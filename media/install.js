(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const data = JSON.parse(document.getElementById('data').textContent);
  const app = document.getElementById('app');
  const h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  };
  const osName = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[data.os] || data.os;
  const wrap = h('div', { class: 'wrap' },
    h('h1', {}, 'This folder is an svn working copy, but the svn command line was not found'),
    h('p', {}, 'SVN Client runs the svn command line that is installed on your computer. It does not bundle one. Install it once, then press Retry.'),
    data.configured ? h('p', { class: 'warn' }, `The setting zovoSvn.path points to "${data.configured}", and no working svn is there. Fix or clear the setting.`) : null,
    data.reason ? h('p', { class: 'muted' }, data.reason) : null,
    h('h2', {}, `Install on ${osName}`));
  const ul = h('div', { class: 'steps' });
  for (const [name, cmd, note] of data.steps) {
    ul.append(h('div', { class: 'step' },
      h('div', { class: 'name' }, name),
      cmd ? h('div', { class: 'cmd' }, h('code', {}, cmd),
        h('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'copy', text: cmd }) }, 'Copy'),
        h('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'terminal', text: cmd }) }, 'Paste in a terminal')) : null,
      note ? h('div', { class: 'muted' }, note) : null));
  }
  wrap.append(ul,
    h('h2', {}, 'Already installed?'),
    h('p', {}, 'VS Code may have started with a short PATH. Set the full path of svn in the setting zovoSvn.path, for example /opt/homebrew/bin/svn or C:\\Program Files\\TortoiseSVN\\bin\\svn.exe.'),
    h('div', { class: 'actions' },
      h('button', { id: 'retry', onclick: () => vscode.postMessage({ type: 'retry' }) }, 'Retry'),
      h('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'setPath' }) }, 'Set the svn path')),
    h('p', { class: 'muted' }, 'svn 1.7 or later is needed. Nothing is downloaded by this extension.'));
  app.append(wrap);
})();
