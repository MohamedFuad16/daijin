"""The client and the mock engine, tested at the protocol level against v3."""

from __future__ import annotations

import asyncio
import inspect
import re
import sys
from pathlib import Path

import pytest
from conftest import DEFAULT_REPO, SUB_75_REPO, run_async

from daijin_tui import mock_data
from daijin_tui.rpc import (
    ERR_INVALID_PARAMS,
    ERR_METHOD_NOT_FOUND,
    ERR_NOT_IMPLEMENTED,
    ERR_SPEND_GATE,
    EVENT_METHOD,
    SPEND_TOUCHING,
    STDERR_TAIL_LINES,
    SUPPORTED_CONTRACT_VERSION,
    MockEngine,
    MockRpcClient,
    RpcClient,
    RpcError,
    StdioRpcClient,
    is_spend_touching,
)

CONTRACT_PATH = Path(__file__).resolve().parents[2] / "engine" / "src" / "rpc" / "methods.md"

CONTRACT_METHODS = [
    ("hello", {"clientVersion": "0.1.0"}, ["engineVersion", "contractVersion"]),
    ("analyze", {"repoPath": DEFAULT_REPO}, ["languages", "commitCount", "structure", "gateCandidates", "hasBrainFolder"]),
    ("diagnose", {"repoPath": SUB_75_REPO}, ["clusters", "misses", "cases", "perCase"]),
    ("retrievalScore", {"repoPath": DEFAULT_REPO}, ["caseRate", "mrr", "violations", "chosenBudget", "rationale", "perCase"]),
    ("search", {"repoPath": DEFAULT_REPO, "query": "upload queue backoff"}, ["chunks", "tokensUsed"]),
    ("serveStatus", {}, ["repos", "ollama", "db", "spendGate"]),
    ("mcpSnippet", {"repoPath": DEFAULT_REPO}, ["unlocked", "threshold", "snippet"]),
    ("gatesGet", {"repoPath": DEFAULT_REPO}, ["path", "content", "discovered", "parseError"]),
    ("gymStatus", {}, ["cycles", "activeRun", "ledger"]),
    ("examDetail", {"examId": "exam-0058"}, ["axes", "attempts", "provenance"]),
    ("settingsGet", {}, ["roles", "retrieval", "storage"]),
    ("board", {}, ["rows"]),
    ("agentFileGet", {"role": "teacher"}, ["content", "defaultHash", "currentHash", "modified"]),
]


@pytest.mark.parametrize("method,params,keys", CONTRACT_METHODS)
@run_async
async def test_contract_methods_return_their_documented_keys(method, params, keys):
    client = MockRpcClient(MockEngine(speed=0.0))
    result = await client.call(method, params)
    for key in keys:
        assert key in result, f"{method} did not return {key}"
    await client.aclose()


# Handshake -----------------------------------------------------------------


# Method coverage, derived from the contract tables ------------------------


def _contract_methods() -> set[str]:
    """Every request method the v4 method TABLES declare.

    The tables are the count, not any sentence about them, so this parses the
    table rows rather than trusting a number written down somewhere.
    """
    methods: set[str] = set()
    for line in CONTRACT_PATH.read_text(encoding="utf-8").splitlines():
        if not line.startswith("| `"):
            continue
        name = line.split("`")[1]
        methods.add(name)
    return methods


@pytest.mark.skipif(not CONTRACT_PATH.exists(), reason="contract file not present")
def test_every_contract_method_is_implemented_and_referenced():
    methods = _contract_methods()
    # A parse failure would make this gate vacuous, so it has to find a surface.
    assert len(methods) >= 25, f"contract parse found only {sorted(methods)}"

    engine = MockEngine(speed=0.0)
    unimplemented = sorted(name for name in methods if not hasattr(engine, f"_rpc_{name}"))
    assert not unimplemented, f"MockEngine does not serve {unimplemented}"

    # Screens and the app shell are scanned for the call site. rpc.py and
    # mock_data.py are excluded on purpose: the engine implementation naming a
    # method proves nothing about a screen using it.
    package = Path(__file__).resolve().parents[1] / "daijin_tui"
    client_code = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted(package.rglob("*.py"))
        if path.name not in ("rpc.py", "mock_data.py")
    )
    # hello is the one method no screen calls: it is the transport handshake,
    # issued by RpcClient.handshake before any screen exists. Checked at its
    # real call site rather than waved through.
    assert '"hello"' in inspect.getsource(RpcClient.handshake)
    handshake_only = {"hello"}

    unreferenced = sorted(
        name for name in methods - handshake_only if f'"{name}"' not in client_code
    )
    assert not unreferenced, f"no screen calls {unreferenced}"


# Naming a method is fine; a stub may explain what one does and does not carry.
# DENYING that a declared method exists is the failure being gated, because that
# is what the document-inventory stub became when v4 added `documents`.
DENIAL_PHRASES = (
    "does not expose",
    "no rpc method",
    "has no method",
    "no method that",
    "not exposed",
    "cannot be listed",
    "does not have",
    "no human readable title",
)


def _stub_offenders(blocks, methods) -> list[str]:
    offenders = []
    for where, block in blocks:
        flat = " ".join(block.split()).lower()
        if not any(phrase in flat for phrase in DENIAL_PHRASES):
            continue
        for name in methods:
            if name.lower() in flat:
                offenders.append(f"{where}: a stub denies {name}, which the contract declares")
    return offenders

@pytest.mark.skipif(not CONTRACT_PATH.exists(), reason="contract file not present")
def test_no_stub_claims_a_method_the_contract_actually_has():
    """A stub that outlives its gap is worse than no stub: it is false on screen.

    This is the exact failure the documents stub became when v4 added the
    method, so it is a gate now rather than a habit.
    """
    methods = _contract_methods()
    assert len(methods) >= 25, "contract parse found nothing"
    screens = Path(__file__).resolve().parents[1] / "daijin_tui" / "screens"
    blocks = []
    for path in sorted(screens.glob("*.py")):
        source = path.read_text(encoding="utf-8")
        for block in re.findall(r"StubPanel\((.*?)\n\s*\)", source, re.S):
            blocks.append((path.name, block))

    # v5 closed the last two gaps, so there are no stubs left to inspect. That
    # would make this gate silently vacuous, so the detector is exercised on a
    # synthetic offender first: a dead gate is worse than no gate.
    sample = 'StubPanel("x", "The surface does not expose documents.")'
    assert _stub_offenders([("sample.py", sample)], methods), "the stub detector itself is broken"

    assert not _stub_offenders(blocks, methods)


@pytest.mark.skipif(not CONTRACT_PATH.exists(), reason="contract file not present")
def test_the_contract_declares_the_method_count_the_plan_recorded():
    """The tables ARE the count, so the count is derived rather than written.

    A literal here was a number in THIS repo describing the ENGINE's surface,
    which is the hand-copied shape: both halves mine, drifting together or not
    at all. The same fix as the keyRef mirror, which stopped being a copy the
    moment it was checked against the original.

    What is asserted instead is the thing a number was standing in for: the
    tables and the mock describe the SAME surface, in both directions.
    """
    methods = _contract_methods()
    # Non-vacuity first: a parser that returned nothing would satisfy every
    # subset assertion below it.
    assert len(methods) >= 25, f"the contract parse found only {sorted(methods)}"

    engine = MockEngine(speed=0.0)
    served = {
        name[len("_rpc_"):] for name in dir(engine) if name.startswith("_rpc_")
    }
    assert not methods - served, f"documented and not served: {sorted(methods - served)}"
    # The reverse catches a method this client INVENTED: one the mock answers
    # and the contract never declared would let a screen be built against
    # something no engine has.
    assert not served - methods, f"served and not documented: {sorted(served - methods)}"


