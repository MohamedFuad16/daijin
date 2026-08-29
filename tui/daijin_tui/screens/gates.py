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

from textual.content import Content

from .. import mock_data
from ..rpc import RpcError
from ..stream import FLUSH_INTERVAL, StreamCoalescer
from ..widgets.activity import IDLE_UNTIL_INFERRED, TERMINAL_PHASES
from ..widgets import Banner, EventLog, PhaseChecklist, SectionTitle, cells
from .base import DaijinScreen
from .dialogs import GatesFileEditScreen

GATE_COLUMNS = ("check", "kind", "state", "used", "last run", "command")

# Wire values stay the contract's; what the user reads is plainer (D-0067).
CLASSIFICATION_LABELS = {
    "live": "working",
    "measured": "tracked by number",
    "pre-broken": "already failing",
    "unavailable": "cannot run here",
}

CLASSIFICATION_NOTE = {
    "live": "passes on the untouched repo, so a failure after a change means the change broke it.",
    "measured": "prints a number; judged on whether the number gets worse, not pass/fail.",
    "pre-broken": "already failing before any change, so it cannot judge one. Set aside, never counted as coverage.",
    "unavailable": "its tool is not installed on this machine. Set aside, never counted as coverage.",
}


class GatesScreen(DaijinScreen):
    mode_name = "gates"
    notice_id = "#gates-notice"
    heading = "Checks"
    subheading = "the repo's own tests, builds and linters; daijin runs them to judge a change"

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
        yield Static(
            "These are the checks daijin found in this repo - test, build and lint "
            "commands. Before the gym grades a change, it runs them on the untouched "
            "code and again after the change: a check that passes before and fails "
            "after is how a bad change gets caught.",
            id="gates-intro",
            markup=True,
        )
        with Horizontal(id="gates-controls"):
            yield Button("Find this repo's checks", id="gates-discover", variant="primary")
            # There is no per-row action. The engine refuses a structural patch
            # with -32602 in every file state, because gates.yaml is the user's
            # document and it replaces the whole of it or nothing.
            yield Button("Edit gates.yaml", id="gates-edit")
        yield SectionTitle("Discovered checks", "stored in gates.yaml; edit it and the engine obeys")
        yield DataTable(id="gates-table", cursor_type="row")
        yield Static("", id="gates-raw", markup=True)
        yield SectionTitle("Why it is classified that way", "select a row above")
        yield Static("[dim]no check selected[/dim]", id="gate-evidence", markup=True)
        # The discovery progress exists only while a discovery is running; an idle
        # checklist of pending steps read as a broken widget (owner field, 2026-08-22).
        yield SectionTitle("Finding checks", id="gates-stream-title")
        yield PhaseChecklist(mock_data.GATES_PHASES, id="gates-checklist")
        yield EventLog(id="gates-events")

    async def load(self) -> None:
        self._subscribe()
        self.refresh_heading()
        # The progress stream earns its screen space only once a discovery has
        # run; an idle checklist of pending steps read as a broken widget.
        self._set_stream_visible(self.job_id is not None)
        table = self.query_one("#gates-table", DataTable)
        if not table.columns:
            table.add_columns(*GATE_COLUMNS)
        repo = getattr(self.app, "selected_repo", None)
        notice = self.query_one("#gates-notice", Banner)
        if not repo:
            notice.set_notice("No repo selected. Press 1 for the repo home and pick one.", "warn")
            # The STALE TABLE was the glitch the owner met (round 8): detach a
            # repo and this screen kept its last rows under a true banner,
            # which reads as data about nothing. No repo, no rows.
            self.gates = []
            table.clear()
            self._show_gate({})
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
            # $raw substitutes as PLAIN text: gates.yaml is the user's file and
            # its bracketed lists parse as markup tags if interpolated raw.
            text_panel.update(Content.from_markup(
                "[b]No gate list could be taken from this file.[/b]\n"
                f"[red]{self.parse_error or 'the engine gave no reason'}[/red]\n\n"
                "The file as it stands:\n\n$raw",
                raw=self.raw_content or "(the file is empty)",
            ))
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
            classification = gate.get("classification")
            table.add_row(*cells(
                gate.get("id", ""),
                gate.get("role") or "-",
                CLASSIFICATION_LABELS.get(classification, classification or "not checked yet"),
                "yes" if gate.get("enabled") else ("no" if "enabled" in gate else "-"),
                baseline.get("status") or "not run",
                gate.get("command", ""),
            ), key=gate.get("id"))
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

    def _set_stream_visible(self, visible: bool) -> None:
        for selector in ("#gates-stream-title", "#gates-checklist", "#gates-events"):
            for widget in self.query(selector):
                widget.display = visible

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
                "This check has not been run yet. Press \"Find this repo's checks\" "
                "to run and classify it."
            ]
        else:
            status = baseline.get("status", "not run")
            took = baseline.get("durationMs")
            took_text = f" in {took / 1000:.1f}s" if isinstance(took, (int, float)) else ""
            said = {"pass": "succeeded", "fail": "failed", "unavailable": "could not run"}.get(status, status)
            evidence = [f"On the untouched repo, this check {said}{took_text}."]
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
        origin = "  [dim]found in $source[/dim]" if gate.get("source") else "  [dim]added by hand[/dim]"
        # Every value below is the REPO'S or the ENGINE'S text, not ours: the
        # shell command out of gates.yaml, the engine's unavailable reason and
        # hint, and the tails of the check's own stdout and stderr. A pytest
        # parametrised id ("test_read[/tmp/x]") or any bracketed path in that
        # output is a closing markup tag with nothing open, which is a
        # MarkupError that kills the app. $variables substitute as plain text.
        self.query_one("#gate-evidence", Static).update(Content.from_markup(
            "[b]$gate_id[/b]  $command" + origin + "\n"
            "[b]$label[/b]  [dim]$note[/dim]\n"
            "$evidence",
            gate_id=str(gate.get("id") or ""),
            command=str(gate.get("command") or ""),
            source=str(gate.get("source") or ""),
            label=CLASSIFICATION_LABELS.get(classification, classification or "not checked yet"),
            note=CLASSIFICATION_NOTE.get(classification, ""),
            evidence="\n".join(evidence),
        ))

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
            self._set_stream_visible(True)
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
