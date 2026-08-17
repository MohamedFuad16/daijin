"""The intro. A branded moment that is also the honest loading screen.

It is shown for exactly as long as startup takes: the handshake and the first
serveStatus. There is no artificial hold, so on a fast machine it is a blink
and on a slow one it is the loading state the user needed anyway. Nothing here
waits on the animation; the animation waits on nothing.

Two rules it inherits from the rest of the app. The wordmark reads on a
colourless terminal because the letterforms carry it and the ramp is only
texture inside them. And the status lines say what the engine ACTUALLY
reported: while a step is still running they name the step, and once hello and
serveStatus answer they show those answers, never a decorative substitute.
"""

from __future__ import annotations

from typing import Any

from textual.app import ComposeResult
from textual.css.query import NoMatches
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Static

from ..motion import DURATIONS, REVEAL, VIEW
from ..widgets.texture import NEUTRAL
from ..widgets.wordmark import reveal_steps, wordmark_lines, wordmark_width

TAGLINE = "a project brain for any repo"

# Read from the tokens so no literal duration appears at a call site here,
# which is the rule motion.py exists to enforce.
VIEW_SECONDS = DURATIONS[VIEW]
REVEAL_SECONDS = DURATIONS[REVEAL]

# Stages, in the order they appear. The wordmark first because it is the point,
# the status last because it is the part that keeps changing.
STAGE_NONE = 0
STAGE_WORDMARK = 1
STAGE_TAGLINE = 2
STAGE_STATUS = 3
FINAL_STAGE = STAGE_STATUS


class SplashScreen(Screen):
    """The intro screen. Any key skips to the finished frame."""

    def __init__(self, *, motion: Any = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.motion = motion
        self.stage = STAGE_NONE
        self.reveal: int | None = None
        self.status_text = ""
        self.skipped = False
        self._stage_timers: list[Any] = []

    def compose(self) -> ComposeResult:
        with Vertical(id="splash-body"):
            yield Static("", id="splash-wordmark", markup=False)
            yield Static("", id="splash-tagline", markup=True)
            yield Static("", id="splash-status", markup=True)

    def on_mount(self) -> None:
        mode = getattr(self.motion, "mode", "full")
        if mode == "off":
            # No animation at all: the finished frame, immediately.
            self._show(FINAL_STAGE, reveal=None)
            return
        if mode == "reduced":
            # Staged appearance, but each stage arrives whole. The information
            # order is the part that carries meaning; the column-by-column
            # entrance is the part that only pleases.
            self._show(STAGE_WORDMARK, reveal=None)
            self._stage_timers.append(self.set_timer(VIEW_SECONDS, lambda: self._show(STAGE_TAGLINE)))
            self._stage_timers.append(self.set_timer(VIEW_SECONDS * 2, lambda: self._show(STAGE_STATUS)))
            return
        self._animate_full()

    def _animate_full(self) -> None:
        steps = list(reveal_steps())
        per_step = REVEAL_SECONDS / max(1, len(steps))
        # The first frame is drawn, not scheduled: a zero-delay timer is a
        # different code path in Textual and it is not one this needs.
        self._show(STAGE_WORDMARK, reveal=steps[0])
        for index, columns in enumerate(steps[1:], start=1):
            self._stage_timers.append(
                self.set_timer(
                    per_step * index,
                    lambda columns=columns: self._show(STAGE_WORDMARK, reveal=columns),
                )
            )
        self._stage_timers.append(self.set_timer(REVEAL_SECONDS, lambda: self._show(STAGE_TAGLINE)))
        self._stage_timers.append(
            self.set_timer(REVEAL_SECONDS + VIEW_SECONDS, lambda: self._show(STAGE_STATUS))
        )

    def _show(self, stage: int, reveal: int | None = None) -> None:
        if self.skipped and stage < FINAL_STAGE:
            return
        self.stage = max(self.stage, stage)
        self.reveal = reveal
        self._paint()

    def _paint(self) -> None:
        try:
            wordmark = self.query_one("#splash-wordmark", Static)
            tagline = self.query_one("#splash-tagline", Static)
            status = self.query_one("#splash-status", Static)
        except NoMatches:
            # on_mount fires before compose has mounted the children, so the
            # very first paint has nothing to write to. In `off` mode that was
            # the ONLY paint, and the finished frame never appeared at all:
            # the mode that promises an instant frame rendered nothing.
            self.call_after_refresh(self._paint)
            return
        lines = (
            wordmark_lines(texture=NEUTRAL, reveal=self.reveal)
            if self.stage >= STAGE_WORDMARK
            else []
        )
        wordmark.update("\n".join(lines))
        tagline.update(f"[dim]{TAGLINE}[/dim]" if self.stage >= STAGE_TAGLINE else "")
        status.update(self.status_text if self.stage >= STAGE_STATUS else "")

    # Status ---------------------------------------------------------------

    def set_status(self, text: str) -> None:
        """Report a startup step, or what the engine answered.

        Called by the app as startup proceeds. The text is shown as given, so
        the caller is the one responsible for it being true.
        """
        self.status_text = text
        self._paint()

    def skip(self) -> None:
        """Jump to the finished frame. Any key does this."""
        self.skipped = True
        for timer in self._stage_timers:
            timer.stop()
        self._stage_timers.clear()
        self.stage = FINAL_STAGE
        self.reveal = None
        self._paint()

    def on_key(self, event: Any) -> None:
        event.stop()
        self.skip()

    def on_click(self) -> None:
        self.skip()
