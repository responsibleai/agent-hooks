// Copyright (c) Microsoft. All rights reserved.

// Initial design sketch, not a normative schema or production SDK API.
// Sources: spec/schema/generated/strict-contexts/*.schema.json.
// Required hook payloads plus the existing optional context members; target is
// omitted intentionally. Verdict metadata preserves optional response fields.
// Self-contained so this file can move without changing imports.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

export type JsonObject = { [key: string]: JsonValue };

/**
 * Shared metadata envelope. Existing optional agent/session metadata remains
 * optional and retains its draft-schema types.
 * TypeScript does not enforce the scalar constraints below, exact object keys,
 * or JSON serializability. Validate data at the wire boundary.
 * Hook interfaces are erased at runtime: hook-bound dispatch retains identity.
 * The request declares interception_point and keeps shared metadata and hook
 * payloads flat; it does not declare a target member.
 */
export interface AgentContext {
  /** @pattern ^agent-hooks/\d+\.\d+$ */
  spec: string;
  /** @format date-time */
  timestamp: string;
  /**
   * Integer, not a fractional number.
   * @minimum 0
   */
  sequence: number;
  agent: {
    /** @minLength 1 */
    id: string;
    /** @pattern ^[a-z0-9_-]+$ */
    framework: string;
    name?: string;
    version?: string;
  };
  session: {
    /** @minLength 1 */
    id: string;
    /** @format date-time */
    started_at?: string;
    /** @minimum 0 */
    turn?: number;
  };
}

/**
 * Generic request envelope. Existing known optional context members remain
 * optional at every hook, matching the existing draft schema.
 */
export interface HooksRequest extends AgentContext {
  interception_point: HookInterceptionPoint;
  agent_init?: AgentInit;
  input?: Input;
  model?: Model;
  messages?: Message[];
  request_id?: string;
  response?: ModelResponse;
  usage?: Usage;
  tool_call?: ToolCall;
  tool_result?: ToolResult;
  tools?: ToolDecl[];
  output?: Output;
  summary?: Summary;
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
    kind?: "human" | "service" | "agent";
  };
  budgets?: {
    tool_call_count?: number;
    token_count?: number;
    elapsed_seconds?: number;
    cost_usd?: number;
  };
  extensions?: JsonObject;
  [extension: string]: unknown;
}

export interface AgentInit {
  tools_registered: string[];
}

export interface Input {
  content: unknown;
  role: "user" | "system" | "external";
}

export interface Model {
  id: string;
  vendor?: string;
  params?: object;
}

export interface Message {
  role: string;
  content: unknown;
}

export interface ToolCallRequest {
  id?: string;
  name: string;
  args: object;
}

export interface ModelResponse {
  content: unknown;
  tool_calls: ToolCallRequest[];
  finish_reason: string;
}

export interface ToolCall {
  /** @minLength 1 */
  id: string;
  /** @minLength 1 */
  name: string;
  args: object;
  /** @pattern ^sha256:[0-9a-f]{64}$ */
  content_hash?: string;
}

export interface ToolResult {
  value: unknown;
  is_error: boolean;
  /** @minimum 0 */
  duration_ms?: number;
}

export interface Usage {
  /** @minimum 0 */
  prompt_tokens?: number;
  /** @minimum 0 */
  completion_tokens?: number;
}

export interface ToolDecl {
  name: string;
  description?: string;
  schema?: object;
}

export interface Output {
  content: unknown;
}

export interface Summary {
  reason: "completed" | "error" | "cancelled";
  /** @minimum 0 */
  tool_calls?: number;
  /** @minimum 0 */
  errors?: number;
  /** @minimum 0 */
  duration_seconds?: number;
}

export type HookInterceptionPoint =
  | "agent_startup"
  | "input"
  | "pre_model_call"
  | "post_model_call"
  | "pre_tool_call"
  | "post_tool_call"
  | "output"
  | "agent_shutdown";

export interface VerdictFields {
  reason?: string | null;
  message?: string | null;
  warnings?: {
    reason?: string | null;
    message?: string | null;
  }[] | null;
  evidence?: {
    artefact?: string | null;
    verification_pointers?: Record<string, string>;
  };
  result_labels?: string[] | null;
}

export type AllowVerdict = VerdictFields & { decision: "allow" };

export type DenyVerdict = VerdictFields & {
  decision: "deny";
  approval?: JsonObject;
};

export type TransformVerdict<TTransform> = VerdictFields & {
  decision: "transform";
  transform: TTransform;
};

export type NonTransformVerdict = AllowVerdict | DenyVerdict;

/** Hooks may specialize transform payloads, but cannot add decision variants. */
export type Verdict<TTransform> =
  | NonTransformVerdict
  | TransformVerdict<TTransform>;

