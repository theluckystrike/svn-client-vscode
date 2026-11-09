#!/usr/bin/env bash
# make-fixtures.sh - build local Subversion fixtures for the svn-client-vscode
# tests and real-app gate. Everything is local (svnadmin create + file:// URLs).
#
# Usage: make-fixtures.sh <root> [--small] [--large] [--clean]
#   --small  build the fast fixtures (default when no build flag is given):
#            history externals keywords conflict locked weird-names timeout
#            basic nested nosvn
#   --large  also build binary300 (300 MB binary) and big100k (100,000 files)
#   --clean  remove <root> entirely (refuses if a process has files open in it).
#            With --small/--large it cleans first, then builds.
#
# Env:
#   FX_DELETIONS         file to append "size path" lines for each deleted path
#   FX_HISTORY_GIT       git URL or local path of the history source
#                        (default https://github.com/chalk/chalk.git, MIT)
#   FX_HISTORY_COMMITS   number of first-parent commits to replay (default 200)
#   FX_MIN_FREE_GB       minimum free disk in GB for the large fixtures (default 18)
#   FX_SKIP_LSOF=1       skip the lsof check before deleting
#
# Output: <root>/repos/<id> (svn repos), <root>/wc/<id> (working copies),
#         <root>/fixtures.tsv (id, wc path, kind, notes). Exit 1 if a check fails.

set -euo pipefail

# ---------------------------------------------------------------- arguments
usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -ge 1 ] || usage
case "$1" in -h|--help) usage ;; -*) echo "error: first argument must be <root>" >&2; usage ;; esac
ROOT_ARG=$1; shift
DO_SMALL=0 DO_LARGE=0 DO_CLEAN=0
for a in "$@"; do
  case "$a" in
    --small) DO_SMALL=1 ;;
    --large) DO_LARGE=1 ;;
    --clean) DO_CLEAN=1 ;;
    -h|--help) usage ;;
    *) echo "error: unknown option $a" >&2; usage ;;
  esac
done
[ $DO_CLEAN -eq 1 ] || [ $DO_LARGE -eq 1 ] || DO_SMALL=1
[ $DO_LARGE -eq 1 ] && [ -z "${FX_LARGE_ONLY:-}" ] && DO_SMALL=1   # --large adds to the small set (FX_LARGE_ONLY=<id> builds just that one)

mkdir -p "$ROOT_ARG"
ROOT=$(cd "$ROOT_ARG" && pwd -P)
case "$ROOT" in /|"$HOME"|/Users|/home|/tmp|/private/tmp) echo "error: refusing to use $ROOT as root" >&2; exit 2 ;; esac

# --------------------------------------------------------------- environment
for loc in en_US.UTF-8 C.UTF-8 en_US.utf8 C.utf8; do
  if locale -a 2>/dev/null | grep -qx "$loc"; then export LC_ALL=$loc LANG=$loc; break; fi
done
export TZ=UTC
SVN_BIN=$(command -v svn) || { echo "error: svn not found" >&2; exit 2; }
SVNADMIN_BIN=$(command -v svnadmin) || { echo "error: svnadmin not found" >&2; exit 2; }
SVNLOOK_BIN=$(command -v svnlook) || { echo "error: svnlook not found" >&2; exit 2; }
TIMEOUT_BIN=$(command -v timeout || command -v gtimeout || true)
HAVE_SQLITE=0; command -v sqlite3 >/dev/null && HAVE_SQLITE=1

