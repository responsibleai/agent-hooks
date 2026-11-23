# Copyright (c) Microsoft. All rights reserved.

"""
Generated wire contracts. Do not edit.

Regenerate with pnpm generate at the repository root.
"""

from typing import Literal, Union

from typing_extensions import NotRequired, TypedDict

JsonValue = Union[  # noqa: UP007
    None,
    bool,
    int,
    float,
    str,
    list["JsonValue"],
    dict[str, "JsonValue"],
]

# Enforcement modes (§8).
Mode = Literal["enforce", "evaluate_only"]

# Composition profiles (§7.1), in §7.2 table order.
CompositionProfile = Literal[
    "sequential/first_deny",
    "sequential/run_all",
    "parallel/strictest",
    "parallel/unanimous",
]

# Values of the on_approval knob (§7.2).
OnApproval = Literal["stop", "resume"]

# Values of the on_disagreement and on_transform_conflict knobs (§7.2).
ConflictResolution = Literal["deny", "approval"]

# The closed set of agent lifecycle interception points (AGENT-HOOKS-0.1 §3).
InterceptionPoint = Literal[
    "agent_startup",
    "input",
    "pre_model_call",
    "post_model_call",
    "pre_tool_call",
    "post_tool_call",
    "output",
    "agent_shutdown",
]

# Who produced an input (§4.2).
InputRole = Literal["user", "system", "external"]

# Why the agent stopped (§4.2).
SummaryReason = Literal["completed", "error", "cancelled"]

# Who acts (§4.5).
ActorKind = Literal["human", "service", "agent"]

# The three decisions (§5).
Decision = Literal["allow", "deny", "transform"]

# How a consultation ended (§9).
Outcome = Literal["approve", "reject", "unresolved"]

# The host_error reasons a continue posture may substitute for (§6.3.1).
SubstitutedFor = Literal[
    "host_error:interceptor_failed",
    "host_error:interceptor_timeout",
    "host_error:verdict_invalid",
]

# Consultation outcomes a record names (§7.6).
ResolvedBy = Literal["approval", "rejection"]

# The conformance capability vocabulary (§13.1, conformance/draft/vectors.schema.json)
# less buffered_output, which is the boolean surface member, plus
# host_declaration.
Capability = Literal[
    "model_calls",
    "tool_calls",
    "parallel_tool_calls",
    "streaming",
    "multi_turn",
    "int64_json",
    "bigint_json",
    "incremental_output",
    "host_declaration",
]

# The tool-seam posture a host implements (§13.1).
ToolSeamHostError = Literal["continue", "terminate"]

# The failure posture (§6.3.1).
OnError = Literal["deny", "continue"]

# Grammar of a registered name: provider, resolver, redactor or binding id.
Reference = str

BoundedTimeoutMs = int

# Namespaced extensions (§4.6): any value under a key that follows the
# namespace rule.
Extensions = dict[str, JsonValue]

# An open JSON object, not an arbitrary JSON value.
JsonObject = dict[str, JsonValue]


class AgentInit(TypedDict):
    """
    Conditional payload of agent_startup (§4.2).
    """

    tools_registered: list[str]


class Input(TypedDict):
    """
    Conditional payload of input (§4.2).
    """

    content: JsonValue
    role: InputRole


class Model(TypedDict):
    """
    Conditional payload of pre_model_call and post_model_call (§4.2).
    """

    id: str
    vendor: NotRequired[str]
    params: NotRequired[JsonObject]


class Message(TypedDict):
    """
    One message of the model request (§4.2).
    """

    role: str
    content: JsonValue


class ToolCallRequest(TypedDict):
    """
    One tool call the model asked for (§4.2).
    """

    id: NotRequired[str]
    name: str
    args: JsonObject


class Response(TypedDict):
    """
    Conditional payload of post_model_call (§4.2).
    """

    content: JsonValue
    tool_calls: list[ToolCallRequest]
    finish_reason: str


class Usage(TypedDict):
    """
    Token usage of a model call (§4.3).
    """

    prompt_tokens: NotRequired[int]
    completion_tokens: NotRequired[int]


class ToolCall(TypedDict):
    """
    Conditional payload of pre_tool_call and post_tool_call (§4.2).
    """

    id: str
    name: str
    args: JsonObject
    content_hash: NotRequired[str]


class ToolResult(TypedDict):
    """
    Conditional payload of post_tool_call (§4.2).
    """

    value: JsonValue
    is_error: bool
    duration_ms: NotRequired[float]


class ToolDecl(TypedDict):
    """
    One declared tool (§4.3).
    """

    name: str
    description: NotRequired[str]
    schema: NotRequired[JsonObject]


class Output(TypedDict):
    """
    Conditional payload of output (§4.2).
    """

    content: JsonValue


class Summary(TypedDict):
    """
    Conditional payload of agent_shutdown (§4.2).
    """

    reason: SummaryReason
    tool_calls: NotRequired[int]
    errors: NotRequired[int]
    duration_seconds: NotRequired[float]


