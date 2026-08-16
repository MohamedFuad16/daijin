"""One test per screen, driven through the app against the mock engine.

Navigation is exercised both ways on purpose: number keys for the keyboard
path, pilot.click for the mouse path.
"""

from __future__ import annotations

import pytest
from conftest import DEFAULT_REPO, SUB_75_REPO, goto, run_async, running_app, screen_text, scroll_to, settle

from textual.widgets import Button, DataTable, Input, Select, Static, TabbedContent

from daijin_tui.rpc import SUPPORTED_CONTRACT_VERSION
from daijin_tui.screens.dialogs import AgentFileEditScreen, SpendConfirmScreen, TextPromptScreen
from daijin_tui.widgets import (
    Banner,
    EventLog,
    PhaseChecklist,
    PlotextBar,
    RadarChart,
    RepoCard,
    Sparkline,
)

MODES = ["home", "init", "brain", "gates", "gym", "exams", "board", "settings"]
MODE_KEYS = list("12345678")


def text_of(widget) -> str:
    return str(widget.render())


# Spend discipline, checked at the screen layer -----------------------------


@pytest.mark.parametrize("key", MODE_KEYS)
@run_async
async def test_opening_a_screen_never_spends(key):
    """No screen may reach a spend-touching method just by being opened."""
    async with running_app(gate_open=True) as (app, pilot):
        await goto(pilot, key)
        await settle(pilot)
        assert app.client.engine.spend_calls == [], (
            f"mode {app.current_mode} called {app.client.engine.spend_calls} on mount"
        )


@run_async
async def test_reloading_a_screen_never_spends():
    async with running_app(gate_open=True) as (app, pilot):
        for key in MODE_KEYS:
            await goto(pilot, key)
            await pilot.press("ctrl+r")
            await settle(pilot)
        assert app.client.engine.spend_calls == []


# 1. Repo home ------------------------------------------------------------


@run_async
async def test_repo_home_shows_a_card_per_repo_with_one_primary_action():
    async with running_app() as (app, pilot):
        cards = list(app.screen.query(RepoCard))
        assert len(cards) == 3
        without_brain = [card for card in cards if card.needs_brain]
        assert len(without_brain) == 1
        assert without_brain[0].repo_path.endswith("kiln-api")
        assert str(without_brain[0].query_one(".card-action", Button).label) == "Initialize brain"
        assert "sqlite-vec" in text_of(app.screen.query_one("#engine-status", Static))
        assert "kiln-api" in text_of(app.screen.query_one("#home-notice", Banner))


@run_async
async def test_repo_home_shows_the_spend_gate_before_anything_is_attempted():
    async with running_app(gate_open=False) as (app, pilot):
        status = text_of(app.screen.query_one("#engine-status", Static))
        assert "spend gate" in status and "blocked" in status
        assert app.client.engine.spend_calls == []


@run_async
async def test_repo_card_shows_the_case_count_and_not_a_bare_percentage():
    async with running_app() as (app, pilot):
        card = next(c for c in app.screen.query(RepoCard) if c.repo_path.endswith("orchard-web"))
        floor = text_of(card.query_one(".card-floor", Static))
        assert "31 of 34" in floor
        assert "%" not in floor


@run_async
async def test_repo_card_sparkline_is_the_score_history_trend_not_the_budget_sweep():
    """The two series are different things and never share a caption."""
    async with running_app() as (app, pilot):
        card = next(c for c in app.screen.query(RepoCard) if c.repo_path.endswith("orchard-web"))
        # scoreHistory arrives newest first; the trend reads oldest to newest.
        assert card.history == pytest.approx([21 / 31, 24 / 33, 27 / 34, 30 / 34, 31 / 34])
        caption = text_of(card.query_one(Sparkline))
        assert "floor over time" in caption
        assert "budget" not in caption
        assert "sweep" not in caption
        assert any(call[0] == "scoreHistory" for call in app.client.engine.calls)


@run_async
async def test_the_budget_sweep_lives_on_the_brain_view_with_its_own_caption():
    async with running_app() as (app, pilot):
        await goto(pilot, "3")
        rendered = screen_text(app)
        assert "one measurement across budgets" in rendered
        assert "not a trend over time" in rendered


@run_async
async def test_attaching_and_detaching_a_repo_changes_the_cards():
    async with running_app() as (app, pilot):
        before = len(list(app.screen.query(RepoCard)))
        app.screen.query_one("#attach-input", Input).value = "/Users/owner/code/newthing"
        await pilot.click("#attach-go")
        await settle(pilot)
        assert len(list(app.screen.query(RepoCard))) == before + 1
        card = next(c for c in app.screen.query(RepoCard) if c.repo_path.endswith("newthing"))
        await pilot.click(card.query_one(".card-detach", Button))
        await settle(pilot)
        assert len(list(app.screen.query(RepoCard))) == before
        assert "Detached" in text_of(app.screen.query_one("#home-notice", Banner))


