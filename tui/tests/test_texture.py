"""One texture language: pattern and colour as two independent channels.

The owner asked the charts to read like the dashboard, where every fill is a
pattern rather than a colour slab. The property that makes that worth doing is
that a reader with no colour still tells the series apart, so these tests
assert on the GLYPHS, which is the channel colour cannot carry.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from daijin_tui.widgets import texture as T
from daijin_tui.widgets.dither import DitherBars, StippleLine

PACKAGE = Path(__file__).resolve().parents[1] / "daijin_tui"


# Two channels ---------------------------------------------------------------


def test_every_texture_is_distinguishable_without_colour():
    """The point of the exercise: pattern alone must separate the series."""
    swatches = [t.swatch for t in T.TEXTURES.values()]
    assert len(set(swatches)) == len(swatches), f"two series share a swatch: {swatches}"
    caps = [t.cap for t in T.TEXTURES.values() if t is not T.NEUTRAL]
    assert len(set(caps)) == len(caps), "two outcome series share a cap glyph"


def test_every_texture_is_also_distinguishable_by_colour():
    outcomes = [T.PASS, T.PARTIAL, T.FAIL, T.UNGRADED]
    colors = [t.color for t in outcomes]
    assert len(set(colors)) == len(colors), "the colour channel duplicates"


def test_a_texture_keeps_its_identity_at_its_cap():
    """A hatched bar capped with a block would lose what names it."""
    assert "╱" in T.FAIL.ramp and T.FAIL.cap in ("╱", "╳")
    assert T.PASS.cap == "█"
    assert T.PARTIAL.cap.startswith("⠿") or T.PARTIAL.cap in T.PARTIAL.ramp + ("⠿",)


def test_an_unknown_verdict_is_not_a_pass():
    assert T.texture_for_verdict("pass") is T.PASS
    assert T.texture_for_verdict("partial") is T.PARTIAL
    assert T.texture_for_verdict("fail") is T.FAIL
    for unknown in (None, "", "weird", "PASSED"):
        assert T.texture_for_verdict(unknown) is T.UNGRADED


# The fill --------------------------------------------------------------------


def test_bars_are_textured_rather_than_solid_slabs():
    rows = T.dither_columns([9], [T.PASS], height=6, width=2)
    glyphs = {ch for row in rows for ch in row if ch != " "}
    assert len(glyphs) > 1, f"the bar is a solid slab of {glyphs}"
    assert glyphs <= set(T.PASS.ramp) | {T.PASS.cap}


def test_a_bar_is_capped_and_denser_toward_the_baseline():
    rows = [r for r in T.dither_columns([9], [T.PASS], height=6, width=1) if r.strip()]
    assert rows[0] == T.PASS.cap, "no solid top edge"
    ranks = [T.PASS.ramp.index(r) for r in rows[1:] if r in T.PASS.ramp]
    assert ranks == sorted(ranks), f"density is not monotone toward the baseline: {ranks}"


def test_two_series_never_render_the_same_glyphs():
    a = set("".join(T.dither_columns([9], [T.PASS], height=6, width=1)).strip())
    b = set("".join(T.dither_columns([9], [T.FAIL], height=6, width=1)).strip())
    assert not (a & b), f"pass and fail share glyphs {a & b}"


def test_bar_heights_track_their_values():
    rows = T.dither_columns([10, 5], [T.NEUTRAL, T.NEUTRAL], height=10, width=1, gap=1)
    tall = sum(1 for row in rows if row[:1].strip())
    short = sum(1 for row in rows if len(row) > 2 and row[2:3].strip())
    assert tall > short, f"the taller value did not draw a taller bar ({tall} vs {short})"


def test_an_outcome_series_draws_a_fail_rather_than_nothing():
    """Zero height reads as a missing attempt, not a failed one."""
    without = T.stipple_area([0.0, 1.0], height=4, textures=[T.FAIL, T.PASS])
    with_floor = T.stipple_area([0.0, 1.0], height=4, textures=[T.FAIL, T.PASS], min_column=1)
    assert not any(T.FAIL.cap in row or "╱" in row for row in without)
    assert any(T.FAIL.cap in row or "╱" in row for row in with_floor), (
        "a failed attempt is invisible, which reads as a missing one"
    )


def test_the_legend_shows_patterns_not_colours():
    text = T.legend([T.PASS, T.FAIL])
    assert T.PASS.swatch in text and T.FAIL.swatch in text
    assert "pass" in text and "fail" in text


# One vocabulary --------------------------------------------------------------


def test_no_chart_invents_its_own_glyphs():
    """A second vocabulary is no vocabulary, the motion.py rule for texture."""
    known = set()
    for tex in T.TEXTURES.values():
        known.update(tex.ramp)
        known.update({tex.cap, tex.swatch})
    offenders = []
    for path in sorted((PACKAGE / "widgets").glob("*.py")) + sorted((PACKAGE / "screens").glob("*.py")):
        if path.name in ("texture.py", "sparkline.py", "radar.py", "common.py", "gauge.py", "charts.py"):
            continue
        source = path.read_text(encoding="utf-8")
        for literal in re.findall(r'"([░▒▓█⠂⠒⠶⠿╱╳·∙•]+)"', source):
            if not set(literal) <= known:
                offenders.append(f"{path.name}: {literal!r}")
    assert not offenders, offenders


# Through the renderer --------------------------------------------------------


def test_the_widget_renders_the_texture_the_data_asks_for():
    """Asserted through render(), not through the table it reads."""
    bars = DitherBars(height=6, bar_width=1)
    bars.set_data(["1", "2"], [10, 10], [T.PASS, T.FAIL])
    rendered = str(bars.render())
    assert T.PASS.cap in rendered and T.FAIL.cap in rendered
    assert "pass" in rendered and "fail" in rendered, "no legend"


def test_the_widget_says_no_data_rather_than_drawing_an_empty_frame():
    assert "no data" in str(DitherBars().render())
    assert "no data" in str(StippleLine().render())


def test_the_stipple_widget_carries_per_point_textures_through_render():
    line = StippleLine(height=4)
    line.set_data([0.0, 1.0], textures=[T.FAIL, T.PASS], min_column=1)
    rendered = str(line.render())
    assert T.PASS.cap in rendered
    assert "╱" in rendered or T.FAIL.cap in rendered


# The radar interior ----------------------------------------------------------


def _lit(lines: list[str]) -> int:
    """Count braille dots actually set, across the canvas rows."""
    total = 0
    for line in lines:
        for ch in line:
            code = ord(ch) - 0x2800
            if 0 < code < 256:
                total += bin(code).count("1")
    return total


def test_the_radar_interior_is_filled_rather_than_a_bare_wire():
    from daijin_tui.widgets.radar import radar_lines

    axes = [{"name": f"a{i}", "score": 5, "max": 5} for i in range(5)]
    canvas = radar_lines(axes, 26, 8)[:8]
    # Measured, not guessed: rings, spokes and outline alone light 137 dots at
    # this size; with the interior stipple it is 249. 200 sits between them
    # with margin on both sides.
    assert _lit(canvas) > 200, f"only {_lit(canvas)} dots set, the interior is empty"


def test_a_bigger_score_encloses_more_texture():
    from daijin_tui.widgets.radar import radar_lines

    small = [{"name": f"a{i}", "score": 1, "max": 5} for i in range(5)]
    large = [{"name": f"a{i}", "score": 5, "max": 5} for i in range(5)]
    # Measured: 249 dots at full score against 150 at one fifth, a ratio of
    # 1.66. The grid and spokes are common to both, which is why the ratio is
    # well under the ratio of the areas.
    assert _lit(radar_lines(large, 26, 8)[:8]) > _lit(radar_lines(small, 26, 8)[:8]) * 1.4, (
        "the fill does not track the scores, so area says nothing"
    )


def test_the_interior_is_a_stipple_not_a_slab():
    """A solid fill would hide a second radar drawn over it."""
    from daijin_tui.widgets.radar import radar_lines

    axes = [{"name": f"a{i}", "score": 5, "max": 5} for i in range(5)]
    canvas = radar_lines(axes, 26, 8)[:8]
    full_cells = sum(1 for line in canvas for ch in line if ord(ch) - 0x2800 == 255)
    # Measured: the stipple lights zero fully-solid cells; removing the stride
    # that makes it a stipple lights 48 of 208. Ten is comfortably between.
    assert full_cells < 10, (
        f"{full_cells} cells are fully lit; that is a slab, and a slab hides "
        "anything drawn over it"
    )


def test_every_documented_verdict_has_its_own_look_and_is_reachable():
    """Locked in contract v5: pass | partial | fail | unsubmitted.

    unsubmitted used to fall through to "not graded", giving it the same swatch
    as an attempt whose verdict was never recorded. Those are different facts:
    one was never handed in, the other was handed in and never judged.
    """
    from daijin_tui import mock_data
    from daijin_tui.widgets.texture import texture_for_verdict

    documented = ("pass", "partial", "fail", "unsubmitted")
    textures = {value: texture_for_verdict(value) for value in documented}
    swatches = {value: tx.swatch for value, tx in textures.items()}
    assert len(set(swatches.values())) == len(documented), f"two verdicts share a swatch: {swatches}"
    labels = {tx.label for tx in textures.values()}
    assert "not graded" not in labels, "a documented verdict is rendered as an absent one"

    # A pattern reader with no colour must still tell them apart.
    ramps = {value: tuple(tx.ramp) for value, tx in textures.items()}
    assert len(set(ramps.values())) == len(documented), f"two verdicts share a pattern: {ramps}"

    unknown = texture_for_verdict("banana")
    assert unknown.swatch not in swatches.values(), "an unknown verdict borrowed a documented one's swatch"
    assert unknown.label == "not graded"

    seen = set()
    for exam in mock_data.EXAM_DETAIL.values():
        for attempt in exam.get("attempts") or []:
            seen.add(attempt.get("verdict"))
    missing = set(documented) - seen
    assert not missing, f"the mock never produces these, so their rendering rots: {missing}"
