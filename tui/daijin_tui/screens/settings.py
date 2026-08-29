"""Settings. Four model roles, their verification pings, and the instruction files.

rolePing is a real provider generation. It fires on a button and a confirmation
and on nothing else: not on mount, not on a reload, not on a settings edit. The
screen therefore opens showing the LAST recorded ping, clearly labelled as
recorded rather than current, which is the honest thing to show when the only
way to know is to spend.
"""

from __future__ import annotations

from typing import Any, Iterable

from textual import work
from textual.containers import Horizontal
from textual.content import Content
from textual.widgets import Button, Checkbox, DataTable, Static

from ..concurrency import gather_iter
from ..rpc import RpcError
from ..widgets import Banner, SectionTitle, cells
from .base import DaijinScreen
from .dialogs import AgentFileEditScreen
from .role_dialog import RoleConfigScreen

# `preset` was removed from the role row (D-0037): it was declared by the
# engine, written by nothing, and rendered here from mock data only, so
# against a real engine this column was ALWAYS BLANK. `provider` replaces it,
# and a name like "Claude" is a rendering of provider plus model rather than a
# stored value. `model?` carries modelKnown, which is true, false, or null for
# unconfigured, the same three states as keyResolvable.
ROLE_COLUMNS = (
    "role", "provider", "model", "model?", "reasoning",
    "endpoint", "HTTP", "TTFT", "latency", "served model id", "verified",
)

# modelKnown is three-valued and null is NOT false: unconfigured is not the
# same claim as "the catalog does not recognise this".
MODEL_KNOWN = {True: "known", False: "unrecognised", None: "not set"}


def _said(value: Any, absent: str = "not set") -> str:
    """Render a null as a stated absence rather than the word None.

    Found by an AGED STATE ROOT, not by any test: a settings.json written
    before provider existed comes back with provider and endpoint null, and
    .get(key, "") does not help when the key is present and the VALUE is null.
    Every fixture in this suite is young, and a machine with history is the one
    a long-time user actually has.
    """
    if value is None or value == "":
        return absent
    return str(value)
FILE_COLUMNS = ("agent file", "current hash", "default hash", "badge")

# Plain words: what each role does for the user, not how the design justifies it.
ROLE_NOTES = {
    "engineer": "the student: attempts the exams. Also embeds brain narration.",
    "teacher": "grades each attempt against five criteria, with citations",
    "auditor": "mines exams from your history and advises on findings",
    "watcher": "keeps an eye on runs and verifies findings cheaply",
}
AGENT_ROLES = ("student", "teacher", "auditor", "watcher")


