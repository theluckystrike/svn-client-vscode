# SVN fixtures (`make-fixtures.sh`)

```
scripts/make-fixtures.sh <root> [--small] [--large] [--clean]
```

- `--small` (default): all fixtures except `binary300` and `big100k`. Takes about 60 s on the dev Mac and needs network access for one `git clone`.
- `--large`: the small set plus `binary300` and `big100k`. Each one is skipped (and counted as a failed check) if free disk is below `FX_MIN_FREE_GB` (default 18).
- `--clean`: removes `<root>`. It refuses if `lsof +D <root>` shows open files. If `FX_DELETIONS=<file>` is set, it appends one `size path` line for each deleted path.

Each run rebuilds from scratch (it removes `<root>/{repos,wc,tmp,src-git}` first). Repos are created locally with `svnadmin create` under `<root>/repos` and accessed through `file://` URLs. Working copies go to `<root>/wc/<id>`. No server and no account are needed. Commit authors are `alice`, `bob` and `carol`. The script prints one `CHECK <id> PASS|FAIL` line per fixture, writes `<root>/fixtures.tsv` (`id, wc_path, kind, notes`), and exits 1 if any check fails.

Requires `svn`/`svnadmin`/`svnlook` (1.15 tested), `git`, `rsync`, `python3`, `perl`, `sqlite3` (for `locked` and `timeout`), `lsof` and `timeout`/`gtimeout`.

| id | kind | what it is |
|---|---|---|
| `history` | clean | Replay of the first 200 first-parent commits of chalk (see below) into `trunk`. Commit messages and dates are the originals, and authors are mapped to alice/bob/carol. `branches/feature-a` is copied from trunk at about r81 and has 5 more commits. `branches/release-1.x` is copied at about r158. `tags/v1.0.0` (from release-1.x) and `tags/v1.1.0` (from trunk HEAD). HEAD r210. The upstream `license` file is in trunk. The WC is a checkout of trunk. |
| `externals` | clean | Trunk of `repos/externals` with `svn:externals` = `file://…/repos/externals-lib/trunk/lib vendor/lib`. `svn status` shows `X vendor` and a `vendor/lib` external section. |
| `keywords` | clean | `keywords.txt` with `svn:keywords "Id Rev Author Date URL"` (expanded) and `svn:eol-style native`. `logo.png` (8x8 PNG) with `svn:mime-type image/png`. `plain.txt` has no keywords. |
| `conflict` | hostile | Text conflict on `file.txt` and a tree conflict on `victim.txt` (local edit, incoming delete upon update), both from `svn update`. A merge text conflict on `merge.txt` from `svn merge ^/branches/feature`. ` M .` (mergeinfo). |
| `locked` | hostile | A `WC_LOCK` row inserted in `.svn/wc.db`. `svn update` fails with E155004. `svn cleanup` fixes it (checked on a copy, so the fixture stays locked). |
| `weird-names` | hostile | Names with spaces, `é ü 中文 🎉`, `notes@home.txt`, `-dash.txt`, quotes, and a 13-level deep dir, committed in r2. 5 files modified, 1 unversioned (`unversioned ü 😀.txt`), 1 missing (`to be deleted é.txt`, removed with `rm`). |
| `timeout` | hostile | Checked out from `file://`, then the REPOSITORY root in `wc.db` was rewritten to `http://10.255.255.1/svn/repo` (uuid kept). `svn info` shows the new URL. `svn log -l 1` hangs (`timeout 8` exits 124). `svn status` still works (`M readme.txt`). |
| `basic` | clean | 30 revisions. Modified: `src/app.js` (changelist `feature-x`), `README.md` (changelist `docs`) and `src/util.js`. Added: `src/feature.js`. Unversioned: `scratch.txt` and `debug.log`. |
| `nested` | clean | WC of `repos/nested-outer`. `inner-wc/` is in `svn:ignore` and holds a separate checkout of `repos/nested-inner`, with 1 local modification. |
| `nosvn` | control | A plain folder with no `.svn` (`svn info` gives E155007). |
| `binary300` | large | One committed 300 MiB random `big.bin` and a small `notes.txt`, which is modified locally. |
| `big100k` | large | 100,000 small files in 1,000 dirs, added with one `svn add` and one commit (the timings are printed). 20 files modified and 5 unversioned. |

## Source of the `history` fixture

- Project: **chalk** (terminal string styling), https://github.com/chalk/chalk
- License: **MIT** (upstream file `license`, "MIT License, Copyright (c) Sindre Sorhus"). The script checks for the MIT text before it replays anything.
- What is replayed: the first 200 commits of `git log --reverse --first-parent` (Aug 2013 to Feb 2018, ending at the "2.3.1" release commit). Those commits are fixed history, so the result is the same on every run.
- The clone goes to `<root>/src-git` and is treated as untrusted data: hooks are off, trees are read with `git read-tree` into `<root>/tmp`, and nothing from the clone is executed. Both folders are deleted afterwards.
- Override with `FX_HISTORY_GIT=<url-or-path>` (for example a local mirror for offline CI) and `FX_HISTORY_COMMITS=<n>`.
