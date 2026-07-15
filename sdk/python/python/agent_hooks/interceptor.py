# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Interceptor protocol (§7)."""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from agent_hooks._types import Verdict
from agent_hooks.context import AgentContext


@runtime_checkable
class Interceptor(Protocol):
    """A callable that receives a :class:`AgentContext` and returns a :class:`Verdict`.

    Interceptors MAY be sync or async; the emitter awaits coroutines. An interceptor
    MAY return a :class:`Verdict`, a wire-shaped ``dict``, or raise — the
    emitter normalizes per §5/§6.3.
    """

    def intercept(self, context: AgentContext, /) -> Verdict | dict[str, Any]: ...
