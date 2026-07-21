# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Core enums and value types for AGENT-HOOKS-0.1 (§3, §5, §8, §10.3, §11)."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Final

from agent_hooks.composition import CompositionConfig

#: Spec version this SDK implements (§4.1 ``spec`` field).
SPEC_VERSION: Final[str] = "agent-hooks/0.1"

#: Name of the default identity provider (§10.1, §10.2).
JCS_SHA256: Final[str] = "jcs-sha256"


class InterceptionPoint(str, Enum):
    """The closed set of agent lifecycle interception points (§3)."""

    AGENT_STARTUP = "agent_startup"
    INPUT = "input"
    PRE_MODEL_CALL = "pre_model_call"
    POST_MODEL_CALL = "post_model_call"
    PRE_TOOL_CALL = "pre_tool_call"
    POST_TOOL_CALL = "post_tool_call"
    OUTPUT = "output"
    AGENT_SHUTDOWN = "agent_shutdown"

    @property
    def transform_permitted(self) -> bool:
        """Whether a ``transform`` verdict is permitted at this point (§3, §4.3)."""
        return self not in {InterceptionPoint.AGENT_STARTUP, InterceptionPoint.AGENT_SHUTDOWN}

    @property
    def is_pre(self) -> bool:
        return self in {InterceptionPoint.PRE_MODEL_CALL, InterceptionPoint.PRE_TOOL_CALL}

    @property
    def is_post(self) -> bool:
        return self in {InterceptionPoint.POST_MODEL_CALL, InterceptionPoint.POST_TOOL_CALL}


class Decision(str, Enum):
    """Verdict decision values (§5.1). Three, closed: ``warn`` is
    ``allow`` + ``warnings[]``; ``escalate`` is ``deny`` + an
    ``approval`` block."""

    ALLOW = "allow"
    DENY = "deny"
    TRANSFORM = "transform"

    @property
    def permits(self) -> bool:
        """Whether the action proceeds under this decision (§2)."""
        return self in {Decision.ALLOW, Decision.TRANSFORM}

    @property
    def blocks(self) -> bool:
        return not self.permits


class EnforcementMode(str, Enum):
    """Whether the host acts on verdicts (§8)."""

    ENFORCE = "enforce"
    EVALUATE_ONLY = "evaluate_only"


class HostError(str, Enum):
    """Reserved ``host_error:*`` reasons a host synthesizes (§11)."""

    CONTEXT_INVALID = "host_error:context_invalid"
    INTERCEPTOR_FAILED = "host_error:interceptor_failed"
    INTERCEPTOR_TIMEOUT = "host_error:interceptor_timeout"
    VERDICT_INVALID = "host_error:verdict_invalid"
    TRANSFORM_INVALID = "host_error:transform_invalid"
    TRANSFORM_TARGET_FORBIDDEN = "host_error:transform_target_forbidden"
    #: §7.5: two or more transforms against the same snapshot in a
    #: parallel profile.
    TRANSFORM_CONFLICT = "host_error:transform_conflict"
    #: §7.5: non-unanimous outcome under ``parallel/unanimous``.
    COMPOSITION_DISAGREEMENT = "host_error:composition_disagreement"
    APPROVAL_RESOLVER_FAILED = "host_error:approval_resolver_failed"
    APPROVAL_UNRESOLVED = "host_error:approval_unresolved"
    #: §9 echo rule: the resolution's ``context_identity`` did not match
    #: the request's byte for byte.
    APPROVAL_IDENTITY_MISMATCH = "host_error:approval_identity_mismatch"
    ADAPTER_UNSUPPORTED = "host_error:adapter_unsupported"
    NO_INTERCEPTOR = "host_error:no_interceptor"
    STREAMING_UNSUPPORTED = "host_error:streaming_unsupported"


