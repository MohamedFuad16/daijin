#!/usr/bin/env bash
#
# Daijin installer.
#
# Installs both halves into one self contained prefix and puts exactly ONE command on
# PATH. Re-runnable: running it twice lands in the same state as running it once.
#
#   curl -fsSL <the owner's url>/install.sh | bash        (once the owner publishes it)
#   bash install/install.sh                               (from a checkout, which is all
#                                                          that works today, on purpose)
#
# NOTHING here is published. Distribution of Daijin is the owner's act, so no download URL
# is baked in; the script installs from a checkout unless a repository URL is passed
# explicitly. A curl form that pointed at an unpublished URL would be a script that has
# never run its own happy path.
#
# Layout, chosen so nothing collides with anything the user already has:
#
#   $PREFIX/engine      the Node engine plus its production dependencies
#   $PREFIX/adapters    sibling of engine, because engine imports ../../../adapters
#   $PREFIX/tui         the Textual client source
#   $PREFIX/venv        a PRIVATE virtualenv holding the client, never the system python
#   $PREFIX/bin/daijin  the shim, the only thing that reaches PATH
#   $PREFIX/VERSION     the stamp: both halves' versions and what produced them
#
# The prefix defaults to ~/.local/share/daijin and NOT to ~/.daijin, because the engine
# daemon already claims ~/.daijin as its per-user STATE root (engine/src/rpc/daemon.js:26:
# which repos are attached, what the settings are). Installing the program on top of the
# user's state would make an uninstall either destructive or incomplete, and the two have
# different lifetimes: the program is replaceable, the state is not.
#
# The private venv is why the shim exists: pip's own console script would sit inside the
# venv, unreachable, and installing the client globally would fight whatever else the user
# has. One shim, one name, no argument with the system.
#
# Network: package registries only (npm, PyPI), and only through npm and pip. No provider
# call, no telemetry, no credential is read or written by this script.

set -euo pipefail

PREFIX="${DAIJIN_PREFIX:-$HOME/.local/share/daijin}"
BIN_DIR="${DAIJIN_BIN_DIR:-$HOME/.local/bin}"
SOURCE="${DAIJIN_SOURCE:-}"
REPO_URL="${DAIJIN_REPO_URL:-}"
MIN_NODE_MAJOR=22
MIN_PYTHON="3.10"
# The embedder is a RUNTIME dependency, not an install dependency. These knobs exist so
# the probe can be pointed at a mock or a closed port under test, and so a user who runs
# Ollama somewhere else is not told a lie about their own machine.
EMBED_MODEL="${DAIJIN_EMBED_MODEL:-bge-m3}"
OLLAMA_URL="${DAIJIN_OLLAMA_URL:-${OLLAMA_BASE_URL:-http://localhost:11434}}"
EMBEDDER_STATE="unknown"

LOG_FILE=""

log() {
  local line
  line="$(date -u '+%Y-%m-%dT%H:%M:%SZ')  $*"
  printf '%s\n' "$line"
  [ -n "$LOG_FILE" ] && printf '%s\n' "$line" >>"$LOG_FILE"
  return 0
}

die() {
  printf 'install: %s\n' "$*" >&2
  [ -n "$LOG_FILE" ] && printf 'FAILED: %s\n' "$*" >>"$LOG_FILE"
  exit 1
}

# ---- preflight ---------------------------------------------------------------------
# Every check names what to do about it. An installer that says "python 3.10 required"
# without saying which python it looked at has not helped anybody.

preflight() {
  log "preflight: checking the three assumed tools"

  command -v node >/dev/null 2>&1 || die "node is required but not on PATH. Install Node ${MIN_NODE_MAJOR} or newer."
  local node_version node_major
  node_version="$(node -v)"
  node_major="${node_version#v}"
  node_major="${node_major%%.*}"
  [ "$node_major" -ge "$MIN_NODE_MAJOR" ] || die "node ${node_version} is too old ($(command -v node)); Daijin needs ${MIN_NODE_MAJOR} or newer because better-sqlite3 does."

  command -v npm >/dev/null 2>&1 || die "npm is required but not on PATH; it ships with Node."

  command -v python3 >/dev/null 2>&1 || die "python3 is required but not on PATH. Install Python ${MIN_PYTHON} or newer."
  python3 - <<'PY' || die "python3 is older than 3.10 ($(command -v python3)); the client needs 3.10 or newer."
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
PY

  python3 -c 'import venv' >/dev/null 2>&1 \
    || die "python3 has no venv module. On Debian and Ubuntu that is the python3-venv package."

  command -v git >/dev/null 2>&1 || die "git is required but not on PATH."

  log "preflight: node ${node_version}, python $(python3 -c 'import sys; print(".".join(map(str, sys.version_info[:3])))'), git $(git --version | awk '{print $3}')"
}

