"""Attach a repo: pick a discovered one, type a path, or clone a URL.

This replaces a bare text input that accepted anything. The field test
attached the literal string "cd" and, separately, a nested near-empty
directory, and neither told the user anything until much later.

The validation here mirrors the ENGINE and is deliberately no stricter. A path
that does not exist is refused without a round trip, because that is the case
we agree on exactly. A directory that is NOT a git repository is ACCEPTED with
a warning, because the engine accepts it and init on one completes and simply
produces less: refusing it here would enforce a rule the engine declines to
have, and block a user from something that works.
"""

from __future__ import annotations

from typing import Any, Iterable

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, DataTable, Input, Static, TabbedContent, TabPane

from ..discovery import Discovered, describe_path, looks_like_clone_url, scan_roots

DISCOVERED_COLUMNS = ("repo", "git", "path")


class AttachRepoScreen(ModalScreen[dict[str, Any] | None]):
    """Returns {"kind": "path"|"url", "value": str} or None.

    The screen does not call the engine itself: it returns a choice and the
    repo home performs it, so the spend-free attach and the streaming clone
    are started by the screen that owns the job and the notice.
    """

    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def __init__(
        self,
        *,
        roots: list[str] | None = None,
        clone_available: bool = True,
        clone_unavailable_reason: str = "",
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.roots = list(roots or [])
        # The URL route exists only when the engine answers for it. A control
        # that is visible and does nothing is the appeared-to-do-nothing
        # defect; a control that is absent, or present with the engine's own
        # reason, is honest.
        self.clone_available = clone_available
        self.clone_unavailable_reason = clone_unavailable_reason
        self.discovered: list[Discovered] = []

    def compose(self) -> ComposeResult:
        with Vertical(id="attach-dialog", classes="dialog"):
            yield Static("[b]Attach a repo[/b]", markup=True)
            with TabbedContent(id="attach-tabs"):
                with TabPane("Discovered", id="attach-tab-found"):
                    yield Static("", id="attach-scan-note", markup=True)
                    yield DataTable(id="attach-table", cursor_type="row")
                    yield Button("Attach selected", id="attach-pick", variant="primary")
                with TabPane("Path", id="attach-tab-path"):
                    yield Input(placeholder="path to a repo on this machine", id="attach-path")
                    yield Static("", id="attach-path-note", markup=True)
                    yield Button("Attach path", id="attach-path-go", variant="primary")
                with TabPane("Clone a URL", id="attach-tab-url"):
                    yield Input(
                        placeholder="https://github.com/owner/name",
                        id="attach-url",
                        disabled=not self.clone_available,
                    )
                    yield Static("", id="attach-url-note", markup=True)
                    yield Button(
                        "Clone and attach",
                        id="attach-url-go",
                        variant="primary",
                        disabled=not self.clone_available,
                    )
            with Horizontal(classes="dialog-actions"):
                yield Button("Cancel", id="attach-cancel")

    def on_mount(self) -> None:
        # After the refresh: setting a table's columns while compose is still
        # mounting leaves it empty, which cost an hour on the role dialog.
        self.call_after_refresh(self._initialise)

    def _initialise(self) -> None:
        table = self.query_one("#attach-table", DataTable)
        if not table.columns:
            table.add_columns(*DISCOVERED_COLUMNS)
        self._rescan()
        if not self.clone_available:
            self.query_one("#attach-url-note", Static).update(
                f"[yellow]{self.clone_unavailable_reason or 'This engine cannot clone yet.'}[/yellow]"
            )

    def _rescan(self) -> None:
        note = self.query_one("#attach-scan-note", Static)
        if not self.roots:
            note.update(
                "[dim]No scan roots configured. Settings holds repoScanRoots, and "
                "the Path tab works regardless.[/dim]"
            )
            return
        self.discovered = scan_roots(self.roots)
        table = self.query_one("#attach-table", DataTable)
        table.clear()
        for item in self.discovered:
            table.add_row(item.name, "yes" if item.is_git else "no", item.path, key=item.path)
        note.update(
            f"[dim]{len(self.discovered)} found under {', '.join(self.roots)}. "
            f"The scan stops at each repository and does not look inside it.[/dim]"
            if self.discovered
            else f"[dim]Nothing found under {', '.join(self.roots)}.[/dim]"
        )

    # Validation ----------------------------------------------------------

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "attach-path":
            ok, reason = describe_path(event.value)
            note = self.query_one("#attach-path-note", Static)
            if not event.value.strip():
                note.update("")
            elif not ok:
                note.update(f"[red]{reason}[/red]")
            else:
                note.update(f"[yellow]{reason}[/yellow]" if reason else "[green]Ready.[/green]")
        elif event.input.id == "attach-url":
            note = self.query_one("#attach-url-note", Static)
            if not event.value.strip():
                note.update("")
            elif looks_like_clone_url(event.value):
                note.update("[green]Reads as a repository URL. The engine will clone it.[/green]")
            else:
                note.update(
                    "[red]Not a repository URL. Expected something like "
                    "https://github.com/owner/name or git@github.com:owner/name.git. "
                    "To attach a directory you already have, use the Path tab.[/red]"
                )

    # Result --------------------------------------------------------------

    def action_cancel(self) -> None:
        self.dismiss(None)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        button = event.button.id
        if button == "attach-cancel":
            self.dismiss(None)
        elif button == "attach-pick":
            self._pick()
        elif button == "attach-path-go":
            value = self.query_one("#attach-path", Input).value.strip()
            ok, reason = describe_path(value)
            if not ok:
                self.query_one("#attach-path-note", Static).update(f"[red]{reason}[/red]")
                return
            self.dismiss({"kind": "path", "value": value})
        elif button == "attach-url-go":
            value = self.query_one("#attach-url", Input).value.strip()
            if not looks_like_clone_url(value):
                self.on_input_changed(Input.Changed(self.query_one("#attach-url", Input), value))
                return
            self.dismiss({"kind": "url", "value": value})

    def _pick(self) -> None:
        table = self.query_one("#attach-table", DataTable)
        if not table.row_count:
            self.query_one("#attach-scan-note", Static).update(
                "[yellow]Nothing to pick. Use the Path tab.[/yellow]"
            )
            return
        try:
            key = table.coordinate_to_cell_key(table.cursor_coordinate).row_key.value
        except Exception:  # noqa: BLE001 - no selection is not an error
            return
        if key:
            self.dismiss({"kind": "path", "value": str(key)})
