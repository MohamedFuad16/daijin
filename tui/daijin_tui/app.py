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
from .motion import DEFAULT_MODE, OFF, Motion
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
    SplashScreen,
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

    def __init__(self, client: RpcClient, *, is_mock: bool = False, repo: str | None = None,
                 state_root: str | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.client = client
        self.is_mock = is_mock
        self.selected_repo = repo
        # Where client-side artifacts (pasted-key files) live. Follows
        # --state-root so tests and alternate roots never write to the real
        # home; the engine's own state lives under the same root.
        self.state_root = str(Path(state_root or DEFAULT_STATE_ROOT).expanduser())
        self.critical_findings: list[dict[str, Any]] = []
        # One Motion for the whole app: every animation goes through it, so
        # "off" is a single switch rather than a convention screens must keep.
        self.motion = Motion(DEFAULT_MODE)
        self.splash: Any = None
        # Set from the first serveStatus: nothing attached yet, so the home
        # screen opens on the attach affordance instead of empty space.
        self.first_run = False
        # THE TITLE IS THE BRAND, not the transport. The owner ruled the top
        # line carries the name and the tagline; how the engine is connected is
        # an engine-status fact and lives in that block on the home screen.
        # (mock mode still announces itself, because a demo must never pass as
        # the real thing.)
        self.title = "DAIJIN, a project brain for any repo" + (" [mock]" if is_mock else "")

    async def on_mount(self) -> None:
        # The splash is the loading screen. It goes up BEFORE the work starts
        # and comes down when the work ends, so its duration is startup's
        # duration and nothing waits on the animation. A failure below dismisses
        # it and shows the real error rather than leaving the brand on screen,
        # which would be the prettiest possible hang.
        splash = SplashScreen(motion=self.motion)
        self.splash = splash
        await self.push_screen(splash)
        splash.set_status("[dim]starting the engine[/dim]")
        await self.client.start()
        splash.set_status("[dim]handshaking[/dim]")
        try:
            await self.client.handshake()
        except Exception as error:  # noqa: BLE001 - any failure is a hard stop
            # A handshake that never completed says nothing about the contract
            # version. Falling through to the version check reported "port in
            # use" as "Contract version mismatch" and threw away the stderr
            # tail the transports go out of their way to preserve.
            self.contract_error = error
            await self._dismiss_splash()
            await self.push_screen(
                UpgradeScreen(
                    engine_version=self.client.engine_version,
                    contract_version=self.client.contract_version,
                    connection_error=str(error),
                )
            )
            return
        if not self.client.contract_matches:
            await self._dismiss_splash()
            await self.push_screen(
                UpgradeScreen(
                    engine_version=self.client.engine_version,
                    contract_version=self.client.contract_version,
                )
            )
            return
        # hello answered, so the status can stop naming steps and start
        # reporting what the engine actually said.
        splash.set_status(
            f"engine [b]{self.client.engine_version or 'unknown'}[/b], "
            f"contract [b]{self.client.contract_version or 'unknown'}[/b]"
        )
        self.client.on_board_finding(self._on_board_finding)
        await self._load_motion_mode()
        # The mode may have just changed under the splash, and a splash still
        # animating in `off` would be the setting being ignored.
        splash.motion = self.motion
        if self.motion.mode == OFF:
            splash.skip()
        await self._first_status(splash)
        await self._dismiss_splash()
        self.switch_mode("home")

    async def _first_status(self, splash: SplashScreen) -> None:
        """One serveStatus, so the splash reports a real world before it goes.

        This is also what decides where the transition lands: a user with no
        repos attached needs the attach affordance, not a screen of nothing.
        """
        try:
            status = await self.client.call("serveStatus", {})
        except Exception:  # noqa: BLE001 - the home screen reports this properly
            return
        repos = (status or {}).get("repos") or []
        ollama = ((status or {}).get("ollama") or {}).get("reachable")
        splash.set_status(
            f"engine [b]{self.client.engine_version or 'unknown'}[/b], "
            f"contract [b]{self.client.contract_version or 'unknown'}[/b], "
            f"{len(repos)} repo{'' if len(repos) == 1 else 's'} attached, "
            f"ollama {'reachable' if ollama else 'not reachable'}"
        )
        self.first_run = not repos

    async def _dismiss_splash(self) -> None:
        if getattr(self, "splash", None) is not None and self.splash in self.screen_stack:
            self.pop_screen()
        self.splash = None

    async def _load_motion_mode(self) -> None:
        """charts.motion is the user's accessibility setting, not a preference
        the app may quietly override."""
        try:
            settings = await self.client.call("settingsGet", {})
        except Exception:  # noqa: BLE001 - a missing setting must not stop boot
            return
        mode = ((settings or {}).get("charts") or {}).get("motion")
        if mode:
            self.set_motion_mode(str(mode))

    def set_motion_mode(self, mode: str) -> None:
        """Apply the mode to the animator AND to the stylesheet.

        CSS transitions do not run through Motion, so a mode that only silenced
        the animator would leave the interface still moving and the setting
        only half kept.
        """
        self.motion.set_mode(mode)
        self.set_class(self.motion.mode == OFF, "-motion-off")

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
    app = DaijinApp(client, is_mock=is_mock, repo=resolve_repo(args.repo, is_mock),
                    state_root=args.state_root)
    app.run()
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