# ---- source ------------------------------------------------------------------------

resolve_source() {
  if [ -n "$SOURCE" ]; then
    [ -d "$SOURCE/engine" ] || die "DAIJIN_SOURCE=$SOURCE does not look like a Daijin checkout (no engine/)."
    log "source: using the checkout at $SOURCE"
    return
  fi

  if [ -n "$REPO_URL" ]; then
    SOURCE="$(mktemp -d)"
    log "source: cloning $REPO_URL"
    git clone --depth 1 "$REPO_URL" "$SOURCE" >/dev/null 2>&1 || die "git clone of $REPO_URL failed."
    return
  fi

  # Running from a checkout: this file lives at <checkout>/install/install.sh. When the
  # script is piped from curl there is no file to locate, which is the case that has to
  # fail loudly rather than guess a URL that nobody has published yet.
  local here
  here="${BASH_SOURCE[0]:-}"
  if [ -n "$here" ] && [ -f "$here" ]; then
    SOURCE="$(cd "$(dirname "$here")/.." && pwd)"
    [ -d "$SOURCE/engine" ] || die "$SOURCE does not look like a Daijin checkout (no engine/)."
    log "source: using the checkout this script came from, $SOURCE"
    return
  fi

  die "No source to install from. Daijin is not published yet, so there is no default download URL.
  Pass a checkout:    DAIJIN_SOURCE=/path/to/daijin bash install.sh
  or a repository:    DAIJIN_REPO_URL=https://... bash install.sh"
}

# ---- copy ---------------------------------------------------------------------------
# tar rather than cp -R so the excludes are honoured on both GNU and BSD, and so a second
# run overwrites in place instead of nesting a directory inside itself.

copy_tree() {
  local name="$1"
  local from="$SOURCE/$name"
  local to="$PREFIX/$name"
  [ -d "$from" ] || die "the checkout has no $name/ directory."
  log "copy: $name"
  mkdir -p "$to"
  (cd "$from" && tar -cf - \
    --exclude='node_modules' \
    --exclude='.venv' \
    --exclude='venv' \
    --exclude='__pycache__' \
    --exclude='.pytest_cache' \
    --exclude='*.egg-info' \
    --exclude='.git' \
    .) | (cd "$to" && tar -xf -)
}

# ---- stamp --------------------------------------------------------------------------
# Both halves are stamped from their own manifests, and hello's engineVersion is checked
# against this file rather than against a literal, so a stale install is detectable.

# Both readers normalize their EMPTY and their absent-field answers to the same "unknown"
# that write_stamp refuses on. The `|| echo unknown` alone did not: node prints the string
# "undefined" and exits 0 for a package.json with no version field, and awk prints nothing
# and exits 0 when no version line matches. Neither is the literal "unknown", so the
# refusal below never fired and the installer stamped `"tuiVersion": ""` on an install it
# had just declared it could not identify. A guard that cannot fire is not a guard.
read_engine_version() {
  local value
  value="$(node -p "require('$PREFIX/engine/package.json').version" 2>/dev/null || true)"
  case "$value" in
    '' | undefined | null) echo "unknown" ;;
    *) printf '%s\n' "$value" ;;
  esac
}

read_tui_version() {
  # tomllib is 3.11+, and the floor is 3.10, so this reads the line rather than the file.
  local value
  value="$(awk -F'"' '/^version *=/ { print $2; exit }' "$PREFIX/tui/pyproject.toml" 2>/dev/null || true)"
  case "$value" in
    '') echo "unknown" ;;
    *) printf '%s\n' "$value" ;;
  esac
}

write_stamp() {
  local engine_version tui_version commit
  engine_version="$(read_engine_version)"
  tui_version="$(read_tui_version)"
  commit="$(git -C "$SOURCE" rev-parse --short HEAD 2>/dev/null || echo 'not-a-git-checkout')"
  [ "$engine_version" = "unknown" ] && die "could not read the engine version from engine/package.json; refusing to stamp an install I cannot identify."
  [ "$tui_version" = "unknown" ] && die "could not read the client version from tui/pyproject.toml; refusing to stamp an install I cannot identify."

  cat >"$PREFIX/VERSION" <<JSON
{
  "engineVersion": "$engine_version",
  "tuiVersion": "$tui_version",
  "installedAt": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "prefix": "$PREFIX",
  "source": { "path": "$SOURCE", "commit": "$commit" },
  "runtime": {
    "node": "$(node -v)",
    "python": "$(python3 -c 'import sys; print(".".join(map(str, sys.version_info[:3])))')"
  }
}
JSON
  log "stamp: engine $engine_version, client $tui_version, source $commit"
}

# ---- install steps -------------------------------------------------------------------

