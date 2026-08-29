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

import os
import re
from pathlib import Path
from typing import Any, Iterable, Sequence

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.content import Content
from textual.screen import ModalScreen
from textual.widgets import Button, Checkbox, Input, Select, Static

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
KEY_PASTE_NOTE = (
    "Reads as a key VALUE. On save it is stored in a private file under the "
    "state root's keys/ directory (readable only by you) and only that "
    "file's path is kept. "
    "The key itself never crosses the wire."
)
_SHOUTING = re.compile(r"^[A-Z][A-Z0-9_]*$")
# After the prefix, case IS allowed: a lowercase environment variable is legal
# and `env:` has already disambiguated. The BARE form must still shout, because
# that is the only thing telling it apart from a path.
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# The engine's own refusal sentences, mirrored and checked against
# keyRefRefusal by tests/test_key_ref_parity.py. Displaying the engine's words
# rather than composing my own keeps one explanation of one rule.
#
# NONE OF THEM QUOTE THE VALUE. The likeliest wrong input here is a pasted API
# key, and a warning that echoes it puts it on screen, in a screenshot, and in
# any log that captures rendered output. A field that masks while typing and
# then quotes the value in an error has masked nothing.
REFUSAL_RELATIVE = (
    "The path is relative. It is read by the daemon, which does not share your "
    "shell's working directory, so give the full path from the root, as "
    "file:/absolute/path."
)
REFUSAL_ENV_FILE_RELATIVE = (
    "The path in an env-file pointer is relative. It is read by the daemon, which "
    "does not share your shell's working directory, so give the full path from the "
    "root: env-file:/absolute/path#VARIABLE_NAME."
)
REFUSAL_ENV_FILE = (
    "An env-file pointer needs a variable name after a #, as "
    "env-file:/absolute/path#VARIABLE_NAME."
)
REFUSAL_ENV_NAME = (
    "An env pointer needs the NAME of an environment variable after the colon, as "
    "env:VARIABLE_NAME. A name may hold letters, digits and underscores, so "
    "anything with dashes or dots is not one, and a key value is never accepted "
    "here."
)
REFUSAL_EMPTY = "The pointer is empty."
REFUSAL_BARE = (
    "A pointer is the NAME of a place a key is kept, never the key. Use an "
    "environment variable name in capitals, an absolute file path, or one of the "
    "explicit forms: env:NAME, file:/abs/path, env-file:/abs/path#NAME."
)


def parse_key_ref(value: str) -> str | None:
    """Return the form this reference takes, or None if the engine would refuse.

    A WHITELIST OF SHAPES, not a detector of keys. Mirrored from
    engine/src/roles/keys.js and checked against it by an executable parity
    test, because two implementations of one rule each match what their own
    author believed and neither can be verified by reading.
    """
    text = (value or "").strip()
    if not text:
        return None
    if text.startswith("env:"):
        # A NAME, not any string. Dashes and dots are not legal in one, which
        # refuses the sk-ant and sk-proj shapes outright rather than by
        # lowercase accident.
        return "env" if _ENV_NAME.match(text[4:]) else None
    if text.startswith("file:"):
        # ABSOLUTE. A relative pointer resolves against the DAEMON's working
        # directory, so the same setting names a different file depending on
        # how the process was launched. The engine accepted relative paths for
        # a while against its own contract; that was the defect this mirror
        # found, not a rule to copy.
        return "file" if text[5:].startswith("/") else None
    if text.startswith("env-file:"):
        rest = text[len("env-file:"):]
        # Split on the LAST '#': an absolute path may legitimately contain one
        # and a variable name may not.
        path, sep, name = rest.rpartition("#")
        return "env-file" if sep and path.startswith("/") and name else None
    if text.startswith("/"):
        return "file"
    if _SHOUTING.match(text):
        return "env"
    return None


