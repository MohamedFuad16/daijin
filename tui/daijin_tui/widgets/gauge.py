"""A bar that fills toward its value instead of jumping to it.

Semantic motion, not decoration: a gauge that slides says "this is climbing",
and the same gauge snapping says only "this is the number now". During a gym
cycle the token budget is the thing a watcher is actually tracking, so the
movement carries the meaning.

Kept in `reduced` for that reason, and skipped entirely in `off`, where the
value is set outright and the end state is identical.
"""

from __future__ import annotations

from typing import Any

from rich.text import Text
from textual.reactive import reactive
from textual.widgets import Static

from ..motion import ARRIVE, MICRO


class Gauge(Static):
    """Horizontal fill with a caption. fraction is animatable."""

    DEFAULT_CSS = """
    Gauge { height: 1; }
    """

    fraction: reactive[float] = reactive(0.0)

    def __init__(self, *, caption: str = "", width: int = 40, **kwargs: Any) -> None:
        super().__init__("", **kwargs)
        self.caption = caption
        self.bar_width = width
        self.target = 0.0
        self.add_class("gauge")

    def watch_fraction(self) -> None:
        self.refresh()

    def set_value(self, fraction: float, *, motion: Any = None, caption: str | None = None) -> None:
        """Move toward a new value, animating when the app's motion allows."""
        target = max(0.0, min(1.0, float(fraction)))
        self.target = target
        if caption is not None:
            self.caption = caption
        if motion is None:
            self.fraction = target
            return
        motion.animate(self, "fraction", target, token=MICRO, easing=ARRIVE, decorative=False)

    def pulse(self, motion: Any) -> None:
        """One attention beat, never a repeating blink.

        A repeating blink is a demand for attention that never ends; a single
        pulse is a notification.
        """
        if motion is None:
            return
        # opacity lives on styles, not on the widget, so the animation targets
        # the style object. Decorative: the grant is already in the event log,
        # the pulse only draws the eye to it.
        motion.animate(
            self.styles,
            "opacity",
            0.55,
            token=MICRO,
            decorative=True,
            on_complete=lambda: motion.animate(
                self.styles, "opacity", 1.0, token=MICRO, decorative=True
            ),
        )

    def render(self) -> Text:
        filled = int(round(self.fraction * self.bar_width))
        text = Text()
        text.append("█" * filled, style="cyan")
        text.append("·" * (self.bar_width - filled), style="dim")
        if self.caption:
            text.append(f"  {self.caption}")
        return text
