"""Test helpers.

The suite runs async code through asyncio.run rather than pulling in an async
pytest plugin, so the only dev dependency is pytest itself.
"""

from __future__ import annotations

import asyncio
import functools
from contextlib import asynccontextmanager
from typing import Any

from daijin_tui.app import DaijinApp
from daijin_tui.rpc import MockEngine, MockRpcClient

TERMINAL_SIZE = (170, 55)
DEFAULT_REPO = "/Users/owner/code/orchard-web"
SUB_75_REPO = "/Users/owner/code/lantern-ios"


def run_async(fn):
    """Run an async test body under a fresh event loop."""

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any):
        return asyncio.run(fn(*args, **kwargs))

    return wrapper


@asynccontextmanager
async def running_app(
    *,
    gate_open: bool = False,
    repo: str | None = DEFAULT_REPO,
    contract_version: str | None = None,
    deferred: dict[str, str] | None = None,
):
    """Boot the app against a zero delay mock engine.

    The spend gate defaults to blocked, matching both the product rule and the
    shipped default, so a test that wants the open path has to say so.
    """
    kwargs: dict[str, Any] = {"speed": 0.0, "gate_open": gate_open}
    if contract_version is not None:
        kwargs["contract_version"] = contract_version
    if deferred is not None:
        kwargs["deferred"] = deferred
    engine = MockEngine(**kwargs)
    client = MockRpcClient(engine)
    app = DaijinApp(client, is_mock=True, repo=repo)
    async with app.run_test(size=TERMINAL_SIZE) as pilot:
        await pilot.pause()
        await pilot.pause()
        yield app, pilot


async def settle(pilot, times: int = 8) -> None:
    """Let queued messages and stream tasks drain."""
    for _ in range(times):
        await pilot.pause()


async def goto(pilot, key: str) -> None:
    """Switch view with the keyboard, the way a user would."""
    await pilot.press(key)
    await settle(pilot)


def screen_text(app) -> str:
    """The composited text of whatever is on screen right now."""
    strips = app.screen._compositor.render_strips()
    return "\n".join("".join(segment.text for segment in strip) for strip in strips)


async def scroll_to(pilot, selector: str) -> None:
    """Bring a widget into view so a mouse click can reach it."""
    pilot.app.screen.query_one(selector).scroll_visible(animate=False)
    await settle(pilot)
