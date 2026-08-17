"""Init activity feed. Claude Code style, never a frozen wait."""

from __future__ import annotations

from typing import Any, Iterable

from textual import work
from textual.containers import Horizontal
from textual.widgets import Button, Input, Select, Static

from .. import mock_data
from ..rpc import RpcError
from ..stream import FLUSH_INTERVAL, StreamCoalescer
from ..widgets.activity import IDLE_UNTIL_INFERRED, TERMINAL_PHASES
from ..widgets import Banner, EventLog, Gauge, PhaseChecklist, SectionTitle
from .base import DaijinScreen
from .dialogs import budget_estimate_lines

MODE_OPTIONS = [
    ("Ingest the existing agent folder as is", "ingest"),
    ("Layer 1 only, deterministic, no key, no spend", "layer1"),
    ("Layer 1 then Layer 2 narration, SPENDS on the engineer key", "layer1+layer2"),
]


class InitFeedScreen(DaijinScreen):
    mode_name = "init"
    notice_id = "#init-notice"
    heading = "Initialize brain"
    subheading = "phase checklist and the raw step-event stream"

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.job_id: str | None = None
        self._subscribed = False
        self.coalescer = StreamCoalescer(self._render_events)

    def content(self) -> Iterable[Any]:
        yield Banner("Pick a repo on the repo home, then start.", tone="info", id="init-notice")
        with Horizontal(id="init-controls"):
            yield Select(MODE_OPTIONS, value="layer1", id="init-mode", allow_blank=False)
            yield Button("Start init", id="init-start", variant="primary")
            yield Button("Cancel job", id="init-cancel")
            yield Button("Clear", id="init-clear")
        with Horizontal(id="init-scope-row"):
            yield Static("Layer 2 scope", classes="kv-label")
            yield Input(
                placeholder="optional, comma separated areas, used by the sub-75 path",
                id="init-scope",
            )
        # A block is the outcome the field test hit, and it used to be one
        # line in a scrolling log. It gets its own panel, above the stream.
        yield Static("", id="init-blocked", markup=True)
        yield Button(
            "Attach the repository root instead", id="init-attach-root"
        )
        yield SectionTitle("Phases")
        # Semantic, not decorative: during a long init the thing a watcher is
        # tracking is how far through the pipeline the run is, so the bar moves
        # toward it rather than jumping. It is also the only stream-driven
        # animation reachable at zero spend, the gym gauge being behind the gate.
        yield Gauge(caption="waiting for the first phase", id="init-progress")
        # Seeded only against the mock. The real engine's pipeline is its own, and
        # a guessed manifest renders phases the engine never ran.
        yield PhaseChecklist(
            mock_data.INIT_PHASES if getattr(self.app, "is_mock", False) else [],
            id="init-checklist",
        )
        yield SectionTitle("Step events", "the same jsonl stream the gym and gates views read")
        yield EventLog(id="init-events")

    def on_mount(self) -> None:
        # Hidden until something blocks: an empty panel and a dead button above
        # the stream would be two rows of nothing on every run that succeeds.
        self.call_after_refresh(self._hide_block)

    def _hide_block(self) -> None:
        try:
            self.query_one("#init-blocked", Static).display = False
            self.query_one("#init-attach-root", Button).display = False
        except Exception:  # noqa: BLE001 - before compose has mounted them
            pass

    async def load(self) -> None:
        self._subscribe()
        self.refresh_heading()
        notice = self.query_one("#init-notice", Banner)
        if not getattr(self.app, "selected_repo", None):
            notice.set_notice("No repo selected. Press 1 for the repo home and pick one.", "warn")
        else:
            notice.set_notice(f"Ready to initialize {self.app.selected_repo}.", "info")

    def _subscribe(self) -> None:
        if not self._subscribed:
            self.client.on_event(self._on_step_event)
            # Drains whatever the last burst left buffered. Without it the tail
            # of a stream waits for an event that never comes.
            self.set_interval(FLUSH_INTERVAL, self.coalescer.flush)
            self.set_interval(1.0, self._check_idle)
            self._subscribed = True

    def on_unmount(self) -> None:
        if self._subscribed:
            self.client.off_event(self._on_step_event)
            self._subscribed = False

    def _on_step_event(self, event: dict[str, Any]) -> None:
        if not self.is_mounted:
            return
        if not self.accepts_step_event(event):
            return
        self.coalescer.push(event)

    def _update_progress(self, checklist: PhaseChecklist) -> None:
        """Fill toward the share of phases the engine has reported finishing.

        The denominator is what the engine has SHOWN so far, not a guessed
        pipeline length, so the bar never implies knowledge of how much is left.
        """
        done = sum(
            1 for key in checklist.order if checklist.state[key]["status"] in ("done", "warn")
        )
        seen = sum(
            1 for key in checklist.order if checklist.state[key]["status"] != "pending"
        )
        if not seen:
            return
        gauge = self.query_one("#init-progress", Gauge)
        gauge.set_value(
            done / seen,
            motion=getattr(self.app, "motion", None),
            caption=f"{done} of {seen} reported phases complete",
        )

    def _check_idle(self) -> None:
        """The stream has no terminal event, so a quiet run has to be inferred."""
        if not self.is_mounted:
            return
        checklist = self.query_one('#init-checklist', PhaseChecklist)
        if checklist.infer_finish_if_idle():
            for widget in self.query("#init-notice"):
                widget.set_notice(
                    f"No step events for {IDLE_UNTIL_INFERRED:.0f}s, so this run is "
                    f"treated as finished. The stream carries no terminal event, so "
                    f"that is inferred, not reported by the engine.",
                    "warn",
                )

    # The closed set from the contract. Switching on the CODE is required
    # rather than preferred: the prose is written for a person and must stay
    # free to be reworded without unwiring a button.
    BLOCK_ACTIONS = {
        "too-little-material": "Attach the repository root instead",
        "gold-set-too-thin": None,
    }

    def _render_block(self, event: dict[str, Any]) -> None:
        """Surface a blocked phase where the user is looking.

        MEASURED 2026-08-17: the blocked step event carries
        {ts, jobId, phase, step, detail, level} and NO actionCode. The field
        exists on initBrain's report, which no method returns and which is not
        written under the state root, so there is no path by which a client
        receives it today. Reported to the extractor.

        So the prose is shown, because it is real and it is what the engine
        said, and the ACTION BUTTON stays hidden until a code arrives. A button
        wired to the prose would be the thing the contract explicitly forbids,
        and a button shown with no code behind it would be the inert control
        this project has already fixed twice.
        """
        panel = self.query_one("#init-blocked", Static)
        button = self.query_one("#init-attach-root", Button)
        detail = str(event.get("detail") or "").strip()
        code = event.get("actionCode")
        panel.display = True
        panel.update(
            f"[b][yellow]{event.get('phase', 'a phase')} blocked.[/yellow][/b]\n{detail}"
        )
        label = self.BLOCK_ACTIONS.get(str(code)) if code else None
        button.display = bool(label)
        if label:
            button.label = label

    def _render_events(self, batch: list[dict[str, Any]]) -> None:
        """Render a batch. A burst costs one repaint, not one per event."""
        checklist = self.query_one("#init-checklist", PhaseChecklist)
        log = self.query_one("#init-events", EventLog)
        checklist.apply_events(batch)
        for event in batch:
            log.append_event(event)
        self._update_progress(checklist)
        blocked = next((e for e in batch if e.get("step") == "blocked"), None)
        if blocked is not None:
            self._render_block(blocked)
        # TERMINAL_PHASES, not a literal. The wire sends exactly one phase
        # here and this constant names it, so the value is not the point: the
        # SHARED SOURCE is. A literal at three call sites is how two of them
        # came to miss the terminal event entirely while the third handled it.
        done = next((e for e in batch if e.get("phase") in TERMINAL_PHASES), None)
        if done is not None:
            # A run that BROKE used to reach this banner and say "Init
            # complete", because the only branch was on step == cancelled. The
            # phase says it ended; level says how, and a failed init has to say
            # so where the user is looking rather than only as a red line in a
            # feed they may have scrolled past.
            level = str(done.get("level") or "info")
            repo = getattr(self.app, "selected_repo", "")
            if level == "error":
                detail = str(done.get("detail") or done.get("message") or "").strip()
                message = (
                    f"Init FAILED for {repo} after {checklist.elapsed:.1f}s, job {self.job_id}. "
                    f"There is no brain to use. {detail}".strip()
                )
            elif level == "warn":
                message = f"Init cancelled after {checklist.elapsed:.1f}s, job {self.job_id}."
            else:
                message = (
                    f"Init complete for {repo} in {checklist.elapsed:.1f}s, job {self.job_id}."
                )
            self.query_one("#init-notice", Banner).set_notice(
                message,
                {"error": "error", "warn": "warn"}.get(level, "info"),
            )

    async def _attach_root(self) -> None:
        """Hand the user back to the home screen with the root to attach.

        The root comes from repoAttach's warning, which the home screen already
        holds, so this does not re-derive a path the engine worked out.
        """
        self.app.switch_mode("home")

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "init-attach-root":
            event.stop()
            await self._attach_root()
        elif event.button.id == "init-start":
            event.stop()
            self.start_init()
        elif event.button.id == "init-cancel":
            event.stop()
            await self.cancel_init()
        elif event.button.id == "init-clear":
            event.stop()
            self.job_id = None
            self.query_one("#init-checklist", PhaseChecklist).reset()
            self.query_one("#init-events", EventLog).clear()

    def _scope(self) -> dict[str, Any] | None:
        raw = self.query_one("#init-scope", Input).value.strip()
        if not raw:
            return None
        areas = [part.strip() for part in raw.split(",") if part.strip()]
        return {"areas": areas} if areas else None

    async def _budget_estimate(
        self, repo: str, mode: str, scope: dict[str, Any] | None
    ) -> dict[str, Any] | None:
        """Zero-spend estimate for the confirmation dialog."""
        params: dict[str, Any] = {"repoPath": repo, "mode": mode}
        if scope:
            params["scope"] = scope
        try:
            return await self.client.call("budgetEstimate", params)
        except RpcError as error:
            self.report_rpc_error(error)
            return None

    @work
    async def start_init(self) -> None:
        repo = getattr(self.app, "selected_repo", None)
        notice = self.query_one("#init-notice", Banner)
        if not repo:
            notice.set_notice("No repo selected. Press 1 for the repo home and pick one.", "warn")
            return
        mode = self.query_one("#init-mode", Select).value
        params: dict[str, Any] = {"repoPath": repo, "mode": mode}
        scope = self._scope()
        if scope:
            params["scope"] = scope

        if mode == "layer1+layer2":
            # Spend-touching. The estimate is displayed and confirmed on this
            # call, or the call is not made at all.
            estimate = await self._budget_estimate(repo, "layer1+layer2", scope)
            scope_note = (
                f"Scoped to {', '.join(scope['areas'])}." if scope else "No scope set, the whole repo is narrated."
            )
            confirmed = await self.confirm_spend(
                method="initBrain, mode layer1+layer2",
                summary=(
                    f"Layer 2 narrates prose over the evidence tables for {repo} using your "
                    f"engineer key. Layer 1 has already run without spending. {scope_note}"
                ),
                estimate_lines=list(budget_estimate_lines(estimate)),
                confirm_label="Run Layer 2 and spend",
            )
            if not confirmed:
                notice.set_notice("Layer 2 not started. Nothing was sent to a provider.", "info")
                return
            params["confirm"] = True
            params["budget"] = estimate

        try:
            result = await self.client.call("initBrain", params)
        except RpcError as error:
            self.report_rpc_error(error)
            notice.set_notice(error.hint, "error")
            return
        self.job_id = result.get("jobId")
        self.query_one("#init-checklist", PhaseChecklist).reset(self.job_id)
        self.query_one("#init-events", EventLog).clear()
        notice.set_notice(f"Init running for {repo}, job {self.job_id}, mode {mode}.", "info")

    async def cancel_init(self) -> None:
        notice = self.query_one("#init-notice", Banner)
        if not self.job_id:
            notice.set_notice("No init job is running.", "warn")
            return
        try:
            result = await self.client.call("jobCancel", {"jobId": self.job_id})
        except RpcError as error:
            self.report_rpc_error(error)
            return
        if result.get("cancelled"):
            notice.set_notice(f"Cancel requested for job {self.job_id}.", "warn")
        else:
            notice.set_notice(f"Job {self.job_id} had already finished.", "info")
