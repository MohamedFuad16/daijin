"""Gates. Discovered commands, classified against the baseline, user editable.

A gate that fails on baseline and candidate alike carries no signal, so the
classification and its liveness evidence are the point of this screen: nothing
here is allowed to sit in the table reporting coverage it does not have.
"""

from __future__ import annotations

from typing import Any, Iterable

from textual import work
from textual.containers import Horizontal
from textual.widgets import Button, DataTable, Static

from .. import mock_data
from ..rpc import RpcError
from ..stream import FLUSH_INTERVAL, StreamCoalescer
from ..widgets.activity import IDLE_UNTIL_INFERRED, TERMINAL_PHASES
from ..widgets import Banner, EventLog, PhaseChecklist, SectionTitle
from .base import DaijinScreen
from .dialogs import GatesFileEditScreen

GATE_COLUMNS = ("gate", "role", "classification", "enabled", "baseline", "command")

CLASSIFICATION_NOTE = {
    "live": "passes on baseline, fails on a regression. Real coverage.",
    "measured": "pre-existing violations, judged on movement rather than on a verdict.",
    "pre-broken": "fails on baseline and candidate alike. Excluded and labelled, never silent coverage.",
    "unavailable": "the command cannot run here. Excluded and labelled.",
}


class GatesScreen(DaijinScreen):
    mode_name = "gates"
    notice_id = "#gates-notice"
    heading = "Repo work gates"
    subheading = "discovered data, classified against the baseline, editable"

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.gates: list[dict[str, Any]] = []
        self.discovered: dict[str, Any] | None = None
        self.summary: dict[str, Any] | None = None
        self.parse_error: str | None = None
        self.raw_content = ""
        self.file_path = ""
        self.job_id: str | None = None
        self._subscribed = False
        self.coalescer = StreamCoalescer(self._render_events)

    def content(self) -> Iterable[Any]:
        yield Banner("", tone="info", id="gates-notice")
        with Horizontal(id="gates-controls"):
            yield Button("Discover gates", id="gates-discover", variant="primary")
            # There is no per-row action. The engine refuses a structural patch
            # with -32602 in every file state, because gates.yaml is the user's
            # document and it replaces the whole of it or nothing.
            yield Button("Edit gates.yaml", id="gates-edit")
        yield SectionTitle("gates.yaml", "the engine treats this as data")
        yield DataTable(id="gates-table", cursor_type="row")
        yield Static("", id="gates-raw", markup=True)
        yield SectionTitle("Liveness evidence", "why this gate is classified the way it is")
        yield Static("[dim]no gate selected[/dim]", id="gate-evidence", markup=True)
        yield SectionTitle("Discovery stream")
        yield PhaseChecklist(mock_data.GATES_PHASES, id="gates-checklist")
        yield EventLog(id="gates-events")

    async def load(self) -> None:
        self._subscribe()
        self.refresh_heading()
        table = self.query_one("#gates-table", DataTable)
        if not table.columns:
            table.add_columns(*GATE_COLUMNS)
        repo = getattr(self.app, "selected_repo", None)
        notice = self.query_one("#gates-notice", Banner)
        if not repo:
            notice.set_notice("No repo selected. Press 1 for the repo home and pick one.", "warn")
            return
        try:
            record = await self.client.call("gatesGet", {"repoPath": repo})
        except RpcError as error:
            notice.set_notice(error.hint, "warn")
            self.gates = []
            table.clear()
            return
        discovered = record.get("discovered")
        self.discovered = discovered if isinstance(discovered, dict) else None
        self.gates = (self.discovered or {}).get("gates") or []
        self.summary = (self.discovered or {}).get("summary")
        self.parse_error = record.get("parseError")
        # content is always present, including when the YAML is broken, because
        # gates.yaml is a file the user is invited to edit and taking their text
        # away at the moment they need to read it would be the worse failure.
        self.raw_content = str(record.get("content") or "")
        self.file_path = str(record.get("path") or "gates.yaml")
        # Three distinct states, and the difference between the second and the
        # third is the whole point: a file that describes no gates and a file
        # that could not be read both produce an empty list, and only one of
        # them makes "zero gates" a true statement.
        text_panel = self.query_one("#gates-raw", Static)

        if self.discovered is None:
            # Case 3: unreadable. The user broke a file we invited them to edit,
            # so they need the text and the error, not a zero.
            table.display = False
            text_panel.display = True
            # Not "could not be parsed": one of the reasons the engine gives is
            # a file that parses perfectly and simply has no gates: key. Naming
            # a cause the response does not claim is a false explanation, so the
            # headline stays neutral and the engine's own sentence carries it.
            text_panel.update(
                f"[b]No gate list could be taken from this file.[/b]\n"
                f"[red]{self.parse_error or 'the engine gave no reason'}[/red]\n\n"
                f"The file as it stands:\n\n"
                + (self.raw_content or "[dim]the file is empty[/dim]")
            )
            notice.set_notice(
                f"{record.get('path', 'gates.yaml')}: no gate list could be taken "
                f"from it, so nothing in it is classified. This is not zero gates, "
                f"and the reason is above.",
                "error",
            )
            self._show_gate({})
            return

        if not self.gates:
            # Case 2: readable and genuinely empty. Zero is TRUE here, so the
            # table is the right rendering and says so.
            table.display = True
            text_panel.display = False
            table.clear()
            notice.set_notice(
                f"{record.get('path', 'gates.yaml')} describes no gates. Nothing "
                f"guards this repo's work, which is a real answer rather than a "
                f"missing one.",
                "warn",
            )
            self._show_gate({})
            return

        table.display = True
        text_panel.display = False
        table.clear()
        for gate in self.gates:
            baseline = gate.get("baseline") or {}
            # A row the user just wrote carries only what they typed. The
            # classification and the baseline are written by discovery, so
            # until it runs these keys are ABSENT rather than false, and a
            # blank cell would read as a verdict nobody reached.
            table.add_row(
                gate.get("id", ""),
                gate.get("role") or "-",
                gate.get("classification") or "not classified",
                "yes" if gate.get("enabled") else ("no" if "enabled" in gate else "-"),
                baseline.get("status") or "not run",
                gate.get("command", ""),
                key=gate.get("id"),
            )
        dead = [g for g in self.gates if g.get("classification") in ("pre-broken", "unavailable")]
        # The engine counts carryingSignal itself. Preferring its number over a
        # recount here means the screen and the ledger cannot drift; a summary
        # of nothing and no summary are different facts, so a missing one is
        # said rather than replaced with a zero.
        summary = self.summary if isinstance(self.summary, dict) else None
        if summary:
            carrying = summary.get("carryingSignal")
            counted = f"{carrying} of {summary.get('total')} carrying signal"
        else:
            # The ORDINARY state after any edit, not an error: no baseline has
            # run over these rows yet. "no summary reported" read like something
            # had failed, and nothing had.
            counted = f"{len(self.gates)} gates, not yet measured; run discovery to classify"
        notice.set_notice(
            f"{record.get('path', 'gates.yaml')}: {counted}, "
            f"{len(dead)} excluded and labelled ({', '.join(g['id'] for g in dead) or 'none'}).",
            "warn" if dead else "info",
        )
        if self.gates:
            self._show_gate(self.gates[0])

    def _show_gate(self, gate: dict[str, Any]) -> None:
        if not gate:
            # Which empty this is matters. One says the file has nothing in it,
            # the other says we could not find out what is in it.
            reason = (
                "no gate list could be taken from the file, so nothing in it is classified"
                if self.discovered is None
                else "the file describes no gates, so there is nothing to explain"
            )
            self.query_one("#gate-evidence", Static).update(f"[dim]No gate to explain: {reason}.[/dim]")
            return
        classification = str(gate.get("classification") or "")
        baseline = gate.get("baseline") or {}
        # The measurement's own words, not a paraphrase of them. When discovery
        # has not run over this row there is no measurement to quote, and
        # saying so beats printing None four times.
        if not baseline:
            evidence = [
                "No baseline has been run over this row, so nothing here is "
                "measured yet. Run discovery to classify it."
            ]
        else:
            evidence = [
                f"status {baseline.get('status', 'not run')}, exit {baseline.get('exitCode')}, "
                f"{baseline.get('durationMs')} ms of a {baseline.get('timeoutMs')} ms budget"
            ]
        if baseline.get("unavailableReason"):
            evidence.append(f"unavailable: {baseline['unavailableReason']}")
        if gate.get("unavailableHint"):
            evidence.append(f"hint: {gate['unavailableHint']}")
        for stream in ("stdoutTail", "stderrTail"):
            tail = str(baseline.get(stream) or "").strip()
            if tail:
                evidence.append(f"{stream}: {tail.splitlines()[-1][:100]}")
        # source is written by discovery too, so a hand-typed row has none and
        # "from None" is the word None leaking into copy.
        origin = f"  [dim]from {gate['source']}[/dim]" if gate.get("source") else "  [dim]hand written[/dim]"
        self.query_one("#gate-evidence", Static).update(
            f"[b]{gate.get('id')}[/b]  {gate.get('command')}{origin}\n"
            f"classification [b]{classification or 'not classified'}[/b]  "
            f"[dim]{CLASSIFICATION_NOTE.get(classification, '')}[/dim]\n"
            + "\n".join(evidence)
        )

    def _selected_gate(self) -> dict[str, Any] | None:
        table = self.query_one("#gates-table", DataTable)
        if not table.row_count:
            return None
        try:
            key = table.coordinate_to_cell_key(table.cursor_coordinate).row_key.value
        except Exception:
            return None
        for gate in self.gates:
            if gate.get("id") == key:
                return gate
        return None

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        key = event.row_key.value if event.row_key else None
        for gate in self.gates:
            if gate.get("id") == key:
                self._show_gate(gate)
                return

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        button_id = event.button.id
        event.stop()
        if button_id == "gates-discover":
            await self.discover()
        elif button_id == "gates-edit":
            self.edit_document()

    @work
    async def edit_document(self) -> None:
        """Edit the whole document, which is the only write the engine accepts.

        Reachable in every state including the unreadable one, because that is
        the state the user most needs to edit out of and gatesSet is the only
        way back.
        """
        repo = getattr(self.app, "selected_repo", None)
        notice = self.query_one("#gates-notice", Banner)
        if not repo:
            notice.set_notice("No repo selected.", "warn")
            return
        content = await self.app.push_screen_wait(
            GatesFileEditScreen(
                path=self.file_path or "gates.yaml",
                content=self.raw_content,
                parse_error=self.parse_error,
            )
        )
        if content is None:
            return
        try:
            await self.client.call("gatesSet", {"repoPath": repo, "patch": {"content": content}})
        except RpcError as error:
            self.report_rpc_error(error)
            return
        self.set_pending_notice(
            "gates.yaml saved. Classification and baseline evidence come from "
            "discovery, so rows you edited read as unclassified until it runs."
        )
        self.start_load()

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
        checklist = self.query_one('#gates-checklist', PhaseChecklist)
        if checklist.infer_finish_if_idle():
            # A stream that simply stopped still ends the claim that it is
            # running. Saying so is not the same as saying it succeeded, so the
            # copy names the inference rather than reporting a result.
            self.query_one("#gates-notice", Banner).set_notice(
                f"Discovery stream went quiet for job {self.job_id}. It may have "
                f"finished; the engine never said so. Reload to see the file as "
                f"it stands.",
                "warn",
            )

    def _render_events(self, batch: list[dict[str, Any]]) -> None:
        """Render a batch. A burst costs one repaint, not one per event."""
        checklist = self.query_one("#gates-checklist", PhaseChecklist)
        log = self.query_one("#gates-events", EventLog)
        checklist.apply_events(batch)
        for event in batch:
            log.append_event(event)

        done = next((e for e in batch if e.get("phase") in TERMINAL_PHASES), None)
        if done is None:
            return
        # Discovery WRITES the classification this screen exists to show, and
        # nothing here read its ending: the banner went on claiming the job was
        # running forever, and the table went on showing the state from before
        # it ran. The phase says it ended; level says how.
        level = str(done.get("level") or "info")
        notice = self.query_one("#gates-notice", Banner)
        if level == "error":
            detail = str(done.get("detail") or "").strip()
            notice.set_notice(
                f"Discovery FAILED for job {self.job_id}. The gates below are "
                f"whatever was there before it ran, not a fresh classification. "
                f"{detail}".strip(),
                "error",
            )
            return
        if level == "warn":
            notice.set_notice(
                f"Discovery cancelled, job {self.job_id}. The gates below are "
                f"whatever was there before it ran.",
                "warn",
            )
            return
        # Only a run that ENDED WELL has written something new to read.
        self.set_pending_notice(
            f"Discovery finished in {checklist.elapsed:.1f}s, job {self.job_id}."
        )
        self.start_load()

    async def discover(self) -> None:
        repo = getattr(self.app, "selected_repo", None)
        notice = self.query_one("#gates-notice", Banner)
        if not repo:
            notice.set_notice("No repo selected.", "warn")
            return
        try:
            result = await self.client.call("gatesDiscover", {"repoPath": repo})
        except RpcError as error:
            self.report_rpc_error(error)
            return
        self.job_id = result.get("jobId")
        self.query_one("#gates-checklist", PhaseChecklist).reset(self.job_id)
        self.query_one("#gates-events", EventLog).clear()
        notice.set_notice(f"Discovery running for {repo}, job {self.job_id}.", "info")
