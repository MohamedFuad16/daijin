"""Widget level tests. Every chart exposes a pure renderer, so no app is needed."""

from __future__ import annotations

import pytest

from daijin_tui.widgets.activity import (
    IDLE_UNTIL_INFERRED,
    SPINNER_FRAMES,
    EventLog,
    PhaseChecklist,
)
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


def test_case_rate_is_rendered_as_count_and_percentage_together():
    """The owner overruled count-only display: the count stays authoritative
    (the denominator is the honesty), and the percentage rides beside it so
    the number is readable at a glance. Neither alone."""
    case_rate = {"exact": 31 / 34, "cases": "31 of 34"}
    rendered = format_case_rate(case_rate)
    assert rendered == "31 of 34 (91.2%)"


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
    assert format_case_rate(None) == "not measured"


def test_formatters():
    assert format_duration(1_733) == "28m 53s"
    assert format_ratio(31 / 34) == "0.9118"
    assert format_ratio(None) == "not measured"
    assert health_glyph("ok")[1] == "health-ok"
    # An undocumented or absent health gets its OWN badge rather than borrowing
    # the no-brain one: rendering "this repo has no brain" off a value nobody
    # understood is a claim, not a fallback.
    assert health_glyph(None)[1] == "health-unknown"
    assert health_glyph("no-brain")[1] == "health-none"
    assert health_glyph("critical")[1] == "health-critical"


def test_a_phase_that_never_ran_is_not_reported_as_done():
    """The client's phase list is a guess; the engine's pipeline is its own.

    Against the real engine the guessed manifest shares no phase names with
    what actually runs, so marking passed-over phases done claimed nine phases
    of work that never happened.
    """
    checklist = PhaseChecklist(
        [("alpha", "Alpha"), ("beta", "Beta"), ("gamma", "Gamma")], clock=lambda: 0.0
    )
    checklist.apply_event({"jobId": "j", "phase": "gamma", "step": "s", "detail": "", "level": "info"})
    assert checklist.state["gamma"]["status"] == "active"
    for skipped in ("alpha", "beta"):
        assert checklist.state[skipped]["status"] == "skipped", (
            f"{skipped} never emitted an event and must not read as done"
        )


def test_an_inferred_finish_says_it_was_inferred():
    """The stream has no terminal event, so completion is a client inference."""
    now = [0.0]
    checklist = PhaseChecklist([("alpha", "Alpha")], clock=lambda: now[0])
    checklist.apply_event({"jobId": "j", "phase": "alpha", "step": "s", "detail": "", "level": "info"})
    now[0] = 5.0
    assert checklist.infer_finish_if_idle() is False, "inferred a finish mid-run"
    now[0] = IDLE_UNTIL_INFERRED + 1
    assert checklist.infer_finish_if_idle() is True
    assert checklist.finish_is_inferred is True
    assert "inferred" in checklist.snapshot_lines()[0]


def test_a_reported_finish_is_not_labelled_inferred():
    checklist = PhaseChecklist([("alpha", "Alpha")], clock=lambda: 0.0)
    checklist.apply_event({"jobId": "j", "phase": "alpha", "step": "s", "detail": "", "level": "info"})
    checklist.apply_event({"jobId": "j", "phase": "done", "step": "complete", "detail": "", "level": "info"})
    assert checklist.finished_at is not None
    assert checklist.finish_is_inferred is False
    assert "inferred" not in checklist.snapshot_lines()[0]


def test_the_idle_threshold_clears_the_measured_worst_gap():
    """9.6s is the largest real gap seen on the P8 fixture, inside floor."""
    assert IDLE_UNTIL_INFERRED > 9.6 * 2, (
        f"{IDLE_UNTIL_INFERRED}s leaves no margin over the measured 9.6s gap; "
        "a live run would be declared finished in the middle of it"
    )


def test_a_notable_step_is_styled_by_name_not_by_level():
    """kept-yours reports generated work being discarded for the user's edit.

    It has to stand out, and it must not wear the warning colour: nothing went
    wrong when the engine honours an edit it promised to honour.
    """
    from daijin_tui.widgets.activity import LEVEL_STYLE

    # Asserted through the function the renderer actually calls, not through
    # the table: a table the renderer ignores is a table that proves nothing.
    kept = EventLog.style_for(
        {"step": "kept-yours", "level": "info", "phase": "classify", "detail": "", "ts": 0}
    )
    ordinary = EventLog.style_for(
        {"step": "classify", "level": "info", "phase": "classify", "detail": "", "ts": 0}
    )
    assert kept != ordinary, "kept-yours renders exactly like every other step"
    assert kept not in LEVEL_STYLE.values(), "it borrowed a level colour"
    assert "yellow" not in kept and "red" not in kept, (
        "a step the engine emits at the default level must not read as a warning"
    )
    # And the level still drives everything that has no name-based style.
    assert EventLog.style_for({"step": "x", "level": "warn"}) == LEVEL_STYLE["warn"]


