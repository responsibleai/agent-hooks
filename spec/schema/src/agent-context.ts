// Copyright (c) Microsoft. All rights reserved.

// agent-context.schema.json and its per-point variants (§4). The master is
// the union of one variant per interception point; each variant requires that
// point's conditional members. scripts/generate-schemas.ts derives the closed
// per-point files under agent-context/ from the same variants.

import { Extensions } from "./common";
import { InterceptionPoint } from "./interception-point";

/** Conditional payload of agent_startup (§4.2). */
export interface AgentInit {
  tools_registered: string[];
}

/** Who produced an input (§4.2). */
export enum InputRole {
  User = "user",
  System = "system",
  External = "external",
}

/** Conditional payload of input (§4.2). */
export interface Input {
  content: unknown;
  role: InputRole;
}

/** Conditional payload of pre_model_call and post_model_call (§4.2). */
export interface Model {
  id: string;
  vendor?: string;
  params?: object;
}

/** One message of the model request (§4.2). */
export interface Message {
  role: string;
  content: unknown;
}

/** One tool call the model asked for (§4.2). */
export interface ToolCallRequest {
  id?: string;
  name: string;
  args: object;
}

/** Conditional payload of post_model_call (§4.2). */
export interface Response {
  content: unknown;
  tool_calls: ToolCallRequest[];
  finish_reason: string;
}

/** Token usage of a model call (§4.3). */
export interface Usage {
  /** @minimum 0 */
  prompt_tokens?: number;
  /** @minimum 0 */
  completion_tokens?: number;
}

/** Conditional payload of pre_tool_call and post_tool_call (§4.2). */
export interface ToolCall {
  /** @minLength 1 */
  id: string;
  /** @minLength 1 */
  name: string;
  args: object;
  /** @pattern ^sha256:[0-9a-f]{64}$ */
  content_hash?: string;
}

/** Conditional payload of post_tool_call (§4.2). */
export interface ToolResult {
  value: unknown;
  is_error: boolean;
  /**
   * @TJS-type number
   * @minimum 0
   */
  duration_ms?: number;
}

/** One declared tool (§4.3). */
export interface ToolDecl {
  name: string;
  description?: string;
  schema?: object;
}

/** Conditional payload of output (§4.2). */
export interface Output {
  content: unknown;
}

/** Why the agent stopped (§4.2). */
export enum SummaryReason {
  Completed = "completed",
  Error = "error",
  Cancelled = "cancelled",
}

/** Conditional payload of agent_shutdown (§4.2). */
export interface Summary {
  reason: SummaryReason;
  /** @minimum 0 */
  tool_calls?: number;
  /** @minimum 0 */
  errors?: number;
  /**
   * @TJS-type number
   * @minimum 0
   */
  duration_seconds?: number;
}

/** Who acts (§4.5). */
export enum ActorKind {
  Human = "human",
  Service = "service",
  Agent = "agent",
}

/**
 * Members present at every point (§4.1), the conditional payloads (§4.2) and
 * the well-known optional members (§4.3, §4.5). Each variant below fixes
 * interception_point and makes that point's payload required.
 */
interface ContextBase {
  /** @pattern ^agent-hooks/\d+\.\d+$ */
  spec: string;
  interception_point: InterceptionPoint;
  /** @format date-time */
  timestamp: string;
  /** @minimum 0 */
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
  target: unknown;
  agent_init?: AgentInit;
  input?: Input;
  model?: Model;
  messages?: Message[];
  request_id?: string;
  response?: Response;
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
    kind?: ActorKind;
  };
  budgets?: {
    /** @TJS-type number */
    tool_call_count?: number;
    /** @TJS-type number */
    token_count?: number;
    /** @TJS-type number */
    elapsed_seconds?: number;
    /** @TJS-type number */
    cost_usd?: number;
  };
  extensions?: Extensions;
}

/** The context at agent_startup: agent_init is required (§4.2). */
export interface AgentStartupContext extends ContextBase {
  interception_point: InterceptionPoint.AgentStartup;
  agent_init: AgentInit;
}

/** The context at input: input is required (§4.2). */
export interface InputContext extends ContextBase {
  interception_point: InterceptionPoint.Input;
  input: Input;
}

/** The context at pre_model_call: model and messages are required (§4.2). */
export interface PreModelCallContext extends ContextBase {
  interception_point: InterceptionPoint.PreModelCall;
  model: Model;
  messages: Message[];
}

/** The context at post_model_call: model and response are required (§4.2). */
export interface PostModelCallContext extends ContextBase {
  interception_point: InterceptionPoint.PostModelCall;
  model: Model;
  response: Response;
}

/** The context at pre_tool_call: tool_call is required (§4.2). */
export interface PreToolCallContext extends ContextBase {
  interception_point: InterceptionPoint.PreToolCall;
  tool_call: ToolCall;
}

/** The context at post_tool_call: tool_call and tool_result are required (§4.2). */
export interface PostToolCallContext extends ContextBase {
  interception_point: InterceptionPoint.PostToolCall;
  tool_call: ToolCall;
  tool_result: ToolResult;
}

/** The context at output: output is required (§4.2). */
export interface OutputContext extends ContextBase {
  interception_point: InterceptionPoint.Output;
  output: Output;
}

/** The context at agent_shutdown: summary is required (§4.2). */
export interface AgentShutdownContext extends ContextBase {
  interception_point: InterceptionPoint.AgentShutdown;
  summary: Summary;
}

/**
 * Payload a host constructs at each interception point (AGENT-HOOKS-0.1 §4).
 * required fields are always present; conditional fields are required per
 * interception_point; optional fields are well-known; namespaced extensions live
 * under extensions.
 * @title Agent Hooks — agent context
 */
export type AgentContext =
  | AgentStartupContext
  | InputContext
  | PreModelCallContext
  | PostModelCallContext
  | PreToolCallContext
  | PostToolCallContext
  | OutputContext
  | AgentShutdownContext;
