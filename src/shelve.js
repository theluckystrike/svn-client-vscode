'use strict';
// Shelving: put local changes aside and bring them back later. Works with every svn from 1.7 on: the changes are
// saved as a patch (`svn diff --git`) in this extension's storage, the files are reverted, and Unshelve applies
// the patch with `svn patch`. Binary changes cannot go into a text patch, so a shelf with them is refused before
// anything is reverted. Nothing leaves the computer.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { arg } = require('./svn/runner');

function shelfDir(storageDir, root) {
  const id = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12);
  return path.join(storageDir, 'shelves', id);
}

function safeName(name) { return String(name).trim().replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'shelf'; }

function list(storageDir, root) {
  const dir = shelfDir(storageDir, root);
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch (_) { return []; }
  return names.map(n => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (_) { return null; } })
    .filter(Boolean).sort((a, b) => b.created - a.created);
}

/**
 * Saves the changes of `paths` (absolute; [] = all) to a shelf, then reverts them (added files are removed from
 * disk after the patch is saved, because the patch holds their text). Returns the shelf record.
 */
async function shelve(repo, { name, paths, storageDir, keep = false }) {
  const dir = shelfDir(storageDir, repo.root);
  fs.mkdirSync(dir, { recursive: true });
  const rels = (paths && paths.length ? paths : []).map(p => path.relative(repo.root, repo.norm ? repo.norm(p) : p) || '.');
  const targets = rels.length ? rels : ['.'];
  const diff = await repo.exec(['diff', '--git', '--internal-diff', '--', ...targets.map(arg)], { kind: 'read', maxBytes: 200 * 1048576 });
  // svn writes the "diff --git", "---" and "+++" names relative to the repository root (trunk/a.txt). Make them
  // relative to the working copy, so `svn patch` in the working copy root finds the files again.
  const rel = String((repo.info && repo.info.relativeUrl) || '^').replace(/^\^\/?/, '');
  const prefix = rel ? decodeURIComponent(rel).replace(/\/?$/, '/') : '';
  const strip = l => (prefix ? l.split(`a/${prefix}`).join('a/').split(`b/${prefix}`).join('b/') : l);
  const patch = diff.stdout.split('\n').map(l => (/^(diff --git |--- a\/|\+\+\+ b\/)/.test(l) ? strip(l) : l)).join('\n');
  if (!patch.trim()) throw Object.assign(new Error('There are no changes to shelve here.'), { friendly: true });
  if (/^Cannot display: file marked as a binary type\./m.test(patch) || /^GIT binary patch/m.test(patch)) {
    throw Object.assign(new Error('Some of these changes are in binary files, which a text shelf cannot hold. Shelve only the text files.'), { friendly: true });
  }
  // "Index:" names are relative to the working copy; the "diff --git" names are relative to the repository root.
  const sections = patch.split(/^(?=Index: )/m).filter(x => x.startsWith('Index: '));
  const files = sections.map(x => x.slice(7, x.indexOf('\n')).replace(/\r$/, ''));
  const added = sections.filter(x => /^new file mode/m.test(x)).map(x => x.slice(7, x.indexOf('\n')).replace(/\r$/, ''));
  const id = `${Date.now()}-${safeName(name).replace(/ /g, '_')}`;
  const rec = { id, name: String(name).trim() || 'Shelf', created: Date.now(), root: repo.root, files, added, bytes: Buffer.byteLength(patch) };
  fs.writeFileSync(path.join(dir, id + '.patch'), patch, 'utf8');
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(rec, null, 1), 'utf8');
  if (!keep) {
    await repo.revert(files.map(f => path.join(repo.root, f)), false);
    for (const a of added) { try { fs.unlinkSync(path.join(repo.root, a)); } catch (_) {} }
    await repo.refresh();
  }
  return rec;
}

/** Applies a shelf with `svn patch`. Keeps the shelf unless drop is true. Returns svn's output. */
async function unshelve(repo, rec, { storageDir, drop = true } = {}) {
  const dir = shelfDir(storageDir, repo.root);
  const file = path.join(dir, rec.id + '.patch');
  if (!fs.existsSync(file)) throw Object.assign(new Error('The shelf file is missing.'), { friendly: true });
  const r = await repo.exec(['patch', '--', file, '.']);
  const rejected = /^C\s|^>\s+rejected hunk/m.test(r.stdout);
  if (drop && !rejected) remove(storageDir, repo.root, rec);
  await repo.refresh();
  return { output: r.stdout, rejected };
}

function remove(storageDir, root, rec) {
  const dir = shelfDir(storageDir, root);
  for (const ext of ['.patch', '.json']) try { fs.unlinkSync(path.join(dir, rec.id + ext)); } catch (_) {}
}

function patchPath(storageDir, root, rec) { return path.join(shelfDir(storageDir, root), rec.id + '.patch'); }

module.exports = { shelve, unshelve, list, remove, patchPath, shelfDir, safeName };
