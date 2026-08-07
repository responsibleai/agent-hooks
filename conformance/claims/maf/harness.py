# Copyright (c) 2026 MohammadHaroonAbuomar. MIT License.
"""AGENT-HOOKS-0.1 CTK harness for Microsoft Agent Framework (Python).

Drives a real :class:`agent_framework.Agent` — with only the chat client and the
tools mocked per the CTK scenario — through the production enforcement path:
the middleware bundle returned by
:func:`agent_framework.create_agent_hooks_middleware` (or, where the vector
requires host-owned emitter configuration the factory does not expose,
:func:`agent_framework.create_agent_hooks_middleware_from_emitter`).

The harness never re-implements dispatch: every ``input`` / ``pre_model_call``
/ ``post_model_call`` / ``pre_tool_call`` / ``post_tool_call`` / ``output``
emission, every verdict write-back, and every block is performed by the
framework's own middleware over its own agent loop. The only harness-emitted
points are ``agent_startup`` / ``agent_shutdown`` on the two vector shapes
that force the host-owned-session factory (zero registered interceptors,
which ``create_agent_hooks_middleware`` rejects at construction, and
``redact_for_approval``, a host-owned emitter configuration) — exactly the
host role that factory is documented for.

Run with::

    pytest test_conformance.py \
        --agent-hooks-harness=harness:AgentFrameworkHarness \
        --agent-hooks-vectors=/path/to/conformance/vectors
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Awaitable, MutableSequence
from typing import Any, ClassVar

from agent_framework import (
    Agent,
    AgentContext,
    AgentMiddleware,
    AgentResponse,
    BaseChatClient,
    ChatMiddlewareLayer,
    ChatResponse,
    Content,
    FunctionInvocationLayer,
    FunctionTool,
    Message,
    create_agent_hooks_middleware,
    create_agent_hooks_middleware_from_emitter,
)
from agent_framework._tools import SKIP_PARSING

# The output projection used for RunRecord.final_output mirrors the feature's
# own ``output``-point codec so the reported final output is byte-identical to
# what the middleware emitted (and to what a transform wrote back).
from agent_framework._agent_hooks import _OutputCodec  # noqa: PLC2701
from agent_hooks import (
    AgentContextBuilder,
    ApprovalResolver,
    EnforcementMode,
    InterceptionBlocked,
    InterceptionEmitter,
    InterceptionRecord,
    Interceptor,
)
from agent_hooks import _core as _agent_hooks_core
from agent_hooks.composition import CompositionConfig
from agent_hooks.ctk.harness import Capability, RunOutcome, RunRecord, Scenario, ToolSpec
from agent_hooks.emitter import IdentityProvider

_FRAMEWORK = "agent-framework"


class _ScriptedChatClient(
    FunctionInvocationLayer,  # type: ignore[type-arg]
    ChatMiddlewareLayer,  # type: ignore[type-arg]
    BaseChatClient,  # type: ignore[type-arg]
):
    """Mock model: the Nth model call returns ``model_script[N]``, deterministically."""

    def __init__(self, script: list[Any]) -> None:
        super().__init__(middleware=[])
        self._script = list(script)
        self._calls = 0

    def _inner_get_response(
        self,
        *,
        messages: MutableSequence[Message],
        stream: bool,
        options: dict[str, Any],
        **kwargs: Any,
    ) -> Awaitable[ChatResponse] | Any:
        if stream:  # pragma: no cover - CTK vectors drive non-streaming runs
            raise AssertionError("CTK scenarios drive non-streaming runs only")

        async def _get() -> ChatResponse:
            if self._calls >= len(self._script):
                raise AssertionError(
                    f"model called {self._calls + 1} times but the script has {len(self._script)} responses"
                )
            scripted = self._script[self._calls]
            self._calls += 1
            contents: list[Content] = []
            if isinstance(scripted.content, str):
                contents.append(Content.from_text(scripted.content))
            elif scripted.content is not None:  # pragma: no cover - vectors use str|null
                raise AssertionError(f"unsupported scripted content: {scripted.content!r}")
            for tc in scripted.tool_calls:
                contents.append(
                    Content.from_function_call(
                        call_id=str(tc["id"]), name=str(tc["name"]), arguments=dict(tc["args"])
                    )
                )
            return ChatResponse(
                messages=[Message(role="assistant", contents=contents)],
                finish_reason=scripted.finish_reason,
            )

        return _get()


def _mock_tool(spec: ToolSpec, log: list[dict[str, Any]]) -> FunctionTool:
    """A framework tool whose behavior is the vector's scripted lookup table.

    ``result_parser=SKIP_PARSING`` keeps the scripted return value native
    (dict/str/number) so the tool seam brackets the value itself, and every
    invocation is recorded — the CTK's proof that transforms were honoured.
    """

    def _fn(**kwargs: Any) -> Any:
        value, is_error = spec.invoke(kwargs)
        log.append({"name": spec.name, "args": dict(kwargs)})
        if is_error:  # pragma: no cover - no current vector scripts is_error
            raise RuntimeError(str(value))
        return value

    schema = {
        "type": "object",
        "properties": {key: {"type": type_name} for key, type_name in (spec.schema or {}).items()},
        "additionalProperties": True,
    }
    return FunctionTool(
        name=spec.name,
        description=f"CTK mock tool {spec.name}",
        func=_fn,
        input_model=schema,
        approval_mode="never_require",
        result_parser=SKIP_PARSING,
    )


class _FinalOutputPresenter(AgentMiddleware):
    """Host presentation policy: the caller receives the final assistant message.

    Agent Framework's run result carries the run's full new-message transcript
    (assistant tool-call messages, tool results, final answer). This host —
    like the CTK reference host — presents only the final assistant message to
    its caller. Installed *after* (inside) the enforcement bundle, so the
    ``output`` interception point guards exactly the content that egresses:
    the trimming happens before the verdict, never after it.
    """

    async def process(self, context: AgentContext, call_next: Any) -> None:
        await call_next()
        result = context.result
        if isinstance(result, AgentResponse) and len(result.messages) > 1:
            result.messages = result.messages[-1:]


def _provider_of(declared: str | None) -> str | IdentityProvider | None:
    """Map the vector's identity_provider onto an emitter provider (§13.2).

    ``"ctk-fault"`` is the scripted always-failing custom provider that pins
    the §10.1 provider-failure rule.
    """
    if declared == "ctk-fault":

        def _boom(_ctx: object) -> str:
            raise RuntimeError("ctk scripted provider fault")

        return IdentityProvider("ctk-fault", _boom)
    return declared


class AgentFrameworkHarness:
    """CTK ``Harness`` over Microsoft Agent Framework's agent-hooks middleware."""

    name = _FRAMEWORK
    # Python ints are arbitrary precision: >2^53 and beyond-u64 integer tokens
    # from vector JSON survive the framework's projection layer losslessly.
    capabilities: ClassVar[set[Capability]] = {
        Capability.MODEL_CALLS,
        Capability.TOOL_CALLS,
        Capability.INT64_JSON,
        Capability.BIGINT_JSON,
    }

    def __init__(self) -> None:
        self._scenario: Scenario | None = None
        self._agent: Agent | None = None
        self._session: tuple[InterceptionEmitter, AgentContextBuilder] | None = None
        self._tools: list[FunctionTool] = []
        self._tool_log: list[dict[str, Any]] = []
        self._records: list[InterceptionRecord] = []

    # ---- Harness protocol ---------------------------------------------------

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
        self._scenario = scenario
        self._tool_log = []
        self._records = []
        provider = _provider_of(identity_provider)
        tools = [_mock_tool(spec, self._tool_log) for spec in scenario.tools.values()]

        if not interceptors or redact_for_approval:
            # Host-owned-session factory: create_agent_hooks_middleware rejects an
            # empty interceptor list at construction (an emitter with zero
            # interceptors fails closed on every emission — exactly what the
            # zero-interceptor vectors pin), and the §9 approval-redaction seam is
            # emitter-level configuration. The harness plays the documented host
            # role: it owns the emitter and the agent_startup/agent_shutdown
            # session brackets; all per-run points still ride the middleware.
            emitter = InterceptionEmitter(
                mode=mode,
                resolver=resolver,
                composition=composition,
                identity_provider=provider,
            )
            if redact_for_approval:
                paths = list(redact_for_approval)

                def _redact(ctx: dict[str, Any]) -> dict[str, Any]:
                    out = json.dumps(ctx)
                    for path in paths:
                        try:
                            out = _agent_hooks_core.apply_transform_ctx(out, path, '"[redacted]"')
                        except Exception:  # noqa: BLE001 - unresolvable paths stay untouched
                            continue
                    return json.loads(out)

                emitter.set_approval_redactor(_redact)
            for interceptor in interceptors:
                emitter.register(interceptor)
            emitter.set_record_sink(self._records.append)
            builder = AgentContextBuilder(
                agent_id="ctk-agent",
                framework=_FRAMEWORK,
                session_id=uuid.uuid4().hex,
            )
            bundle = create_agent_hooks_middleware_from_emitter(emitter, builder)
            self._session = (emitter, builder)
        else:
            # Production default: one agent-hooks session per run, fully owned by
            # the framework middleware (agent_startup/agent_shutdown included).
            bundle = create_agent_hooks_middleware(
                list(interceptors),
                resolver=resolver,
                mode=mode,
                composition=composition,
                identity_provider=provider,
                record_sink=self._records.append,
            )
            self._session = None

        # Tools are supplied per-run (Agent.run(tools=...)): they surface on the
        # run's AgentContext, which is what the middleware's agent_startup
        # projection reads for ``tools_registered`` (see report finding on
        # constructor-registered tools).
        self._tools = tools
        self._agent = Agent(
            client=_ScriptedChatClient(scenario.model_script),
            id="ctk-agent",
            name="ctk-agent",
            middleware=[bundle, _FinalOutputPresenter()],
        )

    async def run(self) -> RunRecord:
        assert self._scenario is not None and self._agent is not None
        scenario = self._scenario
        outcome = RunOutcome.COMPLETED
        final: Any | None = None
        message = Message(role=scenario.input["role"], contents=[scenario.input["content"]])

        async def _run_agent() -> None:
            nonlocal final
            response = await self._agent.run([message], tools=self._tools or None)
            if isinstance(response, AgentResponse):
                final = _OutputCodec.to_wire(response)

        try:
            if self._session is not None:
                emitter, builder = self._session
                try:
                    await emitter.emit(
                        builder.agent_startup(tools_registered=sorted(scenario.tools))
                    )
                    await _run_agent()
                except InterceptionBlocked:
                    outcome = RunOutcome.BLOCKED
                    final = None
                await emitter.emit_unchecked(
                    builder.agent_shutdown(
                        reason="completed" if outcome is RunOutcome.COMPLETED else "error"
                    )
                )
            else:
                await _run_agent()
        except InterceptionBlocked:
            outcome = RunOutcome.BLOCKED
            final = None

        return RunRecord(
            outcome=outcome,
            final_output=final,
            tool_invocations=list(self._tool_log),
            identities=[(r.input_identity, r.enforced_identity) for r in self._records],
            records=[r.to_wire() for r in self._records],
        )

    def teardown(self) -> None:
        self._scenario = None
        self._agent = None
        self._session = None
