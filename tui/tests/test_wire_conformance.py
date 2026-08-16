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

WHAT THIS TEST NEEDS is not node: it is a PREPARED environment, an indexed
brain (which needs Ollama) and a repo whose gates have been discovered. CI has
node and neither of the other two, so the first version of this file failed
nine consecutive runs. It counted a legitimate refusal ("no indexed brain yet")
as a field missing from the wire, which is the false-gate class this project
ruled against, sitting inside the instrument built to catch it.

A refusal is the engine WORKING. Only a SUCCESS response missing a field a
screen reads is the defect. So refusals are named as gaps in coverage and never
as failures, the precondition is probed rather than assumed, and the skip says
out loud what was not checked so the skip path cannot quietly become the only
path.
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
    refused: list[str] = []
    vacuous: set[str] = set()
    checked_paths = 0
    answered: list[str] = []
    skip_reason: str | None = None
    try:
        await client.start()
        await asyncio.wait_for(client.handshake(), timeout=30)

        # PRECONDITION, probed rather than assumed. Indexing needs Ollama, and
        # without it every read-heavy method refuses correctly and this test
        # has nothing to say. That is a skip, not a failure.
        status = await asyncio.wait_for(client.call("serveStatus", {}), timeout=30)
        ollama = status.get("ollama") or {}
        if not ollama.get("reachable"):
            skip_reason = (
                "no reachable Ollama, so no brain can be indexed here and every "
                "read-heavy method would refuse correctly. NOT CHECKED: "
                + ", ".join(method for method, _, _ in READS)
            )
        else:
            await client.call("repoAttach", {"repoPath": str(repo)})
            job = await client.call("initBrain", {"repoPath": str(repo), "mode": "layer1"})
            assert job["jobId"]
            deadline = asyncio.get_running_loop().time() + 180
            done = asyncio.Event()
            client.on_event(lambda e: done.set() if e.get("phase") == "done" else None)
            while asyncio.get_running_loop().time() < deadline and not done.is_set():
                await asyncio.sleep(0.5)
            if not done.is_set():
                # Previously an assert. An environment that cannot finish an
                # init has not found a defect in a screen's field list.
                skip_reason = (
                    "the fixture init did not reach a done phase within 180s, so "
                    "there is no indexed brain to read from. NOT CHECKED: "
                    + ", ".join(method for method, _, _ in READS)
                )
            else:
                subprocess.run(["node", str(SEED), str(repo)], capture_output=True, timeout=120)

                for method, build, paths in READS:
                    try:
                        result = await asyncio.wait_for(client.call(method, build(str(repo))), timeout=60)
                    except RpcError as error:
                        # The engine answered, and the answer was no. That is a
                        # gap in what this run could check, not a missing field.
                        refused.append(f"{method}: {error.hint[:70]}")
                        continue
                    answered.append(method)
                    for path in paths:
                        if not _resolve(result, path):
                            missing.append(f"{method}.{path}")
                        else:
                            checked_paths += 1
                    # A "[]" path over an empty list passes without checking
                    # anything. That is the shape of every vacuous gate this
                    # project has shipped, so emptiness is named rather than
                    # counted as coverage.
                    for path in paths:
                        prefix, sep, _ = path.partition("[]")
                        if sep and _empty_at(result, prefix.rstrip(".")):
                            vacuous.add(f"{method}.{prefix or 'result'}")
    finally:
        await client.aclose()
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(repo, ignore_errors=True)

    if skip_reason:
        pytest.skip(skip_reason)

    # Real defects: the engine SUCCEEDED and the field a screen reads was not
    # in the response.
    assert not missing, (
        "these are read by a screen and absent from a SUCCESSFUL live response, "
        f"so the screen renders nothing against real data: {missing}"
    )

    # Non-vacuity. A run that checked nothing must not read as a pass, which is
    # how a skip path quietly becomes the only path.
    assert checked_paths > 0, (
        f"nothing was checked, so this run proves nothing. Refused: {refused}"
    )
    assert answered, f"every method refused, so no field was verified. Refused: {refused}"

    # gatesGet is the one this check was extended for. Its per-gate paths pass
    # vacuously over an empty list, so a run where the fixture returned zero
    # gates proved nothing about them.
    if "gatesGet" in answered:
        assert "gatesGet.discovered.gates." not in vacuous, (
            "the fixture repo returned zero gates, so every per-gate field above "
            "passed without being looked at"
        )
    assert not vacuous, f"these paths were never actually checked: {sorted(vacuous)}"

    # Coverage is stated whether or not it is complete, because a refusal that
    # nobody reads is the same as a field nobody checked.
    if refused:
        print(f"\nWIRE CONFORMANCE: {len(answered)} methods checked, {checked_paths} paths resolved.")
        print("NOT CHECKED, the engine refused (a legitimate answer, not a defect):")
        for line in refused:
            print(f"  {line}")
