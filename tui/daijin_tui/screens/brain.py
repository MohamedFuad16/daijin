"""Brain browser, retrieval tester, and the mechanical sub-75 diagnosis."""

from __future__ import annotations

from typing import Any, Iterable

from textual import work
from textual.containers import Horizontal
from textual.widgets import Button, DataTable, Input, Select, Static, TabbedContent, TabPane

from ..concurrency import gather_all
from ..rpc import RpcError
from ..widgets import (
    Banner,
    DitherBars,
    Gauge,
    MCP_THRESHOLD,
    SectionTitle,
    case_rate_value,
    format_case_rate,
    format_ratio,
)
from ..widgets.texture import NEUTRAL, PASS
from .base import DaijinScreen

CHUNK_COLUMNS = ("rank", "chunk", "document", "type", "area", "arm", "score", "tokens", "standing")
PER_CASE_COLUMNS = ("case", "hit", "rank", "arm", "type", "area")
CLUSTER_COLUMNS = ("axis", "key", "missed", "of", "share")
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
    subheading = "measured retrieval accuracy, count and percentage together"

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
                yield SectionTitle("Measured floor", "from retrievalScore, re-derived, not read off a filename")
                yield Static("", id="floor-summary", markup=True)
                yield SectionTitle(
                    "Budget sweep",
                    "one measurement across budgets, not a trend over time; the card sparkline is the trend",
                )
                yield DitherBars(
                    title="cases hit by token budget", height=10, bar_width=5, id="budget-sweep"
                )
                yield SectionTitle("Per case", "arm, type, and area are what the diagnosis clusters on")
                yield DataTable(id="percase-table", cursor_type="row")
                yield SectionTitle("MCP unlock")
                yield Static("", id="mcp-summary", markup=True)
                yield SectionTitle("Retrieval tester")
                with Horizontal(id="search-row"):
                    yield Input(placeholder="ask the brain something", id="search-input")
                    yield Button("Search", id="search-go", variant="primary")
                yield Static("", id="search-summary", markup=True)
                yield DataTable(id="chunk-table", cursor_type="row")
                yield SectionTitle("Selected chunk")
                yield Static("[dim]no chunk selected[/dim]", id="chunk-detail", markup=True)

            with TabPane("Inventory", id="brain-tab-inventory"):
                yield SectionTitle("Brain inventory", "from documents, browsing is not search only")
                with Horizontal(id="inventory-filters"):
                    yield Input(placeholder="filter by title, id, or path", id="inventory-query")
                    yield Select(
                        [("all types", "all")],
                        value="all",
                        id="inventory-type",
                        allow_blank=False,
                    )
                    yield Button("Apply", id="inventory-apply", variant="primary")
                yield Static("", id="inventory-summary", markup=True)
                yield DataTable(id="inventory-table", cursor_type="row")
                yield Static("[dim]no document selected[/dim]", id="inventory-detail", markup=True)
            with TabPane("Diagnosis", id="brain-tab-diagnosis"):
                yield Static("", id="diagnosis-headline", markup=True)
                yield SectionTitle("Mechanical clusters", "zero-spend, arithmetic over the per case rows")
                yield DataTable(id="cluster-table", cursor_type="row")
                yield SectionTitle("Missed cases")
                yield DataTable(id="missed-table", cursor_type="row")
                yield SectionTitle("Auditor recommendation", "a paid generation, on your explicit go ahead only")
                yield Button("Ask the auditor to narrate (spends)", id="narrate-go", variant="warning")
                yield Static("[dim]not requested[/dim]", id="narration", markup=True)

    async def load(self) -> None:
        self._init_columns()
        self.refresh_heading()
        notice = self.query_one("#brain-notice", Banner)
        repo = getattr(self.app, "selected_repo", None)
        if not repo:
            notice.set_notice("No repo selected. Press 1 for the repo home and pick one.", "warn")
            self.query_one("#floor-summary", Static).update("[dim]no repo selected[/dim]")
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
        summary = self.query_one("#floor-summary", Static)
        try:
            score = await self.client.call("retrievalScore", {"repoPath": repo, "sweep": True})
        except RpcError as error:
            summary.update(f"[yellow]{error.hint}[/yellow]")
            return
        self.score = score
        case_rate = score.get("caseRate")
        value = case_rate_value(case_rate)
        tone = "green" if (value or 0) >= MCP_THRESHOLD else "yellow"
        self._paint_hero(score, value, tone)
        summary.update(
            f"case rate [{tone}]{format_case_rate(case_rate)}[/{tone}]  "
            f"[dim]ratio {format_ratio(value)}, threshold {MCP_THRESHOLD}[/dim]\n"
            f"MRR {score.get('mrr')} [dim]recorded for movement only, never a floor[/dim]\n"
            f"violations {score.get('violations')} [dim]enforced floor, must-not pairs[/dim]\n"
            f"chosen budget {score.get('chosenBudget')}  [dim]{score.get('rationale', '')}[/dim]"
        )
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
        sweep = score.get("budgetSweep") or []
        if sweep:
            # The house chart vocabulary (owner field round 4): dithered bars,
            # texture and colour as two channels, not a plotext line. The
            # CHOSEN budget wears the pass texture and every other point the
            # neutral one, and the ceiling is the case total so the bars stay
            # comparable across repos instead of always looking full.
            hits = []
            total = 0
            for point in sweep:
                cases = str(point.get("caseRate", {}).get("cases", ""))
                if " of " in cases:
                    hit, _, denominator = cases.partition(" of ")
                    hits.append(int(hit))
                    total = max(total, int(denominator))
                else:
                    hits.append(0)
            chosen = score.get("chosenBudget")
            self.query_one("#budget-sweep", DitherBars).set_data(
                [str(point["budget"]) for point in sweep],
                hits,
                textures=[
                    PASS if point["budget"] == chosen else NEUTRAL for point in sweep
                ],
                ceiling=total or None,
                ceiling_label=f"ceiling {total} cases; chosen budget carries the solid texture",
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
        percent = f"{value * 100:.1f}%"
        cases = ""
        if isinstance(score.get("caseRate"), dict):
            cases = str(score["caseRate"].get("cases") or "")
        if violations:
            status, status_tone = "UNHEALTHY", "red"
            why = f"{violations} must-not violation(s): wrong answers are being served"
        elif (value or 0) >= MCP_THRESHOLD:
            status, status_tone = "HEALTHY", "green"
            why = "above the unlock threshold; MCP serving is offered"
        else:
            status, status_tone = "BELOW FLOOR", "yellow"
            why = "under the unlock threshold; see Diagnosis for what is missing"
        hero.update(
            f"[b {status_tone}]{status}[/b {status_tone}]"
            f"   retrieval [b {status_tone}]{percent}[/b {status_tone}]"
            + (f" [dim]({cases} gold cases answered)[/dim]" if cases else "")
            + f"\n[dim]{why}[/dim]"
        )
        gauge.set_value(
            float(value),
            motion=getattr(self.app, "motion", None),
            caption=f"retrieval {percent}, threshold {MCP_THRESHOLD}",
        )
        measured = f"   measured {score['at']}" if score.get("at") else ""
        facts.update(
            f"[dim]MRR {score.get('mrr')}   violations {violations}   "
            f"budget {score.get('chosenBudget')}{measured}[/dim]"
        )

    async def _load_mcp(self, repo: str) -> None:
        panel = self.query_one("#mcp-summary", Static)
        try:
            result = await self.client.call("mcpSnippet", {"repoPath": repo})
        except RpcError as error:
            panel.update(f"[yellow]{error.hint}[/yellow]")
            return
        # The engine's reason sentence comes from floor.js, the module that
        # made the decision; show it verbatim rather than paraphrasing. The
        # owner asked this panel to say what the unlock actually is: the
        # threshold, why this repo is on its side of it, and once unlocked,
        # what to do with the snippet.
        reason = str(result.get("reason") or "").strip()
        if not result.get("unlocked"):
            detail = reason or (
                f"The floor sits below the {result.get('threshold', MCP_THRESHOLD)} "
                "threshold, so no snippet is offered."
            )
            panel.update(
                f"[yellow]MCP locked.[/yellow] {detail}\n"
                f"[dim]threshold {result.get('threshold', MCP_THRESHOLD)}. "
                f"Re-run init after improving the brain; the Diagnosis tab says "
                f"what is missing.[/dim]"
            )
            return
        panel.update(
            f"[green]MCP unlocked[/green] at threshold {result.get('threshold')}."
            + (f" {reason}" if reason else "")
            + "\n\nPaste ready config:\n\n"
            f"{result.get('snippet', '')}\n\n"
            f"[dim]Paste into your MCP client config (Claude Code: .mcp.json at "
            f"the repo root; Claude Desktop: claude_desktop_config.json). Your "
            f"agent then gets brain.search, brain.conventions, brain.impact_of "
            f"and brain.relevant_adrs answered from this repo's measured "
            f"brain.[/dim]"
        )

    async def _load_diagnosis(self, repo: str) -> None:
        headline = self.query_one("#diagnosis-headline", Static)
        try:
            diagnosis = await self.client.call("diagnose", {"repoPath": repo})
        except RpcError as error:
            headline.update(f"[yellow]{error.hint}[/yellow]")
            return
        case_rate = diagnosis.get("caseRate")
        value = case_rate_value(case_rate)
        threshold = diagnosis.get("threshold", MCP_THRESHOLD)
        above = (value or 0) >= threshold
        headline.update(
            f"case rate [b]{format_case_rate(case_rate)}[/b], "
            f"{'above' if above else 'below'} the {threshold} threshold. "
            f"{diagnosis.get('missed')} of {diagnosis.get('total')} cases miss.\n"
            f"[dim]This clustering is mechanical and free. The narration below is not.[/dim]"
        )
        table = self.query_one("#cluster-table", DataTable)
        table.clear()
        for axis in ("type", "area", "arm"):
            for row in (diagnosis.get("clusters") or {}).get(axis, []):
                of = row.get("of") or 0
                share = f"{row.get('missed', 0)} of {of}"
                table.add_row(axis, row.get("key", ""), str(row.get("missed", 0)), str(of), share)
        missed = self.query_one("#missed-table", DataTable)
        missed.clear()
        for row in diagnosis.get("missedCases", []):
            missed.add_row(row.get("caseId", ""), row.get("arm", ""), row.get("type", ""), row.get("area") or "-")

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
        elif event.button.id == "inventory-apply":
            event.stop()
            repo = getattr(self.app, "selected_repo", None)
            if repo:
                await self._load_inventory(repo)
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
        panel.update(str(result.get("recommendation", "")))

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
        detail.update(
            f"[b]{chunk.get('id')}[/b]  {chunk.get('documentId')}  "
            f"[dim]{chunk.get('type')} / {chunk.get('area') or 'no area'} / "
            f"{chunk.get('tokens')} tokens[/dim]\n\n{chunk.get('text', '')}"
        )

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