class ContextMetadataAgent(TypedDict):
    id: str
    framework: str
    name: NotRequired[str]
    version: NotRequired[str]


class ContextMetadataSession(TypedDict):
    id: str
    started_at: NotRequired[str]
    turn: NotRequired[int]


class ContextMetadataTrace(TypedDict):
    trace_id: NotRequired[str]
    span_id: NotRequired[str]


class ContextMetadataTenant(TypedDict):
    id: NotRequired[str]
    name: NotRequired[str]


class ContextMetadataActor(TypedDict):
    id: NotRequired[str]
    kind: NotRequired[ActorKind]


class ContextMetadataBudgets(TypedDict):
    tool_call_count: NotRequired[float]
    token_count: NotRequired[float]
    elapsed_seconds: NotRequired[float]
    cost_usd: NotRequired[float]


class ContextMetadata(TypedDict):
    """
    Metadata available at every interception point.
    """

    # This version's wire string (§4.1). A released version's contexts
    # carry that version's own string, agent-hooks/<major>.<minor>.
    spec: Literal["agent-hooks/draft"]
    timestamp: str
    sequence: int
    agent: ContextMetadataAgent
    session: ContextMetadataSession
    trace: NotRequired[ContextMetadataTrace]
    tenant: NotRequired[ContextMetadataTenant]
    actor: NotRequired[ContextMetadataActor]
    budgets: NotRequired[ContextMetadataBudgets]


class AgentStartupRequest(TypedDict):
    """
    The request at agent_startup: agent_init is required (§4.2).
    """

    # This version's wire string (§4.1). A released version's contexts
    # carry that version's own string, agent-hooks/<major>.<minor>.
    spec: Literal["agent-hooks/draft"]
    timestamp: str
    sequence: int
    agent: ContextMetadataAgent
    session: ContextMetadataSession
    trace: NotRequired[ContextMetadataTrace]
    tenant: NotRequired[ContextMetadataTenant]
    actor: NotRequired[ContextMetadataActor]
    budgets: NotRequired[ContextMetadataBudgets]
    interception_point: Literal["agent_startup"]
    extensions: NotRequired[Extensions]
    agent_init: AgentInit


class InputRequest(TypedDict):
    """
    The request at input: input is required (§4.2).
    """

    # This version's wire string (§4.1). A released version's contexts
    # carry that version's own string, agent-hooks/<major>.<minor>.
    spec: Literal["agent-hooks/draft"]
    timestamp: str
    sequence: int
    agent: ContextMetadataAgent
    session: ContextMetadataSession
    trace: NotRequired[ContextMetadataTrace]
    tenant: NotRequired[ContextMetadataTenant]
    actor: NotRequired[ContextMetadataActor]
    budgets: NotRequired[ContextMetadataBudgets]
    interception_point: Literal["input"]
    extensions: NotRequired[Extensions]
    input: Input


class PreModelCallRequest(TypedDict):
    """
    The request at pre_model_call: model and messages are required (§4.2).
    """

    # This version's wire string (§4.1). A released version's contexts
    # carry that version's own string, agent-hooks/<major>.<minor>.
    spec: Literal["agent-hooks/draft"]
    timestamp: str
    sequence: int
    agent: ContextMetadataAgent
    session: ContextMetadataSession
    trace: NotRequired[ContextMetadataTrace]
    tenant: NotRequired[ContextMetadataTenant]
    actor: NotRequired[ContextMetadataActor]
    budgets: NotRequired[ContextMetadataBudgets]
    interception_point: Literal["pre_model_call"]
    extensions: NotRequired[Extensions]
    model: Model
    messages: list[Message]
    tools: NotRequired[list[ToolDecl]]
    request_id: NotRequired[str]


class PostModelCallRequest(TypedDict):
    """
    The request at post_model_call: model and response are required (§4.2).
    """

    # This version's wire string (§4.1). A released version's contexts
    # carry that version's own string, agent-hooks/<major>.<minor>.
    spec: Literal["agent-hooks/draft"]
    timestamp: str
    sequence: int
    agent: ContextMetadataAgent
    session: ContextMetadataSession
    trace: NotRequired[ContextMetadataTrace]
    tenant: NotRequired[ContextMetadataTenant]
    actor: NotRequired[ContextMetadataActor]
    budgets: NotRequired[ContextMetadataBudgets]
    interception_point: Literal["post_model_call"]
    extensions: NotRequired[Extensions]
    model: Model
    response: Response
    request_id: NotRequired[str]
    usage: NotRequired[Usage]


