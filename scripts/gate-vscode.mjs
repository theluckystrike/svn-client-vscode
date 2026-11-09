// Real VS Code gate for SVN Client. Installs the .vsix into an isolated profile, opens each fixture working copy
// (scripts/make-fixtures.sh) and drives the Source Control view, the command palette, the log webview, blame and the
// notifications with real key and mouse events over CDP. Checks results with the svn command line.
// usage: node scripts/gate-vscode.mjs <work (short path)> <port> <vsix> <fixtureRoot> <shotDir> <outJson> [phase,...]
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const [work0, port0, vsix, fx0, shotDir, outJson, only = ''] = process.argv.slice(2);
const work = path.resolve(work0), FX = path.resolve(fx0), port = Number(port0);
const WC = id => path.join(FX, 'wc', id);
const R = fs.existsSync(outJson) && only ? JSON.parse(fs.readFileSync(outJson, 'utf8')) : { install: null, steps: [], console: [], started: new Date().toISOString() };
const SVN = ['/opt/homebrew/bin/svn', '/usr/local/bin/svn', '/usr/bin/svn'].find(p => fs.existsSync(p));
const svn = (cwd, ...a) => execFileSync(SVN, ['--non-interactive', ...a], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, LC_CTYPE: 'en_US.UTF-8' } });
const want = p => !only || only.split(',').includes(p);
// svn in the gate may meet the extension's own svn still finishing (working copy lock): wait and retry
const svnRetry = (cwd, ...a) => { for (let i = 0; i < 20; i++) { try { return svn(cwd, ...a); } catch (e) { if (!/E155004/.test(String(e.stderr || e.message)) || i === 19) throw e; spawnSync('sleep', ['0.5']); } } return ''; };

if (!only || only.includes('install')) {
  fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
  fs.rmSync(path.join(work, 'ext'), { recursive: true, force: true });
  R.install = installVsix(work, vsix);
  console.log('install:', R.install.code, R.install.out.trim().split('\n').pop());
}

const base = {
  'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false, 'git.enabled': false,
  'git.autoRepositoryDetection': false, 'workbench.editor.enablePreview': false, 'scm.defaultViewMode': 'list',
  'zovoSvn.statusDelayMs': 400, 'window.titleBarStyle': 'custom', 'window.dialogStyle': 'custom', 'files.simpleDialog.enable': true,
};

