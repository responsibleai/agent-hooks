// Copyright (c) Microsoft. All rights reserved.

// Generated from the AgentHooks TypeSpec specification. Do not edit.
// Regenerate with pnpm generate from the repository root.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Enforcement modes (§8).
 */
export type Mode = "enforce" | "evaluate_only";

/**
 * Composition profiles (§7.1), in §7.2 table order.
 */
export type CompositionProfile = "sequential/first_deny" | "sequential/run_all" | "parallel/strictest" | "parallel/unanimous";

/**
 * Values of the on_approval knob (§7.2).
 */
export type OnApproval = "stop" | "resume";

/**
 * Values of the on_disagreement and on_transform_conflict knobs (§7.2).
 */
export type ConflictResolution = "deny" | "approval";

/**
 * The closed set of agent lifecycle interception points (AGENT-HOOKS-0.1 §3).
 */
export type InterceptionPoint = "agent_startup" | "input" | "pre_model_call" | "post_model_call" | "pre_tool_call" | "post_tool_call" | "output" | "agent_shutdown";

/**
 * Who produced an input (§4.2).
 */
export type InputRole = "user" | "system" | "external";

/**
 * Why the agent stopped (§4.2).
 */
export type SummaryReason = "completed" | "error" | "cancelled";

/**
 * Who acts (§4.5).
 */
export type ActorKind = "human" | "service" | "agent";

/**
 * The three decisions (§5).
 */
export type Decision = "allow" | "deny" | "transform";

/**
 * How a consultation ended (§9).
 */
export type Outcome = "approve" | "reject" | "unresolved";

/**
 * The host_error reasons a continue posture may substitute for (§6.3.1).
 */
export type SubstitutedFor = "host_error:interceptor_failed" | "host_error:interceptor_timeout" | "host_error:verdict_invalid";

/**
 * Consultation outcomes a record names (§7.6).
 */
export type ResolvedBy = "approval" | "rejection";

/**
 * The conformance capability vocabulary (§13.1, conformance/draft/vectors.schema.json)
 * less buffered_output, which is the boolean surface member, plus
 * host_declaration.
 */
export type Capability = "model_calls" | "tool_calls" | "parallel_tool_calls" | "streaming" | "multi_turn" | "int64_json" | "bigint_json" | "incremental_output" | "host_declaration";

/**
 * The tool-seam posture a host implements (§13.1).
 */
export type ToolSeamHostError = "continue" | "terminate";

/**
 * The failure posture (§6.3.1).
 */
export type OnError = "deny" | "continue";

/**
 * Grammar of a registered name: provider, resolver, redactor or binding id.
 */
export type Reference = string;

export type BoundedTimeoutMs = number;

/**
 * Namespaced extensions (§4.6): any value under a key that follows the
 * namespace rule.
 */
export type Extensions = Record<string, JsonValue>;

/**
 * An open JSON object, not an arbitrary JSON value.
 */
export type JsonObject = Record<string, JsonValue>;

/**
 * Conditional payload of agent_startup (§4.2).
 */
export interface AgentInit {
  tools_registered: Array<string>;
}

/**
 * Conditional payload of input (§4.2).
 */
export interface Input {
  content: JsonValue;
  role: InputRole;
}

/**
 * Conditional payload of pre_model_call and post_model_call (§4.2).
 */
export interface Model {
  id: string;
  vendor?: string;
  params?: Record<string, JsonValue>;
}

/**
 * One message of the model request (§4.2).
 */
export interface Message {
  role: string;
  content: JsonValue;
}

/**
 * One tool call the model asked for (§4.2).
 */
export interface ToolCallRequest {
  id?: string;
  name: string;
  args: Record<string, JsonValue>;
}

/**
 * Conditional payload of post_model_call (§4.2).
 */
export interface Response {
  content: JsonValue;
  tool_calls: Array<ToolCallRequest>;
  finish_reason: string;
}

/**
 * Token usage of a model call (§4.3).
 */
export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * Conditional payload of pre_tool_call and post_tool_call (§4.2).
 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, JsonValue>;
  content_hash?: string;
}

/**
 * Conditional payload of post_tool_call (§4.2).
 */
export interface ToolResult {
  value: JsonValue;
  is_error: boolean;
  duration_ms?: number;
}

/**
 * One declared tool (§4.3).
 */
export interface ToolDecl {
  name: string;
  description?: string;
  schema?: Record<string, JsonValue>;
}

/**
 * Conditional payload of output (§4.2).
 */
export interface Output {
  content: JsonValue;
}

/**
 * Conditional payload of agent_shutdown (§4.2).
 */
export interface Summary {
  reason: SummaryReason;
  tool_calls?: number;
  errors?: number;
  duration_seconds?: number;
}

/**
 * Metadata available at every interception point.
 */