@run_async
async def test_clicking_initialize_brain_opens_the_init_screen():
    async with running_app() as (app, pilot):
        card = next(c for c in app.screen.query(RepoCard) if c.needs_brain)
        await pilot.click(card.query_one(".card-action", Button))
        await settle(pilot)
        assert app.current_mode == "init"
        assert app.selected_repo.endswith("kiln-api")


# 2. Init activity feed ---------------------------------------------------


@run_async
async def test_init_feed_runs_every_phase_from_the_step_event_stream():
    async with running_app() as (app, pilot):
        await goto(pilot, "2")
        await pilot.click("#init-start")
        await settle(pilot, 14)
        checklist = app.screen.query_one("#init-checklist", PhaseChecklist)
        log = app.screen.query_one("#init-events", EventLog)
        assert checklist.job_id and checklist.job_id.startswith("job-init-")
        assert log.event_count > 20
        assert set(entry["status"] for entry in checklist.state.values()) <= {"done", "warn"}
        assert checklist.finished_at is not None
        assert "31 of 34" in checklist.state["retrieval-floor"]["detail"]
        assert app.client.engine.spend_calls == [], "layer1 must never spend"


@run_async
async def test_layer2_opens_a_budget_dialog_and_cancelling_spends_nothing():
    async with running_app() as (app, pilot):
        await goto(pilot, "2")
        app.screen.query_one("#init-mode", Select).value = "layer1+layer2"
        await pilot.click("#init-start")
        await settle(pilot)
        assert isinstance(app.screen, SpendConfirmScreen)
        rendered = screen_text(app)
        assert "This call spends money" in rendered
        assert "estimated tokens" in rendered
        assert "basis" in rendered
        assert "narration calls" in rendered, "the dialog shows where the number came from"
        assert any(call[0] == "budgetEstimate" for call in app.client.engine.calls)
        await pilot.click("#spend-cancel")
        await settle(pilot)
        assert app.client.engine.spend_calls == []
        assert app.screen.job_id is None
        assert "Nothing was sent to a provider" in text_of(app.screen.query_one("#init-notice", Banner))


@run_async
async def test_layer2_runs_once_the_budget_is_confirmed():
    async with running_app() as (app, pilot):
        await goto(pilot, "2")
        app.screen.query_one("#init-mode", Select).value = "layer1+layer2"
        await pilot.click("#init-start")
        await settle(pilot)
        await pilot.click("#spend-confirm")
        await settle(pilot, 14)
        assert [call[0] for call in app.client.engine.spend_calls] == ["initBrain"]
        assert app.client.engine.spend_calls[0][1]["confirm"] is True
        assert app.screen.job_id.startswith("job-init-")


@run_async
async def test_escape_on_the_spend_dialog_declines():
    async with running_app() as (app, pilot):
        await goto(pilot, "2")
        app.screen.query_one("#init-mode", Select).value = "layer1+layer2"
        await pilot.click("#init-start")
        await settle(pilot)
        await pilot.press("escape")
        await settle(pilot)
        assert app.client.engine.spend_calls == []


@run_async
async def test_init_scope_is_sent_when_the_user_names_areas():
    async with running_app() as (app, pilot):
        await goto(pilot, "2")
        app.screen.query_one("#init-scope", Input).value = "src/lib, src/styles"
        await pilot.click("#init-start")
        await settle(pilot)
        call = next(c for c in app.client.engine.calls if c[0] == "initBrain")
        assert call[1]["scope"] == {"areas": ["src/lib", "src/styles"]}


@run_async
async def test_init_job_can_be_cancelled():
    async with running_app() as (app, pilot):
        await goto(pilot, "2")
        await pilot.click("#init-start")
        await settle(pilot, 14)
        await pilot.click("#init-cancel")
        await settle(pilot)
        assert any(call[0] == "jobCancel" for call in app.client.engine.calls)


@run_async
async def test_init_feed_refuses_to_start_without_a_repo():
    async with running_app(repo=None) as (app, pilot):
        await goto(pilot, "2")
        await pilot.click("#init-start")
        await settle(pilot)
        assert app.screen.job_id is None
        assert "No repo selected" in text_of(app.screen.query_one("#init-notice", Banner))


