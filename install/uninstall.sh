#!/usr/bin/env bash
#
# Daijin uninstaller. Removes what install.sh created and nothing else.
#
#   bash install/uninstall.sh              remove the default prefix
#   DAIJIN_PREFIX=... bash uninstall.sh    remove a specific one
#   DAIJIN_YES=1 bash uninstall.sh         no prompt
#
# What it removes: the prefix directory (the PROGRAM) and the single PATH symlink, and the
# symlink only when it actually points into that prefix.
#
# What it never touches, because none of it is the program:
#   ~/.daijin                        the engine's per-user STATE: which repos are attached
#                                    and what your settings are (engine/src/rpc/daemon.js)
#   <repo>/.daijin/brain.sqlite      a repository's brain, which is your data
#   your shell profile, node, python
#
# Deleting someone's data is not an uninstaller's business. This prints where those live
# and leaves them alone, so a reinstall finds the machine exactly as it left it.

set -euo pipefail

PREFIX="${DAIJIN_PREFIX:-$HOME/.local/share/daijin}"
BIN_DIR="${DAIJIN_BIN_DIR:-$HOME/.local/bin}"
LINK="$BIN_DIR/daijin"

if [ ! -d "$PREFIX" ]; then
  printf 'Nothing to remove: %s does not exist.\n' "$PREFIX"
  exit 0
fi

printf 'This will remove:\n'
printf '  %s\n' "$PREFIX"
if [ -L "$LINK" ]; then
  target="$(readlink "$LINK")"
  case "$target" in
    "$PREFIX"/*) printf '  %s -> %s\n' "$LINK" "$target" ;;
    *) printf '  (leaving %s alone: it points at %s, which this install did not create)\n' "$LINK" "$target" ;;
  esac
fi
printf '\nIt will NOT remove:\n'
printf '  %s/.daijin  the engine state: attached repos and settings\n' "$HOME"
printf '  any repository brain (.daijin/brain.sqlite inside your repos)\n'

if [ "${DAIJIN_YES:-0}" != "1" ]; then
  printf '\nProceed? [y/N] '
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) printf 'Cancelled.\n'; exit 0 ;;
  esac
fi

if [ -L "$LINK" ]; then
  target="$(readlink "$LINK")"
  case "$target" in
    "$PREFIX"/*) rm -f "$LINK"; printf 'removed %s\n' "$LINK" ;;
  esac
fi

rm -rf "$PREFIX"
printf 'removed %s\n' "$PREFIX"
printf '\nDaijin is uninstalled. Your data was left in place.\n'
printf '  engine state:      %s/.daijin\n' "$HOME"
printf '  repository brains: find ~ -name brain.sqlite -path "*/.daijin/*" 2>/dev/null\n'
printf '\nTo remove those too, delete them by hand; this script will not do it for you.\n'
