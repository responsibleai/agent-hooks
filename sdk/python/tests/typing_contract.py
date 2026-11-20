# Copyright (c) Microsoft. All rights reserved.

"""Static contract checks; run mypy with warn_unused_ignores enabled."""

from agent_hooks_contract import (
    AgentContext,
    AgentStartupHookResponse,
    ApprovalResolution,
    HostDeclaration,
    Input,
    JsonObject,
    JsonValue,
    Model,
    PreToolHookResponse,
    Warning,
)


def input_content(context: AgentContext) -> JsonValue:
    if context["interception_point"] == "input":
        return context["input"]["content"]
    return None


def transformed_args(response: PreToolHookResponse) -> JsonObject | None:
    verdict = response["verdict"]
    if verdict["decision"] == "transform":
        return verdict["transform"]["args"]
    return None


response: PreToolHookResponse = {
    "verdict": {"decision": "transform", "transform": {"args": {"reviewed": True}}}
}
resolution: ApprovalResolution = {"outcome": "unresolved", "context_identity": None}
declaration: HostDeclaration = {
    "$schema": "https://example.test/host.schema.json",
    "spec": "agent-hooks/draft",
    "bindings": [],
    "surface": {"profiles": {"sequential/run_all": {}}},
}
nullable_warning: Warning = {"reason": None}
null_input: Input = {"role": "user", "content": None}

# Missing and null are distinct, including when a required value is unknown.
missing_content: Input = {"role": "user"}  # type: ignore[typeddict-item]
null_vendor: Model = {"id": "model", "vendor": None}  # type: ignore[typeddict-item]
not_json: JsonValue = object()  # type: ignore[assignment]

# Each hook keeps its own transform shape, and startup cannot transform.
wrong_transform: PreToolHookResponse = {
    "verdict": {"decision": "transform", "transform": {"value": 1}}  # type: ignore[typeddict-item]
}
startup_transform: AgentStartupHookResponse = {
    "verdict": {"decision": "transform", "transform": {"args": {}}}  # type: ignore[typeddict-item]
}
