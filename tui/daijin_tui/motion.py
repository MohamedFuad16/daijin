"""Every duration and easing in the app, in one place.

Nothing animates with a literal number at a call site. That is the same
discipline as the contract tables: one source of truth, and a test that fails
if a stray duration appears anywhere else. A UI whose timings are scattered
across twenty files cannot be tuned, and cannot be turned off.

Motion here is meant to carry meaning rather than decorate. A gauge that fills
toward its value says "this is climbing"; the same gauge jumping says nothing.
So the modes are not a quality slider: `reduced` keeps the cues that carry
information and drops the ones that only please, and `off` performs no
animation at all.
"""

from __future__ import annotations

from typing import Any, Callable

# Modes, stored in settings under charts.motion.
FULL = "full"
REDUCED = "reduced"
OFF = "off"
MODES = (FULL, REDUCED, OFF)
DEFAULT_MODE = FULL

# Duration tokens, seconds. The bands come from the brief: micro-interactions
# 120 to 200ms, view transitions 250 to 350ms, chart reveals 400 to 600ms.
MICRO = "micro"
VIEW = "view"
REVEAL = "reveal"

DURATIONS: dict[str, float] = {
    MICRO: 0.16,
    VIEW: 0.30,
    REVEAL: 0.50,
}

# Easing tokens. Movement uses in_out_cubic so it starts and stops softly;
# reveals use out_expo so they arrive quickly and settle, which reads as
# "here is the data" rather than "please wait for the animation".
MOVE = "move"
ARRIVE = "arrive"

EASINGS: dict[str, str] = {
    MOVE: "in_out_cubic",
    ARRIVE: "out_expo",
}

# A pressed-state cue has to land inside the interval where a person still
# reads it as caused by their own press.
PRESS_FEEDBACK = 0.09
assert PRESS_FEEDBACK < 0.1, "press feedback must stay under 100ms to feel caused"


class Motion:
    """Gates and times every animation. One instance lives on the app.

    Counts its own invocations so `off` can be asserted rather than trusted:
    a mode that claims to animate nothing is easy to write and easy to get
    subtly wrong, and the only honest check is that no animation was started.
    """

    def __init__(self, mode: str = DEFAULT_MODE) -> None:
        self.mode = mode if mode in MODES else DEFAULT_MODE
        self.invocations = 0
        self.skipped = 0

    def set_mode(self, mode: str) -> None:
        if mode in MODES:
            self.mode = mode

    @property
    def enabled(self) -> bool:
        return self.mode != OFF

    def allows(self, *, decorative: bool) -> bool:
        """Whether this animation runs in the current mode.

        Decorative motion is the kind whose absence loses nothing: a chart
        growing in, a screen sliding. Non-decorative motion carries state a
        static frame would not show, so `reduced` keeps it.
        """
        if self.mode == OFF:
            return False
        if self.mode == REDUCED and decorative:
            return False
        return True

    def duration(self, token: str, *, decorative: bool = False) -> float:
        """Seconds for a token, or 0 when this mode will not animate it."""
        if not self.allows(decorative=decorative):
            return 0.0
        return DURATIONS.get(token, DURATIONS[MICRO])

    def easing(self, token: str = MOVE) -> str:
        return EASINGS.get(token, EASINGS[MOVE])

    def animate(
        self,
        widget: Any,
        attribute: str,
        value: Any,
        *,
        token: str = MICRO,
        easing: str = MOVE,
        decorative: bool = False,
        on_complete: Callable[[], None] | None = None,
    ) -> bool:
        """Animate, or set the value outright when this mode will not.

        Returns whether an animation was started. When it was not, the value is
        still applied: turning motion off must change how the UI gets there,
        never where it ends up.
        """
        if not self.allows(decorative=decorative):
            self.skipped += 1
            try:
                setattr(widget, attribute, value)
            except Exception:
                pass
            if on_complete is not None:
                on_complete()
            return False

        self.invocations += 1
        widget.animate(
            attribute,
            value,
            duration=self.duration(token, decorative=decorative),
            easing=self.easing(easing),
            on_complete=on_complete,
        )
        return True
