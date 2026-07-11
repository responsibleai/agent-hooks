# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Host-side emitter: dispatch context → interceptors → composition →
combined verdict → record (§6–§10).

Per-language orchestrator over the Rust core:

- Interceptor dispatch (§7) and approval-seam resolution (§9) stay here
  because they call back into user Python code.
- Verdict validation (§5), severity-max aggregation (§7.3, via
  ``_core.compose_aggregate``), transform application (§5.2), identity
  computation (§10.2), record finalization (§10.3), and target
  write-back (§4.3) delegate to ``agent_hooks._core`` so behaviour is
  byte-identical across SDKs.

Composition is host configuration (§7.1): the profile is set on the
emitter (default ``sequential/first_deny, on_approval: stop``) and
recorded on every emission. "Parallel" profiles are implemented with
serial dispatch over isolated deep-copied snapshots — §7.2: parallel
names isolation semantics, not scheduling.

Fail-closed defaults: an ``enforce``-mode emission with zero registered
interceptors yields ``deny host_error:no_interceptor`` (§7), a context
that cannot cross the FFI boundary (non-finite number, out-of-domain
integer, §4.4/§10.2) yields ``deny host_error:context_invalid`` before
any interceptor runs, and :meth:`InterceptionEmitter.emit` **raises**
:class:`InterceptionBlocked` on any block — the ignorable-result
variant is the explicitly named :meth:`emit_unchecked`.

Concurrency (§12.2): emissions for different tool calls may interleave
on the event loop; ``sequence`` assignment and record append are atomic
under a single-threaded asyncio runtime. Sharing one emitter across OS
threads is not supported.
"""
from __future__ import annotations

import asyncio
import contextlib
import copy
import dataclasses
import inspect
import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from agent_hooks import _core
from agent_hooks._marshal import dumps
from agent_hooks._types import (
    JCS_SHA256,
    Decision,
    EnforcementMode,
    HostError,
    InterceptionPoint,
    InterceptionRecord,
    Verdict,
    VerdictSummary,
    Warning,
)
from agent_hooks.approval import (
    ApprovalOutcome,
    ApprovalRequest,
    ApprovalResolver,
)
from agent_hooks.composition import CompositionConfig, CompositionProfile, OnApproval
from agent_hooks.context import AgentContext
from agent_hooks.exceptions import InterceptionBlocked
from agent_hooks.interceptor import Interceptor

#: §7 RECOMMENDED interceptor/resolver timeout (seconds).
DEFAULT_TIMEOUT: float = 5.0


@dataclass(frozen=True, slots=True)
class IdentityProvider:
    """A host-supplied identity provider (§10.1): a name (matching
    ``^[a-z][a-z0-9_-]*$``, not starting with ``jcs``) and a pure
    function ``AgentContext -> str``. The echo and record rules still
    apply; the golden vectors do not.

    The shipped default is declared with the string ``"jcs-sha256"``
    (computed core-side, §10.2); identity-unbound operation with
    ``None``.
    """

    name: str
    fn: Callable[[AgentContext], str]


def _host_error_of(e: Exception, default: HostError) -> HostError:
    try:
        return HostError(getattr(e, "code", ""))
    except ValueError:
        return default


def _is_host_synthesized(v: Verdict) -> bool:
    """Whether a verdict was synthesized by the host (§11) rather than
    returned by an interceptor or resolver."""
    return v.reason is not None and v.reason.startswith("host_error:")


def _replace(v: Verdict, **kw: Any) -> Verdict:
    """``dataclasses.replace`` without re-running the §5 constructor
    gate (the verdict may carry a host-synthesized reason)."""
    out = object.__new__(Verdict)
    for f in (
        "decision",
        "reason",
        "message",
        "warnings",
        "approval",
        "transform",
        "evidence",
        "result_labels",
    ):
        object.__setattr__(out, f, kw.get(f, getattr(v, f)))
    return out


def _union_warnings(pool: list[Verdict]) -> tuple[Warning, ...]:
    """First-seen-ordered union of ``warnings`` from every verdict (§7.3)."""
    out: list[Warning] = []
    for v in pool:
        for w in v.warnings:
            if w not in out:
                out.append(w)
    return tuple(out)


def _union_labels(pool: list[Verdict]) -> tuple[str, ...]:
    """First-seen-ordered union of ``result_labels`` from every **permit**
    verdict (§7.3; §5.4 drops labels when the emission does not proceed)."""
    out: list[str] = []
    for v in pool:
        if not v.decision.permits:
            continue
        for label in v.result_labels:
            if label not in out:
                out.append(label)
    return tuple(out)


def _with_unions(combined: Verdict, pool: list[Verdict]) -> Verdict:
    """Apply the §7.3 metadata unions to a combined verdict."""
    kw: dict[str, Any] = {}
    warnings = _union_warnings(pool)
    if warnings:
        kw["warnings"] = warnings
    if combined.decision.permits:
        labels = _union_labels(pool)
        if labels:
            kw["result_labels"] = labels
    return _replace(combined, **kw) if kw else combined


def _summaries(
    verdicts: list[Verdict], names: list[str | None] | None = None
) -> tuple[VerdictSummary, ...]:
    """Payload-free per-interceptor summaries for the record (§10.3),
    with the hosts' registration names attached positionally."""
    names = names or []
    return tuple(
        VerdictSummary(
            index=i,
            decision=v.decision,
            reason=v.reason,
            name=names[i] if i < len(names) else None,
        )
        for i, v in enumerate(verdicts)
    )


