"""Screens paint before their data arrives, and say so while they wait.

Awaiting load() in on_mount blocked the mount for the whole round trip. That
cost nothing against the mock and a frozen frame against a daemon. These tests
gate the RPC on an event rather than a sleep, so they assert ordering rather
than racing a timer.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from conftest import DEFAULT_REPO, run_async, settle

from daijin_tui.app import DaijinApp
from daijin_tui.rpc import MockEngine, MockRpcClient

SCREEN_DIR = Path(__file__).resolve().parents[1] / "daijin_tui" / "screens"


class GatedClient(MockRpcClient):
    """Every call blocks until the test releases it. No sleeps, no flakes."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.gate = asyncio.Event()
        self.entered = asyncio.Event()

    async def _call_impl(self, method, params=None):
        self.entered.set()
        await self.gate.wait()
        return await super()._call_impl(method, params)

    def release(self) -> None:
        self.gate.set()


async def _app_with(client):
    app = DaijinApp(client, is_mock=True, repo=DEFAULT_REPO)
    return app


async def turns(count: int = 6) -> None:
    """Give the loop a few turns WITHOUT waiting for idle.

    pilot.pause() waits for the app to settle, which never happens while a
    worker is deliberately blocked. These tests hold work open on purpose, so
    they step the loop instead of waiting for quiet.
    """
    for _ in range(count):
        await asyncio.sleep(0)


@run_async
async def test_a_screen_paints_before_its_data_arrives():
    client = GatedClient(MockEngine(speed=0.0))
    client.release()  # let the handshake and the home screen through
    app = await _app_with(client)
    async with app.run_test(size=(170, 55)) as pilot:
        await pilot.pause()
        await app.screen.wait_for_load()

        # From here, every call hangs until released.
        client.gate.clear()
        client.entered.clear()
        await pilot.press("8")
        await turns()

        screen = app.screen
        assert type(screen).__name__ == "SettingsScreen", "the screen mounted"
        body = list(screen.query("#screen-body"))
        assert body, "the body exists while the data does not"
        assert any(widget.loading for widget in body), (
            "the screen mounted without showing that it is waiting; a user "
            "cannot tell that from a screen with no data"
        )
        assert screen.load_count == 0, "load finished, so this proves nothing"

        client.release()
        await screen.wait_for_load()
        await settle(pilot)
        assert screen.load_count == 1
        assert not any(widget.loading for widget in screen.query("#screen-body")), (
            "the loading state outlived the load"
        )


@run_async
async def test_the_app_stays_responsive_while_a_screen_loads():
    """A blocked load must not block navigation."""
    client = GatedClient(MockEngine(speed=0.0))
    client.release()
    app = await _app_with(client)
    async with app.run_test(size=(170, 55)) as pilot:
        await pilot.pause()
        await app.screen.wait_for_load()

        client.gate.clear()
        # switch_mode is what the key binding invokes. pilot.press is avoided
        # here only because it waits for the app to go idle, which never happens
        # while this test is deliberately holding a load open; that is a harness
        # property, not app behaviour.
        app.switch_mode("exams")
        await turns()
        assert app.current_mode == "exams"
        assert app.screen.load_count == 0, "the exams load finished, so nothing is held open"

        # Still mid-load, and the user changes their mind.
        app.switch_mode("board")
        await turns()
        assert app.current_mode == "board", (
            "navigation was blocked by an in-flight load, which is the frozen "
            "frame this strand exists to remove"
        )
        client.release()
        await turns(20)


@run_async
async def test_reload_does_not_block_either():
    client = GatedClient(MockEngine(speed=0.0))
    client.release()
    app = await _app_with(client)
    async with app.run_test(size=(170, 55)) as pilot:
        await pilot.pause()
        await app.screen.wait_for_load()
        first = app.screen.load_count

        client.gate.clear()
        await pilot.press("ctrl+r")
        await turns()
        assert app.screen.load_count == first, "reload completed synchronously"
        assert any(w.loading for w in app.screen.query("#screen-body"))

        client.release()
        await app.screen.wait_for_load()
        assert app.screen.load_count == first + 1


def test_on_mount_starts_the_load_without_awaiting_it():
    """A blocking mount fails these tests only by HANGING, which is a poor
    signal in CI. This catches the regression as a fast, readable failure.
    """
    import inspect

    from daijin_tui.screens.base import DaijinScreen

    source = inspect.getsource(DaijinScreen.on_mount)
    assert "self.start_load()" in source, "on_mount no longer schedules the load"
    assert "await" not in source, (
        "on_mount awaits something; the mount is blocked again and every view "
        "switch costs a full round trip before the screen appears"
    )


def test_no_screen_awaits_its_own_load_from_a_handler():
    """Static guard: on_mount must never await load() again.

    The behavioural tests above would catch a regression, but only for the
    screens they exercise. This catches it for every screen, including ones
    added later.
    """
    offenders = []
    for path in sorted(SCREEN_DIR.glob("*.py")):
        source = path.read_text(encoding="utf-8")
        if "await self.load()" not in source:
            continue
        # base.py's worker body is the one legitimate await: it IS the worker.
        if path.name == "base.py" and "async def _load_with_indicator" in source:
            continue
        offenders.append(path.name)
    assert not offenders, (
        f"{offenders} await load() directly; use start_load() so the wait is "
        "visible rather than frozen"
    )


@run_async
async def test_an_action_confirmation_survives_the_reload_it_triggers():
    """load() recomputes state; "you just detached that" is not state.

    Setting the banner and then triggering a refetch let the refetch's own
    banner overwrite the confirmation, so the user's action acknowledged itself
    and then silently un-acknowledged.
    """
    from textual.widgets import Input

    from daijin_tui.widgets import Banner, RepoCard

    client = MockRpcClient(MockEngine(speed=0.0))
    app = await _app_with(client)
    async with app.run_test(size=(170, 55)) as pilot:
        await pilot.pause()
        await app.screen.wait_for_load()
        screen = app.screen

        screen.query_one("#attach-input", Input).value = "/Users/owner/code/newthing"
        await pilot.click("#attach-go")
        await screen.wait_for_load()
        await settle(pilot)
        assert "Attached" in str(screen.query_one("#home-notice", Banner).render())

        card = next(c for c in screen.query(RepoCard) if c.repo_path.endswith("newthing"))
        await pilot.click(card.query_one(".card-detach"))
        await screen.wait_for_load()
        await settle(pilot)
        notice = str(screen.query_one("#home-notice", Banner).render())
        assert "Detached" in notice, "the reload overwrote the confirmation"
        assert "untouched" in notice