export interface ContextMetadata {
  /**
   * This version's wire string (§4.1). A released version's contexts
   * carry that version's own string, agent-hooks/<major>.<minor>.
   */
  spec: "agent-hooks/draft";
  timestamp: string;
  sequence: number;
  agent: {
    id: string;
    framework: string;
    name?: string;
    version?: string;
  };
  session: {
    id: string;
    started_at?: string;
    turn?: number;
  };
  trace?: {
    trace_id?: string;
    span_id?: string;
  };
  tenant?: {
    id?: string;
    name?: string;
  };
  actor?: {
    id?: string;
    kind?: ActorKind;
  };
  budgets?: {
    tool_call_count?: number;
    token_count?: number;
    elapsed_seconds?: number;
    cost_usd?: number;
  };
}

/**
 * The request at agent_startup: agent_init is required (§4.2).
 */
export interface AgentStartupRequest {
  /**
   * This version's wire string (§4.1). A released version's contexts
   * carry that version's own string, agent-hooks/<major>.<minor>.
   */
  spec: "agent-hooks/draft";
  timestamp: string;
  sequence: number;
  agent: {
    id: string;
    framework: string;
    name?: string;
    version?: string;
  };
  session: {
    id: string;
    started_at?: string;
    turn?: number;
  };
  trace?: {
    trace_id?: string;
    span_id?: string;
  };
  tenant?: {
    id?: string;
    name?: string;
  };
  actor?: {
    id?: string;
    kind?: ActorKind;
  };
  budgets?: {
    tool_call_count?: number;
    token_count?: number;
    elapsed_seconds?: number;
    cost_usd?: number;
  };
  interception_point: "agent_startup";
  extensions?: Record<string, JsonValue>;
  agent_init: AgentInit;
}

/**
 * The request at input: input is required (§4.2).
 */
export interface InputRequest {
  /**
   * This version's wire string (§4.1). A released version's contexts
   * carry that version's own string, agent-hooks/<major>.<minor>.
   */
  spec: "agent-hooks/draft";
  timestamp: string;
  sequence: number;
  agent: {
    id: string;
    framework: string;
    name?: string;
    version?: string;
  };
  session: {
    id: string;
    started_at?: string;
    turn?: number;
  };
  trace?: {
    trace_id?: string;
    span_id?: string;
  };
  tenant?: {
    id?: string;
    name?: string;
  };
  actor?: {
    id?: string;
    kind?: ActorKind;
  };
  budgets?: {
    tool_call_count?: number;
    token_count?: number;
    elapsed_seconds?: number;
    cost_usd?: number;
  };
  interception_point: "input";
  extensions?: Record<string, JsonValue>;
  input: Input;
}

/**
 * The request at pre_model_call: model and messages are required (§4.2).
 */
export interface PreModelCallRequest {
  /**
   * This version's wire string (§4.1). A released version's contexts
   * carry that version's own string, agent-hooks/<major>.<minor>.
   */
  spec: "agent-hooks/draft";
  timestamp: string;
  sequence: number;
  agent: {
    id: string;
    framework: string;
    name?: string;
    version?: string;
  };
  session: {
    id: string;
    started_at?: string;
    turn?: number;
  };
  trace?: {
    trace_id?: string;
    span_id?: string;
  };
  tenant?: {
    id?: string;
    name?: string;
  };
  actor?: {
    id?: string;
    kind?: ActorKind;
  };
  budgets?: {
    tool_call_count?: number;
    token_count?: number;
    elapsed_seconds?: number;
    cost_usd?: number;
  };
  interception_point: "pre_model_call";
  extensions?: Record<string, JsonValue>;
  model: Model;
  messages: Array<Message>;
  tools?: Array<ToolDecl>;
  request_id?: string;
}

/**
 * The request at post_model_call: model and response are required (§4.2).
 */
export interface PostModelCallRequest {
  /**
   * This version's wire string (§4.1). A released version's contexts
   * carry that version's own string, agent-hooks/<major>.<minor>.
   */
  spec: "agent-hooks/draft";
  timestamp: string;
  sequence: number;
  agent: {
    id: string;
    framework: string;
    name?: string;
    version?: string;
  };
  session: {
    id: string;
    started_at?: string;
    turn?: number;
  };
  trace?: {
    trace_id?: string;
    span_id?: string;
  };
  tenant?: {
    id?: string;
    name?: string;
  };
  actor?: {
    id?: string;
    kind?: ActorKind;
  };
  budgets?: {
    tool_call_count?: number;
    token_count?: number;
    elapsed_seconds?: number;
    cost_usd?: number;
  };
  interception_point: "post_model_call";
  extensions?: Record<string, JsonValue>;
  model: Model;
  response: Response;
  request_id?: string;
  usage?: Usage;
}

/**
 * The request at pre_tool_call: tool_call is required (§4.2).
 */