@run_async
async def test_handshake_records_the_contract_version():
    client = MockRpcClient(MockEngine(speed=0.0))
    result = await client.handshake()
    assert result["contractVersion"] == SUPPORTED_CONTRACT_VERSION
    assert client.contract_matches is True
    await client.aclose()


@run_async
async def test_handshake_detects_a_contract_mismatch():
    client = MockRpcClient(MockEngine(speed=0.0, contract_version="6"))
    await client.handshake()
    assert client.contract_version == "6"
    assert client.contract_matches is False
    await client.aclose()


# Spend discipline ----------------------------------------------------------


def _contract_spend_methods() -> set[str]:
    """Read the spend-touching set straight out of the frozen contract."""
    text = CONTRACT_PATH.read_text(encoding="utf-8")
    convention = text.split("## Error convention", 1)[1]
    sentence = convention.split("The spend-touching methods, exhaustively:", 1)[1]
    sentence = sentence.split("Everything else", 1)[0]
    return set(re.findall(r"`([A-Za-z0-9+_]+)`", sentence))


@pytest.mark.skipif(not CONTRACT_PATH.exists(), reason="contract file not present")
def test_client_spend_set_matches_the_frozen_contract():
    """A wrong spend enumeration is the one class of error this project refuses."""
    from_contract = _contract_spend_methods()
    ours = {entry.split(":", 1)[0] for entry in SPEND_TOUCHING}
    # layer1+layer2 appears as a bare mode token in the sentence, not a method.
    from_contract.discard("layer1+layer2")
    assert ours == from_contract, f"contract says {sorted(from_contract)}, client carries {sorted(ours)}"


def test_init_brain_only_spends_on_layer2():
    assert is_spend_touching("initBrain", {"mode": "layer1"}) is False
    assert is_spend_touching("initBrain", {"mode": "ingest"}) is False
    assert is_spend_touching("initBrain", {"mode": "layer1+layer2"}) is True
    assert is_spend_touching("retrievalScore", {}) is False
    assert is_spend_touching("diagnose", {}) is False
    assert is_spend_touching("diagnoseNarrate", {}) is True
    assert is_spend_touching("rolePing", {}) is True
    assert is_spend_touching("gymStart", {}) is True


@run_async
async def test_gym_start_is_refused_when_the_spend_gate_is_blocked():
    client = MockRpcClient(MockEngine(speed=0.0, gate_open=False))
    with pytest.raises(RpcError) as caught:
        await client.call("gymStart", {"repoPath": DEFAULT_REPO, "config": {}})
    assert caught.value.code == ERR_SPEND_GATE
    assert caught.value.gate == ".daijin/GATE"
    assert "owner's hand" in caught.value.hint
    await client.aclose()


@run_async
async def test_gym_harvest_holds_both_locks_and_apply_holds_consent():
    """The learning loop's locks, mirrored: gymHarvest needs the gate AND
    confirm; gymHarvestApply calls no provider but still never infers consent."""
    blocked = MockRpcClient(MockEngine(speed=0.0, gate_open=False))
    with pytest.raises(RpcError) as caught:
        await blocked.call("gymHarvest", {"repoPath": DEFAULT_REPO, "confirm": True})
    assert caught.value.code == ERR_SPEND_GATE
    await blocked.aclose()

    unconfirmed = MockRpcClient(MockEngine(speed=0.0, gate_open=True))
    with pytest.raises(RpcError) as caught:
        await unconfirmed.call("gymHarvest", {"repoPath": DEFAULT_REPO})
    assert caught.value.code == ERR_SPEND_GATE
    assert "nothing is written to the brain" in caught.value.hint.lower()
    with pytest.raises(RpcError) as caught:
        await unconfirmed.call("gymHarvestApply", {"repoPath": DEFAULT_REPO, "batchId": 2})
    assert caught.value.code == ERR_SPEND_GATE
    await unconfirmed.aclose()
    assert is_spend_touching("gymHarvest", {}) is True
    assert is_spend_touching("gymHarvestApply", {}) is False, (
        "apply calls no provider; its consent is the write-to-brain confirmation"
    )


@run_async
async def test_role_ping_is_refused_without_an_explicit_confirmation():
    client = MockRpcClient(MockEngine(speed=0.0))
    with pytest.raises(RpcError) as caught:
        await client.call("rolePing", {"role": "engineer"})
    assert caught.value.code == ERR_SPEND_GATE
    assert "never on a screen opening" in caught.value.hint
    ping = await client.call("rolePing", {"role": "engineer", "confirm": True})
    assert ping["httpStatus"] == 200
    assert ping["servedModelId"] == "glm-4.6"
    # The daemon returns the STORED record (contract, 2026-08-17): the four
    # measurements plus the record's own verdict and timestamp, so a client
    # can render the result without re-reading settings.
    assert set(ping) == {"ok", "httpStatus", "ttftMs", "latencyMs", "servedModelId", "at"}
    assert ping["ok"] is True
    await client.aclose()


@run_async
async def test_role_ping_reports_a_failed_call_rather_than_erroring():
    """A 429 is a completed, billed call. It is data, not an RPC error."""
    client = MockRpcClient(MockEngine(speed=0.0))
    ping = await client.call("rolePing", {"role": "watcher", "confirm": True})
    assert ping["httpStatus"] == 429
    assert ping["servedModelId"] is None
    await client.aclose()


@run_async
async def test_layer2_init_is_refused_without_confirmation():
    client = MockRpcClient(MockEngine(speed=0.0))
    with pytest.raises(RpcError) as caught:
        await client.call("initBrain", {"repoPath": DEFAULT_REPO, "mode": "layer1+layer2"})
    assert caught.value.code == ERR_SPEND_GATE
    assert "engineer key" in caught.value.hint
    # The echo is the CLIENT's obligation, not an engine refusal: the engine
    # accepts a bare confirm and records what it was given. Asserted from the
    # client side in test_screens.py; here we only check the engine's behaviour.
    estimate = await client.call("budgetEstimate", {"repoPath": DEFAULT_REPO, "mode": "layer1+layer2"})
    ok = await client.call(
        "initBrain",
        {"repoPath": DEFAULT_REPO, "mode": "layer1+layer2", "confirm": True, "budget": estimate},
    )
    assert ok["jobId"].startswith("job-init-")
    await client.aclose()


@run_async
async def test_an_open_gate_is_not_consent_to_a_cycle():
    """v5: the engine never infers consent, not even from an open gate."""
    client = MockRpcClient(MockEngine(speed=0.0, gate_open=True))
    with pytest.raises(RpcError) as caught:
        await client.call("gymStart", {"repoPath": DEFAULT_REPO, "config": {}})
    assert caught.value.code == ERR_SPEND_GATE
    assert "not consent to this particular cycle" in caught.value.hint
    ok = await client.call("gymStart", {"repoPath": DEFAULT_REPO, "config": {}, "confirm": True})
    assert ok["jobId"].startswith("job-gym-")
    await client.aclose()


