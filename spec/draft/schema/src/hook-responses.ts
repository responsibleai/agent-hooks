// Copyright (c) Microsoft. All rights reserved.

// Hook-specific core responses. These bare verdicts are distinct from the
// generic path/value Verdict and the hosted InterceptorResponse envelope.

import {
  Input,
  Message,
  Output,
  Response,
  ToolCall,
  ToolResult,
} from "./agent-context";
import { Decision, VerdictBase } from "./verdict";

/**
 * Common allow response for every hook.
 */
export interface HookAllowVerdict extends VerdictBase {
  decision: Decision.Allow;
}

/**
 * Common deny response for every hook.
 */
export interface HookDenyVerdict extends VerdictBase {
  decision: Decision.Deny;
  approval?: object;
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
  messages: Message[];
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
  args: ToolCall["args"];
}

/**
 * Replaces only the value of the tool result.
 */
export interface PostToolHookTransform {
  value: ToolResult["value"];
}

/**
 * Replaces the complete output payload.
 */
export interface OutputHookTransform {
  output: Output;
}

/**
 * Typed input transform verdict.
 */
export interface InputTransformVerdict extends VerdictBase {
  decision: Decision.Transform;
  transform: InputHookTransform;
}

/**
 * Typed pre-model transform verdict.
 */
export interface PreModelTransformVerdict extends VerdictBase {
  decision: Decision.Transform;
  transform: PreModelHookTransform;
}

/**
 * Typed post-model transform verdict.
 */
export interface PostModelTransformVerdict extends VerdictBase {
  decision: Decision.Transform;
  transform: PostModelHookTransform;
}

/**
 * Typed pre-tool transform verdict.
 */
export interface PreToolTransformVerdict extends VerdictBase {
  decision: Decision.Transform;
  transform: PreToolHookTransform;
}

/**
 * Typed post-tool transform verdict.
 */
export interface PostToolTransformVerdict extends VerdictBase {
  decision: Decision.Transform;
  transform: PostToolHookTransform;
}

/**
 * Typed output transform verdict.
 */
export interface OutputTransformVerdict extends VerdictBase {
  decision: Decision.Transform;
  transform: OutputHookTransform;
}

/**
 * Bare agent_startup response: transforms are forbidden.
 * @example [allow.json](../examples/AgentStartupHookResponse/allow.json)
 * @example [deny.json](../examples/AgentStartupHookResponse/deny.json)
 */
export type AgentStartupHookResponse = HookAllowVerdict | HookDenyVerdict;

/**
 * Bare input response.
 * @example [allow.json](../examples/InputHookResponse/allow.json)
 * @example [deny.json](../examples/InputHookResponse/deny.json)
 * @example [transform.json](../examples/InputHookResponse/transform.json)
 */
export type InputHookResponse =
  | HookAllowVerdict
  | HookDenyVerdict
  | InputTransformVerdict;

/**
 * Bare pre_model_call response.
 * @example [allow.json](../examples/PreModelHookResponse/allow.json)
 * @example [deny.json](../examples/PreModelHookResponse/deny.json)
 * @example [transform.json](../examples/PreModelHookResponse/transform.json)
 */
export type PreModelHookResponse =
  | HookAllowVerdict
  | HookDenyVerdict
  | PreModelTransformVerdict;

/**
 * Bare post_model_call response.
 * @example [allow.json](../examples/PostModelHookResponse/allow.json)
 * @example [deny.json](../examples/PostModelHookResponse/deny.json)
 * @example [transform.json](../examples/PostModelHookResponse/transform.json)
 */
export type PostModelHookResponse =
  | HookAllowVerdict
  | HookDenyVerdict
  | PostModelTransformVerdict;

/**
 * Bare pre_tool_call response.
 * @example [allow.json](../examples/PreToolHookResponse/allow.json)
 * @example [deny.json](../examples/PreToolHookResponse/deny.json)
 * @example [transform.json](../examples/PreToolHookResponse/transform.json)
 */
export type PreToolHookResponse =
  | HookAllowVerdict
  | HookDenyVerdict
  | PreToolTransformVerdict;

/**
 * Bare post_tool_call response.
 * @example [allow.json](../examples/PostToolHookResponse/allow.json)
 * @example [deny.json](../examples/PostToolHookResponse/deny.json)
 * @example [transform.json](../examples/PostToolHookResponse/transform.json)
 */
export type PostToolHookResponse =
  | HookAllowVerdict
  | HookDenyVerdict
  | PostToolTransformVerdict;

/**
 * Bare output response.
 * @example [allow.json](../examples/OutputHookResponse/allow.json)
 * @example [deny.json](../examples/OutputHookResponse/deny.json)
 * @example [transform.json](../examples/OutputHookResponse/transform.json)
 */
export type OutputHookResponse =
  | HookAllowVerdict
  | HookDenyVerdict
  | OutputTransformVerdict;

/**
 * Bare agent_shutdown response: transforms are forbidden.
 * @example [allow.json](../examples/AgentShutdownHookResponse/allow.json)
 * @example [deny.json](../examples/AgentShutdownHookResponse/deny.json)
 */
export type AgentShutdownHookResponse = HookAllowVerdict | HookDenyVerdict;
