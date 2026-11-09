'use strict';
// Blame in the editor: who changed each line, in which revision and when. Gutter mode puts a short label before
// every line; inline mode shows it after the line the cursor is on. The hover has the message and a link to the
// diff of that revision. Lines you edited locally show as "not committed".
const path = require('path');
const fs = require('fs');
const { parseBlame, parseLog } = require('../svn/parse');
const { arg } = require('../svn/runner');

/** Maps each line of `now` to its line in `base` (or -1) with Myers' diff. Gives up (null) when too different. */
function mapLines(base, now, maxD = 1500) {
  let s = 0;
  while (s < base.length && s < now.length && base[s] === now[s]) s++;
  let eb = base.length, en = now.length;
  while (eb > s && en > s && base[eb - 1] === now[en - 1]) { eb--; en--; }
  const map = new Array(now.length).fill(-1);
  for (let i = 0; i < s; i++) map[i] = i;
  for (let t = 0; en + t < now.length; t++) map[en + t] = eb + t;
  const a = base.slice(s, eb), b = now.slice(s, en);
  const N = a.length, M = b.length;
  if (N === 0 || M === 0) return map;
  const max = Math.min(N + M, maxD);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;
  // backtrack
  let x = N, y = M;
  for (let d = found; d > 0; d--) {
    const pv = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && pv[off + k - 1] < pv[off + k + 1])) ? k + 1 : k - 1;
    const px = pv[off + prevK], py = px - prevK;
    while (x > px && y > py) { x--; y--; map[s + y] = s + x; }
    x = px; y = py;
  }
  while (x > 0 && y > 0) { x--; y--; map[s + y] = s + x; }
  return map;
}

function shortDate(d) { return d ? String(d).slice(0, 10) : ''; }