@pytest.mark.parametrize(
    "method,params",
    [
        ("gymStart", {"repoPath": DEFAULT_REPO, "config": {}}),
        ("rolePing", {"role": "engineer"}),
        ("diagnoseNarrate", {"repoPath": SUB_75_REPO}),
        ("initBrain", {"repoPath": DEFAULT_REPO, "mode": "layer1+layer2"}),
    ],
)
@run_async
async def test_every_spend_touching_method_refuses_without_confirm(method, params):
    client = MockRpcClient(MockEngine(speed=0.0, gate_open=True))
    with pytest.raises(RpcError) as caught:
        await client.call(method, params)
    assert caught.value.code == ERR_SPEND_GATE, f"{method} did not refuse an unconfirmed call"
    await client.aclose()


@run_async
async def test_budget_estimate_is_zero_spend_and_shows_its_basis():
    client = MockRpcClient(MockEngine(speed=0.0))
    estimate = await client.call("budgetEstimate", {"repoPath": DEFAULT_REPO, "mode": "layer1+layer2"})
    assert set(estimate) == {"estimatedTokens", "basis"}
    assert estimate["estimatedTokens"] == 736_000
    assert "narration calls" in estimate["basis"]
    # The method that feeds the consent dialog must not itself spend.
    assert client.engine.spend_calls == []
    assert not is_spend_touching("budgetEstimate", {})
    gym = await client.call("budgetEstimate", {"repoPath": DEFAULT_REPO, "mode": "gym"})
    assert gym["estimatedTokens"] != estimate["estimatedTokens"]
    with pytest.raises(RpcError):
        await client.call("budgetEstimate", {"repoPath": DEFAULT_REPO, "mode": "nonsense"})
    await client.aclose()


@run_async
async def test_a_scoped_layer2_estimate_is_smaller_than_an_unscoped_one():
    client = MockRpcClient(MockEngine(speed=0.0))
    whole = await client.call("budgetEstimate", {"repoPath": DEFAULT_REPO, "mode": "layer1+layer2"})
    scoped = await client.call(
        "budgetEstimate",
        {"repoPath": DEFAULT_REPO, "mode": "layer1+layer2", "scope": {"areas": ["src/lib"]}},
    )
    assert scoped["estimatedTokens"] < whole["estimatedTokens"]
    assert "scoped to src/lib" in scoped["basis"]
    await client.aclose()


@run_async
async def test_an_unknown_document_filter_is_an_error_not_a_silent_pass():
    """A filter that is ignored returns everything, which reads as no matches."""
    client = MockRpcClient(MockEngine(speed=0.0))
    with pytest.raises(RpcError) as caught:
        await client.call("documents", {"repoPath": DEFAULT_REPO, "filters": {"tpye": "card"}})
    assert caught.value.code == ERR_INVALID_PARAMS
    assert "tpye" in caught.value.hint
    assert "q, type, area" in caught.value.hint.replace("area, q, type", "q, type, area")
    await client.aclose()


@run_async
async def test_exam_rows_carry_a_human_readable_title():
    client = MockRpcClient(MockEngine(speed=0.0))
    rows = await client.call("examList", {})
    for row in rows:
        assert row.get("title"), f"{row['examId']} has no title"
        assert row["title"] != row["examId"]
    await client.aclose()


@run_async
async def test_layer1_init_never_needs_confirmation():
    client = MockRpcClient(MockEngine(speed=0.0))
    result = await client.call("initBrain", {"repoPath": DEFAULT_REPO, "mode": "layer1"})
    assert result["jobId"].startswith("job-init-")
    await client.aclose()


@run_async
async def test_diagnose_is_free_and_narration_is_not():
    client = MockRpcClient(MockEngine(speed=0.0))
    diagnosis = await client.call("diagnose", {"repoPath": SUB_75_REPO})
    assert len(diagnosis["misses"]) > 0
    with pytest.raises(RpcError) as caught:
        await client.call("diagnoseNarrate", {"repoPath": SUB_75_REPO})
    assert caught.value.code == ERR_SPEND_GATE
    narrated = await client.call("diagnoseNarrate", {"repoPath": SUB_75_REPO, "confirm": True})
    assert "Packages/Core" in narrated["recommendation"]
    await client.aclose()


# Value conventions ---------------------------------------------------------


@run_async
async def test_case_rate_carries_both_the_exact_ratio_and_the_count_form():
    client = MockRpcClient(MockEngine(speed=0.0))
    score = await client.call("retrievalScore", {"repoPath": DEFAULT_REPO, "sweep": True})
    case_rate = score["caseRate"]
    assert set(case_rate) == {"exact", "cases"}
    assert case_rate["cases"] == "31 of 34"
    assert case_rate["exact"] == pytest.approx(31 / 34)
    # Unrounded on purpose: rounding at the source is how a floor quietly moves.
    assert case_rate["exact"] != round(case_rate["exact"], 3)
    for point in score["budgetSweep"]:
        assert set(point["caseRate"]) == {"exact", "cases"}
    await client.aclose()


@run_async
async def test_per_case_rows_carry_arm_type_and_area():
    client = MockRpcClient(MockEngine(speed=0.0))
    score = await client.call("retrievalScore", {"repoPath": DEFAULT_REPO})
    assert score["perCase"]
    for row in score["perCase"]:
        assert set(row) == {"caseId", "hit", "rank", "arm", "type", "area"}
        assert row["arm"] in ("semantic", "lexical", "fused")
    await client.aclose()


@run_async
async def test_documents_lists_the_inventory_and_filters_it():
    client = MockRpcClient(MockEngine(speed=0.0))
    rows = await client.call("documents", {"repoPath": DEFAULT_REPO})
    assert len(rows) == 10
    for row in rows:
        assert set(row) == {"id", "type", "path", "title", "area", "tags"}
    cards = await client.call("documents", {"repoPath": DEFAULT_REPO, "filters": {"type": "card"}})
    assert cards and all(row["type"] == "card" for row in cards)
    hits = await client.call("documents", {"repoPath": DEFAULT_REPO, "filters": {"q": "retry storm"}})
    assert [row["id"] for row in hits] == ["lesson-0009-retry-storm"]
    with pytest.raises(RpcError) as caught:
        await client.call("documents", {"repoPath": "/Users/owner/code/kiln-api"})
    assert "No brain has been built" in caught.value.hint
    await client.aclose()


@run_async
async def test_score_history_is_newest_first_and_carries_case_rate_objects():
    client = MockRpcClient(MockEngine(speed=0.0))
    history = await client.call("scoreHistory", {"repoPath": DEFAULT_REPO})
    assert len(history) == 5
    stamps = [row["at"] for row in history]
    assert stamps == sorted(stamps, reverse=True), "scoreHistory must be newest first"
    for row in history:
        assert set(row) == {"at", "caseRate", "chosenBudget"}
        assert set(row["caseRate"]) == {"exact", "cases"}
    # A different series from budgetSweep: this one moves over time.
    assert history[0]["caseRate"]["cases"] == "31 of 34"
    assert history[-1]["caseRate"]["cases"] == "21 of 31"
    await client.aclose()