# 3. Brain browser, tester, diagnosis --------------------------------------


@run_async
async def test_brain_reports_the_floor_as_a_count_with_mrr_marked_recorded():
    async with running_app() as (app, pilot):
        await goto(pilot, "3")
        summary = text_of(app.screen.query_one("#floor-summary", Static))
        assert "31 of 34" in summary
        assert "%" not in summary, "the floor must not be shown as a bare percentage"
        assert "recorded for movement only" in summary
        assert "never a floor" in summary
        assert "chosen budget 4000" in summary


@run_async
async def test_brain_per_case_table_carries_the_clustering_columns():
    async with running_app() as (app, pilot):
        await goto(pilot, "3")
        table = app.screen.query_one("#percase-table", DataTable)
        assert table.row_count == 8
        headers = [str(column.label) for column in table.columns.values()]
        assert headers == ["case", "hit", "rank", "arm", "type", "area"]


@run_async
async def test_brain_answers_a_query_and_reports_tokens_used():
    async with running_app() as (app, pilot):
        await goto(pilot, "3")
        app.screen.query_one("#search-input", Input).value = "retry backoff upload queue"
        await scroll_to(pilot, "#search-go")
        await pilot.click("#search-go")
        await settle(pilot)
        assert app.screen.query_one("#chunk-table", DataTable).row_count > 0
        summary = text_of(app.screen.query_one("#search-summary", Static))
        assert "tokensUsed" in summary and "standing" in summary


@run_async
async def test_a_standing_unit_reports_no_token_cost_rather_than_none():
    """The real daemon sends tokens: null for units outside the budget."""
    async with running_app() as (app, pilot):
        await goto(pilot, "3")
        app.screen.query_one("#search-input", Input).value = "retry backoff upload queue"
        await scroll_to(pilot, "#search-go")
        await pilot.click("#search-go")
        await settle(pilot)
        # Simulate the daemon's shape: standing units carry no token count.
        for chunk in app.screen.chunks:
            if chunk.get("standing"):
                chunk["tokens"] = None
        table = app.screen.query_one("#chunk-table", DataTable)
        table.clear()
        for index, chunk in enumerate(app.screen.chunks, start=1):
            app.screen._add_chunk_row(table, index, chunk)
        cells = [str(table.get_row_at(i)[-2]) for i in range(table.row_count)]
        assert "None" not in cells, "a null token count must not render as None"
        assert "outside budget" in cells


@run_async
async def test_mcp_snippet_unlocks_above_the_threshold():
    async with running_app() as (app, pilot):
        await goto(pilot, "3")
        assert "MCP unlocked" in text_of(app.screen.query_one("#mcp-summary", Static))
        assert "mcpServers" in text_of(app.screen.query_one("#mcp-summary", Static))


@run_async
async def test_mcp_snippet_stays_locked_below_the_threshold():
    async with running_app(repo=SUB_75_REPO) as (app, pilot):
        await goto(pilot, "3")
        panel = text_of(app.screen.query_one("#mcp-summary", Static))
        assert "MCP locked" in panel
        assert "mcpServers" not in panel


@run_async
async def test_mechanical_diagnosis_is_shown_without_spending():
    async with running_app(repo=SUB_75_REPO) as (app, pilot):
        await goto(pilot, "3")
        headline = text_of(app.screen.query_one("#diagnosis-headline", Static))
        assert "21 of 31" in headline
        assert "below the 0.75 threshold" in headline
        clusters = app.screen.query_one("#cluster-table", DataTable)
        assert clusters.row_count == 9
        assert app.screen.query_one("#missed-table", DataTable).row_count == 4
        assert app.client.engine.spend_calls == []


@run_async
async def test_narration_is_refused_until_confirmed_and_then_runs():
    async with running_app(repo=SUB_75_REPO) as (app, pilot):
        await goto(pilot, "3")
        await pilot.click("#--content-tab-brain-tab-diagnosis")
        await settle(pilot)
        await scroll_to(pilot, "#narrate-go")
        await pilot.click("#narrate-go")
        await settle(pilot)
        assert isinstance(app.screen, SpendConfirmScreen)
        await pilot.click("#spend-cancel")
        await settle(pilot)
        assert app.client.engine.spend_calls == []
        assert "Nothing was sent" in text_of(app.screen.query_one("#narration", Static))

        await scroll_to(pilot, "#narrate-go")
        await pilot.click("#narrate-go")
        await settle(pilot)
        await pilot.click("#spend-confirm")
        await settle(pilot)
        assert [call[0] for call in app.client.engine.spend_calls] == ["diagnoseNarrate"]
        assert "Packages/Core" in text_of(app.screen.query_one("#narration", Static))


