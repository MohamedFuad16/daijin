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
from typing import Any

import pytest
from conftest import run_async

from daijin_tui import mock_data
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
    # This entry used to list only the TOP-LEVEL keys, so ollama and db could
    # be renamed underneath it and the check stayed green. They were: embedder
    # became model and driver became backend in a change already committed,
    # and the status screen went on reading the old names and printing "not
    # reported" for fields that were present. A path that stops at an object
    # holds the engine to nothing about its contents.
    ("serveStatus", lambda repo: {}, [
        "repos", "db.backend", "db.repos",
        "ollama.reachable", "ollama.model", "ollama.version", "ollama.digest",
        "spendGate.open", "spendGate.path",
    ]),
    ("documents", lambda repo: {"repoPath": repo}, ["[].id", "[].type", "[].area", "[].title", "[].tags"]),
    ("retrievalScore", lambda repo: {"repoPath": repo}, ["caseRate.exact", "caseRate.cases", "mrr", "violations", "chosenBudget", "rationale", "perCase"]),
    ("mcpSnippet", lambda repo: {"repoPath": repo}, ["unlocked", "threshold"]),
    # The classification arrived on the wire in 0c64509, so the screen reads it
    # again. content stays listed because it is the fallback when discovered is
    # null, and a fallback nobody checks is the one that rots.
    ("gatesGet", lambda repo: {"repoPath": repo}, [
        "path", "content", "discovered.gates", "discovered.gates.[].id",
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
    gates_records: list[dict] = []
    results: dict[str, Any] = {}
    observed_status: set[str] = set()
    observed_class: set[str] = set()
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
                    results[method] = result
                    if method == "gatesGet":
                        gates_records.append(result)
                        for gate in ((result.get("discovered") or {}).get("gates") or []):
                            if gate.get("classification"):
                                observed_class.add(gate["classification"])
                            status = (gate.get("baseline") or {}).get("status")
                            if status:
                                observed_status.add(status)
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

    # Paths a landing engine change will add. They are REPORTED every run and
    # not failed on, because failing would make this branch red for a change
    # on someone else's side; they are listed here rather than left out so the
    # gap is visible instead of silent, and the list is meant to shrink to
    # nothing when the change lands (staged 2026-08-17, serveStatus gaining
    # endpoint, dimension, hint and stateRoot).
    pending = {
        "serveStatus": ["ollama.endpoint", "ollama.dimension", "ollama.hint", "db.stateRoot"],
    }
    still_missing, arrived = [], []
    for method, paths in pending.items():
        result = results.get(method)
        if result is None:
            continue
        for path in paths:
            (arrived if _resolve(result, path) else still_missing).append(f"{method}.{path}")
    if still_missing:
        print("\nPENDING WIRE PATHS, not yet on the engine: " + ", ".join(still_missing))
    if arrived:
        # Self-clearing: the moment the engine sends them, this says so, and
        # leaving them here after that would be a gate that has stopped
        # gating something it could now enforce.
        print(
            "\nPENDING PATHS HAVE ARRIVED, move them into READS: "
            + ", ".join(arrived)
        )

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

    # summary is null whenever no baseline has been run, which is a legitimate
    # state and the ordinary one after any edit. Asserting its fields
    # unconditionally would be a gate that fails on a legitimate state; only
    # asserting them when present would be a gate that can skip everything. So:
    # conditional, plus a separate check that the fixture reaches the branch.
    summary_bearing = [r for r in gates_records if (r.get("discovered") or {}).get("summary")]
    for record in summary_bearing:
        summary = record["discovered"]["summary"]
        for field in ("total", "carryingSignal", "live", "measured", "preBroken", "unavailable"):
            assert field in summary, f"a present summary is missing {field}: {sorted(summary)}"
    # The vocabulary check in test_rpc.py compares the mock against constants
    # in this repo, so both halves are ours and neither reaches the wire. This
    # closes ONE direction against the engine: a live value outside the set we
    # documented means our set is too small, which is the half a subset check
    # can catch. The other direction, a documented value the engine can never
    # produce, is NOT closed here and cannot be: no live run enumerates a
    # vocabulary, it only shows what one fixture happened to produce.
    if observed_status or observed_class:
        assert observed_status <= set(mock_data.BASELINE_STATUS), (
            f"the live engine sent a baseline status we do not document: "
            f"{sorted(observed_status - set(mock_data.BASELINE_STATUS))}"
        )
        assert observed_class <= set(mock_data.GATE_CLASSIFICATION), (
            f"the live engine sent a classification we do not document: "
            f"{sorted(observed_class - set(mock_data.GATE_CLASSIFICATION))}"
        )
        print(
            f"\nWIRE VOCABULARY OBSERVED: statuses {sorted(observed_status)}, "
            f"classifications {sorted(observed_class)}. "
            f"NOT observed and therefore not confirmed against the wire: "
            f"statuses {sorted(set(mock_data.BASELINE_STATUS) - observed_status)}, "
            f"classifications {sorted(set(mock_data.GATE_CLASSIFICATION) - observed_class)}."
        )
    elif "gatesGet" in answered:
        raise AssertionError(
            "gatesGet answered with gates but no classification or status was "
            "read off any of them, so the vocabulary check above was vacuous"
        )

    if "gatesGet" in answered:
        assert summary_bearing, (
            "no repo returned a summary, so the summary fields above were never "
            "checked. The conditional went vacuous; the fixture needs a repo "
            "whose gates have been baselined"
        )

    # Coverage is stated whether or not it is complete, because a refusal that
    # nobody reads is the same as a field nobody checked.
    if refused:
        print(f"\nWIRE CONFORMANCE: {len(answered)} methods checked, {checked_paths} paths resolved.")
        print("NOT CHECKED, the engine refused (a legitimate answer, not a defect):")
        for line in refused:
            print(f"  {line}")
