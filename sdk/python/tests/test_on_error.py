# Copyright (c) Microsoft. All rights reserved.

"""Failure posture ``on_error`` (§6.3.1), the principal notification,
the typed managed-interceptor outcome (§7) and the 1.1 declaration
members (§7.7.3, §7.7.5).

Mirrors the ``on_error`` tests in ``sdk/rust/core/src/emitter.rs`` and
``declaration.rs``: the substitution shape is built by the core, the
dispatch and the notification are this wrapper's.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from agent_hooks import (
    DECLARATION_VERSION,
    SUPPORTED_DECLARATION_VERSIONS,
    ApprovalOutcome,
    ApprovalRequest,
    ApprovalResolution,
    BindingContext,
    CompositionConfig,
    CompositionProfile,
    ControlFailureNotice,
    Decision,
    DeclarationBuilder,
    DeclarationError,
    DeclarationErrorClass,
    HostDeclaration,
    HostError,
    HostRegistry,
    HostSurface,
    InterceptionEmitter,
    InterceptionPoint,
    InterceptionRecord,
    ManagedInterceptorOutcome,
    OnError,
    RegistrationError,
    Transform,
    Verdict,
    VerdictSummary,
    Warning,
)
from agent_hooks.context import AgentContext, AgentContextBuilder

V1_0 = "agent-hooks-declaration/1.0"


def _ctx() -> AgentContext:
    b = AgentContextBuilder(agent_id="a", framework="test", session_id="s")
    return b.pre_tool_call(call_id="tc", name="http_get", args={"url": "evil"})


def _emit(em: InterceptionEmitter, ctx: AgentContext | None = None) -> InterceptionRecord:
    return asyncio.run(em.emit_unchecked(ctx if ctx is not None else _ctx()))


class Raises:
    def intercept(self, _ctx: AgentContext) -> Verdict:
        raise RuntimeError("SECRET-PAYLOAD must not leak")


class Malformed:
    def intercept(self, _ctx: AgentContext) -> dict[str, Any]:
        return {"decision": "transform"}


class Slow:
    async def intercept(self, _ctx: AgentContext) -> Verdict:
        await asyncio.sleep(60)
        return Verdict.allow()


class Allow:
    def intercept(self, _ctx: AgentContext) -> Verdict:
        return Verdict.allow()


class Warns:
    def intercept(self, _ctx: AgentContext) -> Verdict:
        return Verdict.warn(reason="pii")


class Denies:
    def intercept(self, _ctx: AgentContext) -> Verdict:
        return Verdict.deny(reason="policy")


class Escalates:
    def intercept(self, _ctx: AgentContext) -> Verdict:
        return Verdict.escalate(reason="gate")


def _with_notifier(**kw: Any) -> tuple[InterceptionEmitter, list[ControlFailureNotice]]:
    notices: list[ControlFailureNotice] = []
    em = InterceptionEmitter(**kw).set_control_failure_notifier(notices.append)
    return em, notices


def _assert_substituted(r: InterceptionRecord, index: int, binding: str, reason: str) -> None:
    s = r.verdicts[index]
    assert s.decision is Decision.ALLOW, s
    assert s.reason is None, s
    assert s.name == binding
    assert s.substituted_for == reason
    expected = Warning(
        reason="host_warning:control_failed", message=f"{binding}: {reason}; host continued"
    )
    assert expected in r.verdict.warnings, r.verdict.warnings
    wire = r.to_wire()
    assert wire["verdicts"][index]["substituted_for"] == reason
    assert "reason" not in wire["verdicts"][index]


# ---- the three covered failures under continue (item 9) ------------------------


def test_continue_substitutes_allow_for_a_raise() -> None:
    em, notices = _with_notifier()
    em.register(Raises(), "defender", on_error=OnError.CONTINUE).register(Allow(), "audit")
    ctx = _ctx()
    r = _emit(em, ctx)
    assert r.proceeds
    assert r.verdict.decision is Decision.ALLOW
    assert r.verdict.reason is None
    assert len(r.verdict.warnings) == 1
    assert len(r.verdicts) == 2, "the fold continued past the failure"
    _assert_substituted(r, 0, "defender", "host_error:interceptor_failed")
    assert r.verdicts[1].substituted_for is None
    assert r.decided_by is None, "a substituted allow decides nothing"
    assert r.fold_truncated is False
    assert ctx["target"]["url"] == "evil", "target unchanged"
    # The principal was told, with the reason, before the action
    # continued.
    assert len(notices) == 1
    n = notices[0]
    assert n.binding == "defender"
    assert n.index == 0
    assert n.reason == "host_error:interceptor_failed"
    assert n.message == "defender: host_error:interceptor_failed; host continued"
    assert n.interception_point is InterceptionPoint.PRE_TOOL_CALL
    # Host-synthesized text carries nothing from the interceptor or
    # the target.
    text = repr(r.verdict) + repr(n)
    assert "SECRET" not in text and "evil" not in text


def test_continue_substitutes_allow_for_an_invalid_verdict() -> None:
    em, notices = _with_notifier()
    em.register(Malformed(), "defender", on_error="continue")
    r = _emit(em)
    assert r.proceeds
    _assert_substituted(r, 0, "defender", "host_error:verdict_invalid")
    assert notices[0].reason == "host_error:verdict_invalid"


def test_continue_substitutes_allow_for_a_timeout() -> None:
    em, notices = _with_notifier(timeout=0.02)
    em.register(Slow(), "defender", on_error=OnError.CONTINUE).register(Allow())
    r = _emit(em)
    assert r.proceeds
    assert len(r.verdicts) == 2
    _assert_substituted(r, 0, "defender", "host_error:interceptor_timeout")
    assert notices[0].reason == "host_error:interceptor_timeout"


def test_nameless_registration_uses_its_index_as_the_label() -> None:
    # §6.3.1: a registration with no name uses the label
    # ``interceptor-<index>`` with the index written as a decimal
    # integer, as in the Rust core and the C ABI.
    em, notices = _with_notifier()
    em.register(Allow()).register(Raises(), on_error=OnError.CONTINUE)
    r = _emit(em)
    assert r.proceeds
    assert r.verdicts[1].substituted_for == "host_error:interceptor_failed"
    assert r.verdicts[1].name is None
    assert (
        r.verdict.warnings[0].message
        == "interceptor-1: host_error:interceptor_failed; host continued"
    )
    assert notices[0].binding == "interceptor-1"


# ---- the same three under deny: unchanged ---------------------------------------


@pytest.mark.parametrize(
    ("interceptor", "reason", "timeout"),
    [
        (Raises(), "host_error:interceptor_failed", 5.0),
        (Malformed(), "host_error:verdict_invalid", 5.0),
        (Slow(), "host_error:interceptor_timeout", 0.02),
    ],
    ids=["raise", "invalid", "timeout"],
)
def test_deny_is_the_default_and_unchanged(interceptor: Any, reason: str, timeout: float) -> None:
    for posture in (None, OnError.DENY, "deny"):
        em, notices = _with_notifier(timeout=timeout)
        if posture is None:
            em.register(interceptor, "defender")
        else:
            em.register(interceptor, "defender", on_error=posture)
        em.register(Allow(), "audit")
        r = _emit(em)
        assert not r.proceeds
        assert r.verdict.reason == reason
        assert r.verdict.warnings == ()
        assert r.decided_by == 0
        assert r.fold_truncated is True
        assert r.verdicts[0].substituted_for is None
        assert "substituted_for" not in r.to_wire()["verdicts"][0]
        assert notices == []


# ---- what continue never covers ---------------------------------------------------


def test_continue_without_a_notifier_is_refused_at_registration() -> None:
    em = InterceptionEmitter()
    with pytest.raises(RegistrationError, match="control failure notifier") as info:
        em.register(Allow(), "x", on_error=OnError.CONTINUE)
    assert "x:" in info.value.detail
    assert em._interceptors == [], "nothing was registered"

    class Managed:
        def intercept_managed(self, _c: AgentContext, _b: float | None) -> Any:
            return ManagedInterceptorOutcome.timeout()

    with pytest.raises(RegistrationError, match="unnamed registration"):
        em.register_managed(Managed(), on_error="continue")
    # Deny needs no channel; after the channel exists, continue is
    # accepted.
    em.register(Allow())
    em.set_control_failure_notifier(lambda _n: None)
    em.register(Allow(), "x", on_error=OnError.CONTINUE)
    em.register_managed(Managed(), "m", on_error=OnError.CONTINUE)
    assert len(em._interceptors) == 3
    with pytest.raises(ValueError, match="on_error"):
        em.register(Allow(), on_error="allow")  # type: ignore[arg-type]


def test_notifier_failure_withdraws_the_continuation() -> None:
    def boom(_n: ControlFailureNotice) -> None:
        raise RuntimeError("channel down")

    em = InterceptionEmitter().set_control_failure_notifier(boom)
    em.register(Raises(), "defender", on_error=OnError.CONTINUE)
    r = _emit(em)
    assert not r.proceeds
    assert r.verdict.reason == "host_error:interceptor_failed"
    assert r.verdict.message is not None and "notifier" in r.verdict.message
    assert r.verdicts[0].substituted_for is None
    assert r.verdict.warnings == ()


def test_continue_never_covers_cancellation() -> None:
    class Cancelled:
        def intercept_managed(self, _c: AgentContext, _b: float | None) -> Any:
            return ManagedInterceptorOutcome.cancelled()

    em, notices = _with_notifier(composition=CompositionConfig.run_all())
    em.register_managed(Cancelled(), "managed", on_error=OnError.CONTINUE).register(
        Allow(), "second"
    )
    r = _emit(em)
    assert not r.proceeds
    assert r.verdict.reason == "host_error:interceptor_failed"
    assert r.verdict.message is not None and "cancelled" in r.verdict.message
    assert r.verdicts[0].substituted_for is None
    assert r.verdicts[1].decision is Decision.ALLOW, "run_all still ran the rest"
    assert r.decided_by == 0
    assert notices == []


def test_asyncio_cancellation_still_fails_closed_under_continue() -> None:
    class Hanging:
        def __init__(self) -> None:
            self.entered = asyncio.Event()

        async def intercept(self, _c: AgentContext) -> Verdict:
            self.entered.set()
            await asyncio.sleep(3600)
            return Verdict.allow()  # pragma: no cover

    em, notices = _with_notifier()
    hanging = Hanging()
    em.register(hanging, "slow", on_error=OnError.CONTINUE)

    async def scenario() -> bool:
        task = asyncio.ensure_future(em.emit_unchecked(_ctx()))
        await hanging.entered.wait()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            return True
        return False  # pragma: no cover

    assert asyncio.run(scenario())
    rec = em.results[0]
    assert rec.verdict.reason == HostError.INTERCEPTOR_FAILED.value
    assert rec.verdict.message == "CancelledError"
    assert not rec.proceeds
    assert notices == []


def test_continue_never_covers_approval_failures() -> None:
    class Failing:
        def resolve(self, _req: ApprovalRequest) -> ApprovalResolution:
            raise RuntimeError("queue down")

    em, notices = _with_notifier(resolver=Failing())
    em.register(Escalates(), "gate", on_error=OnError.CONTINUE)
    r = _emit(em)
    assert not r.proceeds
    assert r.verdict.reason == "host_error:approval_resolver_failed"
    assert r.resolved_by == "rejection"
    assert r.verdicts[0].substituted_for is None
    assert notices == []

    class SlowResolver:
        async def resolve(self, _req: ApprovalRequest) -> ApprovalResolution:
            await asyncio.sleep(60)
            raise AssertionError  # pragma: no cover

    em, notices = _with_notifier(resolver=SlowResolver(), timeout=0.02)
    em.register(Escalates(), "gate", on_error=OnError.CONTINUE)
    r = _emit(em)
    assert r.verdict.reason == "host_error:approval_resolver_failed"
    assert r.verdict.message == "timeout"
    assert notices == []


def test_continue_never_covers_context_failure_explicit_deny_or_no_interceptor() -> None:
    em, notices = _with_notifier()
    em.register(Raises(), "defender", on_error=OnError.CONTINUE)
    bad = _ctx()
    bad["sequence"] = float("nan")
    r = _emit(em, bad)
    assert r.verdict.reason == "host_error:context_invalid"
    assert r.verdicts == ()

    em, notices = _with_notifier()
    em.register(Denies(), "policy", on_error=OnError.CONTINUE)
    r = _emit(em)
    assert not r.proceeds
    assert r.verdict.reason == "policy"
    assert r.verdicts[0].substituted_for is None

    em, notices = _with_notifier()
    em.register(Raises(), "x", at=["output"], on_error=OnError.CONTINUE)
    r = _emit(em)
    assert r.verdict.reason == "host_error:no_interceptor"
    assert notices == []


def test_continue_never_covers_transform_failure() -> None:
    class BadTransform:
        def intercept(self, _c: AgentContext) -> Verdict:
            return Verdict(
                decision=Decision.TRANSFORM, transform=Transform("$target.nope.deeper", 1)
            )

    em, notices = _with_notifier()
    em.register(BadTransform(), "rewriter", on_error=OnError.CONTINUE)
    r = _emit(em)
    assert not r.proceeds
    assert r.verdict.reason is not None and r.verdict.reason.startswith("host_error:transform_")
    assert r.verdicts[0].substituted_for is None
    assert notices == []


# ---- every profile ----------------------------------------------------------------


@pytest.mark.parametrize(
    "composition",
    [
        CompositionConfig.first_deny(),
        CompositionConfig.run_all(),
        CompositionConfig.strictest(),
        CompositionConfig.unanimous(),
    ],
    ids=lambda c: c.profile.value,
)
def test_substituted_allow_takes_the_slot_in_every_profile(composition: CompositionConfig) -> None:
    em, notices = _with_notifier(composition=composition)
    em.register(Warns(), "pii").register(Raises(), "defender", on_error=OnError.CONTINUE)
    em.register(Allow(), "audit")
    r = _emit(em)
    assert r.proceeds, r.verdict
    assert r.verdict.decision is Decision.ALLOW
    # The §7.3 union keeps both warnings, first seen first.
    assert len(r.verdict.warnings) == 2
    assert r.verdict.warnings[0].reason == "pii"
    _assert_substituted(r, 1, "defender", "host_error:interceptor_failed")
    assert r.verdicts[0].substituted_for is None
    assert r.verdicts[2].substituted_for is None
    assert r.decided_by is None
    assert len(notices) == 1
    if composition.profile is CompositionProfile.SEQUENTIAL_FIRST_DENY:
        assert r.fold_truncated is False


def test_run_all_deny_wins_and_the_warning_stays_in_the_union() -> None:
    em, notices = _with_notifier(composition=CompositionConfig.run_all())
    em.register(Raises(), "flaky", on_error=OnError.CONTINUE).register(Denies(), "guard")
    em.register(Allow(), "second")
    r = _emit(em)
    assert not r.proceeds
    assert r.verdict.reason == "policy"
    assert r.decided_by == 1
    assert r.verdict.warnings[0].reason == "host_warning:control_failed"
    assert r.verdicts[0].substituted_for == "host_error:interceptor_failed"
    assert r.verdicts[1].reason == "policy"
    # The notice is owed even when another verdict denies (§6.3.1).
    assert len(notices) == 1


def test_evaluate_only_records_the_substitution_too() -> None:
    from agent_hooks import EnforcementMode

    em, notices = _with_notifier(mode=EnforcementMode.EVALUATE_ONLY)
    em.register(Raises(), "defender", on_error=OnError.CONTINUE)
    r = _emit(em)
    assert r.proceeds
    _assert_substituted(r, 0, "defender", "host_error:interceptor_failed")
    assert len(notices) == 1


def test_an_interceptor_cannot_emit_the_reserved_warning() -> None:
    class Spoofer:
        def intercept(self, _c: AgentContext) -> dict[str, Any]:
            return {"decision": "allow", "warnings": [{"reason": "host_warning:control_failed"}]}

    em = InterceptionEmitter().register(Spoofer(), "spoofer")
    r = _emit(em)
    assert not r.proceeds
    assert r.verdict.reason == "host_error:verdict_invalid"
    assert r.verdict.warnings == ()
    # Under continue the spoof is a covered failure: the host's own
    # substitute takes the slot, not the interceptor's forgery.
    em, _ = _with_notifier()
    em.register(Spoofer(), "spoofer", on_error=OnError.CONTINUE)
    r = _emit(em)
    assert r.proceeds
    _assert_substituted(r, 0, "spoofer", "host_error:verdict_invalid")


# ---- managed interceptors (§7, item 8) -----------------------------------------------


def test_managed_interceptor_receives_the_bound_and_reports_typed_outcomes() -> None:
    seen: list[float | None] = []
    cleaned: list[bool] = []

    class Scanner:
        def __init__(self, outcome: ManagedInterceptorOutcome) -> None:
            self.outcome = outcome

        async def intercept_managed(
            self, _c: AgentContext, bound: float | None
        ) -> ManagedInterceptorOutcome:
            seen.append(bound)
            if self.outcome.kind == "timeout":
                # The work is cancelled and cleaned up before the typed
                # outcome is reported (§7).
                work = asyncio.ensure_future(asyncio.sleep(3600))
                work.cancel()
                try:
                    await work
                except asyncio.CancelledError:
                    cleaned.append(True)
            return self.outcome

    # The emitter-wide timeout is the bound for a code registration,
    # and the emitter does not wrap the call in its own timer.
    em, notices = _with_notifier(timeout=1.5)
    em.register_managed(Scanner(ManagedInterceptorOutcome.timeout()), "scanner")
    r = _emit(em)
    assert seen == [1.5]
    assert not r.proceeds
    assert r.verdict.reason == "host_error:interceptor_timeout"
    assert r.verdicts[0].name == "scanner"
    assert cleaned == [True]

    em, notices = _with_notifier(timeout=1.5)
    em.register_managed(
        Scanner(ManagedInterceptorOutcome.timeout()), "scanner", on_error=OnError.CONTINUE
    )
    r = _emit(em)
    assert r.proceeds
    _assert_substituted(r, 0, "scanner", "host_error:interceptor_timeout")
    assert len(notices) == 1

    em, _ = _with_notifier(timeout=None)
    em.register_managed(Scanner(ManagedInterceptorOutcome.failed("IoError")), "scanner")
    r = _emit(em)
    assert seen[-1] is None, "unbounded is handed through as None"
    assert r.verdict.reason == "host_error:interceptor_failed"
    assert r.verdict.message == "IoError"

    em, _ = _with_notifier()
    em.register_managed(
        Scanner(ManagedInterceptorOutcome.of_verdict(Verdict.warn(reason="scanned"))), "scanner"
    )
    r = _emit(em)
    assert r.proceeds
    assert r.verdict.warnings[0].reason == "scanned"

    # A managed verdict crosses the §5 gate like any other.
    em, _ = _with_notifier()
    em.register_managed(
        Scanner(
            ManagedInterceptorOutcome.of_verdict({"decision": "allow", "reason": "host_error:x"})
        ),
        "scanner",
    )
    r = _emit(em)
    assert r.verdict.reason == "host_error:verdict_invalid"


def test_managed_raise_and_wrong_return_are_failures_not_crashes() -> None:
    class Panics:
        def intercept_managed(self, _c: AgentContext, _b: float | None) -> Any:
            raise RuntimeError("SECRET")

    class Wrong:
        def intercept_managed(self, _c: AgentContext, _b: float | None) -> Any:
            return {"decision": "allow"}

    em = InterceptionEmitter().register_managed(Panics(), "p")
    r = _emit(em)
    assert r.verdict.reason == "host_error:interceptor_failed"
    assert r.verdict.message == "RuntimeError"
    em = InterceptionEmitter().register_managed(Wrong(), "w")
    r = _emit(em)
    assert r.verdict.reason == "host_error:verdict_invalid"
    assert r.verdict.message is not None and "ManagedInterceptorOutcome" in r.verdict.message


def test_managed_outcome_wire_shapes() -> None:
    assert ManagedInterceptorOutcome.timeout().to_wire() == {"outcome": "timeout"}
    assert ManagedInterceptorOutcome.cancelled().to_wire() == {"outcome": "cancelled"}
    assert ManagedInterceptorOutcome.failed().to_wire() == {"outcome": "failed"}
    assert ManagedInterceptorOutcome.failed("IoError").to_wire() == {
        "outcome": "failed",
        "detail": "IoError",
    }
    assert ManagedInterceptorOutcome.of_verdict(Verdict.allow()).to_wire() == {
        "outcome": "verdict",
        "verdict": {"decision": "allow"},
    }
    s = VerdictSummary.from_wire(
        {"index": 0, "decision": "allow", "substituted_for": "host_error:interceptor_timeout"}
    )
    assert s.substituted_for == "host_error:interceptor_timeout"
    assert s.to_wire() == {
        "index": 0,
        "decision": "allow",
        "substituted_for": "host_error:interceptor_timeout",
    }


# ---- declaration 1.1 (items 1, 7, 9) ---------------------------------------------------


def _surface() -> HostSurface:
    return HostSurface.from_capabilities(["model_calls", "tool_calls", "host_declaration"])


def _registry(notices: list[ControlFailureNotice] | None = None) -> HostRegistry:
    reg = (
        HostRegistry(_surface())
        .kind("com.example.raises", lambda _c, _x: Raises())
        .kind("com.example.allow", lambda _c, _x: Allow())
        .kind("com.example.escalate", lambda _c, _x: Escalates())
    )
    if notices is not None:
        reg.control_failure_notifier(notices.append)
    return reg


def _load(doc: dict[str, Any], reg: HostRegistry) -> InterceptionEmitter:
    return InterceptionEmitter.from_declaration_value(doc, reg)


def _refusal(doc: dict[str, Any], reg: HostRegistry) -> DeclarationError:
    with pytest.raises(DeclarationError) as info:
        _load(doc, reg)
    return info.value


def test_versions_are_1_1_with_1_0_accepted() -> None:
    assert DECLARATION_VERSION == "agent-hooks-declaration/1.1"
    assert SUPPORTED_DECLARATION_VERSIONS == (V1_0, DECLARATION_VERSION)
    assert HostSurface.sdk_default().declaration_versions == frozenset(
        SUPPORTED_DECLARATION_VERSIONS
    )
    # A host still on 1.0 is a valid surface.
    HostSurface(declaration_versions=frozenset({V1_0})).validate()


def test_document_default_inherited_and_overridden() -> None:
    notices: list[ControlFailureNotice] = []
    doc = {
        "declaration": DECLARATION_VERSION,
        "configuration": {"failure": {"on_error": "continue"}},
        "bindings": [
            {"id": "inherits", "kind": "com.example.raises"},
            {"id": "overrides", "kind": "com.example.raises", "on_error": "deny"},
        ],
    }
    em = _load(doc, _registry(notices))
    assert em.declaration is not None
    assert em.declaration.failure_on_error is OnError.CONTINUE
    assert [b.on_error for b in em.declaration.bindings] == [OnError.CONTINUE, OnError.DENY]
    wire = em.declaration.to_wire()
    assert wire["configuration"]["failure"] == {"on_error": "continue"}
    assert [b["on_error"] for b in wire["bindings"]] == ["continue", "deny"]
    r = _emit(em)
    assert not r.proceeds, "the overriding binding denies"
    assert r.verdict.reason == "host_error:interceptor_failed"
    assert r.decided_by == 1
    assert r.verdicts[0].substituted_for == "host_error:interceptor_failed"
    assert r.verdicts[1].substituted_for is None
    assert r.declaration == DECLARATION_VERSION
    assert [n.binding for n in notices] == ["inherits"]

    # Absent document default: deny, and a binding may still opt in.
    doc = {
        "declaration": DECLARATION_VERSION,
        "bindings": [{"id": "flaky", "kind": "com.example.raises", "on_error": "continue"}],
    }
    em = _load(doc, _registry([]))
    assert em.declaration is not None
    assert em.declaration.failure_on_error is OnError.DENY
    r = _emit(em)
    assert r.proceeds
    _assert_substituted(r, 0, "flaky", "host_error:interceptor_failed")


def test_binding_context_carries_the_resolved_on_error() -> None:
    seen: list[BindingContext] = []

    def capture(_config: Any, ctx: BindingContext) -> Allow:
        seen.append(ctx)
        return Allow()

    reg = HostRegistry(_surface()).kind("com.example.capture", capture)
    reg.control_failure_notifier(lambda _n: None)
    _load(
        {
            "declaration": DECLARATION_VERSION,
            "configuration": {"failure": {"on_error": "continue"}},
            "bindings": [
                {"id": "a", "kind": "com.example.capture"},
                {"id": "b", "kind": "com.example.capture", "on_error": "deny"},
            ],
        },
        reg,
    )
    assert [c.on_error for c in seen] == [OnError.CONTINUE, OnError.DENY]
    assert seen[0].declaration_version == DECLARATION_VERSION


def test_a_1_0_document_loads_unchanged() -> None:
    doc = {
        "declaration": V1_0,
        "configuration": {"composition": {"profile": "sequential/run_all"}},
        "bindings": [
            {"id": "flaky", "kind": "com.example.raises"},
            {"id": "second", "kind": "com.example.allow"},
        ],
    }
    em = _load(doc, _registry())
    assert em.declaration is not None
    assert em.declaration.version == V1_0
    assert em.declaration.failure_on_error is OnError.DENY
    assert all(b.on_error is OnError.DENY for b in em.declaration.bindings)
    r = _emit(em)
    assert not r.proceeds
    assert r.verdict.reason == "host_error:interceptor_failed"
    assert r.declaration == V1_0, "the record carries the document's own version"
    assert r.verdicts[0].substituted_for is None
    # The resolved form spells the defaults out for a 1.0 document too.
    assert '"failure":{"on_error":"deny"}' in em.declaration.canonical_json()


def test_a_1_0_loader_refuses_a_1_1_document() -> None:
    reg = HostRegistry(
        HostSurface.from_capabilities(["host_declaration"]).__class__(
            interception_points=_surface().interception_points,
            capabilities=_surface().capabilities,
            declaration_versions=frozenset({V1_0}),
        )
    ).kind("com.example.allow", lambda _c, _x: Allow())
    doc_1_1 = {
        "declaration": DECLARATION_VERSION,
        "bindings": [{"id": "a", "kind": "com.example.allow"}],
    }
    e = _refusal(doc_1_1, reg)
    assert e.error_class is DeclarationErrorClass.VERSION_UNSUPPORTED
    assert e.findings[0].pointer == "/declaration"
    assert e.accepted == (V1_0,)
    # The same host loads a 1.0 document.
    _load({**doc_1_1, "declaration": V1_0}, reg)
    # A minor above the highest this SDK knows is refused the same way,
    # with this SDK's set.
    e = _refusal({**doc_1_1, "declaration": "agent-hooks-declaration/1.2"}, _registry())
    assert e.error_class is DeclarationErrorClass.VERSION_UNSUPPORTED
    assert e.accepted == SUPPORTED_DECLARATION_VERSIONS


@pytest.mark.parametrize(
    ("doc", "error_class", "pointer"),
    [
        (
            {
                "declaration": DECLARATION_VERSION,
                "bindings": [{"id": "a", "kind": "com.example.allow", "on_error": "ignore"}],
            },
            DeclarationErrorClass.INVALID_FIELD,
            "/bindings/0/on_error",
        ),
        (
            {
                "declaration": DECLARATION_VERSION,
                "configuration": {"failure": {"on_error": "allow"}},
                "bindings": [],
            },
            DeclarationErrorClass.INVALID_FIELD,
            "/configuration/failure/on_error",
        ),
        (
            {
                "declaration": V1_0,
                "bindings": [{"id": "a", "kind": "com.example.allow", "on_error": "continue"}],
            },
            DeclarationErrorClass.UNKNOWN_FIELD,
            "/bindings/0/on_error",
        ),
        (
            {
                "declaration": V1_0,
                "configuration": {"failure": {"on_error": "deny"}},
                "bindings": [],
            },
            DeclarationErrorClass.UNKNOWN_FIELD,
            "/configuration/failure",
        ),
        (
            {
                "declaration": DECLARATION_VERSION,
                "configuration": {"failure": {"on_timeout": "continue"}},
                "bindings": [],
            },
            DeclarationErrorClass.UNKNOWN_FIELD,
            "/configuration/failure/on_timeout",
        ),
    ],
    ids=["binding-value", "default-value", "binding-under-1.0", "default-under-1.0", "member"],
)
def test_on_error_refusals(
    doc: dict[str, Any], error_class: DeclarationErrorClass, pointer: str
) -> None:
    e = _refusal(doc, _registry([]))
    assert e.error_class is error_class
    assert e.findings[0].pointer == pointer


def test_continue_in_a_document_needs_a_notifier_on_the_registry() -> None:
    doc = {
        "declaration": DECLARATION_VERSION,
        "bindings": [{"id": "flaky", "kind": "com.example.raises", "on_error": "continue"}],
    }
    e = _refusal(doc, _registry())
    assert e.error_class is DeclarationErrorClass.BINDING_REJECTED
    assert e.findings[0].pointer == "/bindings/0/on_error"
    assert "control failure notifier" in e.findings[0].detail
    # Inherited from the document default: the pointer names it.
    doc = {
        "declaration": DECLARATION_VERSION,
        "configuration": {"failure": {"on_error": "continue"}},
        "bindings": [{"id": "flaky", "kind": "com.example.raises"}],
    }
    e = _refusal(doc, _registry())
    assert e.error_class is DeclarationErrorClass.BINDING_REJECTED
    assert e.findings[0].pointer == "/configuration/failure/on_error"
    # Deny needs no channel.
    _load({**doc, "configuration": {"failure": {"on_error": "deny"}}}, _registry())
    # The notifier may still be set on the sealed emitter: it is a host
    # channel, not declared configuration.
    em = _load({**doc, "configuration": {"failure": {"on_error": "deny"}}}, _registry())
    em.set_control_failure_notifier(lambda _n: None)


def test_builder_writes_the_1_1_members() -> None:
    b = (
        DeclarationBuilder()
        .failure_on_error(OnError.CONTINUE)
        .bind("a", "com.example.raises")
        .bind("b", "com.example.raises", on_error=OnError.DENY)
        .bind("c", "com.example.raises", on_error="continue")
    )
    doc = b.to_value()
    assert doc["declaration"] == DECLARATION_VERSION
    assert doc["configuration"] == {"failure": {"on_error": "continue"}}
    assert "on_error" not in doc["bindings"][0]
    assert doc["bindings"][1]["on_error"] == "deny"
    assert doc["bindings"][2]["on_error"] == "continue"
    notices: list[ControlFailureNotice] = []
    reg = _registry(notices)
    em = InterceptionEmitter.from_declaration(b.build(), reg)
    assert em.declaration is not None
    assert [x.on_error for x in em.declaration.bindings] == [
        OnError.CONTINUE,
        OnError.DENY,
        OnError.CONTINUE,
    ]
    # The builder path and the value path resolve to one form.
    assert (
        em.declaration.canonical_json()
        == reg.resolve(HostDeclaration.from_value(doc)).canonical_json()
    )
    # A wrong value is refused like a file.
    e = _refusal(DeclarationBuilder().failure_on_error("sometimes").to_value(), reg)
    assert e.error_class is DeclarationErrorClass.INVALID_FIELD


def test_managed_kind_through_a_declaration_receives_the_binding_bound() -> None:
    seen: list[float | None] = []

    class Scanner:
        def intercept_managed(self, _c: AgentContext, bound: float | None) -> Any:
            seen.append(bound)
            return ManagedInterceptorOutcome.timeout()

    reg = HostRegistry(_surface()).managed_kind("com.example.scanner", lambda _c, _x: Scanner())
    notices: list[ControlFailureNotice] = []
    reg.control_failure_notifier(notices.append)
    with pytest.raises(ValueError, match="registered twice"):
        reg.kind("com.example.scanner", lambda _c, _x: Allow())
    assert reg.names()["kinds"] == ["com.example.scanner"]
    em = _load(
        {
            "declaration": DECLARATION_VERSION,
            "configuration": {"timeouts": {"interceptor_ms": 4000}},
            "bindings": [
                {
                    "id": "scan",
                    "kind": "com.example.scanner",
                    "timeout_ms": 250,
                    "on_error": "continue",
                },
                {"id": "unbounded", "kind": "com.example.scanner", "timeout_ms": None},
            ],
        },
        reg,
    )
    r = _emit(em)
    assert seen == [0.25, None]
    assert not r.proceeds, "the unbounded binding's timeout denies under deny"
    assert r.verdicts[0].substituted_for == "host_error:interceptor_timeout"
    assert r.verdicts[1].reason == "host_error:interceptor_timeout"
    assert [n.binding for n in notices] == ["scan"]
    # A managed resolver that returns a standard interceptor is a
    # rejected binding, like the reverse.
    reg = HostRegistry(_surface()).managed_kind("com.example.scanner", lambda _c, _x: Allow())
    e = _refusal(
        {
            "declaration": DECLARATION_VERSION,
            "bindings": [{"id": "scan", "kind": "com.example.scanner"}],
        },
        reg,
    )
    assert e.error_class is DeclarationErrorClass.BINDING_REJECTED
    assert "managed interceptor" in e.findings[0].detail


def test_approval_outcome_unchanged_by_on_error() -> None:
    # Sanity: a liftable deny from a continue binding still consults
    # and a permit still substitutes (§9 is untouched by §6.3.1).
    class Approver:
        def resolve(self, request: ApprovalRequest) -> ApprovalResolution:
            return ApprovalResolution(
                outcome=ApprovalOutcome.APPROVE,
                context_identity=request.context_identity,
                verdict=Verdict.allow(),
            )

    em, notices = _with_notifier(resolver=Approver())
    em.register(Escalates(), "gate", on_error=OnError.CONTINUE)
    r = _emit(em)
    assert r.proceeds
    assert r.resolved_by == "approval"
    assert r.verdicts[0].substituted_for is None
    assert notices == []
