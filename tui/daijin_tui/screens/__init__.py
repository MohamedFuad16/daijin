"""Daijin screens. One module per view, all pure clients of the RPC surface."""

from .base import DaijinScreen, NavBar
from .board import BoardScreen
from .brain import BrainScreen
from .dialogs import AgentFileEditScreen, SpendConfirmScreen, TextPromptScreen
from .exams import ExamsScreen
from .gates import GatesScreen
from .gym import GymScreen
from .init_feed import InitFeedScreen
from .repo_home import RepoHomeScreen
from .settings import SettingsScreen
from .upgrade import UpgradeScreen

__all__ = [
    "AgentFileEditScreen",
    "BoardScreen",
    "BrainScreen",
    "DaijinScreen",
    "ExamsScreen",
    "GatesScreen",
    "GymScreen",
    "InitFeedScreen",
    "NavBar",
    "RepoHomeScreen",
    "SettingsScreen",
    "SpendConfirmScreen",
    "TextPromptScreen",
    "UpgradeScreen",
]
