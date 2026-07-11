# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Emitter seam tests (NEXT-08/13/14/20), mirroring the Rust emitter's:
approval redaction (§9), record sink + retention bound (§10.3), and the
effective-target return from ``emit`` (§4.3).
"""
from __future__ import annotations

import asyncio
import json

from agent_hooks import (
    ApprovalOutcome,
    ApprovalRequest,
    ApprovalResolution,
    Decision,
    EmitOutcome,
    InterceptionEmitter,
    Transform,
    Verdict,
)
from agent_hooks._marshal import dumps
from agent_hooks.context import AgentContext, AgentContextBuilder


class Scripted:
    def __init__(self, verdict: Verdict) -> None:
        self.verdict = verdict

    def intercept(self, context: AgentContext) -> Verdict:
        return self.verdict


class CapturingApprover:
    """Approves and captures exactly what egressed through the seam."""

    def __init__(self) -> None:
        self.identity: str | None = None
        self.presented: str | None = None

    def resolve(self, request: ApprovalRequest) -> ApprovalResolution:
        self.identity = request.context_identity
        self.presented = dumps(request.context)
        return ApprovalResolution(
            outcome=ApprovalOutcome.APPROVE,
            context_identity=request.context_identity,
            verdict=Verdict(decision=Decision.ALLOW),
        )


def _ctx() -> AgentContext:
    b = AgentContextBuilder(agent_id="a", framework="x", session_id="s")
    return b.pre_tool_call(call_id="tc", name="t", args={"secret": "evil", "n": 1})


def test_redactor_binds_identity_to_presented_context() -> None:
    # §9/NEXT-08: the request identity covers the REDACTED context, and
    # the redacted value never reaches the resolver; record identities
    # are unaffected.
    approver = CapturingApprover()
    em = InterceptionEmitter(resolver=approver)
    em.register(Scripted(Verdict.escalate(reason="check")))

    def redact(ctx: AgentContext) -> AgentContext:
        out = json.loads(dumps(ctx))
        out["target"]["secret"] = "[redacted]"
        out["tool_call"]["args"]["secret"] = "[redacted]"
        return out

    em.set_approval_redactor(redact)
    record = asyncio.run(em.emit_unchecked(_ctx()))
    assert record.proceeds
    assert record.resolved_by == "approval"
    assert approver.presented is not None
    assert "evil" not in approver.presented
    # Identity was computed over what the approver saw, which differs
    # from the (unredacted) record identities.
    assert approver.identity is not None
    assert approver.identity != record.input_identity


def test_raising_redactor_fails_closed() -> None:
    approver = CapturingApprover()
    em = InterceptionEmitter(resolver=approver)
    em.register(Scripted(Verdict.escalate(reason="check")))

    def bad(_ctx: AgentContext) -> AgentContext:
        raise RuntimeError("SECRET must not leak")

    em.set_approval_redactor(bad)
    record = asyncio.run(em.emit_unchecked(_ctx()))
    assert not record.proceeds
    assert record.verdict.reason == "host_error:approval_resolver_failed"
    assert "SECRET" not in (record.verdict.message or "")


def test_record_sink_and_ring_buffer() -> None:
    seen: list[str] = []
    em = InterceptionEmitter()
    em.register(Scripted(Verdict(decision=Decision.ALLOW)))
    em.set_record_sink(lambda r: seen.append(r.session_id))
    em.set_max_records(2)
    for _ in range(5):
        asyncio.run(em.emit_unchecked(_ctx()))
    assert len(seen) == 5
    assert len(em.results) == 2
    assert em.records_dropped == 3
    assert len(em.take_records()) == 2
    assert em.results == []


def test_sink_exception_is_swallowed() -> None:
    em = InterceptionEmitter()
    em.register(Scripted(Verdict(decision=Decision.ALLOW)))

    def bad_sink(_r: object) -> None:
        raise RuntimeError("sink down")

    em.set_record_sink(bad_sink)
    record = asyncio.run(em.emit_unchecked(_ctx()))
    assert record.proceeds


def test_emit_returns_effective_target() -> None:
    # §4.3/NEXT-14: the returned target reflects the fold's transforms.
    em = InterceptionEmitter()
    em.register(
        Scripted(
            Verdict(
                decision=Decision.TRANSFORM,
                transform=Transform("$target.secret", "clean"),
            )
        )
    )
    outcome = asyncio.run(em.emit(_ctx()))
    assert isinstance(outcome, EmitOutcome)
    assert outcome.target["secret"] == "clean"
    assert outcome.record.proceeds
