# Copyright (c) Microsoft. All rights reserved.

"""CTK-supplied interceptor/resolver that replay a vector's scripts.

Rule evaluation delegates to the Rust core (``_core.ctk_scripted_*``);
this module keeps only the recording wrapper (which must capture what
the *native* harness passed, so it stays per-language) and the
Approval type marshalling.
"""

from __future__ import annotations

import asyncio
import copy
import json
from collections.abc import Awaitable
from dataclasses import dataclass, field
from typing import Any

from agent_hooks import _core
from agent_hooks._marshal import dumps
from agent_hooks._types import ManagedInterceptorOutcome, Verdict
from agent_hooks.approval import ApprovalOutcome, ApprovalRequest, ApprovalResolution
from agent_hooks.context import AgentContext

#: ``fault: hang`` grace (seconds) for a path with no bound to honour:
#: the interceptor returns allow once the bound plus this grace has
#: passed, so an unbounded host fails the vector instead of hanging it
#: (conformance/HARNESS.md "Faults").
HANG_GRACE: float = 10.0

#: A §5-invalid shape: ``transform`` with no body.
_MALFORMED: dict[str, Any] = {"decision": "transform"}


def _mutate(context: AgentContext) -> dict[str, Any]:
    """§7 isolation fault (TM-05): tamper with the received context
    in-place; the emitter's copy isolation must keep enforcement,
    identity, and siblings unaffected."""
    context["target"] = "TAMPERED"
    if isinstance(context.get("tool_call"), dict):
        context["tool_call"]["args"] = {"tampered": True}
    return {"decision": "allow", "reason": "ctk:mutated"}


async def _hang_then_allow() -> dict[str, Any]:
    await asyncio.sleep(HANG_GRACE)
    return {"decision": "allow"}


@dataclass(slots=True)
class ScriptedInterceptor:
    """Replays a vector's ``interceptor_script`` via the Rust core."""

    rules: list[dict[str, Any]]
    _rules_json: str = field(init=False)

    def __post_init__(self) -> None:
        self._rules_json = dumps(self.rules)

    def evaluate(self, context: AgentContext) -> dict[str, Any]:
        """The matched rule's wire verdict, or ``{"__ctk_fault__": ...}``."""
        w: dict[str, Any] = json.loads(
            _core.ctk_scripted_intercept(self._rules_json, dumps(context))
        )
        return w

    def intercept(self, context: AgentContext) -> dict[str, Any] | Awaitable[dict[str, Any]]:
        w = self.evaluate(context)
        fault = w.get("__ctk_fault__")
        if fault is None:
            return w
        if fault == "mutate":
            return _mutate(context)
        if fault == "hang":
            # §6.3: does not return before the binding's bound. Under
            # kind ``ctk.scripted`` the emitter's own timer ends the
            # awaitable first and the vector observes
            # ``host_error:interceptor_timeout``. The allow after the
            # grace is what an unbounded host would see.
            return _hang_then_allow()
        if fault == "cancel":
            # Defined only for kind ``ctk.managed``. A standard
            # interceptor has no cancelled outcome; the nearest
            # fail-closed analogue, as in the Rust runner.
            return _MALFORMED
        # Fault injection: exercise §6.3 interceptor_failed.
        raise RuntimeError("ctk scripted fault: raise")


@dataclass(slots=True)
class ScriptedManagedInterceptor:
    """The same script through the managed-interceptor path (§6.3.1,
    §7): the ``ctk.managed`` kind of a declaration vector owns its own
    deadline, so ``hang`` waits out the bound it was handed, cleans up
    and reports the typed timeout, and ``cancel`` reports the typed
    cancelled outcome. The emitter does not wrap it in a second timer.
    ``raise`` raises natively and ``malformed_verdict`` returns the
    §5-invalid shape as its verdict, as under the standard kind.
    Records every context when ``recorded`` is a list (script 0 of a
    vector)."""

    inner: ScriptedInterceptor
    recorded: list[AgentContext] | None = None

    async def intercept_managed(
        self, context: AgentContext, bound: float | None
    ) -> ManagedInterceptorOutcome:
        if self.recorded is not None:
            self.recorded.append(copy.deepcopy(context))
        w = self.inner.evaluate(context)
        fault = w.get("__ctk_fault__")
        if fault is None:
            return ManagedInterceptorOutcome.of_verdict(w)
        if fault == "mutate":
            return ManagedInterceptorOutcome.of_verdict(_mutate(context))
        if fault == "hang":
            # The work (a sleep standing in for a process or a request)
            # is cancelled at the deadline: cleaned up before the typed
            # outcome is reported.
            if bound is None:
                await asyncio.sleep(HANG_GRACE)
                return ManagedInterceptorOutcome.of_verdict({"decision": "allow"})
            try:
                await asyncio.wait_for(asyncio.sleep(HANG_GRACE), bound)
            except (TimeoutError, asyncio.TimeoutError):
                return ManagedInterceptorOutcome.timeout()
            return ManagedInterceptorOutcome.of_verdict({"decision": "allow"})
        if fault == "cancel":
            return ManagedInterceptorOutcome.cancelled()
        raise RuntimeError("ctk scripted fault: raise")


@dataclass(slots=True)
class RecordingInterceptor:
    """Wraps another interceptor and records every context passed through.

    Recording stays per-language: it captures the exact object the host
    handed the interceptor, before any transform write-back mutates it.
    """

    inner: ScriptedInterceptor
    recorded: list[AgentContext] = field(default_factory=list)

    def intercept(self, context: AgentContext) -> dict[str, Any] | Awaitable[dict[str, Any]]:
        self.recorded.append(copy.deepcopy(context))
        return self.inner.intercept(context)


def redact_paths(ctx: AgentContext, paths: list[str]) -> AgentContext:
    """§9 redaction seam, CTK convention: each listed path is replaced
    with ``"[redacted]"`` via the §5.2/§4.3 transform machinery; a path
    that does not resolve at the escalating point is left untouched."""
    out = dumps(ctx)
    for path in paths:
        try:
            out = _core.apply_transform_ctx(out, path, '"[redacted]"')
        except Exception:  # noqa: BLE001 - an unresolvable path is skipped
            continue
    redacted: AgentContext = json.loads(out)
    return redacted


@dataclass(slots=True)
class ScriptedResolver:
    """Replays a vector's ``approval_script`` via the Rust core."""

    rules: list[dict[str, Any]]
    _rules_json: str = field(init=False)

    def __post_init__(self) -> None:
        self._rules_json = dumps(self.rules)

    def resolve(self, request: ApprovalRequest) -> ApprovalResolution:
        # §10.1: identity may be None (null provider). The scripted
        # engine works in strings; "" round-trips to None below.
        request_identity = request.context_identity or ""
        r = json.loads(
            _core.ctk_scripted_resolve(self._rules_json, dumps(request.context), request_identity)
        )
        if "__ctk_fault__" in r:
            # Fault injection: exercise §9 approval_resolver_failed.
            raise RuntimeError("ctk scripted fault: raise")
        echoed = r.get("context_identity") or ""
        return ApprovalResolution(
            outcome=ApprovalOutcome(r["outcome"]),
            context_identity=(
                None if echoed == "" and request.context_identity is None else echoed
            ),
            verdict=Verdict.from_wire(r["verdict"]) if "verdict" in r else None,
        )
