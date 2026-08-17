"""Configure one role: provider, model, reasoning effort, and a key POINTER.

Three rules this dialog exists to hold.

THE CATALOG COMES OFF THE WIRE. Hard-coding five providers here would put both
halves of every model id in this repo and let them go stale together; the
engine serves providerCatalog from a committed data file that calls itself a
starting point rather than a registry, so the list is rendered rather than
known. An unrecognised model is DESCRIBED and used as written, never refused,
because refusing would make that file authoritative over a fact it disclaims.

NO KEY VALUE CROSSES THE WIRE. keyRef is a pointer: an env var name, a file
path, or an env-file reference. The engine refuses anything else, and this
dialog says so BEFORE the user submits rather than reporting a rejection
afterwards.

NULL REASONING EFFORT MEANS UNSUPPORTED, and is the only encoding of it. A
control rendered as "none" would read as a supported setting turned off.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Sequence

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Select, Static

# Mirrored from engine/src/roles/keys.js, parseKeyRef. It is a WHITELIST OF
# SHAPES, not a detector of keys, and the difference matters for the copy: a
# pasted key that happens to be all-caps-and-digits passes as an environment
# variable name. So this says the reference does not LOOK LIKE A POINTER, which
# is a claim about shape, rather than "that looks like a key", which is a claim
# neither side can make.
KEY_REF_FORMS = ("env:NAME", "file:/abs/path", "env-file:/abs/path#NAME")

# The user-facing sentences, as CONSTANTS so a test can assert the copy rather
# than grep the file for a phrase. The first version of that test matched this
# module's own comment explaining what not to say, which is the assert-on-prose
# trap in miniature.
KEY_REF_REFUSED = (
    "This does not look like a pointer, so the engine will refuse it. Use one of: "
    "{forms}. The key VALUE never crosses the wire."
)
KEY_REF_OK = "Reads as a pointer. The engine resolves it at call time."
KEY_REF_HINT = "A pointer to the key, never the key: {forms}."
KEY_NOT_REQUIRED = "This provider is local and needs no key."
_SHOUTING = re.compile(r"^[A-Z][A-Z0-9_]*$")


def parse_key_ref(value: str) -> str | None:
    """Return the form this reference takes, or None if the engine would refuse."""
    text = (value or "").strip()
    if not text:
        return None
    if text.startswith("env:"):
        return "env" if text[4:] else None
    if text.startswith("file:"):
        # ANY non-empty path, relative included. Requiring an absolute path
        # here would make this client stricter than the engine, which accepts
        # file:rel, and a client that refuses what the engine allows blocks a
        # user from something that works. Measured against parseKeyRef.
        return "file" if text[5:] else None
    if text.startswith("env-file:"):
        rest = text[len("env-file:"):]
        # Split on the LAST '#': the engine reads env-file:x#y#z as the file
        # "x#y" and the name "z", so a path containing a hash still works.
        path, sep, name = rest.rpartition("#")
        return "env-file" if sep and path and name else None
    if text.startswith("/"):
        return "file"
    if _SHOUTING.match(text):
        return "env"
    return None


class RoleConfigScreen(ModalScreen[dict[str, Any] | None]):
    """Returns the patch for one role, or None on cancel."""

    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def __init__(self, *, role: dict[str, Any], catalog: dict[str, Any], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.role = dict(role)
        self.catalog = catalog or {}
        self.providers: list[dict[str, Any]] = list(self.catalog.get("providers") or [])

    # Catalog reads -------------------------------------------------------

    def _provider(self, provider_id: Any) -> dict[str, Any] | None:
        return next((p for p in self.providers if p.get("id") == provider_id), None)

    def _models(self, provider_id: Any) -> list[dict[str, Any]]:
        return list((self._provider(provider_id) or {}).get("models") or [])

    def _model(self, provider_id: Any, model_id: Any) -> dict[str, Any] | None:
        return next((m for m in self._models(provider_id) if m.get("id") == model_id), None)

    def compose(self) -> ComposeResult:
        role_name = self.role.get("role", "role")
        with Vertical(id="role-dialog", classes="dialog"):
            yield Static(f"[b]{role_name}[/b]", markup=True)
            yield Select(
                [(p.get("label", p.get("id")), p.get("id")) for p in self.providers],
                id="role-provider",
                prompt="provider",
                value=self.role.get("provider") or Select.BLANK,
            )
            yield Select([], id="role-model", prompt="model", allow_blank=True)
            yield Select([], id="role-reasoning", prompt="reasoning effort", allow_blank=True)
            yield Static("", id="role-model-note", markup=True)
            yield Input(
                placeholder="env:NAME, file:/abs/path, or env-file:/abs/path#NAME",
                id="role-keyref",
                value=str(self.role.get("keyRef") or ""),
            )
            yield Static("", id="role-key-note", markup=True)
            with Horizontal(classes="dialog-actions"):
                yield Button("Save", id="role-save", variant="primary")
                yield Button("Cancel", id="role-cancel")

    def on_mount(self) -> None:
        # AFTER the refresh, not during mount. Setting options on a Select
        # that compose has not finished mounting leaves it empty and the
        # cascade below it disabled, which is the same ordering bug the splash
        # hit when its only paint ran too early.
        self.call_after_refresh(self._initialise)

    def _initialise(self) -> None:
        self._fill_models(self.role.get("provider"), self.role.get("model"))
        self._check_key_ref()

    # Cascade -------------------------------------------------------------

    def _fill_models(self, provider_id: Any, selected: Any = None) -> None:
        models = self._models(provider_id)
        model_select = self.query_one("#role-model", Select)
        model_select.set_options([(m.get("label", m.get("id")), m.get("id")) for m in models])
        if selected and any(m.get("id") == selected for m in models):
            model_select.value = selected
        self._fill_reasoning(provider_id, model_select.value)
        self._describe_model(provider_id, model_select.value)

    def _fill_reasoning(self, provider_id: Any, model_id: Any) -> None:
        model = self._model(provider_id, model_id) or {}
        levels = model.get("reasoningEffort")
        select = self.query_one("#role-reasoning", Select)
        if not levels:
            # null is UNSUPPORTED, and the control says so rather than
            # offering an empty list that reads as a setting with no options.
            select.set_options([])
            select.disabled = True
            return
        select.disabled = False
        select.set_options([(level, level) for level in levels])
        current = self.role.get("reasoningEffort")
        if current in levels:
            select.value = current

    def _describe_model(self, provider_id: Any, model_id: Any) -> None:
        note = self.query_one("#role-model-note", Static)
        if not model_id or model_id is Select.BLANK:
            note.update("")
            return
        model = self._model(provider_id, model_id)
        if model is None:
            # DESCRIBED, not refused. The catalog is a starting point, so a
            # model that shipped today must still be settable.
            note.update(
                "[yellow]Not in the catalog, which is a starting point rather than a "
                "registry. It will be sent as written.[/yellow]"
            )
            return
        note.update(f"[dim]{model.get('note')}[/dim]" if model.get("note") else "")

    def on_select_changed(self, event: Select.Changed) -> None:
        event.stop()
        if event.select.id == "role-provider":
            self._fill_models(event.value)
            self._check_key_ref()
        elif event.select.id == "role-model":
            provider = self.query_one("#role-provider", Select).value
            self._fill_reasoning(provider, event.value)
            self._describe_model(provider, event.value)

    # Key pointer ---------------------------------------------------------

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "role-keyref":
            self._check_key_ref()

    def _check_key_ref(self) -> None:
        note = self.query_one("#role-key-note", Static)
        provider = self._provider(self.query_one("#role-provider", Select).value) or {}
        value = self.query_one("#role-keyref", Input).value.strip()
        if not provider.get("keyRequired", True):
            note.update(f"[dim]{KEY_NOT_REQUIRED}[/dim]")
            return
        if not value:
            note.update(f"[dim]{KEY_REF_HINT.format(forms=', '.join(KEY_REF_FORMS))}[/dim]")
            return
        if parse_key_ref(value) is None:
            note.update(f"[red]{KEY_REF_REFUSED.format(forms=', '.join(KEY_REF_FORMS))}[/red]")
            return
        note.update(f"[green]{KEY_REF_OK}[/green]")

    # Result --------------------------------------------------------------

    def _patch(self) -> dict[str, Any]:
        provider = self.query_one("#role-provider", Select).value
        model = self.query_one("#role-model", Select).value
        reasoning = self.query_one("#role-reasoning", Select)
        patch: dict[str, Any] = {"role": self.role.get("role")}
        if provider is not Select.BLANK:
            patch["provider"] = provider
        if model is not Select.BLANK:
            patch["model"] = model
        # Unsupported stays null. Sending a string would encode a setting the
        # model does not have.
        patch["reasoningEffort"] = (
            None if reasoning.disabled or reasoning.value is Select.BLANK else reasoning.value
        )
        patch["keyRef"] = self.query_one("#role-keyref", Input).value.strip() or None
        return patch

    def action_cancel(self) -> None:
        self.dismiss(None)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        if event.button.id != "role-save":
            self.dismiss(None)
            return
        provider = self._provider(self.query_one("#role-provider", Select).value) or {}
        value = self.query_one("#role-keyref", Input).value.strip()
        if provider.get("keyRequired", True) and value and parse_key_ref(value) is None:
            # Refuse HERE rather than sending something the engine will reject:
            # the user should learn it while looking at the field.
            self._check_key_ref()
            return
        self.dismiss(self._patch())
