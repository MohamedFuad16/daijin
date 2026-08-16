"""Five axis radar on a unicode canvas, with a horizontal bar fallback.

The owner asked for a radar the user can switch to bars, because a radar on a
low resolution terminal can mislead and bars never do. Both renderers are pure
functions returning a list of strings so they can be asserted in a test.

The canvas uses braille cells: two dots wide, four dots tall. A braille dot is
half a cell wide and a quarter of a cell tall, and a terminal cell is about
twice as tall as it is wide, so braille dots come out close to square and a
circle drawn on them looks like a circle.
"""

from __future__ import annotations

import math
from typing import Any, Sequence

from textual.widgets import Static

BRAILLE_BASE = 0x2800
# Dot bit for a pixel at (x, y) inside one cell, x in 0..1 and y in 0..3.
DOT_BITS = ((0x01, 0x02, 0x04, 0x40), (0x08, 0x10, 0x20, 0x80))

MODES = ("radar", "bars")


class BrailleCanvas:
    """A pixel grid rendered as braille characters."""

    def __init__(self, cell_width: int, cell_height: int) -> None:
        self.cell_width = max(1, cell_width)
        self.cell_height = max(1, cell_height)
        self.width = self.cell_width * 2
        self.height = self.cell_height * 4
        self._cells = [[0] * self.cell_width for _ in range(self.cell_height)]

    def set(self, x: float, y: float) -> None:
        px, py = int(round(x)), int(round(y))
        if not (0 <= px < self.width and 0 <= py < self.height):
            return
        self._cells[py // 4][px // 2] |= DOT_BITS[px % 2][py % 4]

    def line(self, x0: float, y0: float, x1: float, y1: float) -> None:
        """Plot a straight run of pixels between two points."""
        steps = int(max(abs(x1 - x0), abs(y1 - y0))) + 1
        for step in range(steps + 1):
            t = step / steps
            self.set(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)

    def polygon(self, points: Sequence[tuple[float, float]]) -> None:
        for index, point in enumerate(points):
            nxt = points[(index + 1) % len(points)]
            self.line(point[0], point[1], nxt[0], nxt[1])

    def lines(self) -> list[str]:
        return [
            "".join(chr(BRAILLE_BASE + bits) for bits in row)
            for row in self._cells
        ]


def _axis_points(
    values: Sequence[float],
    center: tuple[float, float],
    radius: float,
) -> list[tuple[float, float]]:
    count = len(values)
    points: list[tuple[float, float]] = []
    for index, value in enumerate(values):
        angle = -math.pi / 2 + index * (2 * math.pi / count)
        scaled = max(0.0, min(1.0, float(value))) * radius
        points.append((center[0] + scaled * math.cos(angle), center[1] + scaled * math.sin(angle)))
    return points


def radar_lines(
    axes: Sequence[dict[str, Any]],
    cell_width: int = 30,
    cell_height: int = 9,
) -> list[str]:
    """Draw the axes as a filled outline plus grid rings and spokes.

    axes entries are {name, score, max}. Scores are normalized against max.
    """
    if not axes:
        return ["[dim]no axes[/dim]"]
    values = [
        (float(axis.get("score") or 0.0) / float(axis.get("max") or 1.0)) for axis in axes
    ]
    canvas = BrailleCanvas(cell_width, cell_height)
    center = ((canvas.width - 1) / 2, (canvas.height - 1) / 2)
    radius = min(center[0], center[1]) * 0.92
    ones = [1.0] * len(values)
    # Outer ring and spokes give the eye a reference, otherwise a small polygon
    # and a large one look alike.
    canvas.polygon(_axis_points(ones, center, radius))
    for point in _axis_points(ones, center, radius):
        canvas.line(center[0], center[1], point[0], point[1])
    canvas.polygon(_axis_points(values, center, radius))
    rendered = canvas.lines()
    legend: list[str] = []
    for index, axis in enumerate(axes):
        legend.append(f"{index + 1} {axis.get('name', '?')} {values[index]:.2f}")
    rendered.append("")
    rendered.append("  ".join(legend))
    rendered.append("spokes run clockwise from the top in legend order")
    return rendered


def bar_lines(axes: Sequence[dict[str, Any]], width: int = 46) -> list[str]:
    """Draw the same axes as horizontal bars, the honest fallback."""
    if not axes:
        return ["no axes"]
    label_width = max(len(str(axis.get("name", "?"))) for axis in axes)
    bar_width = max(8, width - label_width - 8)
    out: list[str] = []
    for axis in axes:
        ratio = float(axis.get("score") or 0.0) / float(axis.get("max") or 1.0)
        ratio = max(0.0, min(1.0, ratio))
        filled = int(round(ratio * bar_width))
        bar = "█" * filled + "·" * (bar_width - filled)
        out.append(f"{str(axis.get('name', '?')).rjust(label_width)} {bar} {ratio:.2f}")
    return out


class RadarChart(Static):
    """Radar with a user switchable bar fallback.

    Mode is switched from the exams screen binding and from a mouse click on
    the chart itself, so neither input path is a second class citizen.
    """

    def __init__(
        self,
        axes: Sequence[dict[str, Any]] = (),
        *,
        mode: str = "radar",
        cell_width: int = 30,
        cell_height: int = 9,
        **kwargs: Any,
    ) -> None:
        super().__init__("", **kwargs)
        self._axes = list(axes)
        self.mode = mode if mode in MODES else "radar"
        self.cell_width = cell_width
        self.cell_height = cell_height
        self.add_class("radar-chart")
        self._redraw()

    def set_axes(self, axes: Sequence[dict[str, Any]]) -> None:
        self._axes = list(axes)
        self._redraw()

    def set_mode(self, mode: str) -> None:
        if mode in MODES:
            self.mode = mode
            self._redraw()

    def toggle_mode(self) -> str:
        self.set_mode("bars" if self.mode == "radar" else "radar")
        return self.mode

    def on_click(self) -> None:
        self.toggle_mode()

    @property
    def lines(self) -> list[str]:
        if self.mode == "bars":
            return bar_lines(self._axes)
        return radar_lines(self._axes, self.cell_width, self.cell_height)

    def _redraw(self) -> None:
        body = "\n".join(self.lines)
        header = f"[dim]mode {self.mode}, click or press r to switch[/dim]\n"
        self.update(header + body)
