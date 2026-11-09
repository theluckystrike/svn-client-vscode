'use strict';
// Changelist manager: a tree in the Source Control side bar. Each working copy lists its changelists and the
// changed files without one. Drag files (from this tree or the Explorer) onto a changelist to move them there,
// or onto "No changelist" to take them out.
const path = require('path');

const MIME = 'application/vnd.code.tree.zovosvn.changelists';
const NONE = '\u0000none';

function createChangelistTree({ vscode, model, ui, pro }) {
  const emitter = new vscode.EventEmitter();
  const provider = {
    onDidChangeTreeData: emitter.event,
    getChildren(el) {
      if (!el) {
        if (model.repos.length === 1) return listsOf(model.repos[0]);
        return model.repos.map(r => ({ type: 'repo', repo: r }));
      }
      if (el.type === 'repo') return listsOf(el.repo);
      if (el.type === 'list') {
        const files = [];
        for (const e of el.repo.entries.values()) {
          if (e.kind === 'unversioned' || e.kind === 'conflicted') continue;
          if ((el.name === NONE && !e.changelist) || e.changelist === el.name) files.push({ type: 'file', repo: el.repo, entry: e });
        }
        return files.sort((a, b) => a.entry.rel.localeCompare(b.entry.rel)).slice(0, 2000);
      }
      return [];
    },
    getTreeItem(el) {
      if (el.type === 'repo') {
        const t = new vscode.TreeItem(el.repo.label, vscode.TreeItemCollapsibleState.Expanded);
        t.iconPath = new vscode.ThemeIcon('repo'); t.contextValue = 'repo'; return t;
      }
      if (el.type === 'list') {
        const n = [...el.repo.entries.values()].filter(e => e.kind !== 'unversioned' && e.kind !== 'conflicted' && ((el.name === NONE && !e.changelist) || e.changelist === el.name)).length;
        const t = new vscode.TreeItem(el.name === NONE ? 'No changelist' : el.name, vscode.TreeItemCollapsibleState.Expanded);
        t.description = `${n} file${n === 1 ? '' : 's'}`;
        t.iconPath = new vscode.ThemeIcon(el.name === NONE ? 'list-unordered' : 'tag');
        t.contextValue = el.name === NONE ? 'nochangelist' : 'changelist';
        t.tooltip = el.name === NONE ? 'Changed files that are in no changelist. Drop files here to take them out of their changelist.' : `Changelist ${el.name}. Drop files here to move them into it.`;
        return t;
      }
      const t = new vscode.TreeItem(vscode.Uri.file(el.entry.abs), vscode.TreeItemCollapsibleState.None);
      t.description = path.dirname(el.entry.rel) === '.' ? '' : path.dirname(el.entry.rel);
      t.command = { command: 'zovoSvn.openChange', title: 'Open Changes', arguments: [vscode.Uri.file(el.entry.abs)] };
      t.contextValue = 'clfile';
      return t;
    },
    getParent(el) { if (el.type === 'file') return { type: 'list', repo: el.repo, name: el.entry.changelist || NONE }; if (el.type === 'list' && model.repos.length > 1) return { type: 'repo', repo: el.repo }; return undefined; },
  };

  function listsOf(repo) {
    const extra = repo.extraChangelists || [];
    const names = [...new Set([...repo.changelists, ...extra])].sort();
    return [{ type: 'list', repo, name: NONE }, ...names.map(name => ({ type: 'list', repo, name }))];
  }

  const dnd = {
    dragMimeTypes: [MIME, 'text/uri-list'],
    dropMimeTypes: [MIME, 'text/uri-list'],
    handleDrag(source, dataTransfer) {
      const files = source.filter(s => s.type === 'file').map(s => s.entry.abs);
      if (files.length) dataTransfer.set(MIME, new vscode.DataTransferItem(JSON.stringify(files)));
    },
    async handleDrop(target, dataTransfer) {
      if (!target || target.type !== 'list') return;
      let files = [];
      const own = dataTransfer.get(MIME);
      if (own) files = JSON.parse(await own.asString());
      else {
        const uris = dataTransfer.get('text/uri-list');
        if (uris) files = (await uris.asString()).split(/\r?\n/).filter(Boolean).map(u => { try { return vscode.Uri.parse(u.trim()).fsPath; } catch (_) { return ''; } }).filter(Boolean);
      }
      files = files.filter(f => target.repo.contains(f));
      if (!files.length) return;
      await move(target.repo, target.name === NONE ? '' : target.name, files);
    },
  };

  async function move(repo, name, files) {
    if (!(await pro.allow('Changelist manager', 'Move files between changelists by drag and drop.'))) return;
    try {
      await repo.changelist(name, files);
      await repo.refresh();
    } catch (e) { ui.error(e, repo); }
  }

  const view = vscode.window.createTreeView('zovoSvn.changelists', { treeDataProvider: provider, dragAndDropController: dnd, canSelectMany: true, showCollapseAll: true });
  return { view, refresh: () => emitter.fire(undefined), move, NONE };
}

module.exports = { createChangelistTree, NONE, MIME };