install_engine() {
  copy_tree engine
  copy_tree adapters
  log "engine: installing production dependencies"
  (cd "$PREFIX/engine" && npm install --omit=dev --no-audit --no-fund >>"$LOG_FILE" 2>&1) \
    || die "npm install failed in $PREFIX/engine; see $LOG_FILE"
}

install_client() {
  copy_tree tui
  if [ ! -x "$PREFIX/venv/bin/python" ]; then
    log "client: creating the private virtualenv"
    python3 -m venv "$PREFIX/venv" || die "python3 -m venv failed at $PREFIX/venv"
  else
    log "client: reusing the existing virtualenv"
  fi
  log "client: installing the Textual client into it"
  "$PREFIX/venv/bin/python" -m pip install --quiet --upgrade pip >>"$LOG_FILE" 2>&1 \
    || die "pip could not upgrade itself; see $LOG_FILE"
  "$PREFIX/venv/bin/python" -m pip install --quiet --upgrade "$PREFIX/tui" >>"$LOG_FILE" 2>&1 \
    || die "pip install of the client failed; see $LOG_FILE"
}

# The shim decides the engine command at RUN time, not at install time, so an engine that
# gains its real daemon after this install starts being used without a reinstall.
write_shim() {
  log "shim: writing $PREFIX/bin/daijin"
  mkdir -p "$PREFIX/bin"
  cat >"$PREFIX/bin/daijin" <<'SHIM'
#!/usr/bin/env bash
# Daijin launcher. Written by install.sh; edit the installer, not this file.
set -euo pipefail

PREFIX="__DAIJIN_PREFIX__"
# daemon.js is the process entry point; server.js beside it is a library that exports the
# dispatcher and does nothing when run directly (engine/src/rpc/daemon.js:1-8). Pointing a
# launcher at the library gives a process that exits 0 without answering, which is a
# confusing way to learn the difference.
DAEMON="$PREFIX/engine/src/rpc/daemon.js"

# `daijin update` (owner field round 8): one command pulls the source checkout
# this install came from and re-runs its installer. The source path comes from
# the VERSION stamp the installer wrote, so the update goes back to wherever
# THIS install actually came from, never a guessed location. --ff-only because
# an updater has no business resolving merge conflicts in the owner's checkout.
if [ "${1:-}" = "update" ]; then
  source_path=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source"]["path"])' "$PREFIX/VERSION" 2>/dev/null || true)
  if [ -z "$source_path" ] || [ ! -d "$source_path/.git" ]; then
    printf 'daijin: cannot update: the install stamp names no git checkout (source: %s).\n' "${source_path:-none}" >&2
    printf 'Pull your daijin checkout by hand and re-run install/install.sh.\n' >&2
    exit 1
  fi
  printf 'daijin: updating from %s\n' "$source_path"
  git -C "$source_path" pull --ff-only
  exec bash "$source_path/install/install.sh"
fi

# Only supply an engine when the caller did not choose one. --mock is the client's own
# bundled engine and must win over anything this shim would add.
wants_engine=1
for argument in "$@"; do
  case "$argument" in
    --engine|--engine=*|--mock) wants_engine=0 ;;
  esac
done

if [ "$wants_engine" -eq 1 ]; then
  # Checked HERE rather than inside a command substitution: an exit inside $( ) ends the
  # subshell and the parent carries on, which would launch the client with an empty
  # --engine and call it a successful run. The dry run caught exactly that.
  if [ ! -f "$DAEMON" ]; then
    printf 'daijin: this install has no engine at %s.\n' "$DAEMON" >&2
    printf 'Reinstall, or run against the bundled mock:  daijin . --mock\n' >&2
    exit 1
  fi
  exec "$PREFIX/venv/bin/daijin" "$@" --engine "node $DAEMON"
fi
exec "$PREFIX/venv/bin/daijin" "$@"
SHIM
  # A literal placeholder rather than expansion inside the heredoc, so the shim body stays
  # readable here. It keeps the SHIM's own quoting correct for any prefix; the engine
  # command the shim builds is a separate matter, and check_paths refuses the prefixes
  # that would break it.
  python3 - "$PREFIX/bin/daijin" "$PREFIX" <<'PY'
import sys
path, prefix = sys.argv[1], sys.argv[2]
body = open(path).read().replace('__DAIJIN_PREFIX__', prefix)
open(path, 'w').write(body)
PY
  chmod +x "$PREFIX/bin/daijin"

  mkdir -p "$PREFIX/install"
  cp "$SOURCE/install/smoke.mjs" "$PREFIX/install/smoke.mjs"
  cp "$SOURCE/install/probe-ollama.mjs" "$PREFIX/install/probe-ollama.mjs"
  cp "$SOURCE/install/uninstall.sh" "$PREFIX/install/uninstall.sh"
  chmod +x "$PREFIX/install/uninstall.sh"

  mkdir -p "$BIN_DIR"
  ln -sf "$PREFIX/bin/daijin" "$BIN_DIR/daijin"
  log "shim: linked $BIN_DIR/daijin"
}