@dataclass(frozen=True, slots=True)
class Transform:
    """A single ``$target``-rooted replacement (§5.2)."""

    path: str
    value: Any

    def __post_init__(self) -> None:
        if not (self.path.startswith("$target") or self.path.startswith("$policy_target")):
            raise ValueError(f"transform.path must be rooted at $target (got {self.path!r})")

    def to_wire(self) -> dict[str, Any]:
        # Mirrors the core: value serialized only when non-null; the
        # §10.3 record projection drops it (the §5 wire gate checks
        # presence for interceptor verdicts, so this never weakens it).
        if self.value is None:
            return {"path": self.path}
        return {"path": self.path, "value": self.value}

    @classmethod
    def from_wire(cls, obj: dict[str, Any]) -> Transform:
        return cls(path=obj["path"], value=obj["value"])


@dataclass(frozen=True, slots=True)
class Evidence:
    """Opaque pointer to an offline-verifiable artefact (§5.3)."""

    artefact: str | None = None
    verification_pointers: dict[str, str] = field(default_factory=dict)

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.artefact is not None:
            out["artefact"] = self.artefact
        if self.verification_pointers:
            out["verification_pointers"] = dict(self.verification_pointers)
        return out

    @classmethod
    def from_wire(cls, obj: dict[str, Any]) -> Evidence:
        return cls(
            artefact=obj.get("artefact"),
            verification_pointers=dict(obj.get("verification_pointers") or {}),
        )


@dataclass(frozen=True, slots=True)
class Warning:
    """A recorded concern that does not affect control flow (§5.1)."""

    reason: str | None = None
    message: str | None = None

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.reason is not None:
            out["reason"] = self.reason
        if self.message is not None:
            out["message"] = self.message
        return out

    @classmethod
    def from_wire(cls, obj: Any) -> Warning:
        if not isinstance(obj, dict):
            raise ValueError("warnings must be an array of objects (§5)")
        reason = obj.get("reason")
        if reason is not None and (not isinstance(reason, str) or reason.startswith("host_error:")):
            raise ValueError("warnings[].reason must be a non-reserved string")
        message = obj.get("message")
        if message is not None and not isinstance(message, str):
            raise ValueError("warnings[].message must be string or null")
        return cls(reason=reason, message=message)


