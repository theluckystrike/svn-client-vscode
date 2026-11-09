'use strict';
// A small XML reader for the output of `svn ... --xml`. svn writes well-formed UTF-8 XML with no DTD, so this
// handles elements, attributes, text, the five named entities, numeric references, comments, CDATA and the
// declaration. It returns { name, attrs, children, text } nodes. No dependency, no network.

const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch (_) { return m; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : m;
  });
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1]] = decode(m[3] !== undefined ? m[3] : m[4]);
  return attrs;
}

function parseXml(xml) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { stack[stack.length - 1].text += decode(xml.slice(i)); break; }
    if (lt > i) stack[stack.length - 1].text += decode(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      stack[stack.length - 1].text += xml.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3; continue;
    }
    if (xml[lt + 1] === '?' || xml[lt + 1] === '!') { const e = xml.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    // find the end of the tag, skipping '>' inside quoted attribute values
    let j = lt + 1, q = null;
    for (; j < n; j++) {
      const c = xml[j];
      if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break;
    }
    if (j >= n) throw new Error('XML: unclosed tag at ' + lt);
    const body = xml.slice(lt + 1, j);
    i = j + 1;
    if (body[0] === '/') {
      const name = body.slice(1).trim();
      // pop to the matching element (tolerates stray closers)
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      continue;
    }
    const selfClose = body.endsWith('/');
    const inner = selfClose ? body.slice(0, -1) : body;
    const sp = inner.search(/\s/);
    const name = sp < 0 ? inner : inner.slice(0, sp);
    const node = { name, attrs: sp < 0 ? {} : parseAttrs(inner.slice(sp)), children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

// helpers
const child = (node, name) => (node && node.children.find(c => c.name === name)) || null;
const children = (node, name) => (node ? node.children.filter(c => c.name === name) : []);
const text = (node, name) => { const c = name ? child(node, name) : node; return c ? c.text : ''; };
function find(node, name) {
  if (!node) return null;
  for (const c of node.children) { if (c.name === name) return c; const f = find(c, name); if (f) return f; }
  return null;
}

module.exports = { parseXml, decode, child, children, text, find };