export interface PreToolCallRequest {
  /**
   * This version's wire string (§4.1). A released version's contexts
   * carry that version's own string, agent-hooks/<major>.<minor>.
   */
  spec: "agent-hooks/draft";
  timestamp: string;
  sequence: number;
  agent: {
    id: string;
    framework: string;
    name?: string;
    version?: string;
  };
  session: {
    id: string;
    started_at?: string;
    turn?: number;
  };
  trace?: {
    trace_id?: string;
    span_id?: string;
  };
  tenant?: {
    id?: string;
    name?: string;
  };
  actor?: {
    id?: string;
    kind?: ActorKind;
  };
  budgets?: {
    tool_call_count?: number;
    token_count?: number;
    elapsed_seconds?: number;
    cost_usd?: number;
  };
  interception_point: "pre_tool_call";
  extensions?: Record<string, JsonValue>;
  tool_call: ToolCall;
}

/**
 * The request at post_tool_call: tool_call and tool_result are required (§4.2).
 */
export interface PostToolCallRequest {
  /**
   * This version's wire string (§4.1). A released version's contexts
   * carry that version's own string, agent-hooks/<major>.<minor>.
   */
  spec: "agent-hooks/draft";
  timestamp: string;
  sequence: number;
  agent: {
    id: string;
    framework: string;
    name?: string;
    version?: string;
  };
  session: {
    id: string;
    started_at?: string;
    turn?: number;
  };
  trace?: {
    trace_id?: string;
    span_id?: string;
  };
  tenant?: {
    id?: string;
    name?: string;
  };
  actor?: {
    id?: string;
    kind?: ActorKind;
  };
  budgets?: {
    tool_call_count?: number;
    token_count?: number;
    elapsed_seconds?: number;
    cost_usd?: number;
  };
  interception_point: "post_tool_call";
  extensions?: Record<string, JsonValue>;
  tool_call: ToolCall;
  tool_result: ToolResult;
}

/**
 * The request at output: output is required (§4.2).
 */
export interface OutputRequest {
  /**
   * This version's wire string (§4.1). A released version's contexts
   * carry that version's own string, agent-hooks/<major>.<minor>.
   */
  spec: "agent-hooks/draft";
  timestamp: string;
  sequence: number;
  agent: {
    id: string;
    framework: string;
    name?: string;
    version?: string;
  };
  session: {
    id: string;
    started_at?: string;
    turn?: number;
  };
  trace?: {
    trace_id?: string;
    span_id?: string;
  };
  tenant?: {
    id?: string;
    name?: string;
  };
  actor?: {
    id?: string;
    kind?: ActorKind;
  };
  budgets?: {
    tool_call_count?: number;
    token_count?: number;
    elapsed_seconds?: number;
    cost_usd?: number;
  };
  interception_point: "output";
  extensions?: Record<string, JsonValue>;
  output: Output;
}

/**
 * The request at agent_shutdown: summary is required (§4.2).
 */
export interface AgentShutdownRequest {
  /**
   * This version's wire string (§4.1). A released version's contexts
   * carry that version's own string, agent-hooks/<major>.<minor>.
   */
  spec: "agent-hooks/draft";
  timestamp: string;
  sequence: number;
  agent: {
    id: string;
    framework: string;
    name?: string;
    version?: string;
  };
  session: {
    id: string;
    started_at?: string;
    turn?: number;
  };
  trace?: {
    trace_id?: string;
    span_id?: string;
  };
  tenant?: {
    id?: string;
    name?: string;
  };
  actor?: {
    id?: string;
    kind?: ActorKind;
  };
  budgets?: {
    tool_call_count?: number;
    token_count?: number;
    elapsed_seconds?: number;
    cost_usd?: number;
  };
  interception_point: "agent_shutdown";
  extensions?: Record<string, JsonValue>;
  summary: Summary;
}

/**
 * A recorded concern that does not affect control flow (§5.1).
 */
export interface Warning {
  /**
   * Interceptor-supplied warning identifier. The host_error: prefix is reserved
   * for host-synthesized failures (§11) and host_warning: for host-synthesized
   * warnings (§11.1); an interceptor warning with either prefix fails §5
   * validation.
   */
  reason?: string | null;
  message?: string | null;
}

/**
 * Named URIs an auditor MAY consult. Hosts MUST NOT dereference automatically (§14).
 */
export type VerificationPointers = Record<string, string>;

/**
 * Offline-verifiable evidence attached to a verdict (§14).
 */
export interface Evidence {
  /**
   * Content address (sha256:<hex>) or URI of an offline-verifiable proof.
   */
  artefact?: string | null;
  verification_pointers?: Record<string, string>;
}

/**
 * Members every decision may carry.
 */
export interface VerdictBase {
  /**
   * Interceptor-supplied machine identifier. The host_error: prefix is reserved
   * for host-synthesized failures (§11).
   */
  reason?: string | null;
  /**
   * Human-readable text for the caller.
   */
  message?: string | null;
  /**
   * Recorded concerns that do not affect control flow (§5.1). Permitted on any
   * decision; unioned across an emission's verdicts (§7.3). Reasons starting with
   * host_warning: are reserved for the host (§11.1).
   */
  warnings?: Array<Warning> | null;
  evidence?: Evidence;
  /**
   * Interceptor-supplied labels the host MUST persist with the produced data and
   * resurface on later interception points (§5.4).
   */
  result_labels?: Array<string> | null;
}

