"""Entry point behaviour: flags, repo resolution, and the mock wiring."""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

import pytest
from conftest import run_async

from daijin_tui import mock_data
from daijin_tui.app import (
    ENGINE_COMMAND,
    DaijinApp,
    build_client,
    main,
    parse_args,
    resolve_repo,
)
from daijin_tui.rpc import SUPPORTED_CONTRACT_VERSION, MockRpcClient, StdioRpcClient


def test_mock_flag_selects_the_bundled_engine():
    client, is_mock = build_client(parse_args([".", "--mock"]))
    assert isinstance(client, MockRpcClient)
    assert is_mock is True


def test_engine_flag_selects_the_stdio_client():
    client, is_mock = build_client(parse_args([".", "--engine", "node server.js"]))
    assert isinstance(client, StdioRpcClient)
    assert client.command == ["node", "server.js"]
    assert is_mock is False


def test_the_mock_spend_gate_is_blocked_by_default():
    """Blocked by default matches the product rule: the owner opens the gate."""
    client, _ = build_client(parse_args([".", "--mock"]))
    assert client.engine.gate_open is False


def test_mock_gate_flag_reaches_the_engine():
    client, _ = build_client(parse_args([".", "--mock", "--mock-gate", "open"]))
    assert client.engine.gate_open is True


def test_mock_contract_flag_reaches_the_engine():
    client, _ = build_client(parse_args([".", "--mock", "--mock-contract", "99"]))
    assert client.engine.contract_version == "99"


def test_mock_speed_flag_reaches_the_engine():
    client, _ = build_client(parse_args([".", "--mock", "--mock-speed", "0"]))
    assert client.engine.speed == 0.0


def test_running_without_mock_or_engine_exits_with_guidance(capsys):
    assert main([".", ]) == 2
    assert "--mock" in capsys.readouterr().err


def test_repo_resolution_falls_back_to_a_known_mock_repo():
    assert resolve_repo(".", True) == mock_data.REPOS[0]["path"]
    assert resolve_repo(mock_data.REPOS[1]["path"], True) == mock_data.REPOS[1]["path"]
    assert resolve_repo("/somewhere/real", False) == "/somewhere/real"


def test_every_nav_target_has_a_screen():
    from daijin_tui.screens.base import NAV_ITEMS

    assert {key for key, _ in NAV_ITEMS} == set(DaijinApp.MODES)


# The help text is a promise about what to run ------------------------------


def test_help_text_names_the_process_entry_point_not_the_library(capsys):
    """server.js is the library; launching it exits 0 without ever answering.

    A first-run user following the help text would get a silent non-answer,
    which is the least diagnosable failure there is.
    """
    assert main([".", ]) == 2
    err = capsys.readouterr().err
    assert "daemon.js" in err
    assert "server.js" not in err
    assert ENGINE_COMMAND in err


@run_async
async def test_the_engine_command_in_the_help_text_actually_answers_hello(tmp_path):
    """Close the loop: run what the help says to run, and require an answer.

    Skipped rather than failed when node or the daemon is absent, because a
    missing toolchain is not a defect in this client. The skip message says
    which, so a green run cannot quietly mean "never checked".
    """
    engine_root = Path(__file__).resolve().parents[2] / "engine"
    daemon = engine_root / "src" / "rpc" / "daemon.js"
    if shutil.which("node") is None:
        pytest.skip("node is not installed, so the engine command cannot be exercised")
    if not daemon.exists():
        pytest.skip(f"engine daemon not present at {daemon}")

    # Exactly the command the help text prints, resolved against the repo root.
    parts = ENGINE_COMMAND.split()
    assert parts[0] == "node"
    command = [
        "node",
        str(engine_root.parent / parts[1]),
        f"--state-root={tmp_path}",
        "--no-probe",
    ]
    client = StdioRpcClient(command)
    try:
        await client.start()
        hello = await asyncio.wait_for(client.handshake(), timeout=30)
        assert hello.get("contractVersion"), "the engine command answered without a contract version"
        assert client.contract_version == SUPPORTED_CONTRACT_VERSION, (
            f"client speaks {SUPPORTED_CONTRACT_VERSION}, daemon speaks {client.contract_version}"
        )
    finally:
        await client.aclose()