@run_async
async def test_no_screen_still_advertises_a_gap_the_contract_closed():
    """v5 closed the last two: exam titles and the budget estimate."""
    async with running_app() as (app, pilot):
        for key in MODE_KEYS:
            await goto(pilot, key)
            rendered = screen_text(app)
            for stale in ("no human readable title", "has no method that returns an estimated budget"):
                assert stale not in rendered, f"mode {app.current_mode} still claims: {stale}"


@run_async
async def test_brain_lists_a_real_inventory_from_the_documents_method():
    """Inverted from the old stub test: documents joined the surface in v4."""
    async with running_app() as (app, pilot):
        await goto(pilot, "3")
        assert not app.screen.query("#inventory-stub"), "the inventory stub must be gone"
        table = app.screen.query_one("#inventory-table", DataTable)
        assert table.row_count == 10
        summary = text_of(app.screen.query_one("#inventory-summary", Static))
        assert "10 documents" in summary
        assert "3 card" in summary and "2 adr" in summary
        assert "adr-0044" in text_of(app.screen.query_one("#inventory-detail", Static))
        rendered = screen_text(app)
        assert "does not expose it" not in rendered
        assert "search only" not in rendered


@run_async
async def test_inventory_filters_narrow_the_document_list():
    async with running_app() as (app, pilot):
        await goto(pilot, "3")
        await pilot.click("#--content-tab-brain-tab-inventory")
        await settle(pilot)
        app.screen.query_one("#inventory-query", Input).value = "architecture card"
        await scroll_to(pilot, "#inventory-apply")
        await pilot.click("#inventory-apply")
        await settle(pilot)
        assert app.screen.query_one("#inventory-table", DataTable).row_count == 3
        assert all(row["type"] == "card" for row in app.screen.documents)


@run_async
async def test_inventory_reports_the_engine_hint_when_there_is_no_brain():
    async with running_app(repo="/Users/owner/code/kiln-api") as (app, pilot):
        await goto(pilot, "3")
        assert "No brain has been built" in text_of(app.screen.query_one("#inventory-summary", Static))
        assert app.screen.query_one("#inventory-table", DataTable).row_count == 0


# 4. Gates ------------------------------------------------------------------


@run_async
async def test_gates_table_classifies_every_candidate_with_evidence():
    async with running_app() as (app, pilot):
        await goto(pilot, "4")
        table = app.screen.query_one("#gates-table", DataTable)
        assert table.row_count == 5
        classifications = {str(table.get_row_at(i)[1]) for i in range(table.row_count)}
        assert classifications == {"live", "measured", "pre-broken", "unavailable"}
        assert "baseline run" in text_of(app.screen.query_one("#gate-evidence", Static))


@run_async
async def test_gates_screen_names_the_gates_that_carry_no_signal():
    async with running_app() as (app, pilot):
        await goto(pilot, "4")
        notice = text_of(app.screen.query_one("#gates-notice", Banner))
        assert "excluded and labelled" in notice
        assert "react-doctor" in notice and "playwright" in notice


@run_async
async def test_gates_can_be_reclassified_and_the_change_persists():
    async with running_app() as (app, pilot):
        await goto(pilot, "4")
        await pilot.click("#gates-prebroken")
        await settle(pilot)
        gate = next(g for g in app.screen.gates if g["name"] == "eslint")
        assert gate["classification"] == "pre-broken"
        assert gate["enabled"] is False


@run_async
async def test_gates_discovery_streams_into_the_checklist():
    async with running_app() as (app, pilot):
        await goto(pilot, "4")
        await pilot.click("#gates-discover")
        await settle(pilot, 12)
        checklist = app.screen.query_one("#gates-checklist", PhaseChecklist)
        assert checklist.job_id and checklist.job_id.startswith("job-gates-")
        assert app.screen.query_one("#gates-events", EventLog).event_count > 8
        assert checklist.state["classify"]["status"] in ("done", "warn")


# 5. Gym --------------------------------------------------------------------


@run_async
async def test_gym_screen_renders_the_run_ledger_from_gym_status():
    async with running_app() as (app, pilot):
        await goto(pilot, "5")
        assert app.screen.query_one("#edit-table", DataTable).row_count == 4
        assert app.screen.query_one("#check-table", DataTable).row_count == 4
        assert app.screen.query_one("#extension-table", DataTable).row_count == 4
        assert app.screen.query_one("#boundary-table", DataTable).row_count == 4
        assert app.screen.query_one("#criteria-table", DataTable).row_count == 5
        assert app.screen.query_one("#rollback-table", DataTable).row_count == 1
        assert app.screen.query_one("#cycle-table", DataTable).row_count == 5
        ledger = text_of(app.screen.query_one("#ledger-summary", Static))
        assert "harness-debug" in ledger and "result files" in ledger


