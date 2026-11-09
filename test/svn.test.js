'use strict';
// The extension against real svn repositories (svnadmin create + file://), through a stand-in vscode module.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/svnfix');
const mock = require('./helpers/vscode');

const skip = !fx.SVN && 'svn is not installed';
const m = mock.install();
const { vscode, state } = m;
const ext = require('../src/extension');
const { parseStatus, parseLog, parseBlame, parseInfo } = require('../src/svn/parse');
const finder = require('../src/svn/finder');
const shelves = require('../src/shelve');
const layout = require('../src/layout');

let api, r, other, nested, ctxDir;
const wait = ms => new Promise(res => setTimeout(res, ms));
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(50); } throw new Error('timed out waiting'); }
const run = (id, ...a) => vscode.commands.executeCommand(id, ...a);
const group = (repo, id) => (id.startsWith('cl:') ? repo.clGroups.get(id.slice(3)) : repo.groups[id]).resourceStates.map(s => path.relative(repo.root, s.resourceUri.fsPath).split(path.sep).join('/')).sort();

test.before(async () => {
  if (skip) return;
  r = fx.makeRepo('main');
  fx.write(r.wc, 'a.txt', 'one\ntwo\nthree\n');
  fx.write(r.wc, 'b.txt', 'b\n');
  fx.write(r.wc, 'dir with space/é 中文.txt', 'x\n');
  fx.write(r.wc, 'notes@home.txt', 'n\n');
  fx.write(r.wc, 'gone.txt', 'g\n');
  fx.write(r.wc, 'cl1.txt', 'c\n');
  fx.commitAll(r, 'first', 'alice');
  fx.write(r.wc, 'a.txt', 'one\ntwo changed by bob\nthree\nfour\n');
  fx.commitAll(r, 'second\n\nwith a body', 'bob');
  // a second working copy, used to make conflicts
  other = path.join(r.dir, 'wc2');
  r.svnIn(r.dir, 'checkout', '-q', `${r.repoUrl}/trunk`, other);
  // nested working copy inside the first (ignored folder)
  r.svn('propset', '-q', 'svn:ignore', 'vendor', '.');
  fx.commitAll(r, 'ignore vendor');
  nested = fx.makeRepo('nested');
  fx.write(nested.wc, 'lib.txt', 'lib\n');
  fx.commitAll(nested, 'lib');
  fs.renameSync(nested.wc, path.join(r.wc, 'vendor'));
  ctxDir = path.join(r.dir, 'ctx');
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(r.wc), name: 'wc', index: 0 }];
  state.config['zovoSvn.statusDelayMs'] = 100;
  api = ext.activate(mock.context(ctxDir));
  await until(() => api.model.repos.length === 2);
});

test.after(() => { if (!skip) { ext.deactivate(); fx.cleanup(); } m.uninstall(); });

test('finds the working copy and the nested one once, labelled by path', { skip }, async () => {
  const roots = api.model.repos.map(x => x.root).sort();
  assert.deepEqual(roots, [finder.realpath(r.wc), finder.realpath(path.join(r.wc, 'vendor'))].sort());
  assert.deepEqual(api.model.repos.map(x => x.label).sort(), ['wc', 'wc/vendor']);
  // two workspace folders inside one working copy still give one provider
  const c = finder.candidates([r.wc, path.join(r.wc, 'dir with space')], { depth: 0 });
  assert.equal(c.length, 1);
  assert.equal(api.model.repoFor(path.join(r.wc, 'vendor', 'lib.txt')).label, 'wc/vendor');
});

test('a symlinked folder keeps its own spelling; real paths map onto it', { skip }, async () => {
  const link = path.join(r.dir, 'link-to-wc');
  fs.symlinkSync(r.wc, link);
  const c = finder.candidates([link], { depth: 0 });
  assert.equal(c.length, 1);
  assert.equal(c[0].root, link);
  assert.equal(c[0].real, finder.realpath(r.wc));
  const { Repository } = require('../src/repository');
  const repo = new Repository({ vscode, root: link, real: finder.realpath(r.wc), info: null, label: 'x', getSvn: () => api.model.svn, settings: () => ({ statusDelayMs: 100, exclude: [], maxListedFiles: 100, showUnversioned: true, maxDiffMB: 20, commandTimeoutMs: 30000, statusTimeoutMs: 30000, networkTimeoutMs: 30000 }) });
  assert.equal(repo.norm(path.join(finder.realpath(r.wc), 'a.txt')), path.join(link, 'a.txt'));
  assert.ok(repo.contains(path.join(finder.realpath(r.wc), 'a.txt')) && repo.contains(path.join(link, 'a.txt')));
  repo.dispose();
  fs.unlinkSync(link);
});

