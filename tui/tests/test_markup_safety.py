"""Engine text is DATA, not markup.

Textual's parser raises MarkupError on a closing tag that matches no open one,
so any string containing a "[/...]" token kills the widget that renders it -
and an exception inside a render kills the app. The strings that reach these
screens are not ours: engine hints that interpolate a path the user typed, the
tail of a repo's own test output, an exam title the auditor authored, the
watcher's and auditor's sentences on the board, a markdown instruction file.

Each test below pins one site with genuinely bracketed content and asserts the
brackets SURVIVE, so a fix that silently swallowed the text would fail too.

The escaping question was measured rather than assumed: textual.markup.escape
(and rich's) rewrite only COMPLETE "[...]" tokens, so a dangling "[/" at the
end of untrusted text merges with the caller's own closing tag and raises
anyway - see test_escaping_is_not_a_substitute_for_substitution. Content's
$variable substitution is the fix, and Text is its equivalent for table cells.
"""

from __future__ import annotations

import pytest
from conftest import DEFAULT_REPO, goto, run_async, running_app, screen_text, settle

from textual.widgets import Static

from daijin_tui.rpc import RpcError
from daijin_tui.widgets import Banner, cells

# A path in brackets is a closing tag with nothing open. Real sources: pytest
# parametrised ids ("test_read[/tmp/pytest-of-me/f]"), any sentence quoting a
# markup tag, and this repo's own prose about "[/dim]".
BRACKETED_PATH = "[/Users/owner/code/orchard-web/gates.yaml]"
BRACKETED_PYTEST_ID = "FAILED tests/test_read.py::test_read[/tmp/pytest-of-owner/f.txt]"
QUOTED_TAG = "the fix wraps it in [/dim] and the app dies"


def test_escaping_is_not_a_substitute_for_substitution():
    """Why every fix here is $variable substitution and not an escape call.

    escape() rewrites complete "[...]" tokens only. A dangling "[/" at the end
    of untrusted text is left alone, joins the caller's own closing tag, and
    raises exactly the error the escape was supposed to prevent. This is the
    measured form of the note in state.md.
    """
    from textual.content import Content
    from textual.markup import MarkupError, escape

    with pytest.raises(MarkupError):
        Content.from_markup(f"[dim]{escape('a dangling [/')}[/dim]")

    # Substitution has no such hole: the value is never parsed at all.
    safe = Content.from_markup("[dim]$text[/dim]", text="a dangling [/")
    assert safe.plain == "a dangling [/"


def test_a_banner_shows_a_bracketed_engine_hint_instead_of_crashing():
    """The universal error path: every engine refusal lands in a banner.

    An engine hint interpolates the path the user typed, so a user who attaches
    a path containing brackets got a MarkupError rather than the refusal.
    """
    banner = Banner("", tone="info")
    banner.set_notice(f"{BRACKETED_PATH} does not exist. Attach a repository.", "error")
    assert BRACKETED_PATH in str(banner.render())


def test_table_cells_keep_their_brackets():
    """DataTable renders a str cell through rich's Text.from_markup.

    So a bracketed exam title or gate command raised MarkupError while the
    table was DRAWING, which no caller could catch.
    """
    rendered = [str(cell) for cell in cells("exam [/api] routing", None, 3)]
    assert rendered == ["exam [/api] routing", "", "3"]


@run_async
async def test_a_bracketed_finding_draws_in_the_board_table():
    """The helper existing proves nothing about the rows being built with it.

    This one goes through a real add_row and composites the screen, which is
    where the table's own rendering raises.
    """
    async with running_app() as (app, pilot):
        await goto(pilot, "7")
        table = app.screen._table()
        app.screen._add_row(table, {
            "id": "f-0002",
            "ts": "2026-08-29",
            "source": "watcher",
            "severity": "warn",
            "category": "markup",
            "target": BRACKETED_PATH,
            "evidence": "jsonl",
            "status": "open",
        })
        await settle(pilot)
        assert "gates.yaml" in screen_text(app), "the row must actually draw"


@run_async
async def test_a_repo_that_fails_to_read_renders_its_error_on_the_card():
    """set_stalled carries the exception's own text, brackets and all."""
    from daijin_tui.widgets import RepoCard

    async with running_app() as (app, pilot):
        await goto(pilot, "1")
        card = next(iter(app.screen.query(RepoCard)))
        card.set_stalled(f"could not be read: ENOENT {BRACKETED_PATH}")
        await settle(pilot)
        shown = "\n".join(str(child.render()) for child in card.query(".card-floor"))
        assert BRACKETED_PATH in shown


def test_the_engine_status_line_survives_a_bracketed_hint():
    from daijin_tui.screens.repo_home import RepoHomeScreen

    markup = RepoHomeScreen._engine_markup({
        "ollama": {"reachable": False, "model": "bge-m3", "version": None,
                   "hint": f"no model file at {BRACKETED_PATH}"},
    }).plain
    assert BRACKETED_PATH in markup


