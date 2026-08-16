"""Repo home. Connected repos as cards, one primary action each."""

from __future__ import annotations

from typing import Any, Iterable

from textual.containers import Horizontal, HorizontalScroll
from textual.widgets import Button, Input, Static

from ..concurrency import gather_all, gather_iter
from ..rpc import RpcError
from ..widgets import Banner, RepoCard, SectionTitle, format_count
from .base import DaijinScreen


class RepoHomeScreen(DaijinScreen):
    mode_name = "home"
    notice_id = "#home-notice"
    heading = "Repo home"
    subheading = "connected repos, health, measured floor"

    def content(self) -> Iterable[Any]:
        yield SectionTitle("Connected repos", "click a card, or tab and press enter")
        # Scrollable, not a plain row. Four cards at 42 columns already exceed
        # a 170 column terminal, and a card past the right edge is reachable by
        # neither the mouse nor the keyboard, which fails the one acceptance
        # rule that covers every screen.
        yield HorizontalScroll(id="repo-cards")
        with Horizontal(id="attach-row"):
            yield Input(placeholder="path to a repo to attach", id="attach-input")
            yield Button("Attach repo", id="attach-go", variant="primary")
        yield SectionTitle("Engine status")
        yield Static("", id="engine-status", markup=True)
        yield Banner("", tone="info", id="home-notice")

    async def load(self) -> None:
        container = self.query_one("#repo-cards", HorizontalScroll)
        await container.remove_children()
        try:
            status = await self.client.call("serveStatus", {})
        except RpcError as error:
            self.show_rpc_error(error, "#home-notice")
            return

        for repo in status.get("repos", []):
            await container.mount(RepoCard(repo))

        # The per-repo facts are independent of each other AND of the other
        # repos, so nine calls that cost sum(latency) become one round of
        # max(latency). This is the boot screen: it is the first thing a user
        # waits on, so it is the first thing worth not making them wait for.
        await gather_iter(self._enrich(card) for card in self.query(RepoCard))

        self.query_one("#engine-status", Static).update(self._engine_markup(status))
        needs = [card.repo_path for card in self.query(RepoCard) if card.needs_brain]
        notice = self.query_one("#home-notice", Banner)
        if needs:
            notice.set_notice(
                f"{len(needs)} repo without a brain: {', '.join(needs)}. Initialize brain is the only action offered.",
                "warn",
            )
        else:
            notice.set_notice("Every connected repo has a brain.", "info")

    async def _enrich(self, card: RepoCard) -> None:
        """Fill in the facts the card needs beyond serveStatus.

        hasBrainFolder comes from analyze, the current case rate from
        retrievalScore, and the trend line from scoreHistory. All three are
        contract methods and all three are zero-spend. The budget sweep is NOT
        drawn here: it belongs to the retrieval view, under its own caption.
        """
        await gather_all(
            self._has_brain(card),
            self._floor(card),
            self._history(card),
        )

    async def _has_brain(self, card: RepoCard) -> None:
        try:
            analysis = await self.client.call("analyze", {"repoPath": card.repo_path})
        except RpcError:
            return
        card.set_has_brain(bool(analysis.get("hasBrainFolder")))

    async def _floor(self, card: RepoCard) -> None:
        try:
            card.set_score(await self.client.call("retrievalScore", {"repoPath": card.repo_path}))
        except RpcError:
            # No gold set means no floor. The card already says so.
            pass

    async def _history(self, card: RepoCard) -> None:
        try:
            card.set_history(await self.client.call("scoreHistory", {"repoPath": card.repo_path}))
        except RpcError:
            # Never measured. The sparkline says so rather than drawing a flat line.
            pass

    @staticmethod
    def _engine_markup(status: dict[str, Any]) -> str:
        ollama = status.get("ollama") or {}
        db = status.get("db") or {}
        gate = status.get("spendGate") or {}
        reach = "[green]reachable[/green]" if ollama.get("reachable") else "[red]unreachable[/red]"
        gate_state = "[green]open[/green]" if gate.get("open") else "[yellow]blocked[/yellow]"
        return (
            f"ollama {reach} at {ollama.get('endpoint', '?')}, embedder {ollama.get('embedder', '?')} "
            f"dim {ollama.get('dimension', '?')}\n"
            f"store {db.get('driver', '?')} at {db.get('path', '?')}, "
            f"{format_count(db.get('sizeBytes'))} bytes, index digest {db.get('indexDigest', '?')}\n"
            f"spend gate {gate_state} at {gate.get('path', '?')}  "
            f"[dim]observable here before anything is attempted[/dim]"
        )

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "attach-go":
            event.stop()
            await self.attach_repo()

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "attach-input":
            event.stop()
            await self.attach_repo()

    async def attach_repo(self) -> None:
        field = self.query_one("#attach-input", Input)
        path = field.value.strip()
        notice = self.query_one("#home-notice", Banner)
        if not path:
            notice.set_notice("Type a repo path to attach.", "warn")
            return
        try:
            result = await self.client.call("repoAttach", {"repoPath": path})
        except RpcError as error:
            self.report_rpc_error(error)
            notice.set_notice(error.hint, "error")
            return
        field.value = ""
        self.set_pending_notice(f"Attached {result.get('repo', {}).get('path', path)}.")
        self.start_load()

    async def on_repo_card_selected(self, message: RepoCard.Selected) -> None:
        message.stop()
        self.app.selected_repo = message.repo.get("path")
        self.app.switch_mode("brain")

    async def on_repo_card_init_requested(self, message: RepoCard.InitRequested) -> None:
        message.stop()
        self.app.selected_repo = message.repo.get("path")
        self.app.switch_mode("init")

    async def on_repo_card_detach_requested(self, message: RepoCard.DetachRequested) -> None:
        message.stop()
        path = message.repo.get("path")
        try:
            await self.client.call("repoDetach", {"repoPath": path})
        except RpcError as error:
            self.report_rpc_error(error)
            return
        if self.app.selected_repo == path:
            self.app.selected_repo = None
        self.set_pending_notice(f"Detached {path}. The brain store on disk is untouched.")
        self.start_load()