def key_ref_refusal(value: str) -> str | None:
    """Why the engine would refuse this pointer, or None when it would not.

    None reads as "no complaint", the same shape the engine's keyRefRefusal
    uses, so the caller does not have to invert a boolean to find the message.
    """
    text = (value or "").strip()
    if not text:
        # The RULE says an empty pointer is a refusal, and this function
        # reports the rule. Whether a user who has typed nothing yet should be
        # shown red is a PRESENTATION question, answered at the call site,
        # which shows the hint instead.
        return REFUSAL_EMPTY
    if parse_key_ref(text) is not None:
        return None
    if text.startswith("env-file:"):
        rest = text[len("env-file:"):]
        if "#" not in rest:
            return REFUSAL_ENV_FILE
        path, _, name = rest.rpartition("#")
        # An EMPTY path or name is a malformed pointer, not a relative one, so
        # it gets the shape sentence rather than the working-directory one.
        if not path or not name:
            return REFUSAL_ENV_FILE
        if not path.startswith("/"):
            # env-file has its OWN relative sentence, naming its own form. The
            # first version of this mirror reused file:'s and told the user to
            # write file:/absolute/path for an env-file pointer.
            return REFUSAL_ENV_FILE_RELATIVE
        return REFUSAL_ENV_FILE
    if text.startswith("file:"):
        return REFUSAL_RELATIVE
    if text.startswith("env:"):
        return REFUSAL_ENV_NAME
    return REFUSAL_BARE


def looks_like_pasted_key(value: str) -> bool:
    """A value that is not a pointer but plausibly IS the key itself.

    The field's likeliest wrong input was always a pasted API key, and the
    old answer was a refusal that sent the user off to create a file by
    hand. The product answer is to do that for them: the dialog writes the
    key to a private file and stores the pointer, so the pointer-only rule
    on the wire is kept without asking a user to know it. Deliberately
    loose (no whitespace, not tiny, not a pointer): a false positive costs
    one unnecessary key file, a false negative costs a refusal, and both
    are recoverable.
    """
    text = (value or "").strip()
    return (
        len(text) >= 8
        and not any(ch.isspace() for ch in text)
        and parse_key_ref(text) is None
    )


def discover_key_sources(state_root: Any = None) -> list[tuple[str, str]]:
    """Pointers this machine already has: saved key files and env vars.

    The owner asked for discovery instead of typing: a picker of what exists.
    Two sources, both local and instant: the state root's keys/ directory
    (where pasted keys are saved), and environment variable NAMES that look
    like credentials. Names only, never values: the value stays wherever it
    is, which is the entire point of pointers. Deliberately NO machine-wide
    filesystem scan: a regex walk of the disk hunting key-shaped files would
    be slow, invasive, and indistinguishable from malware to anyone watching.
    """
    sources: list[tuple[str, str]] = []
    keys_dir = (Path(state_root) if state_root else Path.home() / ".daijin") / "keys"
    try:
        for file in sorted(keys_dir.glob("*.key")):
            sources.append((f"saved key: {file.name}", f"file:{file}"))
    except OSError:
        pass
    credential = re.compile(r"(API_?KEY|TOKEN|SECRET)", re.IGNORECASE)
    for name in sorted(os.environ):
        if credential.search(name) and os.environ.get(name, "").strip():
            sources.append((f"env var: {name}", f"env:{name}"))
    return sources