/**
 * allow: proceed. Absorbs warn through warnings[] (§5.1).
 */
export interface AllowVerdict {
  /**
   * Interceptor-supplied machine identifier. The host_error: prefix is reserved
   * for host-synthesized failures (§11).
   */
  reason?: string | null;
  /**
   * Human-readable text for the caller.
   */
  message?: string | null;
  /**
   * Recorded concerns that do not affect control flow (§5.1). Permitted on any
   * decision; unioned across an emission's verdicts (§7.3). Reasons starting with
   * host_warning: are reserved for the host (§11.1).
   */
  warnings?: Array<Warning> | null;
  evidence?: Evidence;
  /**
   * Interceptor-supplied labels the host MUST persist with the produced data and
   * resurface on later interception points (§5.4).
   */
  result_labels?: Array<string> | null;
  decision: "allow";
}

/**
 * deny: stop the action. Absorbs escalate through the approval block (§5.1).
 */
export interface DenyVerdict {
  /**
   * Interceptor-supplied machine identifier. The host_error: prefix is reserved
   * for host-synthesized failures (§11).
   */
  reason?: string | null;
  /**
   * Human-readable text for the caller.
   */
  message?: string | null;
  /**
   * Recorded concerns that do not affect control flow (§5.1). Permitted on any
   * decision; unioned across an emission's verdicts (§7.3). Reasons starting with
   * host_warning: are reserved for the host (§11.1).
   */
  warnings?: Array<Warning> | null;
  evidence?: Evidence;
  /**
   * Interceptor-supplied labels the host MUST persist with the produced data and
   * resurface on later interception points (§5.4).
   */
  result_labels?: Array<string> | null;
  decision: "deny";
  /**
   * Present only on deny: marks the deny as liftable by the approval seam (§9).
   * MAY be empty; reserved for approver-facing parameters.
   */
  approval?: Record<string, JsonValue>;
}

/**
 * Replaces the complete input payload.
 */
export interface InputHookTransform {
  input: Input;
}

/**
 * Replaces the complete model-message array.
 */
export interface PreModelHookTransform {
  messages: Array<Message>;
}

/**
 * Replaces the complete model response payload.
 */
export interface PostModelHookTransform {
  response: Response;
}

/**
 * Replaces the complete tool args for the pre-tool hook.
 */
export interface PreToolHookTransform {
  args: Record<string, JsonValue>;
}

/**
 * Replaces only the value of the tool result.
 */
export interface PostToolHookTransform {
  value: JsonValue;
}

/**
 * Replaces the complete output payload.
 */
export interface OutputHookTransform {
  output: Output;
}

/**
 * agent_startup response: transforms are forbidden.
 */
export interface AgentStartupHookResponse {
  verdict: NonTransformVerdict;
  extensions?: Record<string, JsonValue>;
}

/**
 * input response.
 */
export interface InputHookResponse {
  verdict: AllowVerdict | DenyVerdict | {
    /**
     * Interceptor-supplied machine identifier. The host_error: prefix is reserved
     * for host-synthesized failures (§11).
     */
    reason?: string | null;
    /**
     * Human-readable text for the caller.
     */
    message?: string | null;
    /**
     * Recorded concerns that do not affect control flow (§5.1). Permitted on any
     * decision; unioned across an emission's verdicts (§7.3). Reasons starting with
     * host_warning: are reserved for the host (§11.1).
     */
    warnings?: Array<Warning> | null;
    evidence?: Evidence;
    /**
     * Interceptor-supplied labels the host MUST persist with the produced data and
     * resurface on later interception points (§5.4).
     */
    result_labels?: Array<string> | null;
    decision: "transform";
    transform: InputHookTransform;
  };
  extensions?: Record<string, JsonValue>;
}

/**
 * pre_model_call response.
 */
export interface PreModelHookResponse {
  verdict: AllowVerdict | DenyVerdict | {
    /**
     * Interceptor-supplied machine identifier. The host_error: prefix is reserved
     * for host-synthesized failures (§11).
     */
    reason?: string | null;
    /**
     * Human-readable text for the caller.
     */
    message?: string | null;
    /**
     * Recorded concerns that do not affect control flow (§5.1). Permitted on any
     * decision; unioned across an emission's verdicts (§7.3). Reasons starting with
     * host_warning: are reserved for the host (§11.1).
     */
    warnings?: Array<Warning> | null;
    evidence?: Evidence;
    /**
     * Interceptor-supplied labels the host MUST persist with the produced data and
     * resurface on later interception points (§5.4).
     */
    result_labels?: Array<string> | null;
    decision: "transform";
    transform: PreModelHookTransform;
  };
  extensions?: Record<string, JsonValue>;
}