def _envelope_only(ctx: AgentContext) -> dict[str, Any]:
    """The record-relevant envelope of a context that could not cross
    the FFI boundary intact (§10.3: interception_point, session, sequence)."""
    out: dict[str, Any] = {}
    ip = ctx.get("interception_point")
    if isinstance(ip, str):
        out["interception_point"] = ip
    session = ctx.get("session")
    if isinstance(session, dict) and isinstance(session.get("id"), str):
        out["session"] = {"id": session["id"]}
    seq = ctx.get("sequence")
    if isinstance(seq, int) and not isinstance(seq, bool):
        out["sequence"] = seq
    return out


@dataclass(slots=True)
class _Outcome:
    """Internal result of one profile dispatch."""

    combined: Verdict
    decided_by: int | None = None
    verdicts: tuple[VerdictSummary, ...] = ()
    fold_truncated: bool | None = None
    resolved_by: str | None = None


@dataclass(slots=True)
class EmitOutcome:
    """Returned by :meth:`InterceptionEmitter.emit` on a proceeding
    emission: the record plus the **effective** (post-composition)
    target the guarded action MUST consume (§4.3)."""

    record: InterceptionRecord
    target: Any


class InterceptionEmitter:
    """Host-side helper that implements §6–§10 once so adapters don't have to.

    ``timeout`` bounds each interceptor ``intercept()`` and resolver
    ``resolve()`` call (§7, RECOMMENDED default 5000 ms); breach fails
    closed with ``host_error:interceptor_timeout`` (interceptor) or
    ``host_error:approval_resolver_failed`` (resolver). Only *awaitable*
    returns can be preempted — a synchronous interceptor that blocks the
    event loop cannot be interrupted (use async interceptors for
    untrusted latency). ``timeout=None`` disables enforcement.

    ``composition`` declares the profile and knobs in effect (§7.1);
    ``identity_provider`` declares the identity seam (§10.1):
    ``"jcs-sha256"`` (default, computed by the core), an
    :class:`IdentityProvider` (custom name + function), or ``None``
    (identity-unbound records).
    """

    __slots__ = (
        "_approval_redactor",
        "_composition",
        "_identity",
        "_interceptors",
        "_max_records",
        "_mode",
        "_names",
        "_record_sink",
        "_records",
        "_records_dropped",
        "_resolver",
        "_timeout",
    )

    def __init__(
        self,
        *,
        mode: EnforcementMode = EnforcementMode.ENFORCE,
        resolver: ApprovalResolver | None = None,
        timeout: float | None = DEFAULT_TIMEOUT,
        composition: CompositionConfig | None = None,
        identity_provider: str | IdentityProvider | None = JCS_SHA256,
    ) -> None:
        self._interceptors: list[Interceptor] = []
        self._resolver = resolver
        self._mode = mode
        self._records: list[InterceptionRecord] = []
        self._timeout = timeout
        self._composition = composition if composition is not None else CompositionConfig.default()
        self._identity = self._check_provider(identity_provider)
        self._names: list[str | None] = []
        self._approval_redactor: Callable[[AgentContext], AgentContext] | None = None
        self._record_sink: Callable[[InterceptionRecord], None] | None = None
        self._max_records: int | None = None
        self._records_dropped = 0

    @staticmethod
    def _check_provider(
        provider: str | IdentityProvider | None,
    ) -> str | IdentityProvider | None:
        if (
            provider is not None
            and not isinstance(provider, IdentityProvider)
            and provider != JCS_SHA256
        ):
            raise ValueError(
                f"identity_provider must be {JCS_SHA256!r}, an IdentityProvider, "
                f"or None (got {provider!r}); wrap a custom provider in "
                "IdentityProvider(name, fn) (§10.1)"
            )
        # §10.1 name rules: enforced, not advisory — the jcs prefix is
        # reserved so a custom function can never claim golden-vector
        # semantics on records.
        if isinstance(provider, IdentityProvider) and (
            not re.fullmatch(r"[a-z][a-z0-9_-]*", provider.name)
            or provider.name.startswith("jcs")
        ):
            raise ValueError(
                "identity provider name must match ^[a-z][a-z0-9_-]*$ "
                "and must not begin with 'jcs' (§10.1)"
            )
        return provider

    @property
    def mode(self) -> EnforcementMode:
        return self._mode

    @property
    def composition(self) -> CompositionConfig:
        return self._composition

    @property
    def results(self) -> list[InterceptionRecord]:
        """All interception records emitted so far in this session, in order."""
        return list(self._records)

    def register(
        self, interceptor: Interceptor, name: str | None = None
    ) -> InterceptionEmitter:
        """Register an interceptor, optionally with a host-chosen
        payload-free ``name`` recorded on ``verdicts[].name`` (§10.3)."""
        self._interceptors.append(interceptor)
        self._names.append(name)
        return self

    def set_composition(self, composition: CompositionConfig) -> InterceptionEmitter:
        """Declare the composition profile for subsequent emissions (§7.1)."""
        self._composition = composition
        return self

    def set_identity_provider(
        self, provider: str | IdentityProvider | None
    ) -> InterceptionEmitter:
        """Declare the identity provider (§10.1)."""
        self._identity = self._check_provider(provider)
        return self

    def set_approval_redactor(
        self, redactor: Callable[[AgentContext], AgentContext]
    ) -> InterceptionEmitter:
        """Register the §9/§14 approval redactor: a pure function
        producing the context to place in every ApprovalRequest. The §9
        identity is computed over the redacted context (binding the
        approval to what the approver saw); the record's identities are
        unaffected. A redactor that raises fails the consultation closed
        as ``host_error:approval_resolver_failed``."""
        self._approval_redactor = redactor
        return self

    def set_record_sink(
        self, sink: Callable[[InterceptionRecord], None]
    ) -> InterceptionEmitter:
        """Register a per-emission record callback (§10.3), invoked
        synchronously after every emission before buffering; a sink
        exception is swallowed (audit delivery is the host's liveness
        concern, not the control plane's)."""
        self._record_sink = sink
        return self

    def set_max_records(self, max_records: int) -> InterceptionEmitter:
        """Bound the in-memory record buffer: when full, the OLDEST
        record is dropped and :attr:`records_dropped` increments.
        Unbounded by default."""
        self._max_records = max_records
        return self

    @property
    def records_dropped(self) -> int:
        """Records evicted by the :meth:`set_max_records` bound."""
        return self._records_dropped

    def take_records(self) -> list[InterceptionRecord]:
        """Drain the in-memory record buffer (retention stays bounded
        on long-running sessions)."""
        out = self._records
        self._records = []
        return out

    # -------------------------------------------------------------------------

    async def emit(self, ctx: AgentContext) -> EmitOutcome:
        """Run the emission and **raise** :class:`InterceptionBlocked`
        if the guarded action must not proceed (§6). This is the primary
        entry point; the safe path is the default.

        Returns the record plus the **effective** (post-composition)
        target the guarded action MUST consume (§4.3) — a reference
        captured before ``emit`` may predate a transform.
        """
        record = await self.emit_unchecked(ctx)
        if not record.proceeds:
            raise InterceptionBlocked(record)
        return EmitOutcome(record=record, target=ctx.get("target"))

    async def emit_unchecked(self, ctx: AgentContext) -> InterceptionRecord:
        """Run the emission and return the record without raising.

        The caller MUST inspect :attr:`InterceptionRecord.proceeds` and
        halt the guarded action itself; prefer :meth:`emit`.
        """
        # §10.3: input identity binds to the context BEFORE dispatch, so
        # neither interceptor mutation nor fold-through can retroactively
        # alter what the record claims was evaluated.
        input_identity: str | None = None
        outcome: _Outcome | None = None
        try:
            # §4.4 marshalling guard: a context the wire cannot carry
            # (NaN/Infinity) fails closed before any interceptor runs.
            # §4/§6.3: an invalid envelope is denied before any
            # interceptor or identity provider sees it.
            _core.validate_envelope(dumps(ctx))
            input_identity = self._compute_identity(ctx)
        except _core.AgentHooksCoreError as e:
            # §10.2: the default provider rejected the value domain.
            outcome = _Outcome(
                Verdict.host_error(_host_error_of(e, HostError.CONTEXT_INVALID), str(e))
            )
        except ValueError as e:
            outcome = _Outcome(
                Verdict.host_error(
                    HostError.CONTEXT_INVALID, f"context is not RFC 8259 JSON: {e}"
                )
            )
        except Exception as e:  # noqa: BLE001 — custom provider raised; fail closed
            outcome = _Outcome(
                Verdict.host_error(HostError.CONTEXT_INVALID, type(e).__name__)
            )
        if outcome is None:
            outcome = await self._dispatch(ctx)

        record = self._finalize(ctx, outcome, input_identity)
        if self._record_sink is not None:
            # Audit delivery must not take down the control plane
            # (§10.3): a sink failure is swallowed — the emission
            # outcome is already decided.
            with contextlib.suppress(Exception):
                self._record_sink(record)
        if self._max_records is not None:
            while len(self._records) >= max(self._max_records, 1):
                self._records.pop(0)
                self._records_dropped += 1
        self._records.append(record)
        return record

    # -------------------------------------------------------------------------

    def _provider_name(self) -> str | None:
        if self._identity is None:
            return None
        if isinstance(self._identity, IdentityProvider):
            return self._identity.name
        return JCS_SHA256

    def _compute_identity(self, ctx: AgentContext) -> str | None:
        """Provider output for ``ctx`` (§10.1); ``None`` iff the provider
        is ``None``. Raises on a §10.2 value-domain rejection."""
        if self._identity is None:
            return None
        if isinstance(self._identity, IdentityProvider):
            return self._identity.fn(ctx)
        return _core.context_identity(dumps(ctx))

    def _finalize(
        self, ctx: AgentContext, outcome: _Outcome, input_identity: str | None
    ) -> InterceptionRecord:
        """Build the §10.3 record via ``_core.finalize``."""
        declared = self._provider_name()
        options: dict[str, Any] = {
            "input_identity": input_identity,
            "identity_provider": declared,
            # Custom providers only; jcs-sha256 is computed core-side
            # from the post-composition context.
            "enforced_identity": None,
            "decided_by": outcome.decided_by,
            "composition": self._composition.to_wire(),
            "verdicts": [s.to_wire() for s in outcome.verdicts],
            "fold_truncated": outcome.fold_truncated,
            "resolved_by": outcome.resolved_by,
            "interceptors_registered": len(self._interceptors),
        }
        if isinstance(self._identity, IdentityProvider) and input_identity is not None:
            try:
                options["enforced_identity"] = self._identity.fn(ctx)
            except Exception:  # noqa: BLE001 — honest absence over failure
                options["enforced_identity"] = None
        verdict_json = dumps(outcome.combined.to_wire())
        try:
            record_json = _core.finalize(
                dumps(ctx), verdict_json, self._mode.value, dumps(options)
            )
        except ValueError:
            # The context cannot cross the FFI boundary intact (the
            # emission already failed closed above); record the envelope
            # only, with null identities — honest absence (§10.1).
            options["identity_provider"] = None
            options["enforced_identity"] = None
            record_json = _core.finalize(
                dumps(_envelope_only(ctx)), verdict_json, self._mode.value, dumps(options)
            )
        record = InterceptionRecord.from_core(json.loads(record_json))
        if record.identity_provider != declared:
            record = dataclasses.replace(record, identity_provider=declared)
        return record

    # -------------------------------------------------------------------------

    async def _dispatch(self, ctx: AgentContext) -> _Outcome:
        """Profile dispatch (§7.4–§7.5). Returns the combined verdict
        and its record metadata."""
        if not self._interceptors:
            # §7: zero interceptors fails closed, profile-independent.
            # Register an explicit allow-all interceptor for a
            # deliberate passthrough.
            return _Outcome(Verdict.host_error(HostError.NO_INTERCEPTOR))
        profile = self._composition.profile
        if profile is CompositionProfile.SEQUENTIAL_FIRST_DENY:
            return await self._dispatch_first_deny(ctx)
        if profile is CompositionProfile.SEQUENTIAL_RUN_ALL:
            return await self._dispatch_run_all(ctx)
        return await self._dispatch_parallel(ctx)

    async def _invoke(self, interceptor: Interceptor, ctx: AgentContext) -> Verdict:
        """Invoke one interceptor on its own deep copy of the context
        (§7) and normalize the return through the §5 gate; every failure
        maps to the §6.3 host-synthesized deny."""
        try:
            # §7: each interceptor gets its own deep copy — an in-place
            # mutation of the copy cannot alter enforcement.
            raw = interceptor.intercept(copy.deepcopy(ctx))
            if inspect.isawaitable(raw):
                # §7 timeout: only the awaitable path is preemptible.
                if self._timeout is not None:
                    raw = await asyncio.wait_for(raw, self._timeout)
                else:
                    raw = await raw
        except (TimeoutError, asyncio.TimeoutError):
            return Verdict.host_error(HostError.INTERCEPTOR_TIMEOUT)
        except Exception as e:  # noqa: BLE001 — fail closed per §6.3
            return Verdict.host_error(HostError.INTERCEPTOR_FAILED, type(e).__name__)
        try:
            wire = raw.to_wire() if isinstance(raw, Verdict) else raw
            # §5 gate in the core; from_wire re-types the normalized JSON.
            return Verdict.from_wire(json.loads(_core.validate_verdict(dumps(wire))))
        except _core.AgentHooksCoreError as e:
            return Verdict.host_error(_host_error_of(e, HostError.VERDICT_INVALID), str(e))
        except Exception as e:  # noqa: BLE001 — non-JSON return etc.
            return Verdict.host_error(HostError.VERDICT_INVALID, str(e))

    async def _dispatch_first_deny(self, ctx: AgentContext) -> _Outcome:
        """``sequential/first_deny`` (§7.4): fold-through, first deny
        short-circuits; a liftable deny consults the seam, then ``stop``
        or ``resume`` per the knob."""
        n = len(self._interceptors)
        on_approval = self._composition.on_approval or OnApproval.STOP
        names = self._names
        per: list[Verdict] = []  # index-aligned §10.3 summaries
        pool: list[Verdict] = []  # + substituted resolutions, §7.3 unions
        last_transform: tuple[int, Verdict] | None = None
        resolved_by: str | None = None

        def truncated(i: int) -> bool:
            return i + 1 < n

        for i, interceptor in enumerate(self._interceptors):
            v = await self._invoke(interceptor, ctx)
            per.append(v)
            pool.append(v)
            if _is_host_synthesized(v):
                # §6.3: malformed verdict fails closed and — in this
                # profile — short-circuits like any deny. The failure
                # deny is attributed to the failing interceptor (§10.3
                # decided_by), matching the aggregation profiles.
                return _Outcome(
                    _with_unions(v, pool), i, _summaries(per, names), truncated(i), resolved_by
                )

            if v.decision is Decision.DENY:
                consultation = await self._consult(ctx, v)
                if consultation is None:
                    return _Outcome(
                        _with_unions(v, pool), i, _summaries(per, names), truncated(i), resolved_by
                    )
                rv, permitted = consultation
                if not permitted:
                    # Reject / unresolved / echo violation: a deny
                    # stands (§9); the consultation is still recorded
                    # (§10.3 resolved_by).
                    synthesized = _is_host_synthesized(rv)
                    return _Outcome(
                        _with_unions(rv, pool),
                        None if synthesized else i,
                        _summaries(per, names),
                        truncated(i),
                        "rejection",
                    )
                resolved_by = "approval"
                # §7.6: the permit resolution substitutes at this
                # position; its transform folds like an interceptor's
                # (§7.4).
                sub = self._fold_transform(ctx, rv) if rv.decision is Decision.TRANSFORM else rv
                if not sub.decision.permits:
                    return _Outcome(sub, None, _summaries(per, names), truncated(i), resolved_by)
                pool.append(sub)
                if on_approval is OnApproval.STOP:
                    # §7.4 stop: the resolution is the combined verdict;
                    # the emission ends. fold_truncated makes the skip
                    # legible.
                    return _Outcome(
                        _with_unions(sub, pool),
                        i,
                        _summaries(per, names),
                        truncated(i),
                        resolved_by,
                    )
                if sub.decision is Decision.TRANSFORM:
                    last_transform = (i, sub)
                # resume: fold continues at i+1
            elif v.decision is Decision.TRANSFORM:
                v = self._fold_transform(ctx, v)
                if not v.decision.permits:
                    # Transform failed closed (host-synthesized §5.2).
                    return _Outcome(v, None, _summaries(per, names), truncated(i), resolved_by)
                last_transform = (i, v)
            # allow: continue

        # No standing deny: combined is the last transform, else allow.
        if last_transform is not None:
            decided_by, combined = last_transform
        else:
            combined, decided_by = Verdict(decision=Decision.ALLOW), None
        return _Outcome(
            _with_unions(combined, pool), decided_by, _summaries(per, names), False, resolved_by
        )

    async def _dispatch_run_all(self, ctx: AgentContext) -> _Outcome:
        """``sequential/run_all`` (§7.4): everything runs, transforms
        fold through for visibility, severity-max aggregate; the seam is
        consulted at most once, only when the winner is liftable."""
        all_v: list[Verdict] = []
        for interceptor in self._interceptors:
            # §6.3 per-interceptor: a malformed verdict becomes that
            # interceptor's synthesized deny; the rest still run.
            v = await self._invoke(interceptor, ctx)
            if v.decision is Decision.TRANSFORM:
                folded = self._fold_transform(ctx, v)
                all_v.append(folded)
                if not folded.decision.permits:
                    # §7.4: a transform that fails to apply
                    # short-circuits in both sequential profiles.
                    return _Outcome(folded, None, _summaries(all_v, self._names))
            else:
                all_v.append(v)
        return await self._aggregate_and_consult(ctx, all_v)

    async def _dispatch_parallel(self, ctx: AgentContext) -> _Outcome:
        """Parallel profiles (§7.5): isolated deep-copied snapshots of
        the same untransformed context, no fold; serial dispatch
        (isolation semantics, not scheduling)."""
        snapshot = copy.deepcopy(ctx)
        all_v: list[Verdict] = []
        for interceptor in self._interceptors:
            # _invoke deep-copies again, so each interceptor receives
            # its own copy of the identical snapshot.
            all_v.append(await self._invoke(interceptor, snapshot))
        return await self._aggregate_and_consult(ctx, all_v)

    async def _aggregate_and_consult(self, ctx: AgentContext, all_v: list[Verdict]) -> _Outcome:
        """Severity-max aggregation (§7.3, core-side) + winner handling,
        shared by ``sequential/run_all`` and the parallel profiles.

        The core returns the combined verdict with §7.3 unions applied,
        plus ``consult`` (combined is a liftable deny the profile says
        to consult — environment checks stay here) and
        ``apply_transform`` (parallel-only single winning transform,
        not yet applied)."""
        agg = json.loads(
            _core.compose_aggregate(
                dumps(self._composition.to_wire()), dumps([v.to_wire() for v in all_v])
            )
        )
        combined = Verdict._from_core(agg["combined"])
        decided_by: int | None = agg["decided_by"]
        verdicts = tuple(
            dataclasses.replace(
                VerdictSummary.from_wire(s),
                name=self._names[i] if i < len(self._names) else None,
            )
            for i, s in enumerate(agg["verdicts"])
        )
        resolved_by: str | None = None

        if agg["apply_transform"]:
            # §7.5: apply the single winning transform now.
            folded = self._fold_transform(ctx, combined)
            if not folded.decision.permits:
                return _Outcome(folded, None, verdicts)
            combined = folded
        elif agg["consult"]:
            consultation = await self._consult(ctx, combined)
            if consultation is not None:
                rv, permitted = consultation
                if permitted:
                    resolved_by = "approval"
                    sub = (
                        self._fold_transform(ctx, rv)
                        if rv.decision is Decision.TRANSFORM
                        else rv
                    )
                    # §7.3 step 2: the substituting resolution carries
                    # the emission's unions — uniformly, including for a
                    # §7.5-synthesized trigger (whose `decided_by` is
                    # already None from the aggregation).
                    # (falls back bare when a substituted transform
                    # failed closed)
                    combined = (
                        _with_unions(sub, [*all_v, sub])
                        if sub.decision.permits
                        else sub
                    )
                else:
                    # §10.3: consultation without a permit substitution.
                    resolved_by = "rejection"
                    combined = _with_unions(rv, all_v)
                    if _is_host_synthesized(rv):
                        decided_by = None
        return _Outcome(combined, decided_by, verdicts, None, resolved_by)

    # -------------------------------------------------------------------------

    def _fold_transform(self, ctx: AgentContext, v: Verdict) -> Verdict:
        """Apply (enforce) or validate (evaluate_only) one transform (§7.4, §8)."""
        if v.transform is None:
            return Verdict.host_error(HostError.TRANSFORM_INVALID)
        try:
            if self._mode is EnforcementMode.ENFORCE:
                new_ctx = json.loads(
                    _core.apply_transform_ctx(
                        dumps(ctx), v.transform.path, dumps(v.transform.value)
                    )
                )
                ctx.clear()
                ctx.update(new_ctx)
            else:
                _core.validate_transform_ctx(
                    dumps(ctx), v.transform.path, dumps(v.transform.value)
                )
        except _core.AgentHooksCoreError as e:
            return Verdict.host_error(_host_error_of(e, HostError.TRANSFORM_INVALID), str(e))
        except ValueError as e:
            return Verdict.host_error(HostError.TRANSFORM_INVALID, str(e))
        return v

    async def _consult(
        self, ctx: AgentContext, verdict: Verdict
    ) -> tuple[Verdict, bool] | None:
        """Consult the approval seam for a liftable deny (§9), when the
        profile conditions allow it: ``enforce`` mode, not
        ``agent_shutdown``, a resolver registered, and the verdict
        actually liftable. Enforces the echo rule and the §9
        outcome/verdict consistency requirements.

        Returns ``None`` when the seam was not consulted (the liftable
        deny stands as-is — conformant, not an error), else
        ``(verdict, permitted)`` where the verdict substitutes for the
        triggering one (§7.6).
        """
        if not verdict.is_liftable or self._mode is not EnforcementMode.ENFORCE:
            return None
        # §6.1a: nothing to approve at agent_shutdown.
        if ctx.get("interception_point") == InterceptionPoint.AGENT_SHUTDOWN.value:
            return None
        # §9: no resolver → the deny stands. Conformant, not an error.
        if self._resolver is None:
            return None

        # §9/§14: the host's approval redactor minimizes the context
        # egressing through the seam; a raising redactor fails closed.
        presented = ctx
        if self._approval_redactor is not None:
            try:
                presented = self._approval_redactor(ctx)
            except Exception as e:  # noqa: BLE001
                return (
                    Verdict.host_error(
                        HostError.APPROVAL_RESOLVER_FAILED, type(e).__name__
                    ),
                    False,
                )

        # §9: identity of the context as presented to the resolver —
        # consultation time, after any transforms that folded earlier
        # and after any redaction.
        try:
            identity = self._compute_identity(presented)
        except _core.AgentHooksCoreError as e:
            return (
                Verdict.host_error(_host_error_of(e, HostError.CONTEXT_INVALID), str(e)),
                False,
            )
        except Exception as e:  # noqa: BLE001 — provider failure fails closed
            return Verdict.host_error(HostError.CONTEXT_INVALID, type(e).__name__), False

        try:
            ip = InterceptionPoint(ctx.get("interception_point"))
        except ValueError:
            ip = InterceptionPoint.AGENT_STARTUP
        try:
            raw = self._resolver.resolve(
                ApprovalRequest(
                    context_identity=identity,
                    interception_point=ip,
                    verdict=verdict,
                    context=presented,
                )
            )
            if inspect.isawaitable(raw):
                # §7 timeout applies to the resolver too; only the
                # awaitable path is preemptible.
                if self._timeout is not None:
                    res = await asyncio.wait_for(raw, self._timeout)
                else:
                    res = await raw
            else:
                res = raw
        except (TimeoutError, asyncio.TimeoutError):
            return Verdict.host_error(HostError.APPROVAL_RESOLVER_FAILED, "timeout"), False
        except Exception as e:  # noqa: BLE001
            return (
                Verdict.host_error(HostError.APPROVAL_RESOLVER_FAILED, type(e).__name__),
                False,
            )

        # §9 echo rule (byte-for-byte; None echoes as None).
        if res.context_identity != identity:
            return Verdict.host_error(HostError.APPROVAL_IDENTITY_MISMATCH), False
        if res.outcome is ApprovalOutcome.UNRESOLVED or res.verdict is None:
            return Verdict.host_error(HostError.APPROVAL_UNRESOLVED), False
        try:
            # §9: the resolver's verdict crosses the same §5 gate as an
            # interceptor's.
            rv = Verdict.from_wire(
                json.loads(_core.validate_verdict(dumps(res.verdict.to_wire())))
            )
        except Exception as e:  # noqa: BLE001
            return Verdict.host_error(HostError.VERDICT_INVALID, str(e)), False
        # §9: outcome/decision must agree — approve MUST carry a permit,
        # reject MUST carry a deny.
        if res.outcome is ApprovalOutcome.APPROVE:
            if not rv.decision.permits:
                return (
                    Verdict.host_error(
                        HostError.VERDICT_INVALID, "approve MUST carry a permit verdict (§9)"
                    ),
                    False,
                )
            return rv, True
        if rv.decision is not Decision.DENY:
            return (
                Verdict.host_error(
                    HostError.VERDICT_INVALID, "reject MUST carry a deny verdict (§9)"
                ),
                False,
            )
        return rv, False