@run_async
async def test_a_check_shows_its_command_and_its_output_tails():
    """The gate panel is the repo's own text end to end.

    command comes out of gates.yaml and the tails are the check's real stdout
    and stderr - where a pytest parametrised id puts a bracketed path.
    """
    async with running_app() as (app, pilot):
        await goto(pilot, "4")
        app.screen.discovered = {"gates": []}
        app.screen._show_gate({
            "id": "test",
            "command": "pytest -k 'not [slow]'",
            "source": BRACKETED_PATH,
            "classification": "live",
            "unavailableHint": f"install the deps named in {BRACKETED_PATH}",
            "baseline": {
                "status": "fail",
                "durationMs": 1200,
                "unavailableReason": f"no runner at {BRACKETED_PATH}",
                "stdoutTail": BRACKETED_PYTEST_ID,
                "stderrTail": QUOTED_TAG,
            },
        })
        await settle(pilot)
        shown = str(app.screen.query_one("#gate-evidence", Static).render())
        assert "[slow]" in shown, "the command's own brackets must survive"
        assert "test_read[/tmp/pytest-of-owner/f.txt]" in shown


@run_async
async def test_the_board_renders_both_voices_when_they_quote_markup():
    """The thread is the watcher's and the auditor's own prose.

    An auditor writing about this very screen produces "[/dim]", which is the
    crash. The finding's summary and the fix label come off the wire too.
    """
    async with running_app() as (app, pilot):
        await goto(pilot, "7")
        app.screen._show_row({
            "id": "f-0001",
            "summary": f"markup leaks from {BRACKETED_PATH}",
            "detail": QUOTED_TAG,
            "evidence": "jsonl",
            "status": "open",
            "thread": [
                {"by": "watcher", "at": "2026-08-29T10:00:00", "text": QUOTED_TAG},
                {"by": "auditor", "at": "2026-08-29T10:05:00", "text": BRACKETED_PYTEST_ID},
            ],
            "action": {"label": f"patch {BRACKETED_PATH}"},
        })
        await settle(pilot)
        shown = str(app.screen.query_one("#board-detail", Static).render())
        assert "[/dim]" in shown, "the auditor's quoted tag must reach the reader"
        assert BRACKETED_PATH in shown
        assert "test_read[/tmp/pytest-of-owner/f.txt]" in shown


@run_async
async def test_an_exam_title_the_auditor_wrote_renders_with_its_brackets():
    async with running_app() as (app, pilot):
        await goto(pilot, "6")
        exam_id = app.screen.exams[0]["examId"]
        app.screen.exams[0]["title"] = "Stop [/api] routes leaking the token"
        app.screen.exams[0]["vetoReason"] = f"the premise is already solved in {BRACKETED_PATH}"
        await app.screen.show_exam(exam_id)
        await settle(pilot)
        shown = str(app.screen.query_one("#exam-provenance", Static).render())
        assert "[/api]" in shown
        assert BRACKETED_PATH in shown


@run_async
async def test_a_brain_document_keeps_the_brackets_in_its_title_and_path():
    """This repo's own brain indexes files whose text contains "[/dim]"."""
    async with running_app() as (app, pilot):
        await goto(pilot, "3")
        app.screen._show_document({
            "id": "g001",
            "title": "ADR: [/dim] and the markup class",
            "type": "adr",
            "area": "tui",
            "path": "agent/decisions.md",
            "tags": ["markup", "[/dim]"],
        })
        await settle(pilot)
        shown = str(app.screen.query_one("#inventory-detail", Static).render())
        assert shown.count("[/dim]") == 2, f"both bracketed values must survive: {shown!r}"


@run_async
async def test_a_blocked_init_shows_the_engine_prose_it_exists_to_show():
    """The block panel is the only thing on screen when init refuses."""
    async with running_app() as (app, pilot):
        await goto(pilot, "2")
        app.screen._render_block({
            "phase": "goldset",
            "detail": f"the span {BRACKETED_PATH} appears verbatim in g001",
        })
        await settle(pilot)
        shown = str(app.screen.query_one("#init-blocked", Static).render())
        assert BRACKETED_PATH in shown


@run_async
async def test_the_auditors_answer_is_appended_to_the_block_it_is_about():
    """Static has no `renderable` on Textual 8, and a worker error exits.

    Reading one raised AttributeError AFTER the owner had already paid for the
    generation, so the advice they bought never reached the screen.
    """
    async with running_app() as (app, pilot):
        await goto(pilot, "2")
        panel = app.screen.query_one("#init-blocked", Static)
        app.screen._render_block({"phase": "goldset", "detail": f"blocked on {BRACKETED_PATH}"})
        await settle(pilot)

        from daijin_tui.screens.init_feed import _kept

        kept = _kept(panel)
        assert BRACKETED_PATH in kept.plain, "the block prose must be carried forward"
        assert "goldset blocked." in kept.plain


