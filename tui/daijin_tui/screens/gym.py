"""Gym live view. Same step-event stream as init, plus the run ledger."""

from __future__ import annotations

from typing import Any, Iterable

from textual import work
from textual.containers import Horizontal
from textual.widgets import Button, DataTable, Select, Static, TabbedContent, TabPane

from .. import mock_data
from ..concurrency import gather_all
from ..rpc import RpcError
from ..stream import FLUSH_INTERVAL, StreamCoalescer
from ..widgets.activity import IDLE_UNTIL_INFERRED, TERMINAL_PHASES
from ..widgets import (
    Banner,
    EventLog,
    Gauge,
    PhaseChecklist,
    PlotextLine,
    SectionTitle,
    cells,
    format_count,
    format_duration,
)
from .base import DaijinScreen
from .dialogs import ConfirmScreen, budget_estimate_lines


# The extension ceiling a cycle works against, from the ADR-0167 defaults.
GYM_TOKEN_BUDGET = 400_000


# Client-side sentinel for the "run every ready exam" pick; never on the wire.
ALL_EXAMS = "__all__"


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
            # The exam is part of what the user consents to spend on, so it is
            # chosen here and read from the engine. It used to be
            # mock_data.EXAMS[0], which put a fictional exam id into the one
            # dialog whose whole job is telling the truth about a paid call.
            yield Select([], id="gym-exam", prompt="exam to certify", allow_blank=True)
            # The mode is part of what the user consents to. harness-debug is
            # quarantined and UNGRADED (the ledger refuses rubrics for it);
            # experiment is graded by the teacher but never scored; evaluation
            # is the scored record itself.
            # Plain words on screen, contract words on the wire (D-0067).
            yield Select(
                [
                    ("Practice run (not graded)", "harness-debug"),
                    ("Graded practice (teacher grades, nothing counts)", "experiment"),
                    ("Official run (graded AND counts on the record)", "evaluation"),
                ],
                value="harness-debug",
                id="gym-mode",
                allow_blank=False,
            )
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
            with TabPane("Lessons", id="gym-tab-lessons"):
                yield Static(
                    "After a graded run, [b]Learn from results[/b] asks the teacher what "
                    "knowledge would have prevented each gap. The answers become lesson "
                    "proposals, checked against the current code, and land here for your "
                    "review. Nothing touches the brain until you press "
                    "[b]Write lessons into the brain[/b], and only an evaluation run's "
                    "lessons can be written: an experiment run's lessons are advice to read.",
                    id="harvest-explainer",
                    markup=True,
                )
                yield SectionTitle("Lesson batches", "select a row, then write its lessons into the brain")
                yield DataTable(id="harvest-table", cursor_type="row")
                with Horizontal(id="harvest-actions"):
                    yield Button("Learn from results (spends)", id="gym-harvest", variant="primary")
                    yield Button("Write lessons into the brain", id="gym-apply")

    async def load(self) -> None:
        self._subscribe()
        self.refresh_heading()
        self._init_columns()
        await self._load_exams()
        # The run ledger and the gate state have nothing to do with each other.
        # gymStatus likewise requires repoPath, which the v5 contract row for it
        # does not mention. Reported to the leader.
        gym_params: dict[str, Any] = {}
        repo = getattr(self.app, "selected_repo", None)
        if repo:
            gym_params["repoPath"] = repo
        status_result, gate_result = await gather_all(
            self.client.call("gymStatus", gym_params),
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
        self._render_harvest(status.get("harvest") or [])
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
            f"spending [{tone}]{'unlocked' if self.gate_open else 'locked'}[/{tone}]  "
            f"[dim]{'this run can pay providers' if self.gate_open else 'you will be asked to unlock when you start'}[/dim]"
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
            "#harvest-table": ("batch", "cycle", "mode", "asked", "kept", "dropped", "written to brain"),
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
            table.add_row(*cells(*mapper(row)))

    @staticmethod
    def _cycle_number(row: dict[str, Any], position: int) -> int:
        """Cycle index under either name. The engine says id, the mock says n."""
        for key in ("n", "id", "cycle_id"):
            value = row.get(key)
            if isinstance(value, int):
                return value
        return position

    @staticmethod
    def _cycle_tokens(row: dict[str, Any]) -> int:
        for key in ("tokens", "work_tokens"):
            value = row.get(key)
            if isinstance(value, (int, float)):
                return int(value)
        return 0

    def _render_cycles(self, cycles: list[dict[str, Any]], ledger: dict[str, Any]) -> None:
        numbered = [(self._cycle_number(row, i), row) for i, row in enumerate(cycles, start=1)]
        table = self.query_one("#cycle-table", DataTable)
        table.clear()
        for number, row in numbered:
            table.add_row(*cells(
                format_count(number),
                row.get("examId") or row.get("exam_id") or "-",
                row.get("verdict") or "not graded",
                format_count(self._cycle_tokens(row)),
                format_count(row.get("rounds")),
                format_duration(row.get("durationS")),
            ))
        if numbered:
            self.query_one("#cycle-trend", PlotextLine).set_data(
                [n for n, _ in numbered],
                {"tokens": [self._cycle_tokens(row) for _, row in numbered]},
            )
        drawn = ledger.get("drawnFromResultFiles")
        rows = ledger.get("rowsWritten")
        mismatch = drawn is not None and rows is not None and drawn != rows
        tone = "yellow" if mismatch else "green"
        self.query_one("#ledger-summary", Static).update(
            f"mode [b]{ledger.get('mode', '?')}[/b]  scored writes [b]{ledger.get('scoredWrites', '?')}[/b]  "
            f"exams drawn [{tone}]{drawn}[/{tone}] (counted from result files), graded rows written {rows}\n"
            f"[dim]a run that dies at its token cap leaves no row, so the drawn count comes from files, never from rows[/dim]"
        )

    def _render_harvest(self, batches: list[dict[str, Any]]) -> None:
        self.harvest_rows = {row.get("id"): row for row in batches}
        table = self.query_one("#harvest-table", DataTable)
        table.clear()
        for row in batches:
            table.add_row(*cells(
                str(row.get("id", "-")),
                str(row.get("cycleId", "-")),
                str(row.get("mode", "-")),
                format_count(row.get("questionsAsked")),
                format_count(row.get("accepted")),
                format_count(row.get("rejected")),
                # "no" for an unapplied batch, never blank: an unapplied batch
                # being visibly unapplied is the whole point of the column.
                f"yes, {row.get('written')} lesson(s)" if row.get("applied") else "no",
            ), key=str(row.get("id")))

    # Stream ---------------------------------------------------------------

    def _subscribe(self) -> None:
        if not self._subscribed:
            self.client.on_event(self._on_step_event)
            # Drains whatever the last burst left buffered. Without it the tail
            # of a stream waits for an event that never comes.
            self.set_interval(FLUSH_INTERVAL, self.coalescer.flush)
            self.set_interval(1.0, self._check_idle)
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

    def _check_idle(self) -> None:
        """The stream has no terminal event, so a quiet run has to be inferred."""
        if not self.is_mounted:
            return
        checklist = self.query_one('#gym-checklist', PhaseChecklist)
        if checklist.infer_finish_if_idle():
            for widget in self.query("#gym-notice"):
                widget.set_notice(
                    f"No step events for {IDLE_UNTIL_INFERRED:.0f}s, so this run is "
                    f"treated as finished. The stream carries no terminal event, so "
                    f"that is inferred, not reported by the engine.",
                    "warn",
                )

    async def _load_exams(self) -> None:
        """Fill the picker from the engine, never from the fixture table."""
        select = self.query_one("#gym-exam", Select)
        repo = getattr(self.app, "selected_repo", None)
        if not repo:
            select.set_options([])
            return
        try:
            rows = await self.client.call("examList", {"repoPath": repo, "filters": {}})
        except RpcError as error:
            # A repo with no ledger has no exams to certify. The picker stays
            # empty and start_cycle refuses, which is the honest chain.
            select.set_options([])
            self.report_rpc_error(error)
            return
        exams = rows if isinstance(rows, list) else (rows or {}).get("exams", [])
        self.exam_rows = {e.get("examId"): e for e in exams}
        # The LABEL carries what decides whether a pick can run: a draft exam
        # cannot produce a scored row, and a held-out exam is drawn only by an
        # explicit held-out cohort. The owner picked one blind and met the
        # refusal after consenting to spend.
        def label(row: dict) -> str:
            marks = []
            if row.get("status") and row["status"] != "promoted":
                marks.append(str(row["status"]))
            if row.get("heldOut"):
                marks.append("held out")
            suffix = f"  [{', '.join(marks)}]" if marks else ""
            # ONE line per exam: a title that wraps breaks the picker into
            # unreadable halves (owner field, 2026-08-22), so it is trimmed
            # to fit beside its id and marks.
            title = str(row.get("title", ""))
            room = max(12, 46 - len(suffix))
            if len(title) > room:
                title = title[: room - 1].rstrip() + "\u2026"
            return f"{row.get('examId')}  {title}{suffix}".strip()

        options = [(label(e), e.get("examId")) for e in exams]
        # Every runnable exam in one go. The engine draws the whole ready bank
        # and skips reserved exams itself; ALL_EXAMS is a client-side sentinel,
        # never sent on the wire.
        runnable = [e for e in exams if e.get("status") == "promoted"]
        if len(runnable) > 1:
            options.insert(0, (f"All ready exams ({len(runnable)})", ALL_EXAMS))
        select.set_options(options)

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

        # TERMINAL_PHASES, not a literal. The wire sends exactly one phase
        # here and this constant names it, so the value is not the point: the
        # SHARED SOURCE is. A literal at three call sites is how two of them
        # came to miss the terminal event entirely while the third handled it.
        done = next((e for e in batch if e.get("phase") in TERMINAL_PHASES), None)
        if done is not None:
            # This announced "Cycle complete" for every ending, failures
            # included. A gym cycle is spend touching, so a run that broke
            # after calling a paid provider was being reported as a success.
            # The phase says it ended; level says how.
            level = str(done.get("level") or "info")
            if level == "error":
                detail = str(done.get("detail") or done.get("message") or "").strip()
                message = (
                    f"Cycle FAILED after {checklist.elapsed:.1f}s, job {self.job_id}. "
                    f"Spend may already have happened, so check the ledger before "
                    f"starting another. {detail}".strip()
                )
            elif level == "warn":
                message = (
                    f"Cycle cancelled after {checklist.elapsed:.1f}s, job {self.job_id}. "
                    f"Press Refresh status to reload the ledger."
                )
            else:
                message = (
                    f"Cycle complete in {checklist.elapsed:.1f}s, job {self.job_id}. "
                    f"Press Refresh status to reload the ledger."
                )
            self.query_one("#gym-notice", Banner).set_notice(
                message,
                {"error": "error", "warn": "warn"}.get(level, "info"),
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
        elif event.button.id == "gym-harvest":
            event.stop()
            self.learn_from_results()
        elif event.button.id == "gym-apply":
            event.stop()
            self.apply_lessons()

    @work
    async def learn_from_results(self) -> None:
        """gymHarvest: the teacher answers one question per graded gap.

        Proposal-only: the job records a batch for review and writes nothing
        into the brain. Same locks as a cycle (gate scope gym-cycle, per-call
        consent), and the gate re-blocks itself when the job ends.
        """
        notice = self.query_one("#gym-notice", Banner)
        repo = getattr(self.app, "selected_repo", None)
        if not repo:
            notice.set_notice("No repo selected. Press 1 for the repo home and pick one.", "warn")
            return
        confirmed = await self.confirm_spend(
            method="gymHarvest",
            summary=(
                "Learning from results asks the TEACHER role one question per graded "
                "gap: what knowledge, had it been retrieved, would have prevented "
                "this? The answers become lesson proposals for your review. Nothing "
                "is written to the brain by this call."
            ),
            estimate_lines=["one teacher generation over the graded gaps",
                            "plus free local checks of every proposed citation"],
            confirm_label="Ask the teacher and spend",
        )
        if not confirmed:
            notice.set_notice("Not started. Nothing was sent to a provider.", "info")
            return
        result = None
        for attempt in range(2):
            try:
                result = await self.client.call("gymHarvest", {"repoPath": repo, "confirm": True})
                break
            except RpcError as error:
                if error.is_spend_gate and attempt == 0:
                    opened = await self.offer_gate_open(
                        scope="gym-cycle",
                        repo=repo,
                        why="The spend gate is blocked, so the teacher cannot be paid to answer.",
                    )
                    if opened:
                        continue
                self.report_rpc_error(error)
                notice.set_notice(error.hint, "error")
                return
        if result is None:
            return
        self.job_id = result.get("jobId")
        notice.set_notice(
            f"Learning from results, job {self.job_id}. The batch lands in the "
            f"Lessons tab when it finishes; press Refresh status to reload.",
            "info",
        )

    @work
    async def apply_lessons(self) -> None:
        """gymHarvestApply: the owner's hand writes the accepted lessons.

        No provider is called; the confirmation is still explicit because this
        writes into the repo's brain and reindexes it.
        """
        notice = self.query_one("#gym-notice", Banner)
        repo = getattr(self.app, "selected_repo", None)
        if not repo:
            notice.set_notice("No repo selected. Press 1 for the repo home and pick one.", "warn")
            return
        table = self.query_one("#harvest-table", DataTable)
        row_key = None
        if table.row_count:
            try:
                row_key = table.coordinate_to_cell_key(table.cursor_coordinate).row_key.value
            except Exception:  # noqa: BLE001 - no selection is a normal state
                row_key = None
        if row_key is None:
            notice.set_notice("Select a lesson batch row first, in the Lessons tab.", "warn")
            return
        batch = getattr(self, "harvest_rows", {}).get(int(row_key)) or {}
        if batch.get("applied"):
            notice.set_notice(f"Batch {row_key} is already written into the brain.", "info")
            return
        if batch.get("mode") != "evaluation":
            notice.set_notice(
                f"Batch {row_key} came from a {batch.get('mode')} run, which never writes "
                f"the brain. Its lessons are advice to read; only an evaluation run's "
                f"lessons can be written.",
                "warn",
            )
            return
        if not batch.get("accepted"):
            notice.set_notice(
                f"Batch {row_key} kept no lessons, so there is nothing to write. "
                f"A zero is a recorded outcome, not a failure.",
                "info",
            )
            return
        confirmed = await self.app.push_screen_wait(
            ConfirmScreen(
                title=f"Write batch {row_key} into the brain",
                body=(
                    f"{batch.get('accepted')} lesson(s) will be written into this repo's "
                    f"brain as durable markdown, and the index will be rebuilt so "
                    f"retrieval serves them. This is the step that makes the gym teach."
                ),
                confirm_label="Write the lessons",
            )
        )
        if not confirmed:
            notice.set_notice("Nothing written. The batch stays reviewable.", "info")
            return
        try:
            result = await self.client.call(
                "gymHarvestApply", {"repoPath": repo, "batchId": int(row_key), "confirm": True}
            )
        except RpcError as error:
            self.report_rpc_error(error)
            notice.set_notice(error.hint, "error")
            return
        self.job_id = result.get("jobId")
        notice.set_notice(
            f"Writing lessons, job {self.job_id}. Press Refresh status when it "
            f"finishes to see the batch marked as written.",
            "info",
        )

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
        notice = self.query_one("#gym-notice", Banner)
        # No fixture fallbacks on a spend path. A dialog that asks consent for a
        # repo the user did not choose, or an exam the engine never heard of, is
        # asking them to approve something that will not happen.
        repo = getattr(self.app, "selected_repo", None)
        if not repo:
            notice.set_notice(
                "No repo selected, so there is nothing to certify. Press 1 for "
                "the repo home and pick one.",
                "warn",
            )
            return
        # Only a real exam id counts. Textual's blank sentinel is neither None
        # nor a string, and comparing against the wrong one let it reach the
        # wire as an unserializable object.
        exam_id = self.query_one("#gym-exam", Select).value
        if not isinstance(exam_id, str) or not exam_id:
            notice.set_notice(
                "Pick an exam to certify first. The cycle spends against one "
                "exam and the confirmation names it.",
                "warn",
            )
            return

        # The gate is the owner's permission to spend at all. It is not consent
        # to THIS cycle, so the confirmation happens here regardless of what the
        # gate reads, and the engine refuses without it either way.
        estimate = None
        try:
            estimate = await self.client.call("budgetEstimate", {"repoPath": repo, "mode": "gym"})
        except RpcError as error:
            self.report_rpc_error(error)

        mode = str(self.query_one("#gym-mode", Select).value or "harness-debug")
        # PICKING A HELD-OUT EXAM BY NAME IS THE EXPLICIT ACT the rule asks
        # for, so the client says so on the wire rather than sending a
        # training cohort the engine must refuse. The reserved split stays
        # honest: nothing is auto-drawn into it, and the dialog says which
        # cohort the run is. The all-exams pick draws the whole ready bank
        # (the engine skips reserved exams itself) and is always training.
        run_all = exam_id == ALL_EXAMS
        runnable = [e for e in getattr(self, "exam_rows", {}).values() if e.get("status") == "promoted"]
        chosen = {} if run_all else (getattr(self, "exam_rows", {}).get(exam_id) or {})
        cohort = "held-out" if chosen.get("heldOut") else "training"
        what = (
            f"every ready exam ({len(runnable)} of them), one attempt each,"
            if run_all
            else f"exam {exam_id},"
        )
        confirmed = await self.confirm_spend(
            method="gymStart",
            summary=(
                f"One certification cycle on {repo}, {what} in mode {mode}. "
                + ("This exam is reserved (held out), so the run is recorded as a reserved draw. "
                   if cohort == "held-out" else "")
                + (
                    "The engineer works the exam and the TEACHER role grades each "
                    "applied attempt in this mode."
                    if mode != "harness-debug"
                    else "The engineer works the exam; this mode is ungraded and never scored."
                )
                + (
                    " Evaluation rows enter the SCORED RECORD."
                    if mode == "evaluation"
                    else " Nothing is written to the scored record in this mode."
                )
            ),
            estimate_lines=list(budget_estimate_lines(estimate)),
            confirm_label="Run the cycle and spend",
        )
        if not confirmed:
            notice.set_notice("Cycle not started. Nothing was sent to a provider.", "info")
            return

        result = None
        for attempt in range(2):
            try:
                config: dict[str, Any] = {"mode": mode, "cohort": cohort}
                if run_all:
                    config["cohortSize"] = max(1, len(runnable))
                else:
                    config["examId"] = exam_id
                result = await self.client.call(
                    "gymStart",
                    {
                        "repoPath": repo,
                        "config": config,
                        "confirm": True,
                        # Every spend-confirmed call whose dialog showed an estimate
                        # echoes it, so the run record holds what the user actually
                        # saw rather than only that they said yes.
                        "budget": estimate,
                    },
                )
                break
            except RpcError as error:
                # The gate refusal becomes a BUTTON (owner round 9), scoped to
                # gym-cycle and auto-re-blocked when the run ends.
                if error.is_spend_gate and attempt == 0:
                    opened = await self.offer_gate_open(
                        scope="gym-cycle",
                        repo=repo,
                        why="The spend gate is blocked, so no student run can pay a provider.",
                    )
                    if opened:
                        continue
                self.report_rpc_error(error)
                notice.set_notice(error.hint, "error")
                return
        if result is None:
            return
        self.job_id = result.get("jobId")
        self.query_one("#gym-checklist", PhaseChecklist).reset(self.job_id)
        self.query_one("#gym-events", EventLog).clear()
        notice.set_notice(f"Cycle running, job {self.job_id}, mode {mode}.", "info")
