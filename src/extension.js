'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { findSvn, versionAtLeast, explain, arg } = require('./svn/runner');
const { parseInfo, parseLog } = require('./svn/parse');
const finder = require('./svn/finder');
const { Repository, SCHEME, toSvnUri } = require('./repository');
const { createContentProvider, looksBinary } = require('./content');
const { createDecorations } = require('./decorations');
const { LogPanel, urlUri, emptyUri } = require('./views/log');
const { BlameController } = require('./views/blame');
const { showInstall, closeInstall } = require('./views/install');
const { showGraph } = require('./views/graph');
const { createChangelistTree, NONE } = require('./views/changelists');
const shelves = require('./shelve');
const layout = require('./layout');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createPro } = require('./pro');
const { parseRevisionList } = require('./revisions');

const EXT_ID = 'zovo.zovo-svn-client';
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/.git/**', '**/build/**', '**/dist/**', '**/target/**', '**/out/**', '**/.gradle/**', '**/__pycache__/**'];

let cached = null;
function settings() {
  if (cached) return cached;
  const c = vscode.workspace.getConfiguration('zovoSvn');
  const num = (k, d, lo, hi) => { const v = Number(c.get(k, d)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const depth = c.get('statusDepth', 'infinity');
  cached = {
    path: String(c.get('path', '') || '').trim(),
    statusDelayMs: num('statusDelayMs', 1000, 100, 60000),
    statusDepth: ['infinity', 'immediates', 'files', 'empty'].includes(depth) ? depth : 'infinity',
    exclude: Array.isArray(c.get('exclude')) ? c.get('exclude') : DEFAULT_EXCLUDE,
    detectDepth: num('detectDepth', 3, 0, 8),
    showUnversioned: c.get('showUnversioned', true) !== false,
    maxListedFiles: num('maxListedFiles', 5000, 100, 100000),
    maxDiffMB: num('maxDiffMB', 20, 1, 1024),
    commandTimeoutMs: num('commandTimeoutSec', 120, 5, 3600) * 1000,
    networkTimeoutMs: num('networkTimeoutSec', 300, 5, 7200) * 1000,
    statusTimeoutMs: num('statusTimeoutSec', 300, 5, 7200) * 1000,
    blameMode: c.get('blame.mode', 'gutter') === 'inline' ? 'inline' : 'gutter',
    blameMaxMB: num('blame.maxMB', 10, 1, 512),
    logPageSize: num('log.pageSize', 100, 10, 1000),
    refreshOnFocus: c.get('refreshOnFocus', true) !== false,
    showSupportLinks: c.get('showSupportLinks', true) !== false,
  };
  return cached;
}

let output;
const log = line => { if (output) output.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${line}`); };

// ---------------------------------------------------------------------------------------------------------------
class Model {
  constructor(context, onChange) {
    this.context = context;
    this.onChange = onChange;
    this.repos = [];
    this.svn = null;
    this.missing = false;
    this.installShown = false;
    this.warned = new Set();
    this.scanning = null;
  }

  async findSvn() {
    const s = settings();
    const found = await findSvn(s.path);
    if (found && !versionAtLeast(found.version, 1, 7)) {
      this.svn = null;
      this.missingReason = `svn ${found.version} was found at ${found.path}, but version 1.7 or later is needed.`;
    } else { this.svn = found; this.missingReason = ''; }
    if (this.svn) log(`svn ${this.svn.version} at ${this.svn.path}`);
    else log('svn not found' + (s.path ? ` at the zovoSvn.path setting (${s.path})` : ' on PATH or in the usual places'));
    return this.svn;
  }

  scan() {
    if (!this.scanning) this.scanning = this._scan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async _scan() {
    const s = settings();
    const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
    const excludeNames = s.exclude.map(g => String(g).replace(/^\*\*\//, '').replace(/\/\*\*$/, '')).filter(n => n && !/[*/?]/.test(n));
    const cands = finder.candidates(folders, { depth: s.detectDepth, exclude: excludeNames });
    vscode.commands.executeCommand('setContext', 'zovoSvn.hasWorkingCopy', cands.length > 0);
    this.missing = cands.length > 0 && !this.svn;
    vscode.commands.executeCommand('setContext', 'zovoSvn.missing', this.missing);
    if (!cands.length) { this.setRepos([]); return; }
    if (!this.svn) {
      this.setRepos([]);
      if (!this.installShown) { this.installShown = true; showInstall({ vscode, context: this.context, support, settings, configured: s.path, reason: this.missingReason }); }
      return;
    }
    closeInstall();
    const keep = [];
    const roots = new Set();
    for (const c of cands) {
      let info;
      try {
        const { runSvn } = require('./svn/runner');
        const r = await runSvn(this.svn.path, ['info', '--xml', '--', '.'], { cwd: c.root, timeoutMs: 30000, log });
        info = parseInfo(r.stdout)[0];
      } catch (e) {
        log(`not a usable working copy: ${c.root}: ${e.message}`);
        const ex = explain(e);
        if (!this.warned.has(c.root + ex.text) && !/not in an svn working copy/.test(ex.text)) { this.warned.add(c.root + ex.text); ui.error(e, null, `${c.root}: `); }
        continue;
      }
      const real = info && info.wcRoot ? finder.realpath(info.wcRoot) : c.real;
      if (roots.has(real)) continue;
      roots.add(real);
      // use the workspace's own spelling of the root when it is the same folder (symlinks), else svn's root
      const root = finder.realpath(c.root) === real ? c.root : real;
      keep.push({ root, real, info });
    }
    const multi = keep.length > 1;
    const next = [];
    for (const k of keep) {
      let repo = this.repos.find(r => r.root === k.root);
      if (!repo) {
        repo = new Repository({ vscode, root: k.root, real: k.real, info: k.info, label: multi ? finder.labelFor(k.root, folders) : path.basename(k.root), getSvn: () => this.svn, settings, log, onDidChangeStatus: r => this.onChange(r) });
        repo.refresh();
        log(`working copy ${k.root} (${k.info.url} r${k.info.revision})`);
      } else repo.info = k.info;
      next.push(repo);
    }
    this.setRepos(next);
  }

  setRepos(next) {
    for (const r of this.repos) if (!next.includes(r)) r.dispose();
    this.repos = next;
    vscode.commands.executeCommand('setContext', 'zovoSvn.repoCount', next.length);
    this.onChange(null);
  }

  repoFor(fsPath) {
    if (!fsPath) return null;
    let best = null;
    for (const r of this.repos) if (r.contains(fsPath) && (!best || r.root.length > best.root.length)) best = r;
    return best;
  }

  dispose() { for (const r of this.repos) r.dispose(); this.repos = []; }
}

