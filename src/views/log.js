'use strict';
// History view: a paged `svn log` for the working copy, a folder or a file. Filters by text, author and date
// (svn --search on the server, then an exact author check here). Shows the changed paths of a revision and
// opens the diff of any path, or of any two revisions.
const path = require('path');
const { parseLog, parseDiffSummary } = require('../svn/parse');
const { arg } = require('../svn/runner');
const { page } = require('./html');

const panels = new Map(); // target -> LogPanel

class LogPanel {
  static open(o) {
    const key = o.target;
    const old = panels.get(key);
    if (old) { old.panel.reveal(); return old; }
    const p = new LogPanel(o);
    panels.set(key, p);
    return p;
  }

  constructor({ vscode, context, repo, target, isFile, ui, support, settings }) {
    Object.assign(this, { vscode, context, repo, target, isFile, ui, support, settings });
    this.entries = [];
    this.done = false;
    this.filter = null;
    const name = target === repo.root ? repo.label : path.basename(target);
    this.panel = vscode.window.createWebviewPanel('zovoSvn.log', `SVN Log: ${name}`, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      enableCommandUris: support.commandUris('zovoSvn'),
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'history.svg');
    this.panel.webview.html = page({ vscode, context, webview: this.panel.webview, script: 'log.js', css: 'log.css', title: 'SVN Log', support, settings,
      data: { target: path.relative(repo.root, target) || '.', root: repo.root, url: repo.info ? repo.info.url : '', isFile, pageSize: settings().logPageSize } });
    this.panel.onDidDispose(() => panels.delete(this.target));
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => this.post({ type: 'error', text: ui.explain(e) })));
  }

  post(m) { return this.panel.webview.postMessage(m); }

  async onMessage(m) {
    if (m.type === 'ready') return this.load(true);
    if (m.type === 'more') return this.load(false);
    if (m.type === 'filter') { this.filter = m.filter && (m.filter.text || m.filter.author || m.filter.from || m.filter.to) ? m.filter : null; return this.load(true); }
    if (m.type === 'diffPath') return this.diffPath(m.rev, m.path);
    if (m.type === 'diffRevs') return this.diffRevs(Number(m.a), Number(m.b));
    if (m.type === 'openAt') return this.openAt(m.rev, m.path);
    if (m.type === 'copy') { await this.vscode.env.clipboard.writeText(String(m.text)); return this.vscode.window.setStatusBarMessage('Copied ' + m.text, 2000); }
    return undefined;
  }

  logArgs(fresh) {
    const n = this.settings().logPageSize;
    const args = ['log', '--xml', '-v', '-l', String(n)];
    const f = this.filter;
    let start = 'HEAD', end = '1';
    if (f && f.to) start = `{${nextDay(f.to)}}`;
    if (f && f.from) end = `{${f.from}}`;
    if (!fresh && this.cursor) start = String(this.cursor - 1);
    args.push('-r', `${start}:${end}`);
    if (f && f.text) args.push('--search', f.text);
    if (f && f.author) args.push(f.text ? '--search-and' : '--search', f.author);
    args.push('--', arg(this.target));
    return args;
  }

  async load(fresh) {
    if (fresh) { this.entries = []; this.cursor = null; this.done = false; }
    if (this.done) return;
    this.post({ type: 'loading', fresh });
    const n = this.settings().logPageSize;
    let r;
    try {
      r = await this.repo.exec(this.logArgs(fresh), { kind: 'read', timeoutMs: this.settings().networkTimeoutMs });
    } catch (e) {
      // a file added after the checkout, or a date range before r1: try from BASE
      if (fresh && /E160013|E195012|E205000|E160006|No such revision/i.test(e.stderr + e.message)) {
        const args = this.logArgs(fresh).map(a => (a.startsWith('HEAD:') ? a.replace('HEAD:', 'BASE:') : a));
        r = await this.repo.exec(args, { kind: 'read', timeoutMs: this.settings().networkTimeoutMs });
      } else throw e;
    }
    const raw = parseLog(r.stdout);
    if (raw.length < n) this.done = true;
    if (raw.length) this.cursor = raw[raw.length - 1].revision;
    if (this.cursor !== null && this.cursor <= 1) this.done = true;
    let list = raw;
    const f = this.filter;
    if (f && f.author) { const a = f.author.toLowerCase(); list = list.filter(e => e.author.toLowerCase().includes(a)); }
    if (f && f.text) { const t = f.text.toLowerCase(); list = list.filter(e => (e.msg + ' ' + e.author + ' ' + e.paths.map(p => p.path).join(' ')).toLowerCase().includes(t)); }
    this.entries.push(...list);
    this.post({ type: 'entries', fresh, entries: list, done: this.done, scanned: raw.length });
    this.ui.success();
  }

  /** Diff one changed path of revision rev against its previous version. */
  async diffPath(rev, repoPath) {
    const vscode = this.vscode;
    rev = Number(rev);
    const e = this.entries.find(x => x.revision === rev);
    const p = e && e.paths.find(x => x.path === repoPath);
    const root = this.repo.info.repoRoot;
    if (p && p.kind === 'dir') return vscode.window.showInformationMessage(`${repoPath} is a folder. Pick a file to see its diff.`);
    const right = p && p.action === 'D' ? emptyUri(vscode, repoPath, rev) : urlUri(vscode, root, repoPath, rev, this.repo.root);
    let left;
    if (p && p.action === 'A' && !p.copyfromPath) left = emptyUri(vscode, repoPath, rev - 1);
    else if (p && p.copyfromPath) left = urlUri(vscode, root, p.copyfromPath, p.copyfromRev, this.repo.root);
    else left = urlUri(vscode, root, repoPath, rev - 1, this.repo.root);
    const title = `${path.posix.basename(repoPath)} (r${p && p.copyfromRev ? p.copyfromRev : rev - 1} ↔ r${rev})`;
    return vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  async diffRevs(a, b) {
    const vscode = this.vscode;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const root = this.repo.info.repoRoot;
    if (this.isFile) {
      const rel = await this.repoPathOf(this.target);
      return vscode.commands.executeCommand('vscode.diff', urlUri(vscode, root, rel, lo, this.repo.root), urlUri(vscode, root, rel, hi, this.repo.root), `${path.basename(this.target)} (r${lo} ↔ r${hi})`);
    }
    const r = await this.repo.exec(['diff', '--summarize', '--xml', '-r', `${lo}:${hi}`, '--', arg(this.target)], { kind: 'read', timeoutMs: this.settings().networkTimeoutMs });
    const items = parseDiffSummary(r.stdout).filter(x => x.kind !== 'dir');
    if (!items.length) return vscode.window.showInformationMessage(`No file changed between r${lo} and r${hi}.`);
    const base = decodeURIComponent(this.repo.info.url.slice(root.length)).replace(/\/$/, '');
    const toRepo = p => (/^[a-z+]+:\/\//i.test(p) ? decodeURIComponent(p.slice(root.length)) : `${base}/${p.split(path.sep).join('/')}`);
    const pick = await vscode.window.showQuickPick(items.map(x => ({ label: x.path, description: x.item, x })), { title: `Files changed between r${lo} and r${hi} (${items.length})`, matchOnDescription: true });
    if (!pick) return undefined;
    const rp = toRepo(pick.x.path);
    const left = pick.x.item === 'added' ? emptyUri(vscode, rp, lo) : urlUri(vscode, root, rp, lo, this.repo.root);
    const right = pick.x.item === 'deleted' ? emptyUri(vscode, rp, hi) : urlUri(vscode, root, rp, hi, this.repo.root);
    return vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(rp)} (r${lo} ↔ r${hi})`);
  }

  async openAt(rev, repoPath) {
    const doc = await this.vscode.workspace.openTextDocument(urlUri(this.vscode, this.repo.info.repoRoot, repoPath, Number(rev), this.repo.root));
    return this.vscode.window.showTextDocument(doc, { preview: true });
  }

  async repoPathOf(p) {
    const { parseInfo } = require('../svn/parse');
    const r = await this.repo.exec(['info', '--xml', '--', arg(p)], { kind: 'read' });
    const i = parseInfo(r.stdout)[0];
    return decodeURIComponent(i.url.slice(i.repoRoot.length));
  }
}

function nextDay(d) {
  const t = new Date(d + 'T00:00:00Z');
  if (Number.isNaN(t.getTime())) return d;
  return new Date(t.getTime() + 86400000).toISOString().slice(0, 10);
}

/** A document for a repository path at a revision. The path part keeps the file name so the language is right. */
function urlUri(vscode, repoRoot, repoPath, rev, wcRoot) {
  const url = repoRoot + repoPath.split('/').map(s => encodeURIComponent(s)).join('/');
  return vscode.Uri.from({ scheme: 'zovo-svn', path: `/r${rev}${repoPath}`, query: JSON.stringify({ url, rev, root: wcRoot }) });
}
function emptyUri(vscode, repoPath, rev) {
  return vscode.Uri.from({ scheme: 'zovo-svn', path: `/r${rev}${repoPath}`, query: JSON.stringify({ empty: true }) });
}

module.exports = { LogPanel, urlUri, emptyUri, nextDay, panels };
