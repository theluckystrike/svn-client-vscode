'use strict';
// Revision graph: trunk, branches and tags over time. Each branch is a lane from the revision it was copied in to
// its last change, joined to the lane it came from. Tags are marks on their source lane. Buttons switch to,
// merge from or copy the URL of a branch.
const { listRefs, copySource, toUrl } = require('../layout');
const { page } = require('./html');

const MAX_REFS = 80;

async function buildGraph(repo, token) {
  const refs = await listRefs(repo);
  const all = [...(refs.trunk ? [{ ...refs.trunk, kind: 'trunk' }] : []),
    ...refs.branches.map(b => ({ ...b, kind: 'branch' })),
    ...refs.tags.map(t => ({ ...t, kind: 'tag' }))];
  // newest first when there are too many
  const pick = all.length > MAX_REFS ? [all[0], ...all.slice(1).sort((a, b) => b.revision - a.revision).slice(0, MAX_REFS - 1)] : all;
  const out = [];
  await Promise.all(pick.map(async r => {
    if (token && token.isCancellationRequested) return;
    let src = null;
    try { src = await copySource(repo, r.rel); } catch (_) {}
    out.push({ ...r, created: src ? src.created : 0, from: src ? src.from : '', fromRev: src ? src.fromRev : null, createdBy: src ? src.author : '', msg: src ? src.msg : '' });
  }));
  out.sort((a, b) => (a.kind === 'trunk' ? -1 : b.kind === 'trunk' ? 1 : a.created - b.created));
  const current = repo.info.relativeUrl;
  return { base: refs.base, refs: out, total: all.length, shown: pick.length, current, head: Math.max(0, ...out.map(r => r.revision)) };
}

let current = null;

async function showGraph({ vscode, context, repo, support, settings, ui }) {
  if (current) current.dispose();
  const panel = vscode.window.createWebviewPanel('zovoSvn.graph', `SVN Revision Graph: ${repo.label}`, vscode.ViewColumn.Active, {
    enableScripts: true, retainContextWhenHidden: true, enableCommandUris: support.commandUris('zovoSvn'),
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
  });
  current = panel;
  panel.onDidDispose(() => { if (current === panel) current = null; });
  panel.webview.html = page({ vscode, context, webview: panel.webview, script: 'graph.js', css: 'graph.css', title: 'Revision graph', support, settings, data: { label: repo.label } });
  const load = async () => {
    try {
      const g = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'SVN: reading branches and tags', cancellable: true }, (_p, token) => buildGraph(repo, token));
      panel.webview.postMessage({ type: 'graph', graph: g });
      ui.success();
    } catch (e) { panel.webview.postMessage({ type: 'error', text: ui.explain(e) }); }
  };
  panel.webview.onDidReceiveMessage(async m => {
    if (m.type === 'ready' || m.type === 'reload') return load();
    if (m.type === 'switch') return vscode.commands.executeCommand('zovoSvn.switch', repo.sc, m.rel);
    if (m.type === 'merge') return vscode.commands.executeCommand('zovoSvn.merge', repo.sc, m.rel);
    if (m.type === 'copyUrl') { await vscode.env.clipboard.writeText(toUrl(repo.info.repoRoot, m.rel)); return vscode.window.setStatusBarMessage('Copied the URL', 2000); }
    return undefined;
  });
  return panel;
}

module.exports = { showGraph, buildGraph };
