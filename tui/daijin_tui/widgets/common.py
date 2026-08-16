"""Small shared widgets and formatters."""

from __future__ import annotations

from typing import Any

from textual.app import ComposeResult
from textual.containers import Horizontal
from textual.widgets import Static

# The floor at which MCP unlocks, per the contract's mcpSnippet threshold.
MCP_THRESHOLD = 0.75

HEALTH_GLYPH: dict[str, tuple[str, str]] = {
    "ok": ("●", "health-ok"),
    "warn": ("●", "health-warn"),
    # Derived, not a wire value. See health_state.
    "warn-unmeasured": ("◍", "health-unmeasured"),
    "critical": ("●", "health-critical"),
    "no-brain": ("○", "health-none"),
    "unknown": ("◌", "health-unknown"),
}

# The wire's vocabulary, locked in contract v5.
DOCUMENTED_HEALTH = frozenset({"no-brain", "warn", "ok", "critical"})

_UNSET = object()


def health_state(health: str | None, floor_score: Any = _UNSET) -> str:
    """Resolve the badge state, splitting warn on the discriminator beside it.

    warn covers two situations the engine computes from the same branch: a
    brain that is indexed and has NEVER BEEN MEASURED, and one that was
    measured and scored below the unlock threshold. floorScore tells them
    apart, null for the first and a number for the second, and it sits on the
    same row. Rendering them identically would say the same thing about a repo
    nobody has scored and a repo that scored badly, and only the second is a
    verdict.

    Nothing is invented here: the wire vocabulary stays four values, and this
    is a rendering distinction drawn from two fields the client already has.
    """
    value = str(health or "unknown")
    if value not in DOCUMENTED_HEALTH:
        return "unknown"
    if value == "warn" and floor_score is not _UNSET and floor_score is None:
        return "warn-unmeasured"
    return value


def health_glyph(health: str | None, floor_score: Any = _UNSET) -> tuple[str, str]:
    """Return the dot character and the CSS class for a health value."""
    return HEALTH_GLYPH[health_state(health, floor_score)]


def case_rate_value(case_rate: Any) -> float | None:
    """Read the unrounded ratio out of a v3 caseRate.

    The contract calls exact "the rational value" without fixing its JSON type,
    so both a float and an "n/m" string are accepted. Returns None when there
    is nothing measured, which is not the same as zero.
    """
    if case_rate is None:
        return None
    if isinstance(case_rate, (int, float)):
        return float(case_rate)
    if isinstance(case_rate, dict):
        exact = case_rate.get("exact")
        if isinstance(exact, (int, float)):
            return float(exact)
        if isinstance(exact, str) and "/" in exact:
            numerator, _, denominator = exact.partition("/")
            try:
                return float(numerator) / float(denominator)
            except (ValueError, ZeroDivisionError):
                return None
        if isinstance(exact, str):
            try:
                return float(exact)
            except ValueError:
                return None
    return None


def format_case_rate(case_rate: Any) -> str:
    """Render a caseRate as its count form, never as a bare rounded percentage.

    A rounded percentage hides its own denominator: 91 percent of 34 cases and
    91 percent of 340 cases carry very different error bars, and the count form
    keeps that visible.
    """
    if isinstance(case_rate, dict) and case_rate.get("cases"):
        return str(case_rate["cases"])
    value = case_rate_value(case_rate)
    if value is None:
        return "not measured"
    return f"ratio {value:.4f}, denominator not reported"


def format_ratio(value: float | None, *, digits: int = 4) -> str:
    """A full precision ratio, for showing next to a count form."""
    if value is None:
        return "not measured"
    return f"{value:.{digits}f}"


def format_count(value: int | float | None) -> str:
    if value is None:
        return "-"
    if isinstance(value, float) and not value.is_integer():
        return f"{value:.4g}"
    return f"{int(value):,}"


def format_duration(seconds: float | None) -> str:
    if seconds is None:
        return "-"
    seconds = max(0.0, float(seconds))
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, rest = divmod(int(seconds), 60)
    if minutes < 60:
        return f"{minutes}m {rest:02d}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes:02d}m"


class SectionTitle(Static):
    """A titled rule used to separate panels."""

    def __init__(self, title: str, subtitle: str = "", **kwargs: Any) -> None:
        text = f"[b]{title}[/b]"
        if subtitle:
            text += f"  [dim]{subtitle}[/dim]"
        super().__init__(text, markup=True, **kwargs)
        self.add_class("section-title")


class Banner(Static):
    """A one line notice. tone is info, warn, or error."""

    def __init__(self, text: str, tone: str = "info", **kwargs: Any) -> None:
        super().__init__(text, **kwargs)
        self.add_class("banner")
        self.add_class(f"banner-{tone}")
        self.tone = tone

    def set_notice(self, text: str, tone: str = "info") -> None:
        self.remove_class(f"banner-{self.tone}")
        self.tone = tone
        self.add_class(f"banner-{tone}")
        self.update(text)


class StubPanel(Static):
    """A visible marker for data the frozen RPC contract does not carry.

    Screens use this rather than inventing a method, so a gap reads as a gap.
    """

    def __init__(self, title: str, reason: str, **kwargs: Any) -> None:
        super().__init__(f"[b]STUB  {title}[/b]\n{reason}", markup=True, **kwargs)
        self.add_class("stub-panel")


class KeyValue(Horizontal):
    """A label and value pair on one line."""

    def __init__(self, label: str, value: str, value_classes: str = "", **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._label = label
        self._value = value
        self._value_classes = value_classes
        self.add_class("key-value")

    def compose(self) -> ComposeResult:
        yield Static(self._label, classes="kv-label")
        value = Static(self._value, classes="kv-value")
        if self._value_classes:
            for name in self._value_classes.split():
                value.add_class(name)
        yield value

    def set_value(self, value: str) -> None:
        self._value = value
        for child in self.query(".kv-value"):
            child.update(value)
