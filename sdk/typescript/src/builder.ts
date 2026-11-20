// Copyright (c) Microsoft. All rights reserved.

import {
  InterceptionPoint, SPEC_VERSION_0_1, SPEC_VERSION_DRAFT, requireSpecVersion,
  type AgentContext, type ContextMetadata, type InputRole, type JsonValue,
  type LegacyAgentContext, type Message, type SummaryReason, type ToolCallRequest,
} from "./index";

type Request<P extends InterceptionPoint> = Extract<AgentContext, { interception_point: P }>;
type BuiltRequest<S extends string, P extends InterceptionPoint> =
  S extends typeof SPEC_VERSION_DRAFT ? Request<P> :
  S extends typeof SPEC_VERSION_0_1 ? LegacyAgentContext : Request<P> | LegacyAgentContext;

/** Stateful per-session context builder. Draft requests have hook-specific payloads and no target alias. */
export class AgentContextBuilder<S extends string = string> {
  private seq = 0;
  private readonly agent: ContextMetadata["agent"];
  private readonly session: ContextMetadata["session"];
  readonly spec: S;

  constructor(opts: {
    spec: S;
    agentId: string;
    framework: string;
    sessionId: string;
    agentName?: string;
    agentVersion?: string;
    sessionStartedAt?: string;
  }) {
    requireSpecVersion(opts?.spec, "AgentContextBuilder spec");
    this.spec = opts.spec;
    this.agent = { id: opts.agentId, framework: opts.framework };
    if (opts.agentName) this.agent.name = opts.agentName;
    if (opts.agentVersion) this.agent.version = opts.agentVersion;
    this.session = { id: opts.sessionId };
    if (opts.sessionStartedAt) this.session.started_at = opts.sessionStartedAt;
  }

  private envelope(): ContextMetadata {
    return {
      spec: SPEC_VERSION_DRAFT,
      timestamp: new Date().toISOString(),
      sequence: this.seq++,
      agent: { ...this.agent },
      session: { ...this.session },
    };
  }

  private complete<P extends InterceptionPoint>(
    ctx: Request<P>,
    target: JsonValue | Message[] | Request<"post_model_call">["response"],
  ): BuiltRequest<S, P> {
    // The constructor validates S; this branch preserves the builder's literal version.
    return (this.spec === SPEC_VERSION_DRAFT
      ? ctx
      : { ...ctx, spec: SPEC_VERSION_0_1, target }) as BuiltRequest<S, P>;
  }

  agentStartup(toolsRegistered: string[]): BuiltRequest<S, "agent_startup"> {
    const agent_init = { tools_registered: [...toolsRegistered] };
    return this.complete<"agent_startup">({
      ...this.envelope(), interception_point: InterceptionPoint.AgentStartup, agent_init,
    }, agent_init);
  }

  input(content: JsonValue, role: InputRole = "user"): BuiltRequest<S, "input"> {
    const input = { content, role };
    return this.complete<"input">({
      ...this.envelope(), interception_point: InterceptionPoint.Input, input,
    }, input);
  }

  preModelCall(modelId: string, messages: Message[]): BuiltRequest<S, "pre_model_call"> {
    return this.complete<"pre_model_call">({
      ...this.envelope(), interception_point: InterceptionPoint.PreModelCall,
      model: { id: modelId }, messages,
    }, messages);
  }

  postModelCall(
    modelId: string,
    content: JsonValue,
    toolCalls: ToolCallRequest[],
    finishReason: string,
  ): BuiltRequest<S, "post_model_call"> {
    const response = { content, tool_calls: toolCalls, finish_reason: finishReason };
    return this.complete<"post_model_call">({
      ...this.envelope(), interception_point: InterceptionPoint.PostModelCall,
      model: { id: modelId }, response,
    }, response);
  }

  preToolCall(callId: string, name: string, args: Record<string, JsonValue>): BuiltRequest<S, "pre_tool_call"> {
    return this.complete<"pre_tool_call">({
      ...this.envelope(), interception_point: InterceptionPoint.PreToolCall,
      tool_call: { id: callId, name, args },
    }, args);
  }

  postToolCall(
    callId: string, name: string, args: Record<string, JsonValue>,
    value: JsonValue, isError = false,
  ): BuiltRequest<S, "post_tool_call"> {
    return this.complete<"post_tool_call">({
      ...this.envelope(), interception_point: InterceptionPoint.PostToolCall,
      tool_call: { id: callId, name, args }, tool_result: { value, is_error: isError },
    }, value);
  }

  output(content: JsonValue): BuiltRequest<S, "output"> {
    const output = { content };
    return this.complete<"output">({
      ...this.envelope(), interception_point: InterceptionPoint.Output, output,
    }, output);
  }

  agentShutdown(reason: SummaryReason): BuiltRequest<S, "agent_shutdown"> {
    const summary = { reason };
    return this.complete<"agent_shutdown">({
      ...this.envelope(), interception_point: InterceptionPoint.AgentShutdown, summary,
    }, summary);
  }
}
