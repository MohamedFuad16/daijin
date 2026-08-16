"""The Daijin app shell.

Boot flow follows the owner's clarification: `daijin .` opens the repo home,
and settings is reachable from every screen. Eight views, all reachable by a
number key and by a click on the nav bar.

Two things live at the app level rather than on a screen. The contract
handshake, because a version mismatch has to stop the whole shell rather than
break one view. And boardFinding notifications, because they are not job
scoped, arrive with no job running, and a critical one has to reach the user on
whatever screen they happen to be looking at.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from textual.app import App
from textual.binding import Binding

from . import mock_data
from .rpc import (
    SUPPORTED_CONTRACT_VERSION,
    MockEngine,
    MockRpcClient,
    RpcClient,
    RpcError,
    SocketRpcClient,
    StdioRpcClient,
    default_socket_path,
)
from .screens import (
    BoardScreen,
    BrainScreen,
    ExamsScreen,
    GatesScreen,
    GymScreen,
    InitFeedScreen,
    RepoHomeScreen,
    SettingsScreen,
    UpgradeScreen,
)


# daemon.js is the PROCESS entry point. server.js is the library it imports:
# launching that gets a process that exits 0 without ever answering, which is a
# silent failure a first-run user cannot diagnose.
ENGINE_COMMAND = "node engine/src/rpc/daemon.js"
DEFAULT_STATE_ROOT = "~/.daijin"


class DaijinApp(App):
    """Pure client. Every number it shows came from an RPC result."""

    # Absolute so a subclass defined outside this package still finds the sheet.
    CSS_PATH = str(Path(__file__).with_name("daijin.tcss"))
    TITLE = "Daijin"

    MODES = {
        "home": RepoHomeScreen,
        "init": InitFeedScreen,
        "brain": BrainScreen,
        "gates": GatesScreen,
        "gym": GymScreen,
        "exams": ExamsScreen,
        "board": BoardScreen,
        "settings": SettingsScreen,
    }

    BINDINGS = [
        Binding("q", "quit", "Quit", priority=True),
        Binding("question_mark", "help_panel", "Keys", show=True),
    ]

    def __init__(self, client: RpcClient, *, is_mock: bool = False, repo: str | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.client = client
        self.is_mock = is_mock
        self.selected_repo = repo
        self.critical_findings: list[dict[str, Any]] = []
        # Textual's header joins title and sub_title with an em dash, which this
        # project forbids, so the engine mode rides inside the title instead.
        self.title = "Daijin, mock engine" if is_mock else "Daijin, engine over stdio"

    async def on_mount(self) -> None:
        await self.client.start()
        try:
            await self.client.handshake()
        except (RpcError, Exception) as error:  # noqa: BLE001 - any failure is a hard stop
            self.contract_error = error
        if not self.client.contract_matches:
            await self.push_screen(
                UpgradeScreen(
                    engine_version=self.client.engine_version,
                    contract_version=self.client.contract_version,
                )
            )
            return
        self.client.on_board_finding(self._on_board_finding)
        self.switch_mode("home")

    async def on_unmount(self) -> None:
        await self.client.aclose()

    def _on_board_finding(self, finding: dict[str, Any]) -> None:
        """Critical findings interrupt; everything else waits on the board."""
        if str(finding.get("severity")) != "critical":
            return
        self.critical_findings.append(finding)
        self.bell()
        self.notify(
            f"{finding.get('summary') or finding.get('category', 'finding')}\n"
            f"target {finding.get('target')}, evidence {finding.get('evidence')}",
            title="critical finding",
            severity="error",
            timeout=15,
        )

    def action_help_panel(self) -> None:
        self.action_show_help_panel()


def build_client(args: argparse.Namespace) -> tuple[RpcClient, bool]:
    if args.socket:
        # Attach to a running daemon, or start one and attach to that. Several
        # windows then share one engine, which is the whole point: stdio is
        # parent-child and a second window cannot share the pipe.
        command = (args.engine or ENGINE_COMMAND).split() + [
            f"--state-root={args.state_root}",
            "--socket",
        ]
        return (
            SocketRpcClient(
                default_socket_path(args.state_root), spawn_command=command
            ),
            False,
        )
    if args.engine:
        return StdioRpcClient(args.engine.split()), False
    engine = MockEngine(
        speed=args.mock_speed,
        gate_open=args.mock_gate == "open",
        contract_version=args.mock_contract,
    )
    return MockRpcClient(engine), True


def resolve_repo(requested: str, is_mock: bool) -> str | None:
    """Pick the repo the app opens on.

    The mock engine only knows its own fixture paths, so a real path handed to
    the mock falls back to the first fixture rather than showing an empty home.
    """
    if not is_mock:
        return requested
    known = {repo["path"] for repo in mock_data.REPOS}
    if requested in known:
        return requested
    return mock_data.REPOS[0]["path"]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="daijin",
        description="Daijin terminal client for the project brain engine.",
    )
    parser.add_argument("repo", nargs="?", default=".", help="repo to open, default the working directory")
    parser.add_argument("--mock", action="store_true", help="run against the bundled mock engine, no network, no spend")
    parser.add_argument(
        "--mock-speed",
        type=float,
        default=1.0,
        help="multiplier on the mock step-event stream timing, 0 emits instantly",
    )
    parser.add_argument(
        "--mock-gate",
        choices=("open", "blocked"),
        default="blocked",
        help="simulated owner spend gate for the mock engine, blocked by default",
    )
    parser.add_argument(
        "--mock-contract",
        default=SUPPORTED_CONTRACT_VERSION,
        help="contract version the mock reports, for exercising the upgrade screen",
    )
    parser.add_argument(
        "--socket",
        action="store_true",
        help="attach to a shared daemon over a unix socket, spawning one if none is running",
    )
    parser.add_argument(
        "--state-root",
        default=DEFAULT_STATE_ROOT,
        help=f"where attached repos, settings and the socket live, default {DEFAULT_STATE_ROOT}",
    )
    parser.add_argument(
        "--engine",
        default=None,
        help=f"command that starts the engine daemon on stdio, for example {ENGINE_COMMAND!r}",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.mock and not args.engine and not args.socket:
        print(
            "The engine is not wired yet. Run the shell against the bundled mock:\n"
            "  daijin . --mock\n"
            "or point it at the engine daemon:\n"
            f"  daijin . --engine '{ENGINE_COMMAND}'\n"
            "or share one daemon across windows:\n"
            "  daijin . --socket",
            file=sys.stderr,
        )
        return 2
    client, is_mock = build_client(args)
    app = DaijinApp(client, is_mock=is_mock, repo=resolve_repo(args.repo, is_mock))
    app.run()
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