// ---------------------------------------------------------------------------------------------------------------
let model, rating = { success() {}, failure() {} }, blame, clTree, pro, storageDir;

const ui = {
  explain(e) { if (e && e.friendly) return e.message; return explain(e || {}).text; },
  success() { try { rating.success(); } catch (_) {} },
  /** One error message with the action that fixes it. */
  async error(e, repo, prefix = '') {
    if (e && e.code === 'CANCELLED') return;
    if (e && e.friendly) { vscode.window.showInformationMessage(e.message); return; }
    log(`error: ${e && e.message}${e && e.stderr ? '\n' + e.stderr.trim() : ''}`);
    try { rating.failure(); } catch (_) {}
    const ex = explain(e || {});
    if (e && e.code === 'ENOENT') { model.svn = null; return vscode.commands.executeCommand('zovoSvn.installHelp'); }
    const buttons = [];
    if (ex.action === 'cleanup' && repo) buttons.push('Run Cleanup');
    if (ex.action === 'update' && repo) buttons.push('Update');
    if (ex.action === 'terminal') buttons.push('Open Terminal');
    if (ex.action === 'settings') buttons.push('Timeout Setting');
    if (ex.action === 'install') buttons.push('Install Help');
    buttons.push('Show Output');
    const pick = await vscode.window.showErrorMessage('SVN: ' + prefix + ex.text, ...buttons);
    if (pick === 'Run Cleanup') return vscode.commands.executeCommand('zovoSvn.cleanup', repo.sc);
    if (pick === 'Update') return vscode.commands.executeCommand('zovoSvn.update', repo.sc);
    if (pick === 'Open Terminal') { const t = vscode.window.createTerminal({ name: 'svn', cwd: repo ? repo.root : undefined }); t.show(); return undefined; }
    if (pick === 'Timeout Setting') return vscode.commands.executeCommand('workbench.action.openSettings', 'zovoSvn.networkTimeoutSec');
    if (pick === 'Install Help') return vscode.commands.executeCommand('zovoSvn.installHelp');
    if (pick === 'Show Output') output.show(true);
    return undefined;
  },
};

/** Repository from a command argument: a SourceControl, a resource group, a resource, a Uri, or the active editor. */
async function pickRepo(a) {
  if (!model.svn) { await vscode.commands.executeCommand('zovoSvn.installHelp'); return null; }
  if (a && typeof a === 'object') {
    const byScm = model.repos.find(r => r.sc === a || r.sc.rootUri && a.rootUri && r.sc.rootUri.fsPath === a.rootUri.fsPath && a.inputBox);
    if (byScm) return byScm;
    const g = model.repos.find(r => Object.values(r.groups).includes(a) || [...r.clGroups.values()].includes(a));
    if (g) return g;
    const uri = a.resourceUri || (a instanceof vscode.Uri ? a : null);
    if (uri) { const r = model.repoFor(uri.fsPath); if (r) return r; }
  }
  const ed = vscode.window.activeTextEditor;
  if (model.repos.length > 1 && ed && ed.document.uri.scheme === 'file') { const r = model.repoFor(ed.document.uri.fsPath); if (r) return r; }
  if (model.repos.length === 1) return model.repos[0];
  if (!model.repos.length) { vscode.window.showInformationMessage('SVN: no svn working copy is open. Open a folder that was checked out with svn.'); return null; }
  const p = await vscode.window.showQuickPick(model.repos.map(r => ({ label: r.label, description: r.info ? r.info.relativeUrl : '', detail: r.root, r })), { placeHolder: 'Pick a working copy' });
  return p ? p.r : null;
}

/** Files from command arguments (resource states, Uris, groups, arrays), grouped by working copy. */
function filesFrom(args) {
  const out = [];
  const add = x => {
    if (!x) return;
    if (Array.isArray(x)) { x.forEach(add); return; }
    if (x.resourceStates) { x.resourceStates.forEach(add); return; }
    const uri = x.resourceUri || (x instanceof vscode.Uri ? x : null);
    if (uri && uri.scheme === 'file') out.push(uri.fsPath);
  };
  args.forEach(add);
  if (!out.length && !args.some(a => a && (a.resourceStates || a.resourceUri || a instanceof vscode.Uri || Array.isArray(a)))) {
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.scheme === 'file') out.push(ed.document.uri.fsPath);
  }
  const by = new Map();
  for (const f of [...new Set(out)]) {
    const r = model.repoFor(f);
    if (!r) continue;
    if (!by.has(r)) by.set(r, []);
    by.get(r).push(f);
  }
  return by;
}

const plural = (n, w) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;

async function withScmProgress(repo, title, fn, cancellable = false) {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, () =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `SVN: ${title}`, cancellable }, (_p, token) => fn(token)));
}

