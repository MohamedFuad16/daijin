"""Gym live view. Same step-event stream as init, plus the run ledger."""

from __future__ import annotations

from typing import Any, Iterable

from textual import work
from textual.containers import Horizontal
from textual.widgets import Button, DataTable, Static, TabbedContent, TabPane

from .. import mock_data
from ..concurrency import gather_all
from ..rpc import RpcError
from ..stream import FLUSH_INTERVAL, StreamCoalescer
from ..widgets import (
    Banner,
    EventLog,
    Gauge,
    PhaseChecklist,
    PlotextLine,
    SectionTitle,
    format_count,
    format_duration,
)
from .base import DaijinScreen
from .dialogs import budget_estimate_lines


# The extension ceiling a cycle works against, from the ADR-0167 defaults.
GYM_TOKEN_BUDGET = 400_000


class GymScreen(DaijinScreen):
    mode_name = "gym"
    notice_id = "#gym-notice"
    heading = "Gym"
    subheading = "rounds, edits, checks, extensions, boundary events, criteria audit"

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.job_id: str | None = None
        self.gate_open = False
        self._subscribed = False
        self.coalescer = StreamCoalescer(self._render_events)

    def content(self) -> Iterable[Any]:
        yield Banner("", tone="info", id="gym-notice")
        with Horizontal(id="gym-controls"):
            yield Button("Start cycle", id="gym-start", variant="primary")
            yield Button("Cancel job", id="gym-cancel")
            yield Button("Refresh status", id="gym-refresh")
            yield Static("", id="gym-gate", markup=True)
        with TabbedContent(id="gym-tabs"):
            with TabPane("Live", id="gym-tab-live"):
                yield PhaseChecklist(mock_data.GYM_PHASES, id="gym-checklist")
                yield Gauge(caption="token budget", id="gym-tokens")
                yield EventLog(id="gym-events")
            with TabPane("Run detail", id="gym-tab-run"):
                yield Static("", id="run-summary", markup=True)
                yield SectionTitle("Edits by file")
                yield DataTable(id="edit-table", cursor_type="row")
                yield SectionTitle("Checks", "measured gates report movement, not a verdict alone")
                yield DataTable(id="check-table", cursor_type="row")
                yield SectionTitle("Extension grants and refusals")
                yield DataTable(id="extension-table", cursor_type="row")
                yield SectionTitle("Boundary events")
                yield DataTable(id="boundary-table", cursor_type="row")
                yield SectionTitle("Criteria audit")
                yield DataTable(id="criteria-table", cursor_type="row")
                yield SectionTitle("Rollbacks")
                yield DataTable(id="rollback-table", cursor_type="row")
            with TabPane("Cycles", id="gym-tab-cycles"):
                yield Static("", id="ledger-summary", markup=True)
                yield DataTable(id="cycle-table", cursor_type="row")
                yield PlotextLine(title="tokens per cycle", height=12, id="cycle-trend")

    async def load(self) -> None:
        self._subscribe()
        self.refresh_heading()
        self._init_columns()
        # The run ledger and the gate state have nothing to do with each other.
        status_result, gate_result = await gather_all(
            self.client.call("gymStatus", {}),
            self.client.call("serveStatus", {}),
        )
        if isinstance(status_result, RpcError):
            self.show_rpc_error(status_result, "#gym-notice")
            return
        if isinstance(status_result, BaseException):
            raise status_result
        status = status_result
        self._render_run(status.get("activeRun") or {})
        self._render_cycles(status.get("cycles") or [], status.get("ledger") or {})
        # serveStatus carries the gate, so the state is readable BEFORE any
        # attempt. The user should never have to press a button to find out
        # that pressing the button was refused.
        gate: dict[str, Any] = {}
        if isinstance(gate_result, RpcError):
            self.report_rpc_error(gate_result)
        elif isinstance(gate_result, dict):
            gate = gate_result.get("spendGate") or {}
        self.gate_open = bool(gate.get("open"))
        state = "open" if self.gate_open else "blocked"
        tone = "green" if self.gate_open else "yellow"
        self.query_one("#gym-gate", Static).update(
            f"spend gate [{tone}]{state}[/{tone}] at {gate.get('path', '?')}  "
            f"[dim]the gate moves by the owner's hand, not the agent's[/dim]"
        )
        # The button stays live even when the gate reads blocked. The engine is
        # the authority on its own gate; a client that greys the button out is
        # asserting a state it only read a moment ago, and hides the engine's
        # own refusal text when it is wrong.
        self.query_one("#gym-start", Button).label = (
            "Start cycle" if self.gate_open else "Start cycle (gate reads blocked)"
        )
        self.query_one("#gym-notice", Banner).set_notice(
            (
                "Run detail and cycles come from gymStatus. Live comes from the step-event stream."
                if self.gate_open
                else "The gate reads blocked, so a cycle will be refused. Run detail and cycles below are recorded history and cost nothing."
            ),
            "info" if self.gate_open else "warn",
        )

    def _init_columns(self) -> None:
        specs = {
            "#edit-table": ("file", "added", "removed", "rounds"),
            "#check-table": ("check", "verdict", "kind", "before", "after"),
            "#extension-table": ("round", "requested", "verdict", "reason"),
            "#boundary-table": ("round", "result", "detail"),
            "#criteria-table": ("criterion", "result", "detail"),
            "#rollback-table": ("round", "discarded edits", "reason"),
            "#cycle-table": ("cycle", "exam", "verdict", "tokens", "rounds", "duration"),
        }
        for selector, columns in specs.items():
            table = self.query_one(selector, DataTable)
            if not table.columns:
                table.add_columns(*columns)

    def _render_run(self, run: dict[str, Any]) -> None:
        self.query_one("#run-summary", Static).update(
            f"job [b]{run.get('jobId', '-')}[/b]  exam [b]{run.get('examId', '-')}[/b]  "
            f"round {run.get('round', '-')}  state {run.get('state', '-')}  "
            f"mode [b]{run.get('mode', '-')}[/b] [dim](only evaluation rows are scored)[/dim]"
        )
        self._fill("#edit-table", run.get("edits", []), lambda row: (
            row["file"], format_count(row["added"]), format_count(row["removed"]), format_count(row["rounds"])
        ))
        self._fill("#check-table", run.get("checks", []), lambda row: (
            row["name"], row["verdict"], row["kind"],
            format_count(row.get("before")), format_count(row.get("after"))
        ))
        self._fill("#extension-table", run.get("extensions", []), lambda row: (
            format_count(row["round"]), format_count(row["requested"]), row["verdict"], row["reason"]
        ))
        self._fill("#boundary-table", run.get("boundary", []), lambda row: (
            format_count(row["round"]), row["result"], row["detail"]
        ))
        self._fill("#criteria-table", run.get("criteriaAudit", []), lambda row: (
            row["criterion"], row["result"], row["detail"]
        ))
        self._fill("#rollback-table", run.get("rollbacks", []), lambda row: (
            format_count(row["round"]), format_count(row["discardedEdits"]), row["reason"]
        ))

    def _fill(self, selector: str, rows: list[dict[str, Any]], mapper: Any) -> None:
        table = self.query_one(selector, DataTable)
        table.clear()
        for row in rows:
            table.add_row(*mapper(row))

    def _render_cycles(self, cycles: list[dict[str, Any]], ledger: dict[str, Any]) -> None:
        self._fill("#cycle-table", cycles, lambda row: (
            format_count(row["n"]), row["examId"], row["verdict"],
            format_count(row["tokens"]), format_count(row["rounds"]), format_duration(row["durationS"])
        ))
        if cycles:
            self.query_one("#cycle-trend", PlotextLine).set_data(
                [row["n"] for row in cycles],
                {"tokens": [row["tokens"] for row in cycles]},
            )
        drawn = ledger.get("drawnFromResultFiles")
        rows = ledger.get("rowsWritten")
        mismatch = drawn is not None and rows is not None and drawn != rows
        tone = "yellow" if mismatch else "green"
        self.query_one("#ledger-summary", Static).update(
            f"mode [b]{ledger.get('mode', '?')}[/b]  scored writes [b]{ledger.get('scoredWrites', '?')}[/b]  "
            f"drawn cohort [{tone}]{drawn}[/{tone}] counted from result files, rows written {rows}\n"
            f"[dim]a cap death leaves no row, so the denominator is counted from files, never from rows[/dim]"
        )

    # Stream ---------------------------------------------------------------

    def _subscribe(self) -> None:
        if not self._subscribed:
            self.client.on_event(self._on_step_event)
            # Drains whatever the last burst left buffered. Without it the tail
            # of a stream waits for an event that never comes.
            self.set_interval(FLUSH_INTERVAL, self.coalescer.flush)
            self._subscribed = True

    def on_unmount(self) -> None:
        if self._subscribed:
            self.client.off_event(self._on_step_event)
            self._subscribed = False

    def _on_step_event(self, event: dict[str, Any]) -> None:
        if not self.is_mounted:
            return
        if not self.accepts_step_event(event):
            return
        self.coalescer.push(event)

    def _render_events(self, batch: list[dict[str, Any]]) -> None:
        """Render a batch. A burst costs one repaint, not one per event."""
        checklist = self.query_one("#gym-checklist", PhaseChecklist)
        log = self.query_one("#gym-events", EventLog)
        checklist.apply_events(batch)
        for event in batch:
            log.append_event(event)
        # The budget is what a watcher is actually tracking, so it climbs
        # rather than jumping. An extension GRANT is a distinct event, so it
        # gets one pulse on top of the movement.
        motion = getattr(self.app, "motion", None)
        gauge = self.query_one("#gym-tokens", Gauge)
        latest = next(
            (e for e in reversed(batch) if isinstance(e.get("counts"), dict) and "tokens" in e["counts"]),
            None,
        )
        if latest is not None:
            spent = int(latest["counts"]["tokens"])
            gauge.set_value(
                spent / GYM_TOKEN_BUDGET,
                motion=motion,
                caption=f"{spent:,} of {GYM_TOKEN_BUDGET:,} tokens",
            )
        if any(e.get("step") == "extension" and "granted" in (e.get("counts") or {}) for e in batch):
            gauge.pulse(motion)

        done = next((e for e in batch if e.get("phase") == "done"), None)
        if done is not None:
            event = done
            self.query_one("#gym-notice", Banner).set_notice(
                f"Cycle complete in {checklist.elapsed:.1f}s, job {self.job_id}. "
                f"Press Refresh status to reload the ledger.",
                "info",
            )

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "gym-start":
            event.stop()
            self.start_cycle()
        elif event.button.id == "gym-cancel":
            event.stop()
            await self.cancel_cycle()
        elif event.button.id == "gym-refresh":
            event.stop()
            self.start_load()

    async def cancel_cycle(self) -> None:
        notice = self.query_one("#gym-notice", Banner)
        if not self.job_id:
            notice.set_notice("No gym job is running.", "warn")
            return
        try:
            result = await self.client.call("jobCancel", {"jobId": self.job_id})
        except RpcError as error:
            self.report_rpc_error(error)
            return
        notice.set_notice(
            f"Cancel requested for job {self.job_id}." if result.get("cancelled") else f"Job {self.job_id} had already finished.",
            "warn" if result.get("cancelled") else "info",
        )

    @work
    async def start_cycle(self) -> None:
        repo = getattr(self.app, "selected_repo", None) or mock_data.REPOS[0]["path"]
        notice = self.query_one("#gym-notice", Banner)
        exam_id = mock_data.EXAMS[0]["examId"]

        # The gate is the owner's permission to spend at all. It is not consent
        # to THIS cycle, so the confirmation happens here regardless of what the
        # gate reads, and the engine refuses without it either way.
        estimate = None
        try:
            estimate = await self.client.call("budgetEstimate", {"repoPath": repo, "mode": "gym"})
        except RpcError as error:
            self.report_rpc_error(error)
        confirmed = await self.confirm_spend(
            method="gymStart",
            summary=(
                f"One certification cycle on {repo}, exam {exam_id}, in mode harness-debug. "
                f"The student model works the exam under the ADR-0167 harness defaults and "
                f"the teacher grades it. Nothing is written to the scored record in this mode."
            ),
            estimate_lines=list(budget_estimate_lines(estimate)),
            confirm_label="Run the cycle and spend",
        )
        if not confirmed:
            notice.set_notice("Cycle not started. Nothing was sent to a provider.", "info")
            return

        try:
            result = await self.client.call(
                "gymStart",
                {
                    "repoPath": repo,
                    "config": {"examId": exam_id, "mode": "harness-debug"},
                    "confirm": True,
                    # Every spend-confirmed call whose dialog showed an estimate
                    # echoes it, so the run record holds what the user actually
                    # saw rather than only that they said yes.
                    "budget": estimate,
                },
            )
        except RpcError as error:
            self.report_rpc_error(error)
            notice.set_notice(error.hint, "error")
            return
        self.job_id = result.get("jobId")
        self.query_one("#gym-checklist", PhaseChecklist).reset(self.job_id)
        self.query_one("#gym-events", EventLog).clear()
        notice.set_notice(f"Cycle running, job {self.job_id}, mode harness-debug.", "info")
