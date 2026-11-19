// Copyright (c) Microsoft. All rights reserved.

using AgentHooks.Docs;
namespace AgentHooks;

/** Conditional payload of agent_startup (§4.2). */
@category(Categories.Requests)
model AgentInit {
  tools_registered: string[];
}

/** Who produced an input (§4.2). */
@category(Categories.Requests)
enum InputRole {
  User: "user",
  System: "system",
  External: "external",
}

/** Conditional payload of input (§4.2). */
@category(Categories.Requests)
model Input {
  content: unknown;
  role: InputRole;
}

/** Conditional payload of pre_model_call and post_model_call (§4.2). */
@category(Categories.Requests)
model Model {
  id: string;
  vendor?: string;
  params?: JsonObject;
}

/** One message of the model request (§4.2). */
@category(Categories.Requests)
model Message {
  role: string;
  content: unknown;
}

/** One tool call the model asked for (§4.2). */
@category(Categories.Requests)
model ToolCallRequest {
  id?: string;
  name: string;
  args: JsonObject;
}

/** Conditional payload of post_model_call (§4.2). */
@category(Categories.Requests)
model Response {
  content: unknown;
  tool_calls: ToolCallRequest[];
  finish_reason: string;
}

/** Token usage of a model call (§4.3). */
@category(Categories.Requests)
model Usage {
  @minValue(0)
  prompt_tokens?: integer;

  @minValue(0)
  completion_tokens?: integer;
}

/** Conditional payload of pre_tool_call and post_tool_call (§4.2). */
@category(Categories.Requests)
model ToolCall {
  @minLength(1)
  id: string;

  @minLength(1)
  name: string;

  args: JsonObject;

  @pattern("^sha256:[0-9a-f]{64}$")
  content_hash?: string;
}

/** Conditional payload of post_tool_call (§4.2). */
@category(Categories.Requests)
model ToolResult {
  value: unknown;
  is_error: boolean;

  @minValue(0)
  duration_ms?: float64;
}

/** One declared tool (§4.3). */
@category(Categories.Requests)
model ToolDecl {
  name: string;
  description?: string;
  schema?: JsonObject;
}

/** Conditional payload of output (§4.2). */
@category(Categories.Requests)
model Output {
  content: unknown;
}

/** Why the agent stopped (§4.2). */
@category(Categories.Requests)
enum SummaryReason {
  Completed: "completed",
  Error: "error",
  Cancelled: "cancelled",
}

/** Conditional payload of agent_shutdown (§4.2). */
@category(Categories.Requests)
model Summary {
  reason: SummaryReason;

  @minValue(0)
  tool_calls?: integer;

  @minValue(0)
  errors?: integer;

  @minValue(0)
  duration_seconds?: float64;
}

/** Who acts (§4.5). */
@category(Categories.Requests)
enum ActorKind {
  Human: "human",
  Service: "service",
  Agent: "agent",
}

/** Metadata available at every interception point. */
@category(Categories.Requests)
model ContextMetadata {
  /**
   * This version's wire string (§4.1). A released version's contexts
   * carry that version's own string, agent-hooks/<major>.<minor>.
   */
  spec: "agent-hooks/draft";

  @format("date-time")
  timestamp: string;

  @minValue(0)
  sequence: integer;

  agent: {
    @minLength(1)
    id: string;

    @pattern("^[a-z0-9_-]+$")
    framework: string;

    name?: string;
    version?: string;
  };
  session: {
    @minLength(1)
    id: string;

    @format("date-time")
    started_at?: string;

    @minValue(0)
    turn?: integer;
  };
  trace?: {
    trace_id?: string;
    span_id?: string;
  };
  tenant?: {
    id?: string;
    name?: string;
  };
  actor?: {
    id?: string;
    kind?: ActorKind;
  };
  budgets?: {
    tool_call_count?: float64;
    token_count?: float64;
    elapsed_seconds?: float64;
    cost_usd?: float64;
  };
}

@category(Categories.Requests)
model HooksRequest<TPoint extends InterceptionPoint = InterceptionPoint> {
  ...ContextMetadata;
  interception_point: TPoint;
  extensions?: Extensions;
}

// Example: [agent-startup.json](../examples/AgentContext/agent-startup.json)
/** The request at agent_startup: agent_init is required (§4.2). */
@category(Categories.Requests)
model AgentStartupRequest {
  ...HooksRequest<InterceptionPoint.AgentStartup>;
  agent_init: AgentInit;
}

// Example: [input.json](../examples/AgentContext/input.json)
/** The request at input: input is required (§4.2). */
@category(Categories.Requests)
model InputRequest {
  ...HooksRequest<InterceptionPoint.Input>;
  input: Input;
}

// Example: [pre-model-call.json](../examples/AgentContext/pre-model-call.json)
// Example: [with metadata](../examples/AgentContext/pre-model-call-with-model-metadata.json)
// Example: [with tools](../examples/AgentContext/pre-model-call-with-tools.json)
/** The request at pre_model_call: model and messages are required (§4.2). */
@category(Categories.Requests)
model PreModelCallRequest {
  ...HooksRequest<InterceptionPoint.PreModelCall>;
  `model`: Model;
  messages: Message[];
  tools?: ToolDecl[];
  request_id?: string;
}

// Example: [post-model-call.json](../examples/AgentContext/post-model-call.json)
// Example: [optional tool id](../examples/AgentContext/post-model-call-with-optional-tool-call-id.json)
// Example: [with usage](../examples/AgentContext/post-model-call-with-usage.json)
/** The request at post_model_call: model and response are required (§4.2). */
@category(Categories.Requests)
model PostModelCallRequest {
  ...HooksRequest<InterceptionPoint.PostModelCall>;
  `model`: Model;
  response: Response;
  request_id?: string;
  usage?: Usage;
}

// Example: [pre-tool-call.json](../examples/AgentContext/pre-tool-call.json)
/** The request at pre_tool_call: tool_call is required (§4.2). */
@category(Categories.Requests)
model PreToolCallRequest {
  ...HooksRequest<InterceptionPoint.PreToolCall>;
  tool_call: ToolCall;
}

// Example: [post-tool-call.json](../examples/AgentContext/post-tool-call.json)
// Example: [error](../examples/AgentContext/post-tool-call-error.json)
/** The request at post_tool_call: tool_call and tool_result are required (§4.2). */
@category(Categories.Requests)
model PostToolCallRequest {
  ...HooksRequest<InterceptionPoint.PostToolCall>;
  tool_call: ToolCall;
  tool_result: ToolResult;
}

// Example: [output.json](../examples/AgentContext/output.json)
/** The request at output: output is required (§4.2). */
@category(Categories.Requests)
model OutputRequest {
  ...HooksRequest<InterceptionPoint.Output>;
  output: Output;
}

// Example: [agent-shutdown.json](../examples/AgentContext/agent-shutdown.json)
/** The request at agent_shutdown: summary is required (§4.2). */
@category(Categories.Requests)
model AgentShutdownRequest {
  ...HooksRequest<InterceptionPoint.AgentShutdown>;
  summary: Summary;
}

/**
 * Payload a host constructs at each interception point (AGENT-HOOKS-0.1 §4).
 * Each variant requires its discriminator and own hook payload, with shared
 * metadata and optional namespaced extensions.
 */
@summary("Agent Hooks — agent context")
@category(Categories.Requests)
union AgentContext {
  AgentStartupRequest,
  InputRequest,
  PreModelCallRequest,
  PostModelCallRequest,
  PreToolCallRequest,
  PostToolCallRequest,
  OutputRequest,
  AgentShutdownRequest,
}