def test_the_kept_yours_line_is_distinguishable_without_colour():
    line = EventLog.format_event(
        {
            "ts": 1000,
            "jobId": "j",
            "phase": "classify",
            "step": "kept-yours",
            "detail": "your gates.yaml wins; the discovered one was discarded",
            "level": "info",
        }
    )
    assert "kept-yours" in line
    assert "[keep]" in line, "no marker, so a reader without colour sees nothing special"
    assert "your gates.yaml wins" in line


def test_an_ordinary_step_keeps_its_level_styling_and_no_marker():
    line = EventLog.format_event(
        {"ts": 1000, "jobId": "j", "phase": "classify", "step": "classify", "detail": "eslint live", "level": "info"}
    )
    assert "[" not in line.split("classify", 2)[-1][:3]


def test_the_phase_says_it_ended_and_the_level_says_how():
    """Corrected in engine 9106794. This test used to encode the old reading.

    Keying on the step means enumerating an open set: finished, written,
    kept-yours, and whatever the next job names its ending. level is a closed
    set that is the same for every job, so the step is displayed and the level
    is what the branch reads. The step still appears, because "failed" is worth
    seeing; it is simply not what decides.
    """
    cases = (
        ("finished", "info", "complete"),
        ("written", "info", "complete"),
        ("kept-yours", "info", "complete"),
        ("cancelled", "warn", "stopped: cancelled"),
        ("failed", "error", "FAILED: failed"),
    )
    for step, level, expected in cases:
        checklist = PhaseChecklist([("alpha", "Alpha")], clock=lambda: 0.0)
        checklist.apply_event({"jobId": "j", "phase": "alpha", "step": "s", "detail": "", "level": "info"})
        checklist.apply_event({"jobId": "j", "phase": "done", "step": step, "detail": "", "level": level})
        assert checklist.finished_at is not None
        assert checklist.finish_is_inferred is False
        line = checklist.snapshot_lines()[0]
        assert expected in line, f"{step}/{level} rendered as {line}"

    # The point of reading level rather than the step: an ending this client
    # has never heard of still reports correctly, because level is closed.
    unknown = PhaseChecklist([("alpha", "Alpha")], clock=lambda: 0.0)
    unknown.apply_event({"jobId": "j", "phase": "alpha", "step": "s", "detail": "", "level": "info"})
    unknown.apply_event({"jobId": "j", "phase": "done", "step": "quiesced", "detail": "", "level": "error"})
    assert "FAILED" in unknown.snapshot_lines()[0], (
        "an ending name this client does not know broke the failure reporting, "
        "which is what enumerating the step would do"
    )


def test_a_failure_after_a_done_is_not_hidden():
    """A job that announces done and then throws sends a second done, failed.

    Suppressing it to keep the count at one would hide the thing most worth
    seeing, so the later step wins.
    """
    checklist = PhaseChecklist([("alpha", "Alpha")], clock=lambda: 0.0)
    checklist.apply_event({"jobId": "j", "phase": "alpha", "step": "s", "detail": "", "level": "info"})
    checklist.apply_event({"jobId": "j", "phase": "done", "step": "finished", "detail": "", "level": "info"})
    checklist.apply_event({"jobId": "j", "phase": "done", "step": "failed", "detail": "boom", "level": "error"})
    assert "failed" in checklist.snapshot_lines()[0]


# FIELD TEST, 2026-08-17: the raw stream was misaligned and wrapped mid-token,
# with detail text colliding with counts and long paths breaking the columns.
LONG_EVENT = {
    "ts": 15_900,
    "jobId": "job-init-0001",
    "phase": "retrieval-floor",
    "step": "sweep",
    "detail": (
        "reading /Users/owner/code/orchard-web/src/features/upload/queue/"
        "ordering-guarantee.ts and comparing it against the recorded baseline"
    ),
    "counts": {"hits": 31, "cases": 34},
    "level": "info",
}


