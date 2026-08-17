"""The client's keyRef rule is a MIRROR, so it is checked against the original.

Both halves of a comparison being mine is the defect this project has met on
four surfaces. Here the other half exists and is runnable, so this test runs
the engine's own parseKeyRef over the same inputs and compares, rather than
freezing a copy of its verdicts into a table that could only ever agree with
whoever typed it.

The rule matters in one direction especially: the client must NOT be stricter
than the engine. A dialog that refuses what the engine accepts blocks a user
from something that works, and my first version did exactly that with
`file:rel`.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from daijin_tui.screens.role_dialog import parse_key_ref

ENGINE_KEYS = Path(__file__).resolve().parents[2] / "engine" / "src" / "roles" / "keys.js"

def _engine_has_refusals() -> bool:
    """Does this checkout's engine predate the rule the mirror now follows?

    keyRefRefusal arrived with the fix that made prefixed pointers absolute
    and env: require a NAME. An engine older than that DISAGREES BY DESIGN, so
    comparing against it would fail for the one reason a parity test must not:
    the two sides are not describing the same rule yet.
    """
    if not ENGINE_KEYS.exists():
        return False
    return "keyRefRefusal" in ENGINE_KEYS.read_text(encoding="utf-8")


pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not ENGINE_KEYS.exists() or not _engine_has_refusals(),
    reason=(
        "the mirror cannot be compared: node is missing, or this checkout's engine "
        "predates the keyRef fix (no keyRefRefusal export) and so follows a different "
        "rule by design. NOT CHECKED while skipped: the parse verdicts, the "
        "never-stricter direction, the refusal wording, and the engine-side leak check"
    ),
)

# Every shape either side distinguishes, including the ones that only differ
# by a character. A case list that only held the happy forms would agree
# trivially.
CASES = [
    "env:OPENAI_KEY", "file:/abs/k.txt", "env-file:/abs/e#NAME",
    "env:my_key", "env:_leading", "env:has-dash", "env:has.dot", "env:9lead",
    "env:sk-ant-abc123", "file:../up/key", "env-file:rel#NAME",
    "/abs/path", "SHOUTING_NAME", "ENV_NAME_9", "E",
    "sk-ant-abc123", "sk-proj-abc", "relative/path", "e", "Env_Name", "9SHOUT",
    "env:", "file:", "file:rel", "file:./x", "file: /a",
    "env-file:/abs/e", "env-file:#N", "env-file:/abs#", "env-file:rel#NAME",
    "env-file:x#y#z", "AKIA1234567890", "env: NAME", " env:NAME", "env:NAME ", "",
]


def _engine_verdicts() -> list[str | None]:
    script = (
        f"import {{ parseKeyRef }} from {json.dumps(str(ENGINE_KEYS))};\n"
        f"const cases = {json.dumps(CASES)};\n"
        "console.log(JSON.stringify(cases.map(c => {\n"
        "  const r = parseKeyRef(c);\n"
        "  return r ? r.kind : null;\n"
        "})));\n"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, f"the engine parser would not run: {result.stderr[:400]}"
    return json.loads(result.stdout)


def test_the_client_mirror_agrees_with_the_engine_parser():
    engine = _engine_verdicts()
    mine = [parse_key_ref(case) for case in CASES]
    divergences = [
        (case, theirs, ours)
        for case, theirs, ours in zip(CASES, engine, mine)
        if theirs != ours
    ]
    assert not divergences, "the mirror has drifted from parseKeyRef: " + ", ".join(
        f"{case!r} engine={theirs!r} client={ours!r}" for case, theirs, ours in divergences
    )

    # Non-vacuity: a comparison where everything is None on both sides would
    # pass while checking nothing.
    assert len([v for v in engine if v]) >= 5, "the case list barely exercises the parser"
    assert len([v for v in engine if v is None]) >= 5, "no refusals in the case list"


def test_the_client_is_never_stricter_than_the_engine():
    """The direction that costs a user something.

    A client refusing what the engine accepts blocks work that would have
    succeeded; the reverse merely lets the engine give the verdict. Named as
    its own test because the two are not equally bad and a combined assertion
    would hide which one fired.
    """
    engine = _engine_verdicts()
    stricter = [
        case for case, theirs, ours in zip(CASES, engine, [parse_key_ref(c) for c in CASES])
        if theirs is not None and ours is None
    ]
    assert not stricter, (
        f"the dialog refuses references the engine accepts: {stricter}"
    )


def test_the_gap_in_the_rule_is_known_and_the_copy_does_not_overclaim():
    """It is a shape whitelist, not a key detector, and the copy must match.

    A pasted key that happens to be all-caps-and-digits passes as an
    environment variable name. So the warning says the value does not LOOK
    LIKE A POINTER, which is a claim about shape, rather than "that looks like
    a key", which neither side can make.
    """
    from daijin_tui.screens.role_dialog import KEY_REF_OK, KEY_REF_REFUSED

    assert parse_key_ref("AKIA1234567890") == "env", (
        "the known gap closed; if the engine tightened, this mirror should too"
    )
    assert parse_key_ref("sk-ant-abc123") is None

    # Assert the COPY, not the file. The first version of this grepped the
    # source and matched the comment explaining what not to say, which tests
    # the prose rather than the message.
    assert "does not look like a pointer" in KEY_REF_REFUSED
    for overclaim in ("looks like a key", "that is a key", "is a secret"):
        assert overclaim not in KEY_REF_REFUSED, (
            f"the warning claims something the rule cannot support: {overclaim}"
        )
    assert "never crosses the wire" in KEY_REF_REFUSED, "the reason is not stated"
    assert "resolves it at call time" in KEY_REF_OK


def _engine_refusals() -> list[str | None]:
    script = (
        f"import {{ keyRefRefusal }} from {json.dumps(str(ENGINE_KEYS))};\n"
        f"const cases = {json.dumps(CASES)};\n"
        "console.log(JSON.stringify(cases.map(c => keyRefRefusal(c) ?? null)));\n"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, f"keyRefRefusal would not run: {result.stderr[:400]}"
    return json.loads(result.stdout)


def test_the_refusal_reasons_are_the_engines_own_words():
    """One rule deserves one explanation.

    Composing my own sentence for a refusal the engine already explains gives
    the user two accounts of one rule that drift apart, and the drift is
    invisible until someone reads both.
    """
    from daijin_tui.screens.role_dialog import key_ref_refusal

    engine = _engine_refusals()
    mine = [key_ref_refusal(case) for case in CASES]

    # Agreement on WHETHER there is a complaint is the load-bearing half.
    disagree = [
        (case, theirs, ours)
        for case, theirs, ours in zip(CASES, engine, mine)
        if bool(theirs) != bool(ours)
    ]
    assert not disagree, "the two disagree about what is refusable: " + ", ".join(
        f"{case!r} engine={bool(theirs)} client={bool(ours)}" for case, theirs, ours in disagree
    )
    assert any(engine), "no case in the list is refused, so this checks nothing"

    # And on the sentence itself, where one exists on both sides.
    worded = [
        (case, theirs, ours)
        for case, theirs, ours in zip(CASES, engine, mine)
        if theirs and ours and theirs.strip() != ours.strip()
    ]
    assert not worded, "the refusal wording has drifted: " + "; ".join(
        f"{case!r}\n  engine: {theirs}\n  client: {ours}" for case, theirs, ours in worded
    )


def test_no_refusal_message_ever_quotes_what_the_user_typed():
    """The likeliest wrong value at this input is a pasted API key.

    A warning that echoes it puts it on screen, into any screenshot, and into
    any log that captures rendered output. A field that masks while typing and
    then quotes the value in an error has masked nothing. The engine caught
    this on its side by writing a leak test rather than by re-reading, so this
    is the same test pointed at the client.
    """
    from daijin_tui.screens import role_dialog
    from daijin_tui.screens.role_dialog import key_ref_refusal

    sentinel = "sk-ant-SENTINELVALUE-should-never-appear"
    for probe in (sentinel, f"env:{sentinel}", f"file:{sentinel}", f"env-file:{sentinel}"):
        message = key_ref_refusal(probe) or ""
        assert sentinel not in message, f"the refusal echoed the value: {message!r}"
        assert "SENTINEL" not in message

    # Nor may any of the STATIC copy carry a value-shaped placeholder that a
    # caller would be tempted to fill with the input.
    for name in ("KEY_REF_REFUSED", "KEY_REF_OK", "KEY_REF_HINT", "REFUSAL_RELATIVE",
                 "REFUSAL_ENV_FILE", "REFUSAL_ENV_NAME", "REFUSAL_BARE"):
        copy = getattr(role_dialog, name)
        assert "{value}" not in copy and "{ref}" not in copy, (
            f"{name} invites the caller to interpolate the typed value"
        )


def test_the_engine_refusal_never_suggests_a_resolved_path():
    """A sentence explaining that the daemon's cwd cannot be trusted must not
    then resolve a path against it: that hands the user a confidently wrong
    location under the engine's install directory."""
    for message in _engine_refusals():
        if not message:
            continue
        assert "/Users/" not in message and "node_modules" not in message, (
            f"a resolved path leaked into a refusal: {message}"
        )
