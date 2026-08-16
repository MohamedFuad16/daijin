"""Motion: one source of timings, three modes, and a burst that stays smooth.

The tests the brief asks for: no stray durations outside motion.py, zero
animator invocations when motion is off, and a burst rendered as a handful of
repaints rather than one per event. End states only, never mid-frame.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from conftest import run_async, running_app, settle

from daijin_tui import motion as M
from daijin_tui.stream import FLUSH_INTERVAL, StreamCoalescer

PACKAGE = Path(__file__).resolve().parents[1] / "daijin_tui"


# One source of truth -------------------------------------------------------


def test_no_stray_durations_outside_motion():
    """A timing at a call site is a timing nobody can tune or turn off."""
    offenders = []
    for path in sorted(PACKAGE.rglob("*.py")):
        if path.name == "motion.py":
            continue
        source = path.read_text(encoding="utf-8")
        for match in re.finditer(r"\.animate\((?P<args>[^)]*)\)", source, re.S):
            if "duration=" in match.group("args"):
                offenders.append(f"{path.name}: animate() with its own duration")
        # A raw easing string is the same problem wearing different clothes.
        for easing in ("in_out_cubic", "out_expo", "out_cubic", "in_expo"):
            if f'"{easing}"' in source:
                offenders.append(f"{path.name}: hardcodes the easing {easing!r}")
    assert not offenders, offenders


def test_the_duration_tokens_sit_in_the_briefed_bands():
    assert 0.12 <= M.DURATIONS[M.MICRO] <= 0.20
    assert 0.25 <= M.DURATIONS[M.VIEW] <= 0.35
    assert 0.40 <= M.DURATIONS[M.REVEAL] <= 0.60


def test_press_feedback_lands_inside_the_window_that_feels_caused():
    assert M.PRESS_FEEDBACK < 0.1


# The three modes -----------------------------------------------------------


class Recorder:
    """Stands in for a widget, counting animate calls and final values."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.value = 0.0

    def animate(self, attribute, value, *, duration, easing, on_complete=None):
        self.calls.append({"attribute": attribute, "value": value, "duration": duration, "easing": easing})
        setattr(self, attribute, value)
        if on_complete:
            on_complete()


@pytest.mark.parametrize("mode", M.MODES)
def test_every_mode_reaches_the_same_end_state(mode):
    """Motion changes how the UI gets somewhere, never where it ends up."""
    motion = M.Motion(mode)
    widget = Recorder()
    motion.animate(widget, "value", 42.0, token=M.REVEAL, decorative=True)
    assert widget.value == 42.0, f"{mode} did not reach the end state"


def test_off_starts_no_animation_at_all():
    motion = M.Motion(M.OFF)
    widget = Recorder()
    for decorative in (True, False):
        motion.animate(widget, "value", 1.0, decorative=decorative)
    assert motion.invocations == 0, "motion off started an animation"
    assert widget.calls == [], "the animator was called with motion off"
    assert motion.skipped == 2


def test_reduced_keeps_the_cues_that_carry_information():
    motion = M.Motion(M.REDUCED)
    widget = Recorder()
    motion.animate(widget, "value", 1.0, decorative=True)
    assert motion.invocations == 0, "reduced ran a decorative animation"
    motion.animate(widget, "value", 2.0, decorative=False)
    assert motion.invocations == 1, "reduced dropped a cue that carries state"


def test_full_animates_both_kinds():
    motion = M.Motion(M.FULL)
    widget = Recorder()
    motion.animate(widget, "value", 1.0, decorative=True)
    motion.animate(widget, "value", 2.0, decorative=False)
    assert motion.invocations == 2
    assert all(call["duration"] > 0 for call in widget.calls)


def test_an_unknown_mode_falls_back_rather_than_disabling_motion():
    assert M.Motion("sideways").mode == M.DEFAULT_MODE


# The setting ---------------------------------------------------------------


@run_async
async def test_the_app_takes_its_motion_mode_from_settings():
    async with running_app() as (app, pilot):
        assert app.motion.mode == "full"
        await app.client.call("settingsSet", {"patch": {"charts": {"motion": "off"}}})
        settings = await app.client.call("settingsGet", {})
        assert settings["charts"]["motion"] == "off"


@run_async
async def test_motion_off_across_every_view_starts_nothing():
    """The zero-invocation assertion, driven through the real app."""
    async with running_app() as (app, pilot):
        app.motion.set_mode(M.OFF)
        app.motion.invocations = 0
        for key in "12345678":
            await pilot.press(key)
            await settle(pilot)
            await app.screen.wait_for_load()
        assert app.motion.invocations == 0, (
            f"motion off, yet {app.motion.invocations} animations were started"
        )


# Backpressure --------------------------------------------------------------


def test_a_burst_costs_a_handful_of_flushes_not_one_per_event():
    batches: list[list[dict]] = []
    clock = iter([0.0] + [0.001 * i for i in range(1, 500)])
    coalescer = StreamCoalescer(batches.append, interval=1.0, clock=lambda: next(clock, 999.0))
    for i in range(200):
        coalescer.push({"n": i})
    coalescer.flush()
    assert coalescer.received == 200
    assert coalescer.flushes <= 3, f"200 events cost {coalescer.flushes} repaints"
    assert sum(len(b) for b in batches) == 200, "events were dropped"


