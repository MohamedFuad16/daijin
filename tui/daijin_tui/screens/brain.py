"""Brain browser, retrieval tester, and the mechanical sub-75 diagnosis."""

from __future__ import annotations

from typing import Any, Iterable

from textual import work
from textual.containers import Horizontal
from textual.widgets import Button, DataTable, Input, Select, Static, TabbedContent, TabPane

from textual.content import Content

from ..concurrency import gather_all
from ..rpc import RpcError
from ..widgets import (
    Banner,
    Gauge,
    MCP_THRESHOLD,
    SectionTitle,
    case_rate_value,
    format_case_rate,
    format_ratio,
)
from .base import DaijinScreen

CHUNK_COLUMNS = ("rank", "chunk", "document", "type", "area", "arm", "score", "tokens", "standing")
PER_CASE_COLUMNS = ("case", "hit", "rank", "arm", "type", "area")
CLUSTER_COLUMNS = ("axis", "key", "missed cases", "share")
DOCUMENT_COLUMNS = ("document", "type", "area", "title", "tags")


def _token_cell(chunk: dict[str, Any]) -> str:
    """Render a chunk's token cost, including the case where it has none.

    A standing unit rides outside the token budget, so the engine reports
    tokens as null rather than zero. Zero would claim it was measured and cost
    nothing; null means it was never charged against the budget at all.
    """
    tokens = chunk.get("tokens")
    if tokens is None:
        return "outside budget"
    return f"{int(tokens):,}"


