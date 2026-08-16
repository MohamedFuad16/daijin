"""Unicode sparkline, drawn without a plotting dependency.

Kept separate from the plotext charts because cards need a sparkline inline in
a single character row, where a framed plot would not fit.
"""

from __future__ import annotations

from typing import Any, Sequence

from textual.widgets import Static

BLOCKS = "▁▂▃▄▅▆▇█"


def sparkline(values: Sequence[float | None], width: int | None = None) -> str:
    """Render values as one row of block characters.

    None entries render as a space so a gap in a series reads as a gap rather
    than as a zero. An empty series renders as an empty string.
    """
    points = list(values)
    if width is not None and width > 0 and len(points) > width:
        # Keep the most recent window rather than resampling, so the last
        # value on screen is always the last value in the series.
        points = points[-width:]
    present = [float(v) for v in points if v is not None]
    if not present:
        return " " * len(points)
    low = min(present)
    high = max(present)
    span = high - low
    out: list[str] = []
    for value in points:
        if value is None:
            out.append(" ")
            continue
        if span == 0:
            index = len(BLOCKS) // 2
        else:
            index = int(round((float(value) - low) / span * (len(BLOCKS) - 1)))
        out.append(BLOCKS[max(0, min(len(BLOCKS) - 1, index))])
    return "".join(out)


class Sparkline(Static):
    """A one row sparkline with an optional caption."""

    def __init__(
        self,
        values: Sequence[float | None] = (),
        *,
        caption: str = "",
        **kwargs: Any,
    ) -> None:
        super().__init__("", **kwargs)
        self._values = list(values)
        self._caption = caption
        self.add_class("sparkline")
        self._redraw()

    def set_values(self, values: Sequence[float | None], caption: str | None = None) -> None:
        self._values = list(values)
        if caption is not None:
            self._caption = caption
        self._redraw()

    @property
    def line(self) -> str:
        return sparkline(self._values)

    def _redraw(self) -> None:
        line = self.line
        if not line.strip():
            self.update("[dim]no series[/dim]")
            return
        text = line
        if self._caption:
            text = f"{line}  [dim]{self._caption}[/dim]"
        self.update(text)