@run_async
async def test_gym_reads_the_gate_from_serve_status_before_any_attempt():
    async with running_app(gate_open=False) as (app, pilot):
        await goto(pilot, "5")
        gate = text_of(app.screen.query_one("#gym-gate", Static))
        assert "blocked" in gate and ".daijin/GATE" in gate
        assert app.screen.gate_open is False
        assert app.client.engine.spend_calls == [], "reading the gate must not attempt a cycle"
        assert "gate reads blocked" in str(app.screen.query_one("#gym-start", Button).label)


@run_async
async def test_gym_shows_the_spend_gate_refusal_hint_verbatim():
    async with running_app(gate_open=False) as (app, pilot):
        await goto(pilot, "5")
        await pilot.click("#gym-start")
        await settle(pilot)
        assert isinstance(app.screen, SpendConfirmScreen), "a cycle is confirmed before it is attempted"
        await pilot.click("#spend-confirm")
        await settle(pilot)
        notice = text_of(app.screen.query_one("#gym-notice", Banner))
        assert "spend gate is blocked" in notice.lower()
        assert "owner's hand" in notice
        assert app.screen.job_id is None


@run_async
async def test_gym_live_stream_fills_the_checklist_when_the_gate_is_open():
    async with running_app(gate_open=True) as (app, pilot):
        await goto(pilot, "5")
        await pilot.click("#gym-start")
        await settle(pilot)
        assert isinstance(app.screen, SpendConfirmScreen)
        assert "44 rounds" in screen_text(app), "the cycle estimate shows its basis"
        await pilot.click("#spend-confirm")
        await settle(pilot, 14)
        checklist = app.screen.query_one("#gym-checklist", PhaseChecklist)
        assert checklist.job_id and checklist.job_id.startswith("job-gym-")
        assert app.screen.query_one("#gym-events", EventLog).event_count > 20
        assert checklist.state["rounds"]["status"] in ("done", "warn")
        assert checklist.state["audit"]["status"] in ("done", "warn")


@run_async
async def test_declining_the_gym_dialog_never_reaches_the_engine():
    async with running_app(gate_open=True) as (app, pilot):
        await goto(pilot, "5")
        await pilot.click("#gym-start")
        await settle(pilot)
        await pilot.click("#spend-cancel")
        await settle(pilot)
        assert app.client.engine.spend_calls == []
        assert app.screen.job_id is None
        assert "Nothing was sent to a provider" in text_of(app.screen.query_one("#gym-notice", Banner))


@run_async
async def test_gym_tabs_switch_with_the_mouse():
    async with running_app() as (app, pilot):
        await goto(pilot, "5")
        tabs = app.screen.query_one(TabbedContent)
        assert tabs.active == "gym-tab-live"
        await pilot.click("#--content-tab-gym-tab-run")
        await settle(pilot)
        assert tabs.active == "gym-tab-run"


# 6. Exams ------------------------------------------------------------------


@run_async
async def test_exams_screen_keeps_the_two_status_axes_apart():
    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        table = app.screen.query_one("#exam-table", DataTable)
        assert table.row_count == 5
        headers = [str(column.label) for column in table.columns.values()]
        assert "status" in headers and "benchmark" in headers and "held out" in headers
        assert "title" in headers
        rows = {str(table.get_row_at(i)[0]): table.get_row_at(i) for i in range(table.row_count)}
        quarantined = rows["exam-0061"]
        assert str(quarantined[1]) == "Add jitter to the retry backoff"
        assert str(quarantined[3]) == "promoted", "authoring status is untouched by quarantine"
        assert str(quarantined[4]) == "quarantined"
        assert len(str(quarantined[6])) >= 20
        # Every row is readable without decoding an id.
        for index in range(table.row_count):
            assert str(table.get_row_at(index)[1]).strip()


@run_async
async def test_exam_filters_narrow_each_axis():
    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        app.screen.query_one("#filter-exam-status", Select).value = "draft"
        await settle(pilot)
        assert app.screen.query_one("#exam-table", DataTable).row_count == 1
        assert "1 in the draft queue" in text_of(app.screen.query_one("#exam-notice", Banner))


