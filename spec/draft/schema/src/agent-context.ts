// Copyright (c) Microsoft. All rights reserved.

// agent-context.schema.json and its per-point variants (§4). The master is
// the union of one variant per interception point; each variant requires that
// point's payload. scripts/generate-schemas.ts derives the closed per-point
// files under generated/strict-contexts/ from the same variants.

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

/**
 * Conditional payload of agent_shutdown (§4.2).
 */
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
 * Shared metadata present at every point, plus namespaced extensions.
 */
interface ContextMetadata {
  /** @pattern ^agent-hooks/\d+\.\d+$ */
  spec: string;
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
  extensions?: Extensions;
}

export type HookInterceptionPoint = InterceptionPoint;

export interface HooksRequest extends ContextMetadata {
  interception_point: HookInterceptionPoint;
  [extension: string]: unknown;
}

/**
 * The context at agent_startup: agent_init is required (§4.2).
 * @example [agent-startup.json](../examples/AgentContext/agent-startup.json)
 */
export interface AgentStartupContext extends HooksRequest {
  interception_point: InterceptionPoint.AgentStartup;
  agent_init: AgentInit;
}

/**
 * The context at input: input is required (§4.2).
 * @example [input.json](../examples/AgentContext/input.json)
 */
export interface InputContext extends HooksRequest {
  interception_point: InterceptionPoint.Input;
  input: Input;
}

/**
 * The context at pre_model_call: model and messages are required (§4.2).
 * @example [pre-model-call.json](../examples/AgentContext/pre-model-call.json)
 * @example [pre-model-call-with-model-metadata.json](../examples/AgentContext/pre-model-call-with-model-metadata.json)
 */
export interface PreModelCallContext extends HooksRequest {
  interception_point: InterceptionPoint.PreModelCall;
  model: Model;
  messages: Message[];
}

/**
 * The context at post_model_call: model and response are required (§4.2).
 * @example [post-model-call.json](../examples/AgentContext/post-model-call.json)
 * @example [post-model-call-with-optional-tool-call-id.json](../examples/AgentContext/post-model-call-with-optional-tool-call-id.json)
 */
export interface PostModelCallContext extends HooksRequest {
  interception_point: InterceptionPoint.PostModelCall;
  model: Model;
  response: Response;
}

/**
 * The context at pre_tool_call: tool_call is required (§4.2).
 * @example [pre-tool-call.json](../examples/AgentContext/pre-tool-call.json)
 */
export interface PreToolCallContext extends HooksRequest {
  interception_point: InterceptionPoint.PreToolCall;
  tool_call: ToolCall;
}

/**
 * The context at post_tool_call: tool_call and tool_result are required (§4.2).
 * @example [post-tool-call.json](../examples/AgentContext/post-tool-call.json)
 */
export interface PostToolCallContext extends HooksRequest {
  interception_point: InterceptionPoint.PostToolCall;
  tool_call: ToolCall;
  tool_result: ToolResult;
}

/**
 * The context at output: output is required (§4.2).
 * @example [output.json](../examples/AgentContext/output.json)
 * @example [output-with-extensions.json](../examples/AgentContext/output-with-extensions.json)
 */
export interface OutputContext extends HooksRequest {
  interception_point: InterceptionPoint.Output;
  output: Output;
}

/**
 * The context at agent_shutdown: summary is required (§4.2).
 * @example [agent-shutdown.json](../examples/AgentContext/agent-shutdown.json)
 */
export interface AgentShutdownContext extends HooksRequest {
  interception_point: InterceptionPoint.AgentShutdown;
  summary: Summary;
}

/**
 * Payload a host constructs at each interception point (AGENT-HOOKS-0.1 §4).
 * Each variant requires its discriminator and own hook payload, with shared
 * metadata and optional namespaced extensions.
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
