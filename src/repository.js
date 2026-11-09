'use strict';
// One svn working copy = one Source Control provider. Status runs one at a time per working copy (Coalescer +
// serial Limiter): file events only ask for a refresh, and many events become one `svn status`.
const path = require('path');
const fs = require('fs');
const { runSvn, arg, Limiter, Coalescer, SvnError } = require('./svn/runner');
const { parseStatus, parseInfo, parseUpdate } = require('./svn/parse');
const { matchAny } = require('./glob');

const SCHEME = 'zovo-svn';

/** What each svn item looks like in the lists. letter, tooltip, colour id, strike-through. */
const LOOK = {
  modified: ['M', 'Modified', 'gitDecoration.modifiedResourceForeground'],
  added: ['A', 'Added', 'gitDecoration.addedResourceForeground'],
  deleted: ['D', 'Deleted', 'gitDecoration.deletedResourceForeground', true],
  replaced: ['R', 'Replaced', 'gitDecoration.modifiedResourceForeground'],
  missing: ['!', 'Missing (deleted outside svn)', 'gitDecoration.deletedResourceForeground', true],
  conflicted: ['C', 'Conflicted', 'gitDecoration.conflictingResourceForeground'],
  unversioned: ['?', 'Unversioned', 'gitDecoration.untrackedResourceForeground'],
  obstructed: ['~', 'Obstructed (the kind changed outside svn)', 'gitDecoration.conflictingResourceForeground'],
  incomplete: ['!', 'Incomplete (an update stopped part way)', 'gitDecoration.conflictingResourceForeground'],
  props: ['P', 'Properties changed', 'gitDecoration.modifiedResourceForeground'],
};

function kindOf(e) {
  if (e.item === 'conflicted' || e.treeConflicted || e.props === 'conflicted') return 'conflicted';
  if (e.item === 'normal' && e.props === 'modified') return 'props';
  if (LOOK[e.item]) return e.item;
  return null; // normal, ignored, external, none
}

class Repository {
  /**
   * @param o { vscode, root, info, label, getSvn(), settings(), log(line), onDidChangeStatus(repo) }
   */
  constructor(o) {
    this.vscode = o.vscode;
    this.root = path.resolve(o.root);
    this.real = o.real ? path.resolve(o.real) : this.root;
    this.info = o.info;
    this.label = o.label;
    this.getSvn = o.getSvn;
    this.settings = o.settings;
    this.log = o.log || (() => {});
    this.notify = o.onDidChangeStatus || (() => {});
    this.serial = new Limiter(1);
    this.reads = new Limiter(2);
    this.entries = new Map(); // abs path -> { ...status, kind }
    this.changelists = [];
    this.needsCleanup = false;
    this.lastError = null;
    this.statusMs = 0;
    this.statusRuns = 0;
    this.truncated = 0;
    this.busy = 0;
    this.disposables = [];
    this._infoDirty = false;
    this.coalescer = new Coalescer(() => this._status(), Math.max(100, this.settings().statusDelayMs));
    this._createScm();
    this._watch();
  }

  _createScm() {
    const vscode = this.vscode;
    const sc = vscode.scm.createSourceControl('zovo-svn', `SVN ${this.label}`, vscode.Uri.file(this.root));
    this.sc = sc;
    sc.inputBox.placeholder = 'Message (Ctrl+Enter to commit)';
    sc.acceptInputCommand = { command: 'zovoSvn.commit', title: 'Commit', arguments: [sc] };
    sc.quickDiffProvider = { provideOriginalResource: (uri) => this.originalResource(uri) };
    this.groups = {
      conflicts: sc.createResourceGroup('conflicts', 'Conflicts'),
      changes: sc.createResourceGroup('changes', 'Changes'),
      unversioned: sc.createResourceGroup('unversioned', 'Unversioned'),
    };
    this.groups.conflicts.hideWhenEmpty = true;
    this.groups.unversioned.hideWhenEmpty = true;
    this.clGroups = new Map();
    for (const g of Object.values(this.groups)) g.resourceStates = [];
    this.disposables.push(sc);
    this._updateCommitTemplate();
  }