@run_async
async def test_score_history_and_budget_sweep_are_not_the_same_series():
    client = MockRpcClient(MockEngine(speed=0.0))
    history = await client.call("scoreHistory", {"repoPath": DEFAULT_REPO})
    sweep = (await client.call("retrievalScore", {"repoPath": DEFAULT_REPO, "sweep": True}))["budgetSweep"]
    assert [row["caseRate"]["cases"] for row in history] != [p["caseRate"]["cases"] for p in sweep]
    assert "budget" not in history[0] and "at" not in sweep[0]
    await client.aclose()


@run_async
async def test_settings_match_the_v4_codified_shape():
    client = MockRpcClient(MockEngine(speed=0.0))
    settings = await client.call("settingsGet", {})
    assert set(settings) == {"roles", "instructionFiles", "retrieval", "storage", "spendGate", "charts"}
    for role in settings["roles"]:
        # preset is gone (D-0037). It asserted only that a key existed, which
        # is what let a column stay blank against a real engine for weeks.
        assert "preset" not in role, "preset came back; it is not on the wire"
        assert set(role) >= {
            "role", "provider", "model", "modelKnown", "modelReason",
            "reasoningEffort", "endpoint", "keyRef", "keyMasked", "ping",
        }
    for record in settings["instructionFiles"]:
        assert set(record) == {"name", "path", "hash", "defaultHash", "modified"}
    await client.aclose()


@run_async
async def test_gym_ledger_matches_the_v4_codified_shape():
    client = MockRpcClient(MockEngine(speed=0.0))
    status = await client.call("gymStatus", {})
    assert set(status["ledger"]) == {
        "mode", "scoredWrites", "drawnFromResultFiles", "rowsWritten", "certifications", "exams",
    }
    assert set(status["activeRun"]) == {
        "jobId", "examId", "round", "state", "mode", "edits", "checks",
        "extensions", "boundary", "criteriaAudit", "rollbacks",
    }
    # The denominator rule, visible on the wire: drawn from files, not rows.
    assert status["ledger"]["drawnFromResultFiles"] != status["ledger"]["rowsWritten"]
    await client.aclose()


@run_async
async def test_agent_file_edit_moves_the_settings_mirror_too():
    client = MockRpcClient(MockEngine(speed=0.0))
    await client.call("agentFileSet", {"role": "student", "content": "changed"})
    settings = await client.call("settingsGet", {})
    entry = next(f for f in settings["instructionFiles"] if f["name"] == "student")
    assert entry["modified"] is True
    await client.aclose()


def test_no_fixture_key_looks_like_a_real_provider_key():
    """Fake keys must not trip a secret scanner on a public repo."""
    source = Path(mock_data.__file__).read_text(encoding="utf-8")
    for prefix in ("sk-", "sk-ant-", "ghp_", "AKIA"):
        assert prefix not in source, f"mock_data carries a scanner-tripping prefix {prefix!r}"


@run_async
async def test_retrieval_score_omits_the_sweep_unless_asked():
    client = MockRpcClient(MockEngine(speed=0.0))
    assert "budgetSweep" not in await client.call("retrievalScore", {"repoPath": DEFAULT_REPO})
    assert "budgetSweep" in await client.call("retrievalScore", {"repoPath": DEFAULT_REPO, "sweep": True})
    await client.aclose()


def test_fixtures_do_not_carry_the_superseded_numbers():
    """The pre-correction values must not reappear anywhere in the fixture."""
    source = Path(mock_data.__file__).read_text(encoding="utf-8")
    for banned in ("0.912", "0.659", "91.2 percent", "91.2%"):
        assert banned not in source, f"mock_data still carries {banned!r}"


# Exams ---------------------------------------------------------------------


@run_async
async def test_exam_list_carries_two_orthogonal_status_axes():
    client = MockRpcClient(MockEngine(speed=0.0))
    rows = await client.call("examList", {})
    assert rows
    for row in rows:
        assert row["status"] in ("draft", "validated", "promoted", "vetoed")
        assert row["benchmarkStatus"] in ("active", "quarantined")
        assert isinstance(row["heldOut"], bool)
        assert "tier" in row and "provenance" in row
        if row["benchmarkStatus"] == "quarantined":
            assert len(row.get("quarantineReason", "")) >= 20
    # A promoted exam can still be quarantined: the axes are independent.
    assert any(r["status"] == "promoted" and r["benchmarkStatus"] == "quarantined" for r in rows)
    assert any(r["heldOut"] for r in rows)
    await client.aclose()


@run_async
async def test_exam_list_filters_on_each_axis_independently():
    client = MockRpcClient(MockEngine(speed=0.0))
    drafts = await client.call("examList", {"filters": {"status": "draft"}})
    assert drafts and all(row["status"] == "draft" for row in drafts)
    quarantined = await client.call("examList", {"filters": {"benchmarkStatus": "quarantined"}})
    assert quarantined and all(row["benchmarkStatus"] == "quarantined" for row in quarantined)
    await client.aclose()


@run_async
async def test_quarantine_requires_a_reason_of_at_least_twenty_characters():
    client = MockRpcClient(MockEngine(speed=0.0))
    with pytest.raises(RpcError) as caught:
        await client.call(
            "examUpdate",
            {"examId": "exam-0058", "patch": {"benchmarkStatus": "quarantined", "quarantineReason": "too short"}},
        )
    assert caught.value.code == ERR_INVALID_PARAMS
    assert "20 characters" in caught.value.hint
    updated = await client.call(
        "examUpdate",
        {
            "examId": "exam-0058",
            "patch": {
                "benchmarkStatus": "quarantined",
                "quarantineReason": "cap death left no result row for this exam",
            },
        },
    )
    assert updated["benchmarkStatus"] == "quarantined"
    assert updated["status"] == "promoted", "quarantine must not touch the authoring axis"
    await client.aclose()


@run_async
async def test_releasing_quarantine_drops_the_reason():
    client = MockRpcClient(MockEngine(speed=0.0))
    released = await client.call("examUpdate", {"examId": "exam-0061", "patch": {"benchmarkStatus": "active"}})
    assert released["benchmarkStatus"] == "active"
    assert "quarantineReason" not in released
    await client.aclose()


@run_async
async def test_veto_requires_a_written_reason():
    client = MockRpcClient(MockEngine(speed=0.0))
    with pytest.raises(RpcError) as caught:
        await client.call("examVeto", {"examId": "exam-0074", "reason": "too short"})
    assert "at least 20 characters" in caught.value.hint
    vetoed = await client.call("examVeto", {"examId": "exam-0074", "reason": "the statement cannot be written without leaking the fix"})
    assert vetoed["status"] == "vetoed"
    assert vetoed["vetoReason"].startswith("the statement cannot")
    await client.aclose()


# Lifecycle -----------------------------------------------------------------


