# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Reference in-memory agent + harness.

This is the simplest possible conformant agent loop: it exists so the
CTK can self-test without depending on any real framework.
"""
from __future__ import annotations

import uuid
from typing import Any, ClassVar

from agent_hooks._types import EnforcementMode
from agent_hooks.approval import ApprovalResolver
from agent_hooks.composition import CompositionConfig
from agent_hooks.context import AgentContextBuilder
from agent_hooks.ctk.harness import Capability, RunOutcome, RunRecord, Scenario
from agent_hooks.emitter import IdentityProvider, InterceptionEmitter
from agent_hooks.exceptions import InterceptionBlocked
from agent_hooks.interceptor import Interceptor


class ReferenceHarness:
    """A ~100-line conformant host. Self-test target for the CTK."""

    name = "reference-agent"
    capabilities: ClassVar[frozenset[Capability]] = frozenset(
        {
            Capability.MODEL_CALLS,
            Capability.TOOL_CALLS,
            Capability.INT64_JSON,
            # Python ints are arbitrary precision: beyond-u64 literals
            # survive vector loading and emission byte-faithfully.
            Capability.BIGINT_JSON,
        }
    )

    def __init__(self) -> None:
        self._scenario: Scenario | None = None
        self._emitter: InterceptionEmitter | None = None
        self._builder: AgentContextBuilder | None = None
        self._tool_log: list[dict[str, Any]] = []

    # ---- Harness protocol ---------------------------------------------------

    def setup(
        self,
        scenario: Scenario,
        interceptors: list[Interceptor],
        resolver: ApprovalResolver | None,
        mode: EnforcementMode,
        composition: CompositionConfig | None = None,
        identity_provider: str | None = "jcs-sha256",
    ) -> None:
        self._scenario = scenario
        self._tool_log = []
        em = InterceptionEmitter(
            mode=mode,
            resolver=resolver,
            composition=composition,
            identity_provider=_provider_of(identity_provider),
        )
        for i in interceptors:
            em.register(i)
        self._emitter = em
        self._builder = AgentContextBuilder(
            agent_id="ref-agent",
            framework="reference-agent",
            session_id=str(uuid.uuid4()),
        )

    async def run(self) -> RunRecord:
        assert self._scenario and self._emitter and self._builder
        s, em, b = self._scenario, self._emitter, self._builder
        outcome = RunOutcome.COMPLETED
        final: Any | None = None
        try:
            await em.emit(b.agent_startup(tools_registered=sorted(s.tools)))
            await em.emit(
                b.input(content=s.input["content"], role=s.input["role"])
            )
            messages: list[dict[str, Any]] = [
                {"role": s.input["role"], "content": s.input["content"]}
            ]
            for resp in s.model_script:
                ctx = b.pre_model_call(model_id="mock", messages=list(messages))
                await em.emit(ctx)
                messages = ctx["messages"]  # may be transformed
                await em.emit(
                    b.post_model_call(
                        model_id="mock",
                        content=resp.content,
                        tool_calls=resp.tool_calls,
                        finish_reason=resp.finish_reason,
                    )
                )
                if resp.tool_calls:
                    for tc in resp.tool_calls:
                        try:
                            await self._do_tool_call(tc, messages)
                        except InterceptionBlocked as e:
                            messages.append(
                                {
                                    "role": "tool",
                                    "content": f"blocked: {e.result.verdict.reason}",
                                }
                            )
                else:
                    final = resp.content
                    break
                messages.append({"role": "assistant", "content": resp.content or ""})
            if final is not None:
                ctx = b.output(content=final)
                await em.emit(ctx)
                final = ctx["output"]["content"]
        except InterceptionBlocked:
            outcome = RunOutcome.BLOCKED
            final = None
        await em.emit_unchecked(
            b.agent_shutdown(
                reason="completed" if outcome is RunOutcome.COMPLETED else "error"
            )
        )
        return RunRecord(
            outcome=outcome,
            final_output=final,
            tool_invocations=list(self._tool_log),
            identities=[
                (r.input_identity, r.enforced_identity) for r in em.results
            ],
            records=[r.to_wire() for r in em.results],
        )

    def teardown(self) -> None:
        self._scenario = self._emitter = self._builder = None

    # ---- internals ----------------------------------------------------------

    async def _do_tool_call(
        self, tc: dict[str, Any], messages: list[dict[str, Any]]
    ) -> None:
        assert self._scenario and self._emitter and self._builder
        s, em, b = self._scenario, self._emitter, self._builder
        ctx = b.pre_tool_call(call_id=tc["id"], name=tc["name"], args=dict(tc["args"]))
        await em.emit(ctx)
        args = ctx["tool_call"]["args"]  # post-transform
        spec = s.tools[tc["name"]]
        value, is_error = spec.invoke(args)
        self._tool_log.append({"name": tc["name"], "args": dict(args)})
        await em.emit(
            b.post_tool_call(
                call_id=tc["id"], name=tc["name"], args=dict(args), value=value, is_error=is_error
            )
        )
        messages.append({"role": "tool", "content": value})


def _provider_of(declared: str | None):
    """Map the vector's identity_provider to an emitter provider
    (§13.2): "ctk-fault" is a custom provider that raises, pinning the
    §10.1 provider-failure rule."""
    if declared == "ctk-fault":
        def _boom(_ctx: object) -> str:
            raise RuntimeError("ctk scripted provider fault")

        return IdentityProvider("ctk-fault", _boom)
    return declared
