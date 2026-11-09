'use strict';
// Letters and colours for changed files in the Explorer, the editor tabs and the Source Control list.
const { LOOK } = require('./repository');

function createDecorations({ vscode, model }) {
  const emitter = new vscode.EventEmitter();
  let last = new Map();
  const provider = {
    onDidChangeFileDecorations: emitter.event,
    provideFileDecoration(uri) {
      if (uri.scheme !== 'file') return undefined;
      const repo = model.repoFor(uri.fsPath);
      if (!repo) return undefined;
      const e = repo.entry(uri.fsPath);
      if (!e) return undefined;
      const look = LOOK[e.kind];
      if (!look) return undefined;
      return { badge: look[0], tooltip: 'SVN: ' + look[1], color: new vscode.ThemeColor(look[2]), propagate: e.kind === 'conflicted' };
    },
  };
  /** Fires for the files whose state changed since the last call (old and new), so the Explorer repaints. */
  function update() {
    const now = new Map();
    for (const r of model.repos) for (const [p, e] of r.entries) now.set(p, e.kind);
    const changed = [];
    for (const [p, k] of now) if (last.get(p) !== k) changed.push(p);
    for (const p of last.keys()) if (!now.has(p)) changed.push(p);
    last = now;
    if (changed.length) emitter.fire(changed.length > 5000 ? undefined : changed.map(p => vscode.Uri.file(p)));
  }
  return { provider, update };
}

module.exports = { createDecorations };
