// Copyright (c) Microsoft. All rights reserved.

/**
 * `AgentContext` construction (§4).
 *
 * Stateful per-session builder that owns the L0 envelope
 * (agent/session/sequence) and exposes one method per interception
 * point that fills L1 and sets `target`.
 */

import { AgentContext, InterceptionPoint, JsonValue, SPEC_VERSION } from "./index";

function now(): string {
  return new Date().toISOString();
}

export class AgentContextBuilder {
  private seq = 0;
  private readonly agent: { id: string; framework: string; name?: string; version?: string };
  private readonly session: { id: string; started_at?: string };

  constructor(opts: {
    agentId: string;
    framework: string;
    sessionId: string;
    agentName?: string;
    agentVersion?: string;
    sessionStartedAt?: string;
  }) {
    this.agent = { id: opts.agentId, framework: opts.framework };
    if (opts.agentName) this.agent.name = opts.agentName;
    if (opts.agentVersion) this.agent.version = opts.agentVersion;
    this.session = { id: opts.sessionId };
    if (opts.sessionStartedAt) this.session.started_at = opts.sessionStartedAt;
  }

  private envelope(ip: InterceptionPoint, target: JsonValue): AgentContext {
    const ctx: AgentContext = {
      spec: SPEC_VERSION,
      interception_point: ip,
      timestamp: now(),
      sequence: this.seq++,
      agent: { ...this.agent },
      session: { ...this.session },
      target,
    };
    return ctx;
  }

  agentStartup(toolsRegistered: string[]): AgentContext {
    const agentInit = { tools_registered: [...toolsRegistered] };
    const ctx = this.envelope(InterceptionPoint.AgentStartup, agentInit);
    ctx.agent_init = agentInit;
    return ctx;
  }

  input(content: JsonValue, role: "user" | "system" | "external" = "user"): AgentContext {
    const inp = { content, role };
    const ctx = this.envelope(InterceptionPoint.Input, inp);
    ctx.input = inp;
    return ctx;
  }

  preModelCall(modelId: string, messages: Array<{ role: string; content: JsonValue }>): AgentContext {
    const ctx = this.envelope(InterceptionPoint.PreModelCall, messages);
    ctx.model = { id: modelId };
    ctx.messages = messages;
    return ctx;
  }

  postModelCall(
    modelId: string,
    content: JsonValue,
    toolCalls: Array<{ id: string; name: string; args: Record<string, JsonValue> }>,
    finishReason: string,
  ): AgentContext {
    const response = { content, tool_calls: toolCalls, finish_reason: finishReason };
    const ctx = this.envelope(InterceptionPoint.PostModelCall, response);
    ctx.model = { id: modelId };
    ctx.response = response;
    return ctx;
  }

  preToolCall(callId: string, name: string, args: Record<string, JsonValue>): AgentContext {
    const tc = { id: callId, name, args };
    const ctx = this.envelope(InterceptionPoint.PreToolCall, args);
    ctx.tool_call = tc;
    return ctx;
  }

  postToolCall(
    callId: string,
    name: string,
    args: Record<string, JsonValue>,
    value: JsonValue,
    isError = false,
  ): AgentContext {
    const tr = { value, is_error: isError };
    const ctx = this.envelope(InterceptionPoint.PostToolCall, value);
    ctx.tool_call = { id: callId, name, args };
    ctx.tool_result = tr;
    return ctx;
  }

  output(content: JsonValue): AgentContext {
    const out = { content };
    const ctx = this.envelope(InterceptionPoint.Output, out);
    ctx.output = out;
    return ctx;
  }

  agentShutdown(reason: "completed" | "error" | "cancelled"): AgentContext {
    const summary = { reason };
    const ctx = this.envelope(InterceptionPoint.AgentShutdown, summary);
    ctx.summary = summary;
    return ctx;
  }
}
