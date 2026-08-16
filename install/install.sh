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

read_engine_version() {
  node -p "require('$PREFIX/engine/package.json').version" 2>/dev/null || echo "unknown"
}

read_tui_version() {
  # tomllib is 3.11+, and the floor is 3.10, so this reads the line rather than the file.
  awk -F'"' '/^version *=/ { print $2; exit }' "$PREFIX/tui/pyproject.toml" 2>/dev/null || echo "unknown"
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
  # readable here and a prefix containing spaces cannot break the quoting.
  python3 - "$PREFIX/bin/daijin" "$PREFIX" <<'PY'
import sys
path, prefix = sys.argv[1], sys.argv[2]
body = open(path).read().replace('__DAIJIN_PREFIX__', prefix)
open(path, 'w').write(body)
PY
  chmod +x "$PREFIX/bin/daijin"

  mkdir -p "$PREFIX/install"
  cp "$SOURCE/install/smoke.mjs" "$PREFIX/install/smoke.mjs"
  cp "$SOURCE/install/uninstall.sh" "$PREFIX/install/uninstall.sh"
  chmod +x "$PREFIX/install/uninstall.sh"

  mkdir -p "$BIN_DIR"
  ln -sf "$PREFIX/bin/daijin" "$BIN_DIR/daijin"
  log "shim: linked $BIN_DIR/daijin"
}

smoke() {
  log "smoke: hello handshake against the engine"
  node "$PREFIX/install/smoke.mjs" --prefix "$PREFIX" >>"$LOG_FILE" 2>&1 \
    || die "the hello handshake failed; the install is not usable. See $LOG_FILE"
  log "smoke: hello returned the stamped engine version"
}

report() {
  log "done: installed at $PREFIX"
  printf '\n'
  printf 'Daijin is installed.\n\n'
  printf '  command   %s/daijin\n' "$BIN_DIR"
  printf '  prefix    %s\n' "$PREFIX"
  printf '  stamp     %s/VERSION\n' "$PREFIX"
  printf '  log       %s\n' "$LOG_FILE"
  printf '\n'
  case ":$PATH:" in
    *":$BIN_DIR:"*) printf 'Run:  daijin .\n' ;;
    *) printf '%s is not on your PATH. Either add it:\n\n  export PATH="%s:$PATH"\n\nor run it by path:  %s/daijin .\n' "$BIN_DIR" "$BIN_DIR" "$BIN_DIR" ;;
  esac
  printf '\nUninstall:  %s/install/uninstall.sh\n' "$PREFIX"
}

main() {
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
  report
}

main "$@"
