// Copyright (c) Microsoft. All rights reserved.

// Hook-specific core responses. These bare verdicts are distinct from the
// generic path/value Verdict and the hosted InterceptorResponse envelope.

import {
  InputRequest,
  OutputRequest,
  PostModelCallRequest,
  PostToolCallRequest,
  PreModelCallRequest,
  PreToolCallRequest,
} from "./agent-context";
import {
  AllowVerdict,
  DenyVerdict,
  TransformVerdictBase,
} from "./verdict";

/**
 * Replaces the complete input payload.
 */
export interface InputHookTransform {
  input: InputRequest["input"];
}

/**
 * Replaces the complete model-message array.
 */
export interface PreModelHookTransform {
  messages: PreModelCallRequest["messages"];
}

/**
 * Replaces the complete model response payload.
 */
export interface PostModelHookTransform {
  response: PostModelCallRequest["response"];
}

/**
 * Replaces the complete tool args for the pre-tool hook.
 */
export interface PreToolHookTransform {
  args: PreToolCallRequest["tool_call"]["args"];
}

/**
 * Replaces only the value of the tool result.
 */
export interface PostToolHookTransform {
  value: PostToolCallRequest["tool_result"]["value"];
}

/**
 * Replaces the complete output payload.
 */
export interface OutputHookTransform {
  output: OutputRequest["output"];
}

/**
 * Typed input transform verdict.
 */
export interface InputTransformVerdict extends TransformVerdictBase<InputHookTransform> {}

/**
 * Typed pre-model transform verdict.
 */
export interface PreModelTransformVerdict extends TransformVerdictBase<PreModelHookTransform> {}

/**
 * Typed post-model transform verdict.
 */
export interface PostModelTransformVerdict extends TransformVerdictBase<PostModelHookTransform> {}

/**
 * Typed pre-tool transform verdict.
 */
export interface PreToolTransformVerdict extends TransformVerdictBase<PreToolHookTransform> {}

/**
 * Typed post-tool transform verdict.
 */
export interface PostToolTransformVerdict extends TransformVerdictBase<PostToolHookTransform> {}

/**
 * Typed output transform verdict.
 */
export interface OutputTransformVerdict extends TransformVerdictBase<OutputHookTransform> {}

/**
 * Bare agent_startup response: transforms are forbidden.
 * @example [allow.json](../examples/AgentStartupHookResponse/allow.json)
 * @example [deny.json](../examples/AgentStartupHookResponse/deny.json)
 */
export type AgentStartupHookResponse = AllowVerdict | DenyVerdict;

/**
 * Bare input response.
 * @example [allow.json](../examples/InputHookResponse/allow.json)
 * @example [deny.json](../examples/InputHookResponse/deny.json)
 * @example [transform.json](../examples/InputHookResponse/transform.json)
 */
export type InputHookResponse =
  | AllowVerdict
  | DenyVerdict
  | InputTransformVerdict;

/**
 * Bare pre_model_call response.
 * @example [allow.json](../examples/PreModelHookResponse/allow.json)
 * @example [deny.json](../examples/PreModelHookResponse/deny.json)
 * @example [transform.json](../examples/PreModelHookResponse/transform.json)
 */
export type PreModelHookResponse =
  | AllowVerdict
  | DenyVerdict
  | PreModelTransformVerdict;

/**
 * Bare post_model_call response.
 * @example [allow.json](../examples/PostModelHookResponse/allow.json)
 * @example [deny.json](../examples/PostModelHookResponse/deny.json)
 * @example [transform.json](../examples/PostModelHookResponse/transform.json)
 */
export type PostModelHookResponse =
  | AllowVerdict
  | DenyVerdict
  | PostModelTransformVerdict;

/**
 * Bare pre_tool_call response.
 * @example [allow.json](../examples/PreToolHookResponse/allow.json)
 * @example [deny.json](../examples/PreToolHookResponse/deny.json)
 * @example [transform.json](../examples/PreToolHookResponse/transform.json)
 */
export type PreToolHookResponse =
  | AllowVerdict
  | DenyVerdict
  | PreToolTransformVerdict;

/**
 * Bare post_tool_call response.
 * @example [allow.json](../examples/PostToolHookResponse/allow.json)
 * @example [deny.json](../examples/PostToolHookResponse/deny.json)
 * @example [transform.json](../examples/PostToolHookResponse/transform.json)
 */
export type PostToolHookResponse =
  | AllowVerdict
  | DenyVerdict
  | PostToolTransformVerdict;

/**
 * Bare output response.
 * @example [allow.json](../examples/OutputHookResponse/allow.json)
 * @example [deny.json](../examples/OutputHookResponse/deny.json)
 * @example [transform.json](../examples/OutputHookResponse/transform.json)
 */
export type OutputHookResponse =
  | AllowVerdict
  | DenyVerdict
  | OutputTransformVerdict;

/**
 * Bare agent_shutdown response: transforms are forbidden.
 * @example [allow.json](../examples/AgentShutdownHookResponse/allow.json)
 * @example [deny.json](../examples/AgentShutdownHookResponse/deny.json)
 */
export type AgentShutdownHookResponse = AllowVerdict | DenyVerdict;