class PreToolCallRequest(TypedDict):
    """
    The request at pre_tool_call: tool_call is required (§4.2).
    """

    # This version's wire string (§4.1). A released version's contexts
    # carry that version's own string, agent-hooks/<major>.<minor>.
    spec: Literal["agent-hooks/draft"]
    timestamp: str
    sequence: int
    agent: ContextMetadataAgent
    session: ContextMetadataSession
    trace: NotRequired[ContextMetadataTrace]
    tenant: NotRequired[ContextMetadataTenant]
    actor: NotRequired[ContextMetadataActor]
    budgets: NotRequired[ContextMetadataBudgets]
    interception_point: Literal["pre_tool_call"]
    extensions: NotRequired[Extensions]
    tool_call: ToolCall


class PostToolCallRequest(TypedDict):
    """
    The request at post_tool_call: tool_call and tool_result are required (§4.2).
    """

    # This version's wire string (§4.1). A released version's contexts
    # carry that version's own string, agent-hooks/<major>.<minor>.
    spec: Literal["agent-hooks/draft"]
    timestamp: str
    sequence: int
    agent: ContextMetadataAgent
    session: ContextMetadataSession
    trace: NotRequired[ContextMetadataTrace]
    tenant: NotRequired[ContextMetadataTenant]
    actor: NotRequired[ContextMetadataActor]
    budgets: NotRequired[ContextMetadataBudgets]
    interception_point: Literal["post_tool_call"]
    extensions: NotRequired[Extensions]
    tool_call: ToolCall
    tool_result: ToolResult


class OutputRequest(TypedDict):
    """
    The request at output: output is required (§4.2).
    """

    # This version's wire string (§4.1). A released version's contexts
    # carry that version's own string, agent-hooks/<major>.<minor>.
    spec: Literal["agent-hooks/draft"]
    timestamp: str
    sequence: int
    agent: ContextMetadataAgent
    session: ContextMetadataSession
    trace: NotRequired[ContextMetadataTrace]
    tenant: NotRequired[ContextMetadataTenant]
    actor: NotRequired[ContextMetadataActor]
    budgets: NotRequired[ContextMetadataBudgets]
    interception_point: Literal["output"]
    extensions: NotRequired[Extensions]
    output: Output


class AgentShutdownRequest(TypedDict):
    """
    The request at agent_shutdown: summary is required (§4.2).
    """

    # This version's wire string (§4.1). A released version's contexts
    # carry that version's own string, agent-hooks/<major>.<minor>.
    spec: Literal["agent-hooks/draft"]
    timestamp: str
    sequence: int
    agent: ContextMetadataAgent
    session: ContextMetadataSession
    trace: NotRequired[ContextMetadataTrace]
    tenant: NotRequired[ContextMetadataTenant]
    actor: NotRequired[ContextMetadataActor]
    budgets: NotRequired[ContextMetadataBudgets]
    interception_point: Literal["agent_shutdown"]
    extensions: NotRequired[Extensions]
    summary: Summary


class Warning(TypedDict):
    """
    A recorded concern that does not affect control flow (§5.1).
    """

    # Interceptor-supplied warning identifier. The host_error: prefix is reserved
    # for host-synthesized failures (§11) and host_warning: for host-synthesized
    # warnings (§11.1); an interceptor warning with either prefix fails §5
    # validation.
    reason: NotRequired[str | None]
    message: NotRequired[str | None]


# Named URIs an auditor MAY consult. Hosts MUST NOT dereference automatically (§14).
VerificationPointers = dict[str, str]


class Evidence(TypedDict):
    """
    Offline-verifiable evidence attached to a verdict (§14).
    """

    # Content address (sha256:<hex>) or URI of an offline-verifiable proof.
    artefact: NotRequired[str | None]
    verification_pointers: NotRequired[VerificationPointers]


class VerdictBase(TypedDict):
    """
    Members every decision may carry.
    """

    # Interceptor-supplied machine identifier. The host_error: prefix is reserved
    # for host-synthesized failures (§11).
    reason: NotRequired[str | None]
    # Human-readable text for the caller.
    message: NotRequired[str | None]
    # Recorded concerns that do not affect control flow (§5.1). Permitted on any
    # decision; unioned across an emission's verdicts (§7.3). Reasons starting with
    # host_warning: are reserved for the host (§11.1).
    warnings: NotRequired[list[Warning] | None]
    evidence: NotRequired[Evidence]
    # Interceptor-supplied labels the host MUST persist with the produced data and
    # resurface on later interception points (§5.4).
    result_labels: NotRequired[list[str] | None]


class AllowVerdict(TypedDict):
    """
    allow: proceed. Absorbs warn through warnings[] (§5.1).
    """

    # Interceptor-supplied machine identifier. The host_error: prefix is reserved
    # for host-synthesized failures (§11).
    reason: NotRequired[str | None]
    # Human-readable text for the caller.
    message: NotRequired[str | None]
    # Recorded concerns that do not affect control flow (§5.1). Permitted on any
    # decision; unioned across an emission's verdicts (§7.3). Reasons starting with
    # host_warning: are reserved for the host (§11.1).
    warnings: NotRequired[list[Warning] | None]
    evidence: NotRequired[Evidence]
    # Interceptor-supplied labels the host MUST persist with the produced data and
    # resurface on later interception points (§5.4).
    result_labels: NotRequired[list[str] | None]
    decision: Literal["allow"]


