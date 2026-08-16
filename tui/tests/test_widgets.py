"""Widget level tests. Every chart exposes a pure renderer, so no app is needed."""

from __future__ import annotations

import pytest

from daijin_tui.widgets.activity import SPINNER_FRAMES, EventLog, PhaseChecklist
from daijin_tui.widgets.charts import plot_bar, plot_line
from daijin_tui.widgets.common import (
    case_rate_value,
    format_case_rate,
    format_duration,
    format_ratio,
    health_glyph,
)
from daijin_tui.widgets.radar import BrailleCanvas, bar_lines, radar_lines
from daijin_tui.widgets.sparkline import sparkline

AXES = [
    {"name": "correctness", "score": 0.82, "max": 1.0},
    {"name": "integration", "score": 0.74, "max": 1.0},
    {"name": "conventions", "score": 0.91, "max": 1.0},
    {"name": "evidence", "score": 0.63, "max": 1.0},
    {"name": "restraint", "score": 0.88, "max": 1.0},
]


def test_sparkline_maps_low_to_low_and_high_to_high():
    line = sparkline([0.1, 0.5, 0.9])
    assert len(line) == 3
    assert line[0] == "▁"
    assert line[-1] == "█"


def test_sparkline_renders_a_gap_for_a_missing_point():
    assert sparkline([1.0, None, 2.0])[1] == " "


def test_sparkline_keeps_the_most_recent_window():
    assert sparkline([0, 1, 2, 3, 4, 5], width=3) == sparkline([3, 4, 5])


def test_sparkline_of_an_empty_series_is_empty():
    assert sparkline([]) == ""


def test_braille_canvas_sets_the_expected_dot():
    canvas = BrailleCanvas(1, 1)
    canvas.set(0, 0)
    assert canvas.lines() == ["⠁"]


def test_radar_draws_a_canvas_and_a_legend_naming_every_axis():
    lines = radar_lines(AXES, 24, 6)
    canvas = lines[:6]
    assert len(canvas) == 6
    assert any(char not in " ⠀" for line in canvas for char in line), "radar canvas is blank"
    legend = lines[-2]
    for axis in AXES:
        assert axis["name"] in legend


def test_radar_canvas_actually_reflects_the_scores():
    """Guards against a radar that draws only its grid and ignores the data."""
    low = [{"name": axis["name"], "score": 0.05, "max": 1.0} for axis in AXES]
    high = [{"name": axis["name"], "score": 0.95, "max": 1.0} for axis in AXES]
    low_canvas = radar_lines(low, 24, 6)[:6]
    high_canvas = radar_lines(high, 24, 6)[:6]
    assert low_canvas != high_canvas
    assert radar_lines(AXES, 24, 6)[:6] not in (low_canvas, high_canvas)


def test_bar_fallback_shows_one_row_per_axis_with_the_value():
    lines = bar_lines(AXES, width=50)
    assert len(lines) == len(AXES)
    assert lines[0].strip().startswith("correctness")
    assert lines[0].endswith("0.82")


def test_a_higher_score_fills_more_of_its_bar():
    low = bar_lines([{"name": "a", "score": 0.1, "max": 1.0}], width=40)[0]
    high = bar_lines([{"name": "a", "score": 0.9, "max": 1.0}], width=40)[0]
    assert high.count("█") > low.count("█")


def test_plotext_bar_and_line_render_something():
    bar = plot_bar(["1", "2", "3"], [10, 20, 30], title="tokens", width=40, height=10)
    line = plot_line([1, 2, 3], {"tokens": [10, 20, 30]}, title="trend", width=40, height=10)
    assert bar.strip()
    assert line.strip()


def test_plot_helpers_fall_back_rather_than_render_nothing():
    assert plot_bar([], [], width=30) == "no data"