@run_async
async def test_repo_attach_and_detach_change_the_served_list():
    client = MockRpcClient(MockEngine(speed=0.0))
    before = len((await client.call("serveStatus", {}))["repos"])
    attached = await client.call("repoAttach", {"repoPath": "/Users/owner/code/newthing"})
    assert attached["repo"]["path"] == "/Users/owner/code/newthing"
    assert len((await client.call("serveStatus", {}))["repos"]) == before + 1
    await client.call("repoDetach", {"repoPath": "/Users/owner/code/newthing"})
    assert len((await client.call("serveStatus", {}))["repos"]) == before
    with pytest.raises(RpcError):
        await client.call("repoDetach", {"repoPath": "/nope"})
    await client.aclose()


@run_async
async def test_job_cancel_stops_the_stream_early():
    client = MockRpcClient(MockEngine(speed=0.01))
    seen: list[dict] = []
    client.on_event(seen.append)
    job = await client.call("initBrain", {"repoPath": DEFAULT_REPO, "mode": "layer1"})
    await asyncio.sleep(0.02)
    result = await client.call("jobCancel", {"jobId": job["jobId"]})
    assert result["cancelled"] is True
    for _ in range(40):
        await asyncio.sleep(0.01)
        if seen and seen[-1].get("step") == "cancelled":
            break
    assert seen[-1]["phase"] == "done"
    assert seen[-1]["step"] == "cancelled"
    assert len(seen) < len(mock_data.init_script("j", DEFAULT_REPO, "layer1"))
    await client.aclose()


@run_async
async def test_job_cancel_on_a_finished_job_reports_false():
    client = MockRpcClient(MockEngine(speed=0.0))
    assert (await client.call("jobCancel", {"jobId": "job-init-9999"}))["cancelled"] is False
    await client.aclose()


# Gates ---------------------------------------------------------------------


@run_async
async def test_gates_carry_a_classification_and_liveness_evidence():
    client = MockRpcClient(MockEngine(speed=0.0))
    record = await client.call("gatesGet", {"repoPath": DEFAULT_REPO})
    gates = record["discovered"]["gates"]
    classifications = {gate["classification"] for gate in gates}
    assert {"live", "measured", "pre-broken", "unavailable"} <= classifications
    for gate in gates:
        # The evidence is the measurement itself, not a sentence about it, so
        # the fields the screen reads have to be the ones that are present.
        baseline = gate["baseline"]
        assert baseline["status"], f"{gate['id']} has no baseline status"
        assert baseline["timeoutMs"], f"{gate['id']} has no timeout budget to report"
        assert "durationMs" in baseline and "exitCode" in baseline
    dead = [g for g in gates if g["classification"] in ("pre-broken", "unavailable")]
    assert dead and all(not g["enabled"] for g in dead), "a dead gate must not stay enabled"
    await client.aclose()


@run_async
async def test_the_mock_produces_all_three_gate_discovery_states():
    """A mock that only ever emits well formed output lets a branch rot.

    The empty-because-nothing-is-there case and the empty-because-it-would-not-
    parse case look identical in a gate list and are opposite facts, so both
    have to be reachable, along with the ordinary one.
    """
    client = MockRpcClient(MockEngine(speed=0.0))
    states = {}
    for repo in ("orchard-web", "kiln-api", "lantern-ios"):
        record = await client.call("gatesGet", {"repoPath": f"/Users/owner/code/{repo}"})
        assert "content" in record, "content is always present, including when parsing failed"
        discovered = record["discovered"]
        if discovered is None:
            assert record["parseError"], "an unreadable file must say why"
            states["unparsed"] = repo
        elif not discovered["gates"]:
            assert discovered["summary"]["total"] == 0
            assert record["parseError"] is None
            states["empty"] = repo
        else:
            states["populated"] = repo
    assert set(states) == {"populated", "empty", "unparsed"}, f"a state is unreachable: {states}"
    await client.aclose()




@run_async
async def test_gates_set_replaces_the_document_and_refuses_to_merge_into_it():
    """Checked against the daemon on 2026-08-17.

    A structural patch is refused with -32602 in every file state, and the
    accepted form is patch.content carrying the whole document. The mock had
    this backwards in both directions, which would have made three buttons work
    in the TUI and fail against the engine.
    """
    client = MockRpcClient(MockEngine(speed=0.0))
    with pytest.raises(RpcError) as caught:
        await client.call(
            "gatesSet",
            {"repoPath": DEFAULT_REPO, "patch": {"gates": [{"id": "react-doctor", "enabled": True}]}},
        )
    assert caught.value.code == ERR_INVALID_PARAMS
    updated = await client.call(
        "gatesSet",
        {"repoPath": DEFAULT_REPO, "patch": {"content": "version: 1\ngates:\n  - id: only\n    command: make check\n"}},
    )
    assert [g["id"] for g in updated["discovered"]["gates"]] == ["only"]
    assert updated["content"].endswith("make check\n"), "the document is not stored byte for byte"
    await client.aclose()


@run_async
async def test_an_edited_row_carries_no_classification_it_did_not_earn():
    """Rows come back AS WRITTEN. Discovery writes the classification, not the editor."""
    client = MockRpcClient(MockEngine(speed=0.0))
    updated = await client.call(
        "gatesSet",
        {"repoPath": DEFAULT_REPO, "patch": {"content": "version: 1\ngates:\n  - id: only\n    command: make check\n"}},
    )
    row = updated["discovered"]["gates"][0]
    for earned in ("classification", "baseline", "enabled"):
        assert earned not in row, f"the mock invented {earned} for a row the user just typed"
    assert updated["discovered"]["summary"] is None, (
        "a summary here would be a tally of a baseline nobody ran"
    )
    await client.aclose()


@run_async
async def test_a_broken_gates_file_can_still_be_written_over():
    """The repair path. Refusing the write locks the user out of the fix.

    An earlier version of this mock refused exactly this call as a safety, and
    the daemon accepts it: gatesSet is the only way back from a file the user
    broke.
    """
    client = MockRpcClient(MockEngine(speed=0.0))
    broken = await client.call("gatesGet", {"repoPath": "/Users/owner/code/lantern-ios"})
    assert broken["discovered"] is None, "this repo is meant to start unreadable"
    repaired = await client.call(
        "gatesSet",
        {
            "repoPath": "/Users/owner/code/lantern-ios",
            "patch": {"content": "version: 1\ngates:\n  - id: swiftlint\n    command: swiftlint\n"},
        },
    )
    assert repaired["parseError"] is None and repaired["discovered"] is not None
    assert [g["id"] for g in repaired["discovered"]["gates"]] == ["swiftlint"]
    await client.aclose()