REPOS=$ROOT/repos
WCS=$ROOT/wc
TMPD=$ROOT/tmp
SRCGIT=$ROOT/src-git
TSV=$ROOT/fixtures.tsv
SVNCFG=$TMPD/svn-config        # isolated svn config (no user auto-props/auth)
HISTORY_GIT=${FX_HISTORY_GIT:-https://github.com/chalk/chalk.git}
HISTORY_N=${FX_HISTORY_COMMITS:-200}
MIN_FREE_GB=${FX_MIN_FREE_GB:-18}
UNREACHABLE_ROOT=http://10.255.255.1/svn/repo

FAILS=0
TSV_ROWS=()
log()  { printf '[fx %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die()  { echo "error: $*" >&2; exit 1; }
check() { # check <id> <PASS|FAIL> <detail>
  printf 'CHECK %-12s %s  %s\n' "$1" "$2" "$3"
  [ "$2" = PASS ] || FAILS=$((FAILS+1))
}
row() { TSV_ROWS+=("$1"$'\t'"$2"$'\t'"$3"$'\t'"$4"); }

# svn for building fixtures. The env var skips svn's ~1 s "sleep for timestamps"
# after each WC write (5-10x faster). That sleep exists because svn sees edits by
# size + whole-second mtime; so the history replay stamps files with a distinct
# second per commit, and every other edit in this script changes the file size.
# Verification commands use plain "$SVN_BIN" with the user's normal config.
svnq()  { SVN_I_LOVE_CORRUPTED_WORKING_COPIES_SO_DISABLE_SLEEP_FOR_TIMESTAMPS=yes "$SVN_BIN" --non-interactive --config-dir "$SVNCFG" "$@"; }
svnu()  { local u=$1; shift; svnq --username "$u" "$@"; }   # svnu <author> <cmd> ...
fileurl() { python3 -I -c 'import sys,urllib.parse; print("file://"+urllib.parse.quote(sys.argv[1]))' "$1"; }
mkrepo() { "$SVNADMIN_BIN" create "$REPOS/$1"; fileurl "$REPOS/$1"; }
youngest() { "$SVNLOOK_BIN" youngest "$REPOS/$1"; }
avail_gb() { df -Pk "$1" | awk 'NR==2{print int($4/1048576)}'; }
run_timeout() { # run_timeout <secs> cmd... ; exit 124 on timeout
  local s=$1; shift
  if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$s" "$@"; return $?; fi
  perl -e '$SIG{ALRM}=sub{kill "KILL",$pid; exit 124}; $pid=fork; if(!$pid){exec @ARGV[1..$#ARGV]} alarm $ARGV[0]; waitpid $pid,0; exit($?>>8)' "$s" "$@"
}
lsof_guard() { # refuse to delete a tree that a process has open
  [ "${FX_SKIP_LSOF:-0}" = 1 ] && return 0
  command -v lsof >/dev/null || { log "warning: lsof not found, skipping open-file check"; return 0; }
  local out; out=$(lsof +D "$1" 2>/dev/null || true)
  if [ -n "$out" ]; then
    echo "$out" | head -20 >&2
    die "processes have files open under $1; close them first (nothing deleted)"
  fi
}
record_delete() { # record_delete <path> ; appends "size path" to FX_DELETIONS
  [ -e "$1" ] || return 0
  if [ -n "${FX_DELETIONS:-}" ]; then
    mkdir -p "$(dirname "$FX_DELETIONS")"
    printf '%sK %s\n' "$(du -sk "$1" | awk '{print $1}')" "$1" >> "$FX_DELETIONS"
  fi
  rm -rf "$1"
}

# --------------------------------------------------------------------- clean
if [ $DO_CLEAN -eq 1 ]; then
  lsof_guard "$ROOT"
  log "cleaning $ROOT"
  for p in "$ROOT"/* "$ROOT"/.[!.]*; do [ -e "$p" ] && record_delete "$p"; done
  rmdir "$ROOT"
  if [ -n "${FX_DELETIONS:-}" ]; then printf '0K %s\n' "$ROOT" >> "$FX_DELETIONS"; fi
  log "removed $ROOT"
  if [ $DO_SMALL -eq 0 ]; then exit 0; fi
  mkdir -p "$ROOT"
fi

# ---------------------------------------------------------------- preflight
T0=$(date +%s)
FREE=$(avail_gb "$ROOT")
log "root=$ROOT free=${FREE}GB small=$DO_SMALL large=$DO_LARGE"
[ "$FREE" -ge 1 ] || die "less than 1 GB free"
# idempotent: remove what a previous run left behind
if [ -d "$REPOS" ] || [ -d "$WCS" ] || [ -d "$TMPD" ] || [ -d "$SRCGIT" ]; then
  lsof_guard "$ROOT"
  rm -rf "$REPOS" "$WCS" "$TMPD" "$SRCGIT" "$TSV"
fi
mkdir -p "$REPOS" "$WCS" "$TMPD" "$SVNCFG"

# =================================================================== history
# Python filter for an svnadmin dump stream: set svn:date of revision N to the
# epoch given in a "rev<TAB>epoch" file (values keep their 27-byte length).
DUMP_DATE_FILTER='
import sys, time
dates = {}
for l in open(sys.argv[1]):
    r, e = l.split()
    dates[int(r)] = time.strftime("%Y-%m-%dT%H:%M:%S.000000Z", time.gmtime(int(e))).encode()
inp, out = sys.stdin.buffer, sys.stdout.buffer
key = b"K 8\nsvn:date\nV 27\n"
while True:
    line = inp.readline()
    if not line:
        break
    if line == b"\n":
        out.write(line); continue
    hdr = [line]
    while True:
        l = inp.readline()
        hdr.append(l)
        if l in (b"\n", b""):
            break
    h = dict(x.decode("utf-8", "replace").rstrip("\n").split(": ", 1) for x in hdr if b": " in x)
    body = inp.read(int(h.get("Content-length", 0)))
    rev = int(h["Revision-number"]) if "Revision-number" in h else None
    if rev in dates and key in body:
        i = body.index(key) + len(key)
        body = body[:i] + dates[rev] + body[i + 27:]
    out.write(b"".join(hdr)); out.write(body)
'

build_history() {
  local id=history t=$(date +%s)
  log "history: cloning $HISTORY_GIT"
  rm -rf "$SRCGIT"; mkdir -p "$SRCGIT"
  # Untrusted data: only git objects are read (git log / git read-tree into a temp
  # worktree under <root>/tmp); hooks are disabled and nothing from it is executed.
  GIT_TERMINAL_PROMPT=0 git -c core.hooksPath=/dev/null clone --quiet --no-checkout "$HISTORY_GIT" "$SRCGIT/repo"
  local G=(git -c core.hooksPath=/dev/null --git-dir="$SRCGIT/repo/.git")
  local head_lic
  head_lic=$("${G[@]}" ls-tree --name-only HEAD | grep -iE '^(license|licence|copying)(\.md|\.txt)?$' | head -1 || true)
  [ -n "$head_lic" ] || die "history: no license file in source HEAD"
  "${G[@]}" show "HEAD:$head_lic" > "$TMPD/upstream-license"
  grep -q 'MIT License\|Permission is hereby granted, free of charge' "$TMPD/upstream-license" \
    || die "history: source license is not MIT"
  local src_head; src_head=$("${G[@]}" rev-parse HEAD)

  # one pass over the log: commits.tsv (sha, committer epoch, author index) + msg/NNNN.txt
  mkdir -p "$TMPD/msg"
  "${G[@]}" log --reverse --first-parent --format='%H%x1f%T%x1f%ct%x1f%an%x1f%B%x1e' HEAD \
    | python3 -I -c '
import sys, os
n, out = int(sys.argv[1]), sys.argv[2]
data = sys.stdin.buffer.read().decode("utf-8", "replace")
seen = {}
prev_tree, changed = None, 0
with open(os.path.join(out, "commits.tsv"), "w") as tsv:
    for i, rec in enumerate([r for r in data.split("\x1e") if r.strip()][:n], 1):
        sha, tree, ct, an, msg = rec.lstrip("\n").split("\x1f", 4)
        changed += tree != prev_tree
        prev_tree = tree
        idx = seen.setdefault(an, len(seen) % 3)   # first-seen round robin -> alice/bob/carol
        msg = msg.replace("\r", "").strip() or "(no message)"
        with open(os.path.join(out, "msg", "%04d.txt" % i), "w") as fh:
            fh.write(msg + "\n")
        tsv.write("%s\t%s\t%d\n" % (sha, ct, idx))
open(os.path.join(out, "changed.txt"), "w").write("%d\n" % changed)
' "$HISTORY_N" "$TMPD"
  # commits whose first-parent diff deletes something (WC must be at HEAD before deleting dirs)
  "${G[@]}" log --first-parent --diff-filter=D --format=%H HEAD > "$TMPD/deleting.txt"
  local total; total=$(wc -l < "$TMPD/commits.tsv" | tr -d ' ')
  [ "$total" -ge 1 ] || die "history: no commits"

  local URL; URL=$(mkrepo $id)
  local first_ct; first_ct=$(head -1 "$TMPD/commits.tsv" | cut -f2)
  local last=$((first_ct - 3600)) DATES=$TMPD/dates.tsv
  : > "$DATES"
  REV=""
  hcommit() { # hcommit <author> <svn args...>; sets REV and records a date (uses $last)
    local out; out=$(svnu "$@")
    if [[ $out =~ Committed\ revision\ ([0-9]+) ]]; then REV=${BASH_REMATCH[1]}; else REV=""; fi
  }
  hdate() { [ -n "$REV" ] && printf '%s\t%s\n' "$REV" "$1" >> "$DATES"; return 0; }
  hcommit alice mkdir -m "Create standard layout" "$URL/trunk" "$URL/branches" "$URL/tags"; hdate "$last"
  local WCT=$TMPD/history-trunk EXP=$TMPD/history-export
  svnq checkout -q "$URL/trunk" "$WCT"
  mkdir -p "$EXP"
  export GIT_INDEX_FILE=$TMPD/replay.index
  local authors=(alice bob carol) i=0 sha ct ai line p
  local rev_branch_a="" rev_release="" headrev=1
  while IFS=$'\t' read -r sha ct ai; do
    i=$((i+1))
    grep -qx "$sha" "$TMPD/deleting.txt" && svnq update -q "$WCT"
    # export the tree into the temp worktree (incremental), then rsync into the svn WC
    "${G[@]}" --work-tree="$EXP" read-tree --reset -u "$sha"
    rsync -rlp --checksum --delete --exclude=/.svn --exclude=/.git "$EXP/" "$WCT/"
    # svn detects edits by size + whole-second mtime. Stamp every file with this
    # commit's (strictly increasing) time so same-size edits are never missed.
    if [ "$ct" -gt "$last" ]; then last=$ct; else last=$((last+1)); fi
    find "$WCT" -name .svn -prune -o -type f -print0 | xargs -0 perl -e '$t = shift; utime($t, $t, @ARGV) == @ARGV or die "utime failed\n"' "$last"
    local adds=() dels=() lastdel="//none//"
    while IFS= read -r line; do
      p=${line:8}
      case "$line" in
        '?'*|'I'*) adds+=("$p@") ;;
        '!'*) case "$p" in "$lastdel"/*) ;; *) dels+=("$p@"); lastdel=$p ;; esac ;;
      esac
    done < <(svnq status --no-ignore "$WCT")
    [ ${#adds[@]} -gt 0 ] && svnq add -q --no-ignore --parents "${adds[@]}"
    [ ${#dels[@]} -gt 0 ] && svnq rm -q --force "${dels[@]}"
    hcommit "${authors[$ai]}" commit -F "$TMPD/msg/$(printf %04d $i).txt" "$WCT"
    if [ -n "$REV" ]; then hdate "$last"; headrev=$REV; fi

    if [ $i -eq $((total * 2 / 5)) ] && [ -z "$rev_branch_a" ]; then   # ~rev 80 of 200
      rev_branch_a=$headrev
      last=$((last+60)); hcommit carol copy -m "Create branch feature-a from trunk@$rev_branch_a" "$URL/trunk@$rev_branch_a" "$URL/branches/feature-a"; hdate "$last"
      local WCB=$TMPD/history-feature-a k
      svnq checkout -q "$URL/branches/feature-a" "$WCB"
      for k in 1 2 3 4 5; do
        printf '# Feature A\n\nStep %s of the feature-a work.\n' "$k" >> "$WCB/FEATURE-A.md"
        [ $k -eq 1 ] && svnq add -q "$WCB/FEATURE-A.md"
        last=$((last+60)); hcommit "${authors[$((k % 3))]}" commit -m "feature-a: step $k" "$WCB"; hdate "$last"
      done
      rm -rf "$WCB"
    fi
    if [ $i -eq $((total * 3 / 4)) ] && [ -z "$rev_release" ]; then  # ~rev 150 of 200
      rev_release=$headrev
      last=$((last+60)); hcommit bob copy -m "Create branch release-1.x from trunk@$rev_release" "$URL/trunk@$rev_release" "$URL/branches/release-1.x"; hdate "$last"
      last=$((last+60)); hcommit bob copy -m "Tag v1.0.0" "$URL/branches/release-1.x" "$URL/tags/v1.0.0"; hdate "$last"
    fi
  done < "$TMPD/commits.tsv"
  unset GIT_INDEX_FILE
  # the replayed trunk must equal the last git tree byte for byte
  local tree_diff; tree_diff=$(diff -r -q -x .svn "$EXP" "$WCT" 2>&1 | head -5 || true)

  # keep the upstream license in trunk
  local lic_commit=0
  if ! ls "$WCT" | grep -qiE '^(license|licence)(\.md|\.txt)?$'; then
    cp "$TMPD/upstream-license" "$WCT/LICENSE"
    svnq add -q "$WCT/LICENSE"; lic_commit=1
    last=$((last+60)); hcommit alice commit -m "Add upstream MIT license (from $src_head)" "$WCT"; hdate "$last"
  fi
  last=$((last+60)); hcommit alice copy -m "Tag v1.1.0" "$URL/trunk" "$URL/tags/v1.1.0"; hdate "$last"

  # give every revision its original (monotonic) date: dump -> rewrite svn:date -> load
  "$SVNADMIN_BIN" create "$REPOS/$id.new"
  "$SVNADMIN_BIN" dump -q "$REPOS/$id" | python3 -I -c "$DUMP_DATE_FILTER" "$DATES" | "$SVNADMIN_BIN" load -q "$REPOS/$id.new"
  rm -rf "$REPOS/$id"; mv "$REPOS/$id.new" "$REPOS/$id"
  rm -rf "$WCT" "$EXP" "$SRCGIT"
  svnq checkout -q "$URL/trunk" "$WCS/$id"
  local secs=$(( $(date +%s) - t ))
  log "history: replayed $total commits in ${secs}s, HEAD r$(youngest $id)"
  row $id "$WCS/$id" clean "replay of $total first-parent commits of $HISTORY_GIT (MIT, upstream HEAD $src_head); branches/feature-a (from r$rev_branch_a +5 commits), branches/release-1.x (from r$rev_release), tags/v1.0.0, tags/v1.1.0; authors alice/bob/carol; HEAD r$(youngest $id)"

  # verify
  local nlog; nlog=$(svnq log -q "$URL/trunk" | grep -c '^r[0-9]' || true)
  local ls_b ls_t; ls_b=$(svnq ls "$URL/branches" | tr '\n' ' '); ls_t=$(svnq ls "$URL/tags" | tr '\n' ' ')
  local lic; lic=$(ls "$WCS/$id" | grep -iE '^(license|licence)' | head -1 || true)
  local want; want=$(( $(cat "$TMPD/changed.txt") + 1 + lic_commit ))
  if [ -z "$tree_diff" ] && [ "$nlog" = "$want" ] && [ "$ls_b" = "feature-a/ release-1.x/ " ] && [ "$ls_t" = "v1.0.0/ v1.1.0/ " ] && [ -n "$lic" ]; then
    check $id PASS "trunk == git tree of commit $total; trunk log=$nlog revs (expected $want), branches: $ls_b tags: $ls_t license=$lic"
  else
    check $id FAIL "tree diff='$tree_diff' trunk log=$nlog (expected $want) branches='$ls_b' tags='$ls_t' license='$lic'"
  fi
}

# ================================================================= externals
build_externals() {
  local id=externals
  local A B; A=$(mkrepo externals-lib); B=$(mkrepo externals)
  svnu alice mkdir -q -m "layout" "$A/trunk" "$A/trunk/lib"
  svnq checkout -q "$A/trunk" "$TMPD/extA"
  printf 'export function add(a, b) { return a + b; }\n' > "$TMPD/extA/lib/math.js"
  printf '# vendored lib\n' > "$TMPD/extA/lib/README.md"
  svnq add -q "$TMPD/extA/lib/math.js" "$TMPD/extA/lib/README.md"
  svnu bob commit -q -m "Add lib files" "$TMPD/extA"
  svnu alice mkdir -q -m "layout" "$B/trunk" "$B/branches" "$B/tags"
  svnq checkout -q "$B/trunk" "$TMPD/extB"
  printf 'import { add } from "./vendor/lib/math.js";\n' > "$TMPD/extB/app.js"
  svnq add -q "$TMPD/extB/app.js"
  svnq propset -q svn:externals "$A/trunk/lib vendor/lib" "$TMPD/extB"
  svnu carol commit -q -m "Add app and svn:externals vendor/lib" "$TMPD/extB"
  rm -rf "$TMPD/extA" "$TMPD/extB"
  svnq checkout -q "$B/trunk" "$WCS/$id"
  row $id "$WCS/$id" clean "trunk of repos/externals with svn:externals '$A/trunk/lib vendor/lib' (repos/externals-lib)"
  local st extu; st=$(cd "$WCS/$id" && svnq status); extu=$(svnq info --show-item url "$WCS/$id/vendor/lib" 2>/dev/null || true)
  if echo "$st" | grep -qE '^X +vendor(/lib)?$' && echo "$st" | grep -q "external item at 'vendor/lib'" && [ "$extu" = "$A/trunk/lib" ] && [ -f "$WCS/$id/vendor/lib/math.js" ]; then
    check $id PASS "status shows external 'X' + vendor/lib section, external url=$extu"
  else check $id FAIL "status='$st' external url='$extu'"; fi
}

# ================================================================== keywords
write_png() { python3 -I - "$1" <<'PY'
import sys, struct, zlib
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
w = h = 8
raw = b''.join(b'\x00' + bytes([200, 40, 40]) * w for _ in range(h))
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
open(sys.argv[1], 'wb').write(png)
PY
}
build_keywords() {
  local id=keywords U; U=$(mkrepo $id)
  svnu alice mkdir -q -m "layout" "$U/trunk" "$U/branches" "$U/tags"
  local W=$WCS/$id
  svnq checkout -q "$U/trunk" "$W"
  cat > "$W/keywords.txt" <<'EOF'
This file has keyword expansion.
$Id$
$Rev$
$Author$
$Date$
$URL$
EOF
  write_png "$W/logo.png"
  printf 'plain text without keywords: $Id$\n' > "$W/plain.txt"
  svnq add -q "$W/keywords.txt" "$W/logo.png" "$W/plain.txt"
  svnq propset -q svn:keywords "Id Rev Author Date URL" "$W/keywords.txt"
  svnq propset -q svn:eol-style native "$W/keywords.txt"
  svnq propset -q svn:mime-type image/png "$W/logo.png"
  svnu bob commit -q -m "Add keyword file and PNG" "$W"
  svnq update -q "$W"
  row $id "$W" clean "keywords.txt (svn:keywords 'Id Rev Author Date URL', svn:eol-style native), logo.png (svn:mime-type image/png), plain.txt (no keywords)"
  local mt kw; mt=$(svnq propget svn:mime-type "$W/logo.png"); kw=$(grep -cE '^\$(Id|Rev|Author|Date|URL): ' "$W/keywords.txt" || true)
  if [ "$mt" = image/png ] && [ "$kw" = 5 ] && grep -q '^\$Author: bob \$' "$W/keywords.txt"; then
    check $id PASS "5 keywords expanded ($(grep '^\$Id' "$W/keywords.txt")), mime=$mt"
  else check $id FAIL "mime=$mt expanded=$kw"; fi
}

# ================================================================== conflict
build_conflict() {
  local id=conflict U; U=$(mkrepo $id)
  svnu alice mkdir -q -m "layout" "$U/trunk" "$U/branches" "$U/tags"
  local W1=$WCS/$id W2=$TMPD/conflict-wc2 W3=$TMPD/conflict-branch
  svnq checkout -q "$U/trunk" "$W2"
  printf 'line 1\nline 2\nline 3 original\nline 4\nline 5\n' > "$W2/file.txt"
  printf 'victim line 1\nvictim line 2\n' > "$W2/victim.txt"
  printf 'merge 1\nmerge 2 original\nmerge 3\n' > "$W2/merge.txt"
  svnq add -q "$W2/file.txt" "$W2/victim.txt" "$W2/merge.txt"
  svnu alice commit -q -m "Add files" "$W2"
  svnu alice copy -q -m "Create branches/feature" "$U/trunk" "$U/branches/feature"
  svnq checkout -q "$U/branches/feature" "$W3"
  sed 's/merge 2 original/merge 2 changed on branch/' "$W3/merge.txt" > "$W3/m.tmp" && mv "$W3/m.tmp" "$W3/merge.txt"
  svnu carol commit -q -m "branch: change merge.txt line 2" "$W3"
  svnq checkout -q "$U/trunk" "$W1"
  svnq update -q "$W2"
  # incoming changes from wc2
  sed 's/line 3 original/line 3 changed by bob/' "$W2/file.txt" > "$W2/f.tmp" && mv "$W2/f.tmp" "$W2/file.txt"
  svnu bob commit -q -m "Change line 3" "$W2"
  svnq rm -q "$W2/victim.txt"
  svnu bob commit -q -m "Delete victim.txt" "$W2"
  # local edits in wc1
  sed 's/line 3 original/line 3 changed locally by alice/' "$W1/file.txt" > "$W1/f.tmp" && mv "$W1/f.tmp" "$W1/file.txt"
  printf 'local edit\n' >> "$W1/victim.txt"
  sed 's/merge 2 original/merge 2 changed locally/' "$W1/merge.txt" > "$W1/m.tmp" && mv "$W1/m.tmp" "$W1/merge.txt"
  # merge conflict first (merge needs a single-revision WC), then update conflicts
  (cd "$W1" && svnq merge -q --accept postpone "^/branches/feature" . ) >/dev/null 2>&1 || true
  (cd "$W1" && svnq update -q --accept postpone . ) >/dev/null 2>&1 || true
  rm -rf "$W2" "$W3"
  local st; st=$(cd "$W1" && svnq status)
  row $id "$W1" hostile "after update+merge: text conflict file.txt, tree conflict victim.txt (local edit, incoming delete upon update), merge conflict merge.txt (svn merge ^/branches/feature)"
  local ok=1
  echo "$st" | grep -q '^C  *file.txt$' || ok=0
  echo "$st" | grep -qE '^.{6}C victim.txt$' || ok=0
  echo "$st" | grep -q 'local file edit, incoming file delete' || ok=0
  echo "$st" | grep -q '^C  *merge.txt$' || ok=0
  if [ $ok = 1 ]; then check $id PASS "text conflict file.txt, tree conflict victim.txt, merge conflict merge.txt"
  else check $id FAIL "status: $(echo "$st" | tr '\n' '|')"; fi
}

# ==================================================================== locked
build_locked() {
  local id=locked U; U=$(mkrepo $id)
  svnu alice mkdir -q -m "layout" "$U/trunk" "$U/branches" "$U/tags"
  local W=$WCS/$id
  svnq checkout -q "$U/trunk" "$W"
  printf 'hello\n' > "$W/a.txt"; mkdir -p "$W/src"; printf 'x\n' > "$W/src/b.txt"
  svnq add -q "$W/a.txt" "$W/src"
  svnu bob commit -q -m "Add files" "$W"
  svnq update -q "$W"
  row $id "$W" hostile "WC_LOCK row inserted in .svn/wc.db; svn update fails E155004 until svn cleanup"
  if [ $HAVE_SQLITE = 0 ]; then check $id FAIL "sqlite3 not installed"; return; fi
  sqlite3 "$W/.svn/wc.db" "insert into wc_lock (wc_id, local_dir_relpath, locked_levels) values (1,'',-1)"
  # check on a copy so the fixture itself stays locked
  local C=$TMPD/locked-copy out1 out2 out3 rc2
  cp -R "$W" "$C"
  out1=$(svnq update "$W" 2>&1 || true)
  rc2=0; out2=$(svnq cleanup "$C" 2>&1) || rc2=$?
  out3=$(svnq update "$C" 2>&1 || true)
  rm -rf "$C"
  if echo "$out1" | grep -q E155004 && [ $rc2 = 0 ] && ! echo "$out3" | grep -q E155; then
    check $id PASS "svn update -> $(echo "$out1" | grep -m1 E155004 | cut -c1-90); svn cleanup (on a copy) fixes it -> $(echo "$out3" | tail -1)"
  else check $id FAIL "update='$out1' cleanup rc=$rc2 '$out2' update-after='$out3'"; fi
}

# =============================================================== weird-names
build_weird() {
  local id=weird-names U; U=$(mkrepo $id)
  svnu alice mkdir -q -m "layout" "$U/trunk" "$U/branches" "$U/tags"
  local W=$WCS/$id
  svnq checkout -q "$U/trunk" "$W"
  mkdir -p "$W/dir with spaces/sub dir" "$W/über" "$W/中文目录" "$W/emoji 🎉" \
           "$W/deep/l1/l2/l3/l4/l5/l6/l7/l8/l9/l10/l11/l12"
  printf 'spaces\n'   > "$W/file with spaces.txt"
  printf 'nested\n'   > "$W/dir with spaces/sub dir/inner file.txt"
  printf 'cafe\n'     > "$W/café.txt"
  printf 'groesse\n'  > "$W/über/größe.txt"
  printf 'zhongwen\n' > "$W/中文目录/文件.txt"
  printf 'party\n'    > "$W/emoji 🎉/party 🎉.txt"
  printf 'at\n'       > "$W/notes@home.txt"
  printf 'dash\n'     > "$W/-dash.txt"
  printf 'deep\n'     > "$W/deep/l1/l2/l3/l4/l5/l6/l7/l8/l9/l10/l11/l12/deep file.txt"
  printf 'gone\n'     > "$W/to be deleted é.txt"
  printf "quote\n"    > "$W/it's a 'quote'.txt"
  svnq add -q --force "$W"
  svnu carol commit -q -m "Add weird names: spaces, é ü 中文 🎉, @, leading dash, deep dir" "$W"
  svnq update -q "$W"
  # local state
  printf 'modified\n' >> "$W/file with spaces.txt"
  printf 'modified\n' >> "$W/中文目录/文件.txt"
  printf 'modified\n' >> "$W/notes@home.txt"
  printf 'modified\n' >> "$W/-dash.txt"
  printf 'modified\n' >> "$W/emoji 🎉/party 🎉.txt"
  printf 'unversioned\n' > "$W/unversioned ü 😀.txt"
  rm -- "$W/to be deleted é.txt"
  row $id "$W" hostile "names with spaces, é ü 中文 🎉, notes@home.txt, -dash.txt, quotes, 13-level deep dir; 5 modified, 1 unversioned, 1 missing (rm'd)"
  local st nlog; st=$(cd "$W" && svnq status); nlog=$(svnq log -q "$U" | grep -c '^r[0-9]' || true)
  local m q x; m=$(echo "$st" | grep -c '^M' || true); q=$(echo "$st" | grep -c '^?' || true); x=$(echo "$st" | grep -c '^!' || true)
  if [ "$nlog" = 2 ] && [ "$m" = 5 ] && [ "$q" = 1 ] && [ "$x" = 1 ] && svnq info "$W/notes@home.txt@" >/dev/null 2>&1; then
    check $id PASS "weird names committed (r2), status M=$m ?=$q !=$x"
  else check $id FAIL "log=$nlog M=$m ?=$q !=$x status: $(echo "$st" | tr '\n' '|')"; fi
}

# =================================================================== timeout
build_timeout() {
  local id=timeout U; U=$(mkrepo $id)
  svnu alice mkdir -q -m "layout" "$U/trunk" "$U/branches" "$U/tags"
  local W=$WCS/$id
  svnq checkout -q "$U/trunk" "$W"
  printf 'hello\n' > "$W/readme.txt"; svnq add -q "$W/readme.txt"
  svnu alice commit -q -m "Add readme" "$W"; svnq update -q "$W"
  printf 'local change\n' >> "$W/readme.txt"
  row $id "$W" hostile "repository root rewritten in .svn/wc.db to $UNREACHABLE_ROOT (uuid kept); network commands hang, local status works; 1 local modification"
  if [ $HAVE_SQLITE = 0 ]; then check $id FAIL "sqlite3 not installed"; return; fi
  sqlite3 "$W/.svn/wc.db" "update repository set root='$UNREACHABLE_ROOT'"
  local url rc st t1
  url=$("$SVN_BIN" info --show-item url "$W" 2>&1 || true)
  st=$(cd "$W" && "$SVN_BIN" status 2>&1 || true)
  t1=$(date +%s)
  set +e; (cd "$W" && run_timeout 8 "$SVN_BIN" --non-interactive log -l 1 >/dev/null 2>&1); rc=$?; set -e
  if [ "$url" = "$UNREACHABLE_ROOT/trunk" ] && [ "$rc" = 124 ] && [ "$st" = "M       readme.txt" ]; then
    check $id PASS "svn info url=$url; 'svn log -l 1' timed out after $(( $(date +%s) - t1 ))s (exit 124); svn status works"
  else check $id FAIL "url=$url log exit=$rc status='$st'"; fi
}

# ===================================================================== basic
build_basic() {
  local id=basic U; U=$(mkrepo $id)
  local authors=(alice bob carol)
  svnu alice mkdir -q -m "Create standard layout" "$U/trunk" "$U/branches" "$U/tags"
  local W=$WCS/$id
  svnq checkout -q "$U/trunk" "$W"
  mkdir -p "$W/src" "$W/docs"
  printf '# Basic fixture\n\nA small project.\n' > "$W/README.md"
  printf 'const util = require("./util");\nconsole.log(util.greet("world"));\n' > "$W/src/app.js"
  printf 'exports.greet = (n) => `hello ${n}`;\n' > "$W/src/util.js"
  printf '{\n  "name": "basic",\n  "version": "1.0.0"\n}\n' > "$W/src/config.json"
  printf '# Guide\n\nHow to use it.\n' > "$W/docs/guide.md"
  printf 'Changelog\n=========\n' > "$W/CHANGELOG.txt"
  svnq add -q "$W/README.md" "$W/src" "$W/docs" "$W/CHANGELOG.txt"
  svnu bob commit -q -m "Initial import" "$W"
  local files=(README.md src/app.js src/util.js docs/guide.md CHANGELOG.txt) r
  r=$(youngest $id)
  while [ "$r" -lt 30 ]; do
    local f=${files[$((r % ${#files[@]}))]}
    printf '%s change for r%s\n' "$( [ "${f##*.}" = js ] && echo '//' || echo '-')" "$((r+1))" >> "$W/$f"   # appends: size always changes
    svnu "${authors[$((r % 3))]}" commit -q -m "Update $f (change $((r+1)))" "$W"
    r=$(youngest $id)
  done
  svnq update -q "$W"
  # local state
  printf '// local edit\n' >> "$W/src/app.js"
  printf '// local edit\n' >> "$W/src/util.js"
  printf '\nLocal doc edit.\n' >> "$W/README.md"
  printf 'exports.feature = true;\n' > "$W/src/feature.js"; svnq add -q "$W/src/feature.js"
  printf 'scratch\n' > "$W/scratch.txt"
  printf 'debug log\n' > "$W/debug.log"
  svnq changelist -q feature-x "$W/src/app.js"
  svnq changelist -q docs "$W/README.md"
  row $id "$W" clean "30 revisions; M src/app.js (changelist feature-x), M README.md (changelist docs), M src/util.js, A src/feature.js, ? scratch.txt, ? debug.log"
  local st; st=$(cd "$W" && svnq status)
  local m a q; m=$(echo "$st" | grep -c '^M' || true); a=$(echo "$st" | grep -c '^A' || true); q=$(echo "$st" | grep -c '^?' || true)
  if [ "$(youngest $id)" = 30 ] && [ "$m" = 3 ] && [ "$a" = 1 ] && [ "$q" = 2 ] \
     && echo "$st" | grep -q "^--- Changelist 'feature-x':" && echo "$st" | grep -q "^--- Changelist 'docs':"; then
    check $id PASS "HEAD r30, M=$m A=$a ?=$q, changelists feature-x + docs"
  else check $id FAIL "HEAD=$(youngest $id) M=$m A=$a ?=$q status: $(echo "$st" | tr '\n' '|')"; fi
}

# ==================================================================== nested
build_nested() {
  local id=nested C D; C=$(mkrepo nested-outer); D=$(mkrepo nested-inner)
  svnu alice mkdir -q -m "layout" "$C/trunk" "$C/branches" "$C/tags"
  svnu bob mkdir -q -m "layout" "$D/trunk" "$D/branches" "$D/tags"
  local W=$WCS/$id
  svnq checkout -q "$D/trunk" "$TMPD/nested-d"
  printf 'inner repo file\n' > "$TMPD/nested-d/inner.txt"; svnq add -q "$TMPD/nested-d/inner.txt"
  svnu bob commit -q -m "Inner file" "$TMPD/nested-d"; rm -rf "$TMPD/nested-d"
  svnq checkout -q "$C/trunk" "$W"
  printf 'outer repo file\n' > "$W/outer.txt"; svnq add -q "$W/outer.txt"
  svnq propset -q svn:ignore "inner-wc" "$W"
  svnu alice commit -q -m "Outer file, ignore inner-wc" "$W"
  svnq update -q "$W"
  svnq checkout -q "$D/trunk" "$W/inner-wc"
  printf 'inner local edit\n' >> "$W/inner-wc/inner.txt"
  row $id "$W" clean "WC of repos/nested-outer; inner-wc/ (svn:ignore'd) is a separate WC of repos/nested-inner with 1 local modification"
  local st iu ou; st=$(cd "$W" && svnq status); iu=$(svnq info --show-item repos-root-url "$W/inner-wc"); ou=$(svnq info --show-item repos-root-url "$W")
  if [ -z "$st" ] && [ "$iu" = "$D" ] && [ "$ou" = "$C" ] && [ "$(cd "$W/inner-wc" && svnq status)" = "M       inner.txt" ]; then
    check $id PASS "outer status clean (inner ignored), inner root=$(basename "$iu"), outer root=$(basename "$ou")"
  else check $id FAIL "outer status='$st' inner=$iu outer=$ou"; fi
}

# ===================================================================== nosvn
build_nosvn() {
  local id=nosvn W=$WCS/nosvn
  mkdir -p "$W/src"
  printf '# not a working copy\n' > "$W/README.md"; printf 'x\n' > "$W/src/main.js"
  row $id "$W" control "plain folder, no .svn (control)"
  local out; out=$("$SVN_BIN" info "$W" 2>&1 || true)
  if echo "$out" | grep -q E155007; then check $id PASS "svn info -> E155007 not a working copy"
  else check $id FAIL "$out"; fi
}

# ================================================================= binary300
large_guard() {
  local f; f=$(avail_gb "$ROOT")
  if [ "$f" -lt "$MIN_FREE_GB" ]; then
    log "$1: SKIPPED, only ${f}GB free (< ${MIN_FREE_GB}GB)"
    check "$1" FAIL "skipped: only ${f}GB free"
    return 1
  fi
}
build_binary300() {
  # 300 MiB binary: 1 MiB random, then 299 MiB of zeros. The working copy file is sparse and the checkout keeps no
  # pristine copy (svn 1.15 --store-pristine=no), so the fixture takes about 2 MB of disk while svn, VS Code and the
  # extension still see a 300 MiB binary file (disk is tight on this Mac).
  local id=binary300; large_guard $id || return 0
  local U t; U=$(mkrepo $id); t=$(date +%s)
  svnu alice mkdir -q -m "layout" "$U/trunk" "$U/branches" "$U/tags"
  local W=$WCS/$id
  svnq checkout -q --store-pristine=no "$U/trunk" "$W"
  python3 -I -c "import os,sys; f=open(sys.argv[1],'wb'); f.write(os.urandom(1<<20)); f.seek(314572800-1); f.write(b'\\0'); f.close()" "$W/big.bin"
  printf 'small text file\n' > "$W/notes.txt"
  svnq add -q "$W/big.bin" "$W/notes.txt"
  svnu alice commit -q -m "Add 300 MB binary" "$W"
  svnq update -q "$W"
  printf 'local edit\n' >> "$W/notes.txt"
  log "binary300: built in $(( $(date +%s) - t ))s, disk used: $(du -sk "$W" | cut -f1) KB wc, $(du -sk "$ROOT/repos/$id" | cut -f1) KB repo"
  row $id "$W" large "big.bin 300 MiB (1 MiB random + zeros, sparse, committed; --store-pristine=no), notes.txt locally modified"
  local st; st=$(cd "$W" && svnq status)
  if [ "$st" = "M       notes.txt" ] && [ "$(stat -f %z "$W/big.bin" 2>/dev/null || stat -c %s "$W/big.bin")" = 314572800 ]; then
    check $id PASS "300 MiB committed, status: M notes.txt ($(( $(date +%s) - t ))s)"
  else check $id FAIL "status='$st'"; fi
}

# ================================================================== big100k
build_big100k() {
  local id=big100k; large_guard $id || return 0
  local U; U=$(mkrepo $id)
  svnu alice mkdir -q -m "layout" "$U/trunk" "$U/branches" "$U/tags"
  local W=$WCS/$id t0 t1 t2 t3
  svnq checkout -q "$U/trunk" "$W"
  t0=$(date +%s)
  python3 -I - "$W" <<'PY'
import os, sys
root = sys.argv[1]
for d in range(1000):
    dp = os.path.join(root, "d%04d" % d)
    os.mkdir(dp)
    for f in range(100):
        with open(os.path.join(dp, "f%03d.txt" % f), "w") as fh:
            if d % 100 == 0:
                fh.write("line %d\n" % f)  # 1,000 files with text; the other 99,000 are empty (no disk blocks on APFS)
PY
  t1=$(date +%s)
  svnq add -q --force "$W"
  t2=$(date +%s)
  svnu bob commit -q -m "Add 100,000 files in 1,000 directories" "$W"
  t3=$(date +%s)
  svnq update -q "$W"
  log "big100k: generate $((t1-t0))s, svn add $((t2-t1))s, svn commit $((t3-t2))s"
  local i
  for i in $(seq 0 19); do printf 'local edit\n' >> "$W/d$(printf %04d $((i*50)))/f$(printf %03d $i).txt"; done
  for i in 1 2 3 4 5; do printf 'new\n' > "$W/d0000/unversioned-$i.txt"; done
  row $id "$W" large "100,000 files in 1,000 dirs (generate $((t1-t0))s, add $((t2-t1))s, commit $((t3-t2))s); 20 modified, 5 unversioned"
  local st m q ts; ts=$(date +%s); st=$(cd "$W" && svnq status); m=$(echo "$st" | grep -c '^M' || true); q=$(echo "$st" | grep -c '^?' || true)
  if [ "$m" = 20 ] && [ "$q" = 5 ]; then
    check $id PASS "M=$m ?=$q; svn add $((t2-t1))s, commit $((t3-t2))s, status $(( $(date +%s) - ts ))s"
  else check $id FAIL "M=$m ?=$q"; fi
}

# ===================================================================== main
if [ $DO_SMALL -eq 1 ]; then
  build_history
  build_externals
  build_keywords
  build_conflict
  build_locked
  build_weird
  build_timeout
  build_basic
  build_nested
  build_nosvn
fi
if [ $DO_LARGE -eq 1 ]; then
  case "${FX_LARGE_ONLY:-}" in ''|binary300) build_binary300 ;; esac
  case "${FX_LARGE_ONLY:-}" in ''|big100k) build_big100k ;; esac
fi

rm -rf "$TMPD"
{
  printf 'id\twc_path\tkind\tnotes\n'
  for r in "${TSV_ROWS[@]}"; do printf '%s\n' "$r"; done
} > "$TSV"
echo
echo "== fixtures ($TSV)"
cat "$TSV"
echo
log "done in $(( $(date +%s) - T0 ))s, free $(avail_gb "$ROOT")GB, failed checks: $FAILS"
[ "$FAILS" -eq 0 ]
