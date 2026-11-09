(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
  const h = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k))); return e; };

  const bar = h('div', { class: 'toolbar' }, h('strong', {}, 'Revision graph'), h('span', { class: 'muted', id: 'info' }, 'Reading branches and tags...'),
    h('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'reload' }) }, 'Reload'));
  const wrap = h('div', { class: 'graph', id: 'graph' });
  const side = h('div', { class: 'side', id: 'side' }, h('p', { class: 'muted' }, 'Click a branch or tag.'));
  app.append(bar, h('div', { class: 'body' }, wrap, side));

  function select(r, current) {
    side.textContent = '';
    side.append(h('h3', {}, r.name), h('div', { class: 'muted' }, r.rel),
      h('p', {}, r.kind === 'trunk' ? 'Main line.' : `Copied in r${r.created || '?'}${r.from ? ` from ${r.from}@${r.fromRev}` : ''}${r.createdBy ? ` by ${r.createdBy}` : ''}.`),
      h('p', {}, `Last change r${r.revision}${r.author ? ` by ${r.author}` : ''}${r.date ? `, ${String(r.date).slice(0, 10)}` : ''}.`),
      r.msg ? h('pre', { class: 'msg' }, r.msg) : null,
      h('div', { class: 'actions' },
        r.rel === current ? h('span', { class: 'muted' }, 'This working copy is on it.') : h('button', { onclick: () => vscode.postMessage({ type: 'switch', rel: r.rel }) }, 'Switch to it'),
        r.kind !== 'tag' && r.rel !== current ? h('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'merge', rel: r.rel }) }, 'Merge from it') : null,
        h('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'copyUrl', rel: r.rel }) }, 'Copy URL')));
  }

  function draw(g) {
    wrap.textContent = '';
    document.getElementById('info').textContent = `${g.shown} of ${g.total} lines${g.shown < g.total ? ' (newest shown)' : ''}, up to r${g.head}`;
    const lanes = g.refs.filter(r => r.kind !== 'tag');
    const tags = g.refs.filter(r => r.kind === 'tag');
    // x positions: only revisions that matter, in order, so long quiet stretches do not waste space
    const revs = new Set([0]);
    for (const r of g.refs) { revs.add(r.created || 0); revs.add(r.revision); if (r.fromRev) revs.add(r.fromRev); }
    const order = [...revs].sort((a, b) => a - b);
    const X = new Map(order.map((r, i) => [r, 160 + i * 46]));
    const x = r => { if (X.has(r)) return X.get(r); let best = 160; for (const [k, v] of X) if (k <= r) best = v; return best; };
    const laneY = new Map();
    lanes.forEach((r, i) => laneY.set(r.rel.replace(/^\^/, ''), 40 + i * 44));
    const yOf = p => { for (const [k, v] of laneY) if (p === k || p.startsWith(k + '/')) return v; return null; };
    const height = 60 + lanes.length * 44 + (tags.length ? 30 : 0);
    const width = Math.max(...[...X.values()], 400) + 120;
    const svg = s('svg', { width, height, role: 'img', 'aria-label': 'Branches and tags over revisions' });
    // revision ticks
    for (const r of order) if (r) { svg.append(s('line', { x1: x(r), y1: 18, x2: x(r), y2: height - 10, class: 'tick' })); svg.append(s('text', { x: x(r), y: 12, class: 'rev', 'text-anchor': 'middle' }, 'r' + r)); }
    lanes.forEach((r, i) => {
      const y = 40 + i * 44;
      const x0 = x(r.created || 0), x1 = x(r.revision);
      const g1 = s('g', { class: 'lane ' + r.kind + (r.rel === g.current ? ' current' : ''), tabindex: 0 });
      g1.append(s('text', { x: 8, y: y + 4, class: 'name' }, r.name.length > 20 ? r.name.slice(0, 19) + '…' : r.name));
      g1.append(s('line', { x1: x0, y1: y, x2: Math.max(x1, x0 + 1), y2: y, class: 'path' }));
      g1.append(s('circle', { cx: x0, cy: y, r: 5, class: 'start' }));
      g1.append(s('circle', { cx: x1, cy: y, r: 4, class: 'end' }));
      if (r.from && r.fromRev) {
        const sy = yOf(r.from);
        if (sy != null) svg.append(s('path', { d: `M${x(r.fromRev)},${sy} C${x(r.fromRev) + 20},${sy} ${x0 - 20},${y} ${x0},${y}`, class: 'copy' }));
      }
      const title = s('title', {}, `${r.rel}\ncopied in r${r.created}${r.from ? ' from ' + r.from + '@' + r.fromRev : ''}\nlast change r${r.revision}`);
      g1.append(title);
      g1.addEventListener('click', () => select(r, g.current));
      g1.addEventListener('keydown', e => { if (e.key === 'Enter') select(r, g.current); });
      svg.append(g1);
    });
    for (const t of tags) {
      const sy = t.from ? yOf(t.from) : null;
      const tx = x(t.fromRev || t.created || t.revision);
      const ty = sy != null ? sy : height - 20;
      const g2 = s('g', { class: 'tag', tabindex: 0 });
      g2.append(s('path', { d: `M${tx},${ty - 13} l6,6 l-6,6 l-6,-6 z`, class: 'diamond' }));
      g2.append(s('text', { x: tx + 8, y: ty - 10, class: 'tagname' }, t.name));
      g2.append(s('title', {}, `${t.rel}\nfrom ${t.from || '?'}@${t.fromRev || '?'}`));
      g2.addEventListener('click', () => select(t, g.current));
      svg.append(g2);
    }
    wrap.append(svg);
    if (!g.refs.length) wrap.append(h('p', { class: 'muted' }, 'No trunk, branches or tags folders found next to this working copy.'));
    const cur = g.refs.find(r => r.rel === g.current) || g.refs[0];
    if (cur) select(cur, g.current);
  }

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'graph') draw(m.graph);
    if (m.type === 'error') { document.getElementById('info').textContent = ''; wrap.replaceChildren(h('p', { class: 'error' }, m.text)); }
  });
  vscode.postMessage({ type: 'ready' });
})();
