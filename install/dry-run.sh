#!/usr/bin/env bash
#
# The P6 acceptance check, executable.
#
# Installs Daijin into a throwaway prefix from this checkout and asserts every
# pre-registered criterion, logging each step. Nothing it does touches the user's real
# install, their PATH, or any repository: it works in a temp prefix and a temp bin dir and
# removes both at the end.
#
#   bash install/dry-run.sh              run everything
#   DAIJIN_KEEP=1 bash install/dry-run.sh  keep the prefix afterwards for inspection
#
# Criteria, in the order they are checked:
#   (a) a clean install produces a working daijin command talking to a working daemon
#   (b) the installer is idempotent and re-runnable
#   (c) no secret, no provider call, no network beyond package registries
#   (d) both halves are stamped, and hello's engineVersion comes from the stamp
#   (e) uninstall works and is documented
#   (f) dash and spend sweeps are clean
#
# Two of these are checked by MUTATION rather than by observation, because a criterion
# that cannot fail is not being checked: the stamp comparison is broken on purpose to see
# the smoke check refuse, and the shim's argument contract is exercised through a stand in
# that records what it was actually called with.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$(cd "$HERE/.." && pwd)"
WORK="$(mktemp -d)"
PREFIX="$WORK/prefix"
BIN_DIR="$WORK/bin"
LOG="$WORK/dry-run.log"

PASSED=0
FAILED=0

step() { printf '\n=== %s\n' "$*" | tee -a "$LOG"; }
note() { printf '    %s\n' "$*" | tee -a "$LOG"; }

check() {
  local name="$1"; shift
  if "$@" >>"$LOG" 2>&1; then
    printf '  PASS  %s\n' "$name" | tee -a "$LOG"
    PASSED=$((PASSED + 1))
  else
    printf '  FAIL  %s\n' "$name" | tee -a "$LOG"
    FAILED=$((FAILED + 1))
  fi
}

check_fails() {
  local name="$1"; shift
  if "$@" >>"$LOG" 2>&1; then
    printf '  FAIL  %s (it succeeded, so the check cannot fail and is dead coverage)\n' "$name" | tee -a "$LOG"
    FAILED=$((FAILED + 1))
  else
    printf '  PASS  %s\n' "$name" | tee -a "$LOG"
    PASSED=$((PASSED + 1))
  fi
}

