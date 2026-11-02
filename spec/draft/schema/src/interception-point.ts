// Copyright (c) Microsoft. All rights reserved.

/**
 * The closed set of agent lifecycle interception points (AGENT-HOOKS-0.1 §3).
 * @example [pre-tool-call.json](../examples/InterceptionPoint/pre-tool-call.json)
 * @title Agent Hooks — interception point
 */
export enum InterceptionPoint {
  AgentStartup = "agent_startup",
  Input = "input",
  PreModelCall = "pre_model_call",
  PostModelCall = "post_model_call",
  PreToolCall = "pre_tool_call",
  PostToolCall = "post_tool_call",
  Output = "output",
  AgentShutdown = "agent_shutdown",
}
