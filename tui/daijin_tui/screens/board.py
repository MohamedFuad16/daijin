"""Board view. Watcher and auditor findings, filterable."""

from __future__ import annotations

from typing import Any, Iterable

from textual.containers import Horizontal
from textual.widgets import Button, DataTable, Select, Static

from ..rpc import RpcError
from ..widgets import Banner, SectionTitle
from .base import DaijinScreen

BOARD_COLUMNS = ("ts", "source", "severity", "category", "target", "evidence", "status")

SEVERITY_OPTIONS = [("all severities", "all"), ("info", "info"), ("warn", "warn"), ("critical", "critical")]
SOURCE_OPTIONS = [("all sources", "all"), ("watcher", "watcher"), ("auditor", "auditor"), ("engine", "engine")]
STATUS_OPTIONS = [("all statuses", "all"), ("open", "open"), ("triaged", "triaged"), ("resolved", "resolved")]


class BoardScreen(DaijinScreen):
    mode_name = "board"
    heading = "Board"
    subheading = "watcher detects, auditor judges, the user reads"

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.rows: list[dict[str, Any]] = []
        self.live_findings: list[dict[str, Any]] = []
        self._subscribed = False

    def content(self) -> Iterable[Any]:
        yield Banner("", tone="info", id="board-notice")
        with Horizontal(id="board-filters"):
            yield Select(SEVERITY_OPTIONS, value="all", id="filter-severity", allow_blank=False)
            yield Select(SOURCE_OPTIONS, value="all", id="filter-source", allow_blank=False)
            yield Select(STATUS_OPTIONS, value="all", id="filter-status", allow_blank=False)
            yield Button("Apply", id="board-apply", variant="primary")
        yield DataTable(id="board-table", cursor_type="row")
        yield SectionTitle("Status thread", "corrections are dated in place, withdrawn claims are marked, never deleted")
        yield Static("[dim]no finding selected[/dim]", id="board-detail", markup=True)

    async def load(self) -> None:
        # boardFinding notifications are not job scoped and arrive with no job
        # running, so the board listens for its own lifetime rather than for
        # the duration of some job.
        if not self._subscribed:
            self.client.on_board_finding(self._on_board_finding)
            self._subscribed = True
        await self.apply_filters()

    def on_unmount(self) -> None:
        if self._subscribed:
            self.client.off_board_finding(self._on_board_finding)
            self._subscribed = False

    def _on_board_finding(self, finding: dict[str, Any]) -> None:
        """Render a pushed finding immediately, without waiting for a reload."""
        if not self.is_mounted:
            return
        self.live_findings.insert(0, finding)
        row = {"id": f"live-{len(self.live_findings)}", **finding}
        self.rows.insert(0, row)
        table = self._table()
        table.clear()
        for entry in self.rows:
            self._add_row(table, entry)
        self.query_one("#board-notice", Banner).set_notice(
            f"{len(self.rows)} findings shown, {len(self.live_findings)} pushed live since this view opened.",
            "error" if any(f.get("severity") == "critical" for f in self.live_findings) else "info",
        )

    def _table(self) -> DataTable:
        table = self.query_one("#board-table", DataTable)
        if not table.columns:
            table.add_columns(*BOARD_COLUMNS)
        return table

    def _filters(self) -> dict[str, str]:
        """Omit "all" rather than sending it.

        It is a UI sentinel meaning "do not filter", not a value the engine
        defines, and an engine that takes it literally matches nothing.
        """
        chosen = {
            "severity": self.query_one("#filter-severity", Select).value,
            "source": self.query_one("#filter-source", Select).value,
            "status": self.query_one("#filter-status", Select).value,
        }
        return {key: value for key, value in chosen.items() if value and value != "all"}

    async def apply_filters(self) -> None:
        try:
            result = await self.client.call("board", {"filters": self._filters()})
        except RpcError as error:
            self.show_rpc_error(error, "#board-notice")
            return
        self.rows = result.get("rows", [])
        table = self._table()
        table.clear()
        for row in self.rows:
            self._add_row(table, row)
        critical = sum(1 for row in self.rows if row.get("severity") == "critical")
        tone = "error" if critical else "info"
        self.query_one("#board-notice", Banner).set_notice(
            f"{len(self.rows)} of {result.get('total', len(self.rows))} findings shown, {critical} critical.",
            tone,
        )
        if self.rows:
            self._show_row(self.rows[0])
        else:
            self.query_one("#board-detail", Static).update("[dim]no findings match those filters[/dim]")

    @staticmethod
    def _add_row(table: DataTable, row: dict[str, Any]) -> None:
        table.add_row(
            row.get("ts", ""),
            row.get("source", ""),
            row.get("severity", ""),
            row.get("category", ""),
            row.get("target", ""),
            row.get("evidence", ""),
            row.get("status", ""),
            key=row.get("id"),
        )

    def _show_row(self, row: dict[str, Any]) -> None:
        thread = "\n".join(
            f"  {entry.get('at', '')}  [b]{entry.get('by', '')}[/b]  {entry.get('text', '')}"
            for entry in row.get("thread", [])
        ) or "  [dim]no triage verdict yet[/dim]"
        self.query_one("#board-detail", Static).update(
            f"[b]{row.get('id')}[/b]  {row.get('summary', '')}\n"
            f"[dim]evidence {row.get('evidence')} into the jsonl stream, status {row.get('status')}[/dim]\n"
            f"{thread}"
        )

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "board-apply":
            event.stop()
            await self.apply_filters()

    async def on_select_changed(self, event: Select.Changed) -> None:
        event.stop()
        await self.apply_filters()

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        key = event.row_key.value if event.row_key else None
        for row in self.rows:
            if row.get("id") == key:
                self._show_row(row)
                return
