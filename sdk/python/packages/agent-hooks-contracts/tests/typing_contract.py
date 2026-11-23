# Copyright (c) Microsoft. All rights reserved.

"""Static contract checks; run mypy with warn_unused_ignores enabled."""

from agent_hooks_contracts.generated.draft import (
    AgentContext,
    AgentStartupHookResponse,
    ApprovalRequest,
    ApprovalResolution,
    HostDeclaration,
    Input,
    InterceptionRecord,
    JsonObject,
    JsonValue,
    Model,
    PreToolHookResponse,
    Surface,
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

approval: ApprovalRequest = {
    "context_identity": None,
    "interception_point": "pre_tool_call",
    "verdict": {"decision": "deny"},
}
bad_approval: ApprovalRequest = {
    "context_identity": None,
    "interception_point": "input",
    "verdict": {"decision": "allow"},  # type: ignore[typeddict-item]
}
record: InterceptionRecord = {
    "interception_point": "input",
    "mode": "enforce",
    "verdict": {"decision": "allow"},
    "input_identity": None,
    "enforced_identity": None,
    "identity_provider": None,
    "session_id": "session",
    "sequence": 1,
    "composition": {"profile": "sequential/first_deny"},
    "interceptors_registered": 1,
}
bad_record: InterceptionRecord = {
    **record,
    "verdict": {"decision": "allow", "transform": {"args": {}}},  # type: ignore[typeddict-unknown-key]
}
buffered: Surface = {}
streaming: Surface = {"buffered_output": False, "exposure_bound": "one-chunk"}
missing_bound: Surface = {"buffered_output": False}  # type: ignore[typeddict-item]
wrong_posture: Surface = {
    "buffered_output": True,  # type: ignore[typeddict-item]
    "exposure_bound": "not permitted",
}