def test_the_stream_reads_as_a_table_even_when_a_detail_is_a_sentence():
    """Continuations sit under the detail column, not at column zero.

    Wrapping at the frame edge is what made a long detail collide with the
    columns beside it, so the wrap is done here where the column positions are
    known rather than left to the widget.
    """
    from daijin_tui.widgets.activity import EventLog

    width = 100
    lines = EventLog.format_event(LONG_EVENT, width).split("\n")
    assert len(lines) > 1, "the sample is not long enough to wrap, so this checks nothing"

    head = lines[0]
    indent = len(head) - len(head.lstrip(" "))
    detail_column = head.index("sweep") + len("sweep")
    for line in lines[1:]:
        stripped = len(line) - len(line.lstrip(" "))
        assert stripped > detail_column, (
            f"a continuation started at column {stripped}, inside the step column"
        )
    assert len({len(line) - len(line.lstrip(" ")) for line in lines[1:]}) == 1, (
        "the continuations do not share one hanging indent"
    )
    for line in lines:
        assert len(line) <= width, f"a line ran to {len(line)} in a {width} column frame"


def test_a_long_path_is_cut_in_the_middle_so_both_ends_survive():
    """A path is identified by its start and its basename.

    Cutting the tail throws away the half that names the thing, so the cut is
    in the middle and both ends are asserted.
    """
    from daijin_tui.widgets.activity import EventLog

    path = "/Users/owner/code/orchard-web/src/features/upload/queue/ordering-guarantee.ts"
    cut = EventLog.truncate_middle(path, 40)
    assert len(cut) == 40, f"the truncation did not respect the limit: {len(cut)}"
    assert cut.startswith("/Users/owner"), "the head of the path was lost"
    assert cut.endswith("guarantee.ts"), "the basename was lost, which is the half that names it"
    assert "..." in cut
    # Short enough to fit is left alone.
    assert EventLog.truncate_middle("short.ts", 40) == "short.ts"


def test_counts_are_their_own_segment_rather_than_glued_to_the_detail():
    from daijin_tui.widgets.activity import EventLog

    rendered = EventLog.format_event(LONG_EVENT, 100)
    assert "hits 31, cases 34" in rendered
    # The complaint was the two colliding: the counts must not begin on the
    # same line as the last word of a detail that filled its column.
    detail_end = "recorded baseline"
    line_with_detail = next(l for l in rendered.split("\n") if detail_end in l)
    assert "hits 31" not in line_with_detail or len(line_with_detail) <= 100


def test_the_formatter_degrades_rather_than_producing_one_word_per_line():
    from daijin_tui.widgets.activity import EventLog, MIN_DETAIL_WIDTH

    for width in (0, 10, 30, 40):
        rendered = EventLog.format_event(LONG_EVENT, width)
        assert rendered, f"width {width} produced nothing"
        if width > 0:
            longest = max(len(line) for line in rendered.split("\n"))
            assert longest <= max(width, MIN_DETAIL_WIDTH + 40), (
                f"width {width} produced a {longest} column line"
            )


def test_the_widget_does_not_re_wrap_what_the_formatter_already_laid_out():
    """Two wrappers over one string is how the hanging indent gets undone.

    format_event owns the layout because it knows where the columns are. If
    RichLog also wraps, any disagreement between the width used to format and
    the width at render time (a scrollbar appearing is enough) re-flows the
    line at the frame edge and puts the continuation back at column zero,
    which is the original defect.
    """
    from daijin_tui.widgets.activity import EventLog

    log = EventLog()
    assert log.wrap is False, (
        "the widget wraps as well as the formatter, so the two can disagree"
    )


def test_truncation_is_a_default_the_reader_can_undo():
    from daijin_tui.widgets.activity import EventLog

    shortened = EventLog.format_event(LONG_EVENT, 100, truncate=True)
    whole = EventLog.format_event(LONG_EVENT, 100, truncate=False)
    assert "..." in shortened, "the sample does not truncate, so this checks nothing"
    assert "..." not in whole, "the untruncated form still shortened a token"
    full_path = "/Users/owner/code/orchard-web/src/features/upload/queue/ordering-guarantee.ts"
    assert full_path in whole, "the whole path is not recoverable"
    assert full_path not in shortened
    # Untruncated rows overrun rather than breaking the path across lines,
    # because breaking it is what the truncation existed to prevent.
    assert any(len(line) > 100 for line in whole.split("\n"))
