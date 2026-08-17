"""Find git repositories under the roots the ENGINE was configured with.

This is the first thing in this client that touches the filesystem for
anything other than its own config, so it is bounded on purpose: a fixed
depth, a capped result count, and directories that are never worth walking are
skipped by name. An unbounded walk of a home directory is a hang, and a hang
on the attach dialog is worse than a short list.

The roots come from settings.repoScanRoots rather than from a constant here,
because where a user keeps their code is a preference that must survive this
client rather than a rendering decision.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

# A repo checkout is rarely more than a couple of levels below a code root, and
# every extra level multiplies the walk.
MAX_DEPTH = 3
MAX_RESULTS = 200

# Never worth descending. node_modules alone can hold thousands of directories
# and occasionally a vendored .git, which would be listed as a repo the user
# has never heard of.
SKIP_NAMES = frozenset({
    "node_modules", ".venv", "venv", "__pycache__", ".git", "dist", "build",
    "target", ".next", ".cache", "Library", "Applications", ".Trash",
})


@dataclass(frozen=True)
class Discovered:
    """One candidate. `is_git` is a fact, not a judgement.

    A directory that is not a git repository is still attachable: the engine
    accepts it with a warning, so this reports the state and lets the dialog
    say what it means rather than filtering it away.
    """

    path: str
    name: str
    is_git: bool
    root: str


def scan_roots(
    roots: Sequence[str],
    *,
    max_depth: int = MAX_DEPTH,
    max_results: int = MAX_RESULTS,
    exists: bool = True,
) -> list[Discovered]:
    """Walk each root, shallowly, and return the git repositories found.

    A root that does not exist is skipped in silence: a configured path the
    user has not created yet is not an error, and the dialog reports how many
    roots produced nothing rather than failing on one.
    """
    found: list[Discovered] = []
    seen: set[str] = set()
    for raw in roots or ():
        root = os.path.expanduser(str(raw))
        if exists and not os.path.isdir(root):
            continue
        for path in _walk(root, max_depth):
            if path in seen:
                continue
            seen.add(path)
            found.append(
                Discovered(
                    path=path,
                    name=os.path.basename(path) or path,
                    is_git=os.path.isdir(os.path.join(path, ".git")),
                    root=root,
                )
            )
            if len(found) >= max_results:
                return found
    return found


def _walk(root: str, max_depth: int) -> Iterable[str]:
    """Yield directories that ARE git repositories, without descending into them.

    Stopping at a repository is deliberate: submodules and vendored checkouts
    below one are not things a user means to attach separately.
    """
    stack: list[tuple[str, int]] = [(root, 0)]
    while stack:
        current, depth = stack.pop()
        try:
            entries = list(os.scandir(current))
        except (PermissionError, FileNotFoundError, NotADirectoryError):
            continue
        if any(entry.name == ".git" and entry.is_dir() for entry in entries):
            yield current
            continue
        if depth >= max_depth:
            continue
        for entry in entries:
            if not entry.is_dir(follow_symlinks=False):
                continue
            if entry.name in SKIP_NAMES or entry.name.startswith("."):
                continue
            stack.append((entry.path, depth + 1))


def describe_path(path: str) -> tuple[bool, str]:
    """Can this be attached, and what should the user be told?

    Returns (ok, reason). The rules mirror the ENGINE and are deliberately not
    stricter than it: a directory that is not a git repository is ACCEPTED with
    a warning, so refusing it here would block a user from something that
    works. Only the two the engine refuses are refused.
    """
    text = (path or "").strip()
    if not text:
        return False, "Type a path, or pick one from the list."
    expanded = os.path.expanduser(text)
    if not os.path.exists(expanded):
        return False, f"{text} does not exist."
    if not os.path.isdir(expanded):
        return False, f"{text} is a file, and a repo is a directory."
    if not os.path.isdir(os.path.join(expanded, ".git")):
        # NOT a refusal. The engine attaches it and warns, and init on a
        # non-git directory completes and produces less rather than failing.
        return True, "Not a git repository. It can be attached, and it will produce less."
    return True, ""


def looks_like_clone_url(value: str) -> bool:
    """The shapes repoClone accepts, mirrored so the route can say so early.

    Verified against the daemon: a bare path and a file:// URL are both
    refused, and the engine expects https://host/owner/name or
    git@host:owner/name.git.
    """
    text = (value or "").strip()
    if text.startswith("git@"):
        host, _, rest = text[4:].partition(":")
        return bool(host and "/" in rest)
    if text.startswith("https://"):
        parts = text[len("https://"):].split("/")
        return len(parts) >= 3 and all(parts[:3])
    return False
