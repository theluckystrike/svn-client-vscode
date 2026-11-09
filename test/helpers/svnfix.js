'use strict';
// Real svn repositories for tests: `svnadmin create` + file:// URLs under ~/svn-client-work/t-<pid>-<n>
// (not the temp folder, CLAUDE.md), removed by cleanup(). Every test that needs svn skips when it is missing.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { candidatePaths } = require('../../src/svn/runner');

const SVN = candidatePaths().find(p => fs.existsSync(p)) || '';
const SVNADMIN = SVN ? path.join(path.dirname(SVN), 'svnadmin') : '';
const BASE = path.join(os.homedir(), 'svn-client-work');
let n = 0;
const made = [];

function svn(cwd, ...args) { return execFileSync(SVN, ['--non-interactive', ...args], { cwd, encoding: 'utf8', env: { ...process.env, LC_MESSAGES: 'C', LC_CTYPE: 'en_US.UTF-8' } }); }

/** A repo with trunk/branches/tags and a checkout of trunk. Returns { dir, repoUrl, wc, svn(...args) } */
function makeRepo(name = 'r') {
  const dir = path.join(BASE, `t-${process.pid}-${++n}-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  made.push(dir);
  execFileSync(SVNADMIN, ['create', path.join(dir, 'repo')]);
  const repoUrl = require('url').pathToFileURL(path.join(dir, 'repo')).href;
  svn(dir, 'mkdir', '-m', 'layout', '--username', 'alice', `${repoUrl}/trunk`, `${repoUrl}/branches`, `${repoUrl}/tags`);
  const wc = path.join(dir, 'wc');
  svn(dir, 'checkout', '-q', `${repoUrl}/trunk`, wc);
  return { dir, repoUrl, wc, svn: (...a) => svn(wc, ...a), svnIn: (cwd, ...a) => svn(cwd, ...a) };
}

function write(wc, rel, text) { const p = path.join(wc, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; }

function commitAll(r, msg, user = 'alice') {
  r.svn('add', '-q', '--force', '--', '.');
  const f = path.join(r.dir, 'msg.txt');
  fs.writeFileSync(f, msg);
  r.svn('commit', '-q', '-F', f, '--username', user);
  r.svn('update', '-q');
}

function cleanup() { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); }

module.exports = { SVN, SVNADMIN, BASE, makeRepo, write, commitAll, cleanup, svn };
