# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""CTK-supplied interceptor/resolver that replay a vector's scripts.

Rule evaluation delegates to the Rust core (``_core.ctk_scripted_*``);
this module keeps only the recording wrapper (which must capture what
the *native* harness passed, so it stays per-language) and the
Approval type marshalling.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from typing import Any

from agent_hooks import _core
from agent_hooks._marshal import dumps
from agent_hooks._types import Verdict
from agent_hooks.approval import ApprovalOutcome, ApprovalRequest, ApprovalResolution
from agent_hooks.context import AgentContext


@dataclass(slots=True)
class ScriptedInterceptor:
    """Replays a vector's ``interceptor_script`` via the Rust core."""

    rules: list[dict[str, Any]]
    _rules_json: str = field(init=False)

    def __post_init__(self) -> None:
        self._rules_json = dumps(self.rules)

    def intercept(self, context: AgentContext) -> dict[str, Any]:
        w = json.loads(_core.ctk_scripted_intercept(self._rules_json, dumps(context)))
        if "__ctk_fault__" in w:
            if w["__ctk_fault__"] == "mutate":
                # §7 isolation fault (TM-05): tamper with the received
                # context in-place; the emitter's copy isolation must
                # keep enforcement, identity, and siblings unaffected.
                context["target"] = "TAMPERED"
                if isinstance(context.get("tool_call"), dict):
                    context["tool_call"]["args"] = {"tampered": True}
                return {"decision": "allow", "reason": "ctk:mutated"}
            # NOW-10 fault injection: exercise §6.3 interceptor_failed.
            raise RuntimeError("ctk scripted fault: raise")
        return w


@dataclass(slots=True)
class RecordingInterceptor:
    """Wraps another interceptor and records every context passed through.

    Recording stays per-language: it captures the exact object the host
    handed the interceptor, before any transform write-back mutates it.
    """

    inner: ScriptedInterceptor
    recorded: list[AgentContext] = field(default_factory=list)

    def intercept(self, context: AgentContext) -> dict[str, Any]:
        self.recorded.append(copy.deepcopy(context))
        return self.inner.intercept(context)


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
            # NOW-10 fault injection: exercise §9 approval_resolver_failed.
            raise RuntimeError("ctk scripted fault: raise")
        echoed = r.get("context_identity") or ""
        return ApprovalResolution(
            outcome=ApprovalOutcome(r["outcome"]),
            context_identity=(
                None if echoed == "" and request.context_identity is None else echoed
            ),
            verdict=Verdict.from_wire(r["verdict"]) if "verdict" in r else None,
        )
