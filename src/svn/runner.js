'use strict';
// Runs the user's own `svn` command line. No bundled binaries, no shell (arguments are passed as an array, so
// spaces, quotes and non-ASCII names need no escaping), always --non-interactive (svn never waits for a password
// prompt; credentials come from svn's own auth cache). Every call has a timeout and is killed when it runs out.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseErrors } = require('./parse');

const IS_WIN = process.platform === 'win32';

/** Places to look when svn is not on PATH (VS Code started from the Dock has a short PATH on macOS). */
function candidatePaths(env = process.env, platform = process.platform) {
  const sep = platform === 'win32' ? ';' : ':';
  const exe = platform === 'win32' ? 'svn.exe' : 'svn';
  const dirs = String(env.PATH || env.Path || '').split(sep).filter(Boolean);
  if (platform === 'win32') {
    const pf = [env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', env.ProgramW6432 || 'C:\\Program Files'];
    for (const p of pf) dirs.push(p + '\\TortoiseSVN\\bin', p + '\\SlikSvn\\bin', p + '\\CollabNet\\Subversion Client', p + '\\Subversion\\bin', p + '\\VisualSVN\\bin');
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/opt/local/bin', '/bin', '/snap/bin');
  }
  const seen = new Set();
  return dirs.map(d => path.join(d, exe)).filter(p => (seen.has(p) ? false : (seen.add(p), true)));
}

/**
 * Finds svn. An explicit setting wins and is the only path tried (so a wrong setting shows the install screen
 * instead of silently using another binary). Resolves { path, version } or null.
 */
async function findSvn(configured, { env = process.env, platform = process.platform, exists = fs.existsSync, versionOf = svnVersion } = {}) {
  const list = configured ? [configured] : candidatePaths(env, platform);
  for (const p of list) {
    if (!exists(p)) continue;
    const v = await versionOf(p).catch(() => null);
    if (v) return { path: p, version: v };
  }
  return null;
}

function svnVersion(p) {
  return new Promise((resolve, reject) => {
    execFile(p, ['--version', '--quiet'], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      const v = String(stdout).trim();
      return /^\d+\.\d+/.test(v) ? resolve(v) : reject(new Error('unexpected svn version output'));
    });
  });
}

function versionAtLeast(v, major, minor) {
  const m = String(v || '').match(/^(\d+)\.(\d+)/);
  if (!m) return false;
  return Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor);
}

/** svn needs a UTF-8 locale to handle non-ASCII paths; VS Code started from the Dock often has none. */
function svnEnv(base = process.env, platform = process.platform) {
  const env = { ...base };
  const utf = v => /utf-?8/i.test(v || '');
  if (platform !== 'win32') {
    const effective = env.LC_ALL || env.LC_CTYPE || env.LANG;
    if (!utf(effective)) {
      const loc = platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
      if (env.LC_ALL) env.LC_ALL = loc; else env.LC_CTYPE = loc;
    }
  }
  // English messages are easier to search for. Error codes (E155004 ...) are the same in every language anyway.
  env.LC_MESSAGES = 'C';
  delete env.SVN_EDITOR; delete env.EDITOR; delete env.VISUAL; // never open an editor
  return env;
}

/** A path argument: svn reads "name@rev" as a peg revision, so a name with "@" needs a trailing "@". */
function arg(p) { return String(p).includes('@') ? p + '@' : p; }

class SvnError extends Error {
  constructor(message, { code, errors, stderr, args, timedOut, exitCode } = {}) {
    super(message);
    this.name = 'SvnError';
    this.code = code || (errors && errors[0] && errors[0].code) || '';
    this.errors = errors || [];
    this.stderr = stderr || '';
    this.args = args || [];
    this.timedOut = !!timedOut;
    this.exitCode = exitCode;
  }
}

/** One short sentence for an svn error, with what to do next. */
function explain(err) {
  const codes = new Set((err.errors || []).map(e => e.code));
  if (err.code) codes.add(err.code);
  const has = c => codes.has(c);
  if (err.timedOut) return { text: `svn did not answer within ${Math.round((err.timeoutMs || 0) / 1000)} s and was stopped. The server may be down or unreachable.`, action: 'settings' };
  if (has('E155004') || has('E155037') || has('E155032')) return { text: 'The working copy is locked by an svn command that did not finish. Run Cleanup.', action: 'cleanup' };
  if (has('E155036')) return { text: 'This working copy uses an older format. Run "svn upgrade" in a terminal (your svn is newer than the one that made it).', action: 'terminal' };
  if (has('E155021')) return { text: 'This working copy was made by a newer svn than the one installed. Update your svn command line.', action: 'install' };
  if (has('E170001') || has('E215004') || has('E170013') && /auth/i.test(err.stderr)) return { text: 'The server asked for a login. Run "svn info" once in a terminal and save the password in svn\'s own cache; this extension never stores passwords.', action: 'terminal' };
  if (has('E155011') || has('E160028') || has('E160024') || has('E170004')) return { text: 'Some files are out of date. Update first, then commit again.', action: 'update' };
  if (has('E155015') || has('E200009') && /conflict/i.test(err.stderr)) return { text: 'There are conflicts. Resolve them first.', action: null };
  if (has('E670002') || has('E670008') || has('E731001') || has('E170013') || has('E175002') || has('E730060') || has('E730061') || has('E120171') || has('E000060') || has('E000061') || has('E120108')) return { text: 'The repository server could not be reached. Check the network or the server URL.', action: null };
  if (has('E195012') || /binary/i.test(err.stderr) && /blame/.test((err.args || []).join(' '))) return { text: 'This file is marked as binary (svn:mime-type), so it has no line history.', action: null };
  if (has('E155007') || has('E155010')) return { text: 'This path is not in an svn working copy.', action: null };
  if (has('E200005')) return { text: 'This file is not under version control yet. Add it first.', action: null };
  const first = (err.errors && err.errors[err.errors.length - 1]) || null;
  return { text: first ? `${first.message} (${first.code})` : (err.message || 'svn failed'), action: null };
}