@run_async
async def test_no_gate_carries_a_status_or_classification_outside_the_contract():
    """Values are a contract too, and this mock shipped an invented one.

    baseline.status was "violations", which is not on the wire: a tool with
    pre-existing violations is a MEASURED gate, and measured is a
    classification rather than a status.
    """
    client = MockRpcClient(MockEngine(speed=0.0))
    seen_status, seen_class = set(), set()
    for repo in ("orchard-web", "kiln-api", "lantern-ios"):
        record = await client.call("gatesGet", {"repoPath": f"/Users/owner/code/{repo}"})
        for gate in ((record["discovered"] or {}).get("gates") or []):
            seen_class.add(gate["classification"])
            seen_status.add(gate["baseline"]["status"])
    # SUBSET catches an invented value. It does NOT catch a documented value
    # that no path produces, and a check that only ever asserted the subset
    # reads like coverage of the vocabulary while covering half of it. That is
    # how `timeout` stayed documented, named in BASELINE_STATUS, printed in
    # this test's own coverage every run, and reachable from nothing.
    documented_status = set(mock_data.BASELINE_STATUS)
    documented_class = set(mock_data.GATE_CLASSIFICATION)
    assert seen_status <= documented_status, f"invented statuses: {seen_status - documented_status}"
    assert seen_class <= documented_class, f"invented classifications: {seen_class - documented_class}"
    # REACHABILITY, the other half. Documented and reachable are different
    # claims and this test now makes both.
    #
    # BOUND: both sides of this comparison are mine. mock_data's tuples are
    # hand-copied from the contract, so equality here proves the mock agrees
    # with THIS REPO and not that either agrees with the engine. It cannot
    # catch a value the engine stopped producing, and it cannot catch a
    # phantom the contract names that the engine can never send, because a
    # phantom would sit in the tuple AND in the mock and both halves would
    # pass. That second direction is the worse one: a missing value makes a
    # client guess and the guess eventually shows, while a phantom reads as a
    # real state, gets a branch written for it, and that branch is dead code
    # no use can ever disprove. Nothing on this side closes it; the engine
    # harvests its vocabulary from its own source instead.
    assert seen_status == documented_status, (
        f"documented but produced by nothing, so their rendering is untested: "
        f"{sorted(documented_status - seen_status)}"
    )
    assert seen_class == documented_class, (
        f"documented but produced by nothing: {sorted(documented_class - seen_class)}"
    )
    await client.aclose()


@run_async
async def test_gates_discover_streams_on_the_step_channel():
    client = MockRpcClient(MockEngine(speed=0.0))
    seen: list[dict] = []
    client.on_event(seen.append)
    job = await client.call("gatesDiscover", {"repoPath": DEFAULT_REPO})
    for _ in range(5):
        await asyncio.sleep(0)
    assert seen and all(event["jobId"] == job["jobId"] for event in seen)
    assert {"probe", "baseline", "classify", "done"} <= {event["phase"] for event in seen}
    await client.aclose()


# Agent instruction files ---------------------------------------------------


@run_async
async def test_agent_file_round_trip_updates_the_modified_badge():
    client = MockRpcClient(MockEngine(speed=0.0))
    before = await client.call("agentFileGet", {"role": "student"})
    assert before["modified"] is False
    after = await client.call("agentFileSet", {"role": "student", "content": before["content"] + "\nextra line\n"})
    assert after["modified"] is True
    assert after["currentHash"] != after["defaultHash"]
    with pytest.raises(RpcError):
        await client.call("agentFileGet", {"role": "engineer"})
    await client.aclose()


# Streams -------------------------------------------------------------------


@run_async
async def test_init_stream_events_match_the_contract_shape():
    client = MockRpcClient(MockEngine(speed=0.0))
    seen: list[dict] = []
    client.on_event(seen.append)
    result = await client.call("initBrain", {"repoPath": "/Users/owner/code/kiln-api", "mode": "layer1"})
    for _ in range(5):
        await asyncio.sleep(0)
    assert seen
    for event in seen:
        assert set(event) <= {"ts", "jobId", "phase", "step", "detail", "counts", "level"}
        assert {"ts", "jobId", "phase", "step", "detail", "level"} <= set(event)
        assert event["jobId"] == result["jobId"]
    phases = [event["phase"] for event in seen]
    expected = [key for key, _ in mock_data.INIT_PHASES]
    assert [phase for phase in expected if phase in phases] == expected
    assert phases[-1] == "done"
    await client.aclose()


@run_async
async def test_board_findings_ride_their_own_channel_and_are_not_job_scoped():
    client = MockRpcClient(MockEngine(speed=0.0))
    steps: list[dict] = []
    findings: list[dict] = []
    client.on_event(steps.append)
    client.on_board_finding(findings.append)
    client.engine.start_board_findings()
    for _ in range(5):
        await asyncio.sleep(0)
    assert findings, "no boardFinding notifications arrived"
    assert not steps, "board findings must not leak onto the step channel"
    for finding in findings:
        assert set(finding) >= {"ts", "source", "severity", "category", "target", "evidence", "status"}
        assert "jobId" not in finding
    assert any(f["severity"] == "critical" for f in findings)
    await client.aclose()


@run_async
async def test_pushed_findings_also_land_in_the_board_table():
    client = MockRpcClient(MockEngine(speed=0.0))
    before = (await client.call("board", {}))["total"]
    client.engine.start_board_findings()
    for _ in range(5):
        await asyncio.sleep(0)
    after = await client.call("board", {})
    assert after["total"] == before + len(mock_data.BOARD_FINDING_PUSHES)
    await client.aclose()


@run_async
async def test_gym_start_streams_when_the_gate_is_open():
    client = MockRpcClient(MockEngine(speed=0.0, gate_open=True))
    seen: list[dict] = []
    client.on_event(seen.append)
    result = await client.call("gymStart", {"repoPath": DEFAULT_REPO, "config": {}, "confirm": True})
    for _ in range(5):
        await asyncio.sleep(0)
    assert result["jobId"].startswith("job-gym-")
    assert {"draw", "rounds", "submit", "audit", "done"} <= {event["phase"] for event in seen}
    await client.aclose()


@run_async
async def test_search_respects_the_token_budget_and_keeps_standing_units():
    client = MockRpcClient(MockEngine(speed=0.0))
    result = await client.call(
        "search",
        {"repoPath": DEFAULT_REPO, "query": "retry backoff upload queue", "options": {"tokenBudget": 900}},
    )
    assert result["tokensUsed"] <= 900
    assert [chunk for chunk in result["chunks"] if chunk["standing"]]
    await client.aclose()


@run_async
async def test_unknown_method_is_refused_with_a_hint():
    client = MockRpcClient(MockEngine(speed=0.0))
    with pytest.raises(RpcError) as caught:
        await client.call("brainDump", {})
    assert caught.value.code == ERR_METHOD_NOT_FOUND
    assert "methods.md" in caught.value.hint
    await client.aclose()


@run_async
async def test_board_filters_narrow_the_rows():
    client = MockRpcClient(MockEngine(speed=0.0))
    everything = await client.call("board", {})
    critical = await client.call("board", {"filters": {"severity": "critical"}})
    assert len(critical["rows"]) < len(everything["rows"])
    assert all(row["severity"] == "critical" for row in critical["rows"])
    await client.aclose()


