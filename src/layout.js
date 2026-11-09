'use strict';
// The standard svn layout: <base>/trunk, <base>/branches/<name>, <base>/tags/<name>. Works out <base> from the
// working copy's relative URL, so ^/trunk and ^/project/trunk both work.
const { parseList, parseLog } = require('./svn/parse');

/** '^/proj/branches/x/sub' -> { base: '^/proj', kind: 'branch', name: 'x', rest: '/sub' } */
function splitUrl(relativeUrl) {
  const u = String(relativeUrl || '').replace(/\/+$/, '');
  let m = u.match(/^(.*?)\/(trunk)(\/.*)?$/);
  if (m) return { base: m[1] || '^', kind: 'trunk', name: 'trunk', rest: m[3] || '' };
  m = u.match(/^(.*?)\/(branches|tags)\/([^/]+)(\/.*)?$/);
  if (m) return { base: m[1] || '^', kind: m[2] === 'tags' ? 'tag' : 'branch', name: m[3], rest: m[4] || '' };
  return { base: u || '^', kind: 'other', name: u.split('/').pop() || '', rest: '' };
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }

/** ^/x -> full URL with the repository root. */
function toUrl(repoRoot, rel) {
  if (!rel.startsWith('^')) return rel;
  const tail = rel.slice(1).replace(/^\/+/, '');
  return repoRoot.replace(/\/+$/, '') + (tail ? '/' + tail.split('/').map(s => encodeURIComponent(safeDecode(s))).join('/') : '');
}

/** Lists trunk, branches and tags. Missing folders give empty lists. */
async function listRefs(repo) {
  const info = repo.info;
  const { base } = splitUrl(info.relativeUrl);
  const out = { base, trunk: null, branches: [], tags: [] };
  const ls = async (sub) => {
    try {
      const r = await repo.exec(['list', '--xml', '--', toUrl(info.repoRoot, `${base}/${sub}`)], { kind: 'read', timeoutMs: repo.settings().networkTimeoutMs });
      return parseList(r.stdout).filter(e => e.kind === 'dir');
    } catch (e) { if (/E200009|E160013|E170000|non-existent|not found/i.test(e.stderr + e.message)) return []; throw e; }
  };
  const [top, branches, tags] = await Promise.all([ls(''), ls('branches'), ls('tags')]);
  const t = top.find(e => e.name === 'trunk');
  if (t) out.trunk = { name: 'trunk', rel: `${base}/trunk`, revision: t.revision, author: t.author, date: t.date };
  out.branches = branches.map(e => ({ name: e.name, rel: `${base}/branches/${e.name}`, revision: e.revision, author: e.author, date: e.date }));
  out.tags = tags.map(e => ({ name: e.name, rel: `${base}/tags/${e.name}`, revision: e.revision, author: e.author, date: e.date }));
  return out;
}

/** Where a branch or tag was copied from: its oldest revision on its own path (svn log --stop-on-copy). */
async function copySource(repo, rel) {
  const r = await repo.exec(['log', '--xml', '-v', '--stop-on-copy', '-r', '1:HEAD', '-l', '1', '--', toUrl(repo.info.repoRoot, rel)], { kind: 'read', timeoutMs: repo.settings().networkTimeoutMs });
  const e = parseLog(r.stdout)[0];
  if (!e) return null;
  const own = rel.replace(/^\^/, '');
  const p = e.paths.find(x => x.copyfromPath && (own === x.path || own.startsWith(x.path + '/') || x.path.startsWith(own)));
  return { created: e.revision, author: e.author, date: e.date, msg: e.msg, from: p ? p.copyfromPath : '', fromRev: p ? p.copyfromRev : null };
}

module.exports = { splitUrl, toUrl, listRefs, copySource };
