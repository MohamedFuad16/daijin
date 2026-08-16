"""Gates. Discovered commands, classified against the baseline, user editable.

A gate that fails on baseline and candidate alike carries no signal, so the
classification and its liveness evidence are the point of this screen: nothing
here is allowed to sit in the table reporting coverage it does not have.
"""

from __future__ import annotations

from typing import Any, Iterable

from textual.containers import Horizontal
from textual.widgets import Button, DataTable, Static

from .. import mock_data
from ..rpc import RpcError
from ..stream import FLUSH_INTERVAL, StreamCoalescer
from ..widgets.activity import IDLE_UNTIL_INFERRED
from ..widgets import Banner, EventLog, PhaseChecklist, SectionTitle, format_count
from .base import DaijinScreen

GATE_COLUMNS = ("gate", "classification", "metric", "baseline violations", "enabled", "command")

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
        self.raw_content = ""
        self.job_id: str | None = None
        self._subscribed = False
        self.coalescer = StreamCoalescer(self._render_events)

    def content(self) -> Iterable[Any]:
        yield Banner("", tone="info", id="gates-notice")
        with Horizontal(id="gates-controls"):
            yield Button("Discover gates", id="gates-discover", variant="primary")
            yield Button("Mark measured", id="gates-measured")
            yield Button("Mark pre-broken", id="gates-prebroken")
            yield Button("Toggle enabled", id="gates-toggle")
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
        self.gates = record.get("gates") or []
        self.raw_content = str(record.get("content") or "")
        # Two different situations produce no structured list, and this client
        # cannot tell them apart: a repo whose gates were never discovered, and
        # a response that does not carry the classification. So the copy states
        # only what is observable, which stays true in both cases and stays
        # true after the wire gains the structured rows.
        #
        # What it must never do is render an empty TABLE, because that says
        # "this repo has no gates", which is a claim and a false one when the
        # file has three in it.
        structured = bool(self.gates)
        self.query_one("#gates-table", DataTable).display = structured
        raw = self.query_one("#gates-raw", Static)
        raw.display = not structured
        if not structured:
            raw.update(
                "[b]No classified gate list came back for this repo.[/b] That is "
                "either because discovery has not run here, or because the "
                "response carried the file without its classification. Either "
                "way the file is worth reading, so here it is verbatim:\n\n"
                + (self.raw_content or "[dim]the file is empty[/dim]")
            )
            notice.set_notice(
                f"{record.get('path', 'gates.yaml')}: showing the file itself, "
                f"because nothing is a safer thing to table than a zero this "
                f"screen cannot stand behind. Run discovery if it has not run.",
                "warn",
            )
            self._show_gate({})
            return
        table.clear()
        for gate in self.gates:
            table.add_row(
                gate.get("name", ""),
                gate.get("classification", ""),
                gate.get("metric") or "-",
                format_count(gate.get("baselineViolations")),
                "yes" if gate.get("enabled") else "no",
                gate.get("command", ""),
                key=gate.get("name"),
            )
        dead = [g for g in self.gates if g.get("classification") in ("pre-broken", "unavailable")]
        live = [g for g in self.gates if g.get("classification") in ("live", "measured")]
        tone = "warn" if dead else "info"
        notice.set_notice(
            f"{record.get('path', 'gates.yaml')}: {len(live)} carrying signal, "
            f"{len(dead)} excluded and labelled ({', '.join(g['name'] for g in dead) or 'none'}).",
            tone,
        )
        if self.gates:
            self._show_gate(self.gates[0])

    def _show_gate(self, gate: dict[str, Any]) -> None:
        if not gate:
            self.query_one("#gate-evidence", Static).update(
                "[dim]No structured gate to explain: the wire carries the file, "
                "not its classification.[/dim]"
            )
            return
        classification = str(gate.get("classification", ""))
        self.query_one("#gate-evidence", Static).update(
            f"[b]{gate.get('name')}[/b]  {gate.get('command')}  [dim]from {gate.get('source')}[/dim]\n"
            f"classification [b]{classification}[/b]  [dim]{CLASSIFICATION_NOTE.get(classification, '')}[/dim]\n"
            f"{gate.get('evidence', 'no evidence recorded')}"
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
            if gate.get("name") == key:
                return gate
        return None

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        key = event.row_key.value if event.row_key else None
        for gate in self.gates:
            if gate.get("name") == key:
                self._show_gate(gate)
                return

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        button_id = event.button.id
        event.stop()
        if button_id == "gates-discover":
            await self.discover()
        elif button_id == "gates-measured":
            await self.patch_selected({"classification": "measured", "metric": "GATE_METRIC:down:0", "enabled": True})
        elif button_id == "gates-prebroken":
            await self.patch_selected({"classification": "pre-broken", "metric": None, "enabled": False})
        elif button_id == "gates-toggle":
            gate = self._selected_gate()
            if gate is not None:
                await self.patch_selected({"enabled": not gate.get("enabled")})

    async def patch_selected(self, patch: dict[str, Any]) -> None:
        repo = getattr(self.app, "selected_repo", None)
        gate = self._selected_gate()
        notice = self.query_one("#gates-notice", Banner)
        if not repo or gate is None:
            notice.set_notice("Select a gate row first.", "warn")
            return
        try:
            await self.client.call(
                "gatesSet",
                {"repoPath": repo, "patch": {"gates": [{"name": gate["name"], **patch}]}},
            )
        except RpcError as error:
            self.report_rpc_error(error)
            return
        self.set_pending_notice(
            f"{gate['name']} updated: {', '.join(f'{k} {v}' for k, v in patch.items())}."
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
            pass

    def _render_events(self, batch: list[dict[str, Any]]) -> None:
        """Render a batch. A burst costs one repaint, not one per event."""
        checklist = self.query_one("#gates-checklist", PhaseChecklist)
        log = self.query_one("#gates-events", EventLog)
        checklist.apply_events(batch)
        for event in batch:
            log.append_event(event)

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