  _updateCommitTemplate() {
    const rel = this.info && this.info.relativeUrl ? this.info.relativeUrl : '';
    const rev = this.info && this.info.revision ? `r${this.info.revision}` : '';
    const cmds = [{
      command: 'zovoSvn.update', title: `$(cloud-download) ${rev}${rel ? ' ' + rel : ''}`.trim(),
      tooltip: `${this.root}\n${this.info ? this.info.url : ''}\nClick to update this working copy`, arguments: [this.sc],
    }];
    if (this.needsCleanup) cmds.push({ command: 'zovoSvn.cleanup', title: '$(warning) Cleanup needed', tooltip: 'The working copy is locked by an svn command that did not finish. Click to run svn cleanup.', arguments: [this.sc] });
    else if (this.lastError) cmds.push({ command: 'zovoSvn.showOutput', title: '$(error) svn status failed', tooltip: String(this.lastError.message || '').slice(0, 300) });
    if (this.truncated) cmds.push({ command: 'workbench.action.openSettings', title: `$(info) ${this.truncated.toLocaleString('en-US')} more not listed`, tooltip: 'Each group lists up to zovoSvn.maxListedFiles files. The count is exact.', arguments: ['zovoSvn.maxListedFiles'] });
    this.sc.statusBarCommands = cmds;
  }

