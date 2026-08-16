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
from ..widgets import Banner, DitherBars, RadarChart, SectionTitle, StippleLine
from ..widgets.texture import texture_for_verdict
from .base import DaijinScreen
from .dialogs import TextPromptScreen

EXAM_COLUMNS = ("exam", "title", "tier", "status", "benchmark", "held out", "quarantine reason")
ATTEMPT_COLUMNS = ("attempt", "tokens", "verdict", "why not graded")

# What each ungraded code means for the reader. Branch on the CODE; display the
# engine's sentence, which is written to be improved.
UNGRADED_NOTE = {
    "unsubmitted": "the student never answered, so it cannot have answered badly",
    "apply-error": "the run produced no gradable diff",
    "pending": "submitted, not yet graded",
}

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


def with_repo(params: dict[str, Any], repo: Any) -> dict[str, Any]:
    """Add repoPath, which the engine requires on every exam call.

    The v5 contract rows for examList, examDetail, examVeto and examUpdate do
    not mention it. The engine refuses without it, so the client sends it and
    the divergence is reported rather than worked around silently.
    """
    if repo:
        return {**params, "repoPath": repo}
    return params


def attempt_number(attempt: dict[str, Any], position: int) -> int:
    """The attempt's index, whatever the engine calls it.

    The engine's boundary mapping now sends id, so the earlier read-both-names
    bridge is gone. Position remains the fallback for a row that carries none.
    """
    value = attempt.get("id")
    if isinstance(value, int):
        return value
    return position


def attempt_tokens(attempt: dict[str, Any]) -> int:
    """Work tokens spent on the attempt."""
    value = attempt.get("tokens")
    return int(value) if isinstance(value, (int, float)) else 0


