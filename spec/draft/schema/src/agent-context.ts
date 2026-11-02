// Copyright (c) Microsoft. All rights reserved.

// agent-context.schema.json and its per-point variants (§4). The master is
// the union of one variant per interception point; each variant requires that
// point's payload. scripts/generate-schemas.ts derives the closed per-point
// files under generated/strict-contexts/ from the same variants.

import { Extensions } from "./common";
import { InterceptionPoint } from "./interception-point";

/** JSON data carried by hook payloads. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

/** A JSON object with arbitrary JSON-valued members. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * Shared metadata present at every interception point.
 * @additionalProperties false
 */
export interface AgentMetadata {
  /** @minLength 1 */
  id: string;
  /** @pattern ^[a-z0-9_-]+$ */
  framework: string;
}

/**
 * Shared session identity present at every interception point.
 * @additionalProperties false
 */
export interface SessionMetadata {
  /** @minLength 1 */
  id: string;
}

/**
 * Conditional payload of agent_startup (§4.2).
 * @additionalProperties false
 */
export interface AgentInit {
  tools_registered: string[];
}

/** Who produced an input (§4.2). */
export enum InputRole {
  User = "user",
  System = "system",
  External = "external",
}

/**
 * Conditional payload of input (§4.2).
 * @additionalProperties false
 */
export interface Input {
  content: JsonValue;
  role: InputRole;
}

/**
 * Conditional payload of pre_model_call and post_model_call (§4.2).
 * @additionalProperties false
 */
export interface Model {
  id: string;
}

/**
 * One message of the model request (§4.2).
 * @additionalProperties false
 */
export interface Message {
  role: string;
  content: JsonValue;
}

/**
 * One tool call the model asked for (§4.2).
 * @additionalProperties false
 */
export interface ToolCallRequest {
  name: string;
  args: JsonObject;
}

/**
 * Conditional payload of post_model_call (§4.2).
 * @additionalProperties false
 */
export interface Response {
  content: JsonValue;
  tool_calls: ToolCallRequest[];
  finish_reason: string;
}

/**
 * Conditional payload of pre_tool_call and post_tool_call (§4.2).
 * @additionalProperties false
 */
export interface ToolCall {
  /** @minLength 1 */
  id: string;
  /** @minLength 1 */
  name: string;
  args: JsonObject;
}

/**
 * Conditional payload of post_tool_call (§4.2).
 * @additionalProperties false
 */
export interface ToolResult {
  value: JsonValue;
  is_error: boolean;
}

/**
 * Conditional payload of output (§4.2).
 * @additionalProperties false
 */
export interface Output {
  content: JsonValue;
}

/** Why the agent stopped (§4.2). */
export enum SummaryReason {
  Completed = "completed",
  Error = "error",
  Cancelled = "cancelled",
}

/**
 * Conditional payload of agent_shutdown (§4.2).
 * @additionalProperties false
 */
export interface Summary {
  reason: SummaryReason;
}

/**
 * Members common to every hook-specific context. Optional provider data
 * remains namespaced under extensions; all other omitted members are absent.
 */
interface ContextBase {
  /** @pattern ^agent-hooks/\d+\.\d+$ */
  spec: string;
  /** @format date-time */
  timestamp: string;
  /** @minimum 0 */
  sequence: number;
  agent: AgentMetadata;
  session: SessionMetadata;
  extensions?: Extensions;
}

/**
 * The context at agent_startup: agent_init is required (§4.2).
 * @additionalProperties false
 * @example [agent-startup.json](../examples/AgentContext/agent-startup.json)
 */
export interface AgentStartupContext extends ContextBase {
  interception_point: InterceptionPoint.AgentStartup;
  agent_init: AgentInit;
}

/**
 * The context at input: input is required (§4.2).
 * @additionalProperties false
 * @example [input.json](../examples/AgentContext/input.json)
 */
export interface InputContext extends ContextBase {
  interception_point: InterceptionPoint.Input;
  input: Input;
}

/**
 * The context at pre_model_call: model and messages are required (§4.2).
 * @additionalProperties false
 * @example [pre-model-call.json](../examples/AgentContext/pre-model-call.json)
 * @example [pre-model-call-with-extensions.json](../examples/AgentContext/pre-model-call-with-extensions.json)
 */
export interface PreModelCallContext extends ContextBase {
  interception_point: InterceptionPoint.PreModelCall;
  model: Model;
  messages: Message[];
}

/**
 * The context at post_model_call: model and response are required (§4.2).
 * @additionalProperties false
 * @example [post-model-call.json](../examples/AgentContext/post-model-call.json)
 * @example [post-model-call-with-extensions.json](../examples/AgentContext/post-model-call-with-extensions.json)
 */
export interface PostModelCallContext extends ContextBase {
  interception_point: InterceptionPoint.PostModelCall;
  model: Model;
  response: Response;
}

/**
 * The context at pre_tool_call: tool_call is required (§4.2).
 * @additionalProperties false
 * @example [pre-tool-call.json](../examples/AgentContext/pre-tool-call.json)
 */
export interface PreToolCallContext extends ContextBase {
  interception_point: InterceptionPoint.PreToolCall;
  tool_call: ToolCall;
}

/**
 * The context at post_tool_call: tool_call and tool_result are required (§4.2).
 * @additionalProperties false
 * @example [post-tool-call.json](../examples/AgentContext/post-tool-call.json)
 */
export interface PostToolCallContext extends ContextBase {
  interception_point: InterceptionPoint.PostToolCall;
  tool_call: ToolCall;
  tool_result: ToolResult;
}

/**
 * The context at output: output is required (§4.2).
 * @additionalProperties false
 * @example [output.json](../examples/AgentContext/output.json)
 * @example [output-with-extensions.json](../examples/AgentContext/output-with-extensions.json)
 */
export interface OutputContext extends ContextBase {
  interception_point: InterceptionPoint.Output;
  output: Output;
}

/**
 * The context at agent_shutdown: summary is required (§4.2).
 * @additionalProperties false
 * @example [agent-shutdown.json](../examples/AgentContext/agent-shutdown.json)
 */
export interface AgentShutdownContext extends ContextBase {
  interception_point: InterceptionPoint.AgentShutdown;
  summary: Summary;
}

/**
 * Payload a host constructs at each interception point (AGENT-HOOKS-0.1 §4).
 * Each variant has only shared required metadata, its discriminator, its
 * required hook payload, and the optional namespaced extensions object.
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
