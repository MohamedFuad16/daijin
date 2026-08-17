"""Repo home. Connected repos as cards, one primary action each."""

from __future__ import annotations

import asyncio

from typing import Any, Iterable

from textual import work
from textual.containers import Horizontal, HorizontalScroll
from textual.widgets import Button, Input, Static

from ..concurrency import gather_all, gather_iter
from ..rpc import RpcError
from ..widgets import Banner, RepoCard, SectionTitle, format_count
from ..widgets.wordmark import header_mark
from .attach_dialog import AttachRepoScreen

# DERIVED, not chosen. analyze bounds its file walk with timeBudgetMs = 10_000
# (engine/src/init/analyze.js and init/walk.js), so a legitimately slow but
# BOUNDED engine can spend ten seconds inside one card and still answer. The
# card bound is that ceiling plus a margin for the rest of the call, and the
# three calls a card makes run concurrently so the walk is the dominant one.
#
# If the engine's budget moves, this should move with it: the number is the
# engine's, not mine, and an inherited round number would have fired at 8s
# before a working engine had finished.
ENGINE_WALK_BUDGET_SECONDS = 10.0
CARD_TIMEOUT_SECONDS = ENGINE_WALK_BUDGET_SECONDS + 2.0

# A SECOND, INDEPENDENT number, and it is NOT the walk budget above.
# serveStatus does not walk: its cost is an embedder probe bounded at
# PROBE_TIMEOUT_MS = 1_500 (engine/src/rag/embed.js), so its worst case is
# about 1.5s cold and milliseconds warm. This is that ceiling doubled, and it
# only decides WHEN THE WORDING CHANGES: the status block is painted before
# the call either way and this screen never gives up on it.
#
# Tying this to the 10s walk deadline would have been wrong today and would
# have misled whoever moves either number later.
ENGINE_PROBE_TIMEOUT_SECONDS = 1.5
STATUS_PATIENCE_SECONDS = ENGINE_PROBE_TIMEOUT_SECONDS * 2
from .base import DaijinScreen


