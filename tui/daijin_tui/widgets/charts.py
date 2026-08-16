"""plotext backed bar and line charts.

plotext renders to an ANSI string, so the widgets build the string and hand it
to Rich. If plotext raises for any reason the widget falls back to a plain
character chart rather than showing an empty box, because a chart that
silently disappears reads as "no data" when the truth is "render failed".
"""

from __future__ import annotations

from typing import Any, Sequence

from rich.text import Text
from textual.widgets import Static

try:  # pragma: no cover - import guard
    import plotext as plt
except Exception:  # pragma: no cover - import guard
    plt = None  # type: ignore[assignment]


def _fallback_bars(labels: Sequence[str], values: Sequence[float], width: int) -> str:
    if not values:
        return "no data"
    high = max(values) or 1.0
    label_width = max((len(str(label)) for label in labels), default=1)
    bar_width = max(6, width - label_width - 12)
    rows = []
    for label, value in zip(labels, values):
        filled = int(round((value / high) * bar_width))
        rows.append(f"{str(label).rjust(label_width)} {'█' * filled}{'·' * (bar_width - filled)} {value:,.4g}")
    return "\n".join(rows)


def plot_bar(
    labels: Sequence[str],
    values: Sequence[float],
    *,
    title: str = "",
    width: int = 60,
    height: int = 14,
    orientation: str = "vertical",
) -> str:
    """Return an ANSI bar chart string."""
    if plt is None or not values:
        return _fallback_bars(labels, values, width)
    try:
        plt.clf()
        plt.plotsize(max(20, width), max(6, height))
        plt.theme("dark")
        plt.bar([str(label) for label in labels], list(values), orientation=orientation, width=0.45)
        if title:
            plt.title(title)
        return plt.build()
    except Exception:  # pragma: no cover - render guard
        return _fallback_bars(labels, values, width)


def plot_line(
    xs: Sequence[float],
    series: dict[str, Sequence[float]],
    *,
    title: str = "",
    width: int = 60,
    height: int = 14,
    markers: str = "braille",
) -> str:
    """Return an ANSI line chart string for one or more named series."""
    if plt is None or not series:
        labels = [str(x) for x in xs]
        first = next(iter(series.values())) if series else []
        return _fallback_bars(labels, list(first), width)
    try:
        plt.clf()
        plt.plotsize(max(20, width), max(6, height))
        plt.theme("dark")
        for name, values in series.items():
            plt.plot(list(xs), list(values), label=name, marker=markers)
        if title:
            plt.title(title)
        return plt.build()
    except Exception:  # pragma: no cover - render guard
        labels = [str(x) for x in xs]
        first = next(iter(series.values()))
        return _fallback_bars(labels, list(first), width)


class _AnsiPlot(Static):
    """Shared plumbing: hold an ANSI string and render it as Rich text."""

    def __init__(self, *, title: str = "", height: int = 14, **kwargs: Any) -> None:
        super().__init__("", **kwargs)
        self.title = title
        self.plot_height = height
        self._ansi = ""
        self.add_class("plot")

    @property
    def ansi(self) -> str:
        return self._ansi

    def _show(self, ansi: str) -> None:
        self._ansi = ansi
        self.update(Text.from_ansi(ansi))


class PlotextBar(_AnsiPlot):
    """Bar chart, used for per attempt token bars and gate movement."""

    def __init__(
        self,
        labels: Sequence[str] = (),
        values: Sequence[float] = (),
        *,
        title: str = "",
        height: int = 14,
        orientation: str = "vertical",
        **kwargs: Any,
    ) -> None:
        super().__init__(title=title, height=height, **kwargs)
        self.orientation = orientation
        self.set_data(labels, values)

    def set_data(self, labels: Sequence[str], values: Sequence[float]) -> None:
        self.labels = list(labels)
        self.values = list(values)
        self.refresh_plot()

    def refresh_plot(self) -> None:
        width = self.size.width or 60
        self._show(
            plot_bar(
                self.labels,
                self.values,
                title=self.title,
                width=width,
                height=self.plot_height,
                orientation=self.orientation,
            )
        )

    def on_resize(self) -> None:
        self.refresh_plot()


class PlotextLine(_AnsiPlot):
    """Line chart, used for cycle trends and pass or fail history."""

    def __init__(
        self,
        xs: Sequence[float] = (),
        series: dict[str, Sequence[float]] | None = None,
        *,
        title: str = "",
        height: int = 14,
        **kwargs: Any,
    ) -> None:
        super().__init__(title=title, height=height, **kwargs)
        self.set_data(xs, series or {})

    def set_data(self, xs: Sequence[float], series: dict[str, Sequence[float]]) -> None:
        self.xs = list(xs)
        self.series = {name: list(values) for name, values in series.items()}
        self.refresh_plot()

    def refresh_plot(self) -> None:
        width = self.size.width or 60
        self._show(
            plot_line(
                self.xs,
                self.series,
                title=self.title,
                width=width,
                height=self.plot_height,
            )
        )

    def on_resize(self) -> None:
        self.refresh_plot()