/**
 * post_model_call response.
 */
export interface PostModelHookResponse {
  verdict: AllowVerdict | DenyVerdict | {
    /**
     * Interceptor-supplied machine identifier. The host_error: prefix is reserved
     * for host-synthesized failures (§11).
     */
    reason?: string | null;
    /**
     * Human-readable text for the caller.
     */
    message?: string | null;
    /**
     * Recorded concerns that do not affect control flow (§5.1). Permitted on any
     * decision; unioned across an emission's verdicts (§7.3). Reasons starting with
     * host_warning: are reserved for the host (§11.1).
     */
    warnings?: Array<Warning> | null;
    evidence?: Evidence;
    /**
     * Interceptor-supplied labels the host MUST persist with the produced data and
     * resurface on later interception points (§5.4).
     */
    result_labels?: Array<string> | null;
    decision: "transform";
    transform: PostModelHookTransform;
  };
  extensions?: Record<string, JsonValue>;
}

/**
 * pre_tool_call response.
 */
export interface PreToolHookResponse {
  verdict: AllowVerdict | DenyVerdict | {
    /**
     * Interceptor-supplied machine identifier. The host_error: prefix is reserved
     * for host-synthesized failures (§11).
     */
    reason?: string | null;
    /**
     * Human-readable text for the caller.
     */
    message?: string | null;
    /**
     * Recorded concerns that do not affect control flow (§5.1). Permitted on any
     * decision; unioned across an emission's verdicts (§7.3). Reasons starting with
     * host_warning: are reserved for the host (§11.1).
     */
    warnings?: Array<Warning> | null;
    evidence?: Evidence;
    /**
     * Interceptor-supplied labels the host MUST persist with the produced data and
     * resurface on later interception points (§5.4).
     */
    result_labels?: Array<string> | null;
    decision: "transform";
    transform: PreToolHookTransform;
  };
  extensions?: Record<string, JsonValue>;
}

/**
 * post_tool_call response.
 */
export interface PostToolHookResponse {
  verdict: AllowVerdict | DenyVerdict | {
    /**
     * Interceptor-supplied machine identifier. The host_error: prefix is reserved
     * for host-synthesized failures (§11).
     */
    reason?: string | null;
    /**
     * Human-readable text for the caller.
     */
    message?: string | null;
    /**
     * Recorded concerns that do not affect control flow (§5.1). Permitted on any
     * decision; unioned across an emission's verdicts (§7.3). Reasons starting with
     * host_warning: are reserved for the host (§11.1).
     */
    warnings?: Array<Warning> | null;
    evidence?: Evidence;
    /**
     * Interceptor-supplied labels the host MUST persist with the produced data and
     * resurface on later interception points (§5.4).
     */
    result_labels?: Array<string> | null;
    decision: "transform";
    transform: PostToolHookTransform;
  };
  extensions?: Record<string, JsonValue>;
}

/**
 * output response.
 */
export interface OutputHookResponse {
  verdict: AllowVerdict | DenyVerdict | {
    /**
     * Interceptor-supplied machine identifier. The host_error: prefix is reserved
     * for host-synthesized failures (§11).
     */
    reason?: string | null;
    /**
     * Human-readable text for the caller.
     */
    message?: string | null;
    /**
     * Recorded concerns that do not affect control flow (§5.1). Permitted on any
     * decision; unioned across an emission's verdicts (§7.3). Reasons starting with
     * host_warning: are reserved for the host (§11.1).
     */
    warnings?: Array<Warning> | null;
    evidence?: Evidence;
    /**
     * Interceptor-supplied labels the host MUST persist with the produced data and
     * resurface on later interception points (§5.4).
     */
    result_labels?: Array<string> | null;
    decision: "transform";
    transform: OutputHookTransform;
  };
  extensions?: Record<string, JsonValue>;
}

/**
 * agent_shutdown response: transforms are forbidden.
 */
export interface AgentShutdownHookResponse {
  verdict: NonTransformVerdict;
  extensions?: Record<string, JsonValue>;
}

/**
 * The liftable deny being consulted: an interceptor's (passes §5,
 * verdict.schema.json) or the host-synthesized §7.5 shape, whose reason is a
 * reserved host_error:* string that §5 forbids interceptors to emit — so this
 * member is validated against the §5 schema only when its reason is not
 * host_error:*.
 */
export type LiftableDeny = Record<string, JsonValue> & {
  decision: "deny";
};

/**
 * What the host hands the resolver (§9).
 */
export interface ApprovalRequest {
  context_identity: string | null;
  interception_point: InterceptionPoint;
  verdict: Record<string, JsonValue> & {
    decision: "deny";
  };
  /**
   * The AgentContext as presented to the resolver. MAY be redacted per host policy.
   */
  context?: AgentContext;
}

