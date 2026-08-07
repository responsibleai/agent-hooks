# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Record-semantics tests (§4, §10.1, §10.3)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from agent_hooks import (
    Decision,
    EnforcementMode,
    IdentityProvider,
    InterceptionEmitter,
    Verdict,
)
from agent_hooks.composition import CompositionConfig


def _ctx(**over: Any) -> dict[str, Any]:
    ctx: dict[str, Any] = {
        "spec": "agent-hooks/0.1",
        "interception_point": "pre_tool_call",
        "timestamp": "2026-01-01T00:00:00Z",
        "sequence": 0,
        "agent": {"id": "a", "framework": "test"},
        "session": {"id": "s"},
        "target": {"q": "x"},
        "tool_call": {"id": "tc-1", "name": "t", "args": {"q": "x"}},
    }
    ctx.update(over)
    return ctx


class Allow:
    def intercept(self, context: dict[str, Any]) -> Verdict:
        return Verdict(decision=Decision.ALLOW)


def _emit(em: InterceptionEmitter, ctx: dict[str, Any]):
    return (
        asyncio.get_event_loop_policy().new_event_loop().run_until_complete(em.emit_unchecked(ctx))
    )


def test_envelope_missing_conditional_fails_closed() -> None:
    em = InterceptionEmitter()
    em.register(Allow())
    ctx = _ctx()
    del ctx["tool_call"]
    r = _emit(em, ctx)
    assert not r.proceeds
    assert r.verdict.reason == "host_error:context_invalid"
    assert r.input_identity is None and r.enforced_identity is None
    # §14/TM-09: value-free detail.
    assert (r.verdict.message or "") != "x"


def test_envelope_unknown_point_fails_closed() -> None:
    em = InterceptionEmitter()
    em.register(Allow())
    r = _emit(em, _ctx(interception_point="model_call"))
    assert not r.proceeds
    assert r.verdict.reason == "host_error:context_invalid"


def test_provider_name_rules_enforced() -> None:
    with pytest.raises(ValueError):
        InterceptionEmitter(identity_provider=IdentityProvider("jcs-fake", lambda c: "x"))
    with pytest.raises(ValueError):
        InterceptionEmitter(identity_provider=IdentityProvider("Bad Name", lambda c: "x"))
    InterceptionEmitter(identity_provider=IdentityProvider("myco-hash", lambda c: "x"))


def test_custom_provider_failure_fails_closed() -> None:
    def boom(_ctx: dict[str, Any]) -> str:
        raise RuntimeError("SECRET-VALUE should not leak")

    em = InterceptionEmitter(identity_provider=IdentityProvider("myco-hash", boom))
    em.register(Allow())
    r = _emit(em, _ctx())
    assert not r.proceeds
    assert r.verdict.reason == "host_error:context_invalid"
    assert "SECRET-VALUE" not in (r.verdict.message or "")
    assert r.identity_provider == "myco-hash"
    assert r.input_identity is None


def test_interceptors_registered_and_names() -> None:
    em = InterceptionEmitter()
    em.set_composition(CompositionConfig.run_all())
    em.register(Allow(), name="pii-scan").register(Allow())
    r = _emit(em, _ctx())
    assert r.proceeds
    assert r.interceptors_registered == 2
    assert r.verdicts[0].name == "pii-scan"
    assert r.verdicts[1].name is None


def test_knob_defaults_on_record() -> None:
    em = InterceptionEmitter(mode=EnforcementMode.ENFORCE)
    em.register(Allow())
    r = _emit(em, _ctx())
    assert r.composition.on_approval is not None  # resolved default: stop


def test_record_host_failure_rejection_shape() -> None:
    # §10.3 host projection failure: the host could not construct a
    # context at all; the synthesized record is the rejection shape
    # with the host's envelope facts.
    from agent_hooks import InterceptionPoint

    em = InterceptionEmitter()
    em.register(Allow())
    r = em.record_host_failure(
        InterceptionPoint.PRE_TOOL_CALL,
        "AttributeError",
        session_id="s",
        sequence=7,
        timestamp="2026-01-01T00:00:00Z",
    )
    assert not r.proceeds
    assert r.interception_point is InterceptionPoint.PRE_TOOL_CALL
    assert r.verdict.reason == "host_error:context_invalid"
    assert r.verdict.message == "AttributeError"
    # §10.3 rejection shape: null identities under the declared
    # provider, nothing dispatched.
    assert r.identity_provider == "jcs-sha256"
    assert r.input_identity is None and r.enforced_identity is None
    assert r.decided_by is None
    assert r.verdicts == ()
    assert r.interceptors_registered == 1
    # Envelope facts the host supplied.
    assert r.session_id == "s"
    assert r.sequence == 7
    assert r.timestamp == "2026-01-01T00:00:00Z"
    # The record entered the emitter's stream like any emission.
    assert em.results == [r]


def test_record_host_failure_unknown_envelope_defaults() -> None:
    from agent_hooks import InterceptionPoint

    em = InterceptionEmitter()
    r = em.record_host_failure(InterceptionPoint.OUTPUT)
    assert r.session_id == ""
    assert r.sequence == -1
    assert r.timestamp is None
    assert r.verdict.message is None
    assert r.interceptors_registered == 0


def test_record_host_failure_evaluate_only_records_and_hits_sink() -> None:
    # §8: synthesis still records in evaluate_only — records are the
    # point — and the mode member keeps the record from implying a
    # block happened.
    from agent_hooks import InterceptionPoint

    em = InterceptionEmitter(mode=EnforcementMode.EVALUATE_ONLY)
    seen: list[Any] = []
    em.set_record_sink(seen.append)
    r = em.record_host_failure(InterceptionPoint.PRE_TOOL_CALL, "TypeError")
    assert r.mode is EnforcementMode.EVALUATE_ONLY
    assert r.verdict.reason == "host_error:context_invalid"
    assert seen == [r]


def test_record_host_failure_detail_truncated_by_projection() -> None:
    # §10.3: the synthesized verdict crosses the same payload-free
    # projection as every combined verdict.
    from agent_hooks import InterceptionPoint

    em = InterceptionEmitter()
    r = em.record_host_failure(InterceptionPoint.PRE_TOOL_CALL, "x" * 300)
    assert r.verdict.message is not None
    assert r.verdict.message.endswith("…")
    assert len(r.verdict.message.encode()) <= 256 + len("…".encode())
