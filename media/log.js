// SVN Log webview. Plain script (no framework). All text from svn is set with textContent, never as HTML.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const data = JSON.parse(document.getElementById('data').textContent);
  const app = document.getElementById('app');
  const h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  };

  let rows = [];          // log entries shown
  let selected = null;    // revision shown in the details
  const picked = new Set(); // revisions ticked for "Compare"
  let done = false, loading = false;

  const q = h('input', { type: 'search', id: 'q', placeholder: 'Message, path or author', title: 'Searches the message, author and paths (svn log --search)', size: 26 });
  const author = h('input', { type: 'text', id: 'author', placeholder: 'Author', size: 12 });
  const from = h('input', { type: 'date', id: 'from', title: 'From date' });
  const to = h('input', { type: 'date', id: 'to', title: 'To date' });
  const apply = h('button', { id: 'apply', onclick: () => runFilter() }, 'Filter');
  const clear = h('button', { class: 'secondary', id: 'clear', onclick: () => { q.value = author.value = from.value = to.value = ''; runFilter(); } }, 'Clear');
  const compare = h('button', { class: 'secondary', id: 'compare', disabled: true, title: 'Tick two revisions, then compare them', onclick: () => { const [a, b] = [...picked]; vscode.postMessage({ type: 'diffRevs', a, b }); } }, 'Compare 2 revisions');
  const status = h('span', { class: 'muted', id: 'status' }, '');
  for (const i of [q, author]) i.addEventListener('keydown', e => { if (e.key === 'Enter') runFilter(); });

  const tbody = h('tbody', { id: 'rows' });
  const table = h('table', { class: 'log', role: 'grid', 'aria-label': 'Revisions' },
    h('thead', {}, h('tr', {}, h('th', { class: 'pick', title: 'Pick two to compare' }, ''), h('th', { class: 'rev' }, 'Revision'), h('th', { class: 'who' }, 'Author'), h('th', { class: 'when' }, 'Date'), h('th', {}, 'Message'))),
    tbody);
  const more = h('button', { class: 'secondary', id: 'more', onclick: () => loadMore() }, 'Load more');
  const list = h('div', { class: 'list', id: 'list' }, table, h('div', { class: 'more' }, more));
  const details = h('div', { class: 'details', id: 'details' }, h('p', { class: 'muted' }, 'Pick a revision to see its message and changed paths.'));

  app.append(
    h('div', { class: 'toolbar' }, h('strong', {}, data.target === '.' ? 'Working copy' : data.target), q, author, h('label', {}, 'from', from), h('label', {}, 'to', to), apply, clear, compare, status),
    h('div', { class: 'split' }, list, details));

  list.addEventListener('scroll', () => { if (!done && !loading && list.scrollTop + list.clientHeight > list.scrollHeight - 200) loadMore(); });

  function runFilter() {
    picked.clear(); updateCompare();
    vscode.postMessage({ type: 'filter', filter: { text: q.value.trim(), author: author.value.trim(), from: from.value, to: to.value } });
  }
  function loadMore() { if (!done && !loading) vscode.postMessage({ type: 'more' }); }
  function updateCompare() { compare.disabled = picked.size !== 2; compare.textContent = picked.size === 2 ? `Compare r${Math.min(...picked)} and r${Math.max(...picked)}` : 'Compare 2 revisions'; }

  const fmtDate = d => { if (!d) return ''; const t = new Date(d); return Number.isNaN(t.getTime()) ? d : t.toISOString().slice(0, 16).replace('T', ' '); };
  const firstLine = m => (m || '').split(/\r?\n/).find(l => l.trim()) || '';

  function row(e) {
    const cb = h('input', { type: 'checkbox', 'aria-label': 'Pick r' + e.revision, onclick: ev => { ev.stopPropagation(); if (cb.checked) { if (picked.size >= 2) { const first = [...picked][0]; picked.delete(first); const o = tbody.querySelector(`tr[data-rev="${first}"] input`); if (o) o.checked = false; } picked.add(e.revision); } else picked.delete(e.revision); updateCompare(); } });
    const tr = h('tr', { 'data-rev': e.revision, tabindex: 0, onclick: () => select(e.revision), onkeydown: ev => { if (ev.key === 'Enter') select(e.revision); if (ev.key === 'ArrowDown' && tr.nextSibling) tr.nextSibling.focus(); if (ev.key === 'ArrowUp' && tr.previousSibling) tr.previousSibling.focus(); } },
      h('td', { class: 'pick' }, cb), h('td', { class: 'rev mono' }, 'r' + e.revision), h('td', { class: 'who' }, e.author || '(no author)'), h('td', { class: 'when mono' }, fmtDate(e.date)), h('td', { class: 'msg' }, firstLine(e.msg)));
    return tr;
  }

  function select(rev) {
    selected = rev;
    for (const tr of tbody.children) tr.classList.toggle('sel', Number(tr.dataset.rev) === rev);
    const e = rows.find(r => r.revision === rev);
    details.textContent = '';
    if (!e) return;
    const copy = h('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'copy', text: 'r' + e.revision }) }, 'Copy r' + e.revision);
    details.append(
      h('div', { class: 'head' }, h('strong', {}, 'r' + e.revision), ' ', h('span', { class: 'muted' }, `${e.author || '(no author)'}, ${fmtDate(e.date)}`), ' ', copy),
      h('pre', { class: 'msgfull' }, e.msg || '(no message)'),
      h('div', { class: 'muted' }, `${e.paths.length} changed path${e.paths.length === 1 ? '' : 's'}. Click a file to see its diff.`));
    const ul = h('ul', { class: 'paths' });
    for (const p of e.paths.slice(0, 2000)) {
      const label = p.path + (p.copyfromPath ? `  (from ${p.copyfromPath}@${p.copyfromRev})` : '');
      const li = h('li', { class: 'act-' + p.action },
        h('span', { class: 'act mono', title: { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Replaced' }[p.action] || p.action }, p.action),
        p.kind === 'dir' ? h('span', {}, label) : h('a', { href: '#', onclick: ev => { ev.preventDefault(); vscode.postMessage({ type: 'diffPath', rev: e.revision, path: p.path }); } }, label),
        p.kind !== 'dir' && p.action !== 'D' ? h('a', { href: '#', class: 'open', title: 'Open this file as it was in r' + e.revision, onclick: ev => { ev.preventDefault(); vscode.postMessage({ type: 'openAt', rev: e.revision, path: p.path }); } }, 'open') : null);
      ul.append(li);
    }
    if (e.paths.length > 2000) ul.append(h('li', { class: 'muted' }, `and ${e.paths.length - 2000} more`));
    details.append(ul);
  }

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'loading') { loading = true; status.textContent = 'Loading...'; if (m.fresh) { rows = []; tbody.textContent = ''; } }
    else if (m.type === 'entries') {
      loading = false; done = m.done;
      if (m.fresh) { rows = []; tbody.textContent = ''; }
      rows.push(...m.entries);
      const frag = document.createDocumentFragment();
      for (const e of m.entries) frag.append(row(e));
      tbody.append(frag);
      status.textContent = `${rows.length} revision${rows.length === 1 ? '' : 's'}${done ? '' : ', more on scroll'}`;
      more.style.display = done ? 'none' : '';
      if (m.fresh && rows.length) select(rows[0].revision);
      if (m.fresh && !rows.length) details.replaceChildren(h('p', { class: 'muted' }, 'No revision matches.'));
      // short pages after an author filter: keep loading until the list scrolls
      if (!done && list.scrollHeight <= list.clientHeight + 10) loadMore();
    } else if (m.type === 'error') { loading = false; status.textContent = ''; status.append(h('span', { class: 'error' }, m.text)); }
  });
  vscode.postMessage({ type: 'ready' });
})();
