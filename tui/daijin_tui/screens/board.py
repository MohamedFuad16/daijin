"""Board view. Watcher and auditor findings, filterable.

The watcher is UNIVERSAL (owner ruling, field round 6): every load also runs
the engine's systemCheck sweep over the whole tool - retrieval, brains, gates,
roles, the spend gate - and its findings sit in the same table as the stored
board rows. A finding may carry an auditor fix from the engine's closed
catalog; applying one is a button plus an explicit confirmation, never
automatic.
"""

from __future__ import annotations

from typing import Any, Iterable

from textual import work
from textual.containers import Horizontal
from textual.widgets import Button, DataTable, Select, Static

from ..rpc import RpcError
from ..widgets import Banner, SectionTitle
from .base import DaijinScreen
from .dialogs import ConfirmScreen

BOARD_COLUMNS = ("ts", "source", "severity", "category", "target", "evidence", "status")

SEVERITY_OPTIONS = [("all severities", "all"), ("info", "info"), ("warn", "warn"), ("critical", "critical")]
SOURCE_OPTIONS = [("all sources", "all"), ("watcher", "watcher"), ("auditor", "auditor"), ("engine", "engine")]
STATUS_OPTIONS = [("all statuses", "all"), ("open", "open"), ("triaged", "triaged"), ("resolved", "resolved")]


class BoardScreen(DaijinScreen):
    mode_name = "board"
    notice_id = "#board-notice"
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
        yield Button("Apply auditor fix", id="board-fix", variant="warning")

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
        # THE SWEEP RIDES EVERY LOAD: systemCheck is zero-spend and computed
        # fresh, so the board is the watcher's live report, not an archive.
        # An old daemon without the method degrades to the stored rows alone.
        watch: list[dict[str, Any]] = []
        try:
            watch = (await self.client.call("systemCheck", {})).get("findings", [])
        except RpcError:
            watch = []
        filters = self._filters()
        watch = [
            row for row in watch
            if all(row.get(field) == wanted for field, wanted in filters.items())
        ]
        self.rows = watch + result.get("rows", [])
        table = self._table()
        table.clear()
        for row in self.rows:
            self._add_row(table, row)
        critical = sum(1 for row in self.rows if row.get("severity") == "critical")
        tone = "error" if critical else "info"
        # Two populations, counted apart: "9 of 6 shown" is what merging them
        # into one denominator reads like.
        self.query_one("#board-notice", Banner).set_notice(
            f"{len(watch)} live watcher finding(s) this sweep, "
            f"{len(result.get('rows', []))} of {result.get('total', 0)} stored rows shown, "
            f"{critical} critical.",
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
        self.selected_row = row
        action = row.get("action") or {}
        lines = [
            f"[b]{row.get('id')}[/b]  {row.get('summary', '')}",
        ]
        if row.get("detail"):
            lines.append(str(row["detail"]))
        if row.get("evidence") == "systemCheck":
            lines.append("[dim]live watcher sweep, computed this load, not stored[/dim]")
        else:
            lines.append(
                f"[dim]evidence {row.get('evidence')} into the jsonl stream, status {row.get('status')}[/dim]"
            )
        thread = "\n".join(
            f"  {entry.get('at', '')}  [b]{entry.get('by', '')}[/b]  {entry.get('text', '')}"
            for entry in row.get("thread", [])
        )
        if thread:
            lines.append(thread)
        if action:
            lines.append(f"[yellow]Auditor fix available:[/yellow] {action.get('label')}")
        self.query_one("#board-detail", Static).update("\n".join(lines))
        # The button exists exactly when a fix does; a control keyed on the
        # selection cannot be pressed against the wrong row.
        self.query_one("#board-fix", Button).display = bool(action)

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "board-apply":
            event.stop()
            await self.apply_filters()
        elif event.button.id == "board-fix":
            event.stop()
            self.apply_selected_fix()

    @work
    async def apply_selected_fix(self) -> None:
        row = getattr(self, "selected_row", None) or {}
        action = row.get("action") or {}
        notice = self.query_one("#board-notice", Banner)
        if not action.get("fixId"):
            notice.set_notice("The selected finding carries no fix.", "warn")
            return
        confirmed = await self.app.push_screen_wait(ConfirmScreen(
            title="Apply this fix?",
            body=(
                f"{action.get('label')}\n\n"
                f"For: {row.get('summary', '')}\n"
                "This changes this machine or its settings. The engine's fix "
                "catalog is closed: only commands written in daijin itself can run."
            ),
            confirm_label=str(action.get("label", "Apply")),
        ))
        if not confirmed:
            notice.set_notice("Nothing was changed.", "info")
            return
        params: dict[str, Any] = {"fixId": action["fixId"], "confirm": True}
        # The endpoint fix acts on a role; the finding's target names it.
        if action["fixId"] == "zai-coding-endpoint":
            params["role"] = row.get("target")
        try:
            result = await self.client.call("systemFix", params)
        except RpcError as error:
            self.report_rpc_error(error)
            notice.set_notice(error.hint, "error")
            return
        # Reload FIRST, then report: apply_filters paints its own count line
        # into the banner, and the fix's outcome is the sentence that must
        # survive.
        await self.apply_filters()
        notice.set_notice(
            str(result.get("detail") or "Applied."),
            "info" if result.get("ok") else "warn",
        )

    async def on_select_changed(self, event: Select.Changed) -> None:
        event.stop()
        await self.apply_filters()

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        key = event.row_key.value if event.row_key else None
        for row in self.rows:
            if row.get("id") == key:
                self._show_row(row)
                return
