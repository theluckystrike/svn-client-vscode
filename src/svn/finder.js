'use strict';
// Finds svn working copies for the open folders. Each working copy root is found once, however many workspace
// folders sit inside it, and nested working copies (externals, separate checkouts) are found by their own .svn
// folder. Only the file system is read here; `svn info` confirms each root later.
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', 'bower_components', '.venv', 'venv', '__pycache__', '.gradle', '.idea', '.vs', 'target', 'build', 'dist', 'out', 'obj', 'bin', '.next', '.cache']);

/** Walks up from dir and returns the nearest folder that has a .svn folder, or ''. */
function findUp(dir, exists = p => fs.existsSync(p)) {
  let d = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    if (exists(path.join(d, '.svn'))) return d;
    const parent = path.dirname(d);
    if (parent === d) return '';
    d = parent;
  }
  return '';
}

/**
 * Looks for .svn folders below dir, `depth` levels deep, skipping SKIP names and the extra exclude names.
 * Stops after maxDirs folders so a huge tree never blocks. Returns the folders that hold a .svn folder.
 */
function findBelow(dir, depth = 3, { exclude = [], maxDirs = 5000, budgetMs = 400 } = {}) {
  const skip = new Set([...SKIP, ...exclude]);
  const found = [];
  let seen = 0;
  const t0 = Date.now();
  const walk = (d, level) => {
    if (level > depth || seen > maxDirs || Date.now() - t0 > budgetMs) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    seen++;
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name === '.svn' && level > 0) { found.push(d); continue; }
      if (skip.has(e.name)) continue;
      walk(path.join(d, e.name), level + 1);
    }
  };
  walk(dir, 0);
  return found;
}

function realpath(p) { try { return fs.realpathSync.native(p); } catch (_) { return path.resolve(p); } }

/**
 * Candidate working copy roots for a list of folders: for each folder the root above it (or itself), and the
 * nested roots below it. Deduplicated by real path. Returns [{ root, from }] in a stable order.
 */
function candidates(folders, { depth = 3, exclude = [] } = {}) {
  const map = new Map();
  // keyed by the real path, but the root keeps the path the workspace uses (a symlinked folder stays symlinked,
  // so editors opened from the Explorer match it)
  const add = (root, from) => { if (!root) return; const k = realpath(root); if (!map.has(k)) map.set(k, { root: path.resolve(root), real: k, from }); };
  for (const f of folders) {
    add(findUp(f), f);
    if (depth > 0) for (const r of findBelow(f, depth, { exclude })) add(r, f);
  }
  return [...map.values()].sort((a, b) => a.root.localeCompare(b.root));
}

/** A short label for a root: its folder name, plus the parent path relative to the workspace when nested. */
function labelFor(root, workspaceFolders) {
  const r = path.resolve(root);
  for (const f of workspaceFolders) {
    const ff = path.resolve(f);
    if (r === ff) return path.basename(r);
    const rel = path.relative(ff, r);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return `${path.basename(ff)}/${rel.split(path.sep).join('/')}`;
  }
  return path.basename(r);
}

module.exports = { findUp, findBelow, candidates, labelFor, realpath, SKIP };