@dataclass(frozen=True, slots=True)
class Verdict:
    """Interceptor return value (§5).

    Hosts construct a Verdict from an interceptor's wire output via
    :meth:`from_wire`, which validates per §5 and raises :class:`ValueError`
    on violation; the emitter maps that to ``host_error:verdict_invalid``.
    """

    decision: Decision
    reason: str | None = None
    message: str | None = None
    #: Recorded concerns; permitted on any decision (§5.1).
    warnings: tuple[Warning, ...] = ()
    #: Present only on ``deny``: marks the deny as liftable by the
    #: approval seam (§9). MAY be empty; reserved for approver-facing
    #: parameters.
    approval: dict[str, Any] | None = None
    transform: Transform | None = None
    evidence: Evidence | None = None
    result_labels: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.reason is not None and self.reason.startswith("host_error:"):
            raise ValueError("verdict.reason MUST NOT start with 'host_error:' (§5)")
        if self.approval is not None and self.decision is not Decision.DENY:
            raise ValueError("approval block permitted only on deny (§5.1)")
        if self.decision is Decision.TRANSFORM and self.transform is None:
            raise ValueError("transform body REQUIRED when decision=='transform' (§5)")
        if self.decision is not Decision.TRANSFORM and self.transform is not None:
            raise ValueError("transform body FORBIDDEN when decision!='transform' (§5)")

    @property
    def is_liftable(self) -> bool:
        """A deny carrying an ``approval`` block (§5.1)."""
        return self.decision is Decision.DENY and self.approval is not None

    @classmethod
    def warn(cls, *, reason: str | None = None, message: str | None = None) -> Verdict:
        """Constructor sugar for what earlier drafts called ``warn``: an
        ``allow`` carrying one warning (§5.1)."""
        return cls(
            decision=Decision.ALLOW,
            warnings=(Warning(reason=reason, message=message),),
        )

    @classmethod
    def deny(cls, *, reason: str | None = None, message: str | None = None) -> Verdict:
        """Constructor sugar for a plain, final deny: no ``approval``
        block, so the approval seam cannot lift it (§5.1)."""
        return cls(decision=Decision.DENY, reason=reason, message=message)

    @classmethod
    def escalate(cls, *, reason: str | None = None, message: str | None = None) -> Verdict:
        """Constructor sugar for what earlier drafts called ``escalate``:
        a liftable deny — denied as-is unless the approval seam lifts it
        (§5.1, §9)."""
        return cls(decision=Decision.DENY, reason=reason, message=message, approval={})

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"decision": self.decision.value}
        if self.reason is not None:
            out["reason"] = self.reason
        if self.message is not None:
            out["message"] = self.message
        if self.warnings:
            out["warnings"] = [w.to_wire() for w in self.warnings]
        if self.approval is not None:
            out["approval"] = dict(self.approval)
        if self.transform is not None:
            out["transform"] = self.transform.to_wire()
        if self.evidence is not None:
            out["evidence"] = self.evidence.to_wire()
        if self.result_labels:
            out["result_labels"] = list(self.result_labels)
        return out

    @classmethod
    def from_wire(cls, obj: Any) -> Verdict:
        if not isinstance(obj, dict):
            raise ValueError("verdict must be a JSON object")
        decision_raw = obj.get("decision")
        # The closed set is three (§5.1): warn is allow+warnings,
        # escalate is deny+approval. The old wire names fail closed.
        try:
            decision = Decision(decision_raw)
        except ValueError as e:
            raise ValueError(
                f"verdict.decision invalid: {decision_raw!r} (§5.1: allow|deny|transform)"
            ) from e
        reason = obj.get("reason")
        if reason is not None and not isinstance(reason, str):
            raise ValueError("verdict.reason must be string or null")
        message = obj.get("message")
        if message is not None and not isinstance(message, str):
            raise ValueError("verdict.message must be string or null")
        raw_warnings = obj.get("warnings")
        if raw_warnings is None:
            raw_warnings = []
        if not isinstance(raw_warnings, list):
            raise ValueError("warnings must be an array of objects (§5)")
        warnings = tuple(Warning.from_wire(w) for w in raw_warnings)
        approval = obj.get("approval")
        if approval is not None and not isinstance(approval, dict):
            raise ValueError("verdict.approval must be an object (§5)")
        transform = None
        if obj.get("transform") is not None:
            t = obj["transform"]
            if not isinstance(t, dict) or "path" not in t or "value" not in t:
                raise ValueError("verdict.transform must be {path, value}")
            transform = Transform.from_wire(t)
        evidence = None
        if obj.get("evidence") is not None:
            if not isinstance(obj["evidence"], dict):
                raise ValueError("verdict.evidence must be an object")
            evidence = Evidence.from_wire(obj["evidence"])
        labels = obj.get("result_labels") or []
        if not isinstance(labels, list) or not all(isinstance(s, str) for s in labels):
            raise ValueError("verdict.result_labels must be an array of strings")
        return cls(
            decision=decision,
            reason=reason,
            message=message,
            warnings=warnings,
            approval=dict(approval) if approval is not None else None,
            transform=transform,
            evidence=evidence,
            result_labels=tuple(labels),
        )

    @classmethod
    def host_error(
        cls, err: HostError, message: str | None = None, *, liftable: bool = False
    ) -> Verdict:
        """Host-synthesized deny verdict for a §11 failure.

        ``reason`` carries the reserved ``host_error:*`` identifier; this
        bypasses the interceptor-side prefix check by constructing
        directly. ``liftable=True`` is the §7.5 ``"approval"`` knob
        value: the failure is consultable rather than final.
        """
        v = object.__new__(cls)
        object.__setattr__(v, "decision", Decision.DENY)
        object.__setattr__(v, "reason", err.value)
        object.__setattr__(v, "message", message)
        object.__setattr__(v, "warnings", ())
        object.__setattr__(v, "approval", {} if liftable else None)
        object.__setattr__(v, "transform", None)
        object.__setattr__(v, "evidence", None)
        object.__setattr__(v, "result_labels", ())
        return v

    @classmethod
    def _from_core(cls, vw: dict[str, Any]) -> Verdict:
        """Reconstruct from core-emitted JSON without the §5 gate.

        The core serializes verdicts permissively (they may carry a
        host-synthesized ``host_error:*`` reason), so bypass
        :meth:`from_wire`/``__post_init__`` and construct directly.
        """
        transform = None
        if vw.get("transform") is not None:
            # §10.3 record projection drops transform.value.
            transform = Transform(vw["transform"]["path"], vw["transform"].get("value"))
        evidence = None
        if vw.get("evidence") is not None:
            evidence = Evidence.from_wire(vw["evidence"])
        v = object.__new__(cls)
        object.__setattr__(v, "decision", Decision(vw["decision"]))
        object.__setattr__(v, "reason", vw.get("reason"))
        object.__setattr__(v, "message", vw.get("message"))
        object.__setattr__(
            v,
            "warnings",
            tuple(
                Warning(reason=w.get("reason"), message=w.get("message"))
                for w in vw.get("warnings") or ()
            ),
        )
        object.__setattr__(v, "approval", vw.get("approval"))
        object.__setattr__(v, "transform", transform)
        object.__setattr__(v, "evidence", evidence)
        object.__setattr__(v, "result_labels", tuple(vw.get("result_labels") or ()))
        return v