cleanup() {
  stop_mock 2>/dev/null || true
  if [ "${DAIJIN_KEEP:-0}" = "1" ]; then
    printf '\nkept: %s\n' "$WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

printf 'Daijin install dry run\n  source: %s\n  work:   %s\n' "$SOURCE" "$WORK" | tee "$LOG"

# ---- (a) clean install ----------------------------------------------------------------

step "(a) clean install from a bare directory"
note "prefix and bin dir do not exist yet: $(ls -d "$PREFIX" 2>/dev/null || echo 'absent')"
# A closed port by default: this harness must never probe whatever Ollama the person
# running it happens to have up, or its result would depend on their machine.
CLOSED_PORT_URL="http://127.0.0.1:9"
install_once() {
  DAIJIN_PREFIX="$PREFIX" DAIJIN_BIN_DIR="$BIN_DIR" DAIJIN_SOURCE="$SOURCE" \
    DAIJIN_OLLAMA_URL="${1:-$CLOSED_PORT_URL}" \
    bash "$HERE/install.sh"
}
check "installer exits 0 on a clean machine" install_once

for path in engine adapters tui venv bin/daijin VERSION install.log install/smoke.mjs install/probe-ollama.mjs; do
  check "layout: $path exists" test -e "$PREFIX/$path"
done
check "the shim is executable" test -x "$PREFIX/bin/daijin"
check "the single PATH entry is a symlink into the prefix" test -L "$BIN_DIR/daijin"
check "the client landed in the PRIVATE venv, not the system python" test -x "$PREFIX/venv/bin/daijin"
check "the engine's production dependencies are present" test -d "$PREFIX/engine/node_modules/better-sqlite3"
check "adapters sit beside engine, which is what engine imports" test -f "$PREFIX/adapters/sqlite/fts5.js"

step "(a) the installed command answers, end to end"
check "daijin --help runs through shim, venv, python and argparse" \
  env PATH="$BIN_DIR:$PATH" daijin --help
check "the hello handshake reaches a working daemon" \
  node "$PREFIX/install/smoke.mjs" --prefix "$PREFIX"

# ---- (d) stamping ----------------------------------------------------------------------

step "(d) both halves stamped, hello sourced from the stamp"
stamp_field() { node -p "JSON.parse(require('fs').readFileSync('$PREFIX/VERSION','utf8')).$1" 2>/dev/null; }
check "stamp records an engine version" test -n "$(stamp_field engineVersion)"
check "stamp records a client version" test -n "$(stamp_field tuiVersion)"
check "stamp records the source commit" test -n "$(stamp_field source.commit)"
note "stamped engine $(stamp_field engineVersion), client $(stamp_field tuiVersion), commit $(stamp_field source.commit)"

matches_manifest() {
  local stamped manifest
  stamped="$(stamp_field engineVersion)"
  manifest="$(node -p "require('$PREFIX/engine/package.json').version")"
  [ "$stamped" = "$manifest" ]
}
check "the stamp matches the engine manifest it was read from" matches_manifest

# The mutation: a stamp that disagrees with the running daemon must be caught. Without
# this, "hello matched the stamp" could just be two constants that never disagree.
step "(d) MUTATION: break the stamp and prove the smoke check refuses"
cp "$PREFIX/VERSION" "$WORK/VERSION.bak"
node -e "
const fs = require('fs');
const stamp = JSON.parse(fs.readFileSync('$PREFIX/VERSION', 'utf8'));
stamp.engineVersion = '9.9.9-not-what-is-installed';
fs.writeFileSync('$PREFIX/VERSION', JSON.stringify(stamp, null, 2));
"
check_fails "smoke refuses when the daemon and the stamp disagree" \
  node "$PREFIX/install/smoke.mjs" --prefix "$PREFIX"
cp "$WORK/VERSION.bak" "$PREFIX/VERSION"
check "smoke passes again once the stamp is restored" \
  node "$PREFIX/install/smoke.mjs" --prefix "$PREFIX"

# ---- (b) idempotency --------------------------------------------------------------------

step "(b) idempotent: the second run lands in the same state as the first"
# Hashed with python3 rather than shasum. shasum is perl and is not on every runner; when
# it is missing both sides of the comparison are the empty string, which compares EQUAL
# and passes a check that measured nothing. Same failure the dash sweep had, found by
# asking what happens when the tool is absent instead of assuming it is there.
file_hash() {
  python3 - "$1" <<'HASH'
import hashlib, pathlib, sys
print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())
HASH
}
before_shim="$(file_hash "$PREFIX/bin/daijin")"
before_links="$(ls -1 "$BIN_DIR" | wc -l | tr -d ' ')"
check "the shim hash is computable, so the comparison below can fail" test -n "$before_shim"
check "the bin dir holds a command to compare against" test "$before_links" -ge 1
check "installer exits 0 on a second run" install_once
after_shim="$(file_hash "$PREFIX/bin/daijin")"
after_links="$(ls -1 "$BIN_DIR" | wc -l | tr -d ' ')"
identical_shim() { [ -n "$before_shim" ] && [ "$before_shim" = "$after_shim" ]; }
check "the shim is byte identical after re-running" identical_shim
check "re-running did not add a second command to the bin dir" test "$before_links" = "$after_links"
check "no directory nested itself on the second copy" test ! -d "$PREFIX/engine/engine"
check "the handshake still works after re-running" \
  node "$PREFIX/install/smoke.mjs" --prefix "$PREFIX"

# ---- (a) the shim's argument contract ------------------------------------------------------

step "(a) MUTATION: the shim supplies an engine only when the caller did not"
# A stand in for the client that records its argv, so the contract is observed rather than
# read. This is the last thing done to this prefix before it is uninstalled.
cat >"$PREFIX/venv/bin/daijin" <<'STANDIN'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$DAIJIN_ARGV_FILE"
STANDIN
chmod +x "$PREFIX/venv/bin/daijin"

