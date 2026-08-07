# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""CTK harness contract a framework adapter implements once (§13.2)."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from agent_hooks._types import EnforcementMode
from agent_hooks.approval import ApprovalResolver
from agent_hooks.composition import CompositionConfig
from agent_hooks.interceptor import Interceptor


class Capability(str, Enum):
    """Host-declared capability subset (§3.2)."""

    MODEL_CALLS = "model_calls"
    TOOL_CALLS = "tool_calls"
    PARALLEL_TOOL_CALLS = "parallel_tool_calls"
    STREAMING = "streaming"
    MULTI_TURN = "multi_turn"
    #: The harness language can hold >2^53 integers from vector JSON
    #: losslessly (§4.4). JavaScript harnesses omit this.
    INT64_JSON = "int64_json"
    BIGINT_JSON = "bigint_json"
    #: The host declares buffered_output: false and mediates
    #: post_model_call incrementally under the §12.1 exception with
    #: watermark-gated release; gates the streaming/incremental vector
    #: part. Buffered hosts (the default) omit this and skip it.
    INCREMENTAL_OUTPUT = "incremental_output"


class RunOutcome(str, Enum):
    COMPLETED = "completed"
    BLOCKED = "blocked"
    SUSPENDED = "suspended"
    ERROR = "error"


@dataclass(slots=True)
class ToolBehavior:
    when_args: dict[str, Any] | None
    return_: Any
    is_error: bool = False


@dataclass(slots=True)
class ToolSpec:
    name: str
    behavior: list[ToolBehavior]
    schema: dict[str, Any] = field(default_factory=dict)

    def invoke(self, args: dict[str, Any]) -> tuple[Any, bool]:
        """Mock-tool dispatch: first matching behavior wins."""
        for b in self.behavior:
            if b.when_args is None or b.when_args == args:
                return b.return_, b.is_error
        raise AssertionError(
            f"tool {self.name!r} invoked with {args!r}: no matching behavior clause"
        )


@dataclass(slots=True)
class ModelResponse:
    content: Any
    tool_calls: list[dict[str, Any]]
    finish_reason: str


@dataclass(slots=True)
class Scenario:
    """Hermetic scripted run loaded from a CTK vector."""

    input: dict[str, Any]
    tools: dict[str, ToolSpec] = field(default_factory=dict)
    model_script: list[ModelResponse] = field(default_factory=list)

    @classmethod
    def from_wire(cls, obj: dict[str, Any]) -> Scenario:
        tools = {
            t["name"]: ToolSpec(
                name=t["name"],
                schema=t.get("schema", {}),
                behavior=[
                    ToolBehavior(
                        when_args=b.get("when_args"),
                        return_=b["return"],
                        is_error=b.get("is_error", False),
                    )
                    for b in t["behavior"]
                ],
            )
            for t in obj.get("tools", [])
        }
        model_script = [
            ModelResponse(
                content=m["respond"]["content"],
                tool_calls=list(m["respond"]["tool_calls"]),
                finish_reason=m["respond"]["finish_reason"],
            )
            for m in obj.get("model_script", [])
        ]
        return cls(input=obj["input"], tools=tools, model_script=model_script)


@dataclass(slots=True)
class RunRecord:
    """What :meth:`Harness.run` returns to the CTK runner."""

    outcome: RunOutcome
    final_output: Any | None
    tool_invocations: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    #: ``(input_identity, enforced_identity)`` per interception, in order,
    #: from the harness's emitter (``None`` when the identity provider is
    #: ``null``, §10.1). Enables ``expect.identities_equal``.
    identities: list[tuple[str | None, str | None]] = field(default_factory=list)
    #: Wire-shaped ``InterceptionRecord`` dicts (§10.3), one per emission,
    #: in order. Enables ``expect.records`` assertions.
    records: list[dict[str, Any]] = field(default_factory=list)


class Harness(Protocol):
    """The single interface a framework adapter implements for the CTK."""

    name: str
    capabilities: set[Capability]

    def setup(
        self,
        scenario: Scenario,
        interceptors: list[Interceptor],
        resolver: ApprovalResolver | None,
        mode: EnforcementMode,
        composition: CompositionConfig,
        identity_provider: str | None,
        redact_for_approval: list[str] | None = None,
    ) -> None: ...

    async def run(self) -> RunRecord: ...

    def teardown(self) -> None: ...