/** Core response is the verdict itself; hosted transport envelopes are separate. */
export type HooksResponse<TTransform> = Verdict<TTransform>;

// ---------------------------------------------------------------------------
// Hook: agent_startup
// ---------------------------------------------------------------------------
export interface AgentStartupHookRequest extends HooksRequest {
  interception_point: "agent_startup";
  agent_init: AgentInit;
}

export type AgentStartupHookResponse = NonTransformVerdict;

// ---------------------------------------------------------------------------
// Hook: input
// ---------------------------------------------------------------------------
export interface InputHookRequest extends HooksRequest {
  interception_point: "input";
  input: Input;
}

/** Replaces the complete input payload. */
export interface InputHookTransform {
  input: InputHookRequest["input"];
}

export type InputHookResponse = HooksResponse<InputHookTransform>;

// ---------------------------------------------------------------------------
// Hook: pre_model_call
// ---------------------------------------------------------------------------
export interface PreModelHookRequest extends HooksRequest {
  interception_point: "pre_model_call";
  model: Model;
  messages: Message[];
}

/** Replaces the complete model-message array. */
export interface PreModelHookTransform {
  messages: PreModelHookRequest["messages"];
}

export type PreModelHookResponse = HooksResponse<PreModelHookTransform>;

// ---------------------------------------------------------------------------
// Hook: post_model_call
// ---------------------------------------------------------------------------
export interface PostModelHookRequest extends HooksRequest {
  interception_point: "post_model_call";
  model: Model;
  response: ModelResponse;
}

/** Replaces the complete model response payload. */
export interface PostModelHookTransform {
  response: PostModelHookRequest["response"];
}

export type PostModelHookResponse = HooksResponse<PostModelHookTransform>;

// ---------------------------------------------------------------------------
// Hook: pre_tool_call
// ---------------------------------------------------------------------------
export interface PreToolHookRequest extends HooksRequest {
  interception_point: "pre_tool_call";
  tool_call: ToolCall;
}

/** Replaces the complete tool args for the pre-tool hook. */
export interface PreToolHookTransform {
  args: PreToolHookRequest["tool_call"]["args"];
}

export type PreToolHookResponse = HooksResponse<PreToolHookTransform>;

// ---------------------------------------------------------------------------
// Hook: post_tool_call
// ---------------------------------------------------------------------------
export interface PostToolHookRequest extends HooksRequest {
  interception_point: "post_tool_call";
  tool_call: ToolCall;
  tool_result: ToolResult;
}

/** Replaces only the value of the tool result. */
export interface PostToolHookTransform {
  value: PostToolHookRequest["tool_result"]["value"];
}

export type PostToolHookResponse = HooksResponse<PostToolHookTransform>;

// ---------------------------------------------------------------------------
// Hook: output
// ---------------------------------------------------------------------------
export interface OutputHookRequest extends HooksRequest {
  interception_point: "output";
  output: Output;
}

/** Replaces the complete output payload. */
export interface OutputHookTransform {
  output: OutputHookRequest["output"];
}

export type OutputHookResponse = HooksResponse<OutputHookTransform>;

// ---------------------------------------------------------------------------
// Hook: agent_shutdown
// ---------------------------------------------------------------------------
export interface AgentShutdownHookRequest extends HooksRequest {
  interception_point: "agent_shutdown";
  summary: Summary;
}

export type AgentShutdownHookResponse = NonTransformVerdict;

// ===========================================================================
// SDK-facing handler pairing (separate from serialized data contracts)
// ===========================================================================

/**
 * Synchronous illustrative pairing between a hook request and its response.
 * Execution and asynchronous scheduling are SDK decisions outside this
 * data-contract sketch.
 */
export type HookHandler<TRequest, TResponse> = (
  request: TRequest,
) => TResponse;

export type AgentStartupHookHandler = HookHandler<
  AgentStartupHookRequest,
  AgentStartupHookResponse
>;

export type InputHookHandler = HookHandler<
  InputHookRequest,
  InputHookResponse
>;

export type PreModelHookHandler = HookHandler<
  PreModelHookRequest,
  PreModelHookResponse
>;

export type PostModelHookHandler = HookHandler<
  PostModelHookRequest,
  PostModelHookResponse
>;

export type PreToolHookHandler = HookHandler<
  PreToolHookRequest,
  PreToolHookResponse
>;

export type PostToolHookHandler = HookHandler<
  PostToolHookRequest,
  PostToolHookResponse
>;

export type OutputHookHandler = HookHandler<
  OutputHookRequest,
  OutputHookResponse
>;

export type AgentShutdownHookHandler = HookHandler<
  AgentShutdownHookRequest,
  AgentShutdownHookResponse
>;
