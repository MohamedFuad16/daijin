"""Charts drawn from the texture vocabulary rather than from plotext.

plotext gives a coloured slab per series. The owner's dashboard fills every
shape with a pattern, and a pattern is the channel a colourless reader still
has, so these are rendered directly through Rich styled text. plotext stays
where a framed axis chart is the right thing; it was a convenience, never a
contract.
"""

from __future__ import annotations

from typing import Any, Sequence

from rich.text import Text
from textual.widgets import Static

from .texture import NEUTRAL, Texture, dither_grid, legend, stipple_grid


class DitherBars(Static):
    """Bars as dithered columns, one texture per bar."""

    DEFAULT_CSS = """
    DitherBars { height: auto; }
    """

    def __init__(
        self,
        *,
        title: str = "",
        height: int = 10,
        bar_width: int = 3,
        **kwargs: Any,
    ) -> None:
        super().__init__("", **kwargs)
        self.title = title
        self.chart_height = height
        self.bar_width = bar_width
        self.labels: list[str] = []
        self.values: list[float] = []
        self.textures: list[Texture] = []
        self.add_class("dither-bars")

    def set_data(
        self,
        labels: Sequence[str],
        values: Sequence[float],
        textures: Sequence[Texture] | None = None,
    ) -> None:
        self.labels = [str(label) for label in labels]
        self.values = [float(value) for value in values]
        self.textures = list(textures) if textures else [NEUTRAL] * len(self.values)
        self.refresh()

    def render(self) -> Text:
        text = Text()
        if self.title:
            text.append(f"{self.title}\n", style="bold")
        if not self.values:
            text.append("no data", style="dim")
            return text
        grid = dither_grid(
            self.values, self.textures, height=self.chart_height, width=self.bar_width
        )
        for row in grid:
            for cell, texture in row:
                text.append(cell, style=texture.color if texture else None)
            text.append("\n")
        # Axis labels under their bars, at the same pitch as the columns.
        pitch = self.bar_width + 1
        axis = "".join(str(label)[: self.bar_width].center(pitch) for label in self.labels)
        text.append(axis.rstrip() + "\n", style="dim")
        shown: list[Texture] = []
        for texture in self.textures:
            if texture not in shown:
                shown.append(texture)
        if shown:
            text.append(legend(shown), style="dim")
        return text


class StippleLine(Static):
    """A line with a stippled area beneath it, rather than a bare dot row."""

    DEFAULT_CSS = """
    StippleLine { height: auto; }
    """

    def __init__(self, *, title: str = "", height: int = 6, **kwargs: Any) -> None:
        super().__init__("", **kwargs)
        self.title = title
        self.chart_height = height
        self.values: list[float] = []
        self.texture: Texture = NEUTRAL
        self.point_textures: list[Texture] | None = None
        self.min_column = 0
        self.add_class("stipple-line")

    def set_data(
        self,
        values: Sequence[float],
        texture: Texture = NEUTRAL,
        textures: Sequence[Texture] | None = None,
        min_column: int = 0,
    ) -> None:
        self.values = [float(value) for value in values]
        self.texture = texture
        self.point_textures = list(textures) if textures else None
        self.min_column = min_column
        self.refresh()

    def render(self) -> Text:
        text = Text()
        if self.title:
            text.append(f"{self.title}\n", style="bold")
        if not self.values:
            text.append("no data", style="dim")
            return text
        grid = stipple_grid(
            self.values,
            height=self.chart_height,
            textures=self.point_textures,
            texture=self.texture,
            min_column=self.min_column,
        )
        for row in grid:
            for cell, texture in row:
                text.append(cell, style=texture.color if texture else None)
            text.append("\n")
        shown: list[Texture] = []
        for texture in (self.point_textures or [self.texture]):
            if texture not in shown:
                shown.append(texture)
        text.append(legend(shown), style="dim")
        return text