// ----- commit ---------------------------------------------------------------------------------------------------
async function doCommit(repo, targets, changelist) {
  const conflicts = repo.groups.conflicts.resourceStates.length;
  if (conflicts) { vscode.window.showWarningMessage(`SVN: resolve the ${plural(conflicts, 'conflict')} before you commit.`); return; }
  let files = targets;
  if (!changelist && !files) files = repo.groups.changes.resourceStates.map(s => s.resourceUri.fsPath);
  if (!changelist && !files.length) {
    if (repo.changelists.length) vscode.window.showInformationMessage('SVN: no change outside changelists. Commit a changelist with the check mark on its group.');
    else if (repo.groups.unversioned.resourceStates.length) vscode.window.showInformationMessage('SVN: nothing to commit. Add the new files first (the + button on Unversioned).');
    else vscode.window.showInformationMessage('SVN: nothing to commit.');
    return;
  }
  let msg = repo.sc.inputBox.value;
  if (!msg.trim()) {
    msg = await vscode.window.showInputBox({ title: `SVN: commit ${changelist ? 'changelist ' + changelist : plural(files.length, 'file')}`, prompt: 'Commit message', ignoreFocusOut: true });
    if (msg === undefined) return;
    if (!msg.trim() && (await vscode.window.showWarningMessage('Commit with an empty message?', { modal: true }, 'Commit')) !== 'Commit') return;
  }
  if (files) {
    const missing = files.filter(f => { const e = repo.entry(f); return e && e.kind === 'missing'; });
    const unver = files.filter(f => { const e = repo.entry(f); return e && e.kind === 'unversioned'; });
    if (missing.length) {
      const ok = await vscode.window.showWarningMessage(`${missing.length === 1 ? '1 file was' : plural(missing.length, 'file') + ' were'} deleted outside svn. Mark ${missing.length === 1 ? 'it' : 'them'} as deleted and commit?`, { modal: true, detail: missing.slice(0, 10).map(f => path.relative(repo.root, f)).join('\n') }, 'Delete and Commit');
      if (ok !== 'Delete and Commit') return;
      await repo.remove(missing);
    }
    if (unver.length) await repo.add(unver);
  }
  try {
    const r = await withScmProgress(repo, `committing ${changelist ? 'changelist ' + changelist : plural(files.length, 'file')}`, token => repo.commit(msg, files, { storageDir, changelist, token }));
    repo.sc.inputBox.value = '';
    vscode.window.showInformationMessage(r.revision ? `SVN: committed revision ${r.revision}.` : 'SVN: commit finished.');
    ui.success();
  } catch (e) { ui.error(e, repo); }
}

// ----- open changes --------------------------------------------------------------------------------------------
async function openChange(uri) {
  if (!(uri instanceof vscode.Uri)) uri = uri && uri.resourceUri ? uri.resourceUri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
  if (!uri) return undefined;
  const repo = model.repoFor(uri.fsPath);
  const e = repo && repo.entry(uri.fsPath);
  const name = path.basename(uri.fsPath);
  if (!repo || !e || e.kind === 'unversioned' || e.kind === 'added' || e.kind === 'conflicted' || e.kind === 'obstructed') {
    try { if (fs.statSync(uri.fsPath).isDirectory()) return vscode.commands.executeCommand('revealInExplorer', uri); } catch (_) {}
    return vscode.commands.executeCommand('vscode.open', uri);
  }
  if (e.kind === 'deleted' || e.kind === 'missing') {
    const doc = await vscode.workspace.openTextDocument(repo.baseUri(uri.fsPath));
    return vscode.window.showTextDocument(doc, { preview: true });
  }
  let size = 0, bin = false;
  try {
    const st = fs.statSync(uri.fsPath);
    if (st.isDirectory()) return vscode.window.showInformationMessage(`${name}: ${e.kind === 'props' ? 'only its properties changed' : 'folder'}. Run "SVN: Show Properties Diff" in a terminal with svn diff.`);
    size = st.size;
    const fd = fs.openSync(uri.fsPath, 'r'); const b = Buffer.alloc(Math.min(8000, size)); fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
    bin = looksBinary(b);
  } catch (_) {}
  if (size > settings().maxDiffMB * 1048576 || bin) {
    // no text diff, and the file is not loaded into a text editor unless the user asks for it
    const why = bin ? `a binary file (${(size / 1048576).toFixed(size > 1048576 ? 0 : 2)} MB)` : `${(size / 1048576).toFixed(0)} MB, over the zovoSvn.maxDiffMB limit`;
    const pick = await vscode.window.showInformationMessage(`${name} is ${why}, so it has no text diff.`, 'Open File', 'Show File History');
    if (pick === 'Open File') return vscode.commands.executeCommand('vscode.open', uri);
    if (pick === 'Show File History') return vscode.commands.executeCommand('zovoSvn.showFileLog', uri);
    return undefined;
  }
  return vscode.commands.executeCommand('vscode.diff', repo.baseUri(uri.fsPath), uri, `${name} (BASE ↔ Working Copy)`, { preview: true });
}

