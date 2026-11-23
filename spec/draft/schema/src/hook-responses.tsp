// Copyright (c) Microsoft. All rights reserved.

namespace AgentHooks;

/** Replaces the complete input payload. */
model InputHookTransform {
  ...Record<never>;
  input: InputRequest.input;
}

/** Replaces the complete model-message array. */
model PreModelHookTransform {
  ...Record<never>;
  messages: PreModelCallRequest.messages;
}

/** Replaces the complete model response payload. */
model PostModelHookTransform {
  ...Record<never>;
  response: PostModelCallRequest.response;
}

/** Replaces the complete tool args for the pre-tool hook. */
model PreToolHookTransform {
  ...Record<never>;
  args: ToolCall.args;
}

/** Replaces only the value of the tool result. */
model PostToolHookTransform {
  ...Record<never>;
  value: ToolResult.value;
}

/** Replaces the complete output payload. */
model OutputHookTransform {
  ...Record<never>;
  output: OutputRequest.output;
}

/** Hook response envelope with a hook-specific verdict. */
model HookResponse<TVerdict> {
  ...Record<never>;
  verdict: TVerdict;
  extensions?: Extensions;
}

// Example: [allow](../examples/AgentStartupHookResponse/allow.json)
// Example: [deny](../examples/AgentStartupHookResponse/deny.json)
// Example: [extensions](../examples/AgentStartupHookResponse/allow-with-extensions.json)
/** agent_startup response: transforms are forbidden. */
model AgentStartupHookResponse is HookResponse<NonTransformVerdict>;

// Example: [allow](../examples/InputHookResponse/allow.json)
// Example: [deny](../examples/InputHookResponse/deny.json)
// Example: [transform](../examples/InputHookResponse/transform.json)
// Example: [extensions](../examples/InputHookResponse/deny-with-extensions.json)
/** input response. */
model InputHookResponse is HookResponse<Verdict<InputHookTransform>>;

// Example: [allow](../examples/PreModelHookResponse/allow.json)
// Example: [deny](../examples/PreModelHookResponse/deny.json)
// Example: [transform](../examples/PreModelHookResponse/transform.json)
/** pre_model_call response. */
model PreModelHookResponse is HookResponse<Verdict<PreModelHookTransform>>;

// Example: [allow](../examples/PostModelHookResponse/allow.json)
// Example: [deny](../examples/PostModelHookResponse/deny.json)
// Example: [transform](../examples/PostModelHookResponse/transform.json)
/** post_model_call response. */
model PostModelHookResponse is HookResponse<Verdict<PostModelHookTransform>>;

// Example: [allow](../examples/PreToolHookResponse/allow.json)
// Example: [deny](../examples/PreToolHookResponse/deny.json)
// Example: [transform](../examples/PreToolHookResponse/transform.json)
/** pre_tool_call response. */
model PreToolHookResponse is HookResponse<Verdict<PreToolHookTransform>>;

// Example: [allow](../examples/PostToolHookResponse/allow.json)
// Example: [deny](../examples/PostToolHookResponse/deny.json)
// Example: [transform](../examples/PostToolHookResponse/transform.json)
/** post_tool_call response. */
model PostToolHookResponse is HookResponse<Verdict<PostToolHookTransform>>;

// Example: [allow](../examples/OutputHookResponse/allow.json)
// Example: [deny](../examples/OutputHookResponse/deny.json)
// Example: [transform](../examples/OutputHookResponse/transform.json)
/** output response. */
model OutputHookResponse is HookResponse<Verdict<OutputHookTransform>>;

// Example: [allow](../examples/AgentShutdownHookResponse/allow.json)
// Example: [deny](../examples/AgentShutdownHookResponse/deny.json)
/** agent_shutdown response: transforms are forbidden. */
model AgentShutdownHookResponse is HookResponse<NonTransformVerdict>;
