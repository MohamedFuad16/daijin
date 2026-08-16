"""SocketRpcClient against the real daemon: attach, spawn, and share.

These drive the extractor's socket server, not a mock, because the behaviour
worth testing here (one daemon serving several clients, ids that are
per-connection, a broadcast that reaches everyone) cannot exist in-process.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from pathlib import Path

import pytest
from conftest import run_async

from daijin_tui.rpc import (
    CONNECT_ATTACHED,
    CONNECT_FAILED,
    SUPPORTED_CONTRACT_VERSION,
    SocketRpcClient,
    default_socket_path,
)

ENGINE = Path(__file__).resolve().parents[2] / "engine" / "src" / "rpc" / "daemon.js"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not ENGINE.exists(),
    reason="node or the engine daemon is not available",
)


def spawn_command(state_root: Path) -> list[str]:
    return ["node", str(ENGINE), f"--state-root={state_root}", "--socket", "--no-probe"]


@pytest.fixture
def short_root():
    """A state root short enough for a unix socket path.

    sun_path is 104 bytes on macOS and pytest's tmp_path is far longer, so the
    daemon refuses with a named error. Using /tmp directly keeps the socket
    path around 30 bytes. The daemon's check is worth keeping: meeting a
    sentence that names the limit beats a bare EINVAL.
    """
    root = Path(tempfile.mkdtemp(prefix="dj", dir="/tmp"))
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


async def _wait_attached(client: SocketRpcClient, timeout: float = 25.0) -> None:
    await asyncio.wait_for(client.start(), timeout=timeout)


@run_async
async def test_it_spawns_a_daemon_and_attaches(short_root):
    """No daemon running: this client starts one and owns it."""
    root = short_root
    client = SocketRpcClient(
        default_socket_path(str(root)), spawn_command=spawn_command(root), connect_budget=20.0
    )
    try:
        await _wait_attached(client)
        assert client.connect_state == CONNECT_ATTACHED
        assert client.owns_daemon is True
        hello = await asyncio.wait_for(client.handshake(), timeout=20)
        assert hello["contractVersion"] == SUPPORTED_CONTRACT_VERSION
    finally:
        await client.aclose()


@run_async
async def test_a_second_client_attaches_rather_than_spawning(short_root):
    """The case stdio cannot do at all: two clients, one daemon."""
    root = short_root
    socket_path = default_socket_path(str(root))
    first = SocketRpcClient(socket_path, spawn_command=spawn_command(root), connect_budget=20.0)
    second = SocketRpcClient(socket_path, connect_budget=20.0)
    try:
        await _wait_attached(first)
        await first.handshake()
        await _wait_attached(second)

        assert second.connect_state == CONNECT_ATTACHED
        assert second.owns_daemon is False, "the second client started its own daemon"
        # Null, not empty: this client never had that daemon's stderr.
        assert second.stderr_tail is None

        hello = await asyncio.wait_for(second.handshake(), timeout=20)
        assert hello["contractVersion"] == SUPPORTED_CONTRACT_VERSION

        # Ids are per connection. Both clients number from 1 and neither sees
        # the other's answers.
        a, b = await asyncio.gather(
            first.call("serveStatus", {}), second.call("serveStatus", {})
        )
        assert "repos" in a and "repos" in b
    finally:
        await second.aclose()
        await first.aclose()


@run_async
async def test_one_clients_job_streams_to_both(short_root):
    """Broadcast fan-out, and the filter that stops a screen adopting it."""
    root = short_root
    socket_path = default_socket_path(str(root))
    first = SocketRpcClient(socket_path, spawn_command=spawn_command(root), connect_budget=20.0)
    second = SocketRpcClient(socket_path, connect_budget=20.0)
    seen_first: list[dict] = []
    seen_second: list[dict] = []
    first.on_event(seen_first.append)
    second.on_event(seen_second.append)
    try:
        await _wait_attached(first)
        await first.handshake()
        await _wait_attached(second)
        await second.handshake()

        repo = str(short_root / "repo")
        Path(repo).mkdir()
        await first.call("repoAttach", {"repoPath": repo})
        job = await first.call("gatesDiscover", {"repoPath": repo})

        deadline = asyncio.get_running_loop().time() + 20
        while asyncio.get_running_loop().time() < deadline:
            if seen_second and seen_second[-1].get("phase") == "done":
                break
            await asyncio.sleep(0.05)

        assert seen_first, "the client that started the job saw nothing"
        assert seen_second, "the job did not reach the attached client"
        # Every event carries its jobId, which is what the screen filter keys on.
        assert all(event.get("jobId") for event in seen_second)
        assert all(event["jobId"] == job["jobId"] for event in seen_second)
    finally:
        await second.aclose()
        await first.aclose()


@run_async
async def test_a_failed_connect_reports_a_reason_and_no_false_silence(short_root):
    """Nothing to attach to and nothing to spawn."""
    root = short_root
    client = SocketRpcClient(default_socket_path(str(root)), connect_budget=0.3)
    try:
        with pytest.raises(ConnectionError) as caught:
            await client.start()
        assert client.connect_state == CONNECT_FAILED
        assert "No engine answered" in str(caught.value)
        assert client.failure is not None
        # Attached rather than spawned, so there is no stderr to quote and the
        # message must not imply the engine was silent.
        assert client.failure["engineStderr"] is None
        assert "The engine said:" not in str(caught.value)
    finally:
        # In a finally because a failing assertion must not leak a client into
        # a loop that is about to close.
        await client.aclose()


@run_async
async def test_the_waiting_threshold_is_this_clients_own(short_root):
    """No engine-side state carries a number belonging to this UI."""
    root = short_root
    ticks = iter([0.0, 0.1, 0.2, 0.9, 5.0, 5.0, 5.0, 5.0])
    client = SocketRpcClient(
        default_socket_path(str(root)),
        connect_budget=0.0,
        clock=lambda: next(ticks, 5.0),
    )
    try:
        with pytest.raises(ConnectionError):
            await client.start()
        # Past the threshold but failed, so there is nothing to wait for.
        assert client.should_say_waiting is False
    finally:
        await client.aclose()