export interface ResolutionBase {
  /**
   * MUST equal the request's context_identity byte for byte (echo rule, §9);
   * null echoes as null.
   */
  context_identity: string | null;
}

/**
 * approve: the resolver lifts the deny with an allow verdict.
 */
export interface ApproveResolution {
  /**
   * MUST equal the request's context_identity byte for byte (echo rule, §9);
   * null echoes as null.
   */
  context_identity: string | null;
  outcome: "approve";
  verdict: AllowVerdict;
}

/**
 * reject: the resolver keeps a deny.
 */
export interface RejectResolution {
  /**
   * MUST equal the request's context_identity byte for byte (echo rule, §9);
   * null echoes as null.
   */
  context_identity: string | null;
  outcome: "reject";
  verdict: DenyVerdict;
}

/**
 * unresolved: no decision; the deny stands and no verdict is carried.
 */
export interface UnresolvedResolution {
  /**
   * MUST equal the request's context_identity byte for byte (echo rule, §9);
   * null echoes as null.
   */
  context_identity: string | null;
  outcome: "unresolved";
}

/**
 * Presence only; members are stripped by the projection.
 */
export type ApprovalPresence = Record<string, never>;

/**
 * Warning metadata retained in a payload-free record projection.
 */
export interface WarningProjection {
  reason?: string | null;
  message?: string | null;
}

/**
 * A payload-free projection of the combined verdict (§10.3): transform
 * details are omitted, approval members stripped, messages truncated to
 * 256 UTF-8 bytes.
 * warnings[].reason may carry host_warning:control_failed (§6.3.1, §11.1).
 */
export interface VerdictProjection {
  decision: Decision;
  reason?: string | null;
  message?: string | null;
  warnings?: Array<WarningProjection> | null;
  evidence?: Evidence;
  result_labels?: Array<string> | null;
  approval?: Record<string, never>;
}

/**
 * W3C Trace Context identifiers echoed from the context's optional trace block
 * (§4.5, §10.3).
 */
export interface Trace {
  trace_id?: string;
  span_id?: string;
}

/**
 * Payload-free summary of one interceptor's verdict (§10.3).
 */
export interface VerdictSlot {
  index: number;
  decision: Decision;
  reason?: string | null;
  /**
   * Host-chosen payload-free registration identifier for the interceptor at index (§10.3).
   */
  name?: string;
  /**
   * Present iff this slot's verdict is the allow the host substituted under
   * on_error: continue (§6.3.1): the host_error reason the §6.3 deny would have
   * carried. The entry's decision is allow and reason is absent.
   */
  substituted_for?: SubstitutedFor;
}

/**
 * Host-side record of one emission (AGENT-HOOKS-0.1 §10.3). Payload-free:
 * identities (when a provider is declared) bind the record to the exact
 * pre/post-composition context; session_id/sequence/decided_by provide ordering
 * and attribution; composition makes the record interpretable without
 * out-of-band host configuration.
 *
 * Two rules relate members and cannot be typed, so they are written as JSON
 * Schema in the allOf extension below and copied through by the emitter: verdicts
 * is REQUIRED under the multi-verdict profiles (§7.4), and the identities are
 * null when identity_provider is null (§10.3).
 */
export interface InterceptionRecord {
  interception_point: InterceptionPoint;
  mode: Mode;
  verdict: VerdictProjection;
  /**
   * Identity provider output on the context before dispatch; null iff identity_provider is null.
   */
  input_identity: string | null;
  /**
   * Identity provider output after composition completes; null iff identity_provider is null.
   */
  enforced_identity: string | null;
  /**
   * The declared identity provider (§10.1): "jcs-sha256", a host-defined id
   * (name rules enforced: ^[a-z][a-z0-9_-]*$ and never a jcs prefix), or null
   * (identity-unbound).
   */
  identity_provider: string | null;
  /**
   * ctx.session.id — correlates records across a session.
   */
  session_id: string;
  /**
   * ctx.sequence — total order of records within the session (§12.2.3).
   */
  sequence: number;
  /**
   * OPTIONAL. The context's RFC 3339 timestamp, copied verbatim (§10.3); absent
   * when the context lacked the field.
   */
  timestamp?: string;
  /**
   * OPTIONAL. W3C Trace Context identifiers echoed from the context's optional
   * trace block (§4.5, §10.3); absent when the context carried neither member.
   */
  trace?: Trace;
  /**
   * Registration index of the interceptor whose verdict won aggregation or whose
   * liftable deny was consulted (§7.6); null for a pure-allow combination or a
   * host-synthesized verdict.
   */
  decided_by?: number | null;
  /**
   * The composition profile and knobs in effect for this emission (§7.1).
   */
  composition: {
    profile: CompositionProfile;
    on_approval?: OnApproval;
    on_disagreement?: ConflictResolution;
    on_transform_conflict?: ConflictResolution;
  };
  /**
   * Payload-free per-interceptor summary. REQUIRED in multi-verdict profiles
   * (sequential/run_all, parallel/*) and whenever any slot carries
   * substituted_for (§6.3.1); otherwise OPTIONAL in sequential/first_deny.
   */
  verdicts?: Array<VerdictSlot>;
  /**
   * true iff one or more registered interceptors were never invoked in this
   * emission (short-circuit, approval-stop, or a failed fold-transform). Defined
   * for the sequential profiles (§7.4).
   */
  fold_truncated?: boolean;
  /**
   * Consultation outcome (§7.6, §10.3): "approval" iff a permit resolution
   * substituted for a verdict; "rejection" iff the seam was consulted and did not
   * lift the deny; absent/null iff never consulted.
   */
  resolved_by?: ResolvedBy | null;
  /**
   * Number of interceptors registered at emission time (§10.3).
   */
  interceptors_registered: number;
}