class DenyVerdict(TypedDict):
    """
    deny: stop the action. Absorbs escalate through the approval block (§5.1).
    """

    # Interceptor-supplied machine identifier. The host_error: prefix is reserved
    # for host-synthesized failures (§11).
    reason: NotRequired[str | None]
    # Human-readable text for the caller.
    message: NotRequired[str | None]
    # Recorded concerns that do not affect control flow (§5.1). Permitted on any
    # decision; unioned across an emission's verdicts (§7.3). Reasons starting with
    # host_warning: are reserved for the host (§11.1).
    warnings: NotRequired[list[Warning] | None]
    evidence: NotRequired[Evidence]
    # Interceptor-supplied labels the host MUST persist with the produced data and
    # resurface on later interception points (§5.4).
    result_labels: NotRequired[list[str] | None]
    decision: Literal["deny"]
    # Present only on deny: marks the deny as liftable by the approval seam (§9).
    # MAY be empty; reserved for approver-facing parameters.
    approval: NotRequired[JsonObject]


class InputHookTransform(TypedDict):
    """
    Replaces the complete input payload.
    """

    input: Input


class PreModelHookTransform(TypedDict):
    """
    Replaces the complete model-message array.
    """

    messages: list[Message]


class PostModelHookTransform(TypedDict):
    """
    Replaces the complete model response payload.
    """

    response: Response


class PreToolHookTransform(TypedDict):
    """
    Replaces the complete tool args for the pre-tool hook.
    """

    args: JsonObject


class PostToolHookTransform(TypedDict):
    """
    Replaces only the value of the tool result.
    """

    value: JsonValue


class OutputHookTransform(TypedDict):
    """
    Replaces the complete output payload.
    """

    output: Output


# Verdict choices for hooks that do not support transforms.
NonTransformVerdict = AllowVerdict | DenyVerdict


class AgentStartupHookResponse(TypedDict):
    """
    agent_startup response: transforms are forbidden.
    """

    verdict: NonTransformVerdict
    extensions: NotRequired[Extensions]


class InputHookTransformVerdict(TypedDict):
    """
    transform: proceed with the hook-specific replacement payload.
    """

    # Interceptor-supplied machine identifier. The host_error: prefix is reserved
    # for host-synthesized failures (§11).
    reason: NotRequired[str | None]
    # Human-readable text for the caller.
    message: NotRequired[str | None]
    # Recorded concerns that do not affect control flow (§5.1). Permitted on any
    # decision; unioned across an emission's verdicts (§7.3). Reasons starting with
    # host_warning: are reserved for the host (§11.1).
    warnings: NotRequired[list[Warning] | None]
    evidence: NotRequired[Evidence]
    # Interceptor-supplied labels the host MUST persist with the produced data and
    # resurface on later interception points (§5.4).
    result_labels: NotRequired[list[str] | None]
    decision: Literal["transform"]
    transform: InputHookTransform


class InputHookResponse(TypedDict):
    """
    input response.
    """

    verdict: AllowVerdict | DenyVerdict | InputHookTransformVerdict
    extensions: NotRequired[Extensions]


class PreModelHookTransformVerdict(TypedDict):
    """
    transform: proceed with the hook-specific replacement payload.
    """

    # Interceptor-supplied machine identifier. The host_error: prefix is reserved
    # for host-synthesized failures (§11).
    reason: NotRequired[str | None]
    # Human-readable text for the caller.
    message: NotRequired[str | None]
    # Recorded concerns that do not affect control flow (§5.1). Permitted on any
    # decision; unioned across an emission's verdicts (§7.3). Reasons starting with
    # host_warning: are reserved for the host (§11.1).
    warnings: NotRequired[list[Warning] | None]
    evidence: NotRequired[Evidence]
    # Interceptor-supplied labels the host MUST persist with the produced data and
    # resurface on later interception points (§5.4).
    result_labels: NotRequired[list[str] | None]
    decision: Literal["transform"]
    transform: PreModelHookTransform


class PreModelHookResponse(TypedDict):
    """
    pre_model_call response.
    """

    verdict: AllowVerdict | DenyVerdict | PreModelHookTransformVerdict
    extensions: NotRequired[Extensions]


