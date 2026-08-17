"""The intro screen: brand, loading state, and the failure path through it."""

from __future__ import annotations

import pytest
from conftest import DEFAULT_REPO, run_async, running_app, settle
from test_screens import text_of

from daijin_tui.motion import DURATIONS, REVEAL, VIEW
from daijin_tui.screens.splash import (
    FINAL_STAGE,
    STAGE_STATUS,
    STAGE_TAGLINE,
    STAGE_WORDMARK,
    TAGLINE,
    SplashScreen,
)
from daijin_tui.widgets.texture import NEUTRAL
from daijin_tui.widgets.wordmark import (
    BLOCK_FONT,
    expected_mask,
    mask_of,
    reveal_steps,
    wordmark_lines,
    wordmark_width,
)


# The mark, written out here BY HAND. Comparing the render against
# expected_mask() proved only that the renderer agrees with BLOCK_FONT, and a
# mutation corrupting the font moved both sides together and survived. Both
# halves of a check being derived from the same source is the defect this
# project has met three times; this is the fourth, caught in a test written the
# same hour I wrote about it.
DAIJIN_MASK = (
    "####...###..#####.#####.#####.#...#",
    "#...#.#...#...#......#....#...##..#",
    "#...#.#...#...#......#....#...#.#.#",
    "#...#.#####...#......#....#...#.#.#",
    "#...#.#...#...#......#....#...#.#.#",
    "#...#.#...#...#...#..#....#...#..##",
    "####..#...#.#####..##...#####.#...#",
)


def test_the_wordmark_reads_without_colour():
    """Shape carries it; the ramp is only texture inside the letterforms.

    Asserting the glyphs alone would pass for a rectangle, so the mask is
    recovered from the rendered lines and compared to a mask written out in
    this file. That is the property a colourless terminal depends on, and it is
    checked against something the renderer cannot move.
    """
    lines = wordmark_lines()
    assert len(lines) == 7
    assert tuple(mask_of(lines, wordmark_width())) == DAIJIN_MASK, (
        "the letterforms did not survive the texture, or the font changed"
    )
    # The font's own view has to agree with the hand-written one too, so a
    # font edit fails here rather than silently redefining the brand.
    assert tuple(expected_mask()) == DAIJIN_MASK, "BLOCK_FONT no longer spells DAIJIN"
    # And it IS textured rather than one repeated character, which is what
    # makes it the same visual system as the charts.
    glyphs = {ch for line in lines for ch in line if ch != " "}
    assert glyphs <= set(NEUTRAL.ramp) | {NEUTRAL.cap}, f"a glyph from outside the ramp: {glyphs}"
    assert len(glyphs) > 1, "a single repeated glyph is a slab, not a dither"


def test_each_letterform_is_the_letter_it_claims_to_be():
    """The mask above was PASTED from the font's own output.

    So the code cannot move it, which is why the corruption mutation kills, but
    both sides still came from one belief: if BLOCK_FONT had shipped a typo, the
    hand-copied mask would have enshrined it and this suite would defend a
    misspelled wordmark forever.

    These assertions are written from what the LETTERS are, not from what the
    table says. They are the independent side the mask comparison lacks.
    """
    rows = {letter: BLOCK_FONT[letter] for letter in "DAIJN"}

    def col(mask, index):
        return [row[index] for row in mask]

    d = rows["D"]
    assert all(ch == "#" for ch in col(d, 0)), "D has no left stem"
    assert d[0].count("#") >= 4 and d[6].count("#") >= 4, "D has no top or bottom bar"
    assert d[0][4] == "." and d[6][4] == ".", "D's bowl is closed square, not curved"
    assert all(row[4] == "#" for row in d[1:6]), "D's bowl has no right side"

    a = rows["A"]
    assert a[3].count("#") == 5, "A has no crossbar"
    assert a[0][0] == "." and a[0][4] == ".", "A has no apex"
    assert all(row[0] == "#" and row[4] == "#" for row in a[1:]), "A has no legs"

    i = rows["I"]
    assert i[0].count("#") == 5 and i[6].count("#") == 5, "I has no serifs"
    assert all(row.count("#") == 1 and row[2] == "#" for row in i[1:6]), "I has no centre stem"

    j = rows["J"]
    assert j[0].count("#") == 5, "J has no top bar"
    assert all(row[3] == "#" for row in j[1:5]), "J has no descending stem"
    assert j[6][3] == "." and "#" in j[6], "J has no hook at the foot"
    assert j[5][0] == "#", "J's hook does not turn back"

    n = rows["N"]
    assert all(ch == "#" for ch in col(n, 0)), "N has no left stem"
    assert all(ch == "#" for ch in col(n, 4)), "N has no right stem"
    diagonal = [row.index("#", 1) for row in n[1:6]]
    assert diagonal == sorted(diagonal), f"N's diagonal does not descend: {diagonal}"
    assert diagonal[0] < diagonal[-1], "N has no diagonal at all"


