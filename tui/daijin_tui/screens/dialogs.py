"""Modal dialogs.

The spend dialog is the important one. The contract enumerates four
spend-touching methods, and every one of them reaches the engine only after
the user has seen what it costs and said yes on that call. The dialog returns
False on escape, so the default outcome of walking away is not spending.
"""

from __future__ import annotations

from typing import Any, Iterable, Sequence

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Static, TextArea


class SpendConfirmScreen(ModalScreen[bool]):
    """Confirm one paid call. Returns True only on an explicit confirm."""

    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def __init__(
        self,
        *,
        method: str,
        summary: str,
        estimate_lines: Sequence[str] = (),
        confirm_label: str = "Spend on this call",
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.method = method
        self.summary = summary
        self.estimate_lines = list(estimate_lines)
        self.confirm_label = confirm_label

    def compose(self) -> ComposeResult:
        with Vertical(id="spend-dialog", classes="dialog"):
            yield Static(f"[b]This call spends money[/b]  [dim]{self.method}[/dim]", markup=True, id="spend-title")
            yield Static(self.summary, id="spend-summary")
            if self.estimate_lines:
                yield Static("\n".join(self.estimate_lines), id="spend-estimate")
            yield Static(
                "[dim]Nothing is sent to a provider unless you confirm. Escape cancels.[/dim]",
                markup=True,
                id="spend-footnote",
            )
            with Horizontal(classes="dialog-actions"):
                yield Button(self.confirm_label, id="spend-confirm", variant="warning")
                yield Button("Cancel", id="spend-cancel", variant="primary")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self.dismiss(event.button.id == "spend-confirm")

    def action_cancel(self) -> None:
        self.dismiss(False)


class TextPromptScreen(ModalScreen[str | None]):
    """Collect one line of text, with a minimum length the caller sets."""

    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def __init__(
        self,
        *,
        title: str,
        prompt: str,
        min_length: int = 0,
        placeholder: str = "",
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.title_text = title
        self.prompt = prompt
        self.min_length = min_length
        self.placeholder = placeholder

    def compose(self) -> ComposeResult:
        with Vertical(id="prompt-dialog", classes="dialog"):
            yield Static(f"[b]{self.title_text}[/b]", markup=True)
            yield Static(self.prompt, id="prompt-text")
            yield Input(placeholder=self.placeholder, id="prompt-input")
            yield Static("", id="prompt-error", markup=True)
            with Horizontal(classes="dialog-actions"):
                yield Button("Save", id="prompt-ok", variant="primary")
                yield Button("Cancel", id="prompt-cancel")

    def on_mount(self) -> None:
        self.query_one("#prompt-input", Input).focus()

    def _submit(self) -> None:
        value = self.query_one("#prompt-input", Input).value.strip()
        if len(value) < self.min_length:
            self.query_one("#prompt-error", Static).update(
                f"[yellow]At least {self.min_length} characters, currently {len(value)}.[/yellow]"
            )
            return
        self.dismiss(value)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        if event.button.id == "prompt-ok":
            self._submit()
        else:
            self.dismiss(None)

    def on_input_submitted(self, event: Input.Submitted) -> None:
        event.stop()
        self._submit()

    def action_cancel(self) -> None:
        self.dismiss(None)


class AgentFileEditScreen(ModalScreen[str | None]):
    """Edit one .daijin/agents instruction file."""

    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def __init__(self, *, role: str, content: str, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.role = role
        self.content = content

    def compose(self) -> ComposeResult:
        with Vertical(id="agent-file-dialog", classes="dialog"):
            yield Static(f"[b].daijin/agents/{self.role}.md[/b]", markup=True)
            yield Static(
                "[dim]House conventions: date corrections in place, mark withdrawn claims "
                "WITHDRAWN rather than deleting them, add an era note when the harness "
                "changes underneath the reader.[/dim]",
                markup=True,
            )
            yield TextArea(self.content, id="agent-file-text")
            with Horizontal(classes="dialog-actions"):
                yield Button("Save", id="agent-file-save", variant="primary")
                yield Button("Cancel", id="agent-file-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        if event.button.id == "agent-file-save":
            self.dismiss(self.query_one("#agent-file-text", TextArea).text)
        else:
            self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


def budget_estimate_lines(estimate: dict[str, Any] | None) -> Iterable[str]:
    """Format a budgetEstimate result for the spend dialog.

    basis is shown, not just the number: a figure the user cannot trace is a
    figure they can only take on trust, and this dialog exists to be trusted.
    """
    if not estimate:
        return ["Estimated budget unavailable: the engine returned no estimate."]
    tokens = int(estimate.get("estimatedTokens") or 0)
    lines = [f"estimated tokens  {tokens:,}"]
    basis = str(estimate.get("basis") or "").strip()
    if basis:
        lines.append(f"basis             {basis}")
    lines.append("estimate is deterministic and cost nothing to produce")
    return lines
