# Copyright (c) Microsoft. All rights reserved.

"""Interceptor protocol (§7)."""

from __future__ import annotations

from collections.abc import Awaitable
from typing import Any, Protocol, runtime_checkable

from agent_hooks._types import ManagedInterceptorOutcome, Verdict
from agent_hooks.context import AgentContext


@runtime_checkable
class Interceptor(Protocol):
    """A callable that receives a :class:`AgentContext` and returns a :class:`Verdict`.

    Interceptors MAY be sync or async; the emitter awaits coroutines. An interceptor
    MAY return a :class:`Verdict`, a wire-shaped ``dict``, or raise — the
    emitter normalizes per §5/§6.3.
    """

    def intercept(self, context: AgentContext, /) -> Verdict | dict[str, Any]: ...


@runtime_checkable
class ManagedInterceptor(Protocol):
    """An interceptor that owns external work (a process, an HTTP call)
    and therefore its own deadline (§6.3.1, §7).

    The emitter does not wrap it in the outer timer. On every call it
    receives the registration's resolved bound in seconds (``None`` is
    unbounded) and MUST cancel and clean up the work before it reports
    :meth:`ManagedInterceptorOutcome.timeout`. ``intercept_managed`` MAY
    be sync or async; the emitter awaits coroutines. A raise is the
    ``failed`` outcome; a return that is not a
    :class:`ManagedInterceptorOutcome` is ``host_error:verdict_invalid``.
    """

    def intercept_managed(
        self, context: AgentContext, bound: float | None, /
    ) -> ManagedInterceptorOutcome | Awaitable[ManagedInterceptorOutcome]: ...
