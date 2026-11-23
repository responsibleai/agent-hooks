// Copyright (c) Microsoft. All rights reserved.

namespace AgentHooks;

/**
 * Host-to-interceptor calls (§7), paired by interception_point.
 * These logical operations do not prescribe a transport or require separate
 * runtime methods; an interceptor remains a callable dispatched by the host.
 */
interface Interceptor {
  /** Evaluate agent_startup before the session's first input (§3, §4.2). */
  agentStartup(request: AgentStartupRequest): AgentStartupHookResponse;

  /** Evaluate input before it enters the agent loop (§3, §4.2). */
  input(request: InputRequest): InputHookResponse;

  /** Evaluate pre_model_call before invoking the model (§3, §4.2). */
  preModelCall(request: PreModelCallRequest): PreModelHookResponse;

  /** Evaluate post_model_call before consuming the model response (§3, §4.2). */
  postModelCall(request: PostModelCallRequest): PostModelHookResponse;

  /** Evaluate pre_tool_call before invoking the tool (§3, §4.2). */
  preToolCall(request: PreToolCallRequest): PreToolHookResponse;

  /** Evaluate post_tool_call before consuming the tool result (§3, §4.2). */
  postToolCall(request: PostToolCallRequest): PostToolHookResponse;

  /** Evaluate output before delivering it to the caller (§3, §4.2). */
  output(request: OutputRequest): OutputHookResponse;

  /** Evaluate agent_shutdown after the last output or on abnormal termination (§3, §4.2). */
  agentShutdown(request: AgentShutdownRequest): AgentShutdownHookResponse;
}

/** Host-to-resolver consultation for a liftable deny (§9). */
interface ApprovalResolver {
  /**
   * Resolve a liftable deny, echoing the request's context_identity.
   * The host consults this seam only as prescribed by §7.4–§7.6 and §9,
   * never at agent_shutdown or in evaluate_only mode.
   */
  resolve(request: ApprovalRequest): ApprovalResolution;
}