class RoleConfigScreen(ModalScreen[dict[str, Any] | None]):
    """Returns the patch for one role, or None on cancel."""

    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def __init__(
        self,
        *,
        role: dict[str, Any],
        catalog: dict[str, Any],
        agents: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.role = dict(role)
        self.catalog = catalog or {}
        self.providers: list[dict[str, Any]] = list(self.catalog.get("providers") or [])
        # The machine's Claude Code sub-agents (agentCatalog). Only the
        # claude-code provider reads them; an empty list renders as an empty
        # picker with the note saying where agent files live.
        self.agents: list[dict[str, Any]] = list(agents or [])
        self.key_sources: list[tuple[str, str]] = []

    # Catalog reads -------------------------------------------------------

    def _provider(self, provider_id: Any) -> dict[str, Any] | None:
        return next((p for p in self.providers if p.get("id") == provider_id), None)

    def _models(self, provider_id: Any) -> list[dict[str, Any]]:
        return list((self._provider(provider_id) or {}).get("models") or [])

    def _model(self, provider_id: Any, model_id: Any) -> dict[str, Any] | None:
        return next((m for m in self._models(provider_id) if m.get("id") == model_id), None)

    def compose(self) -> ComposeResult:
        role_name = self.role.get("role", "role")
        self.key_sources = discover_key_sources(getattr(self.app, "state_root", None))
        # LABELLED AND SPACED (owner field round 6): every control carries a
        # dim label above it and breathing room around it, so a note under one
        # field cannot read as the caption of the next. The field list
        # scrolls; the Save row never moves.
        with Vertical(id="role-dialog", classes="dialog"):
            yield Static(f"[b]{role_name}[/b]", markup=True, classes="dialog-title")
            with VerticalScroll(id="role-fields"):
                yield Static("provider", classes="field-label")
                # NO SELECTION IS EXPRESSED BY OMITTING THE VALUE, not by a
                # sentinel. Select.BLANK in Textual 8.2.8 is a legacy alias
                # equal to `False`, and the widget's own validator REFUSES it,
                # so `provider or Select.BLANK` handed the Select an illegal
                # value for every role with no provider - which is every role
                # a fresh user has.
                configured = self.role.get("provider")
                provider_options = [
                    (p.get("label", p.get("id")), p.get("id")) for p in self.providers
                ]
                if configured and any(value == configured for _, value in provider_options):
                    yield Select(provider_options, id="role-provider", prompt="provider",
                                 value=configured)
                else:
                    yield Select(provider_options, id="role-provider", prompt="provider")
                yield Static("model", classes="field-label")
                yield Select([], id="role-model", prompt="model", allow_blank=True)
                yield Static("reasoning", classes="field-label", id="role-reasoning-label")
                yield Select([], id="role-reasoning", prompt="reasoning effort", allow_blank=True)
                yield Static("", id="role-model-note", markup=True, classes="field-note")
                # Which SUB-AGENT plays the role, shown only for claude-code.
                # The model above stays what it is: which Claude model the CLI
                # asks for.
                yield Static("sub-agent", classes="field-label", id="role-agent-label")
                yield Select(
                    [(f"{a.get('name')} ({a.get('scope')})", a.get("id")) for a in self.agents],
                    id="role-agent",
                    prompt="sub-agent",
                    allow_blank=True,
                )
                yield Static("", id="role-agent-note", markup=True, classes="field-note")
                yield Static("endpoint", classes="field-label", id="role-endpoint-label")
                yield Input(
                    placeholder="endpoint (empty follows the catalog default)",
                    id="role-endpoint",
                    value=str(self.role.get("endpoint") or ""),
                )
                yield Static("", id="role-endpoint-note", markup=True, classes="field-note")
                # SHORT caption, wrapped note on its own line: the one-line
                # checkbox caption overflowed the dialog frame and clipped.
                yield Checkbox("Web search", id="role-tools-web", value=False)
                yield Static("", id="role-tools-note", markup=True, classes="field-note")
                yield Static("API key", classes="field-label", id="role-key-label")
                yield Input(
                    placeholder="paste your API key, or point at one: env:NAME, file:/abs/path",
                    id="role-keyref",
                    value=str(self.role.get("keyRef") or ""),
                )
                # WHAT THIS MACHINE ALREADY HAS: saved key files under the
                # state root and credential-shaped env var NAMES. Picking one
                # fills the field above; pasting still works. Names only,
                # never values.
                yield Select(
                    list(self.key_sources),
                    id="role-key-source",
                    prompt="or pick a key this machine already has",
                    allow_blank=True,
                )
                yield Static("", id="role-key-note", markup=True, classes="field-note")
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
        self._sync_provider_extras(self.role.get("provider"), first=True)
        self._check_key_ref()

    def _sync_provider_extras(self, provider_id: Any, *, first: bool = False) -> None:
        """Endpoint auto-fill, the sub-agent picker, and the tools box.

        The endpoint field FOLLOWS the provider: picking one fills in its
        catalog default so the URL on screen is the URL that will be dialled,
        and the move is said out loud (old to new) rather than happening
        silently under a field the user may have read already. A hand-edited
        endpoint is only ever replaced on an explicit provider change, never
        on open.
        """
        provider = self._provider(provider_id) or {}
        endpoint_field = self.query_one("#role-endpoint", Input)
        endpoint_note = self.query_one("#role-endpoint-note", Static)
        default = provider.get("endpointDefault")
        if first:
            if not endpoint_field.value and default:
                endpoint_field.value = str(default)
            endpoint_note.update(
                "[dim]The catalog default for this provider. Edit to override; "
                "empty follows the default.[/dim]" if default else ""
            )
        else:
            old = endpoint_field.value.strip()
            new = str(default or "")
            endpoint_field.value = new
            if old and old != new:
                # label comes from the engine's catalog and `old` is what the
                # user typed into the field, so neither is ours to parse as
                # markup.
                endpoint_note.update(Content.from_markup(
                    "[yellow]Endpoint moved to the $label "
                    "default[/yellow] [dim](was $old)[/dim]",
                    label=str(provider.get("label", provider_id)),
                    old=old,
                ))
            else:
                endpoint_note.update(
                    Content.from_markup("[dim]$endpoint[/dim]", endpoint=new) if new else ""
                )
        show_endpoint = provider_id != "claude-code"
        endpoint_field.display = show_endpoint
        endpoint_note.display = show_endpoint
        self.query_one("#role-endpoint-label", Static).display = show_endpoint

        agent_select = self.query_one("#role-agent", Select)
        agent_note = self.query_one("#role-agent-note", Static)
        is_agent_provider = provider_id == "claude-code"
        agent_select.display = is_agent_provider
        agent_note.display = is_agent_provider
        self.query_one("#role-agent-label", Static).display = is_agent_provider
        if is_agent_provider:
            configured = self.role.get("agentRef")
            if configured and any(a.get("id") == configured for a in self.agents):
                agent_select.value = configured
            agent_note.update(
                "[dim]Which sub-agent file plays this role, from ~/.claude/agents and "
                "each repo's .claude/agents. The model above is which Claude model the "
                "CLI runs it on.[/dim]"
                if self.agents
                else "[yellow]No sub-agent files found in ~/.claude/agents or any attached "
                "repo's .claude/agents.[/yellow]"
            )

        tools_box = self.query_one("#role-tools-web", Checkbox)
        tools_note = self.query_one("#role-tools-note", Static)
        offered = provider.get("tools") or []
        has_web = any(tool.get("id") == "web_search" for tool in offered)
        tools_box.display = has_web
        tools_note.display = has_web
        if has_web:
            note = next(
                (tool.get("note") for tool in offered if tool.get("id") == "web_search"), None
            )
            # The catalog's own note, written by the engine.
            tools_note.update(
                Content.from_markup("[dim]$note[/dim]", note=str(note)) if note else ""
            )
            tools_box.value = bool(self.role.get("tools")) and "web_search" in (
                self.role.get("tools") or []
            )

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
        if not model_id or model_id is Select.NULL:
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
        note.update(
            Content.from_markup("[dim]$note[/dim]", note=str(model.get("note")))
            if model.get("note") else ""
        )

    def on_select_changed(self, event: Select.Changed) -> None:
        event.stop()
        if event.select.id == "role-provider":
            self._fill_models(event.value)
            self._sync_provider_extras(event.value)
            self._check_key_ref()
        elif event.select.id == "role-model":
            provider = self.query_one("#role-provider", Select).value
            self._fill_reasoning(provider, event.value)
            self._describe_model(provider, event.value)
        elif event.select.id == "role-key-source":
            # Picking a discovered source FILLS THE FIELD rather than saving
            # behind it: the input stays the single truth of what will be
            # stored, so what you read is what you save.
            if event.value is not Select.NULL and event.value:
                self.query_one("#role-keyref", Input).value = str(event.value)
                self._check_key_ref()

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
        if looks_like_pasted_key(value):
            note.update(f"[green]{KEY_PASTE_NOTE}[/green]")
            return
        refusal = key_ref_refusal(value)
        if refusal:
            # The ENGINE's sentence, not one composed here. Two explanations of
            # one rule drift apart, and the drift is invisible until someone
            # reads both. It never quotes the value: the likeliest wrong input
            # at this field is a pasted key, and a warning that echoes it puts
            # it on screen and into any log that captures rendered output.
            note.update(Content.from_markup("[red]$refusal[/red]", refusal=str(refusal)))
            return
        note.update(f"[green]{KEY_REF_OK}[/green]")

    # Result --------------------------------------------------------------

    def _patch(self) -> dict[str, Any]:
        provider = self.query_one("#role-provider", Select).value
        model = self.query_one("#role-model", Select).value
        reasoning = self.query_one("#role-reasoning", Select)
        patch: dict[str, Any] = {"role": self.role.get("role")}
        if provider is not Select.NULL and provider:
            patch["provider"] = provider
        if model is not Select.NULL and model:
            patch["model"] = model
        # Unsupported stays null. Sending a string would encode a setting the
        # model does not have.
        patch["reasoningEffort"] = (
            None
            if reasoning.disabled or reasoning.value is Select.NULL or not reasoning.value
            else reasoning.value
        )
        patch["keyRef"] = self.query_one("#role-keyref", Input).value.strip() or None
        # Stored as NULL when it matches the catalog default, so the role
        # FOLLOWS the catalog if the default ever moves. Only a hand-edited
        # URL is worth pinning.
        endpoint = self.query_one("#role-endpoint", Input).value.strip()
        default = str((self._provider(patch.get("provider")) or {}).get("endpointDefault") or "")
        patch["endpoint"] = endpoint if endpoint and endpoint != default else None
        if patch.get("provider") == "claude-code":
            agent = self.query_one("#role-agent", Select).value
            patch["agentRef"] = None if (agent is Select.NULL or not agent) else agent
            patch["endpoint"] = None
        else:
            patch["agentRef"] = None
        tools_box = self.query_one("#role-tools-web", Checkbox)
        patch["tools"] = ["web_search"] if (tools_box.display and tools_box.value) else None
        return patch

    def action_cancel(self) -> None:
        self.dismiss(None)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        if event.button.id != "role-save":
            self.dismiss(None)
            return
        provider = self._provider(self.query_one("#role-provider", Select).value) or {}
        field = self.query_one("#role-keyref", Input)
        value = field.value.strip()
        if provider.get("keyRequired", True) and value and parse_key_ref(value) is None:
            if looks_like_pasted_key(value):
                # The value IS the key. Store it privately and keep the
                # pointer, so the wire rule holds without the user having to
                # know it. The input shows the pointer afterwards, which is
                # the honest rendering of what was saved.
                field.value = self._store_pasted_key(value)
                self._check_key_ref()
            else:
                # Refuse HERE rather than sending something the engine will
                # reject: the user should learn it while looking at the field.
                self._check_key_ref()
                return
        self.dismiss(self._patch())

    def _store_pasted_key(self, value: str) -> str:
        """Write a pasted key to a private per-role file; return the pointer.

        0700 directory, 0600 file: readable by the owner alone. The file is
        overwritten on re-paste so a rotated key needs no cleanup, and the
        pointer is stable so settings never change shape.
        """
        root = getattr(self.app, "state_root", None)
        keys_dir = (Path(root) if root else Path.home() / ".daijin") / "keys"
        keys_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(keys_dir, 0o700)
        key_file = keys_dir / f"{self.role.get('role', 'role')}.key"
        key_file.write_text(value + "\n", encoding="utf-8")
        os.chmod(key_file, 0o600)
        return f"file:{key_file}"