test('groups: changes, unversioned, missing, changelists, conflicts', { skip }, async () => {
  const repo = api.model.repoFor(r.wc);
  // conflict: wc2 changes a.txt line 2 and commits, wc1 changes the same line then updates
  fs.writeFileSync(path.join(other, 'a.txt'), 'one\ntwo from wc2\nthree\nfour\n');
  fx.svn(other, 'commit', '-q', '-m', 'from wc2', '--username', 'carol');
  fx.write(r.wc, 'a.txt', 'one\ntwo local\nthree\nfour\n');
  r.svn('update', '-q', '--accept', 'postpone');
  fx.write(r.wc, 'b.txt', 'b changed\n');
  fx.write(r.wc, 'dir with space/é 中文.txt', 'x changed\n');
  fx.write(r.wc, 'notes@home.txt', 'n changed\n');
  fx.write(r.wc, 'new file.txt', 'new\n');
  fs.unlinkSync(path.join(r.wc, 'gone.txt'));
  fx.write(r.wc, 'cl1.txt', 'c changed\n');
  r.svn('changelist', '-q', 'feature x', 'cl1.txt');
  await repo.refresh();
  assert.deepEqual(group(repo, 'conflicts'), ['a.txt']);
  assert.deepEqual(group(repo, 'changes'), ['b.txt', 'dir with space/é 中文.txt', 'gone.txt', 'notes@home.txt']);
  assert.ok(fs.readdirSync(r.wc).some(f => /^a\.txt\.(mine|r\d+)$/.test(f)), 'svn wrote conflict helper files');
  assert.deepEqual(group(repo, 'unversioned'), ['new file.txt'], 'conflict helper files are not listed as unversioned');
  assert.deepEqual(group(repo, 'cl:feature x'), ['cl1.txt']);
  assert.equal(repo.entry(path.join(r.wc, 'gone.txt')).kind, 'missing');
  assert.equal(repo.sc.count, 6);
  assert.equal(state.contexts['zovoSvn.hasConflicts'], true);
});

test('commit refuses while there are conflicts; resolve, then commit with a non-ASCII message', { skip }, async () => {
  const repo = api.model.repoFor(r.wc);
  repo.sc.inputBox.value = 'Fix: ünïcödé message -m "quoted" a.txt';
  await run('zovoSvn.commit', repo.sc);
  assert.ok(state.messages.some(x => x[0] === 'warn' && /resolve the 1 conflict/.test(x[1])));
  fs.writeFileSync(path.join(r.wc, 'a.txt'), 'one\ntwo merged\nthree\nfour\n');
  state.answers.quickPick.push(items => items.find(i => i.accept === 'working'));
  await run('zovoSvn.resolve', repo.groups.conflicts.resourceStates[0]);
  await repo.refresh();
  assert.deepEqual(group(repo, 'conflicts'), []);
  // the missing file: confirm "Delete and Commit"
  state.answers.warn.push('Delete and Commit');
  await run('zovoSvn.commit', repo.sc);
  await repo.refresh();
  const log = parseLog(fx.svn(r.wc, 'log', '--xml', '-l', '1', '-v', '-r', 'HEAD:1'))[0];
  assert.equal(log.msg, 'Fix: ünïcödé message -m "quoted" a.txt');
  const changed = log.paths.map(p => p.path).sort();
  assert.ok(changed.includes('/trunk/notes@home.txt') && changed.includes('/trunk/gone.txt') && changed.includes('/trunk/a.txt'));
  assert.ok(!changed.includes('/trunk/cl1.txt'), 'changelist files stay out of the Changes commit');
  assert.equal(repo.sc.inputBox.value, '');
  assert.deepEqual(group(repo, 'changes'), []);
  assert.deepEqual(group(repo, 'cl:feature x'), ['cl1.txt']);
});

test('commit a changelist from its group', { skip }, async () => {
  const repo = api.model.repoFor(r.wc);
  repo.sc.inputBox.value = 'changelist commit';
  await run('zovoSvn.commitChangelist', repo.clGroups.get('feature x'));
  await repo.refresh();
  assert.equal(repo.clGroups.size, 0);
  assert.equal(parseLog(fx.svn(r.wc, 'log', '--xml', '-l', '1', '-r', 'HEAD:1'))[0].msg, 'changelist commit');
});

