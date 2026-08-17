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

    def __init__(
        self,
        *,
        engine_version: str | None,
        contract_version: str | None,
        connection_error: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.engine_version = engine_version
        self.contract_version = contract_version
        # Set when the handshake never completed. Then this screen knows
        # nothing about the contract and must not claim a mismatch.
        self.connection_error = connection_error

    def compose(self) -> ComposeResult:
        yield Header()
        with Vertical(id="upgrade-body"):
            if self.connection_error:
                # The handshake never answered, so no contract version was ever
                # read. Reporting a mismatch here would name the wrong problem
                # and hide the stderr tail the transport preserved.
                yield Static("[b]Could not reach the engine[/b]", markup=True, id="upgrade-title")
                yield Static(self.connection_error, id="upgrade-detail")
                yield Static(
                    "The handshake never completed, so this client has not read a contract "
                    "version and is not claiming one is wrong. Fix the connection above and "
                    "start again.",
                    id="upgrade-advice",
                )
            else:
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
