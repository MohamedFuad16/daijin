"""Fan-out behaviour: independent calls run concurrently, under a hard cap.

These are regression guards for a measured win. Before this strand the repo
home issued ten sequential calls on the BOOT screen, so its cost was the sum of
ten round trips. The tests assert the shape that made it max-not-sum, and the
ceiling that keeps a shared daemon from being swarmed.
"""

from __future__ import annotations

import asyncio

import pytest
from conftest import DEFAULT_REPO, run_async, running_app, settle

from daijin_tui.concurrency import gather_all, gather_iter
from daijin_tui.rpc import (
    EMBEDDING_BOUND,
    MAX_EMBEDDING_IN_FLIGHT,
    MAX_IN_FLIGHT,
    MockEngine,
    MockRpcClient,
    RpcError,
)


class LaggyClient(MockRpcClient):
    """The mock with a per-call delay, so serial work is visibly slower."""

    def __init__(self, *args, latency: float = 0.02, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.latency = latency

    async def _call_impl(self, method, params=None):
        await asyncio.sleep(self.latency)
        return await super()._call_impl(method, params)


# The cap ------------------------------------------------------------------


def test_the_broad_ceiling_is_a_backstop_not_a_throughput_limit():
    """Measured by the extractor against the real socket daemon: 27 calls in
    flight from three clients cost 37ms, and three concurrent analyze calls
    cost the same wall clock as one, because they are filesystem bound. So
    breadth is not the risk, and a tight ceiling would only slow the client.
    """
    assert MAX_IN_FLIGHT >= 16, (
        f"MAX_IN_FLIGHT is {MAX_IN_FLIGHT}, tight enough to throttle a fan-out "
        "the daemon was measured to absorb"
    )


@run_async
async def test_the_broad_ceiling_still_binds_if_something_runs_away():
    client = LaggyClient(MockEngine(speed=0.0), latency=0.01)
    issued = MAX_IN_FLIGHT * 3
    await gather_iter(client.call("analyze", {"repoPath": DEFAULT_REPO}) for _ in range(issued))
    assert client.peak_in_flight == MAX_IN_FLIGHT, (
        f"issued {issued} concurrent calls and peaked at {client.peak_in_flight}; "
        "the backstop is not binding"
    )
    await client.aclose()


# The limit that actually matters --------------------------------------------


def test_the_embedding_methods_are_the_ones_that_contend():
    """These queue behind one local Ollama, so concurrency does not overlap."""
    assert EMBEDDING_BOUND == {"search", "retrievalScore", "diagnose"}
    assert MAX_EMBEDDING_IN_FLIGHT == 1


@run_async
async def test_embedding_bound_calls_are_serialised():
    client = LaggyClient(MockEngine(speed=0.0), latency=0.01)
    await gather_iter(
        client.call("retrievalScore", {"repoPath": DEFAULT_REPO}) for _ in range(6)
    )
    assert client.peak_embedding_in_flight == MAX_EMBEDDING_IN_FLIGHT, (
        f"six retrievalScore calls peaked at {client.peak_embedding_in_flight} in "
        "flight; they contend for one embedder and must queue"
    )
    await client.aclose()


@run_async
async def test_cheap_calls_are_not_serialised_by_the_embedding_limit():
    """The narrow limit must not throttle everything else."""
    client = LaggyClient(MockEngine(speed=0.0), latency=0.02)
    await gather_iter(client.call("serveStatus", {}) for _ in range(8))
    assert client.peak_in_flight > 1, "cheap calls were serialised too"
    assert client.peak_embedding_in_flight == 0
    await client.aclose()


@run_async
async def test_the_boot_screen_does_not_stack_retrieval_scores():
    """One retrievalScore per repo, and they must not pile onto one embedder."""
    client = LaggyClient(MockEngine(speed=0.0), latency=0.02)
    from daijin_tui.app import DaijinApp

    app = DaijinApp(client, is_mock=True, repo=DEFAULT_REPO)
    async with app.run_test(size=(170, 55)) as pilot:
        await pilot.pause()
        await app.screen.wait_for_load()
    assert client.peak_embedding_in_flight <= MAX_EMBEDDING_IN_FLIGHT
    assert client.peak_in_flight > 1, "nothing ran concurrently, so this proves nothing"


@run_async
async def test_the_brain_screen_does_not_run_score_and_diagnose_together():
    client = LaggyClient(MockEngine(speed=0.0), latency=0.02)
    from daijin_tui.app import DaijinApp

    app = DaijinApp(client, is_mock=True, repo=DEFAULT_REPO)
    async with app.run_test(size=(170, 55)) as pilot:
        await pilot.pause()
        await app.screen.wait_for_load()
        await pilot.press("3")
        await settle(pilot)
        await app.screen.wait_for_load()
    assert client.peak_embedding_in_flight <= MAX_EMBEDDING_IN_FLIGHT


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


# These assert STRUCTURE, not wall clock. A margin against elapsed time is the
# flaky-gate class: on a loaded CI runner it fails for reasons unrelated to what
# it claims to test, which is the dead-gate rule inverted. Observed concurrency
# is clock-independent: the peak is identical at 0ms and 30ms of injected
# latency, because it is set by how the calls are ISSUED, not by how fast the
# machine answers them. Timing lives in the scratchpad harness, never in CI.


@run_async
async def test_the_boot_screen_issues_its_calls_concurrently():
    """The regression guard for the measured win, asserted structurally.

    Sequential awaits peak at 1 in flight. The fan-out peaks at 7: three
    analyze, three scoreHistory, and one retrievalScore, the other two queued
    behind the embedding permit.
    """
    client = LaggyClient(MockEngine(speed=0.0), latency=0.0)
    from daijin_tui.app import DaijinApp

    app = DaijinApp(client, is_mock=True, repo=DEFAULT_REPO)
    async with app.run_test(size=(170, 55)) as pilot:
        await pilot.pause()
        await app.screen.wait_for_load()
        calls = client._next_id

    assert calls >= 10, f"the boot screen should still gather every fact, saw {calls}"
    assert client.peak_in_flight >= 3, (
        f"peaked at {client.peak_in_flight} calls in flight across {calls} calls; "
        "the per-repo fan-out is running sequentially again"
    )
    assert client.peak_in_flight <= MAX_IN_FLIGHT
    assert client.peak_embedding_in_flight <= MAX_EMBEDDING_IN_FLIGHT


@run_async
async def test_settings_reads_its_four_instruction_files_concurrently():
    client = LaggyClient(MockEngine(speed=0.0), latency=0.0)
    from daijin_tui.app import DaijinApp

    app = DaijinApp(client, is_mock=True, repo=DEFAULT_REPO)
    async with app.run_test(size=(170, 55)) as pilot:
        await pilot.pause()
        await app.screen.wait_for_load()
        await pilot.press("8")
        await settle(pilot)
        await app.screen.wait_for_load()
        screen = app.screen
        client.peak_in_flight = 0
        before = client._next_id
        await screen.load()
        calls = client._next_id - before

    assert calls == 5, f"settingsGet plus four agentFileGet, saw {calls}"
    assert client.peak_in_flight >= 2, (
        f"peaked at {client.peak_in_flight}; the four instruction files are "
        "being read one after another again"
    )


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
