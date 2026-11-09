'use strict';
// Tiny glob matcher for the exclude setting: ** (any folders), * (any characters but /), ? (one character).
// A pattern with no slash matches a name at any depth (like .gitignore), so "node_modules" and "build" work.
const cache = new Map();

function toRegExp(glob) {
  let g = String(glob).trim().replace(/\\/g, '/');
  if (!g) return null;
  if (!g.includes('/')) g = '**/' + g + '/**';
  else if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // "a/**" also matches "a" itself
  re = re.replace(/\/\.\*$/, '(?:/.*)?');
  return new RegExp('^' + re + '$');
}

function matchAny(rel, globs) {
  if (!globs || !globs.length) return false;
  const p = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
  for (const g of globs) {
    let re = cache.get(g);
    if (re === undefined) { re = toRegExp(g); cache.set(g, re); }
    if (re && re.test(p)) return true;
  }
  return false;
}

module.exports = { matchAny, toRegExp };
