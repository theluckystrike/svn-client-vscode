'use strict';
// Turns `svn --xml` output into plain objects. Pure functions: tests feed them real svn output.
const { parseXml, child, children, text, find } = require('./xml');

/** svn status --xml. Paths stay as svn printed them (relative to the cwd when the target was relative). */
function parseStatus(xml) {
  const doc = parseXml(xml);
  const status = child(doc, 'status');
  const out = [];
  const read = (entry, changelist) => {
    const wc = child(entry, 'wc-status');
    if (!wc) return;
    const a = wc.attrs;
    const commit = child(wc, 'commit');
    const lock = child(wc, 'lock');
    out.push({
      path: entry.attrs.path,
      item: a.item || 'none',
      props: a.props || 'none',
      revision: a.revision ? Number(a.revision) : null,
      copied: a.copied === 'true',
      switched: a.switched === 'true',
      wcLocked: a['wc-locked'] === 'true',
      treeConflicted: a['tree-conflicted'] === 'true',
      movedFrom: a['moved-from'] || '',
      movedTo: a['moved-to'] || '',
      fileExternal: a['file-external'] === 'true',
      changelist: changelist || '',
      commit: commit ? { revision: Number(commit.attrs.revision), author: text(commit, 'author'), date: text(commit, 'date') } : null,
      lockOwner: lock ? text(lock, 'owner') : '',
    });
  };
  for (const t of children(status, 'target')) for (const e of children(t, 'entry')) read(e, '');
  for (const cl of children(status, 'changelist')) for (const e of children(cl, 'entry')) read(e, cl.attrs.name || '');
  return out;
}

/** svn info --xml (one or more entries). */
function parseInfo(xml) {
  const doc = parseXml(xml);
  return children(child(doc, 'info'), 'entry').map(e => {
    const repo = child(e, 'repository');
    const wc = child(e, 'wc-info');
    const commit = child(e, 'commit');
    return {
      path: e.attrs.path,
      kind: e.attrs.kind,
      revision: Number(e.attrs.revision || 0),
      url: text(e, 'url'),
      relativeUrl: text(e, 'relative-url'),
      repoRoot: text(repo, 'root'),
      uuid: text(repo, 'uuid'),
      wcRoot: text(wc, 'wcroot-abspath'),
      schedule: text(wc, 'schedule'),
      depth: text(wc, 'depth'),
      commit: commit ? { revision: Number(commit.attrs.revision || 0), author: text(commit, 'author'), date: text(commit, 'date') } : null,
      conflict: !!find(e, 'conflict') || !!find(e, 'tree-conflict'),
    };
  });
}

/** svn log --xml [-v]. */
function parseLog(xml) {
  const doc = parseXml(xml);
  return children(child(doc, 'log'), 'logentry').map(e => {
    const paths = child(e, 'paths');
    return {
      revision: Number(e.attrs.revision),
      author: text(e, 'author'),
      date: text(e, 'date'),
      msg: text(e, 'msg'),
      paths: children(paths, 'path').map(p => ({
        path: p.text,
        action: p.attrs.action,
        kind: p.attrs.kind || '',
        copyfromPath: p.attrs['copyfrom-path'] || '',
        copyfromRev: p.attrs['copyfrom-rev'] ? Number(p.attrs['copyfrom-rev']) : null,
        textMods: p.attrs['text-mods'] !== 'false',
        propMods: p.attrs['prop-mods'] === 'true',
      })),
    };
  });
}

/** svn blame --xml. Lines with local edits have no commit (revision 0). */
function parseBlame(xml) {
  const doc = parseXml(xml);
  const target = find(doc, 'target');
  return children(target, 'entry').map(e => {
    const c = child(e, 'commit');
    return { line: Number(e.attrs['line-number']), revision: c ? Number(c.attrs.revision) : 0, author: c ? text(c, 'author') : '', date: c ? text(c, 'date') : '' };
  });
}

/** svn list --xml. */
function parseList(xml) {
  const doc = parseXml(xml);
  const list = find(doc, 'list');
  return children(list, 'entry').map(e => {
    const c = child(e, 'commit');
    return { name: text(e, 'name'), kind: e.attrs.kind, revision: c ? Number(c.attrs.revision) : 0, author: c ? text(c, 'author') : '', date: c ? text(c, 'date') : '' };
  });
}

/** svn diff --summarize --xml -> [{ path, item, kind, props }] */
function parseDiffSummary(xml) {
  const doc = parseXml(xml);
  return children(find(doc, 'paths'), 'path').map(p => ({ path: p.text, item: p.attrs.item || '', kind: p.attrs.kind || 'file', props: p.attrs.props || 'none' }));
}

/** `svn: E155004: message` lines -> [{code, message}] */
function parseErrors(stderr) {
  const out = [];
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const m = line.match(/^svn[a-z]*: (E\d{6}): (.*)$/);
    if (m) out.push({ code: m[1], message: m[2] });
  }
  return out;
}

/** `svn update` text output -> counts per action and the conflicted paths. */
function parseUpdate(stdout) {
  const counts = { added: 0, deleted: 0, updated: 0, merged: 0, conflicted: 0, existed: 0, replaced: 0, treeConflicts: 0 };
  const conflicts = [];
  let revision = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    let m = line.match(/^(?:Updated to|At) revision (\d+)\./);
    if (m) { revision = Number(m[1]); continue; }
    m = line.match(/^([ADUCGER ])([ADUCGER ])([B ])([C ]) {1,2}(.+)$/);
    if (!m) continue;
    const [, t, p, , tc, file] = m;
    const map = { A: 'added', D: 'deleted', U: 'updated', G: 'merged', C: 'conflicted', E: 'existed', R: 'replaced' };
    if (map[t]) counts[map[t]]++;
    else if (map[p]) counts[map[p]]++;
    if (t === 'C' || p === 'C') conflicts.push(file);
    if (tc === 'C') { counts.treeConflicts++; conflicts.push(file); }
  }
  return { counts, conflicts, revision };
}

module.exports = { parseStatus, parseInfo, parseLog, parseBlame, parseList, parseErrors, parseUpdate, parseDiffSummary };
