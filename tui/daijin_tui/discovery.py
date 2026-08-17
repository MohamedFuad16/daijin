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


# The gh listing. It is a NETWORK CALL to GitHub, so nothing here runs unless a
# user presses a button that says so: the client's only unprompted reads are
# its own config and the engine's wire, and everything else is a labelled
# action. A dialog opening must never cause egress.
GH_TIMEOUT_SECONDS = 20
GH_LIMIT = 100


@dataclass(frozen=True)
class RemoteRepo:
    name_with_owner: str
    url: str
    local_path: str | None = None

    @property
    def needs_clone(self) -> bool:
        return self.local_path is None


def gh_available() -> bool:
    """Is the CLI on PATH at all? Answered without contacting anything."""
    import shutil as _shutil

    return _shutil.which("gh") is not None


def list_github_repos(limit: int = GH_LIMIT) -> tuple[list[RemoteRepo], str]:
    """Ask gh for the account's repositories. Returns (repos, error).

    The error is the CLI's own stderr, shown verbatim: gh already explains
    "not logged in" better than a paraphrase would, and a client that
    rewrites it will drift from whatever gh says next.
    """
    import json as _json
    import subprocess as _subprocess

    if not gh_available():
        return [], "The gh CLI is not installed, so GitHub cannot be listed."
    try:
        result = _subprocess.run(
            ["gh", "repo", "list", "--limit", str(limit), "--json", "nameWithOwner,url"],
            capture_output=True, text=True, timeout=GH_TIMEOUT_SECONDS,
        )
    except FileNotFoundError:
        return [], "The gh CLI is not installed, so GitHub cannot be listed."
    except _subprocess.TimeoutExpired:
        return [], f"gh did not answer within {GH_TIMEOUT_SECONDS} seconds."
    if result.returncode != 0:
        return [], (result.stderr or result.stdout or "gh failed without saying why").strip()
    try:
        rows = _json.loads(result.stdout or "[]")
    except ValueError:
        return [], "gh answered with something that is not JSON."
    return [
        RemoteRepo(name_with_owner=row.get("nameWithOwner", ""), url=row.get("url", ""))
        for row in rows
        if row.get("nameWithOwner")
    ], ""


def mark_already_local(
    remotes: Sequence[RemoteRepo], local: Sequence[Discovered]
) -> list[RemoteRepo]:
    """Match a remote to a local checkout by basename.

    Basename is a WEAK match and deliberately so: it is used only to mark a
    row as already present, never to attach one path as another. A false match
    costs the user a redundant clone offer; a strong-looking match that was
    wrong would attach the wrong directory.
    """
    by_name: dict[str, str] = {}
    for item in local:
        by_name.setdefault(item.name.lower(), item.path)
    return [
        RemoteRepo(
            name_with_owner=remote.name_with_owner,
            url=remote.url,
            local_path=by_name.get(remote.name_with_owner.split("/")[-1].lower()),
        )
        for remote in remotes
    ]
