"""Backpressure for the step-event stream.

A job can emit its whole stream in one tick. Rendering each event as it lands
turns a burst of two hundred into two hundred repaints, which is not faster
than coalescing them, only jerkier: the eye cannot read two hundred frames and
the terminal cannot draw them.

So events are buffered and flushed on a fixed cadence. Nothing is dropped; the
catch-up is smooth rather than instant, and a stream that arrives slowly is
unaffected because the first event in an idle window flushes immediately.
"""

from __future__ import annotations

from typing import Any, Callable

# Roughly 30 flushes per second. Faster than the eye resolves as separate
# updates, slow enough that a burst costs a handful of repaints, not hundreds.
FLUSH_INTERVAL = 1 / 30


class StreamCoalescer:
    """Buffers events and hands them over in batches.

    Deliberately not a widget and not tied to Textual: the batching rule is
    worth testing without an app, and the caller supplies the timer.
    """

    def __init__(
        self,
        sink: Callable[[list[dict[str, Any]]], None],
        *,
        interval: float = FLUSH_INTERVAL,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.sink = sink
        self.interval = interval
        self._clock = clock
        self._buffer: list[dict[str, Any]] = []
        self._last_flush: float | None = None
        self.flushes = 0
        self.received = 0

    def _now(self) -> float:
        if self._clock is not None:
            return self._clock()
        import time

        return time.monotonic()

    def push(self, event: dict[str, Any]) -> bool:
        """Take one event. Returns whether it was flushed immediately."""
        self.received += 1
        self._buffer.append(event)
        now = self._now()
        # The first event after a quiet spell goes straight through, so a slow
        # stream is never delayed by machinery meant for a fast one.
        if self._last_flush is None or (now - self._last_flush) >= self.interval:
            self.flush()
            return True
        return False

    def flush(self) -> None:
        if not self._buffer:
            return
        batch, self._buffer = self._buffer, []
        self._last_flush = self._now()
        self.flushes += 1
        self.sink(batch)

    @property
    def pending(self) -> int:
        return len(self._buffer)