@run_async
async def test_quarantine_dialog_enforces_the_reason_minimum():
    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        await pilot.click("#exam-quarantine")
        await settle(pilot)
        assert isinstance(app.screen, TextPromptScreen)
        app.screen.query_one("#prompt-input", Input).value = "too short"
        await pilot.click("#prompt-ok")
        await settle(pilot)
        assert isinstance(app.screen, TextPromptScreen), "a short reason must not close the dialog"
        assert "At least 20 characters" in text_of(app.screen.query_one("#prompt-error", Static))
        app.screen.query_one("#prompt-input", Input).value = "cap death left no result row for this exam"
        await pilot.click("#prompt-ok")
        await settle(pilot)
        exam = next(e for e in app.screen.exams if e["examId"] == "exam-0058")
        assert exam["benchmarkStatus"] == "quarantined"
        assert exam["status"] == "promoted"


@run_async
async def test_veto_records_its_reason():
    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        await pilot.click("#exam-veto")
        await settle(pilot)
        app.screen.query_one("#prompt-input", Input).value = "statement leaks the fix"
        await pilot.click("#prompt-ok")
        await settle(pilot)
        exam = next(e for e in app.screen.exams if e["examId"] == "exam-0058")
        assert exam["status"] == "vetoed"
        assert "statement leaks the fix" in text_of(app.screen.query_one("#exam-provenance", Static))


@run_async
async def test_radar_switches_to_bars_by_keyboard_and_is_persisted():
    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        radar = app.screen.query_one("#exam-radar", RadarChart)
        assert radar.mode == "radar"
        await pilot.press("r")
        await settle(pilot)
        assert radar.mode == "bars"
        assert len(radar.lines) == 5
        settings = await app.client.call("settingsGet", {})
        assert settings["charts"]["radarMode"] == "bars"


@run_async
async def test_radar_switches_to_bars_by_mouse():
    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        radar = app.screen.query_one("#exam-radar", RadarChart)
        await pilot.click(radar)
        await settle(pilot)
        assert radar.mode == "bars"


@run_async
async def test_exam_token_bars_and_history_come_from_exam_detail():
    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        assert app.screen.exam_id == "exam-0058"
        assert len(app.screen.query_one("#exam-tokens", PlotextBar).values) == 9


# 7. Board ------------------------------------------------------------------


@run_async
async def test_board_lists_findings_and_shows_the_status_thread():
    async with running_app() as (app, pilot):
        await goto(pilot, "7")
        assert app.screen.query_one("#board-table", DataTable).row_count == 6
        detail = text_of(app.screen.query_one("#board-detail", Static))
        assert "watcher" in detail and "evidence" in detail


@run_async
async def test_board_filter_narrows_to_critical_findings():
    async with running_app() as (app, pilot):
        await goto(pilot, "7")
        app.screen.query_one("#filter-severity", Select).value = "critical"
        await settle(pilot)
        assert app.screen.query_one("#board-table", DataTable).row_count == 1
        assert "1 of 6" in text_of(app.screen.query_one("#board-notice", Banner))


@run_async
async def test_pushed_findings_appear_on_the_board_with_no_job_running():
    async with running_app() as (app, pilot):
        await goto(pilot, "7")
        before = app.screen.query_one("#board-table", DataTable).row_count
        app.client.engine.start_board_findings()
        await settle(pilot, 12)
        assert app.screen.query_one("#board-table", DataTable).row_count == before + 3
        assert "pushed live" in text_of(app.screen.query_one("#board-notice", Banner))


# 8. Settings ---------------------------------------------------------------


@run_async
async def test_settings_shows_the_last_recorded_ping_and_never_pings_on_open():
    async with running_app() as (app, pilot):
        await goto(pilot, "8")
        table = app.screen.query_one("#role-table", DataTable)
        assert table.row_count == 4
        verified = {str(table.get_row_at(i)[0]): str(table.get_row_at(i)[-1]) for i in range(table.row_count)}
        assert verified["watcher"] == "never"
        assert verified["engineer"] == "ok"
        detail = text_of(app.screen.query_one("#role-detail", Static))
        assert "recorded at that time, not a live reading" in detail
        assert app.client.engine.spend_calls == []
        assert "Never verified: watcher" in text_of(app.screen.query_one("#settings-notice", Banner))
        assert all("lastPing" not in role for role in app.screen.settings["roles"])
        assert "ping" in app.screen.settings["roles"][0]


