// Copyright (c) Microsoft. All rights reserved.

namespace AgentHooks;

/** Conditional payload of agent_startup (section 4.2). */
model AgentInit {
  tools_registered: string[];
}

/** Who produced an input. */
enum InputRole {
  User: "user",
  System: "system",
  External: "external",
}

model Input {
  content: unknown;
  role: InputRole;
}

model Model {
  id: string;
  vendor?: string;
  params?: JsonObject;
}

model Message {
  role: string;
  content: unknown;
}

model ToolCallRequest {
  id?: string;
  name: string;
  args: JsonObject;
}

model Response {
  content: unknown;
  tool_calls: ToolCallRequest[];
  finish_reason: string;
}

model Usage {
  @minValue(0)
  prompt_tokens?: integer;

  @minValue(0)
  completion_tokens?: integer;
}

model ToolCall {
  @minLength(1)
  id: string;

  @minLength(1)
  name: string;

  args: JsonObject;

  @pattern("^sha256:[0-9a-f]{64}$")
  content_hash?: string;
}

model ToolResult {
  value: unknown;
  is_error: boolean;

  @minValue(0)
  duration_ms?: float64;
}

model ToolDecl {
  name: string;
  description?: string;
  schema?: JsonObject;
}

model Output {
  content: unknown;
}

enum SummaryReason {
  Completed: "completed",
  Error: "error",
  Cancelled: "cancelled",
}

model Summary {
  reason: SummaryReason;

  @minValue(0)
  tool_calls?: integer;

  @minValue(0)
  errors?: integer;

  @minValue(0)
  duration_seconds?: float64;
}

enum ActorKind {
  Human: "human",
  Service: "service",
  Agent: "agent",
}

/** Metadata available at every interception point. */
model ContextMetadata {
  /** This bundle's wire string, rewritten when a specification is cut. */
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

model HooksRequest<TPoint extends InterceptionPoint = InterceptionPoint> {
  ...ContextMetadata;
  interception_point: TPoint;
  extensions?: Extensions;
}

/**
 * The request at agent_startup.
 * [agent-startup.json](../examples/AgentContext/agent-startup.json)
 */
model AgentStartupRequest {
  ...HooksRequest<InterceptionPoint.AgentStartup>;
  agent_init: AgentInit;
}

/**
 * The request at input.
 * [input.json](../examples/AgentContext/input.json)
 */
model InputRequest {
  ...HooksRequest<InterceptionPoint.Input>;
  input: Input;
}

/**
 * The request at pre_model_call.
 * [pre-model-call.json](../examples/AgentContext/pre-model-call.json)
 * [with metadata](../examples/AgentContext/pre-model-call-with-model-metadata.json)
 * [with tools](../examples/AgentContext/pre-model-call-with-tools.json)
 */
model PreModelCallRequest {
  ...HooksRequest<InterceptionPoint.PreModelCall>;
  `model`: Model;
  messages: Message[];
  tools?: ToolDecl[];
  request_id?: string;
}

/**
 * The request at post_model_call.
 * [post-model-call.json](../examples/AgentContext/post-model-call.json)
 * [optional tool id](../examples/AgentContext/post-model-call-with-optional-tool-call-id.json)
 * [with usage](../examples/AgentContext/post-model-call-with-usage.json)
 */
model PostModelCallRequest {
  ...HooksRequest<InterceptionPoint.PostModelCall>;
  `model`: Model;
  response: Response;
  request_id?: string;
  usage?: Usage;
}

/**
 * The request at pre_tool_call.
 * [pre-tool-call.json](../examples/AgentContext/pre-tool-call.json)
 */
model PreToolCallRequest {
  ...HooksRequest<InterceptionPoint.PreToolCall>;
  tool_call: ToolCall;
}

/**
 * The request at post_tool_call.
 * [post-tool-call.json](../examples/AgentContext/post-tool-call.json)
 * [error](../examples/AgentContext/post-tool-call-error.json)
 */
model PostToolCallRequest {
  ...HooksRequest<InterceptionPoint.PostToolCall>;
  tool_call: ToolCall;
  tool_result: ToolResult;
}

/**
 * The request at output.
 * [output.json](../examples/AgentContext/output.json)
 */
model OutputRequest {
  ...HooksRequest<InterceptionPoint.Output>;
  output: Output;
}

/**
 * The request at agent_shutdown.
 * [agent-shutdown.json](../examples/AgentContext/agent-shutdown.json)
 */
model AgentShutdownRequest {
  ...HooksRequest<InterceptionPoint.AgentShutdown>;
  summary: Summary;
}

/** Payload a host constructs at each interception point (section 4). */
@summary("Agent Hooks - agent context")
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
