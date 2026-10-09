# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Reference in-memory agent + harness.

This is the simplest possible conformant agent loop: it exists so the
CTK can self-test without depending on any real framework.

Every emitter it builds goes through the host declaration loader
(§7.7): for a field-based vector it writes the vector's mode,
composition and provider into a copy of its own document
(``reference.declaration.json``) and binds the scripted interceptors
through a ``ctk.instance`` kind, so the field-based vectors exercise
the loader too.
"""

from __future__ import annotations

import copy
import json
import uuid
from importlib.resources import files
from typing import Any, ClassVar

from agent_hooks._types import EnforcementMode
from agent_hooks.approval import ApprovalResolver
from agent_hooks.composition import CompositionConfig
from agent_hooks.context import AgentContext, AgentContextBuilder
from agent_hooks.ctk.harness import Capability, RunOutcome, RunRecord, Scenario
from agent_hooks.ctk.scripted import redact_paths
from agent_hooks.declaration import BindingContext, HostRegistry, HostSurface
from agent_hooks.emitter import InterceptionEmitter
from agent_hooks.exceptions import InterceptionBlocked
from agent_hooks.interceptor import Interceptor

#: The reference harness's own declaration (§7.7.9), with an explicit
#: surface a claim can cite.
REFERENCE_DECLARATION: dict[str, Any] = json.loads(
    files("agent_hooks.ctk").joinpath("reference.declaration.json").read_text(encoding="utf-8")
)


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
            # Every emitter is built through the loader.
            Capability.HOST_DECLARATION,
        }
    )
    tool_seam_host_error = "continue"

    def __init__(self) -> None:
        self._scenario: Scenario | None = None
        self._emitter: InterceptionEmitter | None = None
        self._builder: AgentContextBuilder | None = None
        self._tool_log: list[dict[str, Any]] = []

    # ---- Harness protocol ---------------------------------------------------

    def host_surface(self) -> HostSurface:
        return HostSurface.from_capabilities(
            sorted(c.value for c in self.capabilities), self.tool_seam_host_error
        )

    def declaration(self) -> dict[str, Any]:
        return copy.deepcopy(REFERENCE_DECLARATION)

    def setup(
        self,
        scenario: Scenario,
        interceptors: list[Interceptor],
        resolver: ApprovalResolver | None,
        mode: EnforcementMode,
        composition: CompositionConfig | None = None,
        identity_provider: str | None = "jcs-sha256",
        redact_for_approval: list[str] | None = None,
    ) -> None:
        # Field-based vector: write the vector's configuration into a
        # copy of the reference document and bind the interceptors by
        # index through the ``ctk.instance`` kind.
        doc = self.declaration()
        cfg = doc["configuration"]
        cfg["mode"] = mode.value
        cfg["composition"] = (composition or CompositionConfig.default()).to_wire()
        registry = HostRegistry.for_conformance(self.host_surface())
        if identity_provider == "ctk-fault":
            # §13.2: a custom provider that raises, pinning the §10.1
            # provider-failure rule.
            def _boom(_ctx: AgentContext) -> str:
                raise RuntimeError("ctk scripted provider fault")

            registry.identity_provider("ctk-fault", _boom)
        cfg["identity_provider"] = identity_provider
        if resolver is not None:
            registry.approval_resolver("ctk-scripted", resolver)
        paths = list(redact_for_approval or [])
        if paths:
            registry.approval_redactor("ctk-redact", lambda ctx: redact_paths(ctx, paths))
        cfg["approval"] = {
            "resolver": "ctk-scripted" if resolver is not None else None,
            "redactor": "ctk-redact" if paths else None,
        }
        slots: list[Interceptor | None] = list(interceptors)

        def instance(config: Any, ctx: BindingContext) -> Interceptor:
            i = config.get("index") if isinstance(config, dict) else None
            if not isinstance(i, int) or isinstance(i, bool) or i < 0:
                raise ValueError("config.index must be an unsigned integer")
            if i >= len(slots) or slots[i] is None:
                raise ValueError(f"no interceptor instance {i} for binding {ctx.id}")
            out = slots[i]
            slots[i] = None
            assert out is not None
            return out

        registry.kind("ctk.instance", instance)
        doc["bindings"] = [
            {"id": f"interceptor-{i}", "kind": "ctk.instance", "config": {"index": i}}
            for i in range(len(slots))
        ]
        self._start(scenario, InterceptionEmitter.from_declaration_value(doc, registry))

    def setup_declared(
        self, scenario: Scenario, document: dict[str, Any], registry: HostRegistry
    ) -> None:
        # A refusal propagates: the runner records it as the load
        # outcome and never calls run (§7.7.9).
        self._start(scenario, InterceptionEmitter.from_declaration_value(document, registry))

    def _start(self, scenario: Scenario, emitter: InterceptionEmitter) -> None:
        self._scenario = scenario
        self._tool_log = []
        self._emitter = emitter
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
            await em.emit(b.input(content=s.input["content"], role=s.input["role"]))
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
            b.agent_shutdown(reason="completed" if outcome is RunOutcome.COMPLETED else "error")
        )
        return RunRecord(
            outcome=outcome,
            final_output=final,
            tool_invocations=list(self._tool_log),
            identities=[(r.input_identity, r.enforced_identity) for r in em.results],
            records=[r.to_wire() for r in em.results],
        )

    def teardown(self) -> None:
        self._scenario = self._emitter = self._builder = None

    # ---- internals ----------------------------------------------------------

    async def _do_tool_call(self, tc: dict[str, Any], messages: list[dict[str, Any]]) -> None:
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
