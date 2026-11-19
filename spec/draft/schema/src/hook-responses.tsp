// Copyright (c) Microsoft. All rights reserved.

using TypeSpec.JsonSchema;
using AgentHooks.Docs;
namespace AgentHooks;

/** Replaces the complete input payload. */
@extension("additionalProperties", false)
@category(Categories.Responses)
model InputHookTransform {
  input: InputRequest.input;
}

/** Replaces the complete model-message array. */
@extension("additionalProperties", false)
@category(Categories.Responses)
model PreModelHookTransform {
  messages: PreModelCallRequest.messages;
}

/** Replaces the complete model response payload. */
@extension("additionalProperties", false)
@category(Categories.Responses)
model PostModelHookTransform {
  response: PostModelCallRequest.response;
}

/** Replaces the complete tool args for the pre-tool hook. */
@extension("additionalProperties", false)
@category(Categories.Responses)
model PreToolHookTransform {
  args: ToolCall.args;
}

/** Replaces only the value of the tool result. */
@extension("additionalProperties", false)
@category(Categories.Responses)
model PostToolHookTransform {
  value: ToolResult.value;
}

/** Replaces the complete output payload. */
@extension("additionalProperties", false)
@category(Categories.Responses)
model OutputHookTransform {
  output: OutputRequest.output;
}

/** Hook response envelope with a hook-specific verdict. */
@extension("additionalProperties", false)
@category(Categories.Responses)
model HookResponse<TVerdict> {
  verdict: TVerdict;
  extensions?: Extensions;
}

// Example: [allow](../examples/AgentStartupHookResponse/allow.json)
// Example: [deny](../examples/AgentStartupHookResponse/deny.json)
// Example: [extensions](../examples/AgentStartupHookResponse/allow-with-extensions.json)
/** agent_startup response: transforms are forbidden. */
@category(Categories.Responses)
model AgentStartupHookResponse is HookResponse<NonTransformVerdict>;

// Example: [allow](../examples/InputHookResponse/allow.json)
// Example: [deny](../examples/InputHookResponse/deny.json)
// Example: [transform](../examples/InputHookResponse/transform.json)
// Example: [extensions](../examples/InputHookResponse/deny-with-extensions.json)
/** input response. */
@category(Categories.Responses)
model InputHookResponse is HookResponse<Verdict<InputHookTransform>>;

// Example: [allow](../examples/PreModelHookResponse/allow.json)
// Example: [deny](../examples/PreModelHookResponse/deny.json)
// Example: [transform](../examples/PreModelHookResponse/transform.json)
/** pre_model_call response. */
@category(Categories.Responses)
model PreModelHookResponse is HookResponse<Verdict<PreModelHookTransform>>;

// Example: [allow](../examples/PostModelHookResponse/allow.json)
// Example: [deny](../examples/PostModelHookResponse/deny.json)
// Example: [transform](../examples/PostModelHookResponse/transform.json)
/** post_model_call response. */
@category(Categories.Responses)
model PostModelHookResponse is HookResponse<Verdict<PostModelHookTransform>>;

// Example: [allow](../examples/PreToolHookResponse/allow.json)
// Example: [deny](../examples/PreToolHookResponse/deny.json)
// Example: [transform](../examples/PreToolHookResponse/transform.json)
/** pre_tool_call response. */
@category(Categories.Responses)
model PreToolHookResponse is HookResponse<Verdict<PreToolHookTransform>>;

// Example: [allow](../examples/PostToolHookResponse/allow.json)
// Example: [deny](../examples/PostToolHookResponse/deny.json)
// Example: [transform](../examples/PostToolHookResponse/transform.json)
/** post_tool_call response. */
@category(Categories.Responses)
model PostToolHookResponse is HookResponse<Verdict<PostToolHookTransform>>;

// Example: [allow](../examples/OutputHookResponse/allow.json)
// Example: [deny](../examples/OutputHookResponse/deny.json)
// Example: [transform](../examples/OutputHookResponse/transform.json)
/** output response. */
@category(Categories.Responses)
model OutputHookResponse is HookResponse<Verdict<OutputHookTransform>>;

// Example: [allow](../examples/AgentShutdownHookResponse/allow.json)
// Example: [deny](../examples/AgentShutdownHookResponse/deny.json)
/** agent_shutdown response: transforms are forbidden. */
@category(Categories.Responses)
model AgentShutdownHookResponse is HookResponse<NonTransformVerdict>;
