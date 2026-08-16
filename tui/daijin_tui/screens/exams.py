"""Exams. The bank and the draft queue, with the radar, history, and token bars.

The two status axes are orthogonal and are never merged into one column:
status is where the exam sits in the authoring pipeline, benchmarkStatus is
whether it may still be used to measure. A promoted exam can be quarantined,
and collapsing that into a single word loses the case the rule exists for.
"""

from __future__ import annotations

from typing import Any, Iterable

from textual import work
from textual.containers import Horizontal
from textual.widgets import Button, DataTable, Select, Static

from ..concurrency import gather_all
from ..rpc import RpcError
from ..widgets import Banner, PlotextBar, PlotextLine, RadarChart, SectionTitle
from .base import DaijinScreen
from .dialogs import TextPromptScreen

EXAM_COLUMNS = ("exam", "title", "tier", "status", "benchmark", "held out", "quarantine reason")

STATUS_OPTIONS = [
    ("all statuses", "all"),
    ("draft", "draft"),
    ("validated", "validated"),
    ("promoted", "promoted"),
    ("vetoed", "vetoed"),
]
BENCHMARK_OPTIONS = [
    ("all benchmark states", "all"),
    ("active", "active"),
    ("quarantined", "quarantined"),
]

# quarantineReason is required at a minimum of 20 characters by the contract.
QUARANTINE_REASON_MIN = 20


