# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Mid-emission cancellation semantics (LATER-11, §6.3/§12.2).

A cancelled in-flight emission must not leave a sequence gap with no
record: the emitter appends a fail-closed record
(``deny host_error:interceptor_failed``) and re-raises
:class:`asyncio.CancelledError`.
"""

from __future__ import annotations

import asyncio
from typing import Any

from agent_hooks import (
    CompositionConfig,
    Decision,
    HostError,
    InterceptionEmitter,
    Transform,
    Verdict,
)
from agent_hooks.context import AgentContext, AgentContextBuilder


class Hanging:
    """Async interceptor that blocks until cancelled."""

    def __init__(self) -> None:
        self.entered = asyncio.Event()

    async def intercept(self, context: AgentContext) -> Verdict:
        self.entered.set()
        await asyncio.sleep(3600)
        return Verdict(decision=Decision.ALLOW)  # pragma: no cover


class Transforming:
    def intercept(self, context: AgentContext) -> Verdict:
        return Verdict(
            decision=Decision.TRANSFORM, transform=Transform("$target.url", "clean")
        )


def _ctx() -> AgentContext:
    b = AgentContextBuilder(agent_id="a", framework="x", session_id="s")
    return b.pre_tool_call(call_id="tc", name="t", args={"url": "evil"})


def _cancel_mid_emission(em: InterceptionEmitter, hanging: Hanging) -> dict[str, Any]:
    async def scenario() -> dict[str, Any]:
        ctx = _ctx()
        task = asyncio.ensure_future(em.emit_unchecked(ctx))
        await hanging.entered.wait()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            return {"cancelled": True, "ctx": ctx}
        return {"cancelled": False, "ctx": ctx}  # pragma: no cover

    return asyncio.run(scenario())


def test_cancelled_emission_appends_fail_closed_record_and_reraises() -> None:
    em = InterceptionEmitter()
    hanging = Hanging()
    em.register(hanging)
    out = _cancel_mid_emission(em, hanging)
    assert out["cancelled"], "CancelledError must propagate to the caller"
    assert len(em.results) == 1, "no sequence gap: the aborted emission is recorded"
    rec = em.results[0]
    assert rec.verdict.decision is Decision.DENY
    assert rec.verdict.reason == HostError.INTERCEPTOR_FAILED.value
    assert rec.verdict.message == "CancelledError"
    assert not rec.proceeds


def test_cancelled_emission_after_partial_fold_records_folded_state() -> None:
    em = InterceptionEmitter(
        composition=CompositionConfig.first_deny()
    )
    hanging = Hanging()
    em.register(Transforming()).register(hanging)
    out = _cancel_mid_emission(em, hanging)
    assert out["cancelled"]
    rec = em.results[0]
    assert rec.verdict.reason == HostError.INTERCEPTOR_FAILED.value
    # The first interceptor's transform already folded (§7.4): the
    # context is honestly half-transformed and the record's identities
    # bind to that observed state.
    assert out["ctx"]["target"]["url"] == "clean"
    assert rec.input_identity != rec.enforced_identity


def test_cancellation_outside_dispatch_is_untouched() -> None:
    """A cancel before emit_unchecked starts stays ordinary asyncio."""

    em = InterceptionEmitter()
    em.register(Transforming())

    async def scenario() -> bool:
        task = asyncio.ensure_future(asyncio.sleep(3600))
        await asyncio.sleep(0)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            return True
        return False  # pragma: no cover

    assert asyncio.run(scenario())
    assert len(em.results) == 0
