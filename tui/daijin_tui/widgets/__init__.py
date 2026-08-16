"""Reusable widgets for the Daijin TUI.

Every chart in here exposes a pure function that returns a list of strings so
the drawing can be asserted in a test without a running app.
"""

from .activity import EventLog, PhaseChecklist
from .charts import PlotextBar, PlotextLine, plot_bar, plot_line
from .dither import DitherBars, StippleLine
from .gauge import Gauge
from .common import (
    HEALTH_GLYPH,
    MCP_THRESHOLD,
    Banner,
    KeyValue,
    SectionTitle,
    StubPanel,
    case_rate_value,
    format_case_rate,
    format_count,
    format_duration,
    format_ratio,
    health_glyph,
    health_state,
)
from .radar import RadarChart, bar_lines, radar_lines
from .repo_card import RepoCard
from .sparkline import Sparkline, sparkline

__all__ = [
    "MCP_THRESHOLD",
    "Banner",
    "DitherBars",
    "EventLog",
    "Gauge",
    "HEALTH_GLYPH",
    "KeyValue",
    "PhaseChecklist",
    "PlotextBar",
    "PlotextLine",
    "RadarChart",
    "RepoCard",
    "SectionTitle",
    "Sparkline",
    "StippleLine",
    "StubPanel",
    "bar_lines",
    "case_rate_value",
    "format_case_rate",
    "format_count",
    "format_duration",
    "format_ratio",
    "health_glyph",
    "health_state",
    "plot_bar",
    "plot_line",
    "radar_lines",
    "sparkline",
]