class ExamsScreen(DaijinScreen):
    mode_name = "exams"
    heading = "Exams"
    subheading = "bank and draft queue, five axis radar, per attempt token bars"

    BINDINGS = DaijinScreen.BINDINGS + [("r", "toggle_radar", "Radar or bars")]

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.exams: list[dict[str, Any]] = []
        self.exam_id: str | None = None

    def content(self) -> Iterable[Any]:
        yield Banner("", tone="info", id="exam-notice")
        with Horizontal(id="exam-filters"):
            yield Select(STATUS_OPTIONS, value="all", id="filter-exam-status", allow_blank=False)
            yield Select(BENCHMARK_OPTIONS, value="all", id="filter-exam-benchmark", allow_blank=False)
            yield Button("Veto", id="exam-veto", variant="warning")
            yield Button("Quarantine", id="exam-quarantine")
            yield Button("Release quarantine", id="exam-release")
        yield SectionTitle("Bank and draft queue", "select a row with the mouse or the arrow keys")
        yield DataTable(id="exam-table", cursor_type="row")
        yield SectionTitle("Axes", "press r or click the chart to switch radar and bars")
        yield RadarChart([], id="exam-radar")
        yield SectionTitle("Pass and fail history")
        yield PlotextLine(title="verdict by attempt, 1 pass and 0 fail", height=10, id="exam-history")
        yield SectionTitle("Tokens per attempt")
        yield PlotextBar(title="tokens by attempt", height=12, id="exam-tokens")
        yield SectionTitle("Provenance")
        yield Static("[dim]no exam selected[/dim]", id="exam-provenance", markup=True)

    async def load(self) -> None:
        self.refresh_heading()
        table = self.query_one("#exam-table", DataTable)
        if not table.columns:
            table.add_columns(*EXAM_COLUMNS)
        # The chart preference and the bank contents are unrelated.
        settings, _bank = await gather_all(self._settings(), self.reload_bank())
        mode = ((settings or {}).get("charts") or {}).get("radarMode", "radar")
        self.query_one("#exam-radar", RadarChart).set_mode(mode)

    async def reload_bank(self) -> None:
        table = self.query_one("#exam-table", DataTable)
        filters = {
            "status": self.query_one("#filter-exam-status", Select).value,
            "benchmarkStatus": self.query_one("#filter-exam-benchmark", Select).value,
        }
        try:
            rows = await self.client.call("examList", {"filters": filters})
        except RpcError as error:
            self.show_rpc_error(error, "#exam-notice")
            table.clear()
            self.exams = []
            return
        self.exams = rows if isinstance(rows, list) else rows.get("exams", [])
        table.clear()
        for exam in self.exams:
            table.add_row(
                exam.get("examId", ""),
                exam.get("title", ""),
                exam.get("tier", ""),
                exam.get("status", ""),
                exam.get("benchmarkStatus", ""),
                "yes" if exam.get("heldOut") else "no",
                exam.get("quarantineReason") or "-",
                key=exam.get("examId"),
            )
        quarantined = [e for e in self.exams if e.get("benchmarkStatus") == "quarantined"]
        drafts = [e for e in self.exams if e.get("status") == "draft"]
        self.query_one("#exam-notice", Banner).set_notice(
            f"{len(self.exams)} exams shown, {len(drafts)} in the draft queue, "
            f"{len(quarantined)} quarantined out of measurement.",
            "warn" if quarantined else "info",
        )
        if self.exams:
            await self.show_exam(self.exams[0]["examId"])
        else:
            self.exam_id = None
            self.query_one("#exam-provenance", Static).update("[dim]no exam matches those filters[/dim]")

    async def _settings(self) -> dict[str, Any] | None:
        try:
            return await self.client.call("settingsGet", {})
        except RpcError:
            return None

    def _selected(self) -> dict[str, Any] | None:
        for exam in self.exams:
            if exam.get("examId") == self.exam_id:
                return exam
        return None

    async def show_exam(self, exam_id: str) -> None:
        try:
            detail = await self.client.call("examDetail", {"examId": exam_id})
        except RpcError as error:
            self.report_rpc_error(error)
            return
        self.exam_id = exam_id
        self.query_one("#exam-radar", RadarChart).set_axes(detail.get("axes") or [])
        attempts = detail.get("attempts") or []
        history = self.query_one("#exam-history", PlotextLine)
        tokens = self.query_one("#exam-tokens", PlotextBar)
        if attempts:
            history.set_data(
                [attempt["n"] for attempt in attempts],
                {"verdict": [1 if attempt["verdict"] == "pass" else 0 for attempt in attempts]},
            )
            tokens.set_data(
                [str(attempt["n"]) for attempt in attempts],
                [attempt["tokens"] for attempt in attempts],
            )
        else:
            history.set_data([], {})
            tokens.set_data([], [])
        provenance = detail.get("provenance") or {}
        row = self._selected() or {}
        quarantine = row.get("quarantineReason")
        lines = [
            f"[b]{exam_id}[/b]  {row.get('title', '')}",
            f"base {provenance.get('baseCommit', '?')}  gold {provenance.get('goldCommit', '?')}",
            f"source {provenance.get('source', '?')}, selected by {provenance.get('selectedBy', '?')}, "
            f"supersedes {provenance.get('supersedes') or 'nothing'}",
            str(provenance.get("note", "")),
        ]
        if provenance.get("vetoReason"):
            lines.append(f"[yellow]veto reason: {provenance['vetoReason']}[/yellow]")
        if quarantine:
            lines.append(f"[yellow]quarantined out of measurement: {quarantine}[/yellow]")
        self.query_one("#exam-provenance", Static).update("\n".join(lines))

    async def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        key = event.row_key.value if event.row_key else None
        if key:
            await self.show_exam(str(key))

    async def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        key = event.row_key.value if event.row_key else None
        if key and key != self.exam_id:
            await self.show_exam(str(key))

    async def on_select_changed(self, event: Select.Changed) -> None:
        event.stop()
        if self.is_mounted and self.query("#exam-table"):
            await self.reload_bank()

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        if event.button.id == "exam-veto":
            self.veto_selected()
        elif event.button.id == "exam-quarantine":
            self.quarantine_selected()
        elif event.button.id == "exam-release":
            await self.release_selected()

    @work
    async def veto_selected(self) -> None:
        exam = self._selected()
        if exam is None:
            self.query_one("#exam-notice", Banner).set_notice("Select an exam row first.", "warn")
            return
        reason = await self.app.push_screen_wait(
            TextPromptScreen(
                title=f"Veto {exam['examId']}",
                prompt="Say why. A veto with no written reason cannot be reviewed later.",
                min_length=1,
                placeholder="reason for the veto",
            )
        )
        if not reason:
            return
        try:
            await self.client.call("examVeto", {"examId": exam["examId"], "reason": reason})
        except RpcError as error:
            self.report_rpc_error(error)
            return
        await self.reload_bank()

    @work
    async def quarantine_selected(self) -> None:
        exam = self._selected()
        if exam is None:
            self.query_one("#exam-notice", Banner).set_notice("Select an exam row first.", "warn")
            return
        reason = await self.app.push_screen_wait(
            TextPromptScreen(
                title=f"Quarantine {exam['examId']}",
                prompt=(
                    f"Quarantine takes this exam out of measurement without touching its "
                    f"authoring status. The reason is required, at least "
                    f"{QUARANTINE_REASON_MIN} characters."
                ),
                min_length=QUARANTINE_REASON_MIN,
                placeholder="why this exam can no longer be trusted to measure",
            )
        )
        if not reason:
            return
        try:
            await self.client.call(
                "examUpdate",
                {"examId": exam["examId"], "patch": {"benchmarkStatus": "quarantined", "quarantineReason": reason}},
            )
        except RpcError as error:
            self.report_rpc_error(error)
            return
        await self.reload_bank()

    async def release_selected(self) -> None:
        exam = self._selected()
        if exam is None:
            self.query_one("#exam-notice", Banner).set_notice("Select an exam row first.", "warn")
            return
        try:
            await self.client.call(
                "examUpdate", {"examId": exam["examId"], "patch": {"benchmarkStatus": "active"}}
            )
        except RpcError as error:
            self.report_rpc_error(error)
            return
        await self.reload_bank()

    async def action_toggle_radar(self) -> None:
        mode = self.query_one("#exam-radar", RadarChart).toggle_mode()
        try:
            await self.client.call("settingsSet", {"patch": {"charts": {"radarMode": mode}}})
        except RpcError as error:
            self.report_rpc_error(error)