class RepoHomeScreen(DaijinScreen):
    mode_name = "home"
    notice_id = "#home-notice"
    BINDINGS = [("ctrl+p", "attach_repository_root", "Attach parent repo")]
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
            yield Button("Find a repo", id="attach-browse")
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

        # THE SKELETON WAITS ON NOTHING. The status block is painted before the
        # call is even made, so the attach box is live and the screen is
        # readable while the engine is still thinking. A remote embedder that
        # accepts and never replies made serveStatus a five second call, and
        # the difference between a screen that says what it is doing and one
        # that shows a spinner is the whole complaint.
        status_block = self.query_one("#engine-status", Static)
        status_block.update("[dim]reading the engine...[/dim]")

        # fresh ONLY for an explicit refresh. The engine refuses a non-boolean
        # here with -32602 rather than coercing it, so this passes a real bool
        # and nothing else.
        fresh = self.take_user_initiated()
        params: dict[str, Any] = {"fresh": True} if fresh else {}
        if fresh:
            status_block.update("[dim]re-checking the engine, bypassing its cache...[/dim]")
        pending = asyncio.ensure_future(self.client.call("serveStatus", params))
        try:
            status = await asyncio.wait_for(asyncio.shield(pending), STATUS_PATIENCE_SECONDS)
        except asyncio.TimeoutError:
            # Still waiting, not failed. Say how long rather than implying an
            # error the engine has not reported.
            status_block.update(
                f"[yellow]the engine has not answered in {STATUS_PATIENCE_SECONDS:.0f}s. "
                f"Still waiting; the attach box below works meanwhile.[/yellow]"
            )
            try:
                status = await pending
            except RpcError as error:
                self.show_rpc_error(error, "#home-notice")
                status_block.update(f"[red]{error.hint}[/red]")
                return
        except RpcError as error:
            self.show_rpc_error(error, "#home-notice")
            status_block.update(f"[red]{error.hint}[/red]")
            return

        for repo in status.get("repos", []):
            await container.mount(RepoCard(repo))

        # STATIC CONTENT FIRST. This block used to be painted after the
        # per-repo fan-out, so a single repo whose analyze never returned left
        # the whole screen on a spinner: no status, no attach box, nothing. A
        # screen that gates its own skeleton on data is one bad repo from
        # blank, and the owner met exactly that with an attached path of "/".
        self.query_one("#engine-status", Static).update(self._engine_markup(status))
        notice = self.query_one("#home-notice", Banner)
        if status.get("repos"):
            notice.set_notice(
                f"{len(status['repos'])} repo(s) attached. Reading each one now.", "info"
            )

        # The per-repo facts are independent of each other AND of the other
        # repos, so nine calls that cost sum(latency) become one round of
        # max(latency). Each card is BOUNDED so max(latency) cannot become
        # forever: the engine being bounded tomorrow does not excuse an
        # unbounded await today, and the next call that never answers will
        # come from somewhere neither of us has looked.
        await gather_iter(self._enrich_bounded(card) for card in self.query(RepoCard))

        needs = [card.repo_path for card in self.query(RepoCard) if card.needs_brain]
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

    async def _enrich_bounded(self, card: RepoCard) -> None:
        """Enrich one card, or give up on it and say so.

        The bound is per CARD rather than per call, so a repo cannot spend the
        budget three times over.
        """
        try:
            await asyncio.wait_for(self._enrich(card), timeout=CARD_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            card.set_stalled(
                f"did not answer within {CARD_TIMEOUT_SECONDS:.0f}s, so this repo is "
                f"unread. The others are unaffected."
            )
        except Exception as error:  # noqa: BLE001 - one bad repo is not the screen
            card.set_stalled(f"could not be read: {error}")

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

        A placeholder is a CLAIM about the engine, which is why reading the
        wrong key is worse here than it was under a bare "?": this renderer
        confidently reported "not reported" for fields that were present under
        names it had stopped matching. Ambiguous was less wrong than certain.
        """
        if value is None or value == "":
            return f"[dim]{absent}[/dim]"
        return str(value)

    @classmethod
    def _engine_markup(cls, status: dict[str, Any]) -> str:
        """Render serveStatus in the words the engine used.

        Shape verified against the daemon on 2026-08-17. The key set is FIXED:
        every key is always present and unknown is null rather than absent.
        endpoint, model and dimension are CONFIGURATION rather than probe
        results, so they are real even when ollama is down; only version and
        digest go null, and hint goes non-null and names the host it probed.
        """
        ollama = status.get("ollama") or {}
        db = status.get("db") or {}
        gate = status.get("spendGate") or {}
        reachable = bool(ollama.get("reachable"))
        reach = "[green]reachable[/green]" if reachable else "[red]unreachable[/red]"
        gate_state = "[green]open[/green]" if gate.get("open") else "[yellow]blocked[/yellow]"

        lines = [
            f"ollama {reach} at {cls._said(ollama.get('endpoint'), 'no endpoint configured')}, "
            f"model {cls._said(ollama.get('model'), 'no model configured')} "
            f"dim {cls._said(ollama.get('dimension'), 'no dimension configured')}",
            f"version {cls._said(ollama.get('version'), 'not probed while unreachable')}, "
            f"digest {cls._said(ollama.get('digest'), 'not probed while unreachable')}",
            f"store {cls._said(db.get('backend'), 'not reported')} at "
            f"{cls._said(db.get('stateRoot'), 'not reported')}, "
            f"{format_count(db.get('repos'))} repos",
            f"spend gate {gate_state} at {cls._said(gate.get('path'), 'no gate file')}  "
            f"[dim]observable here before anything is attempted[/dim]",
        ]
        if not reachable:
            # The engine caches its probe for a few seconds, failures included,
            # so a check made immediately after starting ollama can still read
            # unreachable. That is the cache rather than a lie, and saying so
            # stops a user concluding the button is broken when they retry.
            lines.append(
                "[dim]this reading may be cached; ctrl+r re-checks without the "
                "cache[/dim]"
            )
        hint = ollama.get("hint")
        if hint:
            # The engine's own sentence, and it names the host it actually
            # probed. Paraphrasing it here would let this line contradict the
            # endpoint printed directly above it.
            lines.insert(1, f"[yellow]{hint}[/yellow]")
        return "\n".join(lines)

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "attach-browse":
            self.browse_and_attach()
        elif event.button.id == "attach-go":
            event.stop()
            await self.attach_repo()

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "attach-input":
            event.stop()
            await self.attach_repo()

    @work
    async def browse_and_attach(self) -> None:
        """The dialog: discovered repos, a path, or a URL to clone.

        The URL route is offered only when the engine answers for repoClone.
        Probing costs one refused call and buys a dialog that never shows a
        control that cannot work.
        """
        notice = self.query_one("#home-notice", Banner)
        roots: list[str] = []
        try:
            settings = await self.client.call("settingsGet", {})
            roots = list(settings.get("repoScanRoots") or [])
        except RpcError as error:
            # The Path tab still works without roots, so this is a degraded
            # dialog rather than a blocked one.
            self.report_rpc_error(error)

        clone_available, reason = await self._clone_available()
        choice = await self.app.push_screen_wait(
            AttachRepoScreen(
                roots=roots,
                clone_available=clone_available,
                clone_unavailable_reason=reason,
            )
        )
        if not choice:
            return
        if choice["kind"] == "path":
            self.query_one("#attach-input", Input).value = choice["value"]
            await self.attach_repo()
            return
        await self._clone(choice["value"])

    async def _clone_available(self) -> tuple[bool, str]:
        """Ask the engine whether it can clone, without cloning anything.

        A deliberately invalid URL: a method that is not built answers -32001
        with a phase, and one that is built refuses the argument with -32602.
        The refusal IS the capability answer.
        """
        try:
            await self.client.call("repoClone", {"url": ""})
        except RpcError as error:
            if error.is_not_implemented:
                return False, error.hint
            return True, ""
        except Exception:  # noqa: BLE001 - a transport failure is not a verdict
            return False, "Could not reach the engine to ask whether it can clone."
        return True, ""

    @work
    async def _clone(self, url: str) -> None:
        notice = self.query_one("#home-notice", Banner)
        try:
            result = await self.client.call("repoClone", {"url": url})
        except RpcError as error:
            self.report_rpc_error(error)
            notice.set_notice(error.hint, "error")
            return
        self.clone_job_id = result.get("jobId")
        notice.set_notice(
            f"Cloning {url}, job {self.clone_job_id}. It is attached when the clone ends.",
            "info",
        )

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
        attached = (result.get("repo") or {}).get("path", path)
        # Attaching IS selecting. The card click sets selected_repo and this
        # path did not, so a user who attached and pressed 2 was told "no repo
        # selected" over a repo they had just attached - the field test hit
        # exactly that. One action, one meaning.
        self.app.selected_repo = attached
        # repoAttach returns { repo, warning }, and the warning is not a
        # refusal: the attach SUCCEEDED. Verified shape on 2026-08-17.
        warning = result.get("warning")
        if warning:
            root = warning.get("repositoryRoot")
            self.pending_repository_root = root
            offer = (
                f" Press ctrl+p to attach {root} instead."
                if root
                else ""
            )
            # The engine's own sentence, then the way out of the mistake. The
            # field test stalled exactly here, on a user being told what was
            # wrong and left to retype the path themselves.
            self.set_pending_notice(
                f"Attached {attached}, with a warning: {warning.get('detail', warning.get('code', ''))}{offer}",
                "warn",
            )
        else:
            self.pending_repository_root = None
            self.set_pending_notice(f"Attached {attached}.")
        self.start_load()

    async def action_attach_repository_root(self) -> None:
        """Attach the real repository root the last warning named.

        Carried so the owner does not have to retype a path the engine already
        worked out, which is where the field test stalled.
        """
        root = getattr(self, "pending_repository_root", None)
        notice = self.query_one("#home-notice", Banner)
        if not root:
            notice.set_notice(
                "No repository root was offered. This acts on the last attach warning.",
                "info",
            )
            return
        self.query_one("#attach-input", Input).value = root
        self.pending_repository_root = None
        await self.attach_repo()

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
