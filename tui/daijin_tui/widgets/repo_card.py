"""A connected repo, rendered as a card on the repo home."""

from __future__ import annotations

from typing import Any

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.message import Message
from textual.widgets import Button, Static

from .common import MCP_THRESHOLD, case_rate_value, format_case_rate, format_ratio, health_glyph
from .sparkline import Sparkline


class RepoCard(Vertical):
    """Health dot, measured floor, floor-over-time sparkline, one primary action.

    A repo with no brain shows exactly one action, Initialize brain. A repo
    with a brain shows Open. Detach sits apart from the primary action so the
    destructive one is never the button under the thumb.
    """

    can_focus = True

    class Selected(Message):
        def __init__(self, repo: dict[str, Any]) -> None:
            super().__init__()
            self.repo = repo

    class InitRequested(Message):
        def __init__(self, repo: dict[str, Any]) -> None:
            super().__init__()
            self.repo = repo

    class DetachRequested(Message):
        def __init__(self, repo: dict[str, Any]) -> None:
            super().__init__()
            self.repo = repo

    def __init__(self, repo: dict[str, Any], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.repo = dict(repo)
        self.add_class("repo-card")
        self.history: list[float] = []
        self.has_brain: bool | None = None
        self.case_rate: dict[str, Any] | None = None

    @property
    def repo_path(self) -> str:
        return str(self.repo.get("path", ""))

    # serveStatus rows carry health, and health names whether a brain exists.
    # Locked in contract v5: no-brain | warn | ok | critical, where critical is
    # a brain that could NOT BE OPENED. Verified against the daemon on
    # 2026-08-17 that the row carries no hasBrain field, so health is the only
    # thing that can answer this.
    HEALTH_HAS_BRAIN = {"no-brain": False, "ok": True, "warn": True, "critical": True}

    @property
    def needs_brain(self) -> bool:
        if self.has_brain is not None:
            return not self.has_brain
        known = self.HEALTH_HAS_BRAIN.get(str(self.repo.get("health") or ""))
        if known is not None:
            # A critical repo HAS a brain that will not open. Offering to
            # initialize one would put the destructive action under the thumb
            # of the user whose brain just failed to load.
            return not known
        return self.repo.get("floorScore") is None

    def compose(self) -> ComposeResult:
        glyph, klass = health_glyph(self.repo.get("health"), self.repo.get("floorScore"))
        name = self.repo_path.rstrip("/").split("/")[-1] or self.repo_path
        yield Static(f"[b]{glyph}[/b] [b]{name}[/b]", markup=True, classes=f"card-title {klass}")
        yield Static(self.repo_path, classes="card-path")
        yield Static(self._floor_text(), markup=True, classes="card-floor")
        yield Sparkline([], caption="floor over time", classes="card-spark")
        yield Static(self._mcp_text(), markup=True, classes="card-mcp")
        with Horizontal(classes="card-actions"):
            yield Button(
                "Initialize brain" if self.needs_brain else self._open_label(),
                id=f"card-action-{abs(hash(self.repo_path))}",
                variant="primary" if self.needs_brain else "default",
                classes="card-action",
            )
            yield Button("Detach", id=f"card-detach-{abs(hash(self.repo_path))}", classes="card-detach")

    def _open_label(self) -> str:
        return "Inspect brain" if self.repo.get("health") == "critical" else "Open brain"

    def _floor_text(self) -> str:
        """Show the count form when it is available, never a rounded percentage."""
        if self.repo.get("health") == "critical":
            # A floor from a brain that will not open is a number about
            # nothing, so the state is named instead of scored.
            return "[red]brain could not be opened[/red]  [dim]no floor can be measured from it[/dim]"
        if self.case_rate is not None:
            value = case_rate_value(self.case_rate)
            tone = "green" if (value or 0) >= MCP_THRESHOLD else "yellow"
            return (
                f"floor [{tone}]{format_case_rate(self.case_rate)}[/{tone}] cases  "
                f"[dim]ratio {format_ratio(value)}, threshold {MCP_THRESHOLD}[/dim]"
            )
        floor = self.repo.get("floorScore")
        if floor is None:
            # "no brain yet" is only true for no-brain. A warn repo with a null
            # floor HAS a brain that nobody has scored, which is a different
            # thing to tell the user and a different thing for them to do.
            if self.repo.get("health") == "no-brain":
                return "[dim]floor not measured, no brain yet[/dim]"
            return "[dim]indexed, floor never measured. Run the retrieval score.[/dim]"
        tone = "green" if floor >= MCP_THRESHOLD else "yellow"
        return (
            f"floor ratio [{tone}]{format_ratio(floor)}[/{tone}]  "
            f"[dim]denominator not carried by serveStatus, threshold {MCP_THRESHOLD}[/dim]"
        )

    def _mcp_text(self) -> str:
        active = self.repo.get("mcpActive")
        if active:
            return "[green]MCP serving[/green]"
        if self.needs_brain:
            return "[dim]MCP locked until the floor is measured[/dim]"
        return "[yellow]MCP idle[/yellow]"

    def set_score(self, score: dict[str, Any]) -> None:
        """Fill the current floor from one retrievalScore result."""
        self.case_rate = score.get("caseRate")
        for child in self.query(".card-floor"):
            child.update(self._floor_text())

    def set_history(self, history: list[dict[str, Any]]) -> None:
        """Draw the floor over TIME from scoreHistory.

        scoreHistory arrives newest first; the sparkline reads left to right in
        time order, so it is reversed here. This series is deliberately not the
        budget sweep: one is the floor moving over days, the other is one
        measurement across budgets, and drawing them under one caption would
        invite reading a sweep as progress.
        """
        self.history = [case_rate_value(point.get("caseRate")) or 0.0 for point in reversed(history)]
        if history:
            oldest = history[-1].get("at", "")[:10]
            newest = history[0].get("at", "")[:10]
            caption = f"floor over time, {oldest} to {newest}, {len(history)} measurements"
        else:
            caption = "floor over time, no measurements yet"
        for child in self.query(Sparkline):
            child.set_values(self.history, caption)

    def set_has_brain(self, has_brain: bool) -> None:
        """Authoritative answer from analyze(repoPath).hasBrainFolder."""
        self.has_brain = has_brain
        for button in self.query(".card-action"):
            button.label = "Initialize brain" if self.needs_brain else "Open brain"
            button.variant = "primary" if self.needs_brain else "default"
        for child in self.query(".card-mcp"):
            child.update(self._mcp_text())

    def on_click(self) -> None:
        self.focus()
        self.post_message(self.Selected(self.repo))

    def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        if event.button.has_class("card-detach"):
            self.post_message(self.DetachRequested(self.repo))
        elif self.needs_brain:
            self.post_message(self.InitRequested(self.repo))
        else:
            self.post_message(self.Selected(self.repo))

    def on_key(self, event: Any) -> None:
        if event.key == "enter":
            event.stop()
            if self.needs_brain:
                self.post_message(self.InitRequested(self.repo))
            else:
                self.post_message(self.Selected(self.repo))
