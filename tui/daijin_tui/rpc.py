"""JSON-RPC 2.0 client for the Daijin engine, plus a bundled mock engine.

Wire format follows engine/src/rpc/methods.md v3: JSON-RPC 2.0 over stdio using
the MCP stdio framing, which is one JSON object per line, UTF-8, newline
terminated.

Two server initiated notification channels:

- `step`, the jsonl step event, job scoped, powering the init feed, the gym
  live view, and gates discovery.
- `boardFinding`, NOT job scoped, arriving with no job running. Severity
  critical is surfaced immediately by the app, not by whichever screen happens
  to be open.

The contract names the boardFinding payload but not the step notification
method name, so this client uses "step" and accepts a small set of aliases.

Spend discipline. The contract enumerates the spend-touching methods
exhaustively: gymStart, rolePing, initBrain with mode layer1+layer2, and
diagnoseNarrate. Everything else is zero-spend by construction. This module
carries that list as SPEND_TOUCHING and the mock refuses an unconfirmed call
with -32050, so every refusal path is reachable in the shell. Nothing here
reaches the network.
"""

from __future__ import annotations

import asyncio
import copy
import re
import inspect
import json
import sys
import time
from collections import deque
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, Sequence

from . import mock_data

CLIENT_VERSION = "0.1.0"
# Two limits, because the two risks are different.
#
# MAX_IN_FLIGHT is a runaway backstop, NOT a throughput limit. The extractor
# measured the real socket daemon: three clients issuing nine concurrent calls
# each, 27 in flight, cost 37ms total, and three concurrent analyze calls cost
# the same wall clock as one, because they are filesystem bound and overlap.
# So breadth is not the risk and a tight cap would only slow the client down.
MAX_IN_FLIGHT = 32

# EMBEDDING_BOUND is the limit that matters. These methods queue behind ONE
# local Ollama, so firing several at once does not overlap: it contends. The
# repo home asks for a retrievalScore per repo, and the brain screen wants a
# retrievalScore and a diagnose together, which is exactly the case the
# extractor flagged as worth serialising client-side. Serialising here rather
# than in each screen keeps it true no matter who calls.
EMBEDDING_BOUND = frozenset({"search", "retrievalScore", "diagnose"})
MAX_EMBEDDING_IN_FLIGHT = 1
# How much of a failing engine's stderr to carry into the error we raise.
STDERR_TAIL_LINES = 20
# The contract version this client is built against. A mismatch is an upgrade
# screen, not a method error.
SUPPORTED_CONTRACT_VERSION = "5"

# Notification method the engine uses to push one jsonl step event.
EVENT_METHOD = "step"
EVENT_METHOD_ALIASES = frozenset({"step", "event", "stepEvent", "notifications/step"})
# Board findings ride their own channel because they are not job scoped.
BOARD_FINDING_METHOD = "boardFinding"
BOARD_FINDING_ALIASES = frozenset({"boardFinding", "notifications/boardFinding"})

# Error codes. -32050 is fixed by the contract; the rest follow JSON-RPC.
ERR_INVALID_REQUEST = -32600
ERR_METHOD_NOT_FOUND = -32601
ERR_INVALID_PARAMS = -32602
ERR_INTERNAL = -32603
ERR_SPEND_GATE = -32050
# A method that IS in the contract but whose engine capability has not shipped
# yet. Distinct from -32601, which for a frozen surface should never happen and
# means the method is not in the contract at all. Carries data.phase.
ERR_NOT_IMPLEMENTED = -32001

# Exhaustive per the error convention. Adding to this set is a contract change,
# not an implementation detail. Since v5 EVERY member requires confirm: true in
# its params; the engine never infers consent, not even from an open gate.
SPEND_TOUCHING = frozenset({"gymStart", "rolePing", "initBrain:layer1+layer2", "diagnoseNarrate"})

# documents filter keys, fixed by v5.
DOCUMENT_FILTER_KEYS = frozenset({"q", "type", "area"})

EventHandler = Callable[[dict[str, Any]], None]


def is_spend_touching(method: str, params: dict[str, Any] | None = None) -> bool:
    """True when this exact call spends. initBrain only spends on layer1+layer2."""
    if method == "initBrain":
        return f"initBrain:{(params or {}).get('mode')}" in SPEND_TOUCHING
    return method in SPEND_TOUCHING


class RpcError(Exception):
    """A JSON-RPC error response.

    data.hint is written by the engine for the TUI to display verbatim, so
    screens show self.hint and never a paraphrase of it.
    """

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.data = data if isinstance(data, dict) else {}

    @property
    def hint(self) -> str:
        return str(self.data.get("hint") or self.message)

    @property
    def gate(self) -> str | None:
        gate = self.data.get("gate")
        return str(gate) if gate else None

    @property
    def is_spend_gate(self) -> bool:
        return self.code == ERR_SPEND_GATE

    @property
    def is_not_implemented(self) -> bool:
        """A contract method whose engine capability ships in a later phase."""
        return self.code == ERR_NOT_IMPLEMENTED

    @property
    def phase(self) -> str | None:
        """Which build phase ships this capability, when the engine says."""
        phase = self.data.get("phase")
        return str(phase) if phase else None


class RpcClient:
    """Base client. Subclasses provide a transport."""

    def __init__(self) -> None:
        self._handlers: list[EventHandler] = []
        self._finding_handlers: list[EventHandler] = []
        self._next_id = 0
        self.contract_version: str | None = None
        self.engine_version: str | None = None
        self._inflight = asyncio.Semaphore(MAX_IN_FLIGHT)
        self._embedding_inflight = asyncio.Semaphore(MAX_EMBEDDING_IN_FLIGHT)
        self._current_in_flight = 0
        self._current_embedding_in_flight = 0
        # Observability for both limits: tests assert these bind, so the limits
        # are measured properties rather than comments.
        self.peak_in_flight = 0
        self.peak_embedding_in_flight = 0

    # Event fan out ------------------------------------------------------

    def on_event(self, handler: EventHandler) -> EventHandler:
        self._handlers.append(handler)
        return handler

    def off_event(self, handler: EventHandler) -> None:
        if handler in self._handlers:
            self._handlers.remove(handler)

    def on_board_finding(self, handler: EventHandler) -> EventHandler:
        self._finding_handlers.append(handler)
        return handler

    def off_board_finding(self, handler: EventHandler) -> None:
        if handler in self._finding_handlers:
            self._finding_handlers.remove(handler)

    def dispatch_event(self, payload: dict[str, Any]) -> None:
        for handler in list(self._handlers):
            handler(payload)

    def dispatch_board_finding(self, payload: dict[str, Any]) -> None:
        for handler in list(self._finding_handlers):
            handler(payload)

    def dispatch_notification(self, method: str, payload: dict[str, Any]) -> None:
        if method in BOARD_FINDING_ALIASES:
            self.dispatch_board_finding(payload)
        elif method in EVENT_METHOD_ALIASES:
            self.dispatch_event(payload)

    # Transport ----------------------------------------------------------

    def _request_id(self) -> int:
        self._next_id += 1
        return self._next_id

    async def start(self) -> None:  # pragma: no cover - trivial default
        return None

    async def aclose(self) -> None:  # pragma: no cover - trivial default
        return None

    async def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """Issue one request under both limits.

        Embedding-bound methods take the narrow permit first, so a burst of
        them queues instead of contending for the single local embedder, and
        holds neither permit while waiting for the other.
        """
        if method in EMBEDDING_BOUND:
            async with self._embedding_inflight:
                self._current_embedding_in_flight += 1
                self.peak_embedding_in_flight = max(
                    self.peak_embedding_in_flight, self._current_embedding_in_flight
                )
                try:
                    return await self._guarded_call(method, params)
                finally:
                    self._current_embedding_in_flight -= 1
        return await self._guarded_call(method, params)

    async def _guarded_call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        async with self._inflight:
            self._current_in_flight += 1
            self.peak_in_flight = max(self.peak_in_flight, self._current_in_flight)
            try:
                return await self._call_impl(method, params)
            finally:
                self._current_in_flight -= 1

    async def _call_impl(self, method: str, params: dict[str, Any] | None = None) -> Any:
        raise NotImplementedError

    async def handshake(self) -> dict[str, Any]:
        """First call on connect. Records the contract version for the app."""
        result = await self.call("hello", {"clientVersion": CLIENT_VERSION})
        self.contract_version = str(result.get("contractVersion"))
        self.engine_version = str(result.get("engineVersion"))
        return result

    @property
    def contract_matches(self) -> bool:
        return self.contract_version == SUPPORTED_CONTRACT_VERSION

    async def __aenter__(self) -> "RpcClient":
        await self.start()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()