class BlameController {
  constructor({ vscode, model, settings, ui }) {
    Object.assign(this, { vscode, model, settings, ui });
    this.active = new Map(); // fsPath -> { lines: [{revision, author, date}], baseRev }
    this.messages = new Map(); // repoRoot+rev -> msg
    const opts = { isWholeLine: false, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed };
    this.gutter = vscode.window.createTextEditorDecorationType({ ...opts, before: { color: new vscode.ThemeColor('editorLineNumber.foreground'), margin: '0 1.5em 0 0', fontStyle: 'normal' } });
    this.inline = vscode.window.createTextEditorDecorationType({ ...opts, after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 3em', fontStyle: 'italic' } });
    this.disposables = [this.gutter, this.inline,
      vscode.window.onDidChangeTextEditorSelection(e => { if (this.settings().blameMode === 'inline') this.render(e.textEditor); }),
      vscode.window.onDidChangeVisibleTextEditors(eds => { for (const ed of eds) this.render(ed); }),
      vscode.workspace.onDidSaveTextDocument(doc => { if (this.active.has(doc.uri.fsPath)) this.load(doc.uri.fsPath).then(() => this.renderAll(), () => {}); }),
      vscode.workspace.onDidCloseTextDocument(doc => { /* keep: reopening shows it again */ void doc; }),
    ];
  }

  isOn(fsPath) { return this.active.has(fsPath); }

  async toggle(editor) {
    const vscode = this.vscode;
    editor = editor || vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return vscode.window.showInformationMessage('Open a file from an svn working copy to see its blame.');
    const p = editor.document.uri.fsPath;
    if (this.active.has(p)) { this.active.delete(p); this.clear(editor); this.ctx(); return undefined; }
    await this.load(p);
    this.render(editor);
    this.ctx();
    return undefined;
  }

  ctx() {
    const ed = this.vscode.window.activeTextEditor;
    this.vscode.commands.executeCommand('setContext', 'zovoSvn.blameOn', !!(ed && this.active.has(ed.document.uri.fsPath)));
  }

  async load(p) {
    const vscode = this.vscode;
    const repo = this.model.repoFor(p);
    if (!repo) throw Object.assign(new Error('This file is not in an svn working copy.'), { friendly: true });
    const e = repo.entry(p);
    if (e && (e.kind === 'unversioned' || e.kind === 'added')) throw Object.assign(new Error('This file is not committed yet, so it has no line history.'), { friendly: true });
    const st = fs.statSync(p);
    const max = this.settings().blameMaxMB;
    if (st.size > max * 1048576) throw Object.assign(new Error(`This file is ${(st.size / 1048576).toFixed(0)} MB. Blame runs on files up to ${max} MB (setting zovoSvn.blameMaxMB).`), { friendly: true });
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'svn blame' }, () =>
      repo.exec(['blame', '--xml', '-x', '--ignore-eol-style', '--', arg(p)], { kind: 'read', timeoutMs: this.settings().networkTimeoutMs, maxBytes: 512 * 1048576 }));
    let lines = parseBlame(r.stdout).map(x => ({ revision: x.revision, author: x.author, date: x.date }));
    // svn 1.7+ blames the file on disk (local edits have no revision); older ones blame BASE. Unsaved edits in the
    // editor come on top. Map the lines of the editor onto the lines that svn blamed, so moved lines keep their blame.
    const split = t => { const a = t.split(/\r?\n/); if (a.length && a[a.length - 1] === '') a.pop(); return a; };
    const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === p);
    const disk = split(fs.readFileSync(p, 'utf8'));
    const now = doc ? split(doc.getText()) : disk;
    let ref = disk;
    if (lines.length !== disk.length) ref = split((await repo.exec(['cat', '-r', 'BASE', '--', arg(p)], { kind: 'read', maxBytes: max * 1048576 })).stdout);
    let mapped = lines;
    if (ref.length !== now.length || ref.some((l, i) => l !== now[i])) {
      const map = mapLines(ref, now);
      mapped = now.map((_, i) => (map && map[i] >= 0 && lines[map[i]] ? lines[map[i]] : { revision: 0, author: '', date: '' }));
    }
    this.active.set(p, { lines: mapped, repo });
    this.ui.success();
  }

  label(l) {
    if (!l || !l.revision) return 'not committed';
    return `r${l.revision} ${l.author || '?'} ${shortDate(l.date)}`;
  }

  hover(info, l) {
    const vscode = this.vscode;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['zovoSvn.openRevisionDiff', 'zovoSvn.showLog'] };
    if (!l || !l.revision) { md.appendMarkdown('**Not committed.** This line has local changes.'); return md; }
    const key = info.repo.root + '@' + l.revision;
    const msg = this.messages.get(key);
    md.appendMarkdown(`**r${l.revision}** by ${escapeMd(l.author || '?')}, ${escapeMd(String(l.date).replace('T', ' ').slice(0, 19))}\n\n`);
    if (msg !== undefined) md.appendMarkdown(escapeMd(msg).slice(0, 1500) + '\n\n');
    const args = encodeURIComponent(JSON.stringify([{ root: info.repo.root, revision: l.revision }]));
    md.appendMarkdown(`[Open the changes of r${l.revision}](command:zovoSvn.openRevisionDiff?${args})`);
    return md;
  }

  async fetchMessages(info, revs) {
    const missing = [...new Set(revs)].filter(r => r && !this.messages.has(info.repo.root + '@' + r)).slice(0, 40);
    if (!missing.length) return;
    for (const r of missing) this.messages.set(info.repo.root + '@' + r, ''); // no repeat while loading
    try {
      const args = ['log', '--xml'];
      for (const r of missing) args.push('-r', String(r));
      args.push('--', info.repo.info.repoRoot);
      const out = await info.repo.exec(args, { kind: 'read', timeoutMs: 30000 });
      for (const e of parseLog(out.stdout)) this.messages.set(info.repo.root + '@' + e.revision, e.msg);
    } catch (_) { /* offline: hovers show no message */ }
  }

  render(editor) {
    if (!editor) return;
    const p = editor.document.uri.fsPath;
    const info = this.active.get(p);
    if (!info) { this.clear(editor); return; }
    const vscode = this.vscode;
    const mode = this.settings().blameMode;
    const lines = info.lines;
    const n = Math.min(editor.document.lineCount, lines.length || editor.document.lineCount);
    if (mode === 'inline') {
      editor.setDecorations(this.gutter, []);
      const line = editor.selection.active.line;
      const l = lines[line];
      if (line >= editor.document.lineCount) { editor.setDecorations(this.inline, []); return; }
      const end = editor.document.lineAt(line).range.end;
      this.fetchMessages(info, [l && l.revision]);
      editor.setDecorations(this.inline, [{ range: new vscode.Range(end, end), hoverMessage: this.hover(info, l), renderOptions: { after: { contentText: this.label(l) } } }]);
      return;
    }
    editor.setDecorations(this.inline, []);
    const width = Math.max(...lines.slice(0, n).map(l => this.label(l).length), 10);
    const decos = [];
    let prev = null;
    const visible = new Set();
    for (const r of editor.visibleRanges) for (let i = r.start.line; i <= r.end.line; i++) visible.add(i);
    this.fetchMessages(info, [...visible].map(i => lines[i] && lines[i].revision));
    for (let i = 0; i < n; i++) {
      const l = lines[i];
      const same = prev && l && prev.revision === l.revision && i > 0;
      const text = same ? '' : this.label(l);
      decos.push({ range: new vscode.Range(i, 0, i, 0), hoverMessage: this.hover(info, l), renderOptions: { before: { contentText: (text || ' ').padEnd(width, ' '), width: `${width + 2}ch` } } });
      prev = l;
    }
    editor.setDecorations(this.gutter, decos);
  }

  renderAll() { for (const ed of this.vscode.window.visibleTextEditors) this.render(ed); }

  clear(editor) { editor.setDecorations(this.gutter, []); editor.setDecorations(this.inline, []); }

  /** The revision of the line under the cursor, for "Open revision of this line". */
  lineAt(editor) {
    const info = editor && this.active.get(editor.document.uri.fsPath);
    if (!info) return null;
    const l = info.lines[editor.selection.active.line];
    return l && l.revision ? { root: info.repo.root, revision: l.revision } : null;
  }

  dispose() { for (const d of this.disposables) try { d.dispose(); } catch (_) {} }
}

function escapeMd(s) { return String(s).replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&'); }

module.exports = { BlameController, mapLines, escapeMd };
void path;
