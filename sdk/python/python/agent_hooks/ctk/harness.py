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
from agent_hooks.declaration import (
    DeclarationError,
    DeclarationErrorClass,
    Finding,
    HostRegistry,
    HostSurface,
)
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
    #: The host builds its emitter from a host declaration document
    #: through the loader (§7.7.9) and implements
    #: :meth:`Harness.setup_declared`; gates the declaration/* parts.
    HOST_DECLARATION = "host_declaration"


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
class LoadRecord:
    """What loading a vector's host declaration produced (§7.7.9), as
    the runner records it: ``outcome`` is ``"accepted"`` or
    ``"refused"``, ``error_class`` the ``declaration_error:*`` code on
    refusal, and ``paths_equivalent`` whether the value, JSON, file and
    builder paths resolved to one canonical form (or refused with one
    class)."""

    outcome: str
    error_class: str | None = None
    paths_equivalent: bool | None = None
    detail: str | None = None

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"outcome": self.outcome}
        if self.error_class is not None:
            out["class"] = self.error_class
        if self.paths_equivalent is not None:
            out["paths_equivalent"] = self.paths_equivalent
        if self.detail is not None:
            out["detail"] = self.detail
        return out


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
    #: Set by the runner for vectors carrying ``host_declaration``
    #: (§7.7.9); the harness leaves it ``None``.
    load: LoadRecord | None = None


class Harness(Protocol):
    """The single interface a framework adapter implements for the CTK."""

    name: str
    capabilities: set[Capability]
    #: Declared §6.2 posture at the tool seam (§13.1): what the host does
    #: with the run after a ``host_error:*`` deny at
    #: ``pre_tool_call``/``post_tool_call``. ``"continue"`` (the default —
    #: surface a tool error to the model and keep the loop going) or
    #: ``"terminate"`` (the host's own semantics terminate the turn, which
    #: §6.2 explicitly permits). The runner forwards this declaration so
    #: ``expect.run_outcome_by_posture`` vectors resolve to the single
    #: outcome this surface must produce.
    tool_seam_host_error: str = "continue"

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

    # ---- host declaration seam (§7.7.9) -------------------------------------
    # The runner reads these with ``getattr`` and falls back to the
    # defaults below, so a structural Harness that predates them keeps
    # working: it skips the declaration/* parts with a stated reason.

    def host_surface(self) -> HostSurface:
        """The code surface (§7.7.4) a declaration is resolved against.
        The default derives it from :attr:`capabilities` and
        :attr:`tool_seam_host_error`: the §3.2 floor plus the model
        points iff ``model_calls`` plus the tool points iff
        ``tool_calls``, every profile with every knob value. A host
        declaring ``incremental_output`` overrides this to add its
        exposure bound (:meth:`HostSurface.with_exposure_bound`)."""
        return HostSurface.from_capabilities(
            sorted(c.value for c in self.capabilities),
            getattr(self, "tool_seam_host_error", "continue"),
        )

    def declaration(self) -> dict[str, Any] | None:
        """The host's own declaration document (§7.7.9), when it has
        one. The runner resolves it against :meth:`host_surface` and
        reads the capabilities and posture a run is assessed against
        from the resolved form, so what the CTK ran against is what a
        claim cites. ``None`` keeps the code-declared surface."""
        return None

    def setup_declared(
        self, scenario: Scenario, document: dict[str, Any], registry: HostRegistry
    ) -> None:
        """Wire one declaration vector (§7.7.9): the harness MUST build
        its emitter from ``document`` and ``registry`` through the
        loader (``InterceptionEmitter.from_declaration_value``) and let
        the :class:`DeclarationError` propagate, never fall back to the
        field-based :meth:`setup`. The document and the registry carry
        the interceptors, resolver, composition and provider. Only
        harnesses declaring :attr:`Capability.HOST_DECLARATION` receive
        this call."""
        raise DeclarationError(
            DeclarationErrorClass.SURFACE_UNSUPPORTED,
            Finding(
                pointer="",
                detail=f"harness defect: harness {self.name!r} declares host_declaration "
                "but does not implement setup_declared",
            ),
        )