def test_a_partial_reveal_is_a_prefix_of_the_finished_mark():
    """Every frame comes from the same function, so the animation cannot drift."""
    full = wordmark_lines()
    steps = list(reveal_steps())
    assert steps[-1] == wordmark_width(), "the last frame is not the finished mark"
    for columns in steps:
        frame = wordmark_lines(reveal=columns)
        for row, (partial, complete) in enumerate(zip(frame, full)):
            assert complete.startswith(partial.rstrip()) or not partial.strip(), (
                f"row {row} at {columns} columns is not a prefix of the final frame"
            )
    assert wordmark_lines(reveal=steps[-1]) == full


def test_the_font_covers_every_letter_it_is_asked_to_draw():
    """A missing letter would silently vanish rather than fail."""
    for letter in "DAIJIN":
        assert letter in BLOCK_FONT, f"{letter} has no glyph, so the wordmark would be wrong"
    assert wordmark_lines("DAIJIN") == wordmark_lines("daijin"), "case changed the mark"


@run_async
async def test_motion_off_renders_the_finished_frame_with_no_animation():
    """`off` is not a speed setting: nothing is scheduled at all."""
    screen = SplashScreen(motion=type("M", (), {"mode": "off"})())
    async with running_app() as (app, pilot):
        await app.push_screen(screen)
        await settle(pilot)
        assert screen.stage == FINAL_STAGE
        assert screen.reveal is None, "a partial frame was drawn in off mode"
        assert not screen._stage_timers, "off mode scheduled an animation"
        assert TAGLINE in text_of(screen.query_one("#splash-tagline"))


@run_async
async def test_reduced_stages_the_information_without_the_column_entrance():
    """`reduced` keeps the ordering that carries meaning, drops what only pleases."""
    screen = SplashScreen(motion=type("M", (), {"mode": "reduced"})())
    async with running_app() as (app, pilot):
        await app.push_screen(screen)
        await settle(pilot)
        # NOT an exact stage: the staging timers may or may not have advanced
        # by now depending on how loaded the machine is, and asserting the
        # instant would be a wall-clock race of exactly the kind this project
        # calls a flaky gate. The properties that define `reduced` are that the
        # information is staged AT ALL and that no frame is ever partial.
        assert screen.stage >= STAGE_WORDMARK, "reduced rendered nothing"
        assert screen.reveal is None, "reduced drew a partial frame"
        assert screen._stage_timers, "reduced scheduled nothing, so it never stages"


@run_async
async def test_full_stages_the_wordmark_column_by_column():
    screen = SplashScreen(motion=type("M", (), {"mode": "full"})())
    async with running_app() as (app, pilot):
        await app.push_screen(screen)
        await settle(pilot, 1)
        steps = list(reveal_steps())
        assert screen.reveal in steps, f"full mode drew a frame outside the sequence: {screen.reveal}"
        assert screen.reveal < steps[-1], "full mode jumped straight to the finished mark"
        assert screen._stage_timers, "full mode scheduled nothing"


@run_async
async def test_any_key_skips_to_the_finished_frame():
    screen = SplashScreen(motion=type("M", (), {"mode": "full"})())
    async with running_app() as (app, pilot):
        await app.push_screen(screen)
        await settle(pilot)
        assert screen.stage < FINAL_STAGE or screen.reveal is not None
        screen.set_status("engine 1.2.3, contract 5")
        await pilot.press("j")
        await settle(pilot)
        assert screen.skipped is True
        assert screen.stage == FINAL_STAGE
        assert screen.reveal is None
        assert "engine 1.2.3" in text_of(screen.query_one("#splash-status"))
        # The property that matters is that nothing redraws a partial frame
        # afterwards. Two weaker versions were tried first and both were
        # measuring the wrong thing: asserting the timer LIST is empty measures
        # clear() rather than stop(), and waiting for stale timers to fire
        # cannot work because Textual timers do not advance on pilot pauses.
        #
        # So the callback a stale timer WOULD run is invoked directly. That is
        # the guard the skip actually depends on, tested without wall clock.
        screen._show(STAGE_WORDMARK, reveal=6)
        assert screen.stage == FINAL_STAGE, "a late stage callback moved the stage back"
        assert screen.reveal is None, "a late callback redrew a partial frame after a skip"
        assert "engine 1.2.3" in text_of(screen.query_one("#splash-status"))


@run_async
async def test_the_status_line_reports_what_the_engine_said():
    """No invented copy: the numbers come from hello and serveStatus.

    Asserting only that the splash goes away would pass with a decorative
    status line, so the line itself is read and checked against the response
    the engine actually gave.
    """
    async with running_app() as (app, pilot):
        await settle(pilot, 15)
        assert app.splash is None, "the splash outlived startup"
        assert app.current_mode == "home"

        splash = SplashScreen(motion=app.motion)
        await app.push_screen(splash)
        await settle(pilot)
        await app._first_status(splash)
        await settle(pilot)

        status = await app.client.call("serveStatus", {})
        repos = status["repos"]
        line = splash.status_text
        assert f"{len(repos)} repo" in line, f"the repo count is not the engine's: {line!r}"
        assert str(app.client.contract_version) in line, "the contract version is not reported"
        reachable = (status.get("ollama") or {}).get("reachable")
        assert ("ollama reachable" in line) == bool(reachable), (
            f"the ollama line does not match what serveStatus said: {line!r}"
        )
        app.pop_screen()