@run_async
async def test_verifying_a_role_needs_a_confirmation_and_then_pings():
    async with running_app() as (app, pilot):
        await goto(pilot, "8")
        await pilot.click("#role-verify")
        await settle(pilot)
        assert isinstance(app.screen, SpendConfirmScreen)
        await pilot.click("#spend-cancel")
        await settle(pilot)
        assert app.client.engine.spend_calls == []

        await pilot.click("#role-verify")
        await settle(pilot)
        await pilot.click("#spend-confirm")
        await settle(pilot)
        assert [call[0] for call in app.client.engine.spend_calls] == ["rolePing"]
        assert app.client.engine.spend_calls[0][1]["role"] == "engineer"
        assert "served id glm-4.6" in text_of(app.screen.query_one("#settings-notice", Banner))


@run_async
async def test_settings_badges_the_modified_instruction_files():
    async with running_app() as (app, pilot):
        await goto(pilot, "8")
        table = app.screen.query_one("#file-table", DataTable)
        assert table.row_count == 4
        badges = [str(table.get_row_at(index)[-1]) for index in range(table.row_count)]
        assert badges.count("MODIFIED") == 2
        assert badges.count("default") == 2


@run_async
async def test_editing_an_instruction_file_flips_its_badge():
    async with running_app() as (app, pilot):
        await goto(pilot, "8")
        assert app.screen.agent_files["student"]["modified"] is False
        await pilot.click("#file-edit")
        await settle(pilot)
        assert isinstance(app.screen, AgentFileEditScreen)
        app.screen.query_one("#agent-file-text").text = "# Student\n\nrewritten by the user\n"
        await pilot.click("#agent-file-save")
        await settle(pilot)
        assert app.screen.agent_files["student"]["modified"] is True
        assert "now modified from the default" in text_of(app.screen.query_one("#settings-notice", Banner))


# Broadcast fan-out safety --------------------------------------------------


@pytest.mark.parametrize(
    "key,screen_job,checklist_id,log_id",
    [
        ("2", "init", "#init-checklist", "#init-events"),
        ("5", "gym", "#gym-checklist", "#gym-events"),
        ("4", "gates", "#gates-checklist", "#gates-events"),
    ],
)
@run_async
async def test_a_screen_never_narrates_another_clients_job(key, screen_job, checklist_id, log_id):
    """Under a shared daemon, step events reach every attached client.

    A screen that renders whatever arrives adopts the foreign jobId, advances
    its checklist, and finishes by claiming the job completed for the repo THIS
    screen is pointed at. An idle screen showing nothing is correct: it started
    nothing.
    """
    async with running_app() as (app, pilot):
        await goto(pilot, key)
        screen = app.screen
        assert screen.job_id is None
        foreign = {
            "ts": 0,
            "jobId": "job-somewhere-else-0001",
            "phase": "identify",
            "step": "git-walk",
            "detail": "another client's repo",
            "level": "info",
        }
        screen._on_step_event(foreign)
        await settle(pilot)
        checklist = screen.query_one(checklist_id, PhaseChecklist)
        assert checklist.job_id is None, "the screen adopted a job it never started"
        assert screen.query_one(log_id, EventLog).event_count == 0
        assert all(entry["status"] == "pending" for entry in checklist.state.values())
        # Not rendered, but not invisible either: the screen knows it happened.
        assert "job-somewhere-else-0001" in screen.foreign_jobs


@run_async
async def test_a_screen_still_renders_the_job_it_started():
    """The strict filter must not silence the screen's own stream."""
    async with running_app() as (app, pilot):
        await goto(pilot, "2")
        await pilot.click("#init-start")
        await settle(pilot, 14)
        checklist = app.screen.query_one("#init-checklist", PhaseChecklist)
        assert checklist.job_id == app.screen.job_id
        assert app.screen.query_one("#init-events", EventLog).event_count > 20
        assert app.screen.foreign_jobs == set()


# The budget echo is the client's obligation --------------------------------


@run_async
async def test_the_client_always_echoes_the_estimate_it_displayed():
    """The engine accepts a bare confirm, so sending the echo is on us."""
    async with running_app() as (app, pilot):
        await goto(pilot, "2")
        app.screen.query_one("#init-mode", Select).value = "layer1+layer2"
        await pilot.click("#init-start")
        await settle(pilot)
        await pilot.click("#spend-confirm")
        await settle(pilot, 14)
        repo, echoed = app.client.engine.recorded_budgets[-1]
        assert echoed is not None, "the client confirmed a spend without echoing the estimate"
        assert echoed["estimatedTokens"] > 0
        shown = await app.client.call("budgetEstimate", {"repoPath": repo, "mode": "layer1+layer2"})
        assert echoed["estimatedTokens"] == shown["estimatedTokens"]


