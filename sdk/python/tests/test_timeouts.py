# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""§7 interceptor/resolver timeout enforcement (NOW-09)."""
from __future__ import annotations

import asyncio
from typing import Any

from agent_hooks import InterceptionEmitter
from agent_hooks.context import AgentContextBuilder


def _ctx() -> dict[str, Any]:
    b = AgentContextBuilder(agent_id="a", framework="test", session_id="s")
    return b.input(content="hi", role="user")


class SlowInterceptor:
    async def intercept(self, context: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(1.0)
        return {"decision": "allow"}


class FastInterceptor:
    async def intercept(self, context: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(0)
        return {"decision": "allow"}


class EscalatingInterceptor:
    def intercept(self, context: dict[str, Any]) -> dict[str, Any]:
        # §5.1: a liftable deny (what earlier drafts called escalate).
        return {"decision": "deny", "approval": {}, "reason": "test"}


class SlowResolver:
    async def resolve(self, request: Any) -> Any:
        await asyncio.sleep(1.0)


def test_slow_interceptor_times_out() -> None:
    em = InterceptionEmitter(timeout=0.05).register(SlowInterceptor())
    record = asyncio.run(em.emit_unchecked(_ctx()))
    assert record.verdict.reason == "host_error:interceptor_timeout"
    assert not record.proceeds
    # §10.3 (D3): the §6.3 failure deny is attributed to the failing
    # interceptor's index.
    assert record.decided_by == 0


def test_fast_interceptor_passes_within_timeout() -> None:
    em = InterceptionEmitter(timeout=0.05).register(FastInterceptor())
    record = asyncio.run(em.emit_unchecked(_ctx()))
    assert record.proceeds
    assert record.verdict.reason is None


def test_slow_resolver_times_out() -> None:
    em = InterceptionEmitter(timeout=0.05, resolver=SlowResolver()).register(
        EscalatingInterceptor()
    )
    record = asyncio.run(em.emit_unchecked(_ctx()))
    assert record.verdict.reason == "host_error:approval_resolver_failed"
    assert record.verdict.message == "timeout"
    assert not record.proceeds


def test_timeout_none_disables_enforcement() -> None:
    class Sleep60ms:
        async def intercept(self, context: dict[str, Any]) -> dict[str, Any]:
            await asyncio.sleep(0.06)
            return {"decision": "allow"}

    em = InterceptionEmitter(timeout=None).register(Sleep60ms())
    record = asyncio.run(em.emit_unchecked(_ctx()))
    assert record.proceeds
