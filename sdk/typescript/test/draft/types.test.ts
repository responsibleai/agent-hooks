// Copyright (c) Microsoft. All rights reserved.

import type {
  AgentContext, AgentStartupHookResponse, ApprovalRequest, ApprovalResolution,
  InputHookResponse, JsonValue, PreToolCallRequest, PreToolHookResponse, RunAllSupport,
} from "../../src/generated/types";

const request: PreToolCallRequest = {
  spec: "agent-hooks/draft",
  interception_point: "pre_tool_call",
  timestamp: "2026-01-01T00:00:00Z",
  sequence: 0,
  agent: { id: "agent", framework: "example" },
  session: { id: "session" },
  tool_call: { id: "call", name: "tool", args: {} },
};
// @ts-expect-error Draft requests have no target alias.
request.target;
// @ts-expect-error A concrete pre-tool request has no output payload.
request.output;

function narrow(context: AgentContext): void {
  if (context.interception_point === "input") context.input.role;
  // @ts-expect-error Conditional fields require narrowing.
  context.input;
}
narrow(request);

function reviewTool(context: PreToolCallRequest): PreToolHookResponse {
  return {
    verdict: { decision: "transform", transform: { args: { ...context.tool_call.args, reviewed: true } } },
  };
}

const response: InputHookResponse = {
  verdict: { decision: "transform", transform: { input: { content: null, role: "user" } } },
};
// @ts-expect-error Input transforms cannot replace tool arguments.
const wrongHook: InputHookResponse = { verdict: { decision: "transform", transform: { args: {} } } };
// @ts-expect-error A transform verdict requires its payload.
const missingPayload: InputHookResponse = { verdict: { decision: "transform" } };
// @ts-expect-error Startup forbids transforms.
const startup: AgentStartupHookResponse = { verdict: { decision: "transform", transform: { args: {} } } };
const resolution: ApprovalResolution = {
  outcome: "approve", context_identity: null, verdict: { decision: "allow" },
};
// @ts-expect-error Approval resolutions cannot approve a transform.
const invalidResolution: ApprovalResolution = { outcome: "approve", context_identity: null, verdict: { decision: "transform", transform: { args: {} } } };
// @ts-expect-error An approval request requires a liftable deny, even though its verdict is open.
const invalidRequest: ApprovalRequest = { context_identity: null, interception_point: "input", verdict: { decision: "allow" } };
// @ts-expect-error Closed empty objects reject additional members.
const support: RunAllSupport = { extra: true };
// @ts-expect-error JSON values cannot contain functions.
const json: JsonValue = { callback() {} };