#: Convenience constant for the trivial permit verdict.
ALLOW: Final[Verdict] = Verdict(decision=Decision.ALLOW)


@dataclass(frozen=True, slots=True)
class VerdictSummary:
    """Payload-free per-interceptor summary on the record (§10.3)."""

    index: int
    decision: Decision
    reason: str | None = None
    #: Host-chosen payload-free registration identifier (§10.3).
    name: str | None = None

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"index": self.index, "decision": self.decision.value}
        if self.reason is not None:
            out["reason"] = self.reason
        if self.name is not None:
            out["name"] = self.name
        return out

    @classmethod
    def from_wire(cls, obj: dict[str, Any]) -> VerdictSummary:
        return cls(
            index=obj["index"],
            decision=Decision(obj["decision"]),
            reason=obj.get("reason"),
            name=obj.get("name"),
        )


@dataclass(frozen=True, slots=True)
class InterceptionRecord:
    """Host-side record of one emission (§10.3).

    Payload-free by design: the identities (when a provider is declared)
    bind the record to the exact pre/post-composition context without
    duplicating the (possibly sensitive) payload into audit storage.
    ``composition`` makes the record interpretable without out-of-band
    knowledge of host configuration.
    """

    interception_point: InterceptionPoint
    mode: EnforcementMode
    #: The combined verdict (§7.3), possibly host-synthesized or
    #: approval-substituted.
    verdict: Verdict
    #: Provider output before dispatch; ``None`` iff ``identity_provider``
    #: is ``None`` (or the provider itself rejected the context).
    input_identity: str | None
    #: Provider output after composition completes.
    enforced_identity: str | None
    #: The declared identity provider (§10.1); ``None`` = unbound.
    identity_provider: str | None = None
    #: ``ctx.session.id`` — correlates records across a session.
    session_id: str = ""
    #: ``ctx.sequence`` — total order within the session (§12.2.3).
    sequence: int = -1
    #: RFC 3339 instant copied from ``ctx.timestamp`` (§10.3); ``None``
    #: when the context lacked the field.
    timestamp: str | None = None
    #: W3C Trace Context correlation echoed from the context's optional
    #: ``trace`` block (§4.5): ``{"trace_id": ..., "span_id": ...}``;
    #: ``None`` when the context carried none.
    trace: dict[str, str] | None = None
    #: Registration index of the interceptor whose verdict won the
    #: aggregation or whose liftable deny was consulted (§7.6); ``None``
    #: for a pure-allow combination or a host-synthesized verdict.
    decided_by: int | None = None
    #: The composition profile and knobs in effect (§7.1). REQUIRED.
    composition: CompositionConfig = field(default_factory=CompositionConfig.default)
    #: Per-interceptor summary; populated in multi-verdict profiles
    #: (``sequential/run_all``, ``parallel/*``).
    verdicts: tuple[VerdictSummary, ...] = ()
    #: ``True`` iff one or more registered interceptors were never
    #: invoked in this emission (short-circuit, approval-stop, or a
    #: failed fold-transform). Defined for the sequential profiles
    #: (§7.4).
    fold_truncated: bool | None = None
    #: Consultation outcome (§7.6, §10.3): ``"approval"`` iff a permit
    #: resolution substituted; ``"rejection"`` iff consulted without a
    #: lift; ``None`` iff never consulted.
    resolved_by: str | None = None
    #: Interceptors registered at emission time (§10.3).
    interceptors_registered: int = 0

    @property
    def proceeds(self) -> bool:
        """Whether the guarded action executes (§6, §8)."""
        if self.mode is EnforcementMode.EVALUATE_ONLY:
            return True
        return self.verdict.decision.permits

    def to_wire(self) -> dict[str, Any]:
        """Wire shape per ``spec/schema/interception-record.schema.json``.

        Mirrors the core's serde serialization: ``verdicts`` omitted when
        empty; ``fold_truncated``/``resolved_by`` omitted when ``None``.
        """
        out: dict[str, Any] = {
            "interception_point": self.interception_point.value,
            "mode": self.mode.value,
            "verdict": self.verdict.to_wire(),
            "input_identity": self.input_identity,
            "enforced_identity": self.enforced_identity,
            "identity_provider": self.identity_provider,
            "session_id": self.session_id,
            "sequence": self.sequence,
            "decided_by": self.decided_by,
            "composition": self.composition.to_wire(),
        }
        if self.timestamp is not None:
            out["timestamp"] = self.timestamp
        if self.trace is not None:
            out["trace"] = dict(self.trace)
        if self.verdicts:
            out["verdicts"] = [v.to_wire() for v in self.verdicts]
        if self.fold_truncated is not None:
            out["fold_truncated"] = self.fold_truncated
        if self.resolved_by is not None:
            out["resolved_by"] = self.resolved_by
        out["interceptors_registered"] = self.interceptors_registered
        return out

    @classmethod
    def from_core(cls, obj: dict[str, Any]) -> InterceptionRecord:
        """Reconstruct from the JSON emitted by ``_core.finalize``."""
        return cls(
            interception_point=InterceptionPoint(obj["interception_point"]),
            mode=EnforcementMode(obj["mode"]),
            verdict=Verdict._from_core(obj["verdict"]),
            input_identity=obj.get("input_identity"),
            enforced_identity=obj.get("enforced_identity"),
            identity_provider=obj.get("identity_provider"),
            session_id=obj.get("session_id", ""),
            sequence=obj.get("sequence", -1),
            timestamp=obj.get("timestamp"),
            trace=obj.get("trace"),
            decided_by=obj.get("decided_by"),
            composition=CompositionConfig.from_wire(obj.get("composition")),
            verdicts=tuple(VerdictSummary.from_wire(v) for v in obj.get("verdicts") or ()),
            fold_truncated=obj.get("fold_truncated"),
            resolved_by=obj.get("resolved_by"),
            interceptors_registered=obj.get("interceptors_registered", 0),
        )
