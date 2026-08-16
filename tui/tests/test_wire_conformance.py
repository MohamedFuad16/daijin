"""Every field a screen reads off a result must exist on the LIVE engine.

The mock cannot answer this question. A branch that reads a field only the mock
produces passes every test and renders nothing against reality, which is the
dead-gate family with the permissiveness moved into the fixture: coverage of a
world that does not exist.

My `provenance.vetoReason` was exactly that. The engine stores the reason at
the top level of the exam record; my mock invented a nested location; the
display branch could never have fired against real data and no test could tell
me, because both sides of the mock agreed with each other.

So this drives the real daemon and checks the paths, and skips with a stated
reason when the daemon is absent rather than passing quietly.
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest
from conftest import run_async

from daijin_tui.rpc import RpcError, StdioRpcClient

ENGINE = Path(__file__).resolve().parents[2] / "engine" / "src" / "rpc" / "daemon.js"
FIXTURE = Path(__file__).resolve().parents[2] / "engine" / "test-live" / "p8-fixture.mjs"
SEED = Path(__file__).resolve().parents[2] / "engine" / "test-live" / "p8-seed-rubric.mjs"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not ENGINE.exists() or not FIXTURE.exists(),
    reason="node, the engine daemon, or the live fixture is not available",
)

# (method, params-builder, paths the screens read off the RESULT).
# A path is dotted; a "[]" segment means "the rows of the list at this point".
READS = [
    ("analyze", lambda repo: {"repoPath": repo}, ["hasBrainFolder"]),
    ("serveStatus", lambda repo: {}, ["repos", "ollama", "db", "spendGate.open", "spendGate.path"]),
    ("documents", lambda repo: {"repoPath": repo}, ["[].id", "[].type", "[].area", "[].title", "[].tags"]),
    ("retrievalScore", lambda repo: {"repoPath": repo}, ["caseRate.exact", "caseRate.cases", "mrr", "violations", "chosenBudget", "rationale", "perCase"]),
    ("mcpSnippet", lambda repo: {"repoPath": repo}, ["unlocked", "threshold"]),
    # The classification arrived on the wire in 0c64509, so the screen reads it
    # again. content stays listed because it is the fallback when discovered is
    # null, and a fallback nobody checks is the one that rots.
    ("gatesGet", lambda repo: {"repoPath": repo}, [
        "path", "content", "discovered.gates", "discovered.summary.total",
        "discovered.summary.carryingSignal", "discovered.gates.[].id",
        "discovered.gates.[].command", "discovered.gates.[].role",
        "discovered.gates.[].classification", "discovered.gates.[].enabled",
        "discovered.gates.[].source", "discovered.gates.[].unavailableHint",
        "discovered.gates.[].baseline.status", "discovered.gates.[].baseline.exitCode",
        "discovered.gates.[].baseline.durationMs", "discovered.gates.[].baseline.timeoutMs",
        "discovered.gates.[].baseline.stdoutTail", "discovered.gates.[].baseline.stderrTail",
        "discovered.gates.[].baseline.unavailableReason",
    ]),
    ("examList", lambda repo: {"repoPath": repo}, ["[].examId", "[].title", "[].status", "[].benchmarkStatus", "[].heldOut", "[].tier", "[].provenance"]),
    ("examDetail", lambda repo: {"examId": "exam-0001", "repoPath": repo}, ["axes", "attempts", "provenance"]),
    ("board", lambda repo: {}, ["rows", "total"]),
    ("settingsGet", lambda repo: {}, ["roles", "retrieval", "storage"]),
]


def _resolve(value, path: str) -> bool:
    """Does this dotted path exist in the response?"""
    head, _, rest = path.partition(".")
    if head == "[]":
        if not isinstance(value, list):
            return False
        if not value:
            return True  # an empty list cannot contradict the shape
        return _resolve(value[0], rest) if rest else True
    if not isinstance(value, dict) or head not in value:
        return False
    return _resolve(value[head], rest) if rest else True


def _empty_at(value, prefix: str) -> bool:
    """Is the list this path fans out over empty (or absent) in the response?"""
    node = value
    for head in [part for part in prefix.split(".") if part]:
        if not isinstance(node, dict) or head not in node:
            return True
        node = node[head]
    return not isinstance(node, list) or not node


@run_async
async def test_every_field_a_screen_reads_exists_on_the_live_engine():
    root = Path(tempfile.mkdtemp(prefix="wc", dir="/tmp"))
    repo = Path(tempfile.mkdtemp(prefix="wr", dir="/tmp"))
    shutil.rmtree(repo)
    subprocess.run(["node", str(FIXTURE), str(repo)], capture_output=True, timeout=120)
    client = StdioRpcClient(["node", str(ENGINE), f"--state-root={root}"])
    missing: list[str] = []
    vacuous: set[str] = set()
    try:
        await client.start()
        await asyncio.wait_for(client.handshake(), timeout=30)
        await client.call("repoAttach", {"repoPath": str(repo)})
        # A brain is needed before the read-heavy methods answer.
        job = await client.call("initBrain", {"repoPath": str(repo), "mode": "layer1"})
        assert job["jobId"]
        deadline = asyncio.get_running_loop().time() + 180
        done = asyncio.Event()
        client.on_event(lambda e: done.set() if e.get("phase") == "done" else None)
        while asyncio.get_running_loop().time() < deadline and not done.is_set():
            await asyncio.sleep(0.5)
        assert done.is_set(), "the fixture init did not finish, so the check would be vacuous"
        subprocess.run(["node", str(SEED), str(repo)], capture_output=True, timeout=120)

        for method, build, paths in READS:
            try:
                result = await asyncio.wait_for(client.call(method, build(str(repo))), timeout=60)
            except RpcError as error:
                missing.append(f"{method}: refused, {error.hint[:60]}")
                continue
            for path in paths:
                if not _resolve(result, path):
                    missing.append(f"{method}.{path}")
            # A "[]" path over an empty list passes without checking anything.
            # That is the shape of every vacuous gate this project has shipped,
            # so the emptiness is named rather than counted as coverage.
            for path in paths:
                prefix, sep, _ = path.partition("[]")
                if sep and _empty_at(result, prefix.rstrip(".")):
                    vacuous.add(f"{method}.{prefix or 'result'}")
    finally:
        await client.aclose()
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(repo, ignore_errors=True)

    assert not missing, (
        "these are read by a screen and absent from the live response, so the "
        f"screen renders nothing against real data: {missing}"
    )
    # gatesGet is the one this check was extended for, and a run where the
    # fixture repo has no gates would have proved nothing about the fields.
    assert "gatesGet.discovered.gates." not in vacuous, (
        "the fixture repo returned zero gates, so every per-gate field above "
        "passed without being looked at"
    )
    assert not vacuous, f"these paths were never actually checked: {sorted(vacuous)}"