DAIJIN_ARGV_FILE="$WORK/argv-default.txt" "$PREFIX/bin/daijin" . >/dev/null 2>&1 || true
DAIJIN_ARGV_FILE="$WORK/argv-mock.txt" "$PREFIX/bin/daijin" . --mock >/dev/null 2>&1 || true
DAIJIN_ARGV_FILE="$WORK/argv-explicit.txt" "$PREFIX/bin/daijin" . --engine 'node /somewhere/else.js' >/dev/null 2>&1 || true

check "a bare invocation gets an engine command" grep -q -- '--engine' "$WORK/argv-default.txt"
check "and it points at the installed prefix" grep -q "$PREFIX" "$WORK/argv-default.txt"
check_fails "--mock is left alone, since the client's own engine must win" \
  grep -q -- '--engine' "$WORK/argv-mock.txt"
check "an explicit --engine is passed through untouched" \
  grep -q '/somewhere/else.js' "$WORK/argv-explicit.txt"
check_fails "and is not doubled" \
  test "$(grep -c -- '--engine' "$WORK/argv-explicit.txt")" -gt 1

step "(a) MUTATION: an install with no engine refuses instead of pretending"
# The strongest way for an installer to lie is to look finished while the thing it
# installed cannot answer. There is no stand-in daemon to fall back to for exactly that
# reason, and this proves the absence is detected rather than papered over.
mv "$PREFIX/engine/src/rpc/daemon.js" "$WORK/daemon.js.aside"
check_fails "smoke refuses when the engine is missing" \
  node "$PREFIX/install/smoke.mjs" --prefix "$PREFIX"
check_fails "the shim refuses to launch anything in its place" \
  env DAIJIN_ARGV_FILE="$WORK/argv-engineless.txt" "$PREFIX/bin/daijin" .
mv "$WORK/daemon.js.aside" "$PREFIX/engine/src/rpc/daemon.js"
check "and both recover once the engine is back" \
  node "$PREFIX/install/smoke.mjs" --prefix "$PREFIX"

# ---- (g) the embedder probe ---------------------------------------------------------------

step "(g) the embedder is probed at completion and never blocks the install"
# A mock rather than a live Ollama. Pointing this at whatever the developer has running
# would make the result a property of their laptop instead of a property of the installer.
cat >"$WORK/mock-ollama.mjs" <<'MOCK'
import { createServer } from 'node:http';
const models = (process.argv[2] || '').split(',').filter(Boolean).map((name) => ({ name, model: name }));
const server = createServer((request, response) => {
  if (request.url.startsWith('/api/tags')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ models }));
    return;
  }
  response.writeHead(404);
  response.end('{}');
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));
MOCK

