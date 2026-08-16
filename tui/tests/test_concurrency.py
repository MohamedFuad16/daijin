"""Fan-out behaviour: independent calls run concurrently, under a hard cap.

These are regression guards for a measured win. Before this strand the repo
home issued ten sequential calls on the BOOT screen, so its cost was the sum of
ten round trips. The tests assert the shape that made it max-not-sum, and the
ceiling that keeps a shared daemon from being swarmed.
"""

from __future__ import annotations

import asyncio
import time

import pytest
from conftest import DEFAULT_REPO, run_async, running_app, settle

from daijin_tui.concurrency import gather_all, gather_iter
from daijin_tui.rpc import MAX_IN_FLIGHT, MockEngine, MockRpcClient, RpcError


class LaggyClient(MockRpcClient):
    """The mock with a per-call delay, so serial work is visibly slower."""

    def __init__(self, *args, latency: float = 0.02, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.latency = latency

    async def _call_impl(self, method, params=None):
        await asyncio.sleep(self.latency)
        return await super()._call_impl(method, params)


# The cap ------------------------------------------------------------------


def test_the_cap_sits_in_the_agreed_band():
    """Asserted against a literal, not against itself.

    `peak <= MAX_IN_FLIGHT` is trivially true for any large MAX_IN_FLIGHT, so a
    test written that way passes when the cap is effectively removed. It did:
    raising the constant to 500 left the earlier version of these tests green.
    The band is the leader's 4-to-6 prior; changing the number outside it should
    be a deliberate act that fails a test first.
    """
    assert 4 <= MAX_IN_FLIGHT <= 6, f"MAX_IN_FLIGHT is {MAX_IN_FLIGHT}, outside the agreed 4 to 6"


@run_async
async def test_the_cap_actually_binds():
    """With far more work than the ceiling, the peak must BE the ceiling."""
    client = LaggyClient(MockEngine(speed=0.0), latency=0.01)
    issued = MAX_IN_FLIGHT * 4
    await gather_iter(client.call("analyze", {"repoPath": DEFAULT_REPO}) for _ in range(issued))
    assert client.peak_in_flight == MAX_IN_FLIGHT, (
        f"issued {issued} concurrent calls and peaked at {client.peak_in_flight}; "
        f"the cap of {MAX_IN_FLIGHT} is not binding"
    )
    await client.aclose()


@run_async
async def test_the_cap_is_enforced_by_the_client_not_by_each_screen():
    """A screen cannot exceed the ceiling even by fanning out carelessly."""
    client = LaggyClient(MockEngine(speed=0.0), latency=0.01)
    await gather_iter(client.call("serveStatus", {}) for _ in range(50))
    assert client.peak_in_flight == MAX_IN_FLIGHT
    await client.aclose()


@run_async
async def test_in_flight_returns_to_zero_even_when_a_call_fails():
    """A leaked permit would silently shrink the cap to nothing over time."""
    client = LaggyClient(MockEngine(speed=0.0), latency=0.0)
    for _ in range(MAX_IN_FLIGHT + 2):
        with pytest.raises(RpcError):
            await client.call("analyze", {"repoPath": "/nope"})
    assert client._current_in_flight == 0
    # The cap still has its full budget after the failures.
    await gather_iter(client.call("serveStatus", {}) for _ in range(MAX_IN_FLIGHT))
    assert client.peak_in_flight <= MAX_IN_FLIGHT
    await client.aclose()


# The win ------------------------------------------------------------------


@run_async
async def test_the_boot_screen_costs_max_latency_not_sum():
    """The measured regression guard: ten calls must not cost ten round trips."""
    latency = 0.03
    client = LaggyClient(MockEngine(speed=0.0), latency=latency)
    from daijin_tui.app import DaijinApp

    app = DaijinApp(client, is_mock=True, repo=DEFAULT_REPO)
    async with app.run_test(size=(170, 55)) as pilot:
        await pilot.pause()
        screen = app.screen
        before = client._next_id
        start = time.perf_counter()
        await screen.load()
        elapsed = time.perf_counter() - start
        calls = client._next_id - before

    assert calls >= 10, f"the boot screen should still gather every fact, saw {calls}"
    serial = calls * latency
    # serveStatus must finish before the per-repo round starts, so the floor is
    # two round trips; the ceiling is generous enough not to be flaky.
    assert elapsed < serial * 0.55, (
        f"{calls} calls took {elapsed*1000:.0f} ms; serial would be {serial*1000:.0f} ms. "
        "The per-repo fan-out is running sequentially again."
    )
    assert client.peak_in_flight <= MAX_IN_FLIGHT


@run_async
async def test_settings_reads_its_four_instruction_files_concurrently():
    latency = 0.03
    client = LaggyClient(MockEngine(speed=0.0), latency=latency)
    from daijin_tui.app import DaijinApp

    app = DaijinApp(client, is_mock=True, repo=DEFAULT_REPO)
    async with app.run_test(size=(170, 55)) as pilot:
        await pilot.pause()
        await pilot.press("8")
        await settle(pilot)
        screen = app.screen
        before = client._next_id
        start = time.perf_counter()
        await screen.load()
        elapsed = time.perf_counter() - start
        calls = client._next_id - before

    assert calls == 5, f"settingsGet plus four agentFileGet, saw {calls}"
    # settingsGet, then four concurrent reads: two round trips, not five.
    assert elapsed < 5 * latency * 0.7, f"{elapsed*1000:.0f} ms for {calls} calls"


# The helper ---------------------------------------------------------------


@run_async
async def test_gather_all_returns_failures_rather_than_cancelling_siblings():
    """One panel failing must not blank the others."""

    async def ok(value):
        return value

    async def boom():
        raise RpcError(-32602, "no", {"hint": "nope"})

    results = await gather_all(ok(1), boom(), ok(3))
    assert results[0] == 1
    assert isinstance(results[1], RpcError)
    assert results[2] == 3


@run_async
async def test_gather_all_of_nothing_is_not_an_error():
    assert await gather_all() == []
    assert await gather_iter([]) == []