def _unwrap(response: dict[str, Any]) -> Any:
    if "error" in response:
        err = response["error"] or {}
        raise RpcError(
            int(err.get("code", ERR_INTERNAL)),
            str(err.get("message", "engine error")),
            err.get("data"),
        )
    return response.get("result")


class LineProtocolClient(RpcClient):
    """Shared framing: one JSON object per line, ids pending per connection.

    Both transports use it, so the wire handling cannot drift between them.
    """

    def __init__(self) -> None:
        super().__init__()
        self._pending: dict[int, asyncio.Future[Any]] = {}

    async def _pump(self, reader: asyncio.StreamReader) -> None:
        while True:
            line = await reader.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            try:
                message = json.loads(text)
            except json.JSONDecodeError:
                continue
            self._on_message(message)

    def _on_message(self, message: dict[str, Any]) -> None:
        if not isinstance(message, dict):
            return
        if "method" in message and "id" not in message:
            self.dispatch_notification(str(message["method"]), message.get("params") or {})
            return
        request_id = message.get("id")
        future = self._pending.pop(request_id, None) if request_id is not None else None
        if future is None or future.done():
            return
        try:
            future.set_result(_unwrap(message))
        except RpcError as error:
            future.set_exception(error)

    def _fail_pending(self, error: BaseException) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        self._pending.clear()

    async def _send(self, writer: Any, method: str, params: dict[str, Any] | None) -> Any:
        request_id = self._request_id()
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        writer.write((json.dumps(payload) + "\n").encode("utf-8"))
        await writer.drain()
        return await future


class StdioRpcClient(LineProtocolClient):
    """Talks to an engine process over its stdin and stdout.

    This client OWNS its daemon: the process is its child and dies with it.
    """

    def __init__(self, command: Sequence[str], *, cwd: str | None = None) -> None:
        super().__init__()
        self.command = list(command)
        self.cwd = cwd
        self._proc: asyncio.subprocess.Process | None = None
        self._reader: asyncio.Task[None] | None = None
        self._stderr_reader: asyncio.Task[None] | None = None
        self._stderr: deque[str] = deque(maxlen=STDERR_TAIL_LINES)

    async def start(self) -> None:
        if self._proc is not None:
            return
        self._proc = await asyncio.create_subprocess_exec(
            *self.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            # NOT DEVNULL. A daemon that refuses to start writes one careful
            # sentence to stderr naming the holding PID and the lock path, and
            # discarding it turns a diagnosable refusal into a bare
            # ConnectionError. The contract's own convention is that engine
            # text written for the user is displayed verbatim.
            stderr=asyncio.subprocess.PIPE,
            cwd=self.cwd,
        )
        self._reader = asyncio.create_task(self._read_loop())
        self._stderr_reader = asyncio.create_task(self._drain_stderr())

    async def _drain_stderr(self) -> None:
        """Keep the tail of the engine's stderr for the failure message."""
        assert self._proc is not None and self._proc.stderr is not None
        while True:
            line = await self._proc.stderr.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                self._stderr.append(text)

    @property
    def stderr_tail(self) -> str:
        return "\n".join(self._stderr)

    def _startup_error(self, summary: str) -> ConnectionError:
        """Raise with the engine's own words attached, when it wrote any."""
        tail = self.stderr_tail
        if tail:
            return ConnectionError(f"{summary}\n\nThe engine said:\n{tail}")
        return ConnectionError(summary)

    async def _read_loop(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        await self._pump(self._proc.stdout)
        # Let the stderr drain finish so a refusal written just before exit is
        # not lost to a race with the stdout EOF.
        if self._stderr_reader is not None:
            try:
                await asyncio.wait_for(asyncio.shield(self._stderr_reader), timeout=1.0)
            except (asyncio.TimeoutError, Exception):
                pass
        self._fail_pending(self._startup_error("The engine exited without answering."))

    async def _call_impl(self, method: str, params: dict[str, Any] | None = None) -> Any:
        if self._proc is None:
            await self.start()
        assert self._proc is not None and self._proc.stdin is not None
        return await self._send(self._proc.stdin, method, params)

    async def aclose(self) -> None:
        if self._stderr_reader is not None:
            self._stderr_reader.cancel()
            try:
                await self._stderr_reader
            except (asyncio.CancelledError, Exception):
                pass
            self._stderr_reader = None
        if self._reader is not None:
            self._reader.cancel()
            try:
                await self._reader
            except (asyncio.CancelledError, Exception):
                pass
            self._reader = None
        if self._proc is not None:
            if self._proc.stdin is not None and not self._proc.stdin.is_closing():
                self._proc.stdin.close()
            try:
                self._proc.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=2)
            except (asyncio.TimeoutError, Exception):
                pass
            self._proc = None
        self._fail_pending(ConnectionError("client closed"))


# Connect states, per TRANSPORT-PROPOSAL.md. There is deliberately no
# "waiting" state: waiting is a rendering decision this client makes from
# elapsed_ms at its own threshold, so no number belonging to this UI lives on
# the engine side.
CONNECT_CONNECTING = "connecting"
CONNECT_SPAWNING = "spawning"
CONNECT_ATTACHED = "attached"
CONNECT_FAILED = "failed"

# How long to keep retrying a connect before giving up, and how long before the
# UI should start saying something. Both are this client's to choose.
CONNECT_BUDGET_S = 2.0
CONNECT_SAY_SOMETHING_AFTER_S = 0.5