# Sets MOCK_PID rather than printing it. Capturing a pid through $( ) hangs: the command
# substitution waits for EOF on its pipe and a backgrounded child keeps it open, so the
# harness sat there for twelve minutes with a mock server it had started and could not
# get past. Assigning a global costs nothing and cannot deadlock.
MOCK_PID=""
start_mock() {
  local models="$1" portfile="$2" waited=0
  : >"$portfile"
  node "$WORK/mock-ollama.mjs" "$models" >"$portfile" 2>/dev/null &
  MOCK_PID=$!
  while [ ! -s "$portfile" ] && [ "$waited" -lt 50 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  [ -s "$portfile" ] || { printf '    mock server did not report a port\n' | tee -a "$LOG"; return 1; }
}

stop_mock() {
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null
  MOCK_PID=""
  return 0
}

# Branch 1: nothing listening.
install_once "$CLOSED_PORT_URL" >"$WORK/install-unreachable.txt" 2>&1
unreachable_status=$?
check "the install SUCCEEDS with no embedder, because it is a runtime dependency" \
  test "$unreachable_status" -eq 0
check "and says so in its own words" grep -q "no Ollama at $CLOSED_PORT_URL" "$WORK/install-unreachable.txt"
check "naming both next steps" bash -c "grep -q 'Install Ollama' '$WORK/install-unreachable.txt' && grep -q 'ollama pull bge-m3' '$WORK/install-unreachable.txt'"
check "and the completion line stops claiming a usable install" \
  grep -q 'retrieval requires the embedder, not yet present' "$WORK/install-unreachable.txt"
check_fails "so the bare success line never appears when retrieval cannot work" \
  grep -qF 'Daijin is installed.' "$WORK/install-unreachable.txt"

# Branch 2: reachable, but serving something else.
start_mock 'llama3:latest' "$WORK/port-nomodel.txt"
nomodel_url="http://127.0.0.1:$(cat "$WORK/port-nomodel.txt")"
install_once "$nomodel_url" >"$WORK/install-nomodel.txt" 2>&1
check "an Ollama without the model is reported as such, not as absent" \
  grep -q "is running but is NOT serving bge-m3" "$WORK/install-nomodel.txt"
check "with the one command that fixes it" grep -q 'ollama pull bge-m3' "$WORK/install-nomodel.txt"
stop_mock

# Branch 3: reachable and serving it.
start_mock 'bge-m3:latest' "$WORK/port-ready.txt"
ready_url="http://127.0.0.1:$(cat "$WORK/port-ready.txt")"
install_once "$ready_url" >"$WORK/install-ready.txt" 2>&1
check "a served model is reported ready" grep -q 'Retrieval is ready' "$WORK/install-ready.txt"
check "and only then does the bare success line appear" \
  grep -qF 'Daijin is installed.' "$WORK/install-ready.txt"
check_fails "and the not-ready line does not" \
  grep -q 'retrieval requires the embedder, not yet present' "$WORK/install-ready.txt"
stop_mock

# ---- (h) the preflight refusals actually refuse ---------------------------------------

step "(h) MUTATION: every stated requirement is proven to refuse"
# A requirement nobody has watched fail is a requirement nobody has checked. Each of these
# breaks one preflight and asserts the installer stops with the message it promises.

# Hiding node by BUILDING a PATH rather than by filtering one. The first version of this
# filtered node's directory out of $PATH in a loop and could spin forever, because a
# directory can appear in PATH in a different textual form than dirname produces (a
# trailing slash is enough) and then the filter removes nothing. A harness that hangs is
# worse than one that fails, so this constructs a directory of exactly the tools the
# installer needs, minus node, and never loops.
#
# If a tool is missing from this list the installer dies with a DIFFERENT message and the
# assertion below fails loudly, which is the right failure: visible, not vacuous.
NO_NODE_BIN="$WORK/no-node-bin"
mkdir -p "$NO_NODE_BIN"
for tool in sh bash env date printf npm python3 git awk sed grep tr mkdir rmdir tar cp mv ln chmod rm cat dirname basename uname mktemp find sort head tail wc paste; do
  tool_path="$(command -v "$tool" 2>/dev/null)" || continue
  ln -sf "$tool_path" "$NO_NODE_BIN/$tool" 2>/dev/null || true
done
NODELESS_PATH="$NO_NODE_BIN"
check_fails "node is genuinely hidden, so the next check is not vacuous" \
  env PATH="$NODELESS_PATH" command -v node
env PATH="$NODELESS_PATH" DAIJIN_PREFIX="$WORK/refuse-1" DAIJIN_BIN_DIR="$WORK/refuse-bin" \
  DAIJIN_SOURCE="$SOURCE" bash "$HERE/install.sh" >"$WORK/refuse-node.txt" 2>&1
check_fails "the installer refuses when node is missing" test $? -eq 0
check "naming node and what to install" grep -q 'node is required but not on PATH' "$WORK/refuse-node.txt"

mkdir -p "$WORK/fake-old-node"
cat >"$WORK/fake-old-node/node" <<'FAKE'
#!/usr/bin/env bash
[ "$1" = "-v" ] && { printf 'v20.18.1
'; exit 0; }
exit 0
FAKE
chmod +x "$WORK/fake-old-node/node"
env PATH="$WORK/fake-old-node:$PATH" DAIJIN_PREFIX="$WORK/refuse-2" DAIJIN_BIN_DIR="$WORK/refuse-bin" \
  DAIJIN_SOURCE="$SOURCE" bash "$HERE/install.sh" >"$WORK/refuse-old.txt" 2>&1
check_fails "the installer refuses a node below the floor" test $? -eq 0
check "naming the version it found and why it is not enough" \
  bash -c "grep -q 'v20.18.1 is too old' '$WORK/refuse-old.txt' && grep -q 'better-sqlite3' '$WORK/refuse-old.txt'"

mkdir -p "$WORK/fake-no-venv"
cat >"$WORK/fake-no-venv/python3" <<'FAKE'
#!/usr/bin/env bash
# A python that is new enough but cannot make virtualenvs, which is the stock Debian case.
for argument in "$@"; do
  case "$argument" in
    *"import venv"*) exit 1 ;;
  esac
done
exec /usr/bin/env -i PATH="$REAL_PATH" python3 "$@"
FAKE
chmod +x "$WORK/fake-no-venv/python3"
env PATH="$WORK/fake-no-venv:$PATH" REAL_PATH="$PATH" DAIJIN_PREFIX="$WORK/refuse-3" \
  DAIJIN_BIN_DIR="$WORK/refuse-bin" DAIJIN_SOURCE="$SOURCE" bash "$HERE/install.sh" \
  >"$WORK/refuse-venv.txt" 2>&1
check_fails "the installer refuses a python without venv" test $? -eq 0
check "naming the package that provides it" grep -q 'python3-venv' "$WORK/refuse-venv.txt"

check_fails "and no refusal left a half built prefix behind" \
  bash -c "test -d '$WORK/refuse-1/engine' -o -d '$WORK/refuse-2/engine' -o -d '$WORK/refuse-3/engine'"

# ---- (c) and (f) sweeps ---------------------------------------------------------------------

step "(c) no secret, no provider call, no network beyond package registries"
# The sweep covers the SHIPPED artifacts: the files that run on a user's machine. This
# harness is excluded from the provider and credential sweeps for the obvious reason that
# it contains those very patterns as search terms, and it is never installed. It is still
# covered by the dash sweep below, which has no such problem.
SHIPPED=("$HERE/install.sh" "$HERE/uninstall.sh" "$HERE/smoke.mjs" "$HERE/probe-ollama.mjs" "$HERE/README.md")
no_provider_hosts() {
  ! grep -niE 'api\.openai\.com|api\.anthropic\.com|voyageai|generativelanguage|api\.deepseek|api\.x\.ai' "${SHIPPED[@]}"
}
no_credentials() {
  ! grep -niE '(OPENAI|ANTHROPIC|VOYAGE|DEEPSEEK|GROK|GLM)_API_KEY|Authorization:|Bearer ' "${SHIPPED[@]}"
}
no_ad_hoc_downloads() {
  # npm and pip may reach their registries. Nothing else may reach anything.
  ! grep -nE '^[^#]*(curl|wget|nc|ssh|scp) ' "$HERE/install.sh" "$HERE/uninstall.sh"
}
# Scoped to what the installer itself wrote. node_modules and site-packages carry third
# party test fixtures (certificates, sample credential files) that are not ours to judge,
# and sweeping them would turn this into a check nobody could keep green.
no_credential_files() {
  ! find "$PREFIX" \
    -name node_modules -prune -o \
    -name venv -prune -o \
    \( -name '.env*' -o -name '*.pem' -o -name 'credentials*' \) -print | grep -q .
}
check "no provider hostname appears in any shipped install file" no_provider_hosts
check "no credential name or auth header appears in any shipped install file" no_credentials
check "the installer runs no downloader of its own" no_ad_hoc_downloads
check "the installed tree carries no .env and no credential file of ours" no_credential_files

step "(f) dash sweep"
# Written in python rather than grep on purpose. The grep on this machine is ugrep, on CI
# it is GNU grep, on a stock mac it is BSD grep, and their -P support and BRE alternation
# differ. The first version of this sweep used grep and passed with a planted em dash: a
# dead gate reporting coverage, which is the exact failure this project bans. python3 is
# already a hard requirement of the installer, so using it costs nothing and removes the
# variable.
no_dashes() {
  python3 - "$1" <<'SWEEP'
import pathlib, sys
# U+2010..U+2015 are the dash family (hyphen through horizontal bar); U+2212 is minus.
BANNED = {chr(c) for c in range(0x2010, 0x2016)} | {chr(0x2212)}
root = pathlib.Path(sys.argv[1])
found = []
for path in sorted(root.rglob('*')):
    if not path.is_file():
        continue
    try:
        text = path.read_text(encoding='utf-8')
    except (UnicodeDecodeError, OSError):
        continue
    for number, line in enumerate(text.splitlines(), 1):
        hits = sorted({ch for ch in line if ch in BANNED})
        if hits:
            found.append(f"{path}:{number}: {' '.join(hex(ord(h)) for h in hits)}")
for entry in found:
    print(entry)
raise SystemExit(1 if found else 0)
SWEEP
}

# The sweep is proven alive on every run before it is trusted: a planted em dash in a
# throwaway directory must make it fire. Without this the sweep could rot into a pass that
# means nothing, which is how a hygiene gate stops being a gate.
PLANT="$WORK/dash-plant"
mkdir -p "$PLANT"
printf 'a planted em dash \342\200\224 here\n' > "$PLANT/planted.md"
check_fails "the dash sweep fires on a planted em dash" no_dashes "$PLANT"
rm -f "$PLANT/planted.md"
printf 'nothing banned here\n' > "$PLANT/clean.md"
check "and passes on a clean directory" no_dashes "$PLANT"
check "no em dash, en dash or minus sign in install/" no_dashes "$HERE"

# ---- (e) uninstall --------------------------------------------------------------------------

step "(e) uninstall removes the program and none of the data"
# Two kinds of data, planted separately, because they fail differently. A repository brain
# is the user's work. The state root is what remembers which repositories they attached
# and how their roles are configured; losing it turns a reinstall into a re-setup, and the
# uninstaller runs with a HOME it could plausibly reach into.
mkdir -p "$WORK/pretend-repo/.daijin"
: >"$WORK/pretend-repo/.daijin/brain.sqlite"
FAKE_HOME="$WORK/fake-home"
mkdir -p "$FAKE_HOME/.daijin"
printf '{"pid":4242,"startedAt":"planted"}\n' >"$FAKE_HOME/.daijin/daemon.lock"
printf '{"roles":{"engineer":{"model":"planted"}}}\n' >"$FAKE_HOME/.daijin/settings.json"
printf '{"repos":["/planted/repo"]}\n' >"$FAKE_HOME/.daijin/repos.json"

check "uninstaller exits 0" \
  env HOME="$FAKE_HOME" DAIJIN_PREFIX="$PREFIX" DAIJIN_BIN_DIR="$BIN_DIR" DAIJIN_YES=1 bash "$HERE/uninstall.sh"
check_fails "the prefix is gone" test -d "$PREFIX"
check_fails "the PATH entry is gone" test -e "$BIN_DIR/daijin"
check "a repository brain outside the prefix was left alone" test -f "$WORK/pretend-repo/.daijin/brain.sqlite"
check "the state root survived: the daemon lock" test -f "$FAKE_HOME/.daijin/daemon.lock"
check "the state root survived: settings" test -f "$FAKE_HOME/.daijin/settings.json"
check "the state root survived: which repositories were attached" test -f "$FAKE_HOME/.daijin/repos.json"
check "settings were not merely emptied" grep -q 'planted' "$FAKE_HOME/.daijin/settings.json"
check "and the uninstaller says where the data it kept lives" \
  bash -c "env HOME='$FAKE_HOME' DAIJIN_PREFIX='$PREFIX' DAIJIN_BIN_DIR='$BIN_DIR' DAIJIN_YES=1 bash '$HERE/uninstall.sh' | grep -q 'Nothing to remove'"
check "uninstalling twice is not an error" \
  env HOME="$FAKE_HOME" DAIJIN_PREFIX="$PREFIX" DAIJIN_BIN_DIR="$BIN_DIR" DAIJIN_YES=1 bash "$HERE/uninstall.sh"

# ---- report -----------------------------------------------------------------------------------

printf '\n=== dry run complete\n  passed: %s\n  failed: %s\n  log:    %s\n' "$PASSED" "$FAILED" "$LOG"
if [ "$FAILED" -ne 0 ]; then
  printf '\nThe dry run FAILED. Full output is in %s\n' "$LOG"
  [ "${DAIJIN_KEEP:-0}" = "1" ] || printf '(re-run with DAIJIN_KEEP=1 to keep the work directory)\n'
  exit 1
fi
printf '\nAll criteria met.\n'
