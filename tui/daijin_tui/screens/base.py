"""Shared screen chrome: the nav bar every view carries and the base screen."""

from __future__ import annotations

from typing import Any, Iterable, Sequence

from textual.app import ComposeResult
from textual.containers import Horizontal, VerticalScroll
from textual.screen import Screen
from textual.widgets import Button, Footer, Header, Static

from ..rpc import RpcError
from ..widgets.activity import EventLog
from .dialogs import SpendConfirmScreen

# Order matches the number keys, so 1 through 8 and the mouse reach the same
# views. Settings is reachable from everywhere, as the owner asked.
NAV_ITEMS: list[tuple[str, str]] = [
    ("home", "1 Repos"),
    ("init", "2 Init"),
    ("brain", "3 Brain"),
    ("gates", "4 Gates"),
    ("gym", "5 Gym"),
    ("exams", "6 Exams"),
    ("board", "7 Board"),
    ("settings", "8 Settings"),
]


class NavBar(Horizontal):
    """Clickable navigation. Every entry is also a number key binding."""

    def __init__(self, active: str, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.active = active
        self.add_class("nav-bar")

    def compose(self) -> ComposeResult:
        for key, label in NAV_ITEMS:
            button = Button(label, id=f"nav-{key}", classes="nav-button")
            if key == self.active:
                button.add_class("nav-active")
            yield button

    def on_button_pressed(self, event: Button.Pressed) -> None:
        button_id = event.button.id or ""
        if button_id.startswith("nav-"):
            event.stop()
            self.app.switch_mode(button_id[4:])


class DaijinScreen(Screen):
    """Base screen: header, nav bar, scrolling body, footer.

    Subclasses implement content() and, optionally, an async load().
    """

    mode_name: str = ""
    heading: str = ""
    subheading: str = ""
    # How many times load() has completed. Lets a test wait for data without
    # sleeping, and lets a screen tell "never loaded" from "loaded, empty".
    load_count: int = 0
    # Banner a screen uses for its own state, if it has one. A confirmation of
    # a user action is queued here so the reload that follows cannot overwrite
    # it: load() recomputes state, and "you just detached that repo" is not
    # state, it is an event the user needs to see survive the refresh.
    notice_id: str | None = None

    BINDINGS = [
        ("1", "goto('home')", "Repos"),
        ("2", "goto('init')", "Init"),
        ("3", "goto('brain')", "Brain"),
        ("4", "goto('gates')", "Gates"),
        ("5", "goto('gym')", "Gym"),
        ("6", "goto('exams')", "Exams"),
        ("7", "goto('board')", "Board"),
        ("8", "goto('settings')", "Settings"),
        ("ctrl+r", "reload", "Reload"),
        # Most tokens in the step stream are paths, so the truncation the
        # columns need is undoable rather than a policy the reader must accept.
        ("ctrl+t", "toggle_detail_truncation", "Full paths"),
    ]

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        yield NavBar(self.mode_name)
        yield Static(self._heading_markup(), markup=True, id="screen-heading")
        with VerticalScroll(id="screen-body"):
            yield from self.content()
        yield Footer()

    def action_toggle_detail_truncation(self) -> None:
        """Show step-event details whole, or back inside their column.

        Applies to the rows ALREADY on screen, because a setting that only
        affected future events would leave the path the reader is looking at
        exactly as shortened as it was.
        """
        logs = list(self.query(EventLog))
        if not logs:
            self._say("This screen has no step-event stream to expand.")
            return
        wanted = not logs[0].truncate
        for log in logs:
            log.set_truncate(wanted)
        self._say(
            "Step details shortened to fit their column again."
            if wanted
            else "Step details shown in full; long paths scroll rather than shorten."
        )

    def _say(self, text: str, tone: str = "info") -> None:
        """Put a line in this screen's banner, if it has one."""
        if not self.notice_id:
            self.app.notify(text)
            return
        for banner in self.query(self.notice_id):
            banner.set_notice(text, tone)

    def _heading_markup(self) -> str:
        line = f"[b]{self.heading}[/b]"
        if self.subheading:
            line += f"  [dim]{self.subheading}[/dim]"
        repo = getattr(self.app, "selected_repo", None)
        if repo:
            line += f"  [dim]repo {repo}[/dim]"
        if getattr(self.app, "is_mock", False):
            line += "  [reverse] MOCK ENGINE [/reverse]"
        return line

    def content(self) -> Iterable[Any]:  # pragma: no cover - overridden
        return ()

    async def load(self) -> None:  # pragma: no cover - overridden
        return None

    async def on_mount(self) -> None:
        self.start_load()

    def set_pending_notice(self, text: str, tone: str = "info") -> None:
        self._pending_notice = (text, tone)

    def start_load(self) -> None:
        """Load off the UI thread, with the wait visible rather than frozen.

        Awaiting load() in on_mount blocked the mount for the whole round trip.
        Against the mock that was free; against a daemon it is a frozen frame on
        every view switch. The work runs in a worker and the body carries a
        loading state, so the user sees "fetching" instead of a dead screen.
        """
        self._loading_worker = self.run_worker(
            self._load_with_indicator(), exclusive=True, group="screen-load"
        )

    async def _load_with_indicator(self) -> None:
        body = self.query("#screen-body")
        for widget in body:
            widget.loading = True
        try:
            await self.load()
        finally:
            for widget in body:
                widget.loading = False
            self.load_count += 1
            pending = getattr(self, "_pending_notice", None)
            if pending and self.notice_id:
                self._pending_notice = None
                for banner in self.query(self.notice_id):
                    banner.set_notice(*pending)

    async def wait_for_load(self) -> None:
        """Await the in-flight load. For tests and for code that needs the data."""
        worker = getattr(self, "_loading_worker", None)
        if worker is not None:
            await worker.wait()

    def action_goto(self, mode: str) -> None:
        self.app.switch_mode(mode)

    def action_reload(self) -> None:
        self.start_load()

    # Helpers -------------------------------------------------------------

    @property
    def client(self) -> Any:
        return self.app.client

    @staticmethod
    def describe_rpc_error(error: RpcError) -> tuple[str, str]:
        """Turn an engine error into display text and a banner tone.

        A deferred capability is not a failure. The engine answers -32001 with
        the phase that ships it, so the screen says "not built yet, arriving in
        P4" rather than showing a red error over an empty table, which a user
        cannot tell apart from "there is nothing here".
        """
        if error.is_not_implemented:
            # The prefix only sets the tone. The engine's hint is deliberately
            # self-contained so a client that renders it raw still gets the
            # phase, so repeating the phase here would say it twice.
            return (f"Not built yet. {error.hint}", "info")
        if error.is_spend_gate:
            return (error.hint, "warn")
        return (error.hint, "error")

    def report_rpc_error(self, error: RpcError) -> None:
        """Show the engine's hint verbatim. Never paraphrase it."""
        if error.is_not_implemented:
            self.app.notify(
                error.hint,
                title=f"not built yet{f' ({error.phase})' if error.phase else ''}",
                severity="information",
                timeout=8,
            )
            return
        title = f"engine error {error.code}"
        if error.is_spend_gate:
            title = f"spend refused ({error.gate})"
        self.app.notify(error.hint, title=title, severity="error", timeout=10)

    def show_rpc_error(self, error: RpcError, banner_id: str) -> None:
        """Report an error AND leave it on screen, so nothing reads as empty."""
        self.report_rpc_error(error)
        text, tone = self.describe_rpc_error(error)
        for banner in self.query(banner_id):
            banner.set_notice(text, tone)

    async def confirm_spend(
        self,
        *,
        method: str,
        summary: str,
        estimate_lines: Sequence[str] = (),
        confirm_label: str = "Spend on this call",
    ) -> bool:
        """Gate one paid call behind an explicit user action.

        Returns False unless the user confirmed, so every path that skips the
        dialog also skips the spend.
        """
        return bool(
            await self.app.push_screen_wait(
                SpendConfirmScreen(
                    method=method,
                    summary=summary,
                    estimate_lines=estimate_lines,
                    confirm_label=confirm_label,
                )
            )
        )

    # Streaming screens ---------------------------------------------------

    job_id: str | None = None

    def accepts_step_event(self, event: dict[str, Any]) -> bool:
        """True only for the job THIS screen started.

        Under a shared daemon, step events are broadcast to every attached
        client, so a screen that renders whatever arrives will narrate another
        window's job as its own: it adopts the foreign jobId, advances its
        checklist, and finishes by claiming the job completed for the repo THIS
        screen is pointed at. Matching strictly is the only safe rule; an idle
        screen showing nothing is correct, because it started nothing.
        """
        job = event.get("jobId")
        if self.job_id and job == self.job_id:
            return True
        if job and job != self.job_id:
            self.note_foreign_job(str(job))
        return False

    def note_foreign_job(self, job_id: str) -> None:
        """Record a job another client is running, without rendering it."""
        seen = getattr(self, "_foreign_jobs", None)
        if seen is None:
            seen = set()
            self._foreign_jobs = seen
        seen.add(job_id)

    @property
    def foreign_jobs(self) -> set[str]:
        return getattr(self, "_foreign_jobs", set())

    def refresh_heading(self) -> None:
        for widget in self.query("#screen-heading"):
            widget.update(self._heading_markup())