class SocketRpcClient(LineProtocolClient):
    """Attaches to a running daemon over a unix socket, spawning one if absent.

    A separate class from StdioRpcClient rather than a mode of it, because the
    two have genuinely different lifecycles: the stdio client OWNS its daemon
    and the socket client usually does not. A client that sometimes owns its
    engine and sometimes does not eventually grows a quit path that kills a
    daemon another window is using.
    """

    def __init__(
        self,
        socket_path: str,
        *,
        spawn_command: Sequence[str] | None = None,
        connect_budget: float = CONNECT_BUDGET_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        super().__init__()
        self.socket_path = str(socket_path)
        self.spawn_command = list(spawn_command) if spawn_command else None
        self.connect_budget = connect_budget
        self._clock = clock
        self._reader_stream: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._spawned: asyncio.subprocess.Process | None = None
        self._stderr_reader: asyncio.Task[None] | None = None
        self._stderr: deque[str] = deque(maxlen=STDERR_TAIL_LINES)
        self._started_at: float | None = None
        self.connect_state = CONNECT_CONNECTING
        self.failure: dict[str, Any] | None = None

    # Connect surface -----------------------------------------------------

    @property
    def elapsed_ms(self) -> int:
        if self._started_at is None:
            return 0
        return int((self._clock() - self._started_at) * 1000)

    @property
    def should_say_waiting(self) -> bool:
        """True once the wait is long enough to be worth telling the user.

        A silent multi-second wait looks exactly like a hang, which is the
        discarded-stderr failure in another form: a real reason, invisible.
        """
        return (
            self.connect_state in (CONNECT_CONNECTING, CONNECT_SPAWNING)
            and self.elapsed_ms >= CONNECT_SAY_SOMETHING_AFTER_S * 1000
        )

    @property
    def owns_daemon(self) -> bool:
        """Whether this client started the daemon it is talking to."""
        return self._spawned is not None

    @property
    def stderr_tail(self) -> str | None:
        """The spawned daemon's stderr, or None when this client attached.

        None is NOT "the engine said nothing": it means this client never had
        that daemon's stderr, because someone else started it. Rendering the
        two the same reports silence from a daemon that may have written a
        perfectly good refusal to a terminal two windows away.
        """
        if self._spawned is None:
            return None
        return "\n".join(self._stderr)

    # Lifecycle -----------------------------------------------------------

    async def start(self) -> None:
        if self._writer is not None:
            return
        self._started_at = self._clock()
        self.connect_state = CONNECT_CONNECTING
        self.failure = None

        if await self._try_connect():
            return

        if self.spawn_command:
            self.connect_state = CONNECT_SPAWNING
            await self._spawn()

        # Bounded retry. A lost spawn race resolves itself here: the loser's
        # daemon exits on the lock and its client attaches to the winner.
        delay = 0.02
        while (self._clock() - self._started_at) < self.connect_budget:
            await asyncio.sleep(delay)
            delay = min(delay * 2, 0.2)
            if await self._try_connect():
                return

        self.connect_state = CONNECT_FAILED
        reason = (
            f"No engine answered on {self.socket_path} within "
            f"{self.connect_budget:.1f}s."
        )
        self.failure = {"reason": reason, "engineStderr": self.stderr_tail}
        raise self._connect_error(reason)

    def _connect_error(self, reason: str) -> ConnectionError:
        tail = self.stderr_tail
        if tail:
            return ConnectionError(f"{reason}\n\nThe engine said:\n{tail}")
        return ConnectionError(reason)

    async def _try_connect(self) -> bool:
        try:
            reader, writer = await asyncio.open_unix_connection(self.socket_path)
        except (FileNotFoundError, ConnectionRefusedError, OSError):
            return False
        self._reader_stream, self._writer = reader, writer
        self._reader_task = asyncio.create_task(self._read_loop())
        self.connect_state = CONNECT_ATTACHED
        return True

    async def _spawn(self) -> None:
        assert self.spawn_command is not None
        self._spawned = await asyncio.create_subprocess_exec(
            *self.spawn_command,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            # Kept, not discarded: a daemon that refuses to start says why here,
            # and a lock refusal names the holding pid and the lock path.
            stderr=asyncio.subprocess.PIPE,
        )
        self._stderr_reader = asyncio.create_task(self._drain_stderr())

    async def _drain_stderr(self) -> None:
        assert self._spawned is not None and self._spawned.stderr is not None
        while True:
            line = await self._spawned.stderr.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                self._stderr.append(text)

    async def _read_loop(self) -> None:
        assert self._reader_stream is not None
        await self._pump(self._reader_stream)
        # The daemon went away. No automatic reconnect: a silent respawn would
        # present a fresh engine that knows nothing about the job the user was
        # watching, while the user believes they are still watching it.
        self.connect_state = CONNECT_FAILED
        self.failure = {
            "reason": "The engine stopped.",
            "engineStderr": self.stderr_tail,
        }
        self._fail_pending(self._connect_error("The engine stopped."))

    async def _call_impl(self, method: str, params: dict[str, Any] | None = None) -> Any:
        if self._writer is None:
            await self.start()
        assert self._writer is not None
        return await self._send(self._writer, method, params)

    async def aclose(self) -> None:
        for task in (self._reader_task, self._stderr_reader):
            if task is not None:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        self._reader_task = None
        self._stderr_reader = None
        if self._writer is not None:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except Exception:
                pass
            self._writer = None
        # A daemon this client did NOT start outlives it: other windows may be
        # attached, and MCP serving and the gym outlive any one window.
        if self._spawned is not None:
            self._spawned = None
        self._fail_pending(ConnectionError("client closed"))


def default_socket_path(state_root: str) -> str:
    """Beside the lock, so the socket follows the state it serves."""
    return str(Path(state_root).expanduser().resolve() / "daemon.sock")



def _read_gates_document(content: str) -> tuple[dict[str, Any] | None, str | None]:
    """Map an edited document onto the three states the wire can be in.

    This is a line recognizer, NOT a YAML parser. Parsing stays engine side
    where the classification lives, and the mock only has to make each state
    reachable so no branch rots. It reproduces two behaviours that were checked
    against the daemon: rows come back AS WRITTEN, with classification, enabled
    and baseline ABSENT until discovery runs, and summary is null whenever no
    baseline has been measured.
    """
    lines = content.splitlines()
    if not any(line.startswith("gates:") for line in lines):
        return None, "gates.yaml has no `gates:` list, so there is nothing to classify"
    member_indent: int | None = None
    for index, line in enumerate(lines):
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(stripped)
        if stripped.startswith("- "):
            member_indent = None  # a new item sets its own member column
            continue
        if indent == 0:
            member_indent = None
            continue
        if member_indent is None:
            member_indent = indent
        elif indent != member_indent:
            # A member of the same item at a different column. This is the
            # shape of the malformed file the engine rejects.
            return None, (
                f"gates.yaml is not valid YAML (Nested mappings are not allowed in "
                f"compact mappings at line {index + 1}, column {indent + 1}:)"
            )
    gates: list[dict[str, Any]] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("- id:"):
            gates.append({"id": stripped.split(":", 1)[1].strip()})
        elif gates and ":" in stripped and not stripped.startswith("- "):
            key, _, value = stripped.partition(":")
            if key.strip() in ("command", "role", "cwd", "availabilityCommand"):
                gates[-1][key.strip()] = value.strip() or None
    return (
        {
            "version": 1,
            "discoveredAt": None,
            "timeoutMs": None,
            "gates": gates,
            # No baseline has run over an edited file, so there is nothing to
            # tally and a zeroed summary would be a measurement nobody took.
            "summary": None,
        },
        None,
    )


class MockEngine:
    """A local stand in for the Node engine, speaking RPC v3.

    It accepts and returns JSON-RPC envelopes exactly as the real engine does,
    so the same client code drives both. Every value it returns comes from
    mock_data and is labelled as mock in the TUI chrome.

    Spend behaviour mirrors the contract: the four spend-touching methods are
    refused with -32050 unless the call carries the confirmation the TUI is
    required to collect, and gymStart additionally requires the owner gate.
    """

    def __init__(
        self,
        *,
        speed: float = 1.0,
        gate_open: bool = False,
        contract_version: str = mock_data.CONTRACT_VERSION,
        deferred: dict[str, str] | None = None,
        emit: Callable[[dict[str, Any]], Any] | None = None,
    ) -> None:
        self.speed = speed
        self.gate_open = gate_open
        self.contract_version = contract_version
        # Methods whose engine capability has not shipped, mapped to the phase
        # that ships them. The real daemon answers these with -32001; the mock
        # can too, so the "not built yet" screen state is testable offline.
        self.deferred = dict(deferred or {})
        self.emit = emit
        self.settings = copy.deepcopy(mock_data.SETTINGS)
        self.exams = copy.deepcopy(mock_data.EXAMS)
        self.exam_details = copy.deepcopy(mock_data.EXAM_DETAIL)
        self.gates = copy.deepcopy(mock_data.GATES)
        self.unopenable_brains: set[str] = set()
        self.failing_inits: set[str] = set()
        self.failing_cycles = False
        self.failing_discoveries: set[str] = set()
        self.failing_clones = False
        self.agent_files = copy.deepcopy(mock_data.AGENT_FILES)
        self.repos = copy.deepcopy(mock_data.REPOS)
        self.board_rows = copy.deepcopy(mock_data.BOARD_ROWS)
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.spend_calls: list[tuple[str, dict[str, Any]]] = []
        # What each confirmed spend call echoed back, as the real engine records
        # it for the audit trail.
        self.recorded_budgets: list[tuple[str, Any]] = []
        self._jobs: dict[str, asyncio.Task[None]] = {}
        self._cancelled: set[str] = set()
        self._job_seq = 0

    # Protocol -----------------------------------------------------------

    async def handle(self, message: dict[str, Any]) -> dict[str, Any] | None:
        request_id = message.get("id")
        method = message.get("method")
        params = message.get("params") or {}
        if not isinstance(method, str):
            return self._error(request_id, ERR_INVALID_REQUEST, "missing method", "The request carried no method name.")
        self.calls.append((method, params))
        if is_spend_touching(method, params):
            self.spend_calls.append((method, params))
        if method in self.deferred:
            phase = self.deferred[method]
            return self._error(
                request_id,
                ERR_NOT_IMPLEMENTED,
                f"{method} is not implemented yet",
                f"{method} is part of the frozen RPC surface but its engine capability ships in {phase}.",
                {"phase": phase},
            )
        handler = getattr(self, f"_rpc_{method}", None)
        if handler is None:
            return self._error(
                request_id,
                ERR_METHOD_NOT_FOUND,
                f"unknown method {method}",
                f"The engine has no method named {method}. The frozen surface is in engine/src/rpc/methods.md.",
            )
        try:
            result = await handler(params)
        except RpcError as error:
            return self._error(request_id, error.code, error.message, error.hint, error.data)
        if request_id is None:
            return None
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    @staticmethod
    def _error(
        request_id: Any,
        code: int,
        message: str,
        hint: str,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = dict(data or {})
        payload["hint"] = hint
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": code, "message": message, "data": payload},
        }

    def _refuse_spend(self, what: str, hint: str) -> None:
        raise RpcError(
            ERR_SPEND_GATE,
            f"{what} is spend-touching and was not confirmed",
            {"gate": mock_data.SPEND_GATE["path"], "hint": hint},
        )

    async def _push(self, event: dict[str, Any], method: str = EVENT_METHOD) -> None:
        if self.emit is None:
            return
        result = self.emit({"method": method, "params": event})
        if inspect.isawaitable(result):
            await result

    def _new_job_id(self, prefix: str) -> str:
        self._job_seq += 1
        return f"job-{prefix}-{self._job_seq:04d}"

    def _start_stream(self, job_id: str, events: Iterable[dict[str, Any]]) -> None:
        task = asyncio.create_task(self._stream(job_id, list(events)))
        self._jobs[job_id] = task
        task.add_done_callback(lambda _t: self._jobs.pop(job_id, None))

    async def _stream(self, job_id: str, events: list[dict[str, Any]]) -> None:
        previous = 0
        for event in events:
            if job_id in self._cancelled:
                await self._push(
                    {
                        "ts": previous,
                        "jobId": job_id,
                        "phase": "done",
                        "step": "cancelled",
                        "detail": "job cancelled by the user",
                        "level": "warn",
                    }
                )
                return
            delay = max(0.0, (event["ts"] - previous) / 1000.0) * self.speed
            previous = event["ts"]
            if delay > 0:
                await asyncio.sleep(delay)
            await self._push(event)

    def start_board_findings(self) -> None:
        """Push the standing watcher findings, including a critical one."""
        task = asyncio.create_task(self._stream_findings())
        self._jobs["board-findings"] = task
        task.add_done_callback(lambda _t: self._jobs.pop("board-findings", None))

    async def _stream_findings(self) -> None:
        for index, finding in enumerate(mock_data.BOARD_FINDING_PUSHES):
            if index and self.speed:
                await asyncio.sleep(0.4 * self.speed)
            row = dict(finding)
            self.board_rows.insert(0, {"id": f"f-push-{index}", **row})
            await self._push(row, BOARD_FINDING_METHOD)

    async def aclose(self) -> None:
        for task in list(self._jobs.values()):
            task.cancel()
        for task in list(self._jobs.values()):
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        self._jobs.clear()

    # Handshake and lifecycle ---------------------------------------------

    async def _rpc_hello(self, params: dict[str, Any]) -> dict[str, Any]:
        return {"engineVersion": mock_data.ENGINE_VERSION, "contractVersion": self.contract_version}

    async def _rpc_repoAttach(self, params: dict[str, Any]) -> dict[str, Any]:
        path = str(params.get("repoPath") or "").rstrip("/")
        if not path:
            raise RpcError(ERR_INVALID_PARAMS, "repoPath required", {"hint": "Attach needs a repo path."})
        for repo in self.repos:
            if repo["path"] == path:
                return {"repo": copy.deepcopy(repo)}
        known = mock_data.ANALYZE.get(path)
        repo = {
            "path": path,
            "health": "ok" if known and known.get("hasBrainFolder") else "no-brain",
            "floorScore": None,
            "mcpActive": False,
        }
        self.repos.append(repo)
        return {"repo": copy.deepcopy(repo)}

    async def _rpc_repoDetach(self, params: dict[str, Any]) -> dict[str, Any]:
        path = str(params.get("repoPath") or "")
        before = len(self.repos)
        self.repos = [repo for repo in self.repos if repo["path"] != path]
        if len(self.repos) == before:
            raise RpcError(ERR_INVALID_PARAMS, "unknown repoPath", {"hint": f"{path} is not attached."})
        return {"ok": True}

    async def _rpc_jobCancel(self, params: dict[str, Any]) -> dict[str, Any]:
        job_id = str(params.get("jobId") or "")
        if job_id not in self._jobs:
            return {"cancelled": False}
        self._cancelled.add(job_id)
        return {"cancelled": True}

    # Core -----------------------------------------------------------------

    def fail_next_init(self, path: str) -> None:
        """Make this repo's init break partway, as a refused embedder does."""
        self.failing_inits.add(path)

    def fail_next_discovery(self, path: str) -> None:
        """Make this repo's gate discovery break partway."""
        self.failing_discoveries.add(path)

    def fail_next_cycle(self) -> None:
        """Make the next gym cycle break after the provider has been called."""
        self.failing_cycles = True

    def break_brain(self, path: str) -> None:
        """Make a repo's brain unopenable, as deleting a state directory does."""
        self.unopenable_brains.add(path)

    def repair_brain(self, path: str) -> None:
        self.unopenable_brains.discard(path)

    def _repo_row(self, repo: dict[str, Any]) -> dict[str, Any]:
        """Health is COMPUTED per call, not stored at attach time.

        A brain deleted on disk stops reporting the health it had when it was
        attached, and the ok to critical transition happens with no reattach.
        A mock that cached a health per repo would never produce that, which is
        the transition a user actually meets when they remove a state
        directory.
        """
        row = copy.deepcopy(repo)
        if row.get("path") in self.unopenable_brains:
            row["health"] = "critical"
            # floorScore SURVIVES, measured against the daemon: it comes from
            # the score history under the state root, not from the brain, so
            # breaking the index cannot clear it and should not. Those numbers
            # were measured on a date by a particular embedder, and nothing
            # recomputes the past. This mock cleared it, which was a behaviour
            # the engine does not have.
        return row

    def set_ollama_reachable(self, reachable: bool) -> None:
        """Flip the embedder between up and down.

        Down is not "the same object with a false flag": version and digest go
        null and hint fills in, and a client that never sees that branch has an
        untested rendering for the state a user is most likely to need help in.
        """
        self.ollama_reachable = reachable

    async def _rpc_serveStatus(self, params: dict[str, Any]) -> dict[str, Any]:
        status = copy.deepcopy(mock_data.SERVE_STATUS)
        if not getattr(self, "ollama_reachable", True):
            endpoint = status["ollama"]["endpoint"]
            status["ollama"].update({
                "reachable": False,
                "version": None,
                "digest": None,
                "hint": (
                    f"Ollama not reachable at {endpoint}; check that the host is up "
                    f"and reachable, or clear the configured endpoint to fall back "
                    f"to a local ollama"
                ),
            })
        status["repos"] = [self._repo_row(repo) for repo in self.repos]
        status["spendGate"] = {"open": self.gate_open, "path": mock_data.SPEND_GATE["path"]}
        return status

    async def _rpc_analyze(self, params: dict[str, Any]) -> dict[str, Any]:
        repo = params.get("repoPath")
        record = mock_data.ANALYZE.get(repo)
        if record is None:
            raise RpcError(
                ERR_INVALID_PARAMS,
                "unknown repoPath",
                {"hint": f"The mock engine knows nothing about {repo}. Attach it first."},
            )
        return copy.deepcopy(record)

    async def _rpc_initBrain(self, params: dict[str, Any]) -> dict[str, Any]:
        repo = params.get("repoPath")
        mode = params.get("mode", "layer1")
        if mode not in ("ingest", "layer1", "layer1+layer2"):
            raise RpcError(
                ERR_INVALID_PARAMS,
                "unknown mode",
                {"hint": "mode must be ingest, layer1, or layer1+layer2."},
            )
        if mode == "layer1+layer2":
            if not params.get("confirm"):
                self._refuse_spend(
                    "initBrain layer1+layer2",
                    "Layer 2 narration runs on your engineer key and spends. The estimated "
                    "budget has to be shown and confirmed before the job starts.",
                )
            # The engine ACCEPTS a bare confirm and records whatever echo it
            # was given; refusing here would invent a refusal condition on a
            # spend path and train the client against an error that will never
            # come. Sending the echo is the client's obligation, enforced by a
            # client-side test, not by a stricter-than-real mock.
            self.recorded_budgets.append((str(repo), params.get("budget")))
        job_id = self._new_job_id("init")
        # A mock whose jobs always succeed leaves every failure branch of every
        # consumer unexercised. Opt in per repo so tests can drive the run that
        # breaks without every other test having to handle it.
        script = (
            mock_data.init_failure_script(job_id, str(repo))
            if str(repo) in self.failing_inits
            else mock_data.init_script(job_id, str(repo), mode)
        )
        self._start_stream(job_id, script)
        return {"jobId": job_id}

    async def _rpc_diagnose(self, params: dict[str, Any]) -> dict[str, Any]:
        self._require_brain("diagnose", params.get("repoPath"))
        repo = params.get("repoPath")
        record = mock_data.DIAGNOSE.get(repo)
        if record is None:
            raise RpcError(
                ERR_INVALID_PARAMS,
                "no gold set",
                {"hint": f"No gold set has been mined for {repo}, so there is nothing to diagnose."},
            )
        return copy.deepcopy(record)

    async def _rpc_diagnoseNarrate(self, params: dict[str, Any]) -> dict[str, Any]:
        if not params.get("confirm"):
            self._refuse_spend(
                "diagnoseNarrate",
                "The auditor's recommendation is a paid generation. It needs your explicit "
                "go ahead on every call. The mechanical clusters above are free and already shown.",
            )
        repo = params.get("repoPath")
        narration = mock_data.DIAGNOSE_NARRATION.get(repo)
        if narration is None:
            raise RpcError(ERR_INVALID_PARAMS, "no diagnosis", {"hint": f"Nothing to narrate for {repo}."})
        return {"recommendation": narration}

    async def _rpc_retrievalScore(self, params: dict[str, Any]) -> dict[str, Any]:
        self._require_brain("retrievalScore", params.get("repoPath"))
        repo = params.get("repoPath")
        record = mock_data.RETRIEVAL_SCORE.get(repo)
        if record is None:
            raise RpcError(
                ERR_INVALID_PARAMS,
                "no measured floor",
                {"hint": f"No gold set has been mined for {repo}, so there is no floor to report."},
            )
        result = copy.deepcopy(record)
        if not params.get("sweep"):
            result.pop("budgetSweep", None)
        budget = params.get("tokenBudget")
        if budget:
            for point in record.get("budgetSweep", []):
                if point["budget"] == budget:
                    result["caseRate"] = copy.deepcopy(point["caseRate"])
                    result["chosenBudget"] = budget
                    result["rationale"] = "budget pinned by the user for this run"
        return result

    # The engine's own sentences, read off the daemon on 2026-08-17 rather than
    # copied from a description. They are PER METHOD: an earlier version of
    # this mock used one invented sentence for all of them, so a user in mock
    # mode read copy the engine never sends. That is the vetoReason defect
    # again, in the hint rather than in a field location.
    BRAIN_REFUSAL = {
        "search": "{path} has no indexed brain yet, so there is nothing to search. Initialize the brain first.",
        "retrievalScore": "{path} has no indexed brain yet, so there is no floor to measure.",
        "diagnose": "{path} has no indexed brain yet, so there is nothing to diagnose.",
    }

    # Five methods share one callsite engine side (withLedger, 4baeab6), so
    # they share one sentence. Confirmed identical across all five.
    LEDGER_REFUSAL = (
        "{path} has no gym ledger yet, so there are no exams or cycles to read. "
        "Run init on {path} first; it creates the ledger."
    )

    def _uninitialized(self, repo: Any) -> str | None:
        """The repo path when it has nothing initialised, else None."""
        path = str(repo or "")
        row = next((r for r in self.repos if r["path"] == path), None)
        if row is None or row.get("health") != "no-brain":
            return None
        return path

    def _require_brain(self, method: str, repo: Any) -> None:
        """Refuse the way the engine does for a repo with nothing indexed."""
        path = self._uninitialized(repo)
        if path is None:
            return
        raise RpcError(
            ERR_INVALID_PARAMS,
            "no indexed brain",
            {"hint": self.BRAIN_REFUSAL[method].format(path=path)},
        )

    def _require_ledger(self, repo: Any) -> None:
        """Refuse the way the ledger seam does for a repo that was never init'd.

        ONLY the not-yet-initialised case is translated. A ledger that EXISTS
        and cannot be opened still refuses as an internal error engine side,
        deliberately, because dressing a corrupt database as "run init" sends a
        user to rebuild a repo whose real problem is a damaged file. So that
        case is NOT mocked here: mocking it with this friendly sentence would
        be the permissive-double trap inverted, teaching the screen that all
        ledger trouble is a missing brain.
        """
        path = self._uninitialized(repo)
        if path is None:
            return
        raise RpcError(
            ERR_INVALID_PARAMS,
            "no gym ledger",
            {"hint": self.LEDGER_REFUSAL.format(path=path)},
        )

    async def _rpc_search(self, params: dict[str, Any]) -> dict[str, Any]:
        self._require_brain("search", params.get("repoPath"))
        query = str(params.get("query") or "").strip()
        options = params.get("options") or {}
        limit = int(options.get("k") or 10)
        budget = int(options.get("tokenBudget") or self.settings["retrieval"]["tokenBudget"])
        terms = [t.lower() for t in query.split() if len(t) > 2]
        scored: list[dict[str, Any]] = []
        for chunk in copy.deepcopy(mock_data.SEARCH_CHUNKS):
            haystack = f"{chunk['text']} {chunk['documentId']} {chunk['type']} {chunk['area'] or ''}".lower()
            overlap = sum(1 for term in terms if term in haystack)
            if terms and overlap == 0 and not chunk["standing"]:
                continue
            chunk["score"] = round(chunk["score"] + 0.03 * overlap, 4)
            chunk["matchedTerms"] = overlap
            scored.append(chunk)
        scored.sort(key=lambda row: row["score"], reverse=True)
        kept: list[dict[str, Any]] = []
        used = 0
        for chunk in scored[:limit]:
            # Standing units ride outside the budget (platform standing.js).
            if chunk["standing"]:
                kept.append(chunk)
                continue
            if used + chunk["tokens"] > budget:
                continue
            used += chunk["tokens"]
            kept.append(chunk)
        return {"chunks": kept, "tokensUsed": used}

    async def _rpc_documents(self, params: dict[str, Any]) -> Any:
        repo = params.get("repoPath")
        inventory = mock_data.DOCUMENTS.get(repo)
        if inventory is None:
            raise RpcError(
                ERR_INVALID_PARAMS,
                "no brain",
                {"hint": f"No brain has been built for {repo}, so there is no inventory to browse."},
            )
        rows = copy.deepcopy(inventory)
        filters = params.get("filters") or {}
        # A misspelled filter that is silently ignored returns EVERYTHING, which
        # reads as "no matches were filtered out" when the truth is "your filter
        # never ran". v5 makes that an error.
        unknown = sorted(set(filters) - DOCUMENT_FILTER_KEYS)
        if unknown:
            raise RpcError(
                ERR_INVALID_PARAMS,
                "unknown document filter",
                {
                    "hint": (
                        f"documents accepts only {', '.join(sorted(DOCUMENT_FILTER_KEYS))}. "
                        f"Unrecognised: {', '.join(unknown)}. An ignored filter would have "
                        f"returned the whole inventory as though nothing matched it."
                    )
                },
            )
        for field in ("type", "area"):
            wanted = filters.get(field)
            if wanted and wanted != "all":
                rows = [row for row in rows if row.get(field) == wanted]
        query = str(filters.get("q") or "").strip().lower()
        if query:
            rows = [
                row
                for row in rows
                if query in f"{row.get('title', '')} {row.get('id', '')} {row.get('path', '')}".lower()
            ]
        return rows

    async def _rpc_budgetEstimate(self, params: dict[str, Any]) -> dict[str, Any]:
        """Zero-spend. The dialog that shows this runs BEFORE consent."""
        repo = params.get("repoPath")
        mode = params.get("mode")
        if mode not in ("layer1+layer2", "gym"):
            raise RpcError(
                ERR_INVALID_PARAMS,
                "unknown mode",
                {"hint": "budgetEstimate takes mode layer1+layer2 or gym."},
            )
        record = mock_data.BUDGET_ESTIMATE.get((repo, mode))
        if record is None:
            raise RpcError(
                ERR_INVALID_PARAMS,
                "no estimate",
                {"hint": f"The engine cannot estimate a {mode} run for {repo}."},
            )
        result = copy.deepcopy(record)
        scope = (params.get("scope") or {}).get("areas") or []
        if scope:
            # A scoped run narrates less, so the estimate has to move with it or
            # the dialog would overstate what the user is agreeing to.
            factor = min(1.0, 0.34 * len(scope))
            result["estimatedTokens"] = int(result["estimatedTokens"] * factor)
            result["basis"] = f"{result['basis']}, scoped to {', '.join(scope)}"
        return result

    async def _rpc_scoreHistory(self, params: dict[str, Any]) -> Any:
        repo = params.get("repoPath")
        history = mock_data.SCORE_HISTORY.get(repo)
        if history is None:
            raise RpcError(
                ERR_INVALID_PARAMS,
                "no measurements",
                {"hint": f"No floor has ever been measured for {repo}."},
            )
        # Newest first, as the contract states.
        return copy.deepcopy(history)

    async def _rpc_mcpSnippet(self, params: dict[str, Any]) -> dict[str, Any]:
        repo = params.get("repoPath")
        record = mock_data.MCP_SNIPPET.get(repo)
        if record is None:
            return {"unlocked": False, "threshold": mock_data.MCP_THRESHOLD, "snippet": None}
        return copy.deepcopy(record)

    # Gates ----------------------------------------------------------------

    async def _rpc_gatesDiscover(self, params: dict[str, Any]) -> dict[str, Any]:
        repo = str(params.get("repoPath") or "")
        job_id = self._new_job_id("gates")
        self._start_stream(
            job_id,
            mock_data.gates_failure_script(job_id, repo)
            if repo in self.failing_discoveries
            else mock_data.gates_script(job_id, repo),
        )
        return {"jobId": job_id}

    async def _rpc_gatesGet(self, params: dict[str, Any]) -> dict[str, Any]:
        repo = params.get("repoPath")
        record = self.gates.get(repo)
        if record is None:
            raise RpcError(
                ERR_INVALID_PARAMS,
                "no gates discovered",
                {"hint": f"No gates.yaml exists for {repo}. Run discovery first."},
            )
        return copy.deepcopy(record)

    async def _rpc_gatesSet(self, params: dict[str, Any]) -> dict[str, Any]:
        """Replace the whole document, in any state the file is currently in.

        Verified against the daemon on 2026-08-17: a structural patch is
        refused with -32602 whatever the file's state, and a full content write
        is accepted even when the file on disk does not parse, because that is
        the only way a user repairs a file they broke. An earlier version of
        this mock had it exactly backwards and refused the repair.
        """
        repo = params.get("repoPath")
        record = self.gates.get(repo)
        if record is None:
            raise RpcError(ERR_INVALID_PARAMS, "no gates discovered", {"hint": f"No gates.yaml exists for {repo}."})
        patch = params.get("patch") or {}
        if "content" not in patch:
            raise RpcError(
                ERR_INVALID_PARAMS,
                "gatesSet takes the full gates.yaml content",
                {"hint": (
                    "gatesSet takes the full gates.yaml content; the engine treats it as "
                    "data it does not author and replaces the document rather than merging "
                    "into it. Send patch.content."
                )},
            )
        content = str(patch.get("content") or "")
        record["content"] = content
        discovered, parse_error = _read_gates_document(content)
        record["discovered"] = discovered
        record["parseError"] = parse_error
        return copy.deepcopy(record)

    # Gym and exams --------------------------------------------------------

    async def _rpc_gymStart(self, params: dict[str, Any]) -> dict[str, Any]:
        if not self.gate_open:
            raise RpcError(
                ERR_SPEND_GATE,
                "spend gate is blocked",
                {
                    "gate": mock_data.SPEND_GATE["path"],
                    "hint": (
                        "The spend gate is blocked. A gym cycle calls a paid provider, "
                        "so the gate is flipped by the owner's hand and re-blocked after."
                    ),
                },
            )
        if not params.get("confirm"):
            self._refuse_spend(
                "gymStart",
                "A gym cycle spends. The open gate is the owner's permission to spend at "
                "all; it is not consent to this particular cycle, so the engine still "
                "needs an explicit confirmation on the call.",
            )
        self.recorded_budgets.append((str(params.get("repoPath")), params.get("budget")))
        config = params.get("config") or {}
        exam_id = config.get("examId") or self.exams[0]["examId"]
        job_id = self._new_job_id("gym")
        self._start_stream(
            job_id,
            mock_data.gym_failure_script(job_id, str(exam_id))
            if self.failing_cycles
            else mock_data.gym_script(job_id, str(exam_id)),
        )
        return {"jobId": job_id}

    async def _rpc_gymStatus(self, params: dict[str, Any]) -> dict[str, Any]:
        self._require_ledger(params.get("repoPath"))
        return copy.deepcopy(mock_data.GYM_STATUS)

    async def _rpc_examList(self, params: dict[str, Any]) -> Any:
        self._require_ledger(params.get("repoPath"))
        filters = params.get("filters") or {}
        rows = copy.deepcopy(self.exams)
        for field in ("status", "benchmarkStatus", "tier"):
            wanted = filters.get(field)
            if wanted and wanted != "all":
                rows = [row for row in rows if row.get(field) == wanted]
        if filters.get("heldOut") in (True, False):
            rows = [row for row in rows if row.get("heldOut") is filters["heldOut"]]
        return rows

    async def _rpc_examDetail(self, params: dict[str, Any]) -> dict[str, Any]:
        self._require_ledger(params.get("repoPath"))
        exam_id = params.get("examId")
        record = self.exam_details.get(exam_id)
        if record is None:
            raise RpcError(ERR_INVALID_PARAMS, "unknown examId", {"hint": f"No exam named {exam_id} is in the bank."})
        return copy.deepcopy(record)

    def _find_exam(self, exam_id: Any) -> dict[str, Any]:
        for exam in self.exams:
            if exam["examId"] == exam_id:
                return exam
        raise RpcError(ERR_INVALID_PARAMS, "unknown examId", {"hint": f"No exam named {exam_id} is in the bank."})

    async def _rpc_examVeto(self, params: dict[str, Any]) -> dict[str, Any]:
        self._require_ledger(params.get("repoPath"))
        exam = self._find_exam(params.get("examId"))
        reason = str(params.get("reason") or "").strip()
        # 20 characters, the same bound the engine enforces. The mock accepted
        # any non-empty string, which is how a client dialog with a shorter
        # bound survived every test: a mock looser than reality tests nothing
        # about the boundary it is standing in for.
        if len(reason) < 20:
            raise RpcError(
                ERR_INVALID_PARAMS,
                "veto reason too short",
                {
                    "hint": (
                        "A veto needs a written reason of at least 20 characters. "
                        "A veto nobody can review later is a decision without a record."
                    )
                },
            )
        exam["status"] = "vetoed"
        # TOP LEVEL, not inside provenance. The engine stores it here, and the
        # approved change carries it on the bank row beside quarantineReason.
        # My earlier mock invented the provenance location, so the screen's
        # display branch could never have fired against real data: coverage of
        # a world that did not exist.
        exam["vetoReason"] = reason
        return copy.deepcopy(exam)

    async def _rpc_examUpdate(self, params: dict[str, Any]) -> dict[str, Any]:
        self._require_ledger(params.get("repoPath"))
        exam = self._find_exam(params.get("examId"))
        patch = params.get("patch") or {}
        merged = {**exam, **patch}
        # quarantineReason is required, minimum 20 characters, when quarantined.
        if merged.get("benchmarkStatus") == "quarantined":
            reason = str(merged.get("quarantineReason") or "")
            if len(reason) < 20:
                raise RpcError(
                    ERR_INVALID_PARAMS,
                    "quarantineReason too short",
                    {
                        "hint": (
                            "A quarantined exam needs a quarantineReason of at least 20 "
                            "characters. A bare flag with no reason is unreadable six weeks later."
                        )
                    },
                )
        if merged.get("benchmarkStatus") == "active":
            merged.pop("quarantineReason", None)
        exam.clear()
        exam.update(merged)
        return copy.deepcopy(exam)

    # Settings, roles, board -----------------------------------------------

    async def _rpc_providerCatalog(self, params: dict[str, Any]) -> dict[str, Any]:
        """A constant, and deliberately not part of settingsGet.

        A catalog is not user state, and folding it into settings would
        re-send it on every settings read. Zero-spend and unprobeable by
        construction: it is a local table and cannot be made to call a
        provider. rolePing stays the only key-verification path.
        """
        return copy.deepcopy(mock_data.PROVIDER_CATALOG)

    async def _rpc_repoClone(self, params: dict[str, Any]) -> dict[str, Any]:
        """Clone is a JOB, not an overload of repoAttach.

        A clone of a real repository takes minutes, so it streams. Verified
        against the daemon: a URL that is not a hosting URL is refused with
        -32602 and this sentence, and file:// and bare paths are refused too.
        """
        url = str(params.get("url") or "").strip()
        if not re.match(r"^(https://[^/]+/[^/]+/[^/]+|git@[^:]+:[^/]+/.+)$", url):
            raise RpcError(
                ERR_INVALID_PARAMS,
                "not a repository URL",
                {"hint": mock_data.CLONE_URL_HINT.format(url=url or "an empty string")},
            )
        name = str(params.get("name") or "").strip() or url.rstrip("/").split("/")[-1]
        name = name[:-4] if name.endswith(".git") else name
        # Managed location carries host AND owner: a bare name collides the
        # moment two organisations both have a repo called daijin.
        host, owner = self._clone_origin(url)
        target = f"~/.daijin/clones/{host}/{owner}/{name}"
        job_id = self._new_job_id("clone")
        self._start_stream(
            job_id,
            mock_data.clone_failure_script(job_id, url)
            if self.failing_clones
            else mock_data.clone_script(job_id, url, target),
        )
        return {"jobId": job_id}

    @staticmethod
    def _clone_origin(url: str) -> tuple[str, str]:
        if url.startswith("git@"):
            host, _, rest = url[4:].partition(":")
            return host, rest.split("/")[0]
        parts = url.split("/")
        return parts[2], parts[3]

    def fail_next_clone(self) -> None:
        self.failing_clones = True

    async def _rpc_settingsGet(self, params: dict[str, Any]) -> dict[str, Any]:
        return copy.deepcopy(self.settings)

    async def _rpc_settingsSet(self, params: dict[str, Any]) -> dict[str, Any]:
        patch = params.get("patch") or {}
        for role_patch in patch.get("roles", []) or []:
            for role in self.settings["roles"]:
                if role["role"] == role_patch.get("role"):
                    role.update({k: v for k, v in role_patch.items() if k != "ping"})
        for key in ("retrieval", "storage", "charts"):
            if key in patch:
                self.settings[key].update(patch[key])
        return copy.deepcopy(self.settings)

    async def _rpc_rolePing(self, params: dict[str, Any]) -> dict[str, Any]:
        role_name = params.get("role")
        if role_name not in ("engineer", "teacher", "auditor", "watcher"):
            raise RpcError(ERR_INVALID_PARAMS, "unknown role", {"hint": "role must be engineer, teacher, auditor, or watcher."})
        if not params.get("confirm"):
            self._refuse_spend(
                "rolePing",
                "A role ping is a real provider generation and costs money. It only ever "
                "runs when you ask for it, never on a screen opening.",
            )
        role = next(entry for entry in self.settings["roles"] if entry["role"] == role_name)
        # The watcher's endpoint rate limits, which is the interesting case: a
        # failed ping is still a completed call, not an error response.
        if role_name == "watcher":
            ping = {"httpStatus": 429, "ttftMs": None, "latencyMs": 812, "servedModelId": None}
        else:
            ping = {
                "httpStatus": 200,
                "ttftMs": 486,
                "latencyMs": 2_014,
                # The served id is the identity check. The auditor's endpoint
                # answers with a dated build, which is a drift the TUI shows.
                "servedModelId": "gpt-5.2-2026-05-01" if role_name == "auditor" else role.get("model"),
            }
        record = {"ok": ping["httpStatus"] == 200, **ping, "at": "2026-08-16T09:30:00Z"}
        role["ping"] = record
        # The daemon returns the STORED record (contract, 2026-08-17): ok and
        # at ride along, so a client can render the result without re-reading
        # settings first.
        return dict(record)

    async def _rpc_agentCatalog(self, params: dict[str, Any]) -> dict[str, Any]:
        """Zero-spend sub-agent discovery, mirrored from the daemon.

        A directory listing and a frontmatter read on the real engine; a
        constant here, shape-faithful and branch-complete (user and project
        scope, model present and absent).
        """
        return copy.deepcopy(mock_data.AGENT_CATALOG)

    async def _rpc_systemCheck(self, params: dict[str, Any]) -> dict[str, Any]:
        """The tool-wide watcher sweep, mirrored from the daemon.

        Branch-complete: a finding with an install fix, one with the zai
        realm-trap endpoint fix, and one with no fix at all.
        """
        return copy.deepcopy(mock_data.SYSTEM_CHECK)

    async def _rpc_systemFix(self, params: dict[str, Any]) -> dict[str, Any]:
        fix_id = params.get("fixId")
        catalog = {"install-pnpm", "install-yarn", "zai-coding-endpoint"}
        if fix_id not in catalog:
            raise RpcError(ERR_INVALID_PARAMS, "unknown fix", {
                "hint": f"fixId must be one of: {', '.join(sorted(catalog))}. The fix catalog is closed on purpose.",
            })
        if params.get("confirm") is not True:
            raise RpcError(ERR_INVALID_PARAMS, "not confirmed", {
                "hint": "This changes the machine or its settings, so it needs confirm: true from an explicit user action.",
            })
        if fix_id == "zai-coding-endpoint":
            role = params.get("role")
            names = [entry["role"] for entry in self.settings["roles"]]
            if role not in names:
                raise RpcError(ERR_INVALID_PARAMS, "unknown role", {"hint": f"role must be one of {', '.join(names)}."})
            for entry in self.settings["roles"]:
                if entry["role"] == role:
                    entry["endpoint"] = "https://api.z.ai/api/coding/paas/v4"
            return {"ok": True, "applied": fix_id, "detail": f"{role} endpoint set to https://api.z.ai/api/coding/paas/v4. Verify the role to confirm."}
        return {"ok": True, "applied": fix_id, "detail": "Install pnpm globally (npm install -g pnpm) succeeded. added 1 package"}

    async def _rpc_board(self, params: dict[str, Any]) -> dict[str, Any]:
        filters = params.get("filters") or {}
        rows = copy.deepcopy(self.board_rows)
        for field in ("source", "severity", "status", "category"):
            wanted = filters.get(field)
            if wanted and wanted != "all":
                rows = [row for row in rows if row.get(field) == wanted]
        return {"rows": rows, "total": len(self.board_rows)}

    async def _rpc_agentFileGet(self, params: dict[str, Any]) -> dict[str, Any]:
        role = params.get("role")
        record = self.agent_files.get(role)
        if record is None:
            raise RpcError(
                ERR_INVALID_PARAMS,
                "unknown role",
                {"hint": "role must be student, teacher, auditor, or watcher."},
            )
        return copy.deepcopy(record)

    async def _rpc_agentFileSet(self, params: dict[str, Any]) -> dict[str, Any]:
        role = params.get("role")
        record = self.agent_files.get(role)
        if record is None:
            raise RpcError(ERR_INVALID_PARAMS, "unknown role", {"hint": "role must be student, teacher, auditor, or watcher."})
        content = str(params.get("content") or "")
        record["content"] = content
        # A stand in for the engine's real hash; only its stability matters here.
        record["currentHash"] = f"sha256:{abs(hash(content)) % 0x1000000:06x}"
        record["modified"] = record["currentHash"] != record["defaultHash"]
        # settingsGet mirrors these files, so both views move together.
        for entry in self.settings.get("instructionFiles", []):
            if entry.get("name") == role:
                entry["hash"] = record["currentHash"]
                entry["modified"] = record["modified"]
        return copy.deepcopy(record)


class MockRpcClient(RpcClient):
    """In process client over a MockEngine.

    Requests and responses are serialized through JSON on the way in and out,
    so the mock path exercises the same encoding the stdio path does and no
    screen can accidentally hold a reference into the engine's own data.
    """

    def __init__(self, engine: MockEngine | None = None, **engine_kwargs: Any) -> None:
        super().__init__()
        self.engine = engine or MockEngine(**engine_kwargs)
        self.engine.emit = self._on_engine_event

    def _on_engine_event(self, envelope: dict[str, Any]) -> None:
        message = json.loads(
            json.dumps({"jsonrpc": "2.0", "method": envelope["method"], "params": envelope["params"]})
        )
        self.dispatch_notification(message["method"], message["params"])

    async def _call_impl(self, method: str, params: dict[str, Any] | None = None) -> Any:
        request = {
            "jsonrpc": "2.0",
            "id": self._request_id(),
            "method": method,
            "params": params or {},
        }
        response = await self.engine.handle(json.loads(json.dumps(request)))
        if response is None:
            return None
        return _unwrap(json.loads(json.dumps(response)))

    async def aclose(self) -> None:
        await self.engine.aclose()


async def serve_stdio(engine: MockEngine | None = None) -> None:
    """Run a MockEngine as a real stdio server.

    Lets the stdio client be exercised end to end without the Node engine:
        python -m daijin_tui.rpc
    """
    engine = engine or MockEngine()
    lock = asyncio.Lock()

    async def write(message: dict[str, Any]) -> None:
        async with lock:
            sys.stdout.write(json.dumps(message) + "\n")
            sys.stdout.flush()

    def emit(envelope: dict[str, Any]) -> Awaitable[None]:
        return write({"jsonrpc": "2.0", "method": envelope["method"], "params": envelope["params"]})

    engine.emit = emit
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        text = line.strip()
        if not text:
            continue
        try:
            message = json.loads(text)
        except json.JSONDecodeError:
            await write(
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {
                        "code": ERR_INVALID_REQUEST,
                        "message": "parse error",
                        "data": {"hint": "The engine could not parse that line as JSON."},
                    },
                }
            )
            continue
        response = await engine.handle(message)
        if response is not None:
            await write(response)
    await engine.aclose()


def _main(argv: Sequence[str]) -> None:  # pragma: no cover - process entry point
    speed = 1.0
    gate_open = False
    contract = mock_data.CONTRACT_VERSION
    for index, arg in enumerate(argv):
        if arg == "--speed" and index + 1 < len(argv):
            speed = float(argv[index + 1])
        elif arg == "--gate" and index + 1 < len(argv):
            gate_open = argv[index + 1] == "open"
        elif arg == "--contract" and index + 1 < len(argv):
            contract = argv[index + 1]
    asyncio.run(serve_stdio(MockEngine(speed=speed, gate_open=gate_open, contract_version=contract)))


if __name__ == "__main__":  # pragma: no cover - process entry point
    try:
        _main(sys.argv[1:])
    except KeyboardInterrupt:
        pass
