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

# Below this the detail column is too narrow to be a column at all, and the
# layout gives up rather than producing one word per line.
MIN_DETAIL_WIDTH = 24

STATUS_GLYPH = {
    "pending": "○",
    "skipped": "-",
    "active": "",  # replaced by the spinner frame
    "done": "✔",
    "warn": "!",
    "failed": "✖",
}

STATUS_STYLE = {
    "pending": "dim",
    "skipped": "dim",
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

# Some steps deserve visual weight that their LEVEL should not carry.
#
# gatesDiscover emits kept-yours when a user-edited gates.yaml wins over the
# freshly discovered one. It is the only step in that job reporting generated
# work being thrown away, so it needs to stand out, but it stays at the default
# level on purpose: raising it to warn would tell a user something went wrong
# at the moment the engine is honouring their edit. Style by NAME, not level.
#
# Cyan is used by no level, so the weight comes from the palette rather than
# from borrowing the warning colour. The marker carries the same distinction
# without colour, for a reader who has none.
STEP_STYLE: dict[str, str] = {
    "kept-yours": "bold cyan",
}
STEP_MARKER: dict[str, str] = {
    "kept-yours": "keep",
}

# ADVISORIES ARE NOT WARNINGS. mcp-saturation fires when the score sits at the
# gauge's ceiling: nothing went wrong, the gauge is just saying what it can and
# cannot distinguish up there. The engine sends it at level warn so a client
# that knows nothing still surfaces it, but a checklist that counts it as
# "1 warn" on a fully successful init sends the owner hunting for a problem
# that does not exist - which is exactly what happened. Same palette rule as
# kept-yours: cyan belongs to no level, so a note never borrows alarm colour.
ADVISORY_STEPS = {"mcp-saturation"}

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

# The step-event shape has no terminal marker. The mock emits a "done" phase;
# the real engine does not, so a client cannot tell "finished" from "stalled"
# from the stream alone. Raised with the leader as a contract gap. Until it is
# answered, a run that goes quiet is reported as INFERRED complete, never as
# reported complete, because the two are different claims.
# The contract's terminal-event invariant (methods.md, v5, 2026-08-17): every
# job emits EXACTLY ONE event with phase "done", and it is the last event for
# that jobId. `finished` is a STEP name under that phase, not a phase, and
# `complete` is not on the wire at all: this set used to carry both, which
# documented two states the engine cannot produce. A client branch for a
# phantom state is dead code no use can ever disprove, so the set is exactly
# what the wire sends.
#
# It stays a CONSTANT rather than becoming a literal at three call sites. The
# literal was the defect that let two banners miss the terminal event; the
# tolerance was never the point.
TERMINAL_PHASES = frozenset({"done"})

# Generous on purpose. A false "finished" is worse than a late one: it tells
# the user a run ended while it is still working. Measured on the P8 fixture,
# the largest gap between two real step events is 9.6s (inside the floor
# phase, between budget-measured and resolution-measured), so a threshold near
# that would declare a live run complete in the middle of it.
IDLE_UNTIL_INFERRED = 30.0


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
        self.last_event_at: float | None = None
        self.finish_is_inferred = False
        self.terminal_step: str | None = None
        self.terminal_level: str = "info"
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
                "notes": 0,
                "started": None,
                "ended": None,
            }
        return self.state[key]

    def reset(self, job_id: str | None = None) -> None:
        self.job_id = job_id
        self.started_at = None
        self.finished_at = None
        self.last_event_at = None
        self.finish_is_inferred = False
        self.terminal_step = None
        self.terminal_level = "info"
        for entry in self.state.values():
            entry.update(
                {
                    "status": "pending",
                    "detail": "",
                    "counts": {},
                    "steps": 0,
                    "warns": 0,
                    "notes": 0,
                    "started": None,
                    "ended": None,
                }
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
        self.last_event_at = now
        if self.started_at is None:
            self.started_at = now

        if phase in TERMINAL_PHASES:
            # The phase says THAT it ended; `level` says HOW. Corrected in
            # engine 9106794: keying on the step to tell success from failure
            # means enumerating an open set (finished, written, kept-yours, and
            # whatever the next job names its ending), while level is a small
            # closed set that is the same for every job.
            #
            #   info   it stopped well
            #   warn   it was stopped (cancelled)
            #   error  it broke (failed)
            #
            # The step is kept for display, because "failed" is worth showing;
            # it is simply not what the branch reads.
            self.terminal_step = str(event.get("step") or "")
            self.terminal_level = str(event.get("level") or "info")
            broke = self.terminal_level == "error"
            for key in self.order:
                entry = self.state[key]
                if entry["status"] == "active":
                    # A phase that was running when the job broke did NOT
                    # finish. Marking it done is the phantom-done family: a
                    # checklist of ticks over a run that failed.
                    if broke:
                        entry["status"] = "failed"
                    else:
                        entry["status"] = "warn" if entry["warns"] else "done"
                    entry["ended"] = now
            self.finished_at = now
            self.finish_is_inferred = False
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
                # NOT done. A phase that never emitted an event never ran, and
                # marking it done claims work the engine never reported. The
                # client's phase list is a guess; this engine's pipeline may
                # simply not have this phase.
                other["status"] = "skipped"

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
            if str(event.get("step") or "") in ADVISORY_STEPS:
                entry["notes"] += 1
            else:
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

    def infer_finish_if_idle(self) -> bool:
        """Call on a timer. Marks a quiet run finished, and says it inferred it."""
        if not self.running or self.last_event_at is None:
            return False
        if (self.clock() - self.last_event_at) < IDLE_UNTIL_INFERRED:
            return False
        for key in self.order:
            entry = self.state[key]
            if entry["status"] == "active":
                entry["status"] = "warn" if entry["warns"] else "done"
                entry["ended"] = self.last_event_at
        self.finished_at = self.last_event_at
        self.finish_is_inferred = True
        self.refresh_view()
        return True

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
        if self.finished_at is None:
            state = "running" if self.running else "idle"
        elif self.finish_is_inferred:
            # The engine never said it finished; the stream simply stopped.
            state = "complete (inferred from an idle stream)"
        elif self.terminal_level == "error":
            state = f"FAILED: {self.terminal_step or 'the job broke'}"
        elif self.terminal_level == "warn":
            state = f"stopped: {self.terminal_step or 'cancelled'}"
        else:
            state = "complete"
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
            if entry.get("notes"):
                text.append(f"  {entry['notes']} note", style="cyan")
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
        # Wrapping is done in format_event, which knows where the columns are.
        # RichLog's own wrap starts continuations at column zero and is what
        # made a long detail collide with the columns beside it.
        kwargs.setdefault("wrap", False)
        kwargs.setdefault("markup", False)
        kwargs.setdefault("max_lines", 2_000)
        super().__init__(**kwargs)
        self.event_count = 0
        # Truncation is the DEFAULT, not the policy. Most tokens in this
        # stream are paths, so a reader who wants the whole one should be able
        # to have it back rather than being told the column decided.
        self.truncate = True
        self._events: list[dict[str, Any]] = []
        self.add_class("event-log")

    @staticmethod
    def truncate_middle(text: str, limit: int) -> str:
        """Shorten a long token from the MIDDLE, keeping both ends.

        A path is identified by its start and its basename; cutting the tail
        throws away the half that names the thing. The ellipsis is a plain
        three dots so the column arithmetic stays in ASCII cells.
        """
        if limit <= 0 or len(text) <= limit:
            return text
        if limit <= 5:
            return text[:limit]
        keep = limit - 3
        head = (keep + 1) // 2
        return f"{text[:head]}...{text[len(text) - (keep - head):]}"

    @classmethod
    def format_detail(cls, detail: str, limit: int) -> str:
        """Middle-truncate any token too long to sit in the detail column."""
        if limit <= 0:
            return detail
        return " ".join(
            cls.truncate_middle(token, limit) if len(token) > limit else token
            for token in detail.split(" ")
        )

    @classmethod
    def format_event(cls, event: dict[str, Any], width: int = 0, *, truncate: bool = True) -> str:
        """One event as fixed columns, with the detail wrapped under itself.

        The stream has to read as a TABLE even when a detail is a sentence, so
        the wrapping is done here rather than left to the widget: RichLog wraps
        at the frame edge and starts the continuation at column zero, which is
        what made long details collide with the columns beside them. Counts get
        their own segment for the same reason.
        """
        ts = event.get("ts")
        stamp = f"{float(ts) / 1000:7.2f}s" if isinstance(ts, (int, float)) else str(ts)
        step = str(event.get("step", "?"))
        marker = STEP_MARKER.get(step, "")
        prefix = f"[{marker}] " if marker else ""
        head = f"{stamp}  {str(event.get('phase', '?')):<16}{step:<12}"

        counts = event.get("counts") or {}
        tail = ", ".join(f"{k} {v}" for k, v in counts.items()) if counts else ""
        body = f"{prefix}{event.get('detail', '')}"

        if width <= 0:
            return f"{head}{body}{'  ' + tail if tail else ''}"
        indent = len(head)
        room = max(MIN_DETAIL_WIDTH, width - indent)
        # Untruncated, a long token simply overruns its column. The widget
        # does not wrap, so the row scrolls horizontally rather than breaking
        # the path across lines, which is the thing the truncation existed to
        # prevent in the first place.
        if truncate:
            body = cls.format_detail(body, room)
        words, lines, current = body.split(" "), [], ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if current and len(candidate) > room:
                lines.append(current)
                current = word
            else:
                current = candidate
        lines.append(current)
        if tail:
            # Counts are a UNIT and never flow with the prose. Wrapping them as
            # words split "cases 34" across two lines, which is the collision
            # the field test reported rather than a cosmetic nicety.
            if len(lines[-1]) + 2 + len(tail) <= room:
                lines[-1] = f"{lines[-1]}  {tail}"
            else:
                lines.append(tail)
        # Hanging indent: continuations start under the detail column, so the
        # three columns to their left stay a column.
        return "\n".join(
            (head + lines[0]) if index == 0 else (" " * indent + line)
            for index, line in enumerate(lines)
        )

    @staticmethod
    def style_for(event: dict[str, Any]) -> str:
        """Step name wins over level: a step can be notable without being wrong.

        A single function so a test can assert the STYLE THAT IS USED rather
        than the contents of a table something else might ignore.
        """
        step = str(event.get("step") or "")
        return STEP_STYLE.get(step) or LEVEL_STYLE.get(str(event.get("level") or "info"), "white")

    def append_event(self, event: dict[str, Any]) -> None:
        self.event_count += 1
        self._events.append(event)
        # The widget's own width, so the wrap happens where the frame ends.
        self.write(
            Text(
                self.format_event(event, self.size.width or 0, truncate=self.truncate),
                style=self.style_for(event),
            )
        )

    def set_truncate(self, truncate: bool) -> None:
        """Redraw every row at the new setting.

        The events are kept so the toggle applies to what is ALREADY on screen.
        A setting that only affected future rows would leave the path the user
        is looking at exactly as unreadable as it was.
        """
        self.truncate = truncate
        # super().clear() empties the DISPLAY. self.clear() would also empty
        # the events, which are the thing being redrawn.
        super().clear()
        width = self.size.width or 0
        for event in self._events:
            self.write(
                Text(
                    self.format_event(event, width, truncate=truncate),
                    style=self.style_for(event),
                )
            )

    def clear(self) -> "EventLog":
        """Reset the log, events included: a new job starts from nothing."""
        self._events.clear()
        return super().clear()
