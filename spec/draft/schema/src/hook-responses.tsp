// Copyright (c) Microsoft. All rights reserved.

using TypeSpec.JsonSchema;
namespace AgentHooks;

/** Replaces the complete input payload. */
@extension("additionalProperties", false)
model InputHookTransform {
  input: InputRequest.input;
}

/** Replaces the complete model-message array. */
@extension("additionalProperties", false)
model PreModelHookTransform {
  messages: PreModelCallRequest.messages;
}

/** Replaces the complete model response payload. */
@extension("additionalProperties", false)
model PostModelHookTransform {
  response: PostModelCallRequest.response;
}

/** Replaces the complete tool args for the pre-tool hook. */
@extension("additionalProperties", false)
model PreToolHookTransform {
  args: ToolCall.args;
}

/** Replaces only the value of the tool result. */
@extension("additionalProperties", false)
model PostToolHookTransform {
  value: ToolResult.value;
}

/** Replaces the complete output payload. */
@extension("additionalProperties", false)
model OutputHookTransform {
  output: OutputRequest.output;
}

/** Closed envelope; only the nested verdict participates in enforcement. */
@extension("additionalProperties", false)
model HookResponse<TVerdict> {
  verdict: TVerdict;
  extensions?: Extensions;
}

/**
 * Startup responses forbid transforms.
 * [allow](../examples/AgentStartupHookResponse/allow.json)
 * [deny](../examples/AgentStartupHookResponse/deny.json)
 * [extensions](../examples/AgentStartupHookResponse/allow-with-extensions.json)
 */
model AgentStartupHookResponse is HookResponse<NonTransformVerdict>;

/**
 * Input responses.
 * [allow](../examples/InputHookResponse/allow.json)
 * [deny](../examples/InputHookResponse/deny.json)
 * [transform](../examples/InputHookResponse/transform.json)
 * [extensions](../examples/InputHookResponse/deny-with-extensions.json)
 */
model InputHookResponse is HookResponse<Verdict<InputHookTransform>>;

/**
 * Pre-model responses.
 * [allow](../examples/PreModelHookResponse/allow.json)
 * [deny](../examples/PreModelHookResponse/deny.json)
 * [transform](../examples/PreModelHookResponse/transform.json)
 */
model PreModelHookResponse is HookResponse<Verdict<PreModelHookTransform>>;

/**
 * Post-model responses.
 * [allow](../examples/PostModelHookResponse/allow.json)
 * [deny](../examples/PostModelHookResponse/deny.json)
 * [transform](../examples/PostModelHookResponse/transform.json)
 */
model PostModelHookResponse is HookResponse<Verdict<PostModelHookTransform>>;

/**
 * Pre-tool responses.
 * [allow](../examples/PreToolHookResponse/allow.json)
 * [deny](../examples/PreToolHookResponse/deny.json)
 * [transform](../examples/PreToolHookResponse/transform.json)
 */
model PreToolHookResponse is HookResponse<Verdict<PreToolHookTransform>>;

/**
 * Post-tool responses.
 * [allow](../examples/PostToolHookResponse/allow.json)
 * [deny](../examples/PostToolHookResponse/deny.json)
 * [transform](../examples/PostToolHookResponse/transform.json)
 */
model PostToolHookResponse is HookResponse<Verdict<PostToolHookTransform>>;

/**
 * Output responses.
 * [allow](../examples/OutputHookResponse/allow.json)
 * [deny](../examples/OutputHookResponse/deny.json)
 * [transform](../examples/OutputHookResponse/transform.json)
 */
model OutputHookResponse is HookResponse<Verdict<OutputHookTransform>>;

/**
 * Shutdown responses forbid transforms.
 * [allow](../examples/AgentShutdownHookResponse/allow.json)
 * [deny](../examples/AgentShutdownHookResponse/deny.json)
 */
model AgentShutdownHookResponse is HookResponse<NonTransformVerdict>;
