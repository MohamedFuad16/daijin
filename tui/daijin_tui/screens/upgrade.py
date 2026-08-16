"""Shown when the engine speaks a different contract version than this client.

The contract says a mismatch renders an upgrade screen, not a method error,
because a client that limps along against an unknown surface produces wrong
screens rather than an honest stop.
"""

from __future__ import annotations

from typing import Any

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Footer, Header, Static

from ..rpc import SUPPORTED_CONTRACT_VERSION


class UpgradeScreen(Screen):
    """A dead end on purpose. No RPC call is made from here."""

    BINDINGS = [("q", "quit", "Quit")]

    def __init__(self, *, engine_version: str | None, contract_version: str | None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.engine_version = engine_version
        self.contract_version = contract_version

    def compose(self) -> ComposeResult:
        yield Header()
        with Vertical(id="upgrade-body"):
            yield Static("[b]Contract version mismatch[/b]", markup=True, id="upgrade-title")
            yield Static(
                f"This client is built against contract version "
                f"[b]{SUPPORTED_CONTRACT_VERSION}[/b].\n"
                f"The engine reports contract version [b]{self.contract_version or 'none'}[/b], "
                f"engine version {self.engine_version or 'unknown'}.",
                markup=True,
                id="upgrade-detail",
            )
            yield Static(
                "No screens are rendered against an unknown surface. A client that guesses "
                "at a changed method shows numbers it cannot stand behind, so it stops here "
                "instead.\n\n"
                "Upgrade whichever side is behind, then reconnect.",
                id="upgrade-advice",
            )
        yield Footer()