def test_a_slow_stream_is_never_delayed_by_the_coalescer():
    """The first event after a quiet spell goes straight through."""
    batches: list[list[dict]] = []
    ticks = iter([0.0, 10.0, 20.0, 30.0])
    coalescer = StreamCoalescer(batches.append, interval=1.0, clock=lambda: next(ticks, 99.0))
    for i in range(3):
        assert coalescer.push({"n": i}) is True
    assert coalescer.flushes == 3
    assert coalescer.pending == 0


def test_the_flush_interval_is_about_thirty_a_second():
    assert 1 / 45 <= FLUSH_INTERVAL <= 1 / 20


@run_async
async def test_an_instant_full_stream_stays_responsive_and_loses_nothing():
    """The mock at speed 0 emits the whole init stream in one tick."""
    async with running_app() as (app, pilot):
        await pilot.press("2")
        await settle(pilot)
        await app.screen.wait_for_load()
        screen = app.screen
        await pilot.click("#init-start")
        await settle(pilot, 16)
        screen.coalescer.flush()
        await settle(pilot)

        log = screen.query_one("#init-events")
        assert log.event_count == screen.coalescer.received, "events were lost"
        assert log.event_count > 30
        assert screen.coalescer.flushes < log.event_count, (
            "every event caused its own repaint; the coalescer did nothing"
        )
        # The end state is unaffected: the checklist still completed.
        checklist = screen.query_one("#init-checklist")
        assert checklist.finished_at is not None


# The gauge: motion that carries meaning ------------------------------------


@run_async
async def test_the_token_gauge_climbs_during_a_cycle_and_lands_on_the_value():
    from daijin_tui.screens.gym import GYM_TOKEN_BUDGET
    from daijin_tui.widgets import Gauge

    async with running_app(gate_open=True) as (app, pilot):
        await pilot.press("5")
        await settle(pilot)
        await app.screen.wait_for_load()
        app.motion.invocations = 0
        await pilot.click("#gym-start")
        await settle(pilot)
        await pilot.click("#spend-confirm")
        await settle(pilot, 16)
        app.screen.coalescer.flush()
        await settle(pilot)

        gauge = app.screen.query_one("#gym-tokens", Gauge)
        assert app.motion.invocations > 0, "the gauge jumped instead of climbing"
        # Whatever the path, it lands on the real value.
        assert gauge.target == pytest.approx(401_900 / GYM_TOKEN_BUDGET, rel=0.01)
        assert "401,900" in gauge.caption


@run_async
async def test_with_motion_off_the_gauge_still_lands_on_the_value():
    """Off changes the path, never the destination."""
    from daijin_tui.screens.gym import GYM_TOKEN_BUDGET
    from daijin_tui.widgets import Gauge

    async with running_app(gate_open=True) as (app, pilot):
        await pilot.press("5")
        await settle(pilot)
        await app.screen.wait_for_load()
        app.motion.set_mode(M.OFF)
        app.motion.invocations = 0
        await pilot.click("#gym-start")
        await settle(pilot)
        await pilot.click("#spend-confirm")
        await settle(pilot, 16)
        app.screen.coalescer.flush()
        await settle(pilot)

        gauge = app.screen.query_one("#gym-tokens", Gauge)
        assert app.motion.invocations == 0, "motion off started an animation"
        assert gauge.fraction == pytest.approx(401_900 / GYM_TOKEN_BUDGET, rel=0.01)


@run_async
async def test_an_extension_grant_pulses_once_and_reduced_drops_it():
    """The grant is already in the log; the pulse only draws the eye."""
    from daijin_tui.widgets import Gauge

    async with running_app(gate_open=True) as (app, pilot):
        await pilot.press("5")
        await settle(pilot)
        await app.screen.wait_for_load()
        gauge = app.screen.query_one("#gym-tokens", Gauge)

        app.motion.set_mode(M.REDUCED)
        app.motion.invocations = 0
        gauge.pulse(app.motion)
        assert app.motion.invocations == 0, "reduced kept a decorative pulse"

        app.motion.set_mode(M.FULL)
        app.motion.invocations = 0
        gauge.pulse(app.motion)
        assert app.motion.invocations >= 1


@run_async
async def test_motion_off_also_stops_the_css_transitions():
    """A mode that silenced only the animator would be half kept."""
    async with running_app() as (app, pilot):
        assert not app.has_class("-motion-off")
        app.set_motion_mode(M.OFF)
        await settle(pilot)
        assert app.has_class("-motion-off"), (
            "motion off did not reach the stylesheet, so buttons still animate"
        )
        app.set_motion_mode(M.FULL)
        await settle(pilot)
        assert not app.has_class("-motion-off")


def test_the_stylesheet_durations_come_from_the_tokens():
    """The CSS is generated from motion.py, so the two cannot drift."""
    css = (PACKAGE / "daijin.tcss").read_text()
    assert f"{int(M.DURATIONS[M.MICRO] * 1000)}ms" in css
    assert f"{int(M.PRESS_FEEDBACK * 1000)}ms" in css