  _watch() {
    const vscode = this.vscode;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(this.root), '**'));
    const on = uri => this.onFileEvent(uri);
    this.disposables.push(w, w.onDidChange(on), w.onDidCreate(on), w.onDidDelete(on));
  }

  /** A file changed on disk. Excluded folders and svn's own admin files (except wc.db) are ignored. */
  onFileEvent(uri) {
    const p = this.norm(uri.fsPath);
    const rel = path.relative(this.root, p).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return false;
    if (rel.startsWith('.svn/') || rel === '.svn') {
      // another svn client changed the working copy; our own runs are ignored
      if (!/^\.svn\/wc\.db$/.test(rel) || this.busy > 0 || Date.now() - (this._lastRunEnd || 0) < 1500) return false;
    } else if (matchAny(rel, this.settings().exclude)) return false;
    this.coalescer.request();
    return true;
  }

  /** Runs svn in this working copy. kind 'serial' (writes, status) or 'read'. */
  exec(args, { kind = 'serial', timeoutMs, token, encoding, maxBytes, cwd } = {}) {
    const svn = this.getSvn();
    if (!svn) return Promise.reject(new SvnError('svn is not installed', { code: 'ENOENT' }));
    const lim = kind === 'read' ? this.reads : this.serial;
    return lim.run(async () => {
      this.busy++;
      try {
        return await runSvn(svn.path, args, { cwd: cwd || this.root, timeoutMs: timeoutMs ?? this.settings().commandTimeoutMs, token, encoding, maxBytes, log: this.log });
      } finally { this.busy--; this._lastRunEnd = Date.now(); }
    });
  }

  refresh() { return this.coalescer.now(); }

  async refreshInfo() {
    try {
      const r = await this.exec(['info', '--xml', '--', '.'], { kind: 'read', timeoutMs: 30000 });
      const i = parseInfo(r.stdout)[0];
      if (i) { this.info = i; this._updateCommitTemplate(); }
    } catch (e) { this.log('info failed: ' + e.message); }
  }

  async _status() {
    const s = this.settings();
    const args = ['status', '--xml', '--ignore-externals'];
    if (s.statusDepth && s.statusDepth !== 'infinity') args.push('--depth', s.statusDepth);
    args.push('--', '.');
    const t0 = Date.now();
    try {
      const r = await this.exec(args, { timeoutMs: s.statusTimeoutMs, maxBytes: 256 * 1024 * 1024 });
      this.statusMs = Date.now() - t0;
      this.statusRuns++;
      this._apply(parseStatus(r.stdout));
      this.lastError = null;
      if (this._infoDirty) { this._infoDirty = false; await this.refreshInfo(); }
    } catch (e) {
      this.lastError = e;
      if (e.code === 'E155004' || (e.errors || []).some(x => x.code === 'E155004')) this.needsCleanup = true;
      this.log(`status failed: ${e.message}`);
    }
    this._updateCommitTemplate();
    this.notify(this);
  }

  _apply(list) {
    const vscode = this.vscode;
    const s = this.settings();
    const entries = new Map();
    const conflicts = [], changes = [], unversioned = [], cl = new Map();
    let locked = false;
    const cap = s.maxListedFiles;
    this.truncated = 0;
    // the helper files svn writes next to a text conflict (.mine, .rN, .merge-left.rN, .merge-right.rN, .working)
    // belong to that conflict, not to Unversioned; svn removes them when the conflict is resolved
    const conflicted = new Set(list.filter(e => kindOf(e) === 'conflicted').map(e => path.resolve(this.root, e.path)));
    const isHelper = abs => { const m = abs.match(/^(.*)\.(mine|r\d+|merge-left\.r\d+|merge-right\.r\d+|working)$/); return !!m && conflicted.has(m[1]); };
    for (const e of list) {
      if (e.wcLocked) locked = true;
      const kind = kindOf(e);
      if (!kind) continue;
      const abs = path.resolve(this.root, e.path);
      const rel = path.relative(this.root, abs).split(path.sep).join('/');
      if (kind === 'unversioned' && (matchAny(rel + '/', s.exclude) || isHelper(abs))) continue;
      const ent = { ...e, abs, rel, kind };
      entries.set(abs, ent);
      const state = this._state(ent);
      let list;
      if (kind === 'conflicted') list = conflicts;
      else if (kind === 'unversioned') { if (!s.showUnversioned) continue; list = unversioned; }
      else if (e.changelist) { if (!cl.has(e.changelist)) cl.set(e.changelist, []); list = cl.get(e.changelist); }
      else list = changes;
      if (list.length >= cap) { this.truncated++; continue; }
      list.push(state);
    }
    this.needsCleanup = locked;
    this.entries = entries;
    const sort = a => a.sort((x, y) => x._rel.localeCompare(y._rel));
    this.groups.conflicts.resourceStates = sort(conflicts);
    this.groups.changes.resourceStates = sort(changes);
    this.groups.unversioned.resourceStates = sort(unversioned);
    // changelist groups: create new ones, drop old ones
    for (const [name, g] of this.clGroups) if (!cl.has(name)) { g.dispose(); this.clGroups.delete(name); }
    for (const [name, states] of cl) {
      let g = this.clGroups.get(name);
      if (!g) { g = this.sc.createResourceGroup('cl:' + name, `Changelist: ${name}`); g.hideWhenEmpty = true; this.clGroups.set(name, g); }
      g.resourceStates = sort(states);
    }
    this.changelists = [...cl.keys()].sort();
    this.sc.count = conflicts.length + changes.length + [...cl.values()].reduce((n, a) => n + a.length, 0);
    this.vscode.commands.executeCommand('setContext', 'zovoSvn.hasConflicts', conflicts.length > 0);
    void vscode;
  }

  _state(ent) {
    const vscode = this.vscode;
    const look = LOOK[ent.kind];
    const uri = vscode.Uri.file(ent.abs);
    const tip = [look[1]];
    if (ent.treeConflicted) tip.push('tree conflict');
    if (ent.props === 'modified' && ent.kind !== 'props') tip.push('properties changed');
    if (ent.copied) tip.push('copied with history');
    if (ent.movedFrom) tip.push('moved from ' + ent.movedFrom);
    if (ent.movedTo) tip.push('moved to ' + ent.movedTo);
    if (ent.changelist) tip.push('changelist ' + ent.changelist);
    const st = {
      resourceUri: uri,
      contextValue: ent.kind,
      decorations: { strikeThrough: !!look[3], tooltip: tip.join(', '), faded: ent.kind === 'unversioned' },
      command: { command: 'zovoSvn.openChange', title: 'Open Changes', arguments: [uri] },
      _rel: ent.rel,
    };
    return st;
  }

  /** A path in the workspace's spelling of the root (maps the real path of a symlinked root onto it). */
  norm(p) {
    const r = path.resolve(p);
    if (this.real !== this.root && (r === this.real || r.startsWith(this.real + path.sep))) return this.root + r.slice(this.real.length);
    return r;
  }

  entry(fsPath) { return this.entries.get(this.norm(fsPath)); }

  /** Quick diff: the BASE text of a versioned file, unless it is too large. */
  originalResource(uri) {
    if (uri.scheme !== 'file') return undefined;
    const p = this.norm(uri.fsPath);
    if (!this.contains(p)) return undefined;
    const e = this.entry(p);
    if (e && (e.kind === 'unversioned' || e.kind === 'added' || (e.kind === 'replaced' && !e.copied))) return undefined;
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > this.settings().maxDiffMB * 1048576) return undefined;
    } catch (_) { return undefined; }
    if (!e && !fs.existsSync(path.join(this.root, '.svn'))) return undefined;
    return this.baseUri(p);
  }

  baseUri(p) { return toSvnUri(this.vscode, p, { rev: 'BASE', root: this.root }); }

  contains(p) {
    const rel = path.relative(this.root, this.norm(p));
    return !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('.svn');
  }

  // ----- write commands. Each one runs on the serial limiter and refreshes afterwards. -----

  async _write(args, opts = {}) {
    try { return await this.exec(args, opts); } finally { this._infoDirty = true; this.coalescer.now(); }
  }

  add(paths) { return this._write(['add', '--parents', '--', ...paths.map(arg)]); }

  revert(paths, recursive = true) { return this._write(['revert', ...(recursive ? ['--depth', 'infinity'] : []), '--', ...paths.map(arg)]); }

  remove(paths, keepLocal = false) { return this._write(['delete', ...(keepLocal ? ['--keep-local'] : []), '--', ...paths.map(arg)]); }

  resolve(paths, accept) { return this._write(['resolve', '--accept', accept, '--depth', 'infinity', '--', ...paths.map(arg)]); }

  cleanup(extra = []) { return this._write(['cleanup', ...extra, '--', '.'], { timeoutMs: Math.max(this.settings().commandTimeoutMs, 600000) }); }

  changelist(name, paths) { return this._write(name ? ['changelist', '--', name, ...paths.map(arg)] : ['changelist', '--remove', '--', ...paths.map(arg)]); }

  async update(paths, { revision, token } = {}) {
    const r = await this._write(['update', ...(revision ? ['-r', String(revision)] : []), '--accept', 'postpone', '--', ...(paths && paths.length ? paths.map(arg) : ['.'])], { token, timeoutMs: this.settings().networkTimeoutMs });
    return parseUpdate(r.stdout);
  }

  /** Commit with a message. targets: absolute paths, or [] for everything. Uses --targets and -F files in storageDir. */
  async commit(message, targets, { storageDir, changelist, token } = {}) {
    fs.mkdirSync(storageDir, { recursive: true });
    const stamp = `${process.pid}-${Date.now()}`;
    const msgFile = path.join(storageDir, `msg-${stamp}.txt`);
    const tgtFile = path.join(storageDir, `targets-${stamp}.txt`);
    fs.writeFileSync(msgFile, message, 'utf8');
    const args = ['commit', '-F', msgFile, '--encoding', 'UTF-8'];
    try {
      if (changelist) args.push('--changelist', changelist, '--', '.');
      else if (targets && targets.length) {
        fs.writeFileSync(tgtFile, targets.map(t => arg(path.relative(this.root, this.norm(t)) || '.')).join('\n'), 'utf8');
        args.push('--depth', 'empty', '--targets', tgtFile);
      } else args.push('--', '.');
      const r = await this._write(args, { token, timeoutMs: this.settings().networkTimeoutMs });
      const m = String(r.stdout).match(/Committed revision (\d+)\./);
      return { revision: m ? Number(m[1]) : null, stdout: r.stdout };
    } finally {
      for (const f of [msgFile, tgtFile]) try { fs.unlinkSync(f); } catch (_) {}
    }
  }

  /** Adds name patterns to svn:ignore of the parent folder of each path. */
  async ignore(paths, storageDir) {
    const byDir = new Map();
    for (const p of paths) { const d = path.dirname(p); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(path.basename(p)); }
    fs.mkdirSync(storageDir, { recursive: true });
    for (const [dir, names] of byDir) {
      let cur = '';
      try { cur = (await this.exec(['propget', 'svn:ignore', '--', arg(dir)], { kind: 'read' })).stdout; } catch (e) { if (!/W200017|E200017|not found/i.test(e.stderr + e.message)) throw e; }
      const lines = cur.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      for (const n of names) if (!lines.includes(n)) lines.push(n);
      const f = path.join(storageDir, `ignore-${process.pid}-${Date.now()}.txt`);
      fs.writeFileSync(f, lines.join('\n') + '\n', 'utf8');
      try { await this._write(['propset', 'svn:ignore', '-F', f, '--', arg(dir)]); } finally { try { fs.unlinkSync(f); } catch (_) {} }
    }
  }

  dispose() {
    this.coalescer.dispose();
    for (const g of this.clGroups.values()) try { g.dispose(); } catch (_) {}
    for (const d of this.disposables) try { d.dispose(); } catch (_) {}
  }
}

/** zovo-svn: URIs carry the file path (so the editor picks the language) and the revision in the query. */
function toSvnUri(vscode, fsPath, q) {
  return vscode.Uri.file(fsPath).with({ scheme: SCHEME, query: JSON.stringify(q) });
}
function fromSvnUri(uri) {
  let q = {};
  try { q = JSON.parse(uri.query || '{}'); } catch (_) {}
  return { fsPath: uri.fsPath, ...q };
}

module.exports = { Repository, kindOf, LOOK, SCHEME, toSvnUri, fromSvnUri };