class PostModelHookTransformVerdict(TypedDict):
    """
    transform: proceed with the hook-specific replacement payload.
    """

    # Interceptor-supplied machine identifier. The host_error: prefix is reserved
    # for host-synthesized failures (§11).
    reason: NotRequired[str | None]
    # Human-readable text for the caller.
    message: NotRequired[str | None]
    # Recorded concerns that do not affect control flow (§5.1). Permitted on any
    # decision; unioned across an emission's verdicts (§7.3). Reasons starting with
    # host_warning: are reserved for the host (§11.1).
    warnings: NotRequired[list[Warning] | None]
    evidence: NotRequired[Evidence]
    # Interceptor-supplied labels the host MUST persist with the produced data and
    # resurface on later interception points (§5.4).
    result_labels: NotRequired[list[str] | None]
    decision: Literal["transform"]
    transform: PostModelHookTransform


class PostModelHookResponse(TypedDict):
    """
    post_model_call response.
    """

    verdict: AllowVerdict | DenyVerdict | PostModelHookTransformVerdict
    extensions: NotRequired[Extensions]


class PreToolHookTransformVerdict(TypedDict):
    """
    transform: proceed with the hook-specific replacement payload.
    """

    # Interceptor-supplied machine identifier. The host_error: prefix is reserved
    # for host-synthesized failures (§11).
    reason: NotRequired[str | None]
    # Human-readable text for the caller.
    message: NotRequired[str | None]
    # Recorded concerns that do not affect control flow (§5.1). Permitted on any
    # decision; unioned across an emission's verdicts (§7.3). Reasons starting with
    # host_warning: are reserved for the host (§11.1).
    warnings: NotRequired[list[Warning] | None]
    evidence: NotRequired[Evidence]
    # Interceptor-supplied labels the host MUST persist with the produced data and
    # resurface on later interception points (§5.4).
    result_labels: NotRequired[list[str] | None]
    decision: Literal["transform"]
    transform: PreToolHookTransform


class PreToolHookResponse(TypedDict):
    """
    pre_tool_call response.
    """

    verdict: AllowVerdict | DenyVerdict | PreToolHookTransformVerdict
    extensions: NotRequired[Extensions]


class PostToolHookTransformVerdict(TypedDict):
    """
    transform: proceed with the hook-specific replacement payload.
    """

    # Interceptor-supplied machine identifier. The host_error: prefix is reserved
    # for host-synthesized failures (§11).
    reason: NotRequired[str | None]
    # Human-readable text for the caller.
    message: NotRequired[str | None]
    # Recorded concerns that do not affect control flow (§5.1). Permitted on any
    # decision; unioned across an emission's verdicts (§7.3). Reasons starting with
    # host_warning: are reserved for the host (§11.1).
    warnings: NotRequired[list[Warning] | None]
    evidence: NotRequired[Evidence]
    # Interceptor-supplied labels the host MUST persist with the produced data and
    # resurface on later interception points (§5.4).
    result_labels: NotRequired[list[str] | None]
    decision: Literal["transform"]
    transform: PostToolHookTransform


class PostToolHookResponse(TypedDict):
    """
    post_tool_call response.
    """

    verdict: AllowVerdict | DenyVerdict | PostToolHookTransformVerdict
    extensions: NotRequired[Extensions]


class OutputHookTransformVerdict(TypedDict):
    """
    transform: proceed with the hook-specific replacement payload.
    """

    # Interceptor-supplied machine identifier. The host_error: prefix is reserved
    # for host-synthesized failures (§11).
    reason: NotRequired[str | None]
    # Human-readable text for the caller.
    message: NotRequired[str | None]
    # Recorded concerns that do not affect control flow (§5.1). Permitted on any
    # decision; unioned across an emission's verdicts (§7.3). Reasons starting with
    # host_warning: are reserved for the host (§11.1).
    warnings: NotRequired[list[Warning] | None]
    evidence: NotRequired[Evidence]
    # Interceptor-supplied labels the host MUST persist with the produced data and
    # resurface on later interception points (§5.4).
    result_labels: NotRequired[list[str] | None]
    decision: Literal["transform"]
    transform: OutputHookTransform


class OutputHookResponse(TypedDict):
    """
    output response.
    """

    verdict: AllowVerdict | DenyVerdict | OutputHookTransformVerdict
    extensions: NotRequired[Extensions]


class AgentShutdownHookResponse(TypedDict):
    """
    agent_shutdown response: transforms are forbidden.
    """

    verdict: NonTransformVerdict
    extensions: NotRequired[Extensions]


class LiftableDeny(TypedDict):
    """
    The liftable deny being consulted: an interceptor's (passes §5,
    verdict.schema.json) or the host-synthesized §7.5 shape, whose reason is a
    reserved host_error:* string that §5 forbids interceptors to emit — so this
    member is validated against the §5 schema only when its reason is not
    host_error:*.
    """

    decision: Literal["deny"]


# Payload a host constructs at each interception point (AGENT-HOOKS-0.1 §4).
# Each variant requires its discriminator and own hook payload, with shared
# metadata and optional namespaced extensions.
AgentContext = (
    AgentStartupRequest
    | InputRequest
    | PreModelCallRequest
    | PostModelCallRequest
    | PreToolCallRequest
    | PostToolCallRequest
    | OutputRequest
    | AgentShutdownRequest
)