/** The diff of every changed file in a revision, picked from a list. */
async function openRevisionDiff(a) {
  let root = a && a.root, rev = a && a.revision;
  if (!root || !rev) { const l = blame && blame.lineAt(vscode.window.activeTextEditor); if (!l) return vscode.window.showInformationMessage('Turn on SVN blame and put the cursor on a committed line.'); root = l.root; rev = l.revision; }
  const repo = model.repos.find(r => r.root === root) || model.repoFor(root);
  if (!repo) return undefined;
  try {
    const r = await repo.exec(['log', '--xml', '-v', '-r', String(rev), '--', repo.info.repoRoot], { kind: 'read', timeoutMs: settings().networkTimeoutMs });
    const entry = parseLog(r.stdout)[0];
    if (!entry) return undefined;
    const files = entry.paths.filter(p => p.kind !== 'dir');
    const pick = files.length === 1 ? { p: files[0] } : await vscode.window.showQuickPick(files.map(p => ({ label: p.path, description: { A: 'added', M: 'modified', D: 'deleted', R: 'replaced' }[p.action], p })),
      { title: `r${rev} by ${entry.author}: ${entry.msg.split('\n')[0].slice(0, 80)}`, placeHolder: `${plural(files.length, 'changed file')}. Pick one to see its diff.` });
    if (!pick) return undefined;
    const p = pick.p, root2 = repo.info.repoRoot;
    const right = p.action === 'D' ? emptyUri(vscode, p.path, rev) : urlUri(vscode, root2, p.path, rev, repo.root);
    const left = p.action === 'A' && !p.copyfromPath ? emptyUri(vscode, p.path, rev - 1) : p.copyfromPath ? urlUri(vscode, root2, p.copyfromPath, p.copyfromRev, repo.root) : urlUri(vscode, root2, p.path, rev - 1, repo.root);
    return vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(p.path)} (r${rev - 1} ↔ r${rev})`);
  } catch (e) { return ui.error(e, repo); }
}

// ----- branches ------------------------------------------------------------------------------------------------
async function pickRef(repo, title, { includeCurrent = false, includeTags = true } = {}) {
  let refs;
  try { refs = await withScmProgress(repo, 'reading branches and tags', () => layout.listRefs(repo)); } catch (e) { ui.error(e, repo); return null; }
  const cur = repo.info.relativeUrl;
  const items = [];
  const add = (r, icon, kind) => { if (!includeCurrent && r.rel === cur) return; items.push({ label: `$(${icon}) ${r.name}`, description: r.rel === cur ? 'current' : r.rel, detail: r.revision ? `last change r${r.revision}${r.author ? ' by ' + r.author : ''}${r.date ? ', ' + String(r.date).slice(0, 10) : ''}` : '', rel: r.rel, kind }); };
  if (refs.trunk) add(refs.trunk, 'home', 'trunk');
  for (const b of refs.branches.sort((x, y) => y.revision - x.revision)) add(b, 'git-branch', 'branch');
  if (includeTags) for (const t of refs.tags.sort((x, y) => y.revision - x.revision)) add(t, 'tag', 'tag');
  items.push({ label: '$(edit) Type a URL or ^/path...', rel: null, kind: 'custom' });
  const pick = await vscode.window.showQuickPick(items, { title, placeHolder: refs.trunk || refs.branches.length ? 'Pick a branch or tag' : `No trunk, branches or tags under ${refs.base}. Type a URL.`, matchOnDescription: true });
  if (!pick) return null;
  if (pick.kind === 'custom') {
    const v = await vscode.window.showInputBox({ title, prompt: 'A repository URL, or ^/path from the repository root', value: `${refs.base}/branches/` });
    return v ? v.trim() : null;
  }
  return pick.rel;
}

async function confirmCommand(title, cmdline, detail, button) {
  return (await vscode.window.showWarningMessage(title, { modal: true, detail: `${detail ? detail + '\n\n' : ''}Command:\n${cmdline}` }, button)) === button;
}

async function switchTo(a, relArg) {
  const repo = await pickRepo(a);
  if (!repo) return;
  const rel = typeof relArg === 'string' ? relArg : await pickRef(repo, `SVN: switch ${repo.label} to`);
  if (!rel) return;
  const url = layout.toUrl(repo.info.repoRoot, rel);
  const changed = repo.sc.count;
  if (!(await confirmCommand(`Switch ${repo.label} to ${rel}?`, `svn switch ${url}`, changed ? `${plural(changed, 'local change')} stay in the working copy and are merged into the new branch.` : 'The working copy has no local changes.', 'Switch'))) return;
  try {
    const r = await withScmProgress(repo, `switching to ${rel}`, token => repo._write(['switch', '--accept', 'postpone', '--', url], { token, timeoutMs: settings().networkTimeoutMs }), true);
    await repo.refreshInfo();
    const conflicts = (r.stdout.match(/^C|^.C|^...C/mg) || []).length;
    vscode.window.showInformationMessage(`SVN: ${repo.label} is now on ${repo.info.relativeUrl} r${repo.info.revision}.${conflicts ? ` ${plural(conflicts, 'conflict')} to resolve.` : ''}`);
    ui.success();
  } catch (e) { ui.error(e, repo); }
}

async function createCopy(a, kind) {
  const repo = await pickRepo(a);
  if (!repo) return;
  const { base } = layout.splitUrl(repo.info.relativeUrl);
  const word = kind === 'tag' ? 'tag' : 'branch';
  const name = await vscode.window.showInputBox({ title: `SVN: new ${word}`, prompt: `Name of the ${word}. It is created at ${base}/${kind === 'tag' ? 'tags' : 'branches'}/<name>.`,
    validateInput: v => (!v.trim() ? 'Type a name' : /[\\/:*?"<>|\s]/.test(v.trim()) ? 'Use letters, digits, dots, dashes and underscores' : null) });
  if (!name) return;
  const src = await vscode.window.showQuickPick([
    { label: `From ${repo.info.relativeUrl} at HEAD`, description: 'on the server, fast', mode: 'head' },
    { label: `From ${repo.info.relativeUrl} at r${repo.info.revision}`, description: 'the revision of this working copy', mode: 'rev' },
    { label: 'From this working copy, with its local changes', description: 'svn copy . <url>', mode: 'wc' },
  ], { title: `SVN: copy ${word} ${name} from` });
  if (!src) return;
  const dest = `${base}/${kind === 'tag' ? 'tags' : 'branches'}/${name.trim()}`;
  const destUrl = layout.toUrl(repo.info.repoRoot, dest);
  const msg = await vscode.window.showInputBox({ title: 'SVN: commit message for the copy', value: `Create ${word} ${name.trim()} from ${repo.info.relativeUrl}`, ignoreFocusOut: true });
  if (msg === undefined) return;
  const msgFile = path.join(storageDir, `copy-${Date.now()}.txt`);
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(msgFile, msg, 'utf8');
  const srcArg = src.mode === 'wc' ? '.' : src.mode === 'rev' ? `${repo.info.url}@${repo.info.revision}` : repo.info.url;
  const args = ['copy', '-F', msgFile, '--parents', '--', srcArg, destUrl];
  try {
    if (!(await confirmCommand(`Create the ${word} ${dest}?`, `svn copy --parents -m "${msg}" ${srcArg} ${destUrl}`, '', `Create ${word}`))) return;
    const r = await withScmProgress(repo, `creating ${word} ${name}`, token => repo.exec(args, { token, timeoutMs: settings().networkTimeoutMs }));
    const m = String(r.stdout).match(/Committed revision (\d+)/);
    ui.success();
    if (kind === 'branch') {
      const go = await vscode.window.showInformationMessage(`SVN: created ${dest}${m ? ' in r' + m[1] : ''}.`, 'Switch to it');
      if (go) await switchTo(repo.sc, dest);
    } else vscode.window.showInformationMessage(`SVN: created ${dest}${m ? ' in r' + m[1] : ''}.`);
  } catch (e) { ui.error(e, repo); } finally { try { fs.unlinkSync(msgFile); } catch (_) {} }
}

async function merge(a, relArg) {
  const repo = await pickRepo(a);
  if (!repo) return;
  const rel = typeof relArg === 'string' ? relArg : await pickRef(repo, `SVN: merge into ${repo.info.relativeUrl} from`, { includeTags: true });
  if (!rel) return;
  const url = layout.toUrl(repo.info.repoRoot, rel);
  const how = await vscode.window.showQuickPick([
    { label: 'Every revision not merged yet', description: 'sync a branch with trunk, or bring a finished branch back', mode: 'all' },
    { label: 'Some revisions...', description: 'cherry-pick, for example 120,125-130', mode: 'some' },
  ], { title: `SVN: merge from ${rel}` });
  if (!how) return;
  const args = ['merge', '--accept', 'postpone'];
  let shown = `svn merge ${url} .`;
  if (how.mode === 'some') {
    const v = await vscode.window.showInputBox({ title: `SVN: revisions of ${rel} to merge`, prompt: 'Revisions or ranges, for example 120,125-130', validateInput: x => (parseRevisionList(x) ? null : 'Use numbers, commas and ranges like 125-130') });
    if (!v) return;
    const list = parseRevisionList(v);
    args.push('-c', list);
    shown = `svn merge -c ${list} ${url} .`;
  }
  args.push('--', url, '.');
  try {
    const dry = await withScmProgress(repo, 'previewing the merge (dry run)', token => repo.exec([...args.slice(0, 1), '--dry-run', ...args.slice(1)], { token, timeoutMs: settings().networkTimeoutMs }), true);
    const lines = dry.stdout.split(/\r?\n/).filter(l => /^[ADUCGER ][ADUCGER ][B ][C ] /.test(l));
    if (!lines.length) { vscode.window.showInformationMessage(`SVN: nothing to merge from ${rel}. Everything is merged already.`); return; }
    const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: `Merge preview (dry run, nothing changed yet)\n\nCommand: ${shown}\nInto: ${repo.root} (${repo.info.relativeUrl})\n\n${dry.stdout}` });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    const conflicts = lines.filter(l => l[0] === 'C' || l[1] === 'C' || l[3] === 'C').length;
    if (!(await confirmCommand(`Merge ${plural(lines.length, 'change')} from ${rel}?`, shown, conflicts ? `The preview shows ${plural(conflicts, 'conflict')}.` : 'The preview shows no conflict.', 'Merge'))) return;
    const r = await withScmProgress(repo, `merging from ${rel}`, token => repo._write(args, { token, timeoutMs: settings().networkTimeoutMs }), true);
    const c = r.stdout.split(/\r?\n/).filter(l => /^[ADUCGER ][ADUCGER ][B ][C ] /.test(l) && (l[0] === 'C' || l[1] === 'C' || l[3] === 'C')).length;
    vscode.window.showInformationMessage(`SVN: merged from ${rel}. ${c ? plural(c, 'conflict') + ' to resolve, then commit.' : 'Review the changes, then commit.'}`);
    ui.success();
  } catch (e) { ui.error(e, repo); }
}

// ----- activate -------------------------------------------------------------------------------------------------
function activate(context) {
  output = vscode.window.createOutputChannel('SVN Client');
  storageDir = (context.globalStorageUri || vscode.Uri.file(path.join(require('os').homedir(), '.zovo-svn'))).fsPath;
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'zovoSvn', name: 'SVN Client' });
  support.registerSupport({ vscode, context, prefix: 'zovoSvn', selfId: EXT_ID });
  pro = createPro({ vscode, context });

  const decorations = createDecorations({ vscode, model: { get repos() { return model.repos; }, repoFor: p => model.repoFor(p) } });
  model = new Model(context, () => { decorations.update(); if (clTree) clTree.refresh(); });
  const content = createContentProvider({ vscode, model, settings });
  blame = new BlameController({ vscode, model, settings, ui });
  clTree = createChangelistTree({ vscode, model, ui, pro });

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
    try { return await fn(...args); } catch (e) { return ui.error(e, null); }
  }));

  context.subscriptions.push(output, model, blame, clTree.view,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, content),
    vscode.window.registerFileDecorationProvider(decorations.provider),
    vscode.workspace.onDidChangeWorkspaceFolders(() => model.scan()),
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (!e.affectsConfiguration('zovoSvn')) return;
      cached = null;
      if (e.affectsConfiguration('zovoSvn.path')) { await model.findSvn(); model.installShown = false; await model.scan(); }
      else if (e.affectsConfiguration('zovoSvn.detectDepth') || e.affectsConfiguration('zovoSvn.exclude')) await model.scan();
      for (const r of model.repos) r.coalescer.delayMs = settings().statusDelayMs, r.refresh();
      blame.renderAll();
    }),
    vscode.window.onDidChangeWindowState(s => { if (s.focused && settings().refreshOnFocus) for (const r of model.repos) r.coalescer.request(); }),
    vscode.window.onDidChangeActiveTextEditor(() => blame.ctx()),
  );

  reg('zovoSvn.refresh', async a => { const repo = a ? await pickRepo(a) : null; await Promise.all((repo ? [repo] : model.repos).map(r => r.refresh())); });
  reg('zovoSvn.rescan', async () => { await model.findSvn(); model.installShown = !!model.svn; await model.scan(); if (model.svn && model.repos.length) vscode.window.showInformationMessage(`SVN: found ${plural(model.repos.length, 'working copy')} with svn ${model.svn.version}.`); });
  reg('zovoSvn.installHelp', () => showInstall({ vscode, context, support, settings, configured: settings().path, reason: model.missingReason }));
  reg('zovoSvn.showOutput', () => output.show());
  reg('zovoSvn.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#zovoSvn.start`, false));

  reg('zovoSvn.checkout', async (urlArg) => {
    if (!model.svn) { await model.findSvn(); if (!model.svn) return vscode.commands.executeCommand('zovoSvn.installHelp'); }
    const url = typeof urlArg === 'string' ? urlArg : await vscode.window.showInputBox({ title: 'SVN: checkout', prompt: 'Repository URL, for example https://svn.example.com/repo/trunk or file:///path/to/repo/trunk', ignoreFocusOut: true,
      validateInput: v => (/^(https?|svn(\+ssh)?|file):\/\//i.test(v.trim()) ? null : 'Use an http, https, svn, svn+ssh or file URL') });
    if (!url) return undefined;
    const parent = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Check out here', title: 'SVN: pick the parent folder' });
    if (!parent || !parent[0]) return undefined;
    const name = url.trim().replace(/\/+$/, '').split('/').pop() || 'checkout';
    const folder = await vscode.window.showInputBox({ title: 'SVN: folder name', value: decodeURIComponent(name) === 'trunk' ? decodeURIComponent(url.trim().replace(/\/+$/, '').split('/').slice(-2, -1)[0] || 'trunk') : decodeURIComponent(name) });
    if (!folder) return undefined;
    const dest = path.join(parent[0].fsPath, folder);
    if (fs.existsSync(dest) && fs.readdirSync(dest).length) return vscode.window.showWarningMessage(`SVN: ${dest} exists and is not empty. Pick another name.`);
    const { runSvn } = require('./svn/runner');
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `SVN: checking out ${url.trim()}`, cancellable: true }, (_p, token) =>
        runSvn(model.svn.path, ['checkout', '--', url.trim(), dest], { cwd: parent[0].fsPath, token, timeoutMs: Math.max(settings().networkTimeoutMs, 3600000), log }));
      ui.success();
      const go = await vscode.window.showInformationMessage(`SVN: checked out to ${dest}.`, 'Open Folder', 'Add to Workspace');
      if (go === 'Open Folder') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest));
      if (go === 'Add to Workspace') vscode.workspace.updateWorkspaceFolders((vscode.workspace.workspaceFolders || []).length, 0, { uri: vscode.Uri.file(dest) });
    } catch (e) { ui.error(e, null); }
    return undefined;
  });
  reg('zovoSvn.commit', async a => { const repo = await pickRepo(a); if (repo) await doCommit(repo, null, null); });
  reg('zovoSvn.commitSelected', async (...args) => { for (const [repo, files] of filesFrom(args)) await doCommit(repo, files, null); });
  reg('zovoSvn.commitChangelist', async g => {
    const repo = await pickRepo(g);
    if (!repo) return;
    let name = g && g.id && String(g.id).startsWith('cl:') ? String(g.id).slice(3) : null;
    if (!name) { if (!repo.changelists.length) return vscode.window.showInformationMessage('SVN: no changelist in this working copy.'); name = await vscode.window.showQuickPick(repo.changelists, { placeHolder: 'Commit which changelist?' }); }
    if (name) await doCommit(repo, null, name);
    return undefined;
  });

  reg('zovoSvn.update', async a => {
    const repo = await pickRepo(a);
    if (!repo) return;
    try {
      const before = repo.info.revision;
      const r = await withScmProgress(repo, `updating ${repo.label}`, token => repo.update(null, { token }), true);
      await repo.refreshInfo();
      const c = r.counts;
      const parts = [['updated', c.updated], ['added', c.added], ['deleted', c.deleted], ['merged', c.merged]].filter(x => x[1]).map(x => `${x[1]} ${x[0]}`);
      const conflicts = r.conflicts.length;
      const text = `SVN: ${r.revision && r.revision !== before ? `updated to r${r.revision}` : `at r${r.revision || repo.info.revision}`}${parts.length ? ', ' + parts.join(', ') : ''}.`;
      if (conflicts) {
        const go = await vscode.window.showWarningMessage(`${text} ${plural(conflicts, 'conflict')} to resolve.`, 'Show Conflicts');
        if (go) vscode.commands.executeCommand('workbench.view.scm');
      } else { vscode.window.showInformationMessage(text); ui.success(); }
    } catch (e) { ui.error(e, repo); }
  });
  reg('zovoSvn.updateToRevision', async a => {
    const repo = await pickRepo(a);
    if (!repo) return;
    const v = await vscode.window.showInputBox({ title: `SVN: update ${repo.label} to revision`, prompt: 'A revision number, HEAD, or a date like {2025-01-31}', value: 'HEAD' });
    if (!v) return;
    try { await withScmProgress(repo, `updating to ${v}`, token => repo.update(null, { revision: v.trim(), token }), true); await repo.refreshInfo(); vscode.window.showInformationMessage(`SVN: ${repo.label} is at r${repo.info.revision}.`); } catch (e) { ui.error(e, repo); }
  });
  reg('zovoSvn.cleanup', async a => {
    const repo = await pickRepo(a);
    if (!repo) return;
    try { await withScmProgress(repo, `cleanup of ${repo.label}`, () => repo.cleanup()); vscode.window.showInformationMessage(`SVN: cleanup of ${repo.label} finished.`); } catch (e) { ui.error(e, repo); }
  });

  reg('zovoSvn.add', async (...args) => { for (const [repo, files] of filesFrom(args)) { try { await repo.add(files); } catch (e) { ui.error(e, repo); } } });
  reg('zovoSvn.addAll', async a => { const repo = await pickRepo(a); if (!repo) return; const files = repo.groups.unversioned.resourceStates.map(s => s.resourceUri.fsPath); if (files.length) try { await repo.add(files); } catch (e) { ui.error(e, repo); } });
  reg('zovoSvn.revert', async (...args) => {
    for (const [repo, files] of filesFrom(args)) {
      const unver = files.filter(f => { const e = repo.entry(f); return e && e.kind === 'unversioned'; });
      const ver = files.filter(f => !unver.includes(f));
      const n = ver.length + unver.length;
      if (!n) continue;
      const detail = [...ver, ...unver].slice(0, 12).map(f => path.relative(repo.root, f)).join('\n') + (n > 12 ? `\nand ${n - 12} more` : '');
      const ok = await vscode.window.showWarningMessage(`Discard the changes in ${plural(n, 'file')}?`, { modal: true, detail: detail + (unver.length ? `\n\n${plural(unver.length, 'unversioned file')} go to the trash.` : '\n\nThis cannot be undone.') }, 'Discard');
      if (ok !== 'Discard') continue;
      try {
        if (ver.length) await repo.revert(ver);
        for (const f of unver) await vscode.workspace.fs.delete(vscode.Uri.file(f), { recursive: true, useTrash: true });
        await repo.refresh();
      } catch (e) { ui.error(e, repo); }
    }
  });
  reg('zovoSvn.revertAll', async a => {
    const repo = await pickRepo(a);
    if (!repo) return;
    const states = a && a.resourceStates ? a.resourceStates : repo.groups.changes.resourceStates;
    if (!states.length) return;
    await vscode.commands.executeCommand('zovoSvn.revert', ...states);
  });
  reg('zovoSvn.delete', async (...args) => {
    for (const [repo, files] of filesFrom(args)) {
      const ok = await vscode.window.showWarningMessage(`Delete ${plural(files.length, 'file')} with svn delete? The next commit removes ${files.length === 1 ? 'it' : 'them'} from the repository.`, { modal: true, detail: files.slice(0, 12).map(f => path.relative(repo.root, f)).join('\n') }, 'Delete');
      if (ok === 'Delete') try { await repo.remove(files); } catch (e) { ui.error(e, repo); }
    }
  });
  reg('zovoSvn.ignore', async (...args) => {
    for (const [repo, files] of filesFrom(args)) {
      try { await repo.ignore(files, storageDir); vscode.window.showInformationMessage(`SVN: added ${plural(files.length, 'name')} to svn:ignore. Commit the folder to share it.`); } catch (e) { ui.error(e, repo); }
    }
  });
  reg('zovoSvn.resolve', async (...args) => {
    for (const [repo, files] of filesFrom(args)) {
      const tree = files.some(f => { const e = repo.entry(f); return e && e.treeConflicted; });
      const items = [
        { label: 'Mark as resolved', description: 'keep the file as it is now (after you fixed the markers)', accept: 'working' },
        ...(tree ? [] : [{ label: 'Use my version', description: 'mine-full: drop the incoming change', accept: 'mine-full' },
          { label: 'Use their version', description: 'theirs-full: drop my change', accept: 'theirs-full' },
          { label: 'Use the old base version', description: 'base', accept: 'base' }]),
      ];
      const pick = await vscode.window.showQuickPick(items, { title: `SVN: resolve ${plural(files.length, 'conflict')}`, placeHolder: tree ? 'Tree conflict: fix the files by hand, then mark them as resolved' : 'How do you want to resolve it?' });
      if (!pick) continue;
      if (pick.accept === 'working') {
        const marked = files.filter(f => { try { const t = fs.readFileSync(f, 'utf8'); return /^<<<<<<< |^>>>>>>> /m.test(t); } catch (_) { return false; } });
        if (marked.length && (await vscode.window.showWarningMessage(`${plural(marked.length, 'file')} still ${marked.length === 1 ? 'has' : 'have'} conflict markers (<<<<<<<). Mark as resolved anyway?`, { modal: true }, 'Mark as Resolved')) !== 'Mark as Resolved') continue;
      }
      try { await repo.resolve(files, pick.accept); } catch (e) { ui.error(e, repo); }
    }
  });
  reg('zovoSvn.openChange', a => openChange(a));
  reg('zovoSvn.openFile', async (...args) => { for (const [, files] of filesFrom(args)) for (const f of files) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(f)); });
  reg('zovoSvn.openBase', async (...args) => {
    for (const [repo, files] of filesFrom(args)) for (const f of files) { const doc = await vscode.workspace.openTextDocument(repo.baseUri(f)); await vscode.window.showTextDocument(doc, { preview: true }); }
  });
  reg('zovoSvn.addToChangelist', async (...args) => {
    for (const [repo, files] of filesFrom(args)) {
      const items = [...repo.changelists.map(n => ({ label: n })), { label: '$(add) New changelist...', create: true }];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: `Move ${plural(files.length, 'file')} to which changelist?` });
      if (!pick) continue;
      let name = pick.label;
      if (pick.create) { name = await vscode.window.showInputBox({ prompt: 'Name of the new changelist', validateInput: v => (v.trim() ? null : 'Type a name') }); if (!name) continue; }
      try { await repo.changelist(name.trim(), files); } catch (e) { ui.error(e, repo); }
    }
  });
  reg('zovoSvn.removeFromChangelist', async (...args) => { for (const [repo, files] of filesFrom(args)) try { await repo.changelist('', files); } catch (e) { ui.error(e, repo); } });

  reg('zovoSvn.showLog', async a => { const repo = await pickRepo(a); if (repo) LogPanel.open({ vscode, context, repo, target: repo.root, isFile: false, ui, support, settings }); });
  reg('zovoSvn.showFileLog', async (uri) => {
    const u = uri instanceof vscode.Uri ? uri : uri && uri.resourceUri ? uri.resourceUri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
    if (!u || u.scheme !== 'file') return vscode.window.showInformationMessage('Open a file from an svn working copy, then run SVN: Show File History.');
    const repo = model.repoFor(u.fsPath);
    if (!repo) return vscode.window.showInformationMessage('This file is not in an svn working copy.');
    let isFile = true; try { isFile = !fs.statSync(u.fsPath).isDirectory(); } catch (_) {}
    LogPanel.open({ vscode, context, repo, target: u.fsPath, isFile, ui, support, settings });
    return undefined;
  });
  reg('zovoSvn.toggleBlame', async () => { try { await blame.toggle(); } catch (e) { if (e.friendly) vscode.window.showInformationMessage('SVN blame: ' + e.message); else ui.error(e, null); } });
  reg('zovoSvn.openLineRevision', () => openRevisionDiff(null));
  reg('zovoSvn.openRevisionDiff', a => openRevisionDiff(a));

  reg('zovoSvn.switch', (a, rel) => switchTo(a, rel));
  reg('zovoSvn.createBranch', a => createCopy(a, 'branch'));
  reg('zovoSvn.createTag', a => createCopy(a, 'tag'));
  reg('zovoSvn.merge', (a, rel) => merge(a, rel));

  // Pro candidates (free while PRO_ENABLED is false)
  reg('zovoSvn.revisionGraph', async a => {
    const repo = await pickRepo(a);
    if (!repo) return;
    if (!(await pro.allow('Revision graph', 'See trunk, branches and tags over time.'))) return;
    await showGraph({ vscode, context, repo, support, settings, ui });
  });
  reg('zovoSvn.shelve', async (...args) => {
    const by = filesFrom(args.filter(x => x && (x.resourceUri || x instanceof vscode.Uri || Array.isArray(x))));
    const repo = by.size ? [...by.keys()][0] : await pickRepo(args[0]);
    if (!repo) return;
    if (!(await pro.allow('Shelving', 'Put changes aside and bring them back later.'))) return;
    const files = by.get(repo) || [];
    const name = await vscode.window.showInputBox({ title: 'SVN: shelve changes', prompt: files.length ? `Name for a shelf with ${plural(files.length, 'file')}` : 'Name for a shelf with all changes in this working copy', value: `Shelf ${new Date().toISOString().slice(0, 16).replace('T', ' ')}` });
    if (name === undefined) return;
    try {
      const rec = await withScmProgress(repo, 'shelving', () => shelves.shelve(repo, { name, paths: files, storageDir }));
      vscode.window.showInformationMessage(`SVN: shelved ${plural(rec.files.length, 'file')} as "${rec.name}". The files are back to BASE.`);
    } catch (e) { ui.error(e, repo); }
  });
  reg('zovoSvn.unshelve', async a => {
    const repo = await pickRepo(a);
    if (!repo) return;
    if (!(await pro.allow('Shelving', 'Put changes aside and bring them back later.'))) return;
    const list = shelves.list(storageDir, repo.root);
    if (!list.length) return vscode.window.showInformationMessage(`SVN: no shelf for ${repo.label}.`);
    const pick = await vscode.window.showQuickPick(list.map(r => ({ label: r.name, description: `${plural(r.files.length, 'file')}, ${new Date(r.created).toISOString().slice(0, 16).replace('T', ' ')}`, detail: r.files.slice(0, 6).join(', ') + (r.files.length > 6 ? ' ...' : ''), r })), { title: 'SVN: shelves', placeHolder: 'Pick a shelf' });
    if (!pick) return undefined;
    const act = await vscode.window.showQuickPick([{ label: 'Unshelve', description: 'apply and delete the shelf', a: 'pop' }, { label: 'Apply', description: 'apply and keep the shelf', a: 'apply' }, { label: 'Show the patch', a: 'show' }, { label: 'Delete the shelf', a: 'drop' }], { title: `Shelf "${pick.r.name}"` });
    if (!act) return undefined;
    if (act.a === 'show') return vscode.window.showTextDocument(vscode.Uri.file(shelves.patchPath(storageDir, repo.root, pick.r)), { preview: true });
    if (act.a === 'drop') { if ((await vscode.window.showWarningMessage(`Delete the shelf "${pick.r.name}"?`, { modal: true }, 'Delete')) === 'Delete') shelves.remove(storageDir, repo.root, pick.r); return undefined; }
    try {
      const r = await withScmProgress(repo, 'unshelving', () => shelves.unshelve(repo, pick.r, { storageDir, drop: act.a === 'pop' }));
      if (r.rejected) vscode.window.showWarningMessage('SVN: some parts of the shelf did not apply (the files changed since). The shelf is kept. See the Output.', 'Show Output').then(x => x && output.show());
      else vscode.window.showInformationMessage(`SVN: ${act.a === 'pop' ? 'unshelved' : 'applied'} "${pick.r.name}".`);
      log(r.output);
    } catch (e) { ui.error(e, repo); }
    return undefined;
  });
  reg('zovoSvn.newChangelist', async a => {
    const repo = await pickRepo(a);
    if (!repo) return;
    const name = await vscode.window.showInputBox({ prompt: 'Name of the new changelist. Drag files onto it.', validateInput: v => (v.trim() ? null : 'Type a name') });
    if (!name) return;
    repo.extraChangelists = [...new Set([...(repo.extraChangelists || []), name.trim()])];
    clTree.refresh();
  });
  reg('zovoSvn.moveToChangelist', async (...args) => {
    // from the changelist tree context menu: the selected file items
    const items = (Array.isArray(args[1]) ? args[1] : [args[0]]).filter(x => x && x.type === 'file');
    if (!items.length) return;
    const repo = items[0].repo;
    const names = [...new Set([...repo.changelists, ...(repo.extraChangelists || [])])];
    const pick = await vscode.window.showQuickPick([{ label: 'No changelist', name: '' }, ...names.map(n => ({ label: n, name: n })), { label: '$(add) New changelist...', create: true }], { placeHolder: 'Move to' });
    if (!pick) return;
    let name = pick.name;
    if (pick.create) { name = await vscode.window.showInputBox({ prompt: 'Name of the new changelist' }); if (!name) return; }
    await clTree.move(repo, name === NONE ? '' : name, items.map(i => i.entry.abs));
  });

  // start
  (async () => {
    await model.findSvn();
    await model.scan();
  })().catch(e => log('start failed: ' + e.message));

  return { model, settings, pro, blame, _test: { parseRevisionList, filesFrom, openChange, resetSettings: () => { cached = null; } } };
}

function deactivate() { if (model) model.dispose(); }

module.exports = { activate, deactivate, parseRevisionList, DEFAULT_EXCLUDE };
void arg; void toSvnUri;