/**
 * Spawns svn. resolve({ stdout, stderr, code }) on exit 0; rejects SvnError otherwise.
 * opts: cwd, timeoutMs, token (vscode CancellationToken), encoding ('utf8' | 'buffer'), maxBytes, log(line), onSpawn(child)
 */
function runSvn(svnPath, args, opts = {}) {
  const full = ['--non-interactive', ...args];
  const timeoutMs = opts.timeoutMs || 0;
  const maxBytes = opts.maxBytes || 512 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(svnPath, full, { cwd: opts.cwd, env: opts.env || svnEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new SvnError('Could not start svn: ' + e.message, { code: 'ENOENT', args: full }));
    }
    if (opts.log) opts.log(`> svn ${full.map(a => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    if (opts.onSpawn) opts.onSpawn(child);
    const out = [], err = [];
    let outLen = 0, killedFor = '', timer = null, sub = null, settled = false;
    const kill = why => {
      if (killedFor) return; killedFor = why;
      try { child.kill(IS_WIN ? undefined : 'SIGTERM'); } catch (_) {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000).unref();
    };
    if (timeoutMs > 0) timer = setTimeout(() => kill('timeout'), timeoutMs);
    if (opts.token) {
      if (opts.token.isCancellationRequested) kill('cancel');
      else sub = opts.token.onCancellationRequested(() => kill('cancel'));
    }
    child.stdout.on('data', d => { outLen += d.length; if (outLen > maxBytes) kill('too-large'); else out.push(d); });
    child.stderr.on('data', d => { if (err.length < 200) err.push(d); });
    const done = (fn) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); if (sub) sub.dispose(); fn(); };
    child.on('error', e => done(() => reject(new SvnError(e.code === 'ENOENT' ? 'svn was not found at ' + svnPath : 'Could not start svn: ' + e.message, { code: e.code === 'ENOENT' ? 'ENOENT' : e.code, args: full }))));
    child.on('close', code => done(() => {
      const stderr = Buffer.concat(err).toString('utf8');
      const buf = Buffer.concat(out);
      const stdout = opts.encoding === 'buffer' ? buf : buf.toString('utf8');
      if (killedFor === 'timeout') { const e = new SvnError(`svn timed out after ${timeoutMs} ms`, { code: 'TIMEOUT', timedOut: true, stderr, args: full }); e.timeoutMs = timeoutMs; return reject(e); }
      if (killedFor === 'cancel') return reject(new SvnError('Cancelled', { code: 'CANCELLED', stderr, args: full }));
      if (killedFor === 'too-large') return reject(new SvnError(`svn output is larger than ${Math.round(maxBytes / 1048576)} MB`, { code: 'TOO_LARGE', stderr, args: full }));
      if (code !== 0) {
        const errors = parseErrors(stderr);
        const last = errors[errors.length - 1];
        return reject(new SvnError(last ? last.message : (stderr.trim().split('\n').pop() || `svn exited with code ${code}`), { errors, stderr, args: full, exitCode: code }));
      }
      resolve({ stdout, stderr, code });
    }));
  });
}

/**
 * A per-working-copy limiter. `serial` runs one job at a time (status and every command that writes the working
 * copy go here, so there is never more than one `svn status` per working copy). `read` allows `max` jobs at once
 * for cat, blame, log and info.
 */
class Limiter {
  constructor(max = 1) { this.max = max; this.running = 0; this.queue = []; this.peak = 0; }
  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._next();
    });
  }
  _next() {
    while (this.running < this.max && this.queue.length) {
      const { fn, resolve, reject } = this.queue.shift();
      this.running++; this.peak = Math.max(this.peak, this.running);
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { this.running--; this._next(); });
    }
  }
}

/**
 * Debounced, coalescing refresh: many requests become one run; a request while a run is busy makes exactly one
 * more run after it. `run` is never called twice at the same time.
 */
class Coalescer {
  constructor(run, delayMs = 500, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { runFn: run, delayMs, setTimer, clearTimer });
    this.timer = null; this.busy = false; this.again = false; this.runs = 0; this.waiters = [];
  }
  /** Ask for a refresh. Resolves when a run that started after this call has finished. */
  request(delay = this.delayMs) {
    const p = new Promise(r => this.waiters.push(r));
    if (this.busy) { this.again = true; return p; }
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; this._go(); }, delay);
    return p;
  }
  now() { return this.request(0); }
  async _go() {
    if (this.busy) { this.again = true; return; }
    this.busy = true; this.again = false;
    const waiters = this.waiters; this.waiters = [];
    try { this.runs++; await this.runFn(); } catch (_) { /* reported by runFn */ }
    this.busy = false;
    for (const w of waiters) w();
    if (this.again) { this.again = false; this.timer = this.setTimer(() => { this.timer = null; this._go(); }, this.delayMs); }
  }
  dispose() { if (this.timer) this.clearTimer(this.timer); this.timer = null; for (const w of this.waiters) w(); this.waiters = []; }
}

module.exports = { runSvn, findSvn, svnVersion, versionAtLeast, candidatePaths, svnEnv, arg, SvnError, explain, Limiter, Coalescer };
