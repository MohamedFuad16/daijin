"""Fan-out helpers for screens.

A screen's independent RPC calls should cost max(latency), not sum(latency).
The ceiling on how many run at once lives in RpcClient (MAX_IN_FLIGHT), so
these helpers stay free to express intent without also owning the limit.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Iterable


async def gather_all(*awaitables: Awaitable[Any]) -> list[Any]:
    """Run independent work concurrently and wait for all of it.

    Exceptions are returned rather than raised, because each caller already
    handles its own RpcError and one screen panel failing must not blank the
    others. A caller that wants to inspect failures reads the results.
    """
    if not awaitables:
        return []
    return await asyncio.gather(*awaitables, return_exceptions=True)


async def gather_iter(awaitables: Iterable[Awaitable[Any]]) -> list[Any]:
    """gather_all over an iterable, for comprehensions."""
    return await gather_all(*list(awaitables))