@run_async
async def test_stdio_client_talks_to_the_mock_engine_over_a_real_pipe():
    """The mock speaks the wire protocol, not just the in process shortcut."""
    client = StdioRpcClient([sys.executable, "-m", "daijin_tui.rpc", "--speed", "0"])
    seen: list[dict] = []
    client.on_event(seen.append)
    await client.start()
    try:
        hello = await asyncio.wait_for(client.handshake(), timeout=20)
        assert hello["contractVersion"] == SUPPORTED_CONTRACT_VERSION
        status = await asyncio.wait_for(client.call("serveStatus", {}), timeout=20)
        assert len(status["repos"]) == len(mock_data.REPOS)
        assert status["spendGate"]["open"] is False
        with pytest.raises(RpcError):
            await asyncio.wait_for(client.call("examDetail", {"examId": "nope"}), timeout=20)
        job = await asyncio.wait_for(
            client.call("initBrain", {"repoPath": "/Users/owner/code/kiln-api", "mode": "layer1"}), timeout=20
        )
        deadline = asyncio.get_running_loop().time() + 25
        while asyncio.get_running_loop().time() < deadline:
            if seen and seen[-1]["phase"] == "done":
                break
            await asyncio.sleep(0.05)
        assert seen and seen[-1]["phase"] == "done"
        assert all(event["jobId"] == job["jobId"] for event in seen)
    finally:
        await client.aclose()


@run_async
async def test_a_deferred_method_is_not_implemented_not_unknown():
    """The real daemon answers -32001 with the phase that ships the capability.

    -32601 must stay reserved for "not in the contract at all", which on a
    frozen surface should never happen and is worth surfacing loudly.
    """
    client = MockRpcClient(MockEngine(speed=0.0, deferred={"gymStatus": "P4 (gym port)"}))
    with pytest.raises(RpcError) as caught:
        await client.call("gymStatus", {})
    error = caught.value
    assert error.code == ERR_NOT_IMPLEMENTED
    assert error.is_not_implemented is True
    assert error.is_spend_gate is False
    assert error.phase == "P4 (gym port)"
    assert "frozen RPC surface" in error.hint
    # A method genuinely absent from the contract is a different, louder thing.
    with pytest.raises(RpcError) as absent:
        await client.call("brainDump", {})
    assert absent.value.code == ERR_METHOD_NOT_FOUND
    assert absent.value.is_not_implemented is False
    await client.aclose()


def test_not_implemented_and_method_not_found_are_different_codes():
    assert ERR_NOT_IMPLEMENTED != ERR_METHOD_NOT_FOUND
    assert ERR_NOT_IMPLEMENTED != ERR_SPEND_GATE


def test_event_method_name_is_the_one_the_client_listens_for():
    assert EVENT_METHOD == "step"


# Startup failures must carry the engine's own words ------------------------


FAKE_REFUSING_ENGINE = r"""
import sys
sys.stderr.write(
    "daijin engine: another daemon already holds this state root.\n"
    "  holding pid : 4242\n"
    "  lock path   : /tmp/daijin/daemon.lock\n"
    "Stop that daemon or pass a different --state-root.\n"
)
sys.stderr.flush()
sys.exit(1)
"""


@run_async
async def test_a_refusing_engine_surfaces_its_own_message(tmp_path):
    """stderr=DEVNULL turned a diagnosable refusal into a bare ConnectionError.

    The daemon writes one careful sentence naming the holding PID and the lock
    path. Discarding it leaves the user with "engine closed its stdout", which
    names neither. The contract's convention is that engine text written for
    the user is displayed verbatim, and that has to survive a startup failure.
    """
    script = tmp_path / "refusing_engine.py"
    script.write_text(FAKE_REFUSING_ENGINE)
    client = StdioRpcClient([sys.executable, str(script)])
    try:
        await client.start()
        with pytest.raises(ConnectionError) as caught:
            await asyncio.wait_for(client.handshake(), timeout=20)
        message = str(caught.value)
        assert "holding pid : 4242" in message
        assert "/tmp/daijin/daemon.lock" in message
        assert "different --state-root" in message
        assert "The engine said:" in message
    finally:
        await client.aclose()


@run_async
async def test_a_silent_engine_still_reports_a_usable_failure(tmp_path):
    """No stderr means no quoted text, but still not a mystery."""
    script = tmp_path / "silent_engine.py"
    script.write_text("import sys\nsys.exit(1)\n")
    client = StdioRpcClient([sys.executable, str(script)])
    try:
        await client.start()
        with pytest.raises(ConnectionError) as caught:
            await asyncio.wait_for(client.handshake(), timeout=20)
        message = str(caught.value)
        assert "exited without answering" in message
        assert "The engine said:" not in message
    finally:
        await client.aclose()


@run_async
async def test_stderr_tail_is_bounded(tmp_path):
    """A chatty engine must not turn one error into a wall of text."""
    script = tmp_path / "chatty_engine.py"
    script.write_text(
        "import sys\n"
        "for i in range(500):\n"
        "    sys.stderr.write(f'noise line {i}\\n')\n"
        "sys.stderr.flush()\n"
        "sys.exit(1)\n"
    )
    client = StdioRpcClient([sys.executable, str(script)])
    try:
        await client.start()
        with pytest.raises(ConnectionError) as caught:
            await asyncio.wait_for(client.handshake(), timeout=20)
        quoted = str(caught.value).split("The engine said:\n", 1)[1]
        assert len(quoted.splitlines()) == STDERR_TAIL_LINES
        # The TAIL, because the refusal is the last thing written before exit.
        assert "noise line 499" in quoted
    finally:
        await client.aclose()


# The budget echo is the client's obligation, not a mock-side refusal --------


@run_async
async def test_the_engine_accepts_and_records_a_bare_confirm():
    """Mock fidelity: refusing here would invent a refusal that never comes."""
    client = MockRpcClient(MockEngine(speed=0.0))
    result = await client.call(
        "initBrain", {"repoPath": DEFAULT_REPO, "mode": "layer1+layer2", "confirm": True}
    )
    assert result["jobId"].startswith("job-init-")
    assert client.engine.recorded_budgets == [(DEFAULT_REPO, None)]
    await client.aclose()


@run_async
async def test_a_confirmed_call_records_the_echo_it_was_given():
    client = MockRpcClient(MockEngine(speed=0.0))
    estimate = await client.call("budgetEstimate", {"repoPath": DEFAULT_REPO, "mode": "layer1+layer2"})
    await client.call(
        "initBrain",
        {"repoPath": DEFAULT_REPO, "mode": "layer1+layer2", "confirm": True, "budget": estimate},
    )
    repo, echoed = client.engine.recorded_budgets[-1]
    assert repo == DEFAULT_REPO
    assert echoed["estimatedTokens"] == estimate["estimatedTokens"]
    await client.aclose()


# The engine's own sentences, read off the daemon on 2026-08-17 with
# /tmp/probe_five.py, not copied from a description of them. Five methods share
# one callsite engine side (withLedger, 4baeab6) and therefore one sentence;
# the brain family has one sentence EACH.
LEDGER_METHODS = ("examList", "examDetail", "examVeto", "examUpdate", "gymStatus")
LEDGER_HINT = (
    "{path} has no gym ledger yet, so there are no exams or cycles to read. "
    "Run init on {path} first; it creates the ledger."
)
BRAIN_HINTS = {
    "search": "{path} has no indexed brain yet, so there is nothing to search. Initialize the brain first.",
    "retrievalScore": "{path} has no indexed brain yet, so there is no floor to measure.",
    "diagnose": "{path} has no indexed brain yet, so there is nothing to diagnose.",
}
BRAINLESS = "/Users/owner/code/kiln-api"
LEDGER_PARAMS = {
    "examList": {},
    "examDetail": {"examId": "exam-0058"},
    "examVeto": {"examId": "exam-0058", "reason": "a reason long enough to clear the floor"},
    "examUpdate": {"examId": "exam-0058", "patch": {"tier": 2}},
    "gymStatus": {},
}