test('add, ignore, revert (unversioned goes to the trash), delete', { skip }, async () => {
  const repo = api.model.repoFor(r.wc);
  for (const f of fs.readdirSync(r.wc).filter(f => /^a\.txt\./.test(f))) fs.unlinkSync(path.join(r.wc, f));
  fx.write(r.wc, 'build.log', 'log\n');
  await repo.refresh();
  await run('zovoSvn.add', repo.groups.unversioned.resourceStates.find(s => s.resourceUri.fsPath.endsWith('new file.txt')));
  await run('zovoSvn.ignore', repo.groups.unversioned.resourceStates.find(s => s.resourceUri.fsPath.endsWith('build.log')));
  await repo.refresh();
  assert.equal(repo.entry(path.join(r.wc, 'new file.txt')).kind, 'added');
  assert.equal(repo.entry(path.join(r.wc, 'build.log')), undefined);
  assert.match(fx.svn(r.wc, 'propget', 'svn:ignore', '.'), /vendor\s+build\.log/);
  fx.write(r.wc, 'b.txt', 'edit to revert\n');
  await repo.refresh();
  state.answers.warn.push('Discard');
  await run('zovoSvn.revert', ...repo.groups.changes.resourceStates.filter(s => /b\.txt$/.test(s.resourceUri.fsPath)));
  await repo.refresh();
  assert.equal(fs.readFileSync(path.join(r.wc, 'b.txt'), 'utf8'), 'b changed\n');
  state.answers.warn.push('Delete');
  await run('zovoSvn.delete', vscode.Uri.file(path.join(r.wc, 'b.txt')));
  await repo.refresh();
  assert.equal(repo.entry(path.join(r.wc, 'b.txt')).kind, 'deleted');
  state.answers.warn.push('Discard');
  await run('zovoSvn.revert', vscode.Uri.file(path.join(r.wc, 'b.txt')));
  await repo.refresh();
  assert.equal(repo.entry(path.join(r.wc, 'b.txt')), undefined);
});

test('quick diff and BASE documents: text, keywords, binary, too large', { skip }, async () => {
  const repo = api.model.repoFor(r.wc);
  const p = path.join(r.wc, 'b.txt');
  fx.write(r.wc, 'b.txt', 'b changed twice\n');
  await repo.refresh();
  const base = repo.originalResource(vscode.Uri.file(p));
  assert.equal(base.scheme, 'zovo-svn');
  assert.equal(await state.contentProvider.provideTextDocumentContent(base), 'b changed\n');
  assert.equal(repo.originalResource(vscode.Uri.file(path.join(r.wc, 'new file.txt'))), undefined, 'added files have no BASE');
  fx.write(r.wc, 'bin.dat', Buffer.from([0, 1, 2, 3, 0, 255]));
  r.svn('add', '-q', 'bin.dat');
  r.svn('commit', '-q', '-m', 'bin', 'bin.dat');
  const bin = await state.contentProvider.provideTextDocumentContent(repo.baseUri(path.join(r.wc, 'bin.dat')));
  assert.match(bin, /binary file, 6 bytes/);
  state.config['zovoSvn.maxDiffMB'] = 1;
  api._test.resetSettings();
  fx.write(r.wc, 'big.txt', 'x'.repeat(2 * 1048576));
  r.svn('add', '-q', 'big.txt'); r.svn('commit', '-q', '-m', 'big', 'big.txt');
  fx.write(r.wc, 'big.txt', 'y'.repeat(2 * 1048576));
  await repo.refresh();
  assert.equal(repo.originalResource(vscode.Uri.file(path.join(r.wc, 'big.txt'))), undefined, 'no quick diff over the limit');
  assert.match(await state.contentProvider.provideTextDocumentContent(repo.baseUri(path.join(r.wc, 'big.txt'))), /larger than 1 MB/);
  state.answers.info.push(undefined);
  await run('zovoSvn.openChange', vscode.Uri.file(path.join(r.wc, 'big.txt')));
  assert.ok(state.messages.some(x => x[0] === 'info' && /big\.txt is 2 MB, over the zovoSvn\.maxDiffMB limit, so it has no text diff/.test(x[1])));
  r.svn('revert', '-q', 'big.txt');
  delete state.config['zovoSvn.maxDiffMB'];
  api._test.resetSettings();
});

