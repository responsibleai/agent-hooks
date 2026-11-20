// Copyright (c) Microsoft. All rights reserved.

import {
  AgentContextBuilder, InterceptionEmitter, SPEC_VERSION_0_1, SPEC_VERSION_DRAFT,
  type AgentContext, type AgentStartupHookResponse, type ApprovalRequest,
  type ApprovalResolution, type InputHookResponse, type JsonValue, type RunAllSupport,
  type InterceptionRecord, EnforcementMode, ALLOW,
} from "../../src/index";

const builder = new AgentContextBuilder({
  spec: SPEC_VERSION_DRAFT, agentId: "a", framework: "test", sessionId: "s",
});
const ctx = builder.preToolCall("call", "tool", {});
ctx.tool_call.args;
// @ts-expect-error Draft requests have no legacy target alias.
ctx.target;
// @ts-expect-error A concrete pre-tool request has no output payload.
ctx.output;

function narrow(context: AgentContext): void {
  if (context.interception_point === "input") context.input.role;
  // @ts-expect-error Conditional fields require narrowing.
  context.input;
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
// @ts-expect-error Approvals cannot approve a transform in the draft.
const resolution: ApprovalResolution = { outcome: "approve", context_identity: null, verdict: { decision: "transform", transform: { args: {} } } };
// @ts-expect-error Open records must retain their explicitly declared decision.
const request: ApprovalRequest = { context_identity: null, interception_point: "input", verdict: { decision: "allow" } };
// @ts-expect-error Closed empty objects reject additional members.
const support: RunAllSupport = { extra: true };
// @ts-expect-error JSON values cannot contain functions.
const json: JsonValue = { callback() {} };

new InterceptionEmitter(SPEC_VERSION_DRAFT).register({
  intercept(context) {
    narrow(context);
    return response;
  },
});
new InterceptionEmitter(SPEC_VERSION_DRAFT).register({
  // @ts-expect-error Draft interceptors must return a response envelope.
  intercept: () => ({ decision: "allow" }),
});
new InterceptionEmitter(SPEC_VERSION_0_1).register({
  intercept(context) {
    context.target;
    return { decision: "transform", transform: { path: "$target", value: {} } };
  },
});
new InterceptionEmitter(SPEC_VERSION_0_1).register({ intercept: () => ALLOW });

const emitter = new InterceptionEmitter(SPEC_VERSION_DRAFT, EnforcementMode.Enforce, {
  resolve(request) {
    const decision: "deny" = request.verdict.decision;
    return { outcome: "approve", context_identity: request.context_identity, verdict: { decision: "allow" } };
  },
});
emitter.setRecordSink((record: InterceptionRecord) => {});
new InterceptionEmitter(SPEC_VERSION_DRAFT, EnforcementMode.Enforce, {
  // @ts-expect-error Draft approval resolvers cannot approve a transform.
  resolve: (request) => ({
    outcome: "approve", context_identity: request.context_identity,
    verdict: { decision: "transform", transform: { args: {} } },
  }),
});
async function typedRecords(): Promise<void> {
  const record: InterceptionRecord = await emitter.emitUnchecked(ctx);
  const outcome = await emitter.emit(ctx);
  const emitted: InterceptionRecord = outcome.record;
  const retained: readonly InterceptionRecord[] = emitter.records;
  const drained: InterceptionRecord[] = emitter.takeRecords();
  const legacy = new AgentContextBuilder({
    spec: SPEC_VERSION_0_1, agentId: "a", framework: "test", sessionId: "s",
  }).preToolCall("call", "tool", {});
  // @ts-expect-error A draft emitter does not accept a legacy context.
  await emitter.emitUnchecked(legacy);
}