/**
 * OPTIONAL and informative; never checked against code.
 */
export interface Host {
  /**
   * Same grammar as agent.framework (§4.1).
   */
  name: string;
  version?: string;
}

/**
 * §7.2. A knob the declared profile does not consult is refused, never cleared;
 * a consulted knob left unset takes the §7.2 default.
 */
export interface CompositionConfig {
  profile?: CompositionProfile;
  /**
   * Consulted by sequential/first_deny only; refused under any other profile (§7.7.3).
   */
  on_approval?: OnApproval;
  /**
   * Consulted by parallel/unanimous only.
   */
  on_disagreement?: ConflictResolution;
  /**
   * Consulted by parallel/strictest only.
   */
  on_transform_conflict?: ConflictResolution;
}

export interface ApprovalConfig {
  /**
   * §9. A registered approval resolver by reference, or null: liftable denies
   * stay denies.
   */
  resolver?: string | null;
  /**
   * §9 redaction seam. A registered approval redactor by reference, or null.
   */
  redactor?: string | null;
}

export interface PostureConfig {
  /**
   * §13.1. Must equal the posture the host's code implements.
   */
  tool_seam_host_error?: ToolSeamHostError;
}

export interface TimeoutsConfig {
  /**
   * §7 interceptor bound; default 5000. null means unbounded and must be written out.
   */
  interceptor_ms?: TimeoutMs;
  /**
   * §9 resolver bound; defaults to the value of interceptor_ms.
   */
  approval_resolver_ms?: TimeoutMs;
}

export interface RecordsConfig {
  /**
   * In-memory record buffer bound; null (the default) is unbounded. The maximum
   * is 2^53 - 1 so the resolved document always canonicalises (§4.4).
   */
  max_buffered?: number | null;
}

export interface FailureConfig {
  /**
   * §6.3.1. The document default every binding's on_error inherits. deny keeps
   * the §6.3 substituted deny; continue substitutes an allow carrying
   * host_warning:control_failed and records the cause in substituted_for.
   */
  on_error?: OnError;
}

/**
 * Host configuration (§7.1). Every member is OPTIONAL; defaults are the values
 * the specification already names and fail closed.
 */
export interface Configuration {
  /**
   * §8.
   */
  mode?: Mode;
  composition?: CompositionConfig;
  /**
   * §10.1: "jcs-sha256" (the default), a registered custom provider name
   * (^[a-z][a-z0-9_-]{0,63}$, never a jcs prefix), or null (identity-unbound).
   */
  identity_provider?: string | null;
  approval?: ApprovalConfig;
  posture?: PostureConfig;
  timeouts?: TimeoutsConfig;
  records?: RecordsConfig;
  failure?: FailureConfig;
}

export interface FirstDenySupport {
  on_approval?: Array<OnApproval>;
}

export type RunAllSupport = Record<string, never>;

export interface StrictestSupport {
  on_transform_conflict?: Array<ConflictResolution>;
}

export interface UnanimousSupport {
  on_disagreement?: Array<ConflictResolution>;
}

/**
 * Profiles and the knob values supported under each (§13.1). Only the knobs a
 * profile consults may appear; an absent knob member means the §7.2 default
 * value only.
 */
export interface ProfileSupport {
  "sequential/first_deny"?: FirstDenySupport;
  "sequential/run_all"?: Record<string, never>;
  "parallel/strictest"?: StrictestSupport;
  "parallel/unanimous"?: UnanimousSupport;
}

export interface SurfaceBase {
  /**
   * Points the host emits; always includes agent_startup, input, output and
   * agent_shutdown (§3.2), and omits the model or tool points only in pairs.
   */
  interception_points?: Array<InterceptionPoint>;
  capabilities?: Array<Capability>;
  profiles?: ProfileSupport;
}

/**
 * The surface of a host that buffers output (§12.1a), the default:
 * exposure_bound is absent.
 */