test('status runs once per working copy at a time, even with 2,000 file events', { skip }, async () => {
  const repo = api.model.repoFor(r.wc);
  await repo.refresh();
  const before = repo.statusRuns;
  repo.serial.peak = 0;
  const w = state.watchers.find(x => x.pattern.base.fsPath === repo.root);
  for (let i = 0; i < 2000; i++) w.change.fire(vscode.Uri.file(path.join(r.wc, `f${i % 50}.txt`)));
  for (let i = 0; i < 200; i++) w.change.fire(vscode.Uri.file(path.join(r.wc, 'node_modules', 'x', `${i}.js`))); // excluded
  await wait(400);
  await repo.coalescer.now();
  assert.equal(repo.serial.peak, 1);
  assert.ok(repo.statusRuns - before <= 3, `status ran ${repo.statusRuns - before} times`);
  assert.equal(repo.onFileEvent(vscode.Uri.file(path.join(r.wc, 'node_modules', 'a.js'))), false);
  assert.equal(repo.onFileEvent(vscode.Uri.file(path.join(r.wc, '.svn', 'pristine', 'x'))), false);
});

test('blame and log parse real output; mapped blame for local edits', { skip }, async () => {
  const bl = parseBlame(fx.svn(r.wc, 'blame', '--xml', 'a.txt'));
  assert.equal(bl.length, 4);
  assert.ok(bl.every(l => l.revision > 0 && l.author));
  const logs = parseLog(fx.svn(r.wc, 'log', '--xml', '-v', '-l', '3'));
  assert.equal(logs.length, 3);
  const info = parseInfo(fx.svn(r.wc, 'info', '--xml'))[0];
  assert.equal(info.relativeUrl, '^/trunk');
  assert.ok(info.wcRoot);
  fx.write(r.wc, 'a.txt', 'zero\none\ntwo merged\nthree\nfour\n');
  const repo = api.model.repoFor(r.wc);
  await repo.refresh();
  await api.blame.load(path.join(r.wc, 'a.txt'));
  const lines = api.blame.active.get(path.join(r.wc, 'a.txt')).lines;
  assert.equal(lines.length, 5);
  assert.equal(lines[0].revision, 0, 'the new first line is not committed');
  assert.ok(lines[1].revision > 0 && lines[4].revision > 0);
  r.svn('revert', '-q', 'a.txt');
});