def attempt_cap(attempt: dict[str, Any]) -> int | None:
    """The attempt's token cap, which is the bar's real denominator.

    A token count without its cap is unreadable: 41,200 means one thing under a
    450,000 cap and another under 800,000. Scaling the bars to the tallest
    attempt instead would make every chart look the same no matter how much
    headroom the run actually had.
    """
    value = attempt.get("tokenCap")
    return int(value) if isinstance(value, (int, float)) and value > 0 else None


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
        yield Static("", id="exam-axes-note", markup=True)
        yield RadarChart([], id="exam-radar")
        yield SectionTitle("Attempts")
        yield DataTable(id="attempt-table", cursor_type="row")
        yield SectionTitle("Verdict history", "texture carries the outcome, colour only repeats it")
        yield StippleLine(title="verdict by attempt", height=5, id="exam-history")
        yield SectionTitle("Tokens per attempt", "each bar wears its attempt's verdict")
        yield DitherBars(title="tokens by attempt", height=10, id="exam-tokens")
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
        # "all" is a UI sentinel meaning "do not filter", not a value any
        # engine defines. Sending it asks the engine for exams whose status is
        # literally "all", which matches nothing: the bank rendered empty
        # against a real ledger that had a row.
        filters = {
            key: value
            for key, value in (
                ("status", self.query_one("#filter-exam-status", Select).value),
                ("benchmarkStatus", self.query_one("#filter-exam-benchmark", Select).value),
            )
            if value and value != "all"
        }
        # repoPath is REQUIRED by the engine and absent from the v5 contract
        # row for examList. Sent because the engine is the reality; the
        # divergence is reported rather than silently absorbed.
        try:
            rows = await self.client.call(
                "examList", with_repo({"filters": filters}, getattr(self.app, "selected_repo", None))
            )
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
            # No exam means no axes. Leaving the radar mounted renders a chart
            # frame around nothing, which reads as a drawn result.
            radar = self.query_one("#exam-radar", RadarChart)
            radar.set_axes([])
            radar.display = False
            self.query_one("#exam-axes-note", Static).update(
                "[dim]No exam selected, so there is nothing to plot.[/dim]"
            )
            self._render_attempts([])
            self.query_one("#exam-provenance", Static).update("[dim]no exam matches those filters[/dim]")

    def _render_attempts(self, attempts: list[dict[str, Any]]) -> None:
        table = self.query_one("#attempt-table", DataTable)
        if not table.columns:
            table.add_columns(*ATTEMPT_COLUMNS)
        table.clear()
        for position, attempt in enumerate(attempts, start=1):
            code = attempt.get("ungradedCode")
            if code:
                note = UNGRADED_NOTE.get(code, "")
                why = f"{code}: {attempt.get('ungradedReason', '')}"
                if note:
                    why = f"{why} ({note})"
            else:
                why = "-"
            table.add_row(
                str(attempt_number(attempt, position)),
                f"{attempt_tokens(attempt):,}",
                attempt.get("verdict") or "not graded",
                why,
            )

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
            detail = await self.client.call(
                "examDetail", with_repo({"examId": exam_id}, getattr(self.app, "selected_repo", None))
            )
        except RpcError as error:
            self.report_rpc_error(error)
            return
        self.exam_id = exam_id
        axes = detail.get("axes")
        radar = self.query_one("#exam-radar", RadarChart)
        note = self.query_one("#exam-axes-note", Static)
        if axes:
            radar.display = True
            radar.set_axes(axes)
            note.update("")
        else:
            # axes null means NOBODY GRADED THIS. Drawing zeros would show a
            # student who failed every axis, which is a different claim and a
            # false one, so the chart is hidden rather than drawn empty.
            radar.set_axes([])
            radar.display = False
            note.update(
                "[dim]Not graded, so there are no axes to plot. This is not a score of "
                "zero: a zeroed radar would read as a student who failed every axis.[/dim]"
            )
        attempts = detail.get("attempts") or []
        self._render_attempts(attempts)
        history = self.query_one("#exam-history", StippleLine)
        tokens = self.query_one("#exam-tokens", DitherBars)
        # An ungraded attempt is not a fail, so it is left out of the pass and
        # fail line rather than plotted as a zero. Tokens are real for every
        # attempt, graded or not, so the token bars keep all of them.
        numbered = [
            (attempt_number(a, i), a) for i, a in enumerate(attempts, start=1)
        ]
        # Every graded attempt appears, including a partial, which is neither a
        # pass nor a fail and was previously not plotted at all. min_column
        # keeps a fail visible as a fail: drawn at zero height it reads as a
        # missing attempt rather than a failed one.
        graded = [(n, a) for n, a in numbered if a.get("verdict")]
        if graded:
            scale = {"pass": 1.0, "partial": 0.5}
            history.set_data(
                [scale.get(str(a["verdict"]).lower(), 0.0) for _, a in graded],
                textures=[texture_for_verdict(a["verdict"]) for _, a in graded],
                min_column=1,
            )
        else:
            history.set_data([])
        if numbered:
            caps = [attempt_cap(a) for _, a in numbered]
            cap = max((c for c in caps if c), default=None)
            tokens.set_data(
                [str(n) for n, _ in numbered],
                [attempt_tokens(a) for _, a in numbered],
                [texture_for_verdict(a.get("verdict")) for _, a in numbered],
                ceiling=cap,
                ceiling_label=f"cap {cap:,}" if cap else "",
            )
        else:
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
            await self.client.call(
                "examVeto",
                with_repo({"examId": exam["examId"], "reason": reason}, getattr(self.app, "selected_repo", None)),
            )
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
                with_repo(
                    {"examId": exam["examId"], "patch": {"benchmarkStatus": "quarantined", "quarantineReason": reason}},
                    getattr(self.app, "selected_repo", None),
                ),
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
                "examUpdate",
                with_repo(
                    {"examId": exam["examId"], "patch": {"benchmarkStatus": "active"}},
                    getattr(self.app, "selected_repo", None),
                ),
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