@run_async
async def test_the_gym_echoes_its_estimate_too():
    async with running_app(gate_open=True) as (app, pilot):
        await goto(pilot, "5")
        await pilot.click("#gym-start")
        await settle(pilot)
        await pilot.click("#spend-confirm")
        await settle(pilot, 14)
        _repo, echoed = app.client.engine.recorded_budgets[-1]
        assert echoed is not None, "the gym displayed an estimate it did not record"
        assert echoed["estimatedTokens"] > 0


# Deferred engine capabilities ----------------------------------------------


@run_async
async def test_a_deferred_capability_says_so_instead_of_looking_empty():
    """An empty table with a blank banner cannot be told apart from no data.

    This is what the exams screen did against the real daemon before -32001 was
    handled: examList is deferred to P4, so the bank rendered as a bare header
    row and the only signal was a transient red toast.
    """
    async with running_app(deferred={"examList": "P4 (exam mining)"}) as (app, pilot):
        await goto(pilot, "6")
        notice = text_of(app.screen.query_one("#exam-notice", Banner))
        assert "Not built yet" in notice
        # The phase comes from the engine's self-contained hint, said once.
        assert notice.count("P4 (exam mining)") == 1
        assert app.screen.query_one("#exam-table", DataTable).row_count == 0
        assert app.screen.exams == []
        # Deferred is news, not breakage: the banner must not read as an error.
        assert app.screen.query_one("#exam-notice", Banner).tone == "info"


@run_async
async def test_a_deferred_capability_never_leaves_a_blank_banner():
    deferrals = {
        "5": ("gymStatus", "#gym-notice", "P4 (gym port)"),
        "6": ("examList", "#exam-notice", "P4 (exam mining)"),
        "7": ("board", "#board-notice", "P4 (watcher)"),
        "8": ("settingsGet", "#settings-notice", "P4 (settings store)"),
    }
    for key, (method, banner_id, phase) in deferrals.items():
        async with running_app(deferred={method: phase}) as (app, pilot):
            await goto(pilot, key)
            notice = text_of(app.screen.query_one(banner_id, Banner))
            assert notice.strip(), f"{method} deferred left {banner_id} blank"
            assert phase in notice, f"{banner_id} does not say which phase ships {method}"


@run_async
async def test_a_real_error_still_reads_as_an_error():
    """The deferred treatment must not soften genuine failures."""
    async with running_app(deferred={"board": "P4 (watcher)"}) as (app, pilot):
        await goto(pilot, "7")
        assert app.screen.query_one("#board-notice", Banner).tone == "info"
    async with running_app(repo="/Users/owner/code/kiln-api") as (app, pilot):
        await goto(pilot, "3")
        # No brain: a real -32602, which must not be dressed up as "coming soon".
        assert "Not built yet" not in text_of(app.screen.query_one("#inventory-summary", Static))


# Contract handshake --------------------------------------------------------


@run_async
async def test_a_contract_mismatch_renders_the_upgrade_screen():
    from daijin_tui.screens import UpgradeScreen

    async with running_app(contract_version="99") as (app, pilot):
        await settle(pilot)
        assert isinstance(app.screen, UpgradeScreen)
        rendered = screen_text(app)
        assert "Contract version mismatch" in rendered
        assert "99" in rendered
        # A mismatched client must not go on to query the surface it cannot read.
        assert [call[0] for call in app.client.engine.calls] == ["hello"]


@run_async
async def test_a_matching_contract_boots_the_home_screen():
    async with running_app() as (app, pilot):
        assert app.current_mode == "home"
        assert app.client.contract_version == SUPPORTED_CONTRACT_VERSION


# Critical findings ---------------------------------------------------------


@run_async
async def test_a_critical_finding_reaches_the_user_on_any_screen():
    async with running_app() as (app, pilot):
        await goto(pilot, "8")
        assert app.critical_findings == []
        app.client.engine.start_board_findings()
        await settle(pilot, 12)
        assert len(app.critical_findings) == 1
        assert app.critical_findings[0]["target"] == "embedding-identity"
        assert app.current_mode == "settings", "a finding must not navigate the user away"


# Navigation ----------------------------------------------------------------


@pytest.mark.parametrize("key,mode", list(zip(MODE_KEYS, MODES)))
@run_async
async def test_every_view_is_reachable_by_keyboard(key, mode):
    async with running_app() as (app, pilot):
        await goto(pilot, key)
        assert app.current_mode == mode


@pytest.mark.parametrize("mode", MODES)
@run_async
async def test_every_view_is_reachable_by_mouse(mode):
    async with running_app() as (app, pilot):
        await pilot.click(f"#nav-{mode}")
        await settle(pilot)
        assert app.current_mode == mode
