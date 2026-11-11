// Copyright (c) Microsoft. All rights reserved.

// Hook response envelopes specialize the shared verdict's transform payload.

import {
  AgentShutdownRequest,
  AgentStartupRequest,
  InputRequest,
  OutputRequest,
  PostModelCallRequest,
  PostToolCallRequest,
  PreModelCallRequest,
  PreToolCallRequest,
} from "./agent-context";
import { Extensions } from "./common";
import { NonTransformVerdict, Verdict } from "./verdict";

/**
 * Replaces the complete input payload.
 * @additionalProperties false
 */
export interface InputHookTransform {
  input: InputRequest["input"];
}

/**
 * Replaces the complete model-message array.
 * @additionalProperties false
 */
export interface PreModelHookTransform {
  messages: PreModelCallRequest["messages"];
}

/**
 * Replaces the complete model response payload.
 * @additionalProperties false
 */
export interface PostModelHookTransform {
  response: PostModelCallRequest["response"];
}

/**
 * Replaces the complete tool args for the pre-tool hook.
 * @additionalProperties false
 */
export interface PreToolHookTransform {
  args: PreToolCallRequest["tool_call"]["args"];
}

/**
 * Replaces only the value of the tool result.
 * @additionalProperties false
 */
export interface PostToolHookTransform {
  value: PostToolCallRequest["tool_result"]["value"];
}

/**
 * Replaces the complete output payload.
 * @additionalProperties false
 */
export interface OutputHookTransform {
  output: OutputRequest["output"];
}

/**
 * Hook response envelope with a hook-specific verdict.
 * @additionalProperties false
 */
export interface HookResponse<TVerdict> {
  verdict: TVerdict;
  extensions?: Extensions;
}

/** Responses for hooks that forbid transforms. */
export type HooksResponseNoTransform = HookResponse<NonTransformVerdict>;

/** Responses for hooks that allow a hook-specific transform. */
export type HooksResponseTransformSupported<TTransform> = HookResponse<Verdict<TTransform>>;

/**
 * agent_startup response: transforms are forbidden.
 * @example [allow.json](../examples/AgentStartupHookResponse/allow.json)
 * @example [deny.json](../examples/AgentStartupHookResponse/deny.json)
 * @example [allow-with-extensions.json](../examples/AgentStartupHookResponse/allow-with-extensions.json)
 */
export type AgentStartupHookResponse = HooksResponseNoTransform;

/**
 * input response.
 * @example [allow.json](../examples/InputHookResponse/allow.json)
 * @example [deny.json](../examples/InputHookResponse/deny.json)
 * @example [transform.json](../examples/InputHookResponse/transform.json)
 * @example [deny-with-extensions.json](../examples/InputHookResponse/deny-with-extensions.json)
 */
export type InputHookResponse = HooksResponseTransformSupported<InputHookTransform>;

/**
 * pre_model_call response.
 * @example [allow.json](../examples/PreModelHookResponse/allow.json)
 * @example [deny.json](../examples/PreModelHookResponse/deny.json)
 * @example [transform.json](../examples/PreModelHookResponse/transform.json)
 */
export type PreModelHookResponse = HooksResponseTransformSupported<PreModelHookTransform>;

/**
 * post_model_call response.
 * @example [allow.json](../examples/PostModelHookResponse/allow.json)
 * @example [deny.json](../examples/PostModelHookResponse/deny.json)
 * @example [transform.json](../examples/PostModelHookResponse/transform.json)
 */
export type PostModelHookResponse = HooksResponseTransformSupported<PostModelHookTransform>;

/**
 * pre_tool_call response.
 * @example [allow.json](../examples/PreToolHookResponse/allow.json)
 * @example [deny.json](../examples/PreToolHookResponse/deny.json)
 * @example [transform.json](../examples/PreToolHookResponse/transform.json)
 */
export type PreToolHookResponse = HooksResponseTransformSupported<PreToolHookTransform>;

/**
 * post_tool_call response.
 * @example [allow.json](../examples/PostToolHookResponse/allow.json)
 * @example [deny.json](../examples/PostToolHookResponse/deny.json)
 * @example [transform.json](../examples/PostToolHookResponse/transform.json)
 */
export type PostToolHookResponse = HooksResponseTransformSupported<PostToolHookTransform>;

/**
 * output response.
 * @example [allow.json](../examples/OutputHookResponse/allow.json)
 * @example [deny.json](../examples/OutputHookResponse/deny.json)
 * @example [transform.json](../examples/OutputHookResponse/transform.json)
 */
export type OutputHookResponse = HooksResponseTransformSupported<OutputHookTransform>;

/**
 * agent_shutdown response: transforms are forbidden.
 * @example [allow.json](../examples/AgentShutdownHookResponse/allow.json)
 * @example [deny.json](../examples/AgentShutdownHookResponse/deny.json)
 */
export type AgentShutdownHookResponse = HooksResponseNoTransform;

/** Synchronous handler for one hook request and its response contract. */
export type HookHandler<TRequest, TResponse> = (request: TRequest) => TResponse;

export type AgentStartupHookHandler = HookHandler<AgentStartupRequest, AgentStartupHookResponse>;
export type InputHookHandler = HookHandler<InputRequest, InputHookResponse>;
export type PreModelHookHandler = HookHandler<PreModelCallRequest, PreModelHookResponse>;
export type PostModelHookHandler = HookHandler<PostModelCallRequest, PostModelHookResponse>;
export type PreToolHookHandler = HookHandler<PreToolCallRequest, PreToolHookResponse>;
export type PostToolHookHandler = HookHandler<PostToolCallRequest, PostToolHookResponse>;
export type OutputHookHandler = HookHandler<OutputRequest, OutputHookResponse>;
export type AgentShutdownHookHandler = HookHandler<AgentShutdownRequest, AgentShutdownHookResponse>;
