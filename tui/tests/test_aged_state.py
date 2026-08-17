"""The screens, against a state root WITH A PAST.

Every other fixture in this suite is built fresh in a temp directory, which
makes every claim they support a claim about a machine with no history. The
machines that matter all have one. Two real defects came from a file like the
one here and from nothing else: the engine's shallow settings merge, where a
stored section replaced a default outright instead of filling in around it, and
this client's role table printing the literal word None because .get(key,
default) does not help when the key is present and its VALUE is null.

The fixture is deliberately out of date and must stay that way. See the note
inside it.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest
from conftest import run_async

from daijin_tui.rpc import StdioRpcClient
from daijin_tui.screens.repo_home import RepoHomeScreen
from daijin_tui.screens.settings import MODEL_KNOWN, ROLE_COLUMNS, _said

ENGINE = Path(__file__).resolve().parents[2] / "engine" / "src" / "rpc" / "daemon.js"
AGED_SETTINGS = Path(__file__).parent / "fixtures" / "aged-settings.json"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not ENGINE.exists() or not AGED_SETTINGS.exists(),
    reason=(
        "node, the engine daemon, or the aged fixture is not available. NOT CHECKED "
        "while skipped: how the screens render a settings file written before the "
        "current shape existed"
    ),
)


def _aged_state_root() -> Path:
    """A state root holding a settings.json from an older build."""
    root = Path(tempfile.mkdtemp(prefix="aged", dir="/tmp"))
    payload = json.loads(AGED_SETTINGS.read_text(encoding="utf-8"))
    payload.pop("_why_this_file_is_out_of_date", None)
    (root / "settings.json").write_text(json.dumps(payload, indent=1), encoding="utf-8")
    return root


@run_async
async def test_an_aged_settings_file_renders_without_the_word_none():
    """The whole point: a file older than the shape, read by a live engine.

    The engine fills its defaults in around what is stored, so fields the old
    file never had come back NULL rather than absent, and a renderer using
    .get(key, "") prints None for every one of them.
    """
    root = _aged_state_root()
    client = StdioRpcClient(["node", str(ENGINE), f"--state-root={root}"])
    try:
        await client.start()
        await asyncio.wait_for(client.handshake(), timeout=30)
        settings = await asyncio.wait_for(client.call("settingsGet", {}), timeout=30)
        status = await asyncio.wait_for(client.call("serveStatus", {}), timeout=30)
    finally:
        await client.aclose()
        shutil.rmtree(root, ignore_errors=True)

    roles = settings.get("roles") or []
    assert roles, "the aged file names roles, so this check would be vacuous without them"

    # The old file predates `provider`, so a live engine returns it null. If
    # that ever stops being true the fixture has aged into the current shape
    # and has stopped testing anything.
    aged_nulls = [r for r in roles if r.get("provider") is None]
    assert aged_nulls, (
        "no role came back with a null provider, so this fixture now matches the "
        "current shape and no longer describes a system with a past"
    )

    for role in roles:
        cells = [
            role.get("role", ""),
            _said(role.get("provider")),
            _said(role.get("model")),
            MODEL_KNOWN.get(role.get("modelKnown"), "not set"),
            _said(role.get("endpoint")),
        ]
        for cell in cells:
            assert "None" not in str(cell), f"a null rendered as the word None: {cells}"
        assert _said(role.get("provider")) == "not set"

    # And the engine status block, which reads a different section of the same
    # aged file.
    markup = RepoHomeScreen._engine_markup(status)
    assert "None" not in markup, f"a null reached the status line: {markup!r}"
    assert "?" not in markup


@run_async
async def test_the_engine_fills_defaults_in_around_an_old_file():
    """The shallow-merge defect, from the client's side.

    A stored section that REPLACED its default outright is how the embedder
    model and dimension went null on the machines with the longest history.
    The aged file stores `retrieval` and `charts` and has never heard of
    repoScanRoots, so this asserts the stored keys survive AND the missing ones
    arrive.
    """
    root = _aged_state_root()
    client = StdioRpcClient(["node", str(ENGINE), f"--state-root={root}"])
    try:
        await client.start()
        await asyncio.wait_for(client.handshake(), timeout=30)
        settings = await asyncio.wait_for(client.call("settingsGet", {}), timeout=30)
        status = await asyncio.wait_for(client.call("serveStatus", {}), timeout=30)
    finally:
        await client.aclose()
        shutil.rmtree(root, ignore_errors=True)

    # Stored values survive.
    assert (settings.get("retrieval") or {}).get("tokenBudget") == 4000, (
        "a value the old file stored was replaced by a default"
    )
    # Keys the old file never had arrive anyway.
    assert settings.get("repoScanRoots"), (
        "a setting added after this file was written did not arrive, which is the "
        "shallow-merge defect"
    )
    ollama = status.get("ollama") or {}
    for field in ("endpoint", "model", "dimension"):
        assert ollama.get(field) is not None, (
            f"ollama.{field} came back null on an aged state root, which is the "
            f"shallow merge dropping a default the stored section did not carry"
        )


def test_the_fixture_is_still_older_than_the_shape():
    """A fixture that has been updated forward is no longer a fixture.

    If someone "fixes" the file to match the current settings shape it stops
    describing a system with a past, and both tests above pass while checking
    nothing.
    """
    payload = json.loads(AGED_SETTINGS.read_text(encoding="utf-8"))
    assert payload.get("_why_this_file_is_out_of_date"), (
        "the note explaining why this file must stay stale was removed"
    )
    # preset was REMOVED from the role row in D-0037. Its presence here is what
    # makes this file old.
    assert "preset" in payload["roles"][0], (
        "the fixture no longer carries a field the current shape has dropped, so "
        "it has aged into the present"
    )
    assert "repoScanRoots" not in payload, (
        "the fixture gained a setting added after it was written"
    )