# Asked at COMPLETION and never fatal. An install on a machine whose embedder arrives
# tomorrow is a correct install; what would be wrong is finishing with a line that implies
# retrieval works when nothing has checked.
probe_embedder() {
  local status=0
  log "embedder: probing ${OLLAMA_URL} for ${EMBED_MODEL}"
  node "$PREFIX/install/probe-ollama.mjs" --url "$OLLAMA_URL" --model "$EMBED_MODEL" >>"$LOG_FILE" 2>&1 || status=$?
  case "$status" in
    0) EMBEDDER_STATE="ready" ;;
    3) EMBEDDER_STATE="model-missing" ;;
    *) EMBEDDER_STATE="unreachable" ;;
  esac
  log "embedder: ${EMBEDDER_STATE}"
}

smoke() {
  log "smoke: hello handshake against the engine"
  node "$PREFIX/install/smoke.mjs" --prefix "$PREFIX" >>"$LOG_FILE" 2>&1 \
    || die "the hello handshake failed; the install is not usable. See $LOG_FILE"
  log "smoke: hello returned the stamped engine version"
}

# The last line a person reads. It must never imply that retrieval works when the probe
# says otherwise: an installer that overstates what it produced is how someone spends an
# afternoon debugging an empty search instead of running one command.
embedder_report() {
  case "$EMBEDDER_STATE" in
    ready)
      printf 'Embedder:  %s is serving %s. Retrieval is ready.\n' "$OLLAMA_URL" "$EMBED_MODEL"
      ;;
    model-missing)
      printf 'Embedder:  %s is running but is NOT serving %s, so retrieval will not work yet.\n' "$OLLAMA_URL" "$EMBED_MODEL"
      printf '           Pull it:  ollama pull %s\n' "$EMBED_MODEL"
      ;;
    *)
      printf 'Embedder:  no Ollama at %s, so retrieval will not work yet.\n' "$OLLAMA_URL"
      printf '           Install Ollama:  https://ollama.com/download\n'
      printf '           Then pull the model:  ollama pull %s\n' "$EMBED_MODEL"
      ;;
  esac
}

report() {
  log "done: installed at $PREFIX"
  printf '\n'
  if [ "$EMBEDDER_STATE" = "ready" ]; then
    printf 'Daijin is installed.\n\n'
  else
    printf 'Daijin is installed; retrieval requires the embedder, not yet present.\n\n'
  fi
  printf '  command   %s/daijin\n' "$BIN_DIR"
  printf '  prefix    %s\n' "$PREFIX"
  printf '  stamp     %s/VERSION\n' "$PREFIX"
  printf '  log       %s\n' "$LOG_FILE"
  printf '\n'
  embedder_report
  printf '\n'
  case ":$PATH:" in
    *":$BIN_DIR:"*) printf 'Run:  daijin .\n' ;;
    *) printf '%s is not on your PATH. Either add it:\n\n  export PATH="%s:$PATH"\n\nor run it by path:  %s/daijin .\n' "$BIN_DIR" "$BIN_DIR" "$BIN_DIR" ;;
  esac
  printf '\nUninstall:  %s/install/uninstall.sh\n' "$PREFIX"
}

# The client splits its --engine value on whitespace (tui/daijin_tui/app.py:242 and :253
# use str.split(), not shlex.split), and write_shim hands it "node $PREFIX/.../daemon.js".
# A prefix containing a space therefore produces an engine command that is split into the
# wrong argv, and the installed daijin fails at launch with a confusing path error long
# after the install reported success. Refused here, where the message can name the knob,
# rather than quoted here and broken there.
check_paths() {
  case "$PREFIX" in
    *[[:space:]]*) die "the install prefix contains whitespace: '$PREFIX'.
  The client splits the engine command on whitespace, so this install would build a
  daijin that cannot start its own engine. Choose a path without spaces:
    DAIJIN_PREFIX=\$HOME/.local/share/daijin bash install/install.sh" ;;
  esac
  case "$BIN_DIR" in
    *[[:space:]]*) die "the bin directory contains whitespace: '$BIN_DIR'. Choose a path without spaces." ;;
  esac
}

main() {
  check_paths
  mkdir -p "$PREFIX"
  LOG_FILE="$PREFIX/install.log"
  : >"$LOG_FILE"
  log "daijin install starting, prefix $PREFIX"
  preflight
  resolve_source
  install_engine
  install_client
  write_shim
  write_stamp
  smoke
  probe_embedder
  report
}

main "$@"
