// Copyright (c) Microsoft. All rights reserved.

// Hook response aliases specialize the shared verdict's transform payload.

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

/** Shared transport metadata on a hook response, separate from its verdict. */
export interface HooksResponseMetadata {
  extensions?: Extensions;
}

/** Hook-specific verdict choices with optional transport metadata. */
export type HooksResponse<TTransform> = Verdict<TTransform> & HooksResponseMetadata;

/** Lifecycle response metadata without enabling transforms. */
export type NonTransformHookResponse = NonTransformVerdict & HooksResponseMetadata;

/**
 * agent_startup response: transforms are forbidden.
 * @example [allow.json](../examples/AgentStartupHookResponse/allow.json)
 * @example [deny.json](../examples/AgentStartupHookResponse/deny.json)
 * @example [allow-with-extensions.json](../examples/AgentStartupHookResponse/allow-with-extensions.json)
 */
export type AgentStartupHookResponse = NonTransformHookResponse;

/**
 * input response.
 * @example [allow.json](../examples/InputHookResponse/allow.json)
 * @example [deny.json](../examples/InputHookResponse/deny.json)
 * @example [transform.json](../examples/InputHookResponse/transform.json)
 * @example [deny-with-extensions.json](../examples/InputHookResponse/deny-with-extensions.json)
 */
export type InputHookResponse = HooksResponse<InputHookTransform>;

/**
 * pre_model_call response.
 * @example [allow.json](../examples/PreModelHookResponse/allow.json)
 * @example [deny.json](../examples/PreModelHookResponse/deny.json)
 * @example [transform.json](../examples/PreModelHookResponse/transform.json)
 */
export type PreModelHookResponse = HooksResponse<PreModelHookTransform>;

/**
 * post_model_call response.
 * @example [allow.json](../examples/PostModelHookResponse/allow.json)
 * @example [deny.json](../examples/PostModelHookResponse/deny.json)
 * @example [transform.json](../examples/PostModelHookResponse/transform.json)
 */
export type PostModelHookResponse = HooksResponse<PostModelHookTransform>;

/**
 * pre_tool_call response.
 * @example [allow.json](../examples/PreToolHookResponse/allow.json)
 * @example [deny.json](../examples/PreToolHookResponse/deny.json)
 * @example [transform.json](../examples/PreToolHookResponse/transform.json)
 * @example [transform-with-extensions.json](../examples/PreToolHookResponse/transform-with-extensions.json)
 */
export type PreToolHookResponse = HooksResponse<PreToolHookTransform>;

/**
 * post_tool_call response.
 * @example [allow.json](../examples/PostToolHookResponse/allow.json)
 * @example [deny.json](../examples/PostToolHookResponse/deny.json)
 * @example [transform.json](../examples/PostToolHookResponse/transform.json)
 */
export type PostToolHookResponse = HooksResponse<PostToolHookTransform>;

/**
 * output response.
 * @example [allow.json](../examples/OutputHookResponse/allow.json)
 * @example [deny.json](../examples/OutputHookResponse/deny.json)
 * @example [transform.json](../examples/OutputHookResponse/transform.json)
 */
export type OutputHookResponse = HooksResponse<OutputHookTransform>;

/**
 * agent_shutdown response: transforms are forbidden.
 * @example [allow.json](../examples/AgentShutdownHookResponse/allow.json)
 * @example [deny.json](../examples/AgentShutdownHookResponse/deny.json)
 */
export type AgentShutdownHookResponse = NonTransformHookResponse;

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
