"""Finding repos on disk, bounded, and validating a path no more strictly than the engine."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from daijin_tui.discovery import (
    MAX_DEPTH,
    SKIP_NAMES,
    describe_path,
    looks_like_clone_url,
    scan_roots,
)


def _git_repo(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    (path / ".git").mkdir(exist_ok=True)
    return path


def test_the_scan_finds_repos_and_stops_at_each_one(tmp_path):
    root = tmp_path / "code"
    _git_repo(root / "alpha")
    _git_repo(root / "team" / "beta")
    # A submodule below a repo is not something a user means to attach
    # separately, so the walk stops at the repository above it.
    _git_repo(root / "alpha" / "vendor" / "inner")
    (root / "plain").mkdir(parents=True)

    found = {item.name: item for item in scan_roots([str(root)])}
    assert set(found) == {"alpha", "beta"}, f"unexpected set: {sorted(found)}"
    assert "inner" not in found, "the scan descended into a repository"
    assert all(item.is_git for item in found.values())


def test_the_scan_is_bounded_in_depth_and_skips_the_directories_that_hurt(tmp_path):
    """An unbounded walk of a home directory is a hang, and a hang here is worse
    than a short list."""
    root = tmp_path / "code"
    deep = root
    for level in range(MAX_DEPTH + 2):
        deep = deep / f"level{level}"
    _git_repo(deep)
    _git_repo(root / "node_modules" / "vendored")
    _git_repo(root / "shallow")

    names = {item.name for item in scan_roots([str(root)])}
    assert "shallow" in names
    assert "vendored" not in names, "the scan walked into a skipped directory"
    assert deep.name not in names, f"the scan went past depth {MAX_DEPTH}"
    assert "node_modules" in SKIP_NAMES


def test_a_root_that_does_not_exist_is_skipped_rather_than_failing(tmp_path):
    _git_repo(tmp_path / "real" / "one")
    found = scan_roots([str(tmp_path / "real"), str(tmp_path / "not-created-yet")])
    assert [item.name for item in found] == ["one"]


def test_the_result_count_is_capped(tmp_path):
    root = tmp_path / "many"
    for index in range(12):
        _git_repo(root / f"repo{index}")
    assert len(scan_roots([str(root)], max_results=5)) == 5


def test_path_validation_is_never_stricter_than_the_engine(tmp_path):
    """The engine ACCEPTS a non-git directory, with a warning.

    Refusing it here would enforce a rule the engine deliberately declines to
    have and block a user from something that works: init on a non-git
    directory completes and produces less. Only the two cases the engine
    refuses are refused.
    """
    repo = _git_repo(tmp_path / "repo")
    plain = tmp_path / "plain"
    plain.mkdir()
    a_file = tmp_path / "a.txt"
    a_file.write_text("x")

    ok, reason = describe_path(str(repo))
    assert ok and reason == "", f"a git repo was questioned: {reason!r}"

    ok, reason = describe_path(str(plain))
    assert ok, "a non-git directory was refused, which the engine does not do"
    assert "produce less" in reason, "the warning does not say what it costs"

    # The two the engine refuses, and "cd" is the case the field test hit.
    for bad, expected in ((str(tmp_path / "cd"), "does not exist"),
                          (str(a_file), "is a file")):
        ok, reason = describe_path(bad)
        assert not ok and expected in reason, f"{bad}: {reason!r}"

    ok, reason = describe_path("   ")
    assert not ok


def test_the_clone_url_shapes_match_what_the_engine_accepts():
    """Verified against the daemon: a bare path and file:// are both refused."""
    for good in ("https://github.com/owner/name", "https://github.com/owner/name.git",
                 "git@github.com:owner/name.git"):
        assert looks_like_clone_url(good), good
    for bad in ("/tmp/thing", "file:///tmp/thing", "https://example.com", "", "github.com/o/n"):
        assert not looks_like_clone_url(bad), bad
