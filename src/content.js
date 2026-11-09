'use strict';
// Read-only documents for old versions of a file: zovo-svn:<path>?{"rev":"BASE"} or {"url":..., "rev":N}.
// BASE is read from the working copy's pristine copy (no network). A URL revision comes from the user's server.
const path = require('path');
const { runSvn, arg } = require('./svn/runner');
const { fromSvnUri } = require('./repository');

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function createContentProvider({ vscode, model, settings }) {
  const emitter = new vscode.EventEmitter();
  return {
    onDidChange: emitter.event,
    fire: uri => emitter.fire(uri),
    async provideTextDocumentContent(uri, token) {
      const q = fromSvnUri(uri);
      if (q.empty) return '';
      const svn = model.svn;
      if (!svn) return '(svn is not installed)';
      const maxBytes = settings().maxDiffMB * 1048576;
      let args, cwd;
      if (q.url) { args = ['cat', '-r', String(q.rev), '--', q.url + '@' + q.rev]; cwd = q.root || undefined; }
      else { args = ['cat', '-r', String(q.rev || 'BASE'), '--', arg(q.fsPath)]; cwd = q.root || path.dirname(q.fsPath); }
      const repo = q.root ? model.repos.find(r => r.root === q.root) : model.repoFor(q.fsPath);
      try {
        const run = repo
          ? repo.exec(args, { kind: 'read', encoding: 'buffer', maxBytes, token, timeoutMs: q.url ? settings().networkTimeoutMs : settings().commandTimeoutMs })
          : runSvn(svn.path, args, { cwd, encoding: 'buffer', maxBytes, token, timeoutMs: settings().networkTimeoutMs });
        const r = await run;
        const buf = r.stdout;
        if (looksBinary(buf)) return `(binary file, ${buf.length.toLocaleString('en-US')} bytes: no text to compare)`;
        return buf.toString('utf8');
      } catch (e) {
        if (e.code === 'TOO_LARGE') return `(this version is larger than ${settings().maxDiffMB} MB, the zovoSvn.maxDiffMB setting, so it is not shown)`;
        if (/E195012|E160013|E200009|path not found|was not found|non-existent/i.test(e.stderr + ' ' + e.message)) return '';
        return `(could not read this version: ${e.message})`;
      }
    },
  };
}

module.exports = { createContentProvider, looksBinary };