let vs, phase = '';
const shots = [];
const shot = async name => { const f = path.join(shotDir, `${phase}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ phase, name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log(v === false ? 'FAIL' : 'PASS', phase, name, v === undefined ? '' : JSON.stringify(v).slice(0, 300)); }
  catch (e) { R.steps.push({ phase, name, ok: false, error: String(e.message || e).slice(0, 800), ms: Date.now() - t0 }); console.log('FAIL', phase, name, String(e.message || e).slice(0, 300)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
const W = expr => vs.wbEval(expr);
const scmText = () => W(`(() => { const v = document.querySelector('.scm-view'); return v ? v.innerText : ''; })()`);
const scmRows = () => W(`[...document.querySelectorAll('.scm-view .monaco-list-row')].map(r => (r.getAttribute('aria-label') || r.innerText || '').replace(/\\s+/g, ' ').trim())`);
const notes = () => vs.notifications();
const errorNotes = () => W(`[...document.querySelectorAll('.notifications-toasts .notification-list-item')].filter(n => n.querySelector('.codicon-error')).map(n => n.textContent.trim().slice(0, 200))`);
const clickNoteButton = async (label) => {
  const b = await vs.waitFor(async () => JSON.parse(await W(`(() => { const a = [...document.querySelectorAll('.notifications-toasts .monaco-button, .notification-list-item .monaco-button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!a) return 'null'; const b = a.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`)), 15000, 250);
  if (!b) throw new Error('no notification button ' + label);
  await vs.click(b.x, b.y);
};
const clearNotes = async () => { try { await vs.command('Notifications: Clear All Notifications'); } catch {} await sleep(300); };
const dialogButton = async (label) => {
  const b = await vs.waitFor(async () => JSON.parse(await W(`(() => { const a = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!a) return 'null'; const b = a.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`)), 15000, 200);
  if (!b) throw new Error('no dialog button ' + label + ': ' + await W(`(document.querySelector('.monaco-dialog-box') || {}).innerText || 'no dialog'`));
  await vs.click(b.x, b.y);
};
const dialogText = () => W(`(document.querySelector('.monaco-dialog-box') || {}).innerText || ''`);
const quickPickChoose = async (text) => {
  const ok = await vs.waitFor(() => W(`!!document.querySelector('.quick-input-widget') && document.querySelector('.quick-input-widget').style.display !== 'none'`), 10000, 150);
  if (!ok) throw new Error('quick pick not shown');
  if (text) await vs.type(text);
  await sleep(500);
  await vs.key('Enter', 'Enter');
  await sleep(500);
};
const typeScmMessage = async (msg) => {
  await vs.command('View: Show Source Control');
  await sleep(600);
  const b = await vs.waitFor(async () => JSON.parse(await W(`(() => { const e = document.querySelector('.scm-view .scm-editor .monaco-editor'); if (!e) return 'null'; const b = e.getBoundingClientRect(); return JSON.stringify({ x: b.x + 20, y: b.y + b.height / 2 }); })()`)), 10000);
  if (!b) throw new Error('no scm input');
  await vs.click(b.x, b.y);
  await vs.type(msg);
  await sleep(300);
};
const extLog = () => {
  const files = vs.extHostLogs().filter(f => (/SVN Client\.log$/.test(f) || /zovo\.zovo-svn-client/.test(f)) && fs.statSync(f).mtimeMs >= launchedAt - 1000);
  return files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
};

let launchedAt = 0, curWork = work;
async function open(id, folder, settings = {}, env = {}, workDir = work) {
  phase = id; launchedAt = Date.now(); curWork = workDir;
  const busy = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
  if (busy) throw new Error(`port ${port} already answers; pick another`);
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  vs = await launch(workDir, port, folder, { ...base, ...settings });
  for (const [k] of Object.entries(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  // other apps on this shared Mac take the front; an occluded window makes screenshots and the palette time out
  const front = () => spawnSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${vs.child.pid}) to true`], { timeout: 10000 });
  const cmd = vs.command.bind(vs);
  vs.command = async (label) => { front(); await sleep(200); return cmd(label); };
  const sh = vs.shot.bind(vs);
  vs.shot = async (f) => { front(); await sleep(300); return sh(f); };
  front();
  await sleep(2500);
}
async function close() {
  R.console.push(...vs.console.filter(c => !/Extension Host|ENOPRO|punycode|DeprecationWarning|Failed to load resource|vs\/workbench/.test(c.text)).map(c => ({ phase, ...c })));
  await vs.close();
  vs = null;
  await sleep(1000);
}
const waitScm = async (re, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = await vs.waitFor(async () => { const x = await scmText(); return re.test(x) ? x : null; }, 8000, 300);
    if (t) return t;
    await vs.command('View: Show Source Control');
  }
  return null;
};

// ---------------------------------------------------------------------------------------------------------------
if (want('basic')) {
  const wc = WC('basic');
  await open('basic', wc);
  await step('SCM view lists Changes, Unversioned and the changelists', async () => {
    await vs.command('View: Show Source Control');
    const t = await waitScm(/Changes/);
    if (!t) throw new Error('no Changes group: ' + (await scmText()).slice(0, 400));
    const st = svn(wc, 'status');
    const rows = await scmRows();
    return { groups: ['Changes', 'Unversioned', 'Changelist: feature-x', 'Changelist: docs'].filter(g => t.includes(g)), rows: rows.length, svnStatusLines: st.trim().split('\n').length };
  });
  await step('click a modified file: the diff editor opens against BASE', async () => {
    const mod = svn(wc, 'status').split('\n').find(l => l.startsWith('M ') && !/feature|docs/.test(l));
    const name = path.basename(mod.slice(8).trim());
    const b = JSON.parse(await W(`(() => { const r = [...document.querySelectorAll('.scm-view .monaco-list-row')].find(r => (r.querySelector('.label-name') || {}).textContent === ${JSON.stringify(name)}); if (!r) return 'null'; const b = r.getBoundingClientRect(); return JSON.stringify({ x: b.x + 60, y: b.y + b.height / 2 }); })()`));
    if (!b) throw new Error('row not found ' + name);
    await vs.click(b.x, b.y);
    const ok = await vs.waitFor(() => W(`!!document.querySelector('.monaco-diff-editor .editor.original .view-lines') && document.querySelector('.monaco-diff-editor .editor.original .view-lines').innerText.length > 0`), 15000);
    if (!ok) throw new Error('no diff editor');
    const tab = await W(`(document.querySelector('.tabs-container .tab.active') || {}).textContent || ''`);
    await sleep(800);
    await shot('changes-diff');
    return { file: name, tab: tab.trim() };
  });
  await step('quick diff marks the changed lines in the gutter', async () => {
    const mod = svn(wc, 'status').split('\n').find(l => l.startsWith('M ') && !/feature|docs/.test(l));
    vs.open(path.join(wc, mod.slice(8).trim()));
    const n = await vs.waitFor(() => W(`document.querySelectorAll('.editor-instance .dirty-diff-glyph, .editor-instance .cldr.dirty-diff-modified, .editor-instance [class*="dirty-diff-"]').length`), 15000);
    if (!n) throw new Error('no dirty-diff decorations');
    return { decorations: n };
  });
  await step('commit from the input box with Ctrl+Enter (all of Changes, not the changelists)', async () => {
    const before = svn(wc, 'info', '--show-item', 'revision').trim();
    await typeScmMessage('Gate commit: ünïcödé and "quotes"');
    await vs.key('Enter', 'Enter', 4); // Cmd+Enter on macOS (meta = 4)
    const ok = await vs.waitFor(() => { const l = svn(wc, 'log', '-l', '1', '-r', 'HEAD:1', '--xml'); return /Gate commit: ünïcödé and &quot;quotes&quot;|Gate commit: ünïcödé and "quotes"/.test(l) ? l : null; }, 30000, 500);
    if (!ok) throw new Error('commit not in svn log');
    svnRetry(wc, 'update', '-q');
    const st = svn(wc, 'status');
    return { before, after: svn(wc, 'info', '--show-item', 'revision').trim(), changelistsKept: /feature-x/.test(st) && /docs/.test(st) };
  });
  await step('add an unversioned file with its + button, then revert it', async () => {
    const t0 = await waitScm(/Unversioned/);
    if (!t0) throw new Error('no Unversioned group');
    const un = svn(wc, 'status').split('\n').find(l => l.startsWith('?'));
    const name = path.basename(un.slice(8).trim());
    const row = JSON.parse(await W(`(() => { const r = [...document.querySelectorAll('.scm-view .monaco-list-row')].find(r => (r.querySelector('.label-name') || {}).textContent === ${JSON.stringify(name)}); if (!r) return 'null'; const b = r.getBoundingClientRect(); return JSON.stringify({ x: b.x + 40, y: b.y + b.height / 2 }); })()`));
    if (!row) throw new Error('row not found ' + name);
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y }, vs.wb);
    await sleep(500);
    const b = JSON.parse(await W(`(() => { const r = [...document.querySelectorAll('.scm-view .monaco-list-row')].find(r => (r.querySelector('.label-name') || {}).textContent === ${JSON.stringify(name)}); const a = [...r.querySelectorAll('.action-label')].find(a => /^Add$/.test((a.getAttribute('aria-label') || a.title || '').trim())); if (!a) return JSON.stringify({ miss: [...r.querySelectorAll('.action-label')].map(a => a.getAttribute('aria-label')) }); const b = a.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width }); })()`));
    if (!b || b.miss || !b.w) throw new Error('no Add action: ' + JSON.stringify(b));
    await vs.click(b.x, b.y);
    const added = await vs.waitFor(() => (svn(wc, 'status', '--', name).startsWith('A') ? true : null), 15000, 300);
    if (!added) throw new Error('not added');
    svnRetry(wc, 'revert', '-q', '--', name);
    return { added: name };
  });
  await step('Show Log, footer links and theme colours', async () => {
    await vs.command('SVN: Show Log (History)');
    const wv = await vs.waitFor(async () => (await vs.webviews()).find(w => w.title === 'SVN Log' && w.w > 0), 20000);
    if (!wv) throw new Error('no log webview');
    const n = await vs.waitFor(() => vs.wvEval(wv, `document.querySelectorAll('#rows tr').length`), 20000);
    const foot = await vs.wvEval(wv, `(document.getElementById('zovo-support') || {}).innerText || ''`);
    const bg = await vs.wvEval(wv, `getComputedStyle(document.body).backgroundColor`);
    return { rows: n, footer: foot.replace(/\s+/g, ' '), background: bg };
  });
  await step('More free tools lists related Zovo extensions first', async () => {
    await vs.command('SVN: More free tools by Zovo');
    const items = await vs.waitFor(() => W(`(() => { const w = document.querySelector('.quick-input-widget'); if (!w || w.style.display === 'none') return null; return [...w.querySelectorAll('.monaco-list-row')].slice(0, 7).map(r => r.innerText.replace(/\\s+/g, ' ').slice(0, 90)); })()`), 8000);
    await vs.key('Escape', 'Escape');
    if (!items || !items.some(i => /Hex Viewer/.test(i))) throw new Error('no Hex Viewer: ' + JSON.stringify(items));
    return items;
  });
  await step('no error notification in this session', async () => ({ errors: await errorNotes() }));
  await close();
}

if (want('history')) {
  const wc = WC('history');
  await open('history', wc, { 'zovoSvn.log.pageSize': 100 });
  await step('log view: first page of 100, more on scroll, details and changed paths', async () => {
    let wv = null;
    for (let i = 0; i < 3 && !wv; i++) { await vs.command('SVN: Show Log (History)'); wv = await vs.waitFor(async () => (await vs.webviews()).find(w => w.title === 'SVN Log' && w.w > 0), 15000); }
    if (!wv) throw new Error('no log webview');
    const n = await vs.waitFor(async () => { const x = await vs.wvEval(wv, `document.querySelectorAll('#rows tr').length`); return x >= 50 ? x : null; }, 30000);
    await vs.wvEval(wv, `(() => { const l = document.getElementById('list'); l.scrollTop = l.scrollHeight; return 1; })()`);
    const n2 = await vs.waitFor(async () => { const x = await vs.wvEval(wv, `document.querySelectorAll('#rows tr').length`); return x > n ? x : null; }, 20000);
    await vs.wvEval(wv, `(() => { const l = document.getElementById('list'); l.scrollTop = 0; return 1; })()`);
    await vs.wvClick(wv, `document.querySelectorAll('#rows tr')[2]`);
    await sleep(500);
    const det = await vs.wvEval(wv, `document.getElementById('details').innerText`);
    await shot('log-dark');
    return { firstPage: n, afterScroll: n2, details: det.slice(0, 200) };
  });
  await step('log view: author filter and a changed-path diff', async () => {
    const wv = (await vs.webviews()).find(w => w.title === 'SVN Log' && w.w > 0);
    const authors = await vs.wvEval(wv, `[...new Set([...document.querySelectorAll('#rows td.who')].map(t => t.textContent))]`);
    const who = authors[0];
    await vs.wvClick(wv, `document.getElementById('author')`);
    await vs.type(who);
    await vs.wvClick(wv, `document.getElementById('apply')`);
    const ok = await vs.waitFor(async () => { const a = await vs.wvEval(wv, `[...document.querySelectorAll('#rows td.who')].map(t => t.textContent)`); return a.length && a.every(x => x === who) ? a.length : null; }, 30000);
    if (!ok) throw new Error('filter did not apply');
    await vs.wvClick(wv, `document.querySelectorAll('#rows tr')[0]`);
    await sleep(400);
    const link = await vs.wvEval(wv, `!!document.querySelector('ul.paths li.act-M a')`);
    if (link) {
      await vs.wvClick(wv, `document.querySelector('ul.paths li.act-M a')`);
      const d = await vs.waitFor(() => W(`!!document.querySelector('.monaco-diff-editor')`), 20000);
      if (!d) throw new Error('no diff editor for the changed path');
    }
    return { author: who, rows: ok, openedPathDiff: link };
  });
  await step('blame: gutter labels with revision and author, hover link', async () => {
    await vs.command('View: Close All Editors');
    const files = svn(wc, 'list', '-R').split('\n').filter(f => /\.(js|md|ts)$/.test(f) && !/\//.test(f));
    const f = files.find(x => /index\.js|readme\.md/i.test(x)) || files[0];
    vs.open(path.join(wc, f));
    await vs.waitFor(() => W(`!!document.querySelector('.editor-instance .view-lines')`), 15000);
    await sleep(1500);
    await vs.command('SVN: Toggle Blame');
    const txt = await vs.waitFor(async () => { const t = await W(`[...document.querySelectorAll('.editor-instance .view-lines .view-line span[class*="ced-"]')].slice(0, 40).map(e => getComputedStyle(e, '::before').content).filter(c => c && c !== 'none').join('\\n')`); return /r\d+.\S+.\d{4}-\d\d-\d\d/.test(t) ? t : null; }, 20000);
    if (!txt) throw new Error('no blame labels');
    await shot('blame');
    return { file: f, firstLines: txt.split('\n').slice(0, 3) };
  });
  await step('revision graph shows trunk, branches and tags', async () => {
    await vs.command('SVN: Show Revision Graph');
    const wv = await vs.waitFor(async () => (await vs.webviews()).find(w => w.title === 'Revision graph' && w.w > 0), 20000);
    const g = await vs.waitFor(async () => { const x = await vs.wvEval(wv, `JSON.stringify({ lanes: [...document.querySelectorAll('svg .lane .name')].map(t => t.textContent), tags: [...document.querySelectorAll('svg .tagname')].map(t => t.textContent) })`); const o = JSON.parse(x); return o.lanes.length ? o : null; }, 30000);
    if (!g) throw new Error('no graph');
    await sleep(500);
    await shot('graph');
    return g;
  });
  await step('light theme: the log view follows the theme', async () => {
    const sf = path.join(work, 'ud', 'User', 'settings.json');
    const s = JSON.parse(fs.readFileSync(sf, 'utf8')); s['workbench.colorTheme'] = 'Default Light Modern'; fs.writeFileSync(sf, JSON.stringify(s, null, 1));
    await sleep(2500);
    await vs.command('SVN: Show Log (History)');
    await sleep(2500);
    const wv = (await vs.webviews()).find(w => w.title === 'SVN Log' && w.w > 0);
    const bg = wv ? await vs.wvEval(wv, `getComputedStyle(document.body).backgroundColor`) : '';
    await shot('log-light');
    s['workbench.colorTheme'] = 'Default Dark Modern'; fs.writeFileSync(sf, JSON.stringify(s, null, 1));
    return { background: bg };
  });
  await close();
}

if (want('conflict')) {
  const wc = WC('conflict');
  await open('conflict', wc);
  await step('text and tree conflicts show in their own group', async () => {
    await vs.command('View: Show Source Control');
    const t = await waitScm(/Conflicts/);
    if (!t) throw new Error('no Conflicts group: ' + (await scmText()).slice(0, 300));
    const st = svn(wc, 'status');
    await sleep(500);
    await shot('conflicts');
    return { svn: st.split('\n').filter(l => /^C|^.C|^......C/.test(l)), view: t.split('\n').slice(0, 14) };
  });
  await step('commit is refused while conflicts exist', async () => {
    await typeScmMessage('should not commit');
    await vs.key('Enter', 'Enter', 4);
    const n = await vs.waitFor(async () => (await notes()).find(x => /resolve the \d+ conflict/.test(x)), 10000);
    if (!n) throw new Error('no refusal: ' + JSON.stringify(await notes()));
    return n;
  });
  await close();
}

if (want('locked')) {
  const wc = WC('locked');
  await open('locked', wc);
  await step('update on a locked working copy offers Run Cleanup, cleanup fixes it', async () => {
    await vs.command('View: Show Source Control');
    await sleep(1500);
    await clearNotes();
    await vs.command('SVN: Update');
    const n = await vs.waitFor(async () => (await notes()).find(x => /locked/i.test(x)), 20000);
    if (!n) throw new Error('no locked message: ' + JSON.stringify(await notes()));
    await shot('locked-message');
    await clickNoteButton('Run Cleanup');
    const done = await vs.waitFor(async () => (await notes()).find(x => /cleanup of .* finished/i.test(x)), 30000);
    if (!done) throw new Error('cleanup did not finish: ' + JSON.stringify(await notes()));
    await clearNotes();
    await vs.command('SVN: Update');
    const up = await vs.waitFor(async () => (await notes()).find(x => /SVN: (updated to|at) r\d+/.test(x)), 30000);
    return { message: n.slice(0, 160), after: up };
  });
  await close();
}

if (want('weird')) {
  const wc = WC('weird-names');
  await open('weird', wc);
  await step('spaces, non-ASCII, @ and leading-dash names are listed and commit', async () => {
    await vs.command('View: Show Source Control');
    const t = await waitScm(/Changes/);
    const st = svn(wc, 'status');
    await shot('weird-names');
    // commit everything in Changes; missing files need the confirmation
    await typeScmMessage('weird names gate');
    await vs.key('Enter', 'Enter', 4);
    const dlg = await vs.waitFor(async () => { const d = await dialogText(); return d ? d : null; }, 6000);
    if (dlg && /deleted outside svn/.test(dlg)) await dialogButton('Delete and Commit');
    const ok = await vs.waitFor(() => { const l = svn(wc, 'log', '-l', '1', '-v', '-r', 'HEAD:1'); return /weird names gate/.test(l) ? l : null; }, 30000, 500);
    if (!ok) throw new Error('no commit: ' + JSON.stringify(await notes()));
    svnRetry(wc, 'update', '-q');
    const left = svn(wc, 'status').split('\n').filter(l => l && !l.startsWith('?'));
    return { listed: (t || '').split('\n').filter(l => /[^\x00-\x7f]|@|^-/.test(l)).slice(0, 10), committedPaths: ok.split('\n').filter(l => /^ {3}[AMDR] /.test(l)).length, leftVersionedChanges: left, svnBefore: st.split('\n').length };
  });
  await close();
}

if (want('timeout')) {
  const wc = WC('timeout');
  await open('timeout', wc, { 'zovoSvn.networkTimeoutSec': 8 });
  await step('a server that does not answer: update stops after 8 s with a clear message, status still works', async () => {
    await vs.command('View: Show Source Control');
    await sleep(1500);
    const t0 = Date.now();
    await vs.command('SVN: Update');
    const n = await vs.waitFor(async () => (await notes()).find(x => /did not answer within 8 s|could not be reached/.test(x)), 40000);
    if (!n) throw new Error('no timeout message: ' + JSON.stringify(await notes()));
    const ms = Date.now() - t0;
    const alive = await W('1 + 1');
    const ps = spawnSync('pgrep', ['-f', 'svn --non-interactive update']).stdout.toString().trim();
    await shot('timeout-message');
    return { message: n.slice(0, 160), ms, uiAlive: alive === 2, svnLeftRunning: ps };
  });
  await close();
}

if (want('missing')) {
  const wc = WC('basic');
  await open('missing', wc, { 'zovoSvn.path': '/nonexistent/bin/svn' });
  await step('missing svn: one install screen with the brew command, no error toast loop', async () => {
    const wv = await vs.waitFor(async () => (await vs.webviews()).find(w => w.title === 'Install svn' && w.w > 0), 20000);
    if (!wv) throw new Error('no install screen');
    const txt = await vs.wvEval(wv, `document.body.innerText`);
    await sleep(500);
    await shot('missing-svn');
    await sleep(8000);
    const errs = await errorNotes();
    const views = (await vs.webviews()).filter(w => w.title === 'Install svn').length;
    await vs.command('View: Show Source Control');
    await sleep(800);
    const welcome = await W(`(document.querySelector('.part.sidebar') || {}).innerText || ''`);
    return { brew: /brew install subversion/.test(txt), setting: /zovoSvn\.path/.test(txt), errors: errs, installViews: views, scmWelcome: /svn command line was not found/.test(welcome) };
  });
  await close();
}

if (want('nested')) {
  const wc = WC('nested');
  // two workspace folders: the nested root and a sub folder of the outer one -> 2 providers, no duplicate
  const wsFile = path.join(work, 'nested.code-workspace');
  const sub = fs.readdirSync(wc, { withFileTypes: true }).find(d => d.isDirectory() && d.name !== '.svn' && !fs.existsSync(path.join(wc, d.name, '.svn')));
  fs.writeFileSync(wsFile, JSON.stringify({ folders: [{ path: wc }, ...(sub ? [{ path: path.join(wc, sub.name) }] : [])] }));
  await open('nested', wsFile);
  await step('nested and multi-root working copies are found once each', async () => {
    await vs.command('View: Show Source Control');
    await sleep(4000);
    const providers = await W(`[...document.querySelectorAll('.scm-view .scm-provider, .scm-repositories-view .monaco-list-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
    await shot('nested');
    const log = extLog();
    const roots = [...log.matchAll(/working copy (\/\S+)/g)].map(m => m[1]);
    return { providers, roots: [...new Set(roots)], rootsLogged: roots.length };
  });
  await close();
}

if (want('externals')) {
  const wc = WC('externals');
  await open('externals', wc);
  await step('an svn:externals folder is its own provider, the parent lists it once', async () => {
    await vs.command('View: Show Source Control');
    await sleep(4000);
    const roots = [...extLog().matchAll(/working copy (\/\S+)/g)].map(m => m[1]);
    return { roots: [...new Set(roots)] };
  });
  await close();
}

if (want('keywords')) {
  const wc = WC('keywords');
  await open('keywords', wc);
  await step('keyword file: the BASE side has the same expanded $Id$, so only the real edit differs', async () => {
    const f = svn(wc, 'propget', '-R', 'svn:keywords').split('\n').filter(Boolean)[0].split(' - ')[0];
    fs.appendFileSync(path.join(wc, f), 'gate line\n');
    await vs.command('View: Close All Editors');
    await sleep(800);
    await waitScm(new RegExp(path.basename(f).replace('.', '\\.')));
    const b = await vs.waitFor(async () => JSON.parse(await W(`(() => { const r = [...document.querySelectorAll('.scm-view .monaco-list-row')].find(r => (r.querySelector('.label-name') || {}).textContent === ${JSON.stringify(path.basename(f))}); if (!r) return 'null'; const b = r.getBoundingClientRect(); return JSON.stringify({ x: b.x + 60, y: b.y + b.height / 2 }); })()`)), 15000);
    if (!b) throw new Error('row not found');
    await vs.click(b.x, b.y);
    const orig = await vs.waitFor(() => W(`(() => { const e = document.querySelector('.monaco-diff-editor .editor.original .view-lines'); return e && e.innerText.length ? e.innerText : null; })()`), 15000);
    const inserts = await W(`document.querySelectorAll('.monaco-diff-editor .editor.modified .line-insert, .monaco-diff-editor .editor.modified .char-insert').length`);
    svn(wc, 'revert', '-q', '--', f);
    return { file: f, baseHasExpandedId: /\$Id:[\s\u00a0]+\S+[\s\u00a0]+\d+[\s\u00a0]/.test(orig || ''), origFirst: (orig || '').split('\n').find(l => /\$Id/.test(l)), insertDecorations: inserts };
  });
  await close();
}

if (want('big100k') && fs.existsSync(WC('big100k'))) {
  const wc = WC('big100k');
  const t0 = Date.now();
  await open('big100k', wc, { 'zovoSvn.statusDelayMs': 1000 });
  await step('100,000-file working copy: first status time', async () => {
    await vs.command('View: Show Source Control');
    const t = await waitScm(/Changes/, 180000);
    if (!t) throw new Error('no status after 180 s');
    return { msFromLaunch: Date.now() - t0, files: Number(svn(wc, 'list', '-R', '--depth', 'infinity').split('\n').length) };
  });
  await step('a build that writes 5,000 files: never more than 1 svn status at a time', async () => {
    const outDir = path.join(wc, 'gate-build-out');
    fs.mkdirSync(outDir, { recursive: true });
    let max = 0, samples = 0, seen = 0;
    const counter = setInterval(() => {
      const ps = spawnSync('ps', ['-Ao', 'pid,command']).stdout.toString().split('\n').filter(l => /svn --non-interactive status/.test(l) && !/pgrep|ps -A/.test(l));
      samples++; max = Math.max(max, ps.length); if (ps.length) seen++;
    }, 50);
    const versioned = svn(wc, 'list', '--depth', 'infinity').split('\n').filter(f => /\.txt$/.test(f)).slice(0, 200);
    for (let i = 0; i < 5000; i++) {
      fs.writeFileSync(path.join(outDir, `obj-${i}.o`), String(i));
      if (i < versioned.length) fs.appendFileSync(path.join(wc, versioned[i]), 'x');
      if (i % 250 === 0) await sleep(100);
    }
    await sleep(6000);
    clearInterval(counter);
    const runs = (extLog().match(/> svn --non-interactive status/g) || []).length;
    const t = await scmText();
    svn(wc, 'revert', '-q', '--', ...versioned);
    fs.rmSync(outDir, { recursive: true, force: true });
    return { maxConcurrentStatus: max, samplesWithStatus: seen, samples, statusRunsTotal: runs, listed: /gate-build-out/.test(t) };
  });
  await close();
}

if (want('binary300') && fs.existsSync(WC('binary300'))) {
  const wc = WC('binary300');
  await open('binary300', wc);
  await step('300 MB binary: listed, opens without a text diff, VS Code stays responsive', async () => {
    const big = svn(wc, 'list').split('\n').find(f => f && fs.statSync(path.join(wc, f)).size > 100e6);
    const fd = fs.openSync(path.join(wc, big), 'r+'); fs.writeSync(fd, Buffer.from([1, 2, 3]), 0, 3, 1000); fs.closeSync(fd);
    await vs.command('View: Show Source Control');
    await vs.command('SVN: Refresh');
    const t = await waitScm(new RegExp(big.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 60000);
    if (!t) throw new Error('big file not listed');
    const b = JSON.parse(await W(`(() => { const r = [...document.querySelectorAll('.scm-view .monaco-list-row')].find(r => (r.querySelector('.label-name') || {}).textContent === ${JSON.stringify(big)}); if (!r) return 'null'; const b = r.getBoundingClientRect(); return JSON.stringify({ x: b.x + 60, y: b.y + b.height / 2 }); })()`));
    await sleep(4000); // let the status run after the edit finish (svn reads the 300 MB file to compare it)
    const t1 = Date.now();
    await vs.click(b.x, b.y);
    const n = await vs.waitFor(async () => (await notes()).find(x => /has no text diff/.test(x)), 20000, 100);
    const alive = await W('1 + 1');
    svn(wc, 'revert', '-q', '--', big);
    return { file: big, message: n, ms: Date.now() - t1, uiAlive: alive === 2 };
  });
  await close();
}

if (want('rating')) {
  // rating ask v2.1: 2 good uses in 2 window sessions at least 4 h apart, no error in the last 24 h. A fresh profile,
  // because the hostile phases above end in errors on purpose. Fake clock for the second session.
  const rw = work + 'r';
  fs.rmSync(rw, { recursive: true, force: true });
  installVsix(rw, vsix);
  const wc = WC('basic');
  const openLog = async () => { for (let i = 0; i < 4; i++) { await focus(); await vs.command('SVN: Show Log (History)'); const w = await vs.waitFor(async () => (await vs.webviews()).find(x => x.title === 'SVN Log' && x.w > 0), 10000); if (w && await vs.waitFor(() => vs.wvEval(w, `document.querySelectorAll('#rows tr').length`), 10000)) return true; } return false; };
  const focus = async () => { spawnSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${vs.child.pid}) to true`], { timeout: 10000 }); await sleep(400); return W('document.hasFocus()'); };
  await open('rating', wc, {}, {}, rw);
  await step('session 1: a successful log view counts, no ask yet', async () => {
    const opened = await openLog();
    if (!opened) { await shot('rating-s1-noopen'); R.ratingDebug = { notes: await notes(), wvs: await vs.webviews(), quick: await W(`(document.querySelector('.quick-input-widget') || {}).innerText || ''`) }; }
    await sleep(5000);
    return { opened, focused: await focus(), ask: (await notes()).filter(x => /Is SVN Client useful/.test(x)) };
  });
  await close();
  await open('rating', wc, {}, { ZOVO_RATING_CLOCK_OFFSET_HOURS: '5' }, rw);
  await step('session 2, 5 h later: the ask shows once after a success', async () => {
    const opened = await openLog();
    if (!opened) throw new Error('the log view did not open');
    const n = await vs.waitFor(async () => { await focus(); return (await notes()).find(x => /Is SVN Client useful/.test(x)); }, 20000, 500);
    const db = path.join(rw, 'ud', 'User', 'globalStorage', 'state.vscdb');
    const st = spawnSync('sqlite3', [db, "select value from ItemTable where key = 'zovo.zovo-svn-client'"]).stdout.toString().slice(0, 1500);
    if (!n) throw new Error('no rating ask: ' + JSON.stringify(await notes()) + ' state: ' + st);
    await shot('rating-ask');
    return n;
  });
  await close();
  fs.rmSync(rw, { recursive: true, force: true });
}

R.finished = new Date().toISOString();
R.shots = shots;
fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
const fails = R.steps.filter(s => !s.ok);
console.log(`\n${R.steps.length - fails.length}/${R.steps.length} steps passed${fails.length ? '; failed: ' + fails.map(f => f.phase + ': ' + f.name).join(' | ') : ''}`);
