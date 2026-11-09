'use strict';
// Pure parts: XML reader, svn output parsers, glob, limiter, coalescer, error text, line mapping, layout.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseXml, child, text } = require('../src/svn/xml');
const P = require('../src/svn/parse');
const R = require('../src/svn/runner');
const { matchAny } = require('../src/glob');
const { mapLines } = require('../src/views/blame');
const { splitUrl, toUrl } = require('../src/layout');
const { parseRevisionList } = require('../src/revisions');

test('xml: entities, numeric references, CDATA, comments, self-closing tags, > inside attributes', () => {
  const d = parseXml('<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y=\'>\'><b/>t&lt;&#233;&#x4E2D;<![CDATA[<raw>]]><c k="v">in</c></a>');
  const a = child(d, 'a');
  assert.equal(a.attrs.x, '1 & 2');
  assert.equal(a.attrs.y, '>');
  assert.equal(a.text, 't<é中<raw>');
  assert.equal(text(a, 'c'), 'in');
  assert.equal(child(a, 'b').children.length, 0);
});

test('status: items, changelists, tree conflicts, locks', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<status><target path=".">
<entry path="a b.txt"><wc-status props="none" item="modified" revision="3"><commit revision="2"><author>alice</author><date>2025-01-01T00:00:00.000000Z</date></commit></wc-status></entry>
<entry path="new.txt"><wc-status props="none" item="unversioned"></wc-status></entry>
<entry path="gone.txt"><wc-status props="none" item="missing" revision="3"></wc-status></entry>
<entry path="tc.txt"><wc-status props="none" item="normal" tree-conflicted="true" revision="3"></wc-status></entry>
<entry path="."><wc-status props="none" item="normal" wc-locked="true" revision="3"></wc-status></entry>
</target>
<changelist name="feature x"><entry path="é.txt"><wc-status props="modified" item="modified" revision="3"></wc-status></entry></changelist>
</status>`;
  const s = P.parseStatus(xml);
  assert.equal(s.length, 6);
  assert.equal(s[0].path, 'a b.txt');
  assert.equal(s[0].commit.author, 'alice');
  assert.equal(s[3].treeConflicted, true);
  assert.equal(s[4].wcLocked, true);
  assert.equal(s[5].changelist, 'feature x');
  assert.equal(s[5].path, 'é.txt');
});

test('errors and update output', () => {
  const e = P.parseErrors('svn: E155004: Run \'svn cleanup\' to remove locks\nsvn: E155004: Working copy \'/x\' locked.\n');
  assert.deepEqual(e.map(x => x.code), ['E155004', 'E155004']);
  const u = P.parseUpdate("Updating '.':\nU    a.txt\nC    b.txt\nA    c/d.txt\n   C e.txt\n      >   local file edit, incoming file delete upon update\nUpdated to revision 7.\nSummary of conflicts:\n  Text conflicts: 1\n");
  assert.equal(u.revision, 7);
  assert.equal(u.counts.updated, 1);
  assert.equal(u.counts.added, 1);
  assert.deepEqual(u.conflicts, ['b.txt', 'e.txt']);
});

test('explain: one plain sentence and the right next step', () => {
  const ex = code => R.explain(new R.SvnError('x', { errors: [{ code, message: 'm' }] }));
  assert.equal(ex('E155004').action, 'cleanup');
  assert.equal(ex('E155011').action, 'update');
  assert.equal(ex('E215004').action, 'terminal');
  assert.match(ex('E670008').text, /could not be reached/);
  const t = new R.SvnError('t', { code: 'TIMEOUT', timedOut: true }); t.timeoutMs = 8000;
  assert.match(R.explain(t).text, /did not answer within 8 s/);
});

test('arg: a trailing @ only for names that contain @', () => {
  assert.equal(R.arg('notes@home.txt'), 'notes@home.txt@');
  assert.equal(R.arg('plain.txt'), 'plain.txt');
});

test('svnEnv: a UTF-8 locale and English messages, no editor', () => {
  const env = R.svnEnv({ LANG: 'C', EDITOR: 'vim', PATH: '/bin' }, 'darwin');
  assert.equal(env.LC_CTYPE, 'en_US.UTF-8');
  assert.equal(env.LC_MESSAGES, 'C');
  assert.equal(env.EDITOR, undefined);
  assert.equal(R.svnEnv({ LANG: 'de_DE.UTF-8' }, 'linux').LC_CTYPE, undefined);
  assert.equal(R.svnEnv({ LC_ALL: 'POSIX' }, 'linux').LC_ALL, 'C.UTF-8');
});

test('findSvn: a set path is the only one tried; PATH and the usual folders otherwise', async () => {
  const exists = p => p === '/opt/homebrew/bin/svn';
  const versionOf = () => Promise.resolve('1.14.3');
  assert.deepEqual(await R.findSvn('', { env: { PATH: '/usr/bin' }, platform: 'darwin', exists, versionOf }), { path: '/opt/homebrew/bin/svn', version: '1.14.3' });
  assert.equal(await R.findSvn('/nope/svn', { env: { PATH: '/usr/bin' }, platform: 'darwin', exists, versionOf }), null);
  const win = R.candidatePaths({ PATH: 'C:\\x', ProgramFiles: 'C:\\Program Files' }, 'win32');
  assert.ok(win.some(p => /TortoiseSVN\\bin\\svn\.exe$|TortoiseSVN[\\/]bin[\\/]svn\.exe$/.test(p)));
  assert.ok(R.versionAtLeast('1.7.0', 1, 7) && !R.versionAtLeast('1.6.17', 1, 7) && R.versionAtLeast('1.15.0', 1, 7));
});

test('runSvn: a missing binary rejects with ENOENT, a hung one is killed at the timeout', async () => {
  await assert.rejects(R.runSvn('/no/such/svn', ['status']), e => e.code === 'ENOENT');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsvn-'));
  try {
    const fake = path.join(dir, 'svn');
    fs.writeFileSync(fake, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const t0 = Date.now();
    await assert.rejects(R.runSvn(fake, ['log'], { timeoutMs: 400 }), e => e.timedOut === true);
    assert.ok(Date.now() - t0 < 5000);
    const err = path.join(dir, 'svn2');
    fs.writeFileSync(err, '#!/bin/sh\necho "svn: E155004: Working copy locked." >&2\nexit 1\n', { mode: 0o755 });
    await assert.rejects(R.runSvn(err, ['update']), e => e.code === 'E155004');
    const big = path.join(dir, 'svn3');
    fs.writeFileSync(big, '#!/bin/sh\nhead -c 3000000 /dev/zero\n', { mode: 0o755 });
    await assert.rejects(R.runSvn(big, ['cat'], { maxBytes: 1000000 }), e => e.code === 'TOO_LARGE');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Limiter: never more than max at once', async () => {
  const lim = new R.Limiter(1);
  let now = 0, peak = 0;
  await Promise.all(Array.from({ length: 20 }, () => lim.run(async () => { now++; peak = Math.max(peak, now); await new Promise(r => setTimeout(r, 2)); now--; })));
  assert.equal(peak, 1);
  assert.equal(lim.peak, 1);
});

test('Coalescer: 1,000 requests during a busy run give one more run, never two at once', async () => {
  let running = 0, peak = 0, runs = 0;
  const c = new R.Coalescer(async () => { running++; runs++; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, 30)); running--; }, 5);
  c.request();
  await new Promise(r => setTimeout(r, 15)); // first run is busy now
  const all = [];
  for (let i = 0; i < 1000; i++) all.push(c.request());
  await Promise.all(all);
  assert.equal(peak, 1);
  assert.equal(runs, 2);
  c.dispose();
});

test('glob: folder names, ** and *', () => {
  const ex = ['**/node_modules/**', 'build', '*.log', 'docs/tmp/'];
  assert.ok(matchAny('a/node_modules/x/y.js', ex));
  assert.ok(matchAny('node_modules/', ex));
  assert.ok(matchAny('src/build/out.o', ex));
  assert.ok(matchAny('build', ex));
  assert.ok(matchAny('x.log', ex) && matchAny('a/x.log', ex) && !matchAny('a/x.logs', ex));
  assert.ok(matchAny('docs/tmp/a', ex));
  assert.ok(!matchAny('src/builder/a.js', ex));
});

test('mapLines: lines keep their base line through inserts and deletes', () => {
  const base = ['a', 'b', 'c', 'd', 'e'];
  const now = ['a', 'X', 'b', 'c', 'e', 'Y'];
  assert.deepEqual(mapLines(base, now), [0, -1, 1, 2, 4, -1]);
  assert.deepEqual(mapLines(base, base), [0, 1, 2, 3, 4]);
  assert.deepEqual(mapLines([], ['n']), [-1]);
});

test('layout: base folder and URLs', () => {
  assert.deepEqual(splitUrl('^/trunk'), { base: '^', kind: 'trunk', name: 'trunk', rest: '' });
  assert.deepEqual(splitUrl('^/proj/branches/fix-1/src'), { base: '^/proj', kind: 'branch', name: 'fix-1', rest: '/src' });
  assert.equal(splitUrl('^/proj/tags/v1').kind, 'tag');
  assert.equal(toUrl('file:///r', '^/proj/branches/a b'), 'file:///r/proj/branches/a%20b');
  assert.equal(toUrl('file:///r', '^/x/100%'), 'file:///r/x/100%25');
});

test('revision lists for merge', () => {
  assert.equal(parseRevisionList('120,125-130'), '120,125-130');
  assert.equal(parseRevisionList('r5 r7:r9'), '5,7-9');
  assert.equal(parseRevisionList('abc'), null);
  assert.equal(parseRevisionList(''), null);
});
