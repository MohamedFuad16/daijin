"""Live activity widgets driven by the jsonl step-event stream.

The owner's rule for init is that it must never look frozen: a phase checklist
with spinners, an animated verb on the active line, per phase counts, and an
elapsed clock. The same two widgets drive the gym live view, because the
contract sends one stream for both.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Sequence

from rich.text import Text
from textual.widgets import RichLog, Static

SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

STATUS_GLYPH = {
    "pending": "○",
    "active": "",  # replaced by the spinner frame
    "done": "✔",
    "warn": "!",
    "failed": "✖",
}

STATUS_STYLE = {
    "pending": "dim",
    "active": "bold cyan",
    "done": "green",
    "warn": "yellow",
    "failed": "red",
}

LEVEL_STYLE = {
    "info": "white",
    "warn": "yellow",
    "error": "red",
    "success": "green",
}

# Verbs cycle on the active line so the eye can tell a slow phase from a hung
# one. They describe the phase, never a number, so they cannot mislead.
PHASE_VERBS: dict[str, Sequence[str]] = {
    "verify-roles": ("pinging", "timing first token", "reading served ids"),
    "identify": ("walking history", "counting languages", "probing gates"),
    "brain": ("reading evidence", "narrating", "validating citations"),
    "chunk-embed": ("chunking", "embedding", "writing the store"),
    "gold-set": ("mining", "checking integrity", "certifying the gauge"),
    "retrieval-floor": ("sweeping budgets", "scoring", "picking the floor"),
    "mcp-unlock": ("unlocking", "writing the snippet"),
    "draw": ("drawing", "building the worktree", "arming the guard"),
    "rounds": ("editing", "checking gates", "watching the boundary"),
    "submit": ("submitting", "grading blind", "reading the rubric"),
    "audit": ("auditing criteria", "counting the cohort"),
}
DEFAULT_VERBS = ("working", "reading", "writing")


class PhaseChecklist(Static):
    """Checklist of pipeline phases, advanced by step events."""

    DEFAULT_CSS = """
    PhaseChecklist { height: auto; }
    """

    def __init__(
        self,
        phases: Sequence[tuple[str, str]],
        *,
        clock: Callable[[], float] = time.monotonic,
        **kwargs: Any,
    ) -> None:
        super().__init__("", **kwargs)
        self.clock = clock
        self.frame = 0
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self.job_id: str | None = None
        self.order: list[str] = []
        self.state: dict[str, dict[str, Any]] = {}
        for key, label in phases:
            self._ensure(key, label)
        self.add_class("phase-checklist")

    # State ---------------------------------------------------------------

    def _ensure(self, key: str, label: str | None = None) -> dict[str, Any]:
        if key not in self.state:
            self.order.append(key)
            self.state[key] = {
                "label": label or key.replace("-", " ").capitalize(),
                "status": "pending",
                "detail": "",
                "counts": {},
                "steps": 0,
                "warns": 0,
                "started": None,
                "ended": None,
            }
        return self.state[key]

    def reset(self, job_id: str | None = None) -> None:
        self.job_id = job_id
        self.started_at = None
        self.finished_at = None
        for entry in self.state.values():
            entry.update(
                {"status": "pending", "detail": "", "counts": {}, "steps": 0, "warns": 0, "started": None, "ended": None}
            )
        self.refresh_view()

    def apply_events(self, batch: list[dict[str, Any]]) -> None:
        """Advance from a batch, repainting once rather than per event."""
        for event in batch:
            self.apply_event(event, refresh=False)
        self.refresh_view()

    def apply_event(self, event: dict[str, Any], *, refresh: bool = True) -> None:
        """Advance the checklist from one step event."""
        phase = str(event.get("phase") or "")
        if not phase:
            return
        if self.job_id is None:
            self.job_id = event.get("jobId")
        now = self.clock()
        if self.started_at is None:
            self.started_at = now

        if phase == "done":
            for key in self.order:
                entry = self.state[key]
                if entry["status"] == "active":
                    entry["status"] = "warn" if entry["warns"] else "done"
                    entry["ended"] = now
            self.finished_at = now
            if refresh:
                self.refresh_view()
            return

        entry = self._ensure(phase)
        if entry["status"] in ("pending", "done", "warn"):
            if entry["status"] == "pending":
                entry["started"] = now
            entry["status"] = "active"
        # Anything earlier in the order that is still running is finished by
        # the arrival of a later phase; the stream does not send phase-end.
        index = self.order.index(phase)
        for key in self.order[:index]:
            other = self.state[key]
            if other["status"] == "active":
                other["status"] = "warn" if other["warns"] else "done"
                other["ended"] = now
            elif other["status"] == "pending":
                other["status"] = "done"
                other["ended"] = now

        entry["steps"] += 1
        entry["detail"] = str(event.get("detail") or "")
        counts = event.get("counts")
        if isinstance(counts, dict):
            # Re-insert so the most recently reported counters sort last and the
            # line stays readable when a long phase reports many of them.
            for key, value in counts.items():
                entry["counts"].pop(key, None)
                entry["counts"][key] = value
        level = str(event.get("level") or "info")
        if level == "warn":
            entry["warns"] += 1
        elif level == "error":
            entry["status"] = "failed"
            entry["ended"] = now
        if refresh:
            self.refresh_view()

    @property
    def elapsed(self) -> float:
        if self.started_at is None:
            return 0.0
        end = self.finished_at if self.finished_at is not None else self.clock()
        return end - self.started_at

    @property
    def running(self) -> bool:
        return self.started_at is not None and self.finished_at is None

    # Rendering -----------------------------------------------------------

    def _verb(self, phase: str) -> str:
        verbs = PHASE_VERBS.get(phase, DEFAULT_VERBS)
        return verbs[(self.frame // 6) % len(verbs)]

    # How many of a phase's counters fit on one line before it stops reading.
    MAX_COUNTS_SHOWN = 4

    @classmethod
    def _format_counts(cls, counts: dict[str, Any]) -> str:
        if not counts:
            return ""
        parts = []
        shown = list(counts.items())[-cls.MAX_COUNTS_SHOWN :]
        for key, value in shown:
            if isinstance(value, float) and not value.is_integer():
                parts.append(f"{key} {value:.4g}")
            else:
                parts.append(f"{key} {int(value):,}" if isinstance(value, (int, float)) else f"{key} {value}")
        return ", ".join(parts)

    def _phase_elapsed(self, entry: dict[str, Any]) -> float | None:
        if entry["started"] is None:
            return None
        end = entry["ended"] if entry["ended"] is not None else self.clock()
        return end - entry["started"]

    def snapshot_lines(self) -> list[str]:
        """Plain text form of the checklist, used by tests."""
        lines = [self._header_text()]
        for key in self.order:
            entry = self.state[key]
            status = entry["status"]
            glyph = SPINNER_FRAMES[self.frame % len(SPINNER_FRAMES)] if status == "active" else STATUS_GLYPH[status]
            label = entry["label"]
            if status == "pending":
                body = "pending"
            elif status == "active":
                body = f"{self._verb(key)} ... {entry['detail']}".strip()
            else:
                body = entry["detail"] or "complete"
            counts = self._format_counts(entry["counts"])
            elapsed = self._phase_elapsed(entry)
            tail = []
            if counts:
                tail.append(counts)
            if entry["steps"]:
                tail.append(f"{entry['steps']} steps")
            if elapsed is not None:
                tail.append(f"{elapsed:.1f}s")
            suffix = f"   [{', '.join(tail)}]" if tail else ""
            lines.append(f"{glyph} {label}  {body}{suffix}")
        return lines

    def _header_text(self) -> str:
        done = sum(1 for key in self.order if self.state[key]["status"] in ("done", "warn"))
        job = self.job_id or "no job"
        state = "complete" if self.finished_at is not None else ("running" if self.running else "idle")
        return f"{job}  {state}  phase {done}/{len(self.order)}  elapsed {self.elapsed:.1f}s"

    def render(self) -> Text:
        text = Text()
        text.append(self._header_text(), style="bold")
        text.append("\n")
        for key in self.order:
            entry = self.state[key]
            status = entry["status"]
            style = STATUS_STYLE[status]
            glyph = SPINNER_FRAMES[self.frame % len(SPINNER_FRAMES)] if status == "active" else STATUS_GLYPH[status]
            text.append(f"{glyph} ", style=style)
            text.append(f"{entry['label']:<24}", style=style)
            if status == "pending":
                text.append("pending", style="dim")
            elif status == "active":
                text.append(f"{self._verb(key)} ... ", style="cyan")
                text.append(entry["detail"], style="white")
            else:
                text.append(entry["detail"] or "complete", style="dim")
            counts = self._format_counts(entry["counts"])
            if counts:
                text.append(f"   {counts}", style="magenta")
            elapsed = self._phase_elapsed(entry)
            if elapsed is not None:
                text.append(f"  {elapsed:.1f}s", style="dim")
            if entry["warns"]:
                text.append(f"  {entry['warns']} warn", style="yellow")
            text.append("\n")
        return text

    def refresh_view(self) -> None:
        self.refresh(layout=True)

    def tick(self) -> None:
        self.frame += 1
        if self.running:
            self.refresh()

    def on_mount(self) -> None:
        self.set_interval(0.1, self.tick)


class EventLog(RichLog):
    """The raw step-event stream, one jsonl row per line, newest at the bottom."""

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("wrap", True)
        kwargs.setdefault("markup", False)
        kwargs.setdefault("max_lines", 2_000)
        super().__init__(**kwargs)
        self.event_count = 0
        self.add_class("event-log")

    @staticmethod
    def format_event(event: dict[str, Any]) -> str:
        ts = event.get("ts")
        stamp = f"{float(ts) / 1000:7.2f}s" if isinstance(ts, (int, float)) else str(ts)
        counts = event.get("counts") or {}
        tail = ""
        if counts:
            tail = "  " + ", ".join(f"{k} {v}" for k, v in counts.items())
        return f"{stamp}  {event.get('phase', '?'):<16}{event.get('step', '?'):<12}{event.get('detail', '')}{tail}"

    def append_event(self, event: dict[str, Any]) -> None:
        self.event_count += 1
        style = LEVEL_STYLE.get(str(event.get("level") or "info"), "white")
        self.write(Text(self.format_event(event), style=style))