class BrainScreen(DaijinScreen):
    mode_name = "brain"
    notice_id = "#brain-notice"
    heading = "Brain browser, retrieval tester, diagnosis"
    subheading = "what the brain knows, how accurately it answers, and how to connect it"

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.chunks: list[dict[str, Any]] = []
        self.documents: list[dict[str, Any]] = []
        self.score: dict[str, Any] = {}

    def content(self) -> Iterable[Any]:
        yield Banner("", tone="info", id="brain-notice")
        # THE HERO (owner field round 6): the brain's status and its retrieval
        # rate, big, before anything else. The reader should know "healthy or
        # not" and "how much it retrieves" without scanning a table; the
        # table below carries the rest of the numbers.
        yield Static("", id="brain-hero", markup=True)
        yield Gauge(caption="", width=60, id="brain-hero-gauge")
        yield Static("", id="brain-hero-facts", markup=True)
        with TabbedContent(id="brain-tabs"):
            with TabPane("Retrieval", id="brain-tab-retrieval"):
                # The floor numbers live in the HERO now; repeating them here
                # as a second block was the duplication the owner read twice
                # (field round 8). What this tab adds is the control the hero
                # cannot carry: choosing the budget.
                yield SectionTitle(
                    "Token budget",
                    "the recommendation comes from the sweep below; re-measuring applies and stores your choice",
                )
                with Horizontal(id="budget-row"):
                    yield Select([], id="brain-budget", prompt="budget", allow_blank=True)
                    yield Button("Re-measure at this budget", id="brain-remeasure", variant="primary")
                yield Static("", id="brain-budget-note", markup=True, classes="field-note")
                yield Static("", id="budget-sweep-note", markup=True, classes="field-note")
                yield SectionTitle("Gold cases", "every question the brain is tested on, and how it did")
                yield DataTable(id="percase-table", cursor_type="row")
                yield SectionTitle("Connect your coding agent (MCP)")
                yield Button("Get the connection code", id="mcp-unlock", disabled=True)
                yield Static("", id="mcp-summary", markup=True)
                yield SectionTitle("Ask the brain", "type a question and see what your agent would get back")
                with Horizontal(id="search-row"):
                    yield Input(placeholder="ask the brain something", id="search-input")
                    yield Button("Search", id="search-go", variant="primary")
                yield Static("", id="search-summary", markup=True)
                yield DataTable(id="chunk-table", cursor_type="row")
                yield SectionTitle("Selected chunk")
                yield Static("[dim]no chunk selected[/dim]", id="chunk-detail", markup=True)

            with TabPane("Inventory", id="brain-tab-inventory"):
                yield SectionTitle(
                    "What the brain knows",
                    "every document in this repo's brain - the knowledge your agent retrieves from",
                )
                with Horizontal(id="inventory-filters"):
                    yield Input(placeholder="filter by title, id, or path", id="inventory-query")
                    yield Select(
                        [("all types", "all")],
                        value="all",
                        id="inventory-type",
                        allow_blank=False,
                    )
                    yield Button("Filter", id="inventory-apply", variant="primary")
                yield Static("", id="inventory-summary", markup=True)
                yield DataTable(id="inventory-table", cursor_type="row")
                yield Static("[dim]no document selected[/dim]", id="inventory-detail", markup=True)
            with TabPane("Diagnosis", id="brain-tab-diagnosis"):
                yield Static("", id="diagnosis-headline", markup=True)
                yield SectionTitle("Where the misses cluster", "free arithmetic over the questions the brain got wrong")
                yield DataTable(id="cluster-table", cursor_type="row")
                yield SectionTitle("The questions it missed")
                yield DataTable(id="missed-table", cursor_type="row")
                yield SectionTitle("Ask the auditor what to do", "a paid model call, only on your explicit go ahead")
                yield Button("Ask the auditor to narrate (spends)", id="narrate-go", variant="warning")
                yield Static("[dim]not requested[/dim]", id="narration", markup=True)

    async def load(self) -> None:
        self._init_columns()
        self.refresh_heading()
        notice = self.query_one("#brain-notice", Banner)
        repo = getattr(self.app, "selected_repo", None)
        if not repo:
            notice.set_notice("No repo selected. Press 1 for the repo home and pick one.", "warn")
            self.query_one("#brain-hero", Static).update("[dim]no repo selected[/dim]")
            return
        notice.set_notice(f"Serving {repo}.", "info")
        # Four independent panels, each already owning its own error handling,
        # so one failing does not blank the others and none needs to wait for
        # the one before it.
        await gather_all(
            self._load_floor(repo),
            self._load_mcp(repo),
            self._load_inventory(repo),
            self._load_diagnosis(repo),
        )

    def _init_columns(self) -> None:
        for selector, columns in (
            ("#chunk-table", CHUNK_COLUMNS),
            ("#percase-table", PER_CASE_COLUMNS),
            ("#cluster-table", CLUSTER_COLUMNS),
            ("#missed-table", ("case", "arm", "type", "area")),
            ("#inventory-table", DOCUMENT_COLUMNS),
        ):
            table = self.query_one(selector, DataTable)
            if not table.columns:
                table.add_columns(*columns)

    async def _load_floor(self, repo: str) -> None:
        try:
            # recall: the STORED last measurement, instantly. Opening this screen used to
            # re-run a four-budget embedding sweep, which is why it took so long to load;
            # measuring is the explicit Re-measure button now.
            score = await self.client.call("retrievalScore", {"repoPath": repo, "sweep": True, "recall": True})
        except RpcError as error:
            self.query_one("#brain-hero", Static).update(f"[yellow]{error.hint}[/yellow]")
            return
        self.score = score
        case_rate = score.get("caseRate")
        value = case_rate_value(case_rate)
        tone = "green" if (value or 0) >= MCP_THRESHOLD else "yellow"
        self._paint_hero(score, value, tone)
        self._fill_budget_control(score)
        table = self.query_one("#percase-table", DataTable)
        table.clear()
        for row in score.get("perCase", []):
            table.add_row(
                row.get("caseId", ""),
                "hit" if row.get("hit") else "MISS",
                str(row.get("rank") if row.get("rank") is not None else "-"),
                row.get("arm", ""),
                row.get("type", ""),
                row.get("area") or "-",
            )
        # One readable line per measured budget, recommendation marked. The dithered
        # bar chart this replaces read as broken UI to the owner (field, 2026-08-22):
        # four near-identical bars carry less than four labelled numbers.
        sweep = score.get("budgetSweep") or []
        note = self.query_one("#budget-sweep-note", Static)
        if sweep:
            chosen = score.get("chosenBudget")
            lines = []
            for point in sweep:
                cases = str(point.get("caseRate", {}).get("cases", "?"))
                marker = "  [green]<- recommended[/green]" if point.get("budget") == chosen else ""
                lines.append(f"  {point.get('budget'):>6} tokens: {cases} answered{marker}")
            note.update("[dim]measured at each budget:[/dim]\n" + "\n".join(lines))
        else:
            note.update("")

    def _fill_budget_control(self, score: dict[str, Any]) -> None:
        select = self.query_one("#brain-budget", Select)
        note = self.query_one("#brain-budget-note", Static)
        chosen = score.get("chosenBudget")
        budgets = [point.get("budget") for point in score.get("budgetSweep") or [] if point.get("budget")]
        if not budgets and chosen:
            budgets = [chosen]
        select.set_options([
            (f"{budget} (recommended)" if budget == chosen else str(budget), budget)
            for budget in budgets
        ])
        if chosen in budgets:
            select.value = chosen
        note.update(f"[dim]{score.get('rationale', '')}[/dim]" if score.get("rationale") else "")

    @work
    async def remeasure_at_budget(self) -> None:
        repo = getattr(self.app, "selected_repo", None)
        notice = self.query_one("#brain-notice", Banner)
        budget = self.query_one("#brain-budget", Select).value
        if not repo or budget is Select.NULL or not budget:
            notice.set_notice("Pick a budget first.", "warn")
            return
        notice.set_notice(f"Re-measuring at {budget} tokens. Zero spend; the local embedder does the work.", "info")
        try:
            score = await self.client.call("retrievalScore", {"repoPath": repo, "tokenBudget": int(budget)})
            # STORED, so serving actually uses it: a re-measure that only
            # repainted a screen would leave retrieval on the old budget.
            await self.client.call("settingsSet", {"patch": {"retrieval": {"tokenBudget": int(budget)}}})
        except RpcError as error:
            self.report_rpc_error(error)
            notice.set_notice(error.hint, "error")
            return
        self.score = score
        value = case_rate_value(score.get("caseRate"))
        self._paint_hero(score, value, "green" if (value or 0) >= MCP_THRESHOLD else "yellow")
        notice.set_notice(
            f"Measured and stored: {budget} tokens is now the serving budget. "
            f"Case rate {format_case_rate(score.get('caseRate'))}.",
            "info",
        )

    def _paint_hero(self, score: dict[str, Any], value: float | None, tone: str) -> None:
        """Status word and retrieval rate, large; the other numbers as facts.

        The status is DERIVED from the same numbers the floor enforces:
        healthy is at-or-above the unlock threshold with zero violations,
        below-floor is under it, and a violation makes it unhealthy whatever
        the rate says, because a must-not pair surfacing is a wrong answer
        being served.
        """
        hero = self.query_one("#brain-hero", Static)
        gauge = self.query_one("#brain-hero-gauge", Gauge)
        facts = self.query_one("#brain-hero-facts", Static)
        violations = int(score.get("violations") or 0)
        if value is None:
            hero.update("[b yellow]NOT MEASURED[/b yellow]  [dim]run init to measure this brain[/dim]")
            facts.update("")
            return
        percent = f"{value * 100:.0f}%"
        if violations:
            status, status_tone = "UNHEALTHY", "red"
            why = f"{violations} wrong answer(s) are being served; MCP stays off until they clear"
        elif (value or 0) >= MCP_THRESHOLD:
            status, status_tone = "HEALTHY", "green"
            why = "good enough to serve your coding agent over MCP"
        else:
            status, status_tone = "BELOW FLOOR", "yellow"
            why = "not accurate enough to serve yet; the Diagnosis tab says what is missing"
        # One statement of the rate, once: the status word, the number, and the bar on the
        # same line. The owner read "retrieval 96%" three times on this screen before this.
        hero.update(
            f"[b {status_tone}]{status}[/b {status_tone}]"
            f"   MCP retrieval rate [b {status_tone}]{percent}[/b {status_tone}]"
            f"\n[dim]{why}[/dim]"
        )
        gauge.set_value(
            float(value),
            motion=getattr(self.app, "motion", None),
            caption=f"needs {MCP_THRESHOLD:.0%} to serve",
        )
        mrr = score.get("mrr")
        mrr_text = f"{float(mrr):.3f}" if isinstance(mrr, (int, float)) else "-"
        measured = f"   measured {str(score.get('at'))[:16].replace('T', ' ')}" if score.get("at") else ""
        facts.update(
            f"[dim]answer ranking (MRR) {mrr_text}{measured}\n"
            f"MRR: how close to the top the right answer lands, 0 to 1; 1.0 means it is "
            f"always the first result.[/dim]"
        )

    async def _load_mcp(self, repo: str) -> None:
        """Arm or gray the connect button; the code itself appears on the click.

        The owner's ask (field, 2026-08-22): a button that is grayed out below
        the threshold and clickable above it, not a dialog of prose. The
        engine's own reason sentence still rides the panel, because the
        decision is the engine's.
        """
        panel = self.query_one("#mcp-summary", Static)
        button = self.query_one("#mcp-unlock", Button)
        try:
            result = await self.client.call("mcpSnippet", {"repoPath": repo})
        except RpcError as error:
            panel.update(f"[yellow]{error.hint}[/yellow]")
            button.disabled = True
            return
        self.mcp_result = result
        reason = str(result.get("reason") or "").strip()
        if not result.get("unlocked"):
            button.disabled = True
            button.variant = "default"
            detail = reason or "The retrieval rate is under the bar, so connecting is not offered yet."
            panel.update(
                f"[yellow]Not available yet.[/yellow] {detail}\n"
                f"[dim]The button turns green when this brain answers well enough "
                f"({MCP_THRESHOLD:.0%} of its gold cases). The Diagnosis tab says what is "
                f"missing.[/dim]"
            )
            return
        button.disabled = False
        button.variant = "success"
        panel.update(
            "[green]Ready to connect.[/green] Press the button for a config snippet you "
            "can paste into your coding agent."
        )

    def show_mcp_snippet(self) -> None:
        result = getattr(self, "mcp_result", None) or {}
        if not result.get("unlocked"):
            return
        # The snippet is UNTRUSTED text as far as markup goes: it is JSON, and
        # JSON's brackets parse as tags. Content.from_markup substitutes the
        # $variable as plain text, which is Textual's own escape hatch; raw
        # interpolation crashed the whole app on the click (fresh-install
        # walkthrough, 2026-08-23).
        self.query_one("#mcp-summary", Static).update(Content.from_markup(
            "Paste this into your MCP client config "
            "[dim](Claude Code: .mcp.json at the repo root; Claude Desktop: "
            "claude_desktop_config.json)[/dim]:\n\n"
            "$snippet\n\n"
            "[dim]Your agent then gets brain.search, brain.conventions, "
            "brain.impact_of and brain.relevant_adrs answered from this repo's "
            "measured brain.[/dim]",
            snippet=str(result.get("snippet", "")),
        ))

    async def _load_diagnosis(self, repo: str) -> None:
        headline = self.query_one("#diagnosis-headline", Static)
        try:
            # recall: clusters over the stored measurement, no embedding sweep on load.
            diagnosis = await self.client.call("diagnose", {"repoPath": repo, "recall": True})
        except RpcError as error:
            headline.update(f"[yellow]{error.hint}[/yellow]")
            return
        # The v5 contract row for diagnose: misses is a LIST of case ids, cases is the
        # denominator, clusters come keyed byType/byArea/byArm with {value, count} rows,
        # and the per-case detail rides perCase (hit flag included). This pane was written
        # against a mock that invented friendlier keys, so it rendered "None of None" and
        # two empty tables over a diagnosis that had a real miss in it.
        case_rate = diagnosis.get("caseRate")
        value = case_rate_value(case_rate)
        threshold = diagnosis.get("threshold", MCP_THRESHOLD)
        above = (value or 0) >= threshold
        miss_ids = diagnosis.get("misses") or []
        total = diagnosis.get("cases")
        if not miss_ids:
            report = "Nothing to fix: every gold case was answered."
        elif above:
            report = (
                f"{len(miss_ids)} of {total} question(s) missed. The brain still clears the "
                f"serving bar; the tables below say where the misses sit."
            )
        else:
            report = (
                f"{len(miss_ids)} of {total} question(s) missed, and the brain is under the "
                f"serving bar. The tables below say which areas and kinds of knowledge are "
                f"thin - that is what to improve first."
            )
        headline.update(
            f"[b]Brain report:[/b] answered [b]{format_case_rate(case_rate)}[/b] of its gold "
            f"cases. {report}\n"
            f"[dim]This report is free and mechanical. The auditor's advice below is a paid "
            f"model call.[/dim]"
        )
        table = self.query_one("#cluster-table", DataTable)
        table.clear()
        clusters = diagnosis.get("clusters") or {}
        for axis, wire_key in (("type", "byType"), ("area", "byArea"), ("arm", "byArm")):
            for row in clusters.get(wire_key, []):
                count = row.get("count", 0)
                share = f"{count} of {len(miss_ids)} misses" if miss_ids else "-"
                table.add_row(axis, str(row.get("value", "")), str(count), share)
        missed = self.query_one("#missed-table", DataTable)
        missed.clear()
        for row in diagnosis.get("perCase") or []:
            if row.get("hit"):
                continue
            missed.add_row(
                row.get("caseId", ""),
                row.get("arm") or "-",
                row.get("type") or "-",
                row.get("area") or "-",
            )

    async def _load_inventory(self, repo: str) -> None:
        summary = self.query_one("#inventory-summary", Static)
        query = self.query_one("#inventory-query", Input).value.strip()
        wanted_type = self.query_one("#inventory-type", Select).value
        filters: dict[str, Any] = {}
        if query:
            filters["q"] = query
        if wanted_type and wanted_type != "all":
            filters["type"] = wanted_type
        try:
            rows = await self.client.call("documents", {"repoPath": repo, "filters": filters})
        except RpcError as error:
            summary.update(f"[yellow]{error.hint}[/yellow]")
            self.documents = []
            self.query_one("#inventory-table", DataTable).clear()
            return
        self.documents = rows if isinstance(rows, list) else rows.get("documents", [])
        table = self.query_one("#inventory-table", DataTable)
        table.clear()
        for row in self.documents:
            table.add_row(
                row.get("id", ""),
                row.get("type", ""),
                row.get("area") or "-",
                row.get("title", ""),
                ", ".join(row.get("tags") or []),
                key=row.get("id"),
            )
        if not filters:
            self._refresh_type_options()
        by_type: dict[str, int] = {}
        for row in self.documents:
            by_type[str(row.get("type"))] = by_type.get(str(row.get("type")), 0) + 1
        breakdown = ", ".join(f"{count} {name}" for name, count in sorted(by_type.items()))
        summary.update(f"[b]{len(self.documents)}[/b] documents  [dim]{breakdown}[/dim]")
        if self.documents:
            self._show_document(self.documents[0])

    def _refresh_type_options(self) -> None:
        """Keep the type filter honest: only types the inventory actually has."""
        types = sorted({str(row.get("type")) for row in self.documents})
        select = self.query_one("#inventory-type", Select)
        current = select.value
        select.set_options([("all types", "all")] + [(name, name) for name in types])
        select.value = current if current in {"all", *types} else "all"

    def _show_document(self, document: dict[str, Any]) -> None:
        self.query_one("#inventory-detail", Static).update(
            f"[b]{document.get('id')}[/b]  {document.get('title', '')}\n"
            f"[dim]{document.get('type')} / {document.get('area') or 'no area'} / "
            f"{document.get('path', '')}[/dim]\n"
            f"tags: {', '.join(document.get('tags') or []) or 'none'}"
        )

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "search-go":
            event.stop()
            await self.run_search()
        elif event.button.id == "brain-remeasure":
            event.stop()
            self.remeasure_at_budget()
        elif event.button.id == "inventory-apply":
            event.stop()
            repo = getattr(self.app, "selected_repo", None)
            if repo:
                await self._load_inventory(repo)
        elif event.button.id == "mcp-unlock":
            event.stop()
            self.show_mcp_snippet()
        elif event.button.id == "narrate-go":
            event.stop()
            self.run_narration()

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "search-input":
            event.stop()
            await self.run_search()
        elif event.input.id == "inventory-query":
            event.stop()
            repo = getattr(self.app, "selected_repo", None)
            if repo:
                await self._load_inventory(repo)

    @work
    async def run_narration(self) -> None:
        repo = getattr(self.app, "selected_repo", None)
        panel = self.query_one("#narration", Static)
        if not repo:
            panel.update("[yellow]No repo selected.[/yellow]")
            return
        confirmed = await self.confirm_spend(
            method="diagnoseNarrate",
            summary=(
                f"The auditor reads the mechanical clusters for {repo} and writes a "
                f"recommendation. This is one paid generation on the auditor key, and it "
                f"has to be confirmed on every call."
            ),
            estimate_lines=[
                "one auditor generation over the clustered diagnosis",
                "the clusters themselves are already computed and cost nothing",
            ],
            confirm_label="Narrate and spend",
        )
        if not confirmed:
            panel.update("[dim]Not requested. Nothing was sent to a provider.[/dim]")
            return
        try:
            result = await self.client.call("diagnoseNarrate", {"repoPath": repo, "confirm": True})
        except RpcError as error:
            self.report_rpc_error(error)
            panel.update(f"[red]{error.hint}[/red]")
            return
        panel.update(Content.from_markup("$text", text=str(result.get("recommendation", ""))))

    async def run_search(self) -> None:
        repo = getattr(self.app, "selected_repo", None)
        query = self.query_one("#search-input", Input).value.strip()
        summary = self.query_one("#search-summary", Static)
        if not repo:
            summary.update("[yellow]No repo selected.[/yellow]")
            return
        if not query:
            summary.update("[dim]Type a query first.[/dim]")
            return
        try:
            result = await self.client.call("search", {"repoPath": repo, "query": query})
        except RpcError as error:
            self.report_rpc_error(error)
            summary.update(f"[red]{error.hint}[/red]")
            return
        self.chunks = result.get("chunks", [])
        table = self.query_one("#chunk-table", DataTable)
        table.clear()
        for index, chunk in enumerate(self.chunks, start=1):
            self._add_chunk_row(table, index, chunk)
        standing = sum(1 for chunk in self.chunks if chunk.get("standing"))
        summary.update(
            f"[b]{len(self.chunks)}[/b] chunks, tokensUsed [b]{result.get('tokensUsed')}[/b], "
            f"{standing} standing unit(s) riding outside the budget\n"
            # The owner asked why this has no percentage when the floor above
            # does. It is deliberate, and the screen now says so: one query is
            # not a measurement. The floor scores a whole gold set and reports
            # a count; a single search has no denominator to be a fraction of.
            f"[dim]No case rate here: one query is not a measurement. The measured "
            f"floor above scores the whole gold set, and it is the number.[/dim]"
        )
        if self.chunks:
            self._show_chunk(self.chunks[0])

    @staticmethod
    def _add_chunk_row(table: DataTable, index: int, chunk: dict[str, Any]) -> None:
        table.add_row(
            str(index),
            chunk.get("id", ""),
            chunk.get("documentId", ""),
            chunk.get("type", ""),
            chunk.get("area") or "-",
            chunk.get("arm") or "-",
            f"{chunk.get('score') or 0:.4f}",
            # Standing units come back with tokens null because they ride
            # outside the budget. str(None) would print "None" in a numeric
            # column, which reads as a value rather than as "not counted".
            _token_cell(chunk),
            "yes" if chunk.get("standing") else "no",
            key=chunk.get("id"),
        )

    def _show_chunk(self, chunk: dict[str, Any]) -> None:
        detail = self.query_one("#chunk-detail", Static)
        detail.update(Content.from_markup(
            f"[b]{chunk.get('id')}[/b]  {chunk.get('documentId')}  "
            f"[dim]{chunk.get('type')} / {chunk.get('area') or 'no area'} / "
            f"{chunk.get('tokens')} tokens[/dim]\n\n$text",
            text=str(chunk.get("text", "")),
        ))

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        key = event.row_key.value if event.row_key else None
        if event.data_table.id == "chunk-table":
            for chunk in self.chunks:
                if chunk.get("id") == key:
                    self._show_chunk(chunk)
                    return
        elif event.data_table.id == "inventory-table":
            for document in self.documents:
                if document.get("id") == key:
                    self._show_document(document)
                    return
