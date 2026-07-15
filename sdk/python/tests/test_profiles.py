# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Composition-profile emitter tests (§7), mirroring the Rust emitter's.

Covers all four profiles, the ``on_approval`` stop/resume knob, the
run_all single-consult rule, parallel transform conflict, unanimous
disagreement, the §4.4 NaN marshalling guard, the §10.1 provider seam
(None/custom), and the §10.2 big-int rejection.
"""

from __future__ import annotations

import asyncio
import copy
from typing import Any

from agent_hooks import (
    ApprovalOutcome,
    ApprovalRequest,
    ApprovalResolution,
    CompositionConfig,
    Decision,
    EnforcementMode,
    IdentityProvider,
    InterceptionEmitter,
    InterceptionRecord,
    OnApproval,
    SynthesisPolicy,
    Transform,
    Verdict,
)
from agent_hooks.context import AgentContext, AgentContextBuilder


class Scripted:
    """Interceptor that always returns one verdict."""

    def __init__(self, verdict: Verdict) -> None:
        self.verdict = verdict
        self.calls = 0

    def intercept(self, context: AgentContext) -> Verdict:
        self.calls += 1
        return self.verdict


class Approver:
    """Resolver with a fixed outcome/verdict; echoes the identity (§9)."""

    def __init__(self, outcome: ApprovalOutcome, verdict: Verdict | None) -> None:
        self.outcome = outcome
        self.verdict = verdict
        self.calls = 0

    def resolve(self, request: ApprovalRequest) -> ApprovalResolution:
        self.calls += 1
        return ApprovalResolution(
            outcome=self.outcome,
            context_identity=request.context_identity,  # echo rule
            verdict=self.verdict,
        )


def _ctx() -> AgentContext:
    b = AgentContextBuilder(agent_id="a", framework="x", session_id="s")
    return b.pre_tool_call(call_id="tc", name="t", args={"url": "evil"})


def _transform(path: str, value: Any) -> Verdict:
    return Verdict(decision=Decision.TRANSFORM, transform=Transform(path, value))


def _deny() -> Verdict:
    return Verdict(decision=Decision.DENY)


def _emit(em: InterceptionEmitter, ctx: AgentContext) -> InterceptionRecord:
    return asyncio.run(em.emit_unchecked(ctx))


# ---- sequential/run_all -----------------------------------------------------


def test_run_all_runs_everything_and_strictest_wins() -> None:
    em = InterceptionEmitter(composition=CompositionConfig.run_all())
    late = Scripted(Verdict.warn(reason="late"))
    em.register(Scripted(_deny())).register(late)
    r = _emit(em, _ctx())
    assert r.verdict.decision is Decision.DENY
    assert late.calls == 1, "run_all: everything runs"
    assert len(r.verdicts) == 2
    assert r.decided_by == 0
    # §7.3: warnings union onto the deny combination.
    assert len(r.verdict.warnings) == 1
    assert r.fold_truncated is None, "not defined outside first_deny"


def test_run_all_transforms_fold_through() -> None:
    em = InterceptionEmitter(composition=CompositionConfig.run_all())
    seen: list[Any] = []

    class Peek:
        def intercept(self, context: AgentContext) -> Verdict:
            seen.append(copy.deepcopy(context["target"]["url"]))
            return Verdict(decision=Decision.ALLOW)

    em.register(Scripted(_transform("$target.url", "safe"))).register(Peek())
    ctx = _ctx()
    r = _emit(em, ctx)
    assert r.verdict.decision is Decision.TRANSFORM
    assert seen == ["safe"], "§7.4: later interceptors observe the fold"
    assert ctx["target"]["url"] == "safe"
    assert r.input_identity != r.enforced_identity


def test_run_all_consults_once_when_all_denies_liftable() -> None:
    approver = Approver(ApprovalOutcome.APPROVE, Verdict(decision=Decision.ALLOW))
    em = InterceptionEmitter(resolver=approver, composition=CompositionConfig.run_all())
    em.register(Scripted(Verdict.escalate(reason="a")))
    em.register(Scripted(Verdict.escalate(reason="b")))
    r = _emit(em, _ctx())
    # §7.4: one consultation lifts the entire deny set.
    assert approver.calls == 1
    assert r.verdict.decision is Decision.ALLOW
    assert r.resolved_by == "approval"
    assert r.decided_by == 0
    assert len(r.verdicts) == 2


def test_run_all_plain_deny_blocks_consult() -> None:
    approver = Approver(ApprovalOutcome.APPROVE, Verdict(decision=Decision.ALLOW))
    em = InterceptionEmitter(resolver=approver, composition=CompositionConfig.run_all())
    em.register(Scripted(Verdict.escalate())).register(Scripted(_deny()))
    r = _emit(em, _ctx())
    # §7.4: a single plain deny makes lifting pointless — severity
    # already decided; the seam is never consulted.
    assert approver.calls == 0
    assert r.verdict.decision is Decision.DENY
    assert not r.verdict.is_liftable
    assert r.decided_by == 1
    assert r.resolved_by is None


# ---- sequential/first_deny --------------------------------------------------


def test_first_deny_no_resolver_liftable_deny_stands() -> None:
    em = InterceptionEmitter()
    em.register(Scripted(Verdict.escalate(reason="check")))
    r = _emit(em, _ctx())
    # §9: no resolver → the liftable deny stands, NOT an error.
    assert r.verdict.decision is Decision.DENY
    assert r.verdict.reason == "check"
    assert r.verdict.is_liftable
    assert r.resolved_by is None
    assert r.decided_by == 0


def test_first_deny_stop_truncates_and_records_substitution() -> None:
    approver = Approver(ApprovalOutcome.APPROVE, Verdict(decision=Decision.ALLOW))
    em = InterceptionEmitter(
        resolver=approver, composition=CompositionConfig.first_deny(OnApproval.STOP)
    )
    skipped = Scripted(_deny())
    em.register(Scripted(Verdict.escalate())).register(skipped)
    r = _emit(em, _ctx())
    assert r.verdict.decision is Decision.ALLOW
    assert skipped.calls == 0, "§7.4 stop: interceptors after the deny never run"
    assert r.fold_truncated is True
    assert r.resolved_by == "approval"
    assert r.decided_by == 0


def test_first_deny_resume_continues_the_fold() -> None:
    approver = Approver(ApprovalOutcome.APPROVE, Verdict(decision=Decision.ALLOW))
    em = InterceptionEmitter(
        resolver=approver, composition=CompositionConfig.first_deny(OnApproval.RESUME)
    )
    em.register(Scripted(Verdict.escalate()))
    em.register(Scripted(_deny()))  # now runs — and denies
    r = _emit(em, _ctx())
    assert r.verdict.decision is Decision.DENY
    assert r.decided_by == 1
    assert r.resolved_by == "approval"
    assert r.fold_truncated is False


def test_first_deny_resume_allows_multiple_consultations() -> None:
    approver = Approver(ApprovalOutcome.APPROVE, Verdict(decision=Decision.ALLOW))
    em = InterceptionEmitter(
        resolver=approver, composition=CompositionConfig.first_deny(OnApproval.RESUME)
    )
    em.register(Scripted(Verdict.escalate(reason="one")))
    em.register(Scripted(Verdict.escalate(reason="two")))
    r = _emit(em, _ctx())
    # §7.4 resume: each subsequently encountered liftable deny MAY be
    # consulted in turn.
    assert approver.calls == 2
    assert r.verdict.decision is Decision.ALLOW
    assert r.fold_truncated is False
    assert r.resolved_by == "approval"


def test_first_deny_reject_leaves_deny_standing() -> None:
    approver = Approver(ApprovalOutcome.REJECT, Verdict(decision=Decision.DENY, reason="rejected"))
    em = InterceptionEmitter(resolver=approver)
    em.register(Scripted(Verdict.escalate(reason="check")))
    r = _emit(em, _ctx())
    assert r.verdict.decision is Decision.DENY
    assert r.verdict.reason == "rejected"
    # §10.3: a consultation that did not lift is still recorded.
    assert r.resolved_by == "rejection"
    assert r.decided_by == 0


def test_echo_rule_violation_fails_closed() -> None:
    class BadEcho:
        def resolve(self, request: ApprovalRequest) -> ApprovalResolution:
            return ApprovalResolution(
                outcome=ApprovalOutcome.APPROVE,
                context_identity="sha256:forged",
                verdict=Verdict(decision=Decision.ALLOW),
            )

    em = InterceptionEmitter(resolver=BadEcho())
    em.register(Scripted(Verdict.escalate()))
    r = _emit(em, _ctx())
    assert r.verdict.reason == "host_error:approval_identity_mismatch"
    assert r.decided_by is None


def test_approve_with_deny_is_verdict_invalid() -> None:
    # §9: approve MUST carry a permit verdict. ApprovalResolution's own
    # constructor enforces this, so use a duck-typed resolution.
    class Res:
        outcome = ApprovalOutcome.APPROVE
        verdict = Verdict(decision=Decision.DENY)
        context_identity: str | None = None

    class BadApprover:
        def resolve(self, request: ApprovalRequest) -> Any:
            res = Res()
            res.context_identity = request.context_identity
            return res

    em = InterceptionEmitter(resolver=BadApprover())
    em.register(Scripted(Verdict.escalate()))
    r = _emit(em, _ctx())
    assert r.verdict.reason == "host_error:verdict_invalid"


def test_reject_with_permit_is_verdict_invalid() -> None:
    class Res:
        outcome = ApprovalOutcome.REJECT
        verdict = Verdict(decision=Decision.ALLOW)
        context_identity: str | None = None

    class BadRejecter:
        def resolve(self, request: ApprovalRequest) -> Any:
            res = Res()
            res.context_identity = request.context_identity
            return res

    em = InterceptionEmitter(resolver=BadRejecter())
    em.register(Scripted(Verdict.escalate()))
    r = _emit(em, _ctx())
    assert r.verdict.reason == "host_error:verdict_invalid"


def test_shutdown_never_consults() -> None:
    approver = Approver(ApprovalOutcome.APPROVE, Verdict(decision=Decision.ALLOW))
    em = InterceptionEmitter(resolver=approver)
    em.register(Scripted(Verdict.escalate()))
    b = AgentContextBuilder(agent_id="a", framework="x", session_id="s")
    r = _emit(em, b.agent_shutdown(reason="completed"))
    # §6.1a: the liftable deny is recorded, the seam untouched.
    assert approver.calls == 0
    assert r.verdict.is_liftable
    assert r.resolved_by is None


def test_evaluate_only_never_consults_and_proceeds() -> None:
    approver = Approver(ApprovalOutcome.APPROVE, Verdict(decision=Decision.ALLOW))
    em = InterceptionEmitter(mode=EnforcementMode.EVALUATE_ONLY, resolver=approver)
    em.register(Scripted(Verdict.escalate()))
    r = _emit(em, _ctx())
    assert approver.calls == 0
    assert r.verdict.is_liftable
    assert r.proceeds, "§8: evaluate_only proceeds regardless"


# ---- parallel/strictest -----------------------------------------------------


def test_parallel_strictest_transform_conflict_fails_closed() -> None:
    em = InterceptionEmitter(composition=CompositionConfig.strictest(SynthesisPolicy.DENY))
    em.register(Scripted(_transform("$target.url", "a")))
    em.register(Scripted(_transform("$target.url", "b")))
    ctx = _ctx()
    r = _emit(em, ctx)
    assert r.verdict.reason == "host_error:transform_conflict"
    # Snapshot isolation: neither transform applied.
    assert ctx["target"]["url"] == "evil"
    assert r.decided_by is None
    assert len(r.verdicts) == 2


def test_parallel_strictest_conflict_approval_consults_seam() -> None:
    approver = Approver(ApprovalOutcome.APPROVE, _transform("$target.url", "resolved"))
    em = InterceptionEmitter(
        resolver=approver,
        composition=CompositionConfig.strictest(SynthesisPolicy.APPROVAL),
    )
    em.register(Scripted(_transform("$target.url", "a")))
    em.register(Scripted(_transform("$target.url", "b")))
    ctx = _ctx()
    r = _emit(em, ctx)
    # §7.5 "approval": the resolver may resolve the conflict with a
    # transform of its own.
    assert approver.calls == 1
    assert r.verdict.decision is Decision.TRANSFORM
    assert ctx["target"]["url"] == "resolved"
    assert r.resolved_by == "approval"
    assert r.decided_by is None, "synthesized trigger"


def test_parallel_strictest_single_transform_applies() -> None:
    em = InterceptionEmitter(composition=CompositionConfig.strictest(SynthesisPolicy.DENY))
    em.register(Scripted(Verdict(decision=Decision.ALLOW)))
    em.register(Scripted(_transform("$target.url", "safe")))
    ctx = _ctx()
    r = _emit(em, ctx)
    assert r.verdict.decision is Decision.TRANSFORM
    assert r.decided_by == 1
    assert ctx["target"]["url"] == "safe"
    assert r.input_identity != r.enforced_identity


def test_parallel_strictest_isolated_snapshots() -> None:
    seen: list[Any] = []

    class Mutating:
        def intercept(self, context: AgentContext) -> Verdict:
            context["target"]["url"] = "mutated"  # must not leak anywhere
            return Verdict(decision=Decision.ALLOW)

    class Peek:
        def intercept(self, context: AgentContext) -> Verdict:
            seen.append(context["target"]["url"])
            return Verdict(decision=Decision.ALLOW)

    em = InterceptionEmitter(composition=CompositionConfig.strictest())
    em.register(Mutating()).register(Peek())
    ctx = _ctx()
    r = _emit(em, ctx)
    assert seen == ["evil"], "§7.5: no interceptor observes another's mutation"
    assert ctx["target"]["url"] == "evil"
    assert r.verdict.decision is Decision.ALLOW


def test_parallel_strictest_liftable_winner_consults() -> None:
    approver = Approver(ApprovalOutcome.APPROVE, Verdict(decision=Decision.ALLOW))
    em = InterceptionEmitter(resolver=approver, composition=CompositionConfig.strictest())
    em.register(Scripted(Verdict(decision=Decision.ALLOW)))
    em.register(Scripted(Verdict.escalate(reason="check")))
    r = _emit(em, _ctx())
    assert approver.calls == 1
    assert r.verdict.decision is Decision.ALLOW
    assert r.resolved_by == "approval"
    assert r.decided_by == 1


# ---- parallel/unanimous -----------------------------------------------------


def test_unanimous_allow_passes_with_unions() -> None:
    em = InterceptionEmitter(composition=CompositionConfig.unanimous())
    a = Verdict(decision=Decision.ALLOW, result_labels=("l1",))
    b = Verdict.warn(reason="w")
    em.register(Scripted(a)).register(Scripted(b))
    r = _emit(em, _ctx())
    assert r.verdict.decision is Decision.ALLOW
    assert r.verdict.result_labels == ("l1",)
    assert len(r.verdict.warnings) == 1


def test_unanimous_disagreement_synthesizes_deny() -> None:
    em = InterceptionEmitter(
        composition=CompositionConfig.unanimous(SynthesisPolicy.DENY, SynthesisPolicy.DENY)
    )
    em.register(Scripted(Verdict(decision=Decision.ALLOW)))
    em.register(Scripted(_transform("$target.url", "x")))
    ctx = _ctx()
    r = _emit(em, ctx)
    assert r.verdict.reason == "host_error:composition_disagreement"
    assert ctx["target"]["url"] == "evil", "transform not applied"
    assert r.decided_by is None
    assert len(r.verdicts) == 2


def test_unanimous_disagreement_approval_consults_seam() -> None:
    approver = Approver(ApprovalOutcome.APPROVE, Verdict(decision=Decision.ALLOW))
    em = InterceptionEmitter(
        resolver=approver,
        composition=CompositionConfig.unanimous(SynthesisPolicy.APPROVAL, SynthesisPolicy.DENY),
    )
    em.register(Scripted(Verdict(decision=Decision.ALLOW)))
    em.register(Scripted(_deny()))
    r = _emit(em, _ctx())
    assert approver.calls == 1
    assert r.verdict.decision is Decision.ALLOW
    assert r.resolved_by == "approval"
    assert r.decided_by is None, "synthesized trigger"


def test_unanimous_disagreement_approval_without_resolver_stands() -> None:
    em = InterceptionEmitter(
        composition=CompositionConfig.unanimous(SynthesisPolicy.APPROVAL, SynthesisPolicy.DENY)
    )
    em.register(Scripted(Verdict(decision=Decision.ALLOW)))
    em.register(Scripted(_deny()))
    r = _emit(em, _ctx())
    # §9: no resolver → the synthesized liftable deny stands.
    assert r.verdict.reason == "host_error:composition_disagreement"
    assert r.verdict.is_liftable
    assert r.resolved_by is None


# ---- identity provider seam (§10.1) ----------------------------------------


def test_null_provider_unbound_record() -> None:
    em = InterceptionEmitter(identity_provider=None)
    em.register(Scripted(Verdict(decision=Decision.ALLOW)))
    r = _emit(em, _ctx())
    assert r.input_identity is None
    assert r.enforced_identity is None
    assert r.identity_provider is None


def test_custom_provider_identities_and_name() -> None:
    calls: list[str] = []

    def fingerprint(ctx: AgentContext) -> str:
        calls.append(ctx["interception_point"])
        return f"host:{ctx['sequence']}"

    em = InterceptionEmitter(identity_provider=IdentityProvider("host-hash", fingerprint))
    em.register(Scripted(Verdict(decision=Decision.ALLOW)))
    r = _emit(em, _ctx())
    assert r.identity_provider == "host-hash"
    assert r.input_identity == "host:0"
    assert r.enforced_identity == "host:0"
    assert calls, "custom provider function was used"


def test_default_provider_rejects_big_int_before_dispatch() -> None:
    scripted = Scripted(Verdict(decision=Decision.ALLOW))
    em = InterceptionEmitter().register(scripted)
    ctx = _ctx()
    ctx["target"]["id"] = 9007199254740993  # 2^53 + 1
    r = _emit(em, ctx)
    assert r.verdict.reason == "host_error:context_invalid"
    assert "string-encode" in (r.verdict.message or "")
    assert scripted.calls == 0, "no interceptor ran"
    assert not r.proceeds


def test_default_provider_rejects_beyond_u64_literal() -> None:
    # AR-09-001 regression: serde-class parsers coerce integer literals
    # beyond u64 to a double, so byte-distinct contexts would silently
    # share an identity without the core's raw-text scan. Python ints
    # are arbitrary precision, so the literal reaches the core intact.
    scripted = Scripted(Verdict(decision=Decision.ALLOW))
    em = InterceptionEmitter().register(scripted)
    ctx = _ctx()
    ctx["target"]["id"] = 2**64  # beyond u64: the coerced class
    r = _emit(em, ctx)
    assert r.verdict.reason == "host_error:context_invalid"
    assert "string-encode" in (r.verdict.message or "")
    assert scripted.calls == 0, "no interceptor ran"
    assert not r.proceeds


def test_nan_in_context_fails_closed_before_dispatch() -> None:
    # P-004 survivor: allow_nan=False at every marshalling site.
    scripted = Scripted(Verdict(decision=Decision.ALLOW))
    em = InterceptionEmitter().register(scripted)
    ctx = _ctx()
    ctx["target"]["ratio"] = float("nan")
    r = _emit(em, ctx)
    assert r.verdict.reason == "host_error:context_invalid"
    assert scripted.calls == 0, "no interceptor ran"
    assert not r.proceeds
    assert r.input_identity is None
    assert r.session_id == "s", "record envelope survives the marshalling failure"


def test_composition_recorded_on_every_record() -> None:
    em = InterceptionEmitter(composition=CompositionConfig.run_all())
    em.register(Scripted(Verdict(decision=Decision.ALLOW)))
    r = _emit(em, _ctx())
    # §7.1/§10.3: records are interpretable without out-of-band
    # knowledge of host configuration.
    assert r.composition == CompositionConfig.run_all()
    assert r.identity_provider == "jcs-sha256"


def test_sequence_unique_under_concurrent_emissions() -> None:
    """§12.2.3: sequence values are unique and totally ordered when
    emissions for different tool calls race across threads."""
    import threading

    from agent_hooks.context import AgentContextBuilder

    builder = AgentContextBuilder(agent_id="a", framework="x", session_id="s")
    seen: list[int] = []
    lock = threading.Lock()

    def emit_some() -> None:
        for _ in range(200):
            ctx = builder.pre_tool_call(call_id="tc", name="t", args={})
            with lock:
                seen.append(ctx["sequence"])

    threads = [threading.Thread(target=emit_some) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(seen) == 1600
    assert len(set(seen)) == 1600, "sequence values must be unique (§12.2.3)"
