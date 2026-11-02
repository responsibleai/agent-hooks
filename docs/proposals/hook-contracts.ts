// Copyright (c) Microsoft. All rights reserved.

// Initial design sketch, not a normative schema or production SDK API.
// Sources: spec/schema/generated/strict-contexts/*.schema.json.
// Required-only hook payloads: no optional payload members, interception_point,
// or target. Verdict metadata preserves the existing optional response fields.
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
 * Required metadata only; optional schema members are omitted recursively.
 * TypeScript does not enforce the scalar constraints below, exact object keys,
 * or JSON serializability. Validate data at the wire boundary.
 * Hook interfaces are erased at runtime: hook-bound dispatch retains identity.
 * The typed request keeps shared metadata flat and separate from hook payload
 * fields; a wire adapter supplies interception_point and target.
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
  };
  session: {
    /** @minLength 1 */
    id: string;
  };
}

/**
 * Generic extension-friendly request envelope. Shared AgentContext metadata
 * and each hook's required payload properties are all top-level.
 */
export interface HooksRequest extends AgentContext {
  interception_point: HookInterceptionPoint;
  [extension: string]: unknown;
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
  agent_init: {
    tools_registered: string[];
  };
}

export type AgentStartupHookResponse = NonTransformVerdict;

// ---------------------------------------------------------------------------
// Hook: input
// ---------------------------------------------------------------------------
export interface InputHookRequest extends HooksRequest {
  interception_point: "input";
  input: {
    content: JsonValue;
    role: "user" | "system" | "external";
  };
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
  model: {
    id: string;
  };
  messages: {
    role: string;
    content: JsonValue;
  }[];
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
  model: {
    id: string;
  };
  response: {
    content: JsonValue;
    // Required even when empty; the schema's optional tool-call id is omitted.
    tool_calls: {
      name: string;
      args: JsonObject;
    }[];
    finish_reason: string;
  };
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
  tool_call: {
    /** @minLength 1 */
    id: string;
    /** @minLength 1 */
    name: string;
    args: JsonObject;
  };
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
  tool_call: {
    /** @minLength 1 */
    id: string;
    /** @minLength 1 */
    name: string;
    args: JsonObject;
  };
  tool_result: {
    value: JsonValue;
    is_error: boolean;
  };
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
  output: {
    content: JsonValue;
  };
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
  summary: {
    reason: "completed" | "error" | "cancelled";
  };
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