@run_async
async def test_an_instruction_file_renders_whatever_the_owner_wrote_in_it():
    """.daijin/agents/*.md is prose about a tool that renders markup."""
    async with running_app() as (app, pilot):
        await goto(pilot, "8")
        app.screen.agent_files = {
            "auditor": {
                "currentHash": "ab12",
                "defaultHash": "ab12",
                "modified": False,
                "content": f"Never write {QUOTED_TAG}\nSee {BRACKETED_PATH}",
            }
        }
        app.screen._show_file("auditor")
        await settle(pilot)
        shown = str(app.screen.query_one("#file-detail", Static).render())
        assert "[/dim]" in shown
        assert BRACKETED_PATH in shown


@run_async
async def test_a_bracketed_engine_refusal_reaches_the_screen_it_refused():
    """show_rpc_error puts the hint in a banner AND in a toast.

    Both paths carry the engine's sentence verbatim, so both have to take it
    as characters rather than as markup.
    """
    async with running_app() as (app, pilot):
        await goto(pilot, "3")
        error = RpcError(-32602, "no brain", {"hint": f"no brain at {BRACKETED_PATH}. Run init."})
        app.screen.show_rpc_error(error, "#brain-notice")
        await settle(pilot)
        shown = str(app.screen.query_one("#brain-notice", Banner).render())
        assert BRACKETED_PATH in shown
        # And the whole screen still composites, which is where a table cell
        # or a toast would have raised instead.
        assert screen_text(app)


@run_async
async def test_typing_a_bracketed_path_into_the_attach_box_does_not_kill_the_app():
    """describe_path ECHOES what the user is typing.

    So this fired on a keystroke rather than on any engine answer: the path
    validation note is built from the field's own text.
    """
    from textual.widgets import Input

    from daijin_tui.screens.attach_dialog import AttachRepoScreen

    async with running_app() as (app, pilot):
        await goto(pilot, "1")
        await app.push_screen(AttachRepoScreen(roots=[], clone_available=True))
        await settle(pilot)
        field = app.screen.query_one("#attach-path", Input)
        field.value = "/tmp/[/does-not-exist]"
        app.screen.on_input_changed(Input.Changed(field, field.value))
        await settle(pilot)
        shown = str(app.screen.query_one("#attach-path-note", Static).render())
        assert "[/does-not-exist]" in shown


@run_async
async def test_every_screen_heading_survives_a_bracketed_repo_path():
    """The heading carries the attached repo path on EVERY screen.

    The path is whatever the owner attached, so one bracketed segment in it
    took down every screen in the app at once.
    """
    async with running_app() as (app, pilot):
        for key in "12345678":
            await goto(pilot, key)
            # Set it AFTER the load: the home screen deliberately moves the
            # selection onto an attached repo while it loads.
            app.selected_repo = "/Users/owner/code/[/legacy]/web"
            app.screen.refresh_heading()
            await settle(pilot)
            heading = str(app.screen.query_one("#screen-heading", Static).render())
            assert "[/legacy]" in heading, f"{app.screen.mode_name} lost the path"


@run_async
async def test_the_cannot_reach_the_engine_screen_shows_the_stderr_it_captured():
    """The last screen standing when the engine will not start.

    connection_error is the transport's preserved stderr tail - a node stack
    trace or an installer's output - and a MarkupError here leaves the user
    with nothing at all.
    """
    from daijin_tui.screens.upgrade import UpgradeScreen

    stderr_tail = "node:internal/modules [/Users/owner/.local/share/daijin/serve.js]"
    async with running_app() as (app, pilot):
        await app.push_screen(UpgradeScreen(
            engine_version=None,
            contract_version=None,
            connection_error=stderr_tail,
        ))
        await settle(pilot)
        assert stderr_tail in str(app.screen.query_one("#upgrade-detail", Static).render())


@run_async
async def test_an_empty_board_does_not_offer_a_fix_to_apply():
    """A control that can only answer "there is nothing here" is not a control.

    Checked and found ALREADY CORRECT: the stylesheet hides #board-fix by
    default and _show_row reveals it only for a finding that carries a fix.
    Kept as a pin because the rule lives in CSS, where nothing else asserts
    it - this test fails if that rule is deleted, and it passed before this
    session's changes as well as after.
    """
    from textual.widgets import Button

    from daijin_tui.rpc import MockEngine

    class EmptyBoard(MockEngine):
        """A tool with nothing on its board: no stored rows, a clean sweep."""

        async def _rpc_board(self, params):
            return {"rows": [], "total": 0}

        async def _rpc_systemCheck(self, params):
            return {"findings": []}

    async with running_app(engine=EmptyBoard(speed=0.0)) as (app, pilot):
        await goto(pilot, "7")
        assert app.screen.rows == [], "the fixture must actually produce an empty board"
        assert not app.screen.query_one("#board-fix", Button).display