class ApprovalRequest(TypedDict):
    """
    What the host hands the resolver (§9).
    """

    context_identity: str | None
    interception_point: InterceptionPoint
    verdict: LiftableDeny
    # The AgentContext as presented to the resolver. MAY be redacted per host policy.
    context: NotRequired[AgentContext]


class ResolutionBase(TypedDict):
    # MUST equal the request's context_identity byte for byte (echo rule, §9);
    # null echoes as null.
    context_identity: str | None


class ApproveResolution(TypedDict):
    """
    approve: the resolver lifts the deny with an allow verdict.
    """

    # MUST equal the request's context_identity byte for byte (echo rule, §9);
    # null echoes as null.
    context_identity: str | None
    outcome: Literal["approve"]
    verdict: AllowVerdict


class RejectResolution(TypedDict):
    """
    reject: the resolver keeps a deny.
    """

    # MUST equal the request's context_identity byte for byte (echo rule, §9);
    # null echoes as null.
    context_identity: str | None
    outcome: Literal["reject"]
    verdict: DenyVerdict


class UnresolvedResolution(TypedDict):
    """
    unresolved: no decision; the deny stands and no verdict is carried.
    """

    # MUST equal the request's context_identity byte for byte (echo rule, §9);
    # null echoes as null.
    context_identity: str | None
    outcome: Literal["unresolved"]


class ApprovalPresence(TypedDict):
    """
    Presence only; members are stripped by the projection.
    """

    pass


class WarningProjection(TypedDict):
    """
    Warning metadata retained in a payload-free record projection.
    """

    reason: NotRequired[str | None]
    message: NotRequired[str | None]


class VerdictProjection(TypedDict):
    """
    A payload-free projection of the combined verdict (§10.3): transform
    details are omitted, approval members stripped, messages truncated to
    256 UTF-8 bytes.
    warnings[].reason may carry host_warning:control_failed (§6.3.1, §11.1).
    """

    decision: Decision
    reason: NotRequired[str | None]
    message: NotRequired[str | None]
    warnings: NotRequired[list[WarningProjection] | None]
    evidence: NotRequired[Evidence]
    result_labels: NotRequired[list[str] | None]
    approval: NotRequired[ApprovalPresence]


class Trace(TypedDict):
    """
    W3C Trace Context identifiers echoed from the context's optional trace block
    (§4.5, §10.3).
    """

    trace_id: NotRequired[str]
    span_id: NotRequired[str]


class VerdictSlot(TypedDict):
    """
    Payload-free summary of one interceptor's verdict (§10.3).
    """

    index: int
    decision: Decision
    reason: NotRequired[str | None]
    # Host-chosen payload-free registration identifier for the interceptor at index (§10.3).
    name: NotRequired[str]
    # Present iff this slot's verdict is the allow the host substituted under
    # on_error: continue (§6.3.1): the host_error reason the §6.3 deny would have
    # carried. The entry's decision is allow and reason is absent.
    substituted_for: NotRequired[SubstitutedFor]


class InterceptionRecordComposition(TypedDict):
    profile: CompositionProfile
    on_approval: NotRequired[OnApproval]
    on_disagreement: NotRequired[ConflictResolution]
    on_transform_conflict: NotRequired[ConflictResolution]


class InterceptionRecord(TypedDict):
    """
    Host-side record of one emission (AGENT-HOOKS-0.1 §10.3). Payload-free:
    identities (when a provider is declared) bind the record to the exact
    pre/post-composition context; session_id/sequence/decided_by provide ordering
    and attribution; composition makes the record interpretable without
    out-of-band host configuration.

    Two rules relate members and cannot be typed, so they are written as JSON
    Schema in the allOf extension below and copied through by the emitter: verdicts
    is REQUIRED under the multi-verdict profiles (§7.4), and the identities are
    null when identity_provider is null (§10.3).
    """

    interception_point: InterceptionPoint
    mode: Mode
    verdict: VerdictProjection
    # Identity provider output on the context before dispatch; null iff identity_provider is null.
    input_identity: str | None
    # Identity provider output after composition completes; null iff identity_provider is null.
    enforced_identity: str | None
    # The declared identity provider (§10.1): "jcs-sha256", a host-defined id
    # (name rules enforced: ^[a-z][a-z0-9_-]*$ and never a jcs prefix), or null
    # (identity-unbound).
    identity_provider: str | None
    # ctx.session.id — correlates records across a session.
    session_id: str
    # ctx.sequence — total order of records within the session (§12.2.3).
    sequence: int
    # OPTIONAL. The context's RFC 3339 timestamp, copied verbatim (§10.3); absent
    # when the context lacked the field.
    timestamp: NotRequired[str]
    # OPTIONAL. W3C Trace Context identifiers echoed from the context's optional
    # trace block (§4.5, §10.3); absent when the context carried neither member.
    trace: NotRequired[Trace]
    # Registration index of the interceptor whose verdict won aggregation or whose
    # liftable deny was consulted (§7.6); null for a pure-allow combination or a
    # host-synthesized verdict.
    decided_by: NotRequired[int | None]
    # The composition profile and knobs in effect for this emission (§7.1).
    composition: InterceptionRecordComposition
    # Payload-free per-interceptor summary. REQUIRED in multi-verdict profiles
    # (sequential/run_all, parallel/*) and whenever any slot carries
    # substituted_for (§6.3.1); otherwise OPTIONAL in sequential/first_deny.
    verdicts: NotRequired[list[VerdictSlot]]
    # true iff one or more registered interceptors were never invoked in this
    # emission (short-circuit, approval-stop, or a failed fold-transform). Defined
    # for the sequential profiles (§7.4).
    fold_truncated: NotRequired[bool]
    # Consultation outcome (§7.6, §10.3): "approval" iff a permit resolution
    # substituted for a verdict; "rejection" iff the seam was consulted and did not
    # lift the deny; absent/null iff never consulted.
    resolved_by: NotRequired[ResolvedBy | None]
    # Number of interceptors registered at emission time (§10.3).
    interceptors_registered: int