test('log view: pages, author filter, changed paths', { skip }, async () => {
  const repo = api.model.repoFor(r.wc);
  state.config['zovoSvn.log.pageSize'] = 10;
  api._test.resetSettings();
  for (let i = 0; i < 12; i++) { fx.write(r.wc, 'b.txt', `v${i}\n`); r.svn('commit', '-q', '-m', `edit ${i}`, '--username', i % 2 ? 'dave' : 'erin', 'b.txt'); }
  r.svn('update', '-q');
  await run('zovoSvn.showLog', repo.sc);
  const panel = state.panels[state.panels.length - 1];
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.match(panel.webview.html, /script-src 'nonce-/);
  await panel.send({ type: 'ready' });
  const first = panel.posted.find(x => x.type === 'entries');
  assert.ok(first.entries.length >= 10, String(first.entries.length));
  await panel.send({ type: 'more' });
  const pages = panel.posted.filter(x => x.type === 'entries');
  assert.equal(pages.length, 2);
  assert.ok(pages[1].entries[0].revision < first.entries[first.entries.length - 1].revision);
  await panel.send({ type: 'filter', filter: { author: 'dave' } });
  const f = panel.posted.filter(x => x.type === 'entries').pop();
  assert.ok(f.entries.length >= 1 && f.entries.every(e => e.author === 'dave'));
  delete state.config['zovoSvn.log.pageSize'];
  api._test.resetSettings();
});

test('branches: list, copy, switch back; merge preview shows the command', { skip }, async () => {
  const repo = api.model.repoFor(r.wc);
  r.svn('copy', '-q', '-m', 'branch', `${r.repoUrl}/trunk`, `${r.repoUrl}/branches/feature-1`);
  r.svn('copy', '-q', '-m', 'tag', `${r.repoUrl}/trunk`, `${r.repoUrl}/tags/v1.0`);
  const refs = await layout.listRefs(repo);
  assert.equal(refs.trunk.rel, '^/trunk');
  assert.deepEqual(refs.branches.map(b => b.name), ['feature-1']);
  assert.deepEqual(refs.tags.map(b => b.name), ['v1.0']);
  const src = await layout.copySource(repo, '^/branches/feature-1');
  assert.equal(src.from, '/trunk');
  // switch with the command, confirm the modal
  state.answers.warn.push('Switch');
  await run('zovoSvn.switch', repo.sc, '^/branches/feature-1');
  assert.equal(repo.info.relativeUrl, '^/branches/feature-1');
  const modal = state.messages.filter(x => x[0] === 'warn').pop();
  assert.match(modal[2], /Command:\nsvn switch file:\/\/.*\/branches\/feature-1/);
  state.answers.warn.push('Switch');
  await run('zovoSvn.switch', repo.sc, '^/trunk');
  assert.equal(repo.info.relativeUrl, '^/trunk');
});

test('shelve and unshelve a text change and an added file', { skip }, async () => {
  const repo = api.model.repoFor(r.wc);
  r.svn('revert', '-q', '-R', '.');
  fx.write(r.wc, 'b.txt', 'shelved edit\n');
  fx.write(r.wc, 'shelf-new.txt', 'brand new\n');
  r.svn('add', '-q', 'shelf-new.txt');
  await repo.refresh();
  const storageDir = path.join(ctxDir, 'storage');
  const rec = await shelves.shelve(repo, { name: 'wip', paths: [], storageDir });
  assert.deepEqual(rec.files.sort(), ['b.txt', 'new file.txt', 'shelf-new.txt'].filter(f => rec.files.includes(f)).sort());
  assert.ok(!fs.existsSync(path.join(r.wc, 'shelf-new.txt')));
  assert.notEqual(fs.readFileSync(path.join(r.wc, 'b.txt'), 'utf8'), 'shelved edit\n');
  assert.equal(shelves.list(storageDir, repo.root).length, 1);
  const out = await shelves.unshelve(repo, rec, { storageDir });
  assert.equal(out.rejected, false);
  assert.equal(fs.readFileSync(path.join(r.wc, 'b.txt'), 'utf8'), 'shelved edit\n');
  assert.equal(fs.readFileSync(path.join(r.wc, 'shelf-new.txt'), 'utf8'), 'brand new\n');
  assert.equal(shelves.list(storageDir, repo.root).length, 0);
  fx.write(r.wc, 'bin2.dat', Buffer.from([0, 0, 1]));
  r.svn('add', '-q', 'bin2.dat');
  r.svn('propset', '-q', 'svn:mime-type', 'application/octet-stream', 'bin2.dat');
  await assert.rejects(shelves.shelve(repo, { name: 'bin', paths: [path.join(r.wc, 'bin2.dat')], storageDir }), /binary/);
});

test('locked working copy: status sees it, the error offers Cleanup, cleanup fixes it', { skip }, async () => {
  const repo = api.model.repoFor(r.wc);
  r.svn('revert', '-q', '-R', '.');
  const db = path.join(r.wc, '.svn', 'wc.db');
  require('child_process').execFileSync('sqlite3', [db, "insert into wc_lock (wc_id, local_dir_relpath, locked_levels) values (1,'',-1)"]);
  await repo.refresh();
  assert.equal(repo.needsCleanup, true);
  state.answers.error.push(undefined);
  await assert.rejects(repo.update(null), e => e.code === 'E155004' || e.errors.some(x => x.code === 'E155004'));
  await run('zovoSvn.cleanup', repo.sc);
  await repo.refresh();
  assert.equal(repo.needsCleanup, false);
  const u = await repo.update(null);
  assert.ok(u.revision > 0);
});

test('missing svn: the install screen once, no repos, no error toast loop', { skip }, async () => {
  const before = state.panels.length;
  const errorsBefore = state.messages.filter(x => x[0] === 'error').length;
  state.config['zovoSvn.path'] = '/no/such/svn';
  api._test.resetSettings();
  await api.model.findSvn();
  api.model.installShown = false;
  await api.model.scan();
  await api.model.scan();
  await api.model.scan();
  assert.equal(api.model.missing, true);
  assert.equal(api.model.repos.length, 0);
  assert.equal(state.contexts['zovoSvn.missing'], true);
  assert.equal(state.panels.slice(before).filter(p => p.type === 'zovoSvn.install').length, 1, 'one install screen for three scans');
  assert.match(state.panels[state.panels.length - 1].webview.html, /brew install subversion|apt install subversion|TortoiseSVN/);
  assert.equal(state.messages.filter(x => x[0] === 'error').length, errorsBefore, 'no error toasts');
  delete state.config['zovoSvn.path'];
  api._test.resetSettings();
  await api.model.findSvn();
  await api.model.scan();
  assert.equal(api.model.repos.length, 2);
  assert.equal(state.contexts['zovoSvn.missing'], false);
});
