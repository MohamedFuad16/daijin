"""One test per screen, driven through the app against the mock engine.

Navigation is exercised both ways on purpose: number keys for the keyboard
path, pilot.click for the mouse path.
"""

from __future__ import annotations

import pytest
from conftest import DEFAULT_REPO, SUB_75_REPO, goto, run_async, running_app, screen_text, scroll_to, settle

from textual.widgets import Button, DataTable, Input, Select, Static, TabbedContent, TextArea

from daijin_tui import mock_data
from daijin_tui.rpc import SUPPORTED_CONTRACT_VERSION
from daijin_tui.screens.gates import GATE_COLUMNS
from daijin_tui.screens.dialogs import AgentFileEditScreen, SpendConfirmScreen, TextPromptScreen
from daijin_tui.widgets import (
    Banner,
    EventLog,
    PhaseChecklist,
    PlotextBar,
    DitherBars,
    RadarChart,
    RepoCard,
    Sparkline,
    StippleLine,
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
        assert len(cards) == len(mock_data.REPOS)
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
async def test_every_repo_card_can_be_reached_on_a_standard_terminal():
    """Four cards at 42 columns overflow a 170 column terminal.

    The row was a plain Horizontal, so the overflowing cards were reachable by
    neither the mouse nor the keyboard: not clipped visibly, just gone. That
    fails the one acceptance rule covering every screen, and it fails silently,
    which is why it survived three repos.
    """
    async with running_app() as (app, pilot):
        cards = list(app.screen.query(RepoCard))
        container = app.screen.query_one("#repo-cards")
        widest = max(card.region.right for card in cards)
        assert widest > app.screen.size.width, (
            "the cards fit, so this check proves nothing; seed another repo"
        )
        # The container must be ABLE to scroll. Intersecting a region with its
        # container and asserting containment is a tautology, which is what the
        # first version of this check did.
        assert container.max_scroll_x > 0, (
            "the card row cannot scroll, so the cards past the right edge are "
            "reachable by neither the mouse nor the keyboard"
        )
        last = cards[-1]
        last.scroll_visible(animate=False)
        await settle(pilot)
        assert last.region.right <= app.screen.size.width, (
            f"the last card still ends at {last.region.right} on a "
            f"{app.screen.size.width} column screen after scrolling to it"
        )
        button = last.query_one(".card-action", Button)
        await pilot.click(button)
        await settle(pilot)
        assert app.current_mode != "home", "the card scrolled into view but its action did not fire"

@run_async
async def test_attaching_and_detaching_a_repo_changes_the_cards():
    async with running_app() as (app, pilot):
        before = len(list(app.screen.query(RepoCard)))
        app.screen.query_one("#attach-input", Input).value = "/Users/owner/code/newthing"
        await pilot.click("#attach-go")
        # The refetch after a mutation is a worker now, so the confirmation is
        # immediate and the reload is not. Tests wait for it; users see it load.
        await app.screen.wait_for_load()
        await settle(pilot)
        assert len(list(app.screen.query(RepoCard))) == before + 1
        card = next(c for c in app.screen.query(RepoCard) if c.repo_path.endswith("newthing"))
        # Past the right edge on a standard terminal, so it is scrolled to
        # first. That the scroll REACHES it is the point.
        card.scroll_visible(animate=False)
        await settle(pilot)
        await pilot.click(card.query_one(".card-detach", Button))
        await app.screen.wait_for_load()
        await settle(pilot)
        assert len(list(app.screen.query(RepoCard))) == before
        assert "Detached" in text_of(app.screen.query_one("#home-notice", Banner))




@run_async
async def test_a_brain_deleted_on_disk_changes_the_badge_without_a_reattach():
    """Health is computed per call, so it can change under a repo that is already attached.

    A mock that cached a health at attach time would never produce the
    transition a user actually meets when they delete a state directory, and
    the screen's handling of it would go untested.
    """
    async with running_app() as (app, pilot):
        card = next(c for c in app.screen.query(RepoCard) if c.repo_path.endswith("orchard-web"))
        assert card.repo.get("health") == "ok"

        app.client.engine.break_brain("/Users/owner/code/orchard-web")
        app.screen.start_load()
        await app.screen.wait_for_load()
        await settle(pilot)

        card = next(c for c in app.screen.query(RepoCard) if c.repo_path.endswith("orchard-web"))
        assert card.repo.get("health") == "critical", "the badge kept a health the engine stopped reporting"
        assert card.needs_brain is False
        rendered = " ".join(text_of(s) for s in card.query(Static))
        assert "could not be opened" in rendered

        # Asserting the absence of a floor in the RENDER proves nothing: the
        # critical branch returns before any floor is drawn, so that check
        # passes whether or not the score was cleared. The claim is about the
        # row, so it is made against the row.
        row = next(
            r for r in (await app.client.call("serveStatus", {}))["repos"]
            if r["path"].endswith("orchard-web")
        )
        assert row["health"] == "critical"
        # Measured against the daemon on 2026-08-17: the floor SURVIVES, because
        # it comes from the score history rather than from the brain. The mock
        # cleared it, which was a behaviour the engine does not have. My earlier
        # assertion here encoded my invention as a fact.
        assert row["floorScore"] is not None, (
            "the score history does not live in the brain, so breaking the brain "
            "cannot erase what was already measured"
        )
        rendered_after = " ".join(text_of(s) for s in card.query(Static))
        assert "last measured floor" in rendered_after, (
            "a real historical measurement is being hidden behind the broken state"
        )
        assert "from the score history" in rendered_after, (
            "the surviving floor is shown without saying it is not from this brain"
        )


@run_async
async def test_warn_says_which_of_its_two_situations_this_is():
    """warn covers indexed-never-measured AND measured-below-the-floor.

    The engine computes both from one branch, so the field alone cannot tell
    them apart; floorScore on the same row can. Rendering them identically
    would say the same thing about a repo nobody has scored and a repo that
    scored badly, and only the second is a verdict.
    """
    from daijin_tui.widgets import health_glyph, health_state

    assert health_state("warn", None) == "warn-unmeasured"
    assert health_state("warn", 0.62) == "warn"
    assert health_glyph("warn", None) != health_glyph("warn", 0.62), (
        "never measured and measured badly share a badge"
    )
    # The distinction is a rendering one. The wire vocabulary stays four values.
    from daijin_tui.widgets.common import DOCUMENTED_HEALTH

    assert "warn-unmeasured" not in DOCUMENTED_HEALTH

    unmeasured = RepoCard({"path": "/x/never-scored", "health": "warn", "floorScore": None})
    measured = RepoCard({"path": "/x/scored-low", "health": "warn", "floorScore": 0.62})
    async with running_app() as (app, pilot):
        await app.screen.mount(unmeasured)
        await app.screen.mount(measured)
        await settle(pilot)
        first = " ".join(text_of(s) for s in unmeasured.query(Static))
        second = " ".join(text_of(s) for s in measured.query(Static))
        assert "never measured" in first, f"the unscored repo does not say so: {first!r}"
        assert "no brain yet" not in first, "a repo that IS indexed was told it has no brain"
        assert "0.62" in second and "never measured" not in second

@run_async
async def test_a_critical_repo_is_not_offered_a_fresh_brain_over_the_one_it_has():
    """critical is a brain that could not be OPENED, not a brain that is missing.

    serveStatus rows carry no hasBrain field (checked against the daemon on
    2026-08-17), so health is the only thing that can answer this, and falling
    back to a null floorScore made critical look like no-brain. That put
    "Initialize brain" under the thumb of the user whose brain just failed to
    load, which is the destructive reading of an ambiguous state.
    """
    async with running_app() as (app, pilot):
        card = next(c for c in app.screen.query(RepoCard) if c.repo.get("health") == "critical")
        assert card.needs_brain is False
        labels = [str(b.label) for b in card.query(Button)]
        assert "Initialize brain" not in labels, f"a fresh brain was offered over a broken one: {labels}"
        assert "Inspect brain" in labels
        rendered = " ".join(text_of(s) for s in card.query(Static))
        assert "could not be opened" in rendered
        assert "floor" not in rendered.split("could not be opened")[0][-40:], (
            "a floor was scored from a brain that will not open"
        )


@run_async
async def test_every_documented_health_value_renders_and_none_of_them_crash():
    """Locked vocabulary: no-brain | warn | ok | critical.

    The mock reaches all four, so no branch here is carried by a default that
    nobody exercises.
    """
    from daijin_tui.widgets import health_glyph

    seen = {r["health"] for r in mock_data.REPOS}
    assert seen == {"no-brain", "warn", "ok", "critical"}, f"a documented state is unreachable: {seen}"
    classes = {value: health_glyph(value)[1] for value in seen}
    assert len(set(classes.values())) == len(classes), f"two states look alike: {classes}"
    # An undocumented value must not crash and must not borrow a real state's look.
    unknown_glyph, unknown_class = health_glyph("banana")
    assert unknown_class not in classes.values(), "an unknown health borrowed a documented state's badge"

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
async def test_an_init_that_broke_is_not_announced_as_complete():
    """The phase says THAT it ended; level says HOW.

    This banner branched only on step == cancelled, so a run that BROKE
    reported "Init complete" in the one place the user is looking, while the
    only evidence of the failure was a red line in a feed they may have
    scrolled past and a repo card still saying no-brain with no stated
    connection between them.

    Keying on the step was my reading of guidance that has since been
    corrected (engine 9106794): the step is an open set, level is a closed one.
    """
    async with running_app() as (app, pilot):
        app.client.engine.fail_next_init(DEFAULT_REPO)
        await goto(pilot, "2")
        await pilot.click("#init-start")
        await settle(pilot, 20)

        notice = text_of(app.screen.query_one("#init-notice", Banner))
        assert "FAILED" in notice, f"a broken init was announced as: {notice!r}"
        assert "complete" not in notice.lower(), "the failure still reads as a success"
        assert "no brain to use" in notice, "the consequence is not stated"
        assert "embedder refused" in notice, "the engine's own reason is not carried"

        checklist = app.screen.query_one("#init-checklist", PhaseChecklist)
        assert checklist.terminal_level == "error"
        header = checklist.render().plain
        assert "FAILED" in header, f"the checklist header hides the failure: {header!r}"
        # A phase that was running when the job broke did not finish.
        assert "failed" in {entry["status"] for entry in checklist.state.values()}, (
            "a run that broke left a checklist of ticks"
        )
        assert not any(
            entry["status"] == "done" and key == "brain"
            for key, entry in checklist.state.items()
        ), "the phase that was mid flight when it broke is marked done"

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
        column = GATE_COLUMNS.index("classification")
        classifications = {str(table.get_row_at(i)[column]) for i in range(table.row_count)}
        assert classifications == {"live", "measured", "pre-broken", "unavailable"}
        # The evidence pane quotes the measurement rather than paraphrasing it,
        # so the numbers it shows have to be the ones the baseline recorded.
        evidence = text_of(app.screen.query_one("#gate-evidence", Static))
        first = app.screen.gates[0]["baseline"]
        assert str(first["durationMs"]) in evidence, f"the duration is not shown: {evidence!r}"
        assert str(first["timeoutMs"]) in evidence, "the budget the duration is measured against is missing"
        assert first["status"] in evidence


@run_async
async def test_a_gates_file_that_describes_nothing_is_not_a_gates_file_that_broke():
    """Both produce an empty gate list and they are opposite facts.

    An empty table says "nothing guards this repo". That is true of a file that
    lists no gates and false of a file that would not parse, where the truth is
    that we do not know what it lists. The screen has to say which one it has.
    """
    async with running_app() as (app, pilot):
        await goto(pilot, "4")
        screen = app.screen

        app.selected_repo = "/Users/owner/code/kiln-api"
        screen.start_load()
        await screen.wait_for_load()
        await settle(pilot)
        empty_notice = text_of(screen.query_one("#gates-notice", Banner))
        assert screen.query_one("#gates-table", DataTable).display is True, (
            "a genuinely empty file is a table with no rows, which is the true rendering"
        )
        assert screen.query_one("#gates-table", DataTable).row_count == 0
        assert screen.query_one("#gates-raw", Static).display is False
        assert "describes no gates" in empty_notice
        empty_evidence = text_of(screen.query_one("#gate-evidence", Static))

        app.selected_repo = "/Users/owner/code/lantern-ios"
        screen.start_load()
        await screen.wait_for_load()
        await settle(pilot)
        broken_notice = text_of(screen.query_one("#gates-notice", Banner))
        assert screen.query_one("#gates-table", DataTable).display is False, (
            "an unparsed file rendered as an empty table claims zero gates it never counted"
        )
        raw = screen.query_one("#gates-raw", Static)
        assert raw.display is True
        rendered = text_of(raw)
        assert "No gate list could be taken" in rendered
        assert "Nested mappings are not allowed" in rendered, "the engine's reason is not shown"
        assert "swiftlint" in rendered, "the file the user has to fix is not shown"
        assert broken_notice != empty_notice, "the two empty states read identically"
        assert "not zero gates" in broken_notice
        broken_evidence = text_of(screen.query_one("#gate-evidence", Static))
        assert broken_evidence != empty_evidence, "the evidence pane explains both empties the same way"
        assert "no gate list could be taken" in broken_evidence
        assert "describes no gates" in empty_evidence



@run_async
async def test_the_unreadable_state_does_not_name_a_cause_the_engine_never_gave():
    """The engine gives two reasons through parseError and only one is a parse failure.

    A file that is valid YAML with no `gates:` key reaches the same branch. Copy
    that says "could not be parsed" there is a false explanation rather than a
    false number, which is the harder one to notice.
    """
    async with running_app() as (app, pilot):
        await goto(pilot, "4")
        screen = app.screen
        served = app.client.engine.gates["/Users/owner/code/lantern-ios"]
        served["content"] = mock_data.UNSHAPED_GATES_YAML
        served["parseError"] = mock_data.UNSHAPED_GATES_ERROR

        app.selected_repo = "/Users/owner/code/lantern-ios"
        screen.start_load()
        await screen.wait_for_load()
        await settle(pilot)

        rendered = text_of(screen.query_one("#gates-raw", Static))
        notice = text_of(screen.query_one("#gates-notice", Banner))
        assert mock_data.UNSHAPED_GATES_ERROR in rendered, "the engine's own reason is not shown"
        for wrong in ("could not be parsed", "not valid YAML", "could not be read"):
            assert wrong not in rendered, f"the screen invented a cause: {wrong!r}"
            assert wrong not in notice, f"the notice invented a cause: {wrong!r}"


@run_async
async def test_a_missing_summary_is_a_real_state_not_a_defensive_branch():
    """The live engine returns summary null whenever no baseline has been run.

    Verified against the daemon on 2026-08-17: a gates.yaml read without a
    baseline pass carries discovered with summary null, so this path is ordinary
    rather than hypothetical and must not print a count nobody measured.
    """
    async with running_app() as (app, pilot):
        await goto(pilot, "4")
        screen = app.screen
        app.client.engine.gates[DEFAULT_REPO]["discovered"]["summary"] = None
        screen.start_load()
        await screen.wait_for_load()
        await settle(pilot)
        notice = text_of(screen.query_one("#gates-notice", Banner))
        assert screen.query_one("#gates-table", DataTable).row_count == 5, (
            "the rows are known even when the tally is not"
        )
        assert "not yet measured" in notice, f"a count was invented: {notice!r}"
        assert "run discovery" in notice, "the state is named but not the way out of it"
        assert "carrying signal" not in notice

@run_async
async def test_the_gate_count_comes_from_the_engines_own_summary():
    """Recounting here would let the screen and the ledger drift apart.

    A missing summary is also not a zero: the screen says it has none rather
    than printing one it made up.
    """
    async with running_app() as (app, pilot):
        await goto(pilot, "4")
        screen = app.screen
        summary = screen.summary
        assert summary["carryingSignal"] == 3 and summary["total"] == 5
        notice = text_of(screen.query_one("#gates-notice", Banner))
        assert "3 of 5 carrying signal" in notice, f"the engine's count is not what is shown: {notice!r}"

        # Mutate the engine's own copy: the mock deep copies at construction,
        # so editing the module table would change nothing this app can see.
        served = app.client.engine.gates[DEFAULT_REPO]["discovered"]
        original = served.pop("summary")
        try:
            screen.start_load()
            await screen.wait_for_load()
            await settle(pilot)
            silent = text_of(screen.query_one("#gates-notice", Banner))
            assert "not yet measured" in silent, f"a missing count was rendered as a count: {silent!r}"
            assert "run discovery" in silent, "the state is named but not the way out of it"
            assert "carrying signal" not in silent
        finally:
            served["summary"] = original


@run_async
async def test_gates_screen_names_the_gates_that_carry_no_signal():
    async with running_app() as (app, pilot):
        await goto(pilot, "4")
        notice = text_of(app.screen.query_one("#gates-notice", Banner))
        assert "excluded and labelled" in notice
        assert "react-doctor" in notice and "playwright" in notice


@run_async
async def test_the_gates_screen_offers_no_per_row_write_the_engine_would_refuse():
    """The engine refuses a structural patch with -32602 in every file state.

    Three buttons here used to send exactly that. They worked against the mock
    and would have failed against the engine on every press, which is the
    live-only class again.
    """
    async with running_app() as (app, pilot):
        await goto(pilot, "4")
        ids = {button.id for button in app.screen.query(Button)}
        assert "gates-edit" in ids
        for gone in ("gates-measured", "gates-prebroken", "gates-toggle"):
            assert gone not in ids, f"{gone} sends a patch the engine always refuses"
        sent: list[dict] = []
        original = app.client.call

        async def record(method, params=None):
            if method == "gatesSet":
                sent.append(params or {})
            return await original(method, params)

        app.client.call = record
        try:
            await pilot.click("#gates-edit")
            await settle(pilot)
            app.screen_stack[-1].query_one("#gates-file-text", TextArea).text = (
                "version: 1\ngates:\n  - id: only\n    command: make check\n"
            )
            await pilot.click("#gates-file-save")
            await app.screen.wait_for_load()
            await settle(pilot)
        finally:
            app.client.call = original
        assert sent, "the save sent nothing"
        assert "content" in sent[0]["patch"], f"the write was not a document write: {sent[0]}"
        assert "gates" not in sent[0]["patch"], "a structural patch went out anyway"
        assert [g["id"] for g in app.screen.gates] == ["only"]


@run_async
async def test_a_row_the_user_just_typed_is_not_shown_as_classified():
    """Discovery writes the classification; the editor does not.

    Verified against the daemon on 2026-08-17: rows come back with
    classification, enabled and baseline ABSENT after a write. A blank cell
    would read as a verdict, so the table names the absence.
    """
    async with running_app() as (app, pilot):
        await goto(pilot, "4")
        await app.client.call(
            "gatesSet",
            {"repoPath": DEFAULT_REPO, "patch": {"content": "version: 1\ngates:\n  - id: only\n    command: make check\n"}},
        )
        app.screen.start_load()
        await app.screen.wait_for_load()
        await settle(pilot)
        table = app.screen.query_one("#gates-table", DataTable)
        row = table.get_row_at(0)
        assert str(row[GATE_COLUMNS.index("classification")]) == "not classified"
        assert str(row[GATE_COLUMNS.index("baseline")]) == "not run"
        assert str(row[GATE_COLUMNS.index("enabled")]) == "-", "an absent flag was rendered as a no"
        evidence = text_of(app.screen.query_one("#gate-evidence", Static))
        assert "No baseline has been run" in evidence
        assert "None" not in evidence, f"a null was printed as the word None: {evidence!r}"


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
async def test_a_gym_cycle_that_broke_after_spending_is_not_called_complete():
    """This banner had no branch at all: every ending read "Cycle complete".

    A gym cycle is spend touching, so a run that broke AFTER the provider was
    called was being reported as a success, and the user's next move would be
    to start another one.
    """
    async with running_app(gate_open=True) as (app, pilot):
        app.client.engine.fail_next_cycle()
        await goto(pilot, "5")
        await pilot.click("#gym-start")
        await settle(pilot)
        if isinstance(app.screen, SpendConfirmScreen):
            await pilot.click("#spend-confirm")
        await settle(pilot, 20)

        notice = text_of(app.screen.query_one("#gym-notice", Banner))
        assert "FAILED" in notice, f"a broken paid cycle was announced as: {notice!r}"
        assert "complete" not in notice.lower()
        assert "Spend may already have happened" in notice, (
            "the user is not told that a failed cycle can still have cost money"
        )
        assert "503" in notice, "the engine's own reason is not carried"

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
        assert len(app.screen.query_one("#exam-tokens", DitherBars).values) == 9


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


# Ungraded work is not a bad grade ------------------------------------------


@run_async
async def test_an_ungraded_exam_draws_no_radar_at_all():
    """axes null means nobody graded it, which is not a score of zero.

    A zeroed radar is a specific and false claim: that the student was measured
    on five axes and scored nothing on all of them.
    """
    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        await app.screen.show_exam("exam-0072")
        await settle(pilot)
        radar = app.screen.query_one("#exam-radar", RadarChart)
        assert radar.display is False, "a radar was drawn for work nobody graded"
        note = text_of(app.screen.query_one("#exam-axes-note", Static))
        assert "Not graded" in note
        assert "not a score of zero" in note


@run_async
async def test_a_graded_exam_still_draws_its_radar():
    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        await app.screen.show_exam("exam-0058")
        await settle(pilot)
        radar = app.screen.query_one("#exam-radar", RadarChart)
        assert radar.display is True
        assert len(radar._axes) == 5
        assert text_of(app.screen.query_one("#exam-axes-note", Static)).strip() == ""


@run_async
async def test_ungraded_attempts_explain_themselves_by_code():
    from textual.widgets import DataTable as DT

    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        await app.screen.show_exam("exam-0074")
        await settle(pilot)
        table = app.screen.query_one("#attempt-table", DT)
        assert table.row_count == 3
        reasons = [str(table.get_row_at(i)[-1]) for i in range(table.row_count)]
        assert any("unsubmitted" in r for r in reasons)
        assert any("apply-error" in r for r in reasons)
        assert any("pending" in r for r in reasons)
        # The code drives the branch; the engine's sentence is displayed.
        unsubmitted = next(r for r in reasons if "unsubmitted" in r)
        assert "never answered" in unsubmitted, "the code was not branched on"
        assert "cannot have answered badly" in unsubmitted
        verdicts = [str(table.get_row_at(i)[3]) for i in range(table.row_count)]
        assert all(v == "not graded" for v in verdicts)


@run_async
async def test_an_ungraded_attempt_is_not_plotted_as_a_failure():
    """The pass and fail line must not read three ungraded runs as three fails."""
    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        await app.screen.show_exam("exam-0074")
        await settle(pilot)
        history = app.screen.query_one("#exam-history", StippleLine)
        assert history.values == [], "ungraded attempts were plotted, which reads as failures"
        # Tokens are real for every attempt, graded or not.
        tokens = app.screen.query_one("#exam-tokens", DitherBars)
        assert len(tokens.values) == 3


@run_async
async def test_the_retrieval_tester_says_why_it_has_no_percentage():
    """A deliberate omission that looks like a missing feature is not done.

    The owner asked why the tester shows no percentage when the floor does.
    The distinction was carried by layout alone, which is not explaining.
    """
    async with running_app() as (app, pilot):
        await goto(pilot, "3")
        app.screen.query_one("#search-input", Input).value = "retry backoff upload queue"
        await scroll_to(pilot, "#search-go")
        await pilot.click("#search-go")
        await settle(pilot)
        summary = text_of(app.screen.query_one("#search-summary", Static))
        assert "one query is not a measurement" in summary
        assert "%" not in summary, "the tester must not invent a rate it cannot have"


# The run mode is a claim about the record --------------------------------


@run_async
async def test_a_harness_debug_attempt_is_marked_in_both_channels():
    """Only an evaluation attempt touches the scored record.

    Rendering the two identically invites reading a debug run as a scored one,
    so it is marked by text as well as by dimming: dim is invisible to a reader
    without colour, and this is exactly the distinction they most need.
    """
    from textual.widgets import DataTable as DT

    from daijin_tui.widgets import DitherBars

    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        await app.screen.show_exam("exam-0058")
        await settle(pilot)
        table = app.screen.query_one("#attempt-table", DT)
        modes = [str(table.get_row_at(i)[1]) for i in range(table.row_count)]
        assert "harness-debug" in modes, "the mode column does not say which runs were debug"
        assert "evaluation" in modes
        bars = app.screen.query_one("#exam-tokens", DitherBars)
        assert any(label.endswith("*") for label in bars.labels), (
            "no textual marker on the debug bars, so a colourless reader sees nothing"
        )
        assert "harness-debug" in bars.ceiling_label
        assert "outside the scored record" in bars.ceiling_label


@run_async
async def test_an_attempt_with_no_mode_is_not_presented_as_scored():
    """Absence of the field is not evidence of an evaluation run."""
    from textual.widgets import DataTable as DT

    from daijin_tui.widgets import DitherBars

    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        await app.screen.show_exam("exam-0058")
        await settle(pilot)
        table = app.screen.query_one("#attempt-table", DT)
        modes = [str(table.get_row_at(i)[1]) for i in range(table.row_count)]
        assert "unknown" in modes, "a row without a mode was given one"
        assert modes.count("evaluation") == 1, (
            "rows with no mode were defaulted to evaluation, which claims they were scored"
        )
        bars = app.screen.query_one("#exam-tokens", DitherBars)
        # Marked: the two harness-debug plus the one experiment. Not marked:
        # the row with no mode, and the row whose mode the contract does not
        # name, both of which are unknown rather than unscored.
        marked = [label for label in bars.labels if label.endswith("*")]
        assert len(marked) == 3, f"expected the three declared unscored attempts, saw {marked}"


@run_async
async def test_the_veto_dialog_enforces_the_bound_the_engine_enforces():
    """A rejection that only arrives from the engine makes the user retype.

    The engine requires 20 characters; the dialog used to accept one, so a
    short reason was accepted by the screen and refused by the round trip.
    """
    from daijin_tui.screens.exams import VETO_REASON_MIN

    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        await pilot.click("#exam-veto")
        await settle(pilot)
        assert isinstance(app.screen, TextPromptScreen)
        assert app.screen.min_length == VETO_REASON_MIN
        app.screen.query_one("#prompt-input", Input).value = "too short"
        await pilot.click("#prompt-ok")
        await settle(pilot)
        assert isinstance(app.screen, TextPromptScreen), "a short reason was accepted"
        assert f"At least {VETO_REASON_MIN}" in text_of(app.screen.query_one("#prompt-error", Static))
        app.screen.query_one("#prompt-input", Input).value = (
            "the statement cannot be written without leaking the fix"
        )
        await pilot.click("#prompt-ok")
        await settle(pilot)
        exam = next(e for e in app.screen.exams if e["examId"] == "exam-0058")
        assert exam["status"] == "vetoed"


@run_async
async def test_experiment_is_marked_unscored_not_dropped_into_unknown():
    """The contract names three modes and TWO sit outside the scored record.

    experiment is declared, so treating it as unknown would under-report a run
    the contract says does not count, which is the same error as calling it
    scored, only quieter.
    """
    from textual.widgets import DataTable as DT

    from daijin_tui.screens.exams import is_undeclared_mode, is_unscored
    from daijin_tui.widgets import DitherBars

    assert is_unscored({"mode": "experiment"}) is True
    assert is_unscored({"mode": "harness-debug"}) is True
    assert is_unscored({"mode": "evaluation"}) is False
    # An undeclared value is neither, in both directions.
    assert is_unscored({"mode": "sideways"}) is False
    assert is_unscored({}) is False
    assert is_undeclared_mode({"mode": "sideways"}) is True
    assert is_undeclared_mode({}) is True
    assert is_undeclared_mode({"mode": "experiment"}) is False

    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        await app.screen.show_exam("exam-0058")
        await settle(pilot)
        table = app.screen.query_one("#attempt-table", DT)
        modes = [str(table.get_row_at(i)[1]) for i in range(table.row_count)]
        assert "experiment" in modes, "experiment is not named in the column"
        # Rendered verbatim, never bucketed: the engine sent it, the screen says it.
        assert "sideways" in modes, "an undeclared mode was rewritten rather than shown"
        assert "unknown" in modes, "a row with no mode at all lost its unknown label"
        bars = app.screen.query_one("#exam-tokens", DitherBars)
        assert "experiment" in bars.ceiling_label and "harness-debug" in bars.ceiling_label, (
            f"the note does not name both unscored modes: {bars.ceiling_label!r}"
        )


