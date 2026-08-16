"""Copy constraints, checked against the rendered screen, not just the source.

The project forbids em dashes and en dashes. Source scanning alone misses the
ones a library injects, so this walks every view and reads the composited text.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from conftest import goto, run_async, running_app

import daijin_tui

# Written as escapes so this file can scan itself without tripping its own check.
FORBIDDEN = ("\u2014", "\u2013")
SOURCE_ROOT = Path(daijin_tui.__file__).parent
PROJECT_ROOT = SOURCE_ROOT.parent


def composited_text(app) -> str:
    strips = app.screen._compositor.render_strips()
    return "\n".join("".join(segment.text for segment in strip) for strip in strips)


TRACKED_FILES = (
    sorted(SOURCE_ROOT.rglob("*.py"))
    + sorted(SOURCE_ROOT.rglob("*.tcss"))
    + sorted((PROJECT_ROOT / "tests").rglob("*.py"))
    + [PROJECT_ROOT / "README.md", PROJECT_ROOT / "pyproject.toml"]
)


@pytest.mark.parametrize("path", TRACKED_FILES)
def test_source_carries_no_em_or_en_dash(path):
    text = path.read_text(encoding="utf-8")
    for dash in FORBIDDEN:
        assert dash not in text, f"{path} contains {dash!r}"


@pytest.mark.parametrize("key", ["1", "2", "3", "4", "5", "6", "7", "8"])
@run_async
async def test_rendered_screen_carries_no_em_or_en_dash(key):
    async with running_app() as (app, pilot):
        await goto(pilot, key)
        rendered = composited_text(app)
        for dash in FORBIDDEN:
            assert dash not in rendered, f"mode {app.current_mode} rendered {dash!r}"
