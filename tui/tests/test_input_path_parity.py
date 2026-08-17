"""Symmetric-input-path divergence: the review's named pattern, kept as a suite.

Keyboard, mouse and sibling screens implementing the same intent differently,
tested only where they agreed. Every test here was written as a reproduction
that FAILED before its fix, and each fix was mutated back to confirm the test
kills it. The names keep the reproduction numbering so a reader can find the
finding they came from.
"""
from __future__ import annotations

import pytest
from conftest import DEFAULT_REPO, goto, run_async, running_app, settle
from test_screens import text_of

from daijin_tui import mock_data
from daijin_tui.widgets import Banner, PhaseChecklist, RadarChart, RepoCard


@run_async
async def test_f1_spend_dialog_uses_fixture_data():
    """The consent dialog must name what the USER chose, from the engine.

    Two properties, both about a paid surface: with nothing selected there is
    no dialog at all, and with a selection the dialog names THAT exam rather
    than whichever one happens to be first in a fixture table.
    """
    from daijin_tui.screens.dialogs import SpendConfirmScreen
    from textual.widgets import Select

    async with running_app(gate_open=True) as (app, pilot):
        await goto(pilot, "5")
        app.selected_repo = None
        await pilot.click("#gym-start")
        await settle(pilot, 12)
        assert not isinstance(app.screen, SpendConfirmScreen), (
            "a spend dialog opened for a repo the user never chose"
        )
        assert "No repo selected" in text_of(app.screen.query_one("#gym-notice", Banner))

    async with running_app(gate_open=True) as (app, pilot):
        await goto(pilot, "5")
        select = app.screen.query_one("#gym-exam", Select)
        options = [v for v in (getattr(select, "_options", None) or []) if isinstance(v, tuple)]
        options = [v for _, v in options if isinstance(v, str)]
        assert len(options) > 1, f"need two exams to tell picked from first: {options}"
        chosen = options[1]
        select.value = chosen
        await settle(pilot)
        await pilot.click("#gym-start")
        await settle(pilot, 12)
        assert isinstance(app.screen, SpendConfirmScreen)
        body = " ".join(text_of(w) for w in app.screen.query("Static"))
        assert chosen in body, f"the dialog does not name the chosen exam {chosen}: {body[:200]!r}"
        assert options[0] not in body, (
            f"the dialog names the FIRST exam {options[0]} rather than the chosen one"
        )


@run_async
async def test_f2_terminal_phase_constant_ignored():
    """complete/finished are terminal too; the banners only know 'done'."""
    from daijin_tui.widgets.activity import TERMINAL_PHASES

    async with running_app() as (app, pilot):
        await goto(pilot, "2")
        screen = app.screen
        screen.job_id = "job-init-0001"
        screen.query_one("#init-checklist", PhaseChecklist).reset("job-init-0001")
        screen._render_events([
            {"ts": 0, "jobId": "job-init-0001", "phase": "complete", "step": "failed",
             "detail": "the embedder refused", "level": "error"},
        ])
        await settle(pilot)
        notice = text_of(screen.query_one("#init-notice", Banner))
        assert "complete" in TERMINAL_PHASES
        assert "FAILED" in notice, f"a terminal phase that is not 'done' was ignored: {notice!r}"


@run_async
async def test_f4_exams_load_only_catches_rpcerror():
    """A ConnectionError must not become AttributeError in the worker."""
    from daijin_tui.rpc import RpcError

    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        original = app.client.call

        async def boom(method, params=None):
            if method == "examList":
                raise ConnectionError("the engine exited without answering")
            return await original(method, params)

        app.client.call = boom
        try:
            app.screen.start_load()
            await app.screen.wait_for_load()
            await settle(pilot)
        finally:
            app.client.call = original
        notice = text_of(app.screen.query_one("#exam-notice", Banner))
        assert "exited without answering" in notice or "engine" in notice.lower(), (
            f"a transport failure was not reported to the user: {notice!r}"
        )


@run_async
async def test_f5_radar_click_does_not_persist():
    """r persists the mode; a click must not silently revert."""
    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        await settle(pilot, 10)
        radar = app.screen.query_one(RadarChart)
        radar.on_click()
        await settle(pilot)
        clicked = radar.mode
        app.screen.start_load()
        await app.screen.wait_for_load()
        await settle(pilot)
        assert app.screen.query_one(RadarChart).mode == clicked, (
            "the mouse-set mode reverted on reload while the keyboard's would not"
        )


@run_async
async def test_f6_card_body_click_ignores_needs_brain():
    """Enter routes a brainless card to init; a body click must agree."""
    async with running_app() as (app, pilot):
        card = next(c for c in app.screen.query(RepoCard) if c.needs_brain)
        card.focus()
        await settle(pilot)
        await pilot.press("enter")
        await settle(pilot)
        by_key = app.current_mode
        assert by_key == "init", f"the keyboard path changed: {by_key}"

    async with running_app() as (app, pilot):
        card = next(c for c in app.screen.query(RepoCard) if c.needs_brain)
        await pilot.click(card.query_one(".card-path"))
        await settle(pilot)
        assert app.current_mode == "init", (
            f"a body click on a brainless card went to {app.current_mode!r} "
            f"while Enter on the same card goes to 'init'"
        )


@run_async
async def test_f7_gates_editor_escape_is_dead():
    """Escape is bound; the action must exist for it to do anything."""
    from daijin_tui.screens.dialogs import GatesFileEditScreen

    assert hasattr(GatesFileEditScreen, "action_cancel"), (
        "escape is bound to an action this modal never implements"
    )


@run_async
async def test_f3_connection_failure_reported_as_version_mismatch():
    """A handshake that never completed says nothing about the contract.

    Every startup failure was caught into a write-only attribute and then fell
    through to the version check, so "port in use" rendered as "Contract
    version mismatch" and the stderr tail the transports preserve was discarded
    at the last hop.
    """
    from daijin_tui.app import DaijinApp
    from daijin_tui.rpc import MockEngine, MockRpcClient
    from daijin_tui.screens import UpgradeScreen

    client = MockRpcClient(MockEngine(speed=0.0))

    async def refuse():
        raise ConnectionError("the engine exited without answering: EADDRINUSE port 7420")

    client.handshake = refuse
    app = DaijinApp(client, is_mock=True, repo=DEFAULT_REPO)
    async with app.run_test(size=(170, 55)) as pilot:
        await settle(pilot, 10)
        assert isinstance(app.screen, UpgradeScreen)
        body = " ".join(text_of(w) for w in app.screen.query("Static"))
        assert "EADDRINUSE" in body, f"the real error was discarded: {body[:200]!r}"
        assert "Contract version mismatch" not in body, (
            "a connection failure was reported as a version mismatch"
        )
    await client.aclose()