def test_phase_checklist_advances_and_finishes():
    clock = iter([0.0, 1.0, 2.0, 3.0, 4.0] + [9.0] * 40)
    checklist = PhaseChecklist(
        [("alpha", "Alpha"), ("beta", "Beta")], clock=lambda: next(clock)
    )
    assert checklist.state["alpha"]["status"] == "pending"
    checklist.apply_event({"jobId": "job-1", "phase": "alpha", "step": "s", "detail": "d", "counts": {"n": 2}, "level": "info"})
    assert checklist.state["alpha"]["status"] == "active"
    assert checklist.state["alpha"]["counts"] == {"n": 2}
    assert checklist.job_id == "job-1"
    checklist.apply_event({"jobId": "job-1", "phase": "beta", "step": "s", "detail": "d", "level": "warn"})
    assert checklist.state["alpha"]["status"] == "done"
    assert checklist.state["beta"]["warns"] == 1
    checklist.apply_event({"jobId": "job-1", "phase": "done", "step": "complete", "detail": "", "level": "info"})
    assert checklist.state["beta"]["status"] == "warn"
    assert checklist.running is False
    assert checklist.finished_at is not None


def test_phase_checklist_appends_a_phase_the_client_did_not_know_about():
    checklist = PhaseChecklist([("alpha", "Alpha")], clock=lambda: 0.0)
    checklist.apply_event({"jobId": "j", "phase": "surprise", "step": "s", "detail": "", "level": "info"})
    assert "surprise" in checklist.order
    assert checklist.state["surprise"]["status"] == "active"


def test_phase_checklist_snapshot_shows_the_spinner_and_the_counts():
    checklist = PhaseChecklist([("alpha", "Alpha")], clock=lambda: 0.0)
    checklist.apply_event({"jobId": "j", "phase": "alpha", "step": "s", "detail": "reading", "counts": {"units": 18}, "level": "info"})
    lines = checklist.snapshot_lines()
    assert "phase 0/1" in lines[0]
    assert "Alpha" in lines[1]
    assert "units 18" in lines[1]
    assert lines[1][0] in SPINNER_FRAMES


def test_phase_checklist_reset_clears_every_phase():
    checklist = PhaseChecklist([("alpha", "Alpha")], clock=lambda: 0.0)
    checklist.apply_event({"jobId": "j", "phase": "alpha", "step": "s", "detail": "x", "level": "info"})
    checklist.reset("job-2")
    assert checklist.state["alpha"]["status"] == "pending"
    assert checklist.job_id == "job-2"


def test_event_log_formats_a_step_event_with_its_counts():
    line = EventLog.format_event(
        {"ts": 4500, "jobId": "j", "phase": "brain", "step": "layer1", "detail": "cards", "counts": {"units": 18}, "level": "info"}
    )
    assert "4.50s" in line
    assert "brain" in line and "layer1" in line and "cards" in line
    assert "units 18" in line


def test_case_rate_is_rendered_as_a_count_not_a_percentage():
    case_rate = {"exact": 31 / 34, "cases": "31 of 34"}
    rendered = format_case_rate(case_rate)
    assert rendered == "31 of 34"
    assert "%" not in rendered


def test_case_rate_value_accepts_both_json_forms_of_exact():
    """The contract calls exact the rational value without fixing its type."""
    assert case_rate_value({"exact": 0.5, "cases": "1 of 2"}) == 0.5
    assert case_rate_value({"exact": "31/34", "cases": "31 of 34"}) == pytest.approx(31 / 34)
    assert case_rate_value({"exact": "0.75", "cases": "3 of 4"}) == 0.75
    assert case_rate_value(0.9) == 0.9
    assert case_rate_value(None) is None
    assert case_rate_value({"exact": "nonsense"}) is None


def test_a_case_rate_with_no_count_form_says_so_rather_than_rounding():
    rendered = format_case_rate({"exact": 31 / 34})
    assert "denominator not reported" in rendered
    assert "%" not in rendered
    assert format_case_rate(None) == "not measured"


def test_formatters():
    assert format_duration(1_733) == "28m 53s"
    assert format_ratio(31 / 34) == "0.9118"
    assert format_ratio(None) == "not measured"
    assert health_glyph("ok")[1] == "health-ok"
    assert health_glyph(None)[1] == "health-none"
