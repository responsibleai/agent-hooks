// Copyright (c) Microsoft. All rights reserved.

// interceptor-response.schema.json: hook-specific response envelopes (§5.5).

import { Extensions } from "./common";
import {
  AgentShutdownHookResponse,
  AgentStartupHookResponse,
  InputHookResponse,
  OutputHookResponse,
  PostModelHookResponse,
  PostToolHookResponse,
  PreModelHookResponse,
  PreToolHookResponse,
} from "./hook-responses";

/**
 * The envelope form: a hook-specific response plus transport metadata.
 * @additionalProperties false
 */
export interface ResponseEnvelope<TResponse> {
  verdict: TResponse;
  /**
   * Opaque namespaced transport metadata (§4.6), including provider receipts
   * under extensions.<provider>.receipt. Canonical extensions are bounded at
   * 65536 bytes (§5.5).
   */
  extensions?: Extensions;
}

/** Bare or enveloped response for one hook. */
export type InterceptorResponse<TResponse> = TResponse | ResponseEnvelope<TResponse>;

/**
 * The hosted response for agent_startup. Transforms are forbidden.
 * @example [allow envelope](../examples/InterceptorResponse/agent-startup-allow-envelope.json)
 */
export type AgentStartupInterceptorResponse = InterceptorResponse<AgentStartupHookResponse>;

/**
 * The hosted response for input.
 * @example [deny envelope](../examples/InterceptorResponse/input-deny-envelope.json)
 */
export type InputInterceptorResponse = InterceptorResponse<InputHookResponse>;

/** The hosted response for pre_model_call. */
export type PreModelInterceptorResponse = InterceptorResponse<PreModelHookResponse>;

/** The hosted response for post_model_call. */
export type PostModelInterceptorResponse = InterceptorResponse<PostModelHookResponse>;

/**
 * The hosted response for pre_tool_call.
 * @example [transform envelope](../examples/InterceptorResponse/pre-tool-transform-envelope.json)
 */
export type PreToolInterceptorResponse = InterceptorResponse<PreToolHookResponse>;

/** The hosted response for post_tool_call. */
export type PostToolInterceptorResponse = InterceptorResponse<PostToolHookResponse>;

/** The hosted response for output. */
export type OutputInterceptorResponse = InterceptorResponse<OutputHookResponse>;

/** The hosted response for agent_shutdown. Transforms are forbidden. */
export type AgentShutdownInterceptorResponse = InterceptorResponse<AgentShutdownHookResponse>;