@run_async
async def test_an_uninitialized_repo_refuses_in_the_engines_own_words():
    """The code matters as much as the text: hints render verbatim, codes route.

    A mock with the right sentence and the wrong code looks correct on screen
    and routes wrongly, so both are pinned.
    """
    client = MockRpcClient(MockEngine(speed=0.0))
    for method in LEDGER_METHODS:
        with pytest.raises(RpcError) as caught:
            await client.call(method, {"repoPath": BRAINLESS, **LEDGER_PARAMS[method]})
        assert caught.value.code == ERR_INVALID_PARAMS, f"{method} refused with the wrong code"
        assert caught.value.hint == LEDGER_HINT.format(path=BRAINLESS), (
            f"{method} does not speak the engine's sentence: {caught.value.hint!r}"
        )
    for method, sentence in BRAIN_HINTS.items():
        params = {"repoPath": BRAINLESS}
        if method == "search":
            params["query"] = "retry"
        with pytest.raises(RpcError) as caught:
            await client.call(method, params)
        assert caught.value.code == ERR_INVALID_PARAMS
        assert caught.value.hint == sentence.format(path=BRAINLESS), (
            f"{method} invented its own wording: {caught.value.hint!r}"
        )
    await client.aclose()


@run_async
async def test_the_friendly_ledger_refusal_is_narrow_on_purpose():
    """Only the not-yet-initialised case is translated.

    A ledger that EXISTS and cannot be opened stays an internal error engine
    side, because dressing a corrupt database as "run init" sends a user to
    rebuild a repo whose real problem is a damaged file. Mocking that case with
    this sentence would be the permissive double inverted: it would teach the
    screen that all ledger trouble is a missing brain, and the one case needing
    different advice is the one it would get wrong.

    So the corrupt-ledger state is deliberately UNMOCKED, and this test guards
    the boundary the mock CAN express: an initialised repo never hears it.
    """
    client = MockRpcClient(MockEngine(speed=0.0))
    initialised = [r["path"] for r in mock_data.REPOS if r["health"] != "no-brain"]
    assert initialised, "no initialised repo, so this check would be vacuous"
    for repo in initialised:
        for method in LEDGER_METHODS:
            try:
                await client.call(method, {"repoPath": repo, **LEDGER_PARAMS[method]})
            except RpcError as error:
                assert "no gym ledger yet" not in error.hint, (
                    f"{method} told an initialised repo ({repo}) to run init: {error.hint!r}"
                )
    await client.aclose()


@run_async
async def test_gym_start_refuses_for_spend_before_it_ever_reaches_the_ledger():
    """A coincidence rather than a design, and worth pinning as one.

    gymStart's gate file lives inside the same .daijin/ whose absence causes
    the ledger error, so it refuses for spend first and never gets there. A
    mock that scripted the ledger refusal here would be wrong about the order.
    """
    client = MockRpcClient(MockEngine(speed=0.0))
    with pytest.raises(RpcError) as caught:
        await client.call("gymStart", {"repoPath": BRAINLESS, "examId": "exam-0058", "confirm": True})
    assert caught.value.code == ERR_SPEND_GATE, (
        f"the spend refusal did not come first: {caught.value.code}"
    )
    assert "no gym ledger yet" not in caught.value.hint
    await client.aclose()


# One raising subscriber must not be able to stop the others or the read loop.
# The loop is how the whole app talks to the engine, so an exception escaping
# it leaves every screen on its last frame with nothing to say why.


class _Pipe(asyncio.StreamReader):
    """A StreamReader preloaded with whole lines, then EOF."""

    def __init__(self, lines: list[str]) -> None:
        super().__init__()
        for line in lines:
            self.feed_data((line + "\n").encode())
        self.feed_eof()


@run_async
async def test_one_raising_handler_stops_neither_its_siblings_nor_the_loop():
    seen_before: list[dict] = []
    seen_after: list[dict] = []

    def raises(event):
        raise ValueError("a subscriber with a bug in it")

    client = StdioRpcClient(["true"])
    client.on_event(lambda e: seen_before.append(e))
    client.on_event(raises)
    client.on_event(lambda e: seen_after.append(e))

    # Two notifications, then a RESPONSE: the response is the proof the loop
    # was still reading after the handler blew up, not merely that _pump
    # returned. A dead loop leaves this future pending forever.
    pending = asyncio.get_running_loop().create_future()
    client._pending[1] = pending
    await client._pump(_Pipe([
        '{"jsonrpc":"2.0","method":"step","params":{"phase":"ingest"}}',
        '{"jsonrpc":"2.0","method":"step","params":{"phase":"done"}}',
        '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
    ]))

    # (a) The siblings ran, both of them, for BOTH events. A guard that only
    # protected the loop would still let one bad handler eat the ones after it.
    assert len(seen_before) == 2, seen_before
    assert len(seen_after) == 2, seen_after
    # (b) The loop survived and went on delivering.
    assert pending.done() and pending.result() == {"ok": True}

    # NOT SWALLOWED: the failure is kept, and it names the handler.
    failures = client.handler_failures
    assert len(failures) == 2, failures
    assert "raises" in failures[0], failures[0]
    assert "ValueError" in failures[0] and "a subscriber with a bug in it" in failures[0]


@run_async
async def test_a_raising_board_finding_handler_is_guarded_too():
    """boardFinding is the other fan-out and had the identical hole."""
    seen: list[dict] = []
    client = StdioRpcClient(["true"])
    client.on_board_finding(lambda f: (_ for _ in ()).throw(RuntimeError("boom")))
    client.on_board_finding(lambda f: seen.append(f))

    await client._pump(_Pipe([
        '{"jsonrpc":"2.0","method":"boardFinding","params":{"severity":"critical"}}',
    ]))

    assert seen == [{"severity": "critical"}]
    assert any("boardFinding handler" in line for line in client.handler_failures)


@run_async
async def test_the_handler_failure_tail_is_bounded_and_stderr_is_not_spammed(capsys):
    """A broken handler fails once per event, and a stream is hundreds.

    An unbounded tail is a leak and an unguarded print into a terminal a TUI
    is drawing in trades a visible crash for an unusable screen, so the tail
    is capped and each distinct failure reaches stderr exactly once.
    """
    from daijin_tui.rpc import HANDLER_FAILURE_TAIL_LINES

    client = StdioRpcClient(["true"])
    client.on_event(lambda e: (_ for _ in ()).throw(ValueError("same every time")))
    for _ in range(HANDLER_FAILURE_TAIL_LINES + 25):
        client.dispatch_event({"phase": "ingest"})

    assert len(client.handler_failures) == HANDLER_FAILURE_TAIL_LINES
    reported = capsys.readouterr().err
    # Count REPORTS, not occurrences of the message: one report also quotes
    # the failing source line in its traceback, so counting the message text
    # would have counted the same report four times and passed by accident.
    assert reported.count("step handler ") == 1, (
        f"one broken handler on a busy stream must not spam the terminal: {reported!r}"
    )
    assert "ValueError: same every time" in reported, "the one report must carry the cause"