@run_async
async def test_a_first_run_lands_on_the_attach_box_not_empty_cards():
    """With nothing attached there are no cards, so the splash hands over to the one useful control."""
    from textual.widgets import Input

    from daijin_tui.rpc import MockEngine, MockRpcClient

    engine = MockEngine(speed=0.0)
    engine.repos = []
    async with running_app(engine=engine, repo=None) as (app, pilot):
        await settle(pilot, 15)
        assert app.current_mode == "home"
        assert app.first_run is True, "an empty engine was not recognised as a first run"
        notice = text_of(app.screen.query_one("#home-notice"))
        assert "No repos attached yet" in notice, f"the empty state says nothing useful: {notice!r}"
        assert app.screen.query_one("#attach-input", Input).has_focus, (
            "the only useful control on an empty home screen is not focused"
        )


@run_async
async def test_a_handshake_failure_shows_the_error_rather_than_holding_the_brand():
    """The prettiest possible hang is still a hang.

    Finding 3 of review run 3 said a startup failure must show its real error.
    Putting a splash in front of startup is exactly how that regresses, so the
    failure path is exercised through the splash rather than around it.
    """
    from daijin_tui.app import DaijinApp
    from daijin_tui.rpc import MockEngine, MockRpcClient
    from daijin_tui.screens import SplashScreen as Splash
    from daijin_tui.screens import UpgradeScreen

    client = MockRpcClient(MockEngine(speed=0.0))

    async def refuse():
        raise ConnectionError("the engine exited without answering: EADDRINUSE port 7420")

    client.handshake = refuse
    app = DaijinApp(client, is_mock=True, repo=DEFAULT_REPO)
    async with app.run_test(size=(170, 55)) as pilot:
        await settle(pilot, 12)
        assert isinstance(app.screen, UpgradeScreen)
        # NOT just "the top screen is the error": a splash left underneath is
        # still a splash holding timers over a dead startup, and asserting on
        # the top of the stack passes either way.
        assert not any(isinstance(s, Splash) for s in app.screen_stack), (
            "the brand is still on the stack under the error screen"
        )
        assert app.splash is None
        body = " ".join(text_of(w) for w in app.screen.query("Static"))
        assert "EADDRINUSE" in body
    await client.aclose()


@run_async
async def test_the_splash_uses_the_motion_tokens_and_no_literal_durations():
    """Every duration here comes from motion.py, like everywhere else."""
    import inspect

    from daijin_tui.screens import splash as module

    source = inspect.getsource(module)
    body = source.split("VIEW_SECONDS = DURATIONS[VIEW]")[1]
    for literal in ("0.1", "0.2", "0.3", "0.5", "1.0", "sleep("):
        assert literal not in body, f"a hard-coded timing appeared in the splash: {literal}"
    assert module.VIEW_SECONDS == DURATIONS[VIEW]
    assert module.REVEAL_SECONDS == DURATIONS[REVEAL]


# FIELD TEST, 2026-08-17: the drawn three-row header mark was unreadable on a
# real terminal. These tests replace the ones that guarded it, and the lesson
# they carry is that none of the old ones could have caught it: the mask
# matched, the letterform properties held, and a human still could not read it.


def test_the_header_shows_the_word_because_legibility_beats_cleverness():
    """A drawn header mark is gone until letterforms survive three rows.

    The full-size splash mark stays, because it was read on a real terminal and
    approved. The difference between the two is not the code, it is that one
    was looked at by the owner and one was looked at by me.
    """
    from daijin_tui.widgets import wordmark
    from daijin_tui.widgets.wordmark import header_mark, wordmark_lines

    assert header_mark(30) == ["DAIJIN"]
    assert header_mark(6) == ["DAIJIN"]
    assert header_mark(5) == [], "a header too narrow for the word still got something to wrap"
    for width in range(0, 40):
        for line in header_mark(width):
            assert len(line) <= width, f"at {width} columns the header returned {len(line)}"

    assert not hasattr(wordmark, "small_wordmark_lines"), (
        "the unreadable small form is still available to be re-enabled by accident"
    )
    # The approved mark is untouched.
    assert len(wordmark_lines()) == 7


@run_async
async def test_the_home_screen_carries_the_word_and_drops_it_when_it_cannot_fit():
    async with running_app() as (app, pilot):
        await settle(pilot, 12)
        mark = app.screen.query_one("#home-wordmark")
        assert mark.display is True
        assert text_of(mark).strip() == "DAIJIN"

    async with running_app(size=(5, 40)) as (app, pilot):
        await settle(pilot, 12)
        mark = app.screen.query_one("#home-wordmark")
        assert mark.display is False, "a header too narrow for the word kept its row"