export interface BufferedSurface {
  /**
   * Points the host emits; always includes agent_startup, input, output and
   * agent_shutdown (§3.2), and omits the model or tool points only in pairs.
   */
  interception_points?: Array<InterceptionPoint>;
  capabilities?: Array<Capability>;
  profiles?: ProfileSupport;
  /**
   * §12.1a. false must be declared explicitly and requires exposure_bound.
   */
  buffered_output?: true;
}

/**
 * The surface of a host that streams output (§12.1a): buffered_output is
 * written as false and exposure_bound is present.
 */
export interface UnbufferedSurface {
  /**
   * Points the host emits; always includes agent_startup, input, output and
   * agent_shutdown (§3.2), and omits the model or tool points only in pairs.
   */
  interception_points?: Array<InterceptionPoint>;
  capabilities?: Array<Capability>;
  profiles?: ProfileSupport;
  /**
   * §12.1a. false must be declared explicitly and requires exposure_bound.
   */
  buffered_output: false;
  /**
   * §12.1a. Present iff buffered_output is false.
   */
  exposure_bound: string;
}

/**
 * One interceptor binding (§7.7.4).
 */
export interface Binding {
  /**
   * Unique in the array; stamped on verdicts[].name (§10.3).
   */
  id: string;
  /**
   * A lookup key into the host's kind registry and nothing more: never a path,
   * class name, URL or module the loader interprets. At least one dot, so every
   * kind carries a namespace the host controls. The first segments agent_hooks
   * and ctk are reserved. This specification defines no kinds.
   */
  kind: string;
  /**
   * Kind-specific; handed to the kind resolver unchanged. The loader interprets
   * none of it; its one check here is the document-wide integer bound of §7.7.6
   * (no integer token above 2^53 - 1, so the resolved form canonicalises).
   * Default {}.
   */
  config?: JsonValue;
  /**
   * Points this binding runs at, each in the surface. Default: every surface
   * point.
   */
  at?: Array<InterceptionPoint>;
  /**
   * Per-binding bound. Default: configuration.timeouts.interceptor_ms; null is unbounded.
   */
  timeout_ms?: TimeoutMs;
  /**
   * §6.3.1 failure posture for this binding: what the host does when the
   * interceptor raises, times out or returns an invalid verdict. Default:
   * configuration.failure.on_error.
   */
  on_error?: OnError;
}

/**
 * A host declaration document (AGENT-HOOKS-0.1 §7.7): one JSON object that
 * fixes a host's configuration (§7.1, §8, §10.1, §13.1), its declared surface
 * (§13.1) and its interceptor bindings. The document's spec member selects
 * its format and behavior; this file describes agent-hooks/draft. Every object is
 * closed except bindings[].config and the values under extensions. This schema
 * is self-contained so a settings validator can use it alone. Rules it cannot
 * express (knob consistency, the §3.2 floor, surface against the host's code,
 * registered names) live in the loader (§7.7.6).
 */
export interface HostDeclaration {
  configuration?: Configuration;
  /**
   * Ordered: array order is dispatch order. REQUIRED, so an empty-deny host
   * (zero bindings) is written down rather than arrived at by omission. Binding
   * ids are unique.
   */
  bindings: Array<Binding>;
  /**
   * Ignored by the loader; kept for editors.
   */
  $schema?: string;
  /**
   * REQUIRED. The specification version the document is written for
   * (§7.7.3, §7.7.6): this version's wire string. A document written for a
   * released version names that version's own string instead, and is
   * read by that version's rules.
   */
  spec: "agent-hooks/draft";
  /**
   * OPTIONAL. An operator label for logs. Never stamped on records.
   */
  id?: string;
  host?: Host;
  /**
   * The declared surface (§13.1) in file form. OPTIONAL: when absent the host's
   * own code surface applies. Every stated member must be a subset of what the
   * host's code reports; a document a conformance claim cites carries this block
   * explicitly.
   */
  surface?: Surface;
  /**
   * Host-specific extras, kept verbatim and never read by the loader. Keys
   * follow the §4.6 namespace rule; the §4.6 reserved namespaces apply.
   */
  extensions?: Record<string, JsonValue>;
}

/**
 * Payload a host constructs at each interception point (AGENT-HOOKS-0.1 §4).
 * Each variant requires its discriminator and own hook payload, with shared
 * metadata and optional namespaced extensions.
 */
export type AgentContext = AgentStartupRequest | InputRequest | PreModelCallRequest | PostModelCallRequest | PreToolCallRequest | PostToolCallRequest | OutputRequest | AgentShutdownRequest;

/**
 * Verdict choices for hooks that do not support transforms.
 */
export type NonTransformVerdict = AllowVerdict | DenyVerdict;

/**
 * What the resolver returns (§9).
 */
export type ApprovalResolution = ApproveResolution | RejectResolution | UnresolvedResolution;

/**
 * A bound in milliseconds; null is unbounded.
 */
export type TimeoutMs = number | null;

/**
 * The declared surface (§13.1) in file form, by output posture.
 */
export type Surface = BufferedSurface | UnbufferedSurface;
