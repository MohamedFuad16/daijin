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
# What it never touches, because none of it is the program. Three layers, and the middle
# one has two halves that fail differently (D-0031):
#
#   <repo>/.daijin/          THE REPO'S OWN. brain/ markdown, agents/, manifest.json,
#                            goldset.yaml, GATE. Canonical, human readable, committed.
#                            An uninstaller touching this would delete authored work.
#   ~/.daijin/repos/<id>/
#       index/               DISPOSABLE. Regenerable from the brain markdown at any time.
#                            The only thing here a cleanup could honestly offer to remove.
#       records/             KEPT. score-history.json was measured by a particular embedder
#                            on a date, and nothing can recompute the past. Clearing it
#                            alongside the index would destroy evidence to free a few
#                            megabytes, which is the trade nobody wants and everybody
#                            makes when the two sit in one directory.
#   ~/.daijin/settings.json, repos.json, daemon.lock   machine state: roles, attachments.
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
printf '  %s/.daijin           machine state: settings, attachments, and per repo\n' "$HOME"
printf '                       index/ (disposable) and records/ (measured history)\n'
printf '  <repo>/.daijin       each repository'"'"'s own brain, contract, gold set and GATE\n'

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
printf '  machine state:      %s/.daijin\n' "$HOME"
printf '  repository brains:  the .daijin folder inside each repository you attached\n'
printf '\nIf you want the disk back, the only part that regenerates is the index:\n'
printf '  rm -rf %s/.daijin/repos/*/index\n' "$HOME"
printf 'Leave records/ alone unless you mean to discard measured history; nothing\n'
printf 'recomputes a score that was taken on a date by an embedder you no longer run.\n'