class SettingsScreen(DaijinScreen):
    mode_name = "settings"
    notice_id = "#settings-notice"
    heading = "Settings"
    subheading = "models for each role, instruction files, spending, retrieval"

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.settings: dict[str, Any] = {}
        self.agent_files: dict[str, dict[str, Any]] = {}

    def content(self) -> Iterable[Any]:
        yield Banner("", tone="info", id="settings-notice")
        yield SectionTitle("Model roles", "a ping is a paid generation, so it only runs when you ask")
        yield DataTable(id="role-table", cursor_type="row")
        yield Static("", id="role-detail", markup=True)
        with Horizontal(id="role-actions"):
            yield Button("Configure selected role", id="role-configure", variant="primary")
            yield Button("Verify selected role (spends)", id="role-verify", variant="warning")
            yield Button("Reset endpoints to defaults", id="role-reset-endpoints")
        yield SectionTitle("Instruction files", ".daijin/agents, shipped defaults, user editable")
        yield DataTable(id="file-table", cursor_type="row")
        yield Static("", id="file-detail", markup=True)
        with Horizontal(id="file-actions"):
            yield Button("Edit selected file", id="file-edit", variant="primary")
        yield SectionTitle("Spending", "paid model calls always show a confirmation; this controls the extra unlock step")
        yield Checkbox(
            "Unlock spending automatically when I start a paid run",
            id="spend-auto-unlock",
        )
        yield Static(
            "[dim]Off: starting a paid run first asks you to unlock spending, then to "
            "confirm the run. On: runs you start unlock spending by themselves; you "
            "still confirm each run, and spending locks itself again when the run "
            "ends.[/dim]",
            id="spend-auto-note",
            markup=True,
            classes="field-note",
        )
        yield SectionTitle("Retrieval and storage")
        yield Static("", id="config-summary", markup=True)

    async def load(self) -> None:
        role_table = self.query_one("#role-table", DataTable)
        if not role_table.columns:
            role_table.add_columns(*ROLE_COLUMNS)
        file_table = self.query_one("#file-table", DataTable)
        if not file_table.columns:
            file_table.add_columns(*FILE_COLUMNS)
        try:
            self.settings = await self.client.call("settingsGet", {})
        except RpcError as error:
            self.show_rpc_error(error, "#settings-notice")
            return
        # agentFileGet is zero-spend, so reading all four on open is fine, and
        # the four files have nothing to do with each other, so reading them
        # one after another only spent the user's time.
        await gather_iter(self._load_agent_file(role) for role in AGENT_ROLES)
        # The standing spending instruction is stored settings; the checkbox
        # reflects it without firing its Changed handler as a user act.
        box = self.query_one("#spend-auto-unlock", Checkbox)
        with box.prevent(Checkbox.Changed):
            box.value = bool((self.settings.get("spend") or {}).get("autoUnlockReason"))
        self._update_view()

    async def on_checkbox_changed(self, event: Checkbox.Changed) -> None:
        if event.checkbox.id != "spend-auto-unlock":
            return
        event.stop()
        # The standing instruction is WRITTEN, with a reason, or cleared. Writing
        # it is the owner's explicit act; the engine still re-blocks the gate
        # after every run and every paid run still shows its confirmation.
        reason = (
            "Standing instruction from Settings: runs the owner starts unlock "
            "spending without the extra dialog."
        ) if event.value else None
        try:
            await self.client.call("settingsSet", {"patch": {"spend": {"autoUnlockReason": reason}}})
            self.settings.setdefault("spend", {})["autoUnlockReason"] = reason
        except RpcError as error:
            self.show_rpc_error(error, "#settings-notice")
            with event.checkbox.prevent(Checkbox.Changed):
                event.checkbox.value = not event.value

    async def _load_agent_file(self, role: str) -> None:
        try:
            self.agent_files[role] = await self.client.call("agentFileGet", {"role": role})
        except RpcError:
            return

    def _update_view(self) -> None:
        roles = self.settings.get("roles", [])
        table = self.query_one("#role-table", DataTable)
        table.clear()
        never_verified = []
        failing = []
        drift = []
        for role in roles:
            ping = role.get("ping") or {}
            verified = bool(ping)
            # `ok` is the record's own verdict (v5 stored shape). httpStatus
            # is a fallback for a record written before ok existed, and CANNOT
            # replace it: a claude-code ping has no HTTP at all, so status
            # alone would render every successful CLI ping as FAILED.
            ok = verified and bool(ping.get("ok", ping.get("httpStatus") == 200))
            if not verified:
                never_verified.append(role.get("role"))
            elif not ok:
                failing.append(role.get("role"))
            elif ping.get("servedModelId") and ping.get("servedModelId") != role.get("model"):
                drift.append(role.get("role"))
            table.add_row(*cells(
                role.get("role", ""),
                _said(role.get("provider")),
                _said(role.get("model")),
                MODEL_KNOWN.get(role.get("modelKnown"), "not set"),
                # null reasoningEffort means the MODEL has no such control,
                # which is only sayable once a model is configured. On a role
                # that was never set up it means nothing is set, and claiming
                # "not supported" there is a statement about a model nobody
                # chose.
                (
                    "not supported"
                    if role.get("model")
                    else "not set"
                ) if not role.get("reasoningEffort") else str(role.get("reasoningEffort")),
                _said(role.get("endpoint")),
                str(ping.get("httpStatus", "-")),
                f"{ping.get('ttftMs')} ms" if ping.get("ttftMs") else "-",
                f"{ping.get('latencyMs')} ms" if ping.get("latencyMs") else "-",
                str(ping.get("servedModelId") or "-"),
                "never" if not verified else ("ok" if ok else "FAILED"),
            ), key=role.get("role"))
        notice = self.query_one("#settings-notice", Banner)
        if failing:
            notice.set_notice(
                f"Last ping failed for: {', '.join(str(name) for name in failing)}. "
                f"That role is not ready. Layer 1 only mode still works with zero keys.",
                "warn",
            )
        elif never_verified:
            notice.set_notice(
                f"Never verified: {', '.join(str(name) for name in never_verified)}. "
                f"Verification is a paid call, so it is not run for you.",
                "warn",
            )
        elif drift:
            notice.set_notice(
                f"Served model id differs from the requested model on: {', '.join(str(d) for d in drift)}.",
                "warn",
            )
        else:
            notice.set_notice("All four roles verified, served ids match.", "info")
        if roles:
            self._show_role(roles[0])

        file_table = self.query_one("#file-table", DataTable)
        file_table.clear()
        for role in AGENT_ROLES:
            record = self.agent_files.get(role)
            if record is None:
                continue
            file_table.add_row(*cells(
                role,
                record.get("currentHash", ""),
                record.get("defaultHash", ""),
                "MODIFIED" if record.get("modified") else "default",
            ), key=role)
        if self.agent_files:
            self._show_file(next(iter(self.agent_files)))

        retrieval = self.settings.get("retrieval", {})
        storage = self.settings.get("storage", {})
        budget = retrieval.get("tokenBudget", 0)
        self.query_one("#config-summary", Static).update(
            f"token budget [b]{budget}[/b], k {retrieval.get('k')}, RRF_K {retrieval.get('rrfK')}, "
            f"per candidate cap {retrieval.get('perCandidateCapRatio')}, slot floor {retrieval.get('slotFloor')}, "
            f"standing outside budget {retrieval.get('standingOutsideBudget')}\n"
            f"[dim]the initial context rides in every round: {budget} x 44 rounds is about "
            f"{budget * 44:,} tokens per exam[/dim]\n"
            f"store {storage.get('driver')}, embedder {storage.get('embedder')}, dimension {storage.get('dimension')}"
        )

    def _show_role(self, role: dict[str, Any]) -> None:
        ping = role.get("ping") or {}
        name = str(role.get("role", ""))
        # keyRef is a POINTER THE OWNER TYPES - a file path or an env var
        # name - so it is their text, not ours, and a bracketed path in it is
        # a MarkupError on a row highlight.
        lines: list[Any] = [
            Content.from_markup(
                "[b]$name[/b]  $note", name=name, note=str(ROLE_NOTES.get(name, ""))
            ),
            Content.from_markup(
                "key $ref, masked $masked",
                ref=str(role.get("keyRef", "?")),
                masked=str(role.get("keyMasked", "?")),
            ),
        ]
        if not ping:
            lines.append(
                "[yellow]never verified.[/yellow] Verifying calls the provider and costs money, "
                "so nothing is pinged until you ask for it."
            )
        else:
            lines.append(
                f"last recorded ping {ping.get('at', '-')}, HTTP {ping.get('httpStatus', '-')}, "
                f"TTFT {ping.get('ttftMs', '-')} ms, latency {ping.get('latencyMs', '-')} ms"
            )
            # Both ids come back from the provider's own response.
            lines.append(Content.from_markup(
                "served model id [b]$served[/b] against requested $requested",
                served=str(ping.get("servedModelId") or "none"),
                requested=str(role.get("model")),
            ))
            if ping.get("servedModelId") and ping.get("servedModelId") != role.get("model"):
                lines.append(
                    "[yellow]The served id is not the requested id. The served id is the "
                    "authoritative one.[/yellow]"
                )
            lines.append("[dim]recorded at that time, not a live reading[/dim]")
        self.query_one("#role-detail", Static).update(Content("\n").join(
            line if isinstance(line, Content) else Content.from_markup(line) for line in lines
        ))

    def _show_file(self, role: str) -> None:
        record = self.agent_files.get(role) or {}
        badge = "MODIFIED from the shipped default" if record.get("modified") else "matches the shipped default"
        # content is the WHOLE instruction file, markdown the owner edits. A
        # "[/...]" token anywhere in it - and these files are prose about this
        # tool, which renders markup - is a closing tag with nothing open, and
        # that MarkupError kills the app on a row highlight.
        self.query_one("#file-detail", Static).update(Content.from_markup(
            "[b].daijin/agents/$role.md[/b]  $badge\n"
            "[dim]current $current, default $default[/dim]\n"
            "$content",
            role=str(role),
            badge=badge,
            current=str(record.get("currentHash", "?")),
            default=str(record.get("defaultHash", "?")),
            content=str(record.get("content", "")),
        ))

    def _selected_key(self, table_id: str) -> str | None:
        table = self.query_one(f"#{table_id}", DataTable)
        if not table.row_count:
            return None
        try:
            return table.coordinate_to_cell_key(table.cursor_coordinate).row_key.value
        except Exception:
            return None

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        key = event.row_key.value if event.row_key else None
        if event.data_table.id == "role-table":
            for role in self.settings.get("roles", []):
                if role.get("role") == key:
                    self._show_role(role)
                    return
        elif event.data_table.id == "file-table" and key:
            self._show_file(str(key))

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        if event.button.id == "role-configure":
            self.configure_selected_role()
        elif event.button.id == "role-verify":
            self.verify_selected_role()
        elif event.button.id == "role-reset-endpoints":
            self.reset_endpoints()
        elif event.button.id == "file-edit":
            self.edit_selected_file()

    @work
    async def verify_selected_role(self) -> None:
        role_name = self._selected_key("role-table")
        notice = self.query_one("#settings-notice", Banner)
        if not role_name:
            notice.set_notice("Select a role row first.", "warn")
            return
        role = next((r for r in self.settings.get("roles", []) if r.get("role") == role_name), {})
        confirmed = await self.confirm_spend(
            method="rolePing",
            summary=(
                f"Verifying the {role_name} role sends one real generation to "
                f"{role.get('endpoint', 'its endpoint')} using {role.get('keyRef', 'its key')}. "
                f"That is the only way to learn the served model id, because the catalogue "
                f"endpoint is not authoritative."
            ),
            estimate_lines=["one short generation on the configured model"],
            confirm_label=f"Ping {role_name} and spend",
        )
        if not confirmed:
            notice.set_notice("Not verified. Nothing was sent to a provider.", "info")
            return
        try:
            ping = await self.client.call("rolePing", {"role": role_name, "confirm": True})
        except RpcError as error:
            self.report_rpc_error(error)
            notice.set_notice(error.hint, "error")
            return
        try:
            self.settings = await self.client.call("settingsGet", {})
        except RpcError as error:
            self.report_rpc_error(error)
            return
        self._update_view()
        if ping.get("ok", ping.get("httpStatus") == 200):
            transport = (
                f"HTTP {ping.get('httpStatus')}" if ping.get("httpStatus") is not None
                else "the claude CLI"
            )
            ttft = f", TTFT {ping.get('ttftMs')} ms" if ping.get("ttftMs") is not None else ""
            notice.set_notice(
                f"{role_name} answered via {transport}, served id "
                f"{ping.get('servedModelId')}{ttft}.",
                "info",
            )
        else:
            detail = ping.get("hint") or (
                f"HTTP {ping.get('httpStatus')}" if ping.get("httpStatus") is not None
                else "no answer"
            )
            notice.set_notice(
                f"{role_name} failed: {detail} The call completed and was billed; "
                f"the role is not ready. Retry without editing settings.",
                "warn",
            )

    @work
    async def reset_endpoints(self) -> None:
        """Every role's endpoint back to the catalog default.

        Encoded as NULL, not as a copied URL: a null endpoint means "use the
        catalog default", so it keeps tracking the catalog if the default
        moves, where a copied URL would freeze today's default forever.
        """
        notice = self.query_one("#settings-notice", Banner)
        roles = self.settings.get("roles") or []
        patch = [{"role": r.get("role"), "endpoint": None} for r in roles if r.get("role")]
        if not patch:
            notice.set_notice("No roles loaded yet.", "warn")
            return
        try:
            await self.client.call("settingsSet", {"patch": {"roles": patch}})
        except RpcError as error:
            self.report_rpc_error(error)
            notice.set_notice(error.hint, "error")
            return
        self.set_pending_notice(
            "Endpoints reset. Each role now follows its provider's catalog default."
        )
        self.start_load()

    @work
    async def configure_selected_role(self) -> None:
        """Provider, model, reasoning and the key POINTER, for one role."""
        role_name = self._selected_key("role-table")
        notice = self.query_one("#settings-notice", Banner)
        if not role_name:
            notice.set_notice("Select a role row first.", "warn")
            return
        role = next(
            (r for r in (self.settings.get("roles") or []) if r.get("role") == role_name), None
        )
        if role is None:
            notice.set_notice(f"{role_name} is not in the settings this screen loaded.", "warn")
            return
        try:
            catalog = await self.client.call("providerCatalog", {})
        except RpcError as error:
            # Without the catalog the dialog would have to invent a provider
            # list, which is the hand-copied vocabulary this method exists to
            # avoid. Better to say why than to guess.
            self.report_rpc_error(error)
            notice.set_notice(
                f"Cannot configure a role without the provider catalog: {error.hint}", "error"
            )
            return
        # Zero-spend, so fetched on open; without it the claude-code provider
        # would offer an empty sub-agent list and read as broken. Its absence
        # (an old daemon) degrades to that empty list rather than blocking the
        # dialog, because every other provider works without it.
        try:
            agents = (await self.client.call("agentCatalog", {})).get("agents") or []
        except RpcError:
            agents = []
        patch = await self.app.push_screen_wait(
            RoleConfigScreen(role=role, catalog=catalog, agents=agents)
        )
        if patch is None:
            return
        try:
            await self.client.call("settingsSet", {"patch": {"roles": [patch]}})
        except RpcError as error:
            self.report_rpc_error(error)
            notice.set_notice(error.hint, "error")
            return
        saved_key = ""
        key_ref = str(patch.get("keyRef") or "")
        # A pasted key was just written to a private file; SAY WHERE, in the
        # notice that survives the reload. The owner watched their pasted key
        # "turn into" a file pointer with no explanation of where it went.
        if key_ref.startswith("file:") and "/keys/" in key_ref:
            saved_key = (
                f" Your pasted key is stored at {key_ref[5:]} (readable only by you); "
                f"the settings keep the pointer, never the key. Paste a new key any "
                f"time to replace it."
            )
        self.set_pending_notice(
            f"{role_name} set to {patch.get('provider')} {patch.get('model')}."
            f"{saved_key} Verify it with a ping before trusting it."
        )
        self.start_load()

    @work
    async def edit_selected_file(self) -> None:
        role = self._selected_key("file-table")
        notice = self.query_one("#settings-notice", Banner)
        if not role:
            notice.set_notice("Select an instruction file row first.", "warn")
            return
        record = self.agent_files.get(role) or {}
        content = await self.app.push_screen_wait(
            AgentFileEditScreen(role=str(role), content=str(record.get("content", "")))
        )
        if content is None:
            return
        try:
            updated = await self.client.call("agentFileSet", {"role": role, "content": content})
        except RpcError as error:
            self.report_rpc_error(error)
            return
        self.agent_files[str(role)] = updated
        self._update_view()
        self._show_file(str(role))
        notice.set_notice(
            f".daijin/agents/{role}.md saved, "
            f"{'now modified from the default' if updated.get('modified') else 'back to the shipped default'}.",
            "info",
        )