class Host(TypedDict):
    """
    OPTIONAL and informative; never checked against code.
    """

    # Same grammar as agent.framework (§4.1).
    name: str
    version: NotRequired[str]


class CompositionConfig(TypedDict):
    """
    §7.2. A knob the declared profile does not consult is refused, never cleared;
    a consulted knob left unset takes the §7.2 default.
    """

    profile: NotRequired[CompositionProfile]
    # Consulted by sequential/first_deny only; refused under any other profile (§7.7.3).
    on_approval: NotRequired[OnApproval]
    # Consulted by parallel/unanimous only.
    on_disagreement: NotRequired[ConflictResolution]
    # Consulted by parallel/strictest only.
    on_transform_conflict: NotRequired[ConflictResolution]


class ApprovalConfig(TypedDict):
    # §9. A registered approval resolver by reference, or null: liftable denies
    # stay denies.
    resolver: NotRequired[str | None]
    # §9 redaction seam. A registered approval redactor by reference, or null.
    redactor: NotRequired[str | None]


class PostureConfig(TypedDict):
    # §13.1. Must equal the posture the host's code implements.
    tool_seam_host_error: NotRequired[ToolSeamHostError]


# A bound in milliseconds; null is unbounded.
TimeoutMs = BoundedTimeoutMs | None


class TimeoutsConfig(TypedDict):
    # §7 interceptor bound; default 5000. null means unbounded and must be written out.
    interceptor_ms: NotRequired[TimeoutMs]
    # §9 resolver bound; defaults to the value of interceptor_ms.
    approval_resolver_ms: NotRequired[TimeoutMs]


class RecordsConfig(TypedDict):
    # In-memory record buffer bound; null (the default) is unbounded. The maximum
    # is 2^53 - 1 so the resolved document always canonicalises (§4.4).
    max_buffered: NotRequired[int | None]


class FailureConfig(TypedDict):
    # §6.3.1. The document default every binding's on_error inherits. deny keeps
    # the §6.3 substituted deny; continue substitutes an allow carrying
    # host_warning:control_failed and records the cause in substituted_for.
    on_error: NotRequired[OnError]


class Configuration(TypedDict):
    """
    Host configuration (§7.1). Every member is OPTIONAL; defaults are the values
    the specification already names and fail closed.
    """

    # §8.
    mode: NotRequired[Mode]
    composition: NotRequired[CompositionConfig]
    # §10.1: "jcs-sha256" (the default), a registered custom provider name
    # (^[a-z][a-z0-9_-]{0,63}$, never a jcs prefix), or null (identity-unbound).
    identity_provider: NotRequired[str | None]
    approval: NotRequired[ApprovalConfig]
    posture: NotRequired[PostureConfig]
    timeouts: NotRequired[TimeoutsConfig]
    records: NotRequired[RecordsConfig]
    failure: NotRequired[FailureConfig]


class FirstDenySupport(TypedDict):
    on_approval: NotRequired[list[OnApproval]]


class RunAllSupport(TypedDict):
    pass


class StrictestSupport(TypedDict):
    on_transform_conflict: NotRequired[list[ConflictResolution]]


class UnanimousSupport(TypedDict):
    on_disagreement: NotRequired[list[ConflictResolution]]


# Profiles and the knob values supported under each (§13.1). Only the knobs a
# profile consults may appear; an absent knob member means the §7.2 default
# value only.
ProfileSupport = TypedDict(
    "ProfileSupport",
    {
        "sequential/first_deny": NotRequired[FirstDenySupport],
        "sequential/run_all": NotRequired[RunAllSupport],
        "parallel/strictest": NotRequired[StrictestSupport],
        "parallel/unanimous": NotRequired[UnanimousSupport],
    },
)


