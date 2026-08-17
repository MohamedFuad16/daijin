"""Repo home. Connected repos as cards, one primary action each."""

from __future__ import annotations

from typing import Any, Iterable

from textual.containers import Horizontal, HorizontalScroll
from textual.widgets import Button, Input, Static

from ..concurrency import gather_all, gather_iter
from ..rpc import RpcError
from ..widgets import Banner, RepoCard, SectionTitle, format_count
from ..widgets.wordmark import header_mark
from .base import DaijinScreen


class RepoHomeScreen(DaijinScreen):
    mode_name = "home"
    notice_id = "#home-notice"
    heading = "Repo home"
    subheading = "connected repos, health, measured floor"

    def content(self) -> Iterable[Any]:
        # The mark, persistent. The splash is a moment; this is the brand
        # staying put, and it is the same object in a size a header can hold.
        # Sized at compose time and re-sized on resize, because a mark that
        # wraps is not a smaller mark, it is a broken one.
        yield Static("", id="home-wordmark", markup=False)
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

    def on_mount(self) -> None:
        self._draw_wordmark()

    def on_resize(self, event: Any) -> None:
        self._draw_wordmark()

    def _draw_wordmark(self) -> None:
        try:
            mark = self.query_one("#home-wordmark", Static)
        except Exception:  # noqa: BLE001 - before compose has mounted it
            return
        width = self.size.width or 0
        lines = header_mark(width)
        mark.update("\n".join(lines))
        # A mark that could not be drawn takes no vertical space either, so a
        # narrow terminal loses the brand rather than losing a row of content.
        mark.display = bool(lines)

    async def load(self) -> None:
        self._draw_wordmark()
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
        if not status.get("repos"):
            # Nothing is attached, so there are no cards to look at and the
            # only useful thing on this screen is the attach box. The splash is
            # the moment a brand new user is oriented; landing them on empty
            # space wastes it.
            from textual.widgets import Input

            self.query_one("#attach-input", Input).focus()
            notice.set_notice(
                "No repos attached yet. Give Daijin a path below and it will read the "
                "repo, build a brain for it, and measure what it can retrieve.",
                "info",
            )
            return
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
    def _said(value: Any, absent: str) -> str:
        """A field the engine did not report, said in words.

        A bare "?" reads as a rendering fault rather than as a state, and it
        was doing double duty for two different absences: a key the response
        omitted and a key whose value was null. The default in .get() only
        covered the first, so a null printed the word None.
        """
        if value is None or value == "":
            return f"[dim]{absent}[/dim]"
        return str(value)

    @classmethod
    def _engine_markup(cls, status: dict[str, Any]) -> str:
        ollama = status.get("ollama") or {}
        db = status.get("db") or {}
        gate = status.get("spendGate") or {}
        reachable = bool(ollama.get("reachable"))
        reach = "[green]reachable[/green]" if reachable else "[red]unreachable[/red]"
        gate_state = "[green]open[/green]" if gate.get("open") else "[yellow]blocked[/yellow]"
        # An unreachable embedder has no endpoint or dimension to report, and
        # saying so is different from saying the engine failed to tell us.
        missing = "not reachable" if not reachable else "not reported"
        size = db.get("sizeBytes")
        return (
            f"ollama {reach} at {cls._said(ollama.get('endpoint'), missing)}, "
            f"embedder {cls._said(ollama.get('embedder'), missing)} "
            f"dim {cls._said(ollama.get('dimension'), missing)}\n"
            f"store {cls._said(db.get('driver'), 'not reported')} at "
            f"{cls._said(db.get('path'), 'no store yet')}, "
            f"{format_count(size) if size is not None else '[dim]size not measured yet[/dim]'}"
            f"{' bytes' if size is not None else ''}, "
            f"index digest {cls._said(db.get('indexDigest'), 'not measured yet')}\n"
            f"spend gate {gate_state} at {cls._said(gate.get('path'), 'no gate file')}  "
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