class SurfaceBase(TypedDict):
    # Points the host emits; always includes agent_startup, input, output and
    # agent_shutdown (§3.2), and omits the model or tool points only in pairs.
    interception_points: NotRequired[list[InterceptionPoint]]
    capabilities: NotRequired[list[Capability]]
    profiles: NotRequired[ProfileSupport]


class BufferedSurface(TypedDict):
    """
    The surface of a host that buffers output (§12.1a), the default:
    exposure_bound is absent.
    """

    # Points the host emits; always includes agent_startup, input, output and
    # agent_shutdown (§3.2), and omits the model or tool points only in pairs.
    interception_points: NotRequired[list[InterceptionPoint]]
    capabilities: NotRequired[list[Capability]]
    profiles: NotRequired[ProfileSupport]
    # §12.1a. false must be declared explicitly and requires exposure_bound.
    buffered_output: NotRequired[Literal[True]]


class UnbufferedSurface(TypedDict):
    """
    The surface of a host that streams output (§12.1a): buffered_output is
    written as false and exposure_bound is present.
    """

    # Points the host emits; always includes agent_startup, input, output and
    # agent_shutdown (§3.2), and omits the model or tool points only in pairs.
    interception_points: NotRequired[list[InterceptionPoint]]
    capabilities: NotRequired[list[Capability]]
    profiles: NotRequired[ProfileSupport]
    # §12.1a. false must be declared explicitly and requires exposure_bound.
    buffered_output: Literal[False]
    # §12.1a. Present iff buffered_output is false.
    exposure_bound: str


class Binding(TypedDict):
    """
    One interceptor binding (§7.7.4).
    """

    # Unique in the array; stamped on verdicts[].name (§10.3).
    id: Reference
    # A lookup key into the host's kind registry and nothing more: never a path,
    # class name, URL or module the loader interprets. At least one dot, so every
    # kind carries a namespace the host controls. The first segments agent_hooks
    # and ctk are reserved. This specification defines no kinds.
    kind: str
    # Kind-specific; handed to the kind resolver unchanged. The loader interprets
    # none of it; its one check here is the document-wide integer bound of §7.7.6
    # (no integer token above 2^53 - 1, so the resolved form canonicalises).
    # Default {}.
    config: NotRequired[JsonValue]
    # Points this binding runs at, each in the surface. Default: every surface
    # point.
    at: NotRequired[list[InterceptionPoint]]
    # Per-binding bound. Default: configuration.timeouts.interceptor_ms; null is unbounded.
    timeout_ms: NotRequired[TimeoutMs]
    # §6.3.1 failure posture for this binding: what the host does when the
    # interceptor raises, times out or returns an invalid verdict. Default:
    # configuration.failure.on_error.
    on_error: NotRequired[OnError]


# The declared surface (§13.1) in file form, by output posture.
Surface = BufferedSurface | UnbufferedSurface

# A host declaration document (AGENT-HOOKS-0.1 §7.7): one JSON object that
# fixes a host's configuration (§7.1, §8, §10.1, §13.1), its declared surface
# (§13.1) and its interceptor bindings. The document's spec member selects
# its format and behavior; this file describes agent-hooks/draft. Every object is
# closed except bindings[].config and the values under extensions. This schema
# is self-contained so a settings validator can use it alone. Rules it cannot
# express (knob consistency, the §3.2 floor, surface against the host's code,
# registered names) live in the loader (§7.7.6).
HostDeclaration = TypedDict(
    "HostDeclaration",
    {
        "configuration": NotRequired[Configuration],
        # Ordered: array order is dispatch order. REQUIRED, so an empty-deny host
        # (zero bindings) is written down rather than arrived at by omission. Binding
        # ids are unique.
        "bindings": list[Binding],
        # Ignored by the loader; kept for editors.
        "$schema": NotRequired[str],
        # REQUIRED. The specification version the document is written for
        # (§7.7.3, §7.7.6): this version's wire string. A document written for a
        # released version names that version's own string instead, and is
        # read by that version's rules.
        "spec": Literal["agent-hooks/draft"],
        # OPTIONAL. An operator label for logs. Never stamped on records.
        "id": NotRequired[str],
        "host": NotRequired[Host],
        # The declared surface (§13.1) in file form. OPTIONAL: when absent the host's
        # own code surface applies. Every stated member must be a subset of what the
        # host's code reports; a document a conformance claim cites carries this block
        # explicitly.
        "surface": NotRequired[Surface],
        # Host-specific extras, kept verbatim and never read by the loader. Keys
        # follow the §4.6 namespace rule; the §4.6 reserved namespaces apply.
        "extensions": NotRequired[Extensions],
    },
)

# What the resolver returns (§9).
ApprovalResolution = ApproveResolution | RejectResolution | UnresolvedResolution
