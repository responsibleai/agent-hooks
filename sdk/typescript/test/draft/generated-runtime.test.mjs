// Copyright (c) Microsoft. All rights reserved.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentContextBuilder, Composition, EnforcementMode, HostError, InterceptionEmitter,
  SPEC_VERSION_DRAFT, applyTransformCtx, contextIdentity, parseInterceptorResponse,
  serializeInterceptorResponse, composeAggregate, HostWarning,
} from "../../dist/index.js";

const builder = () => new AgentContextBuilder({
  spec: SPEC_VERSION_DRAFT, agentId: "a", framework: "test", sessionId: "s",
});
const cases = [
  [() => builder().input("before"), { input: { content: "after", role: "user" } }, (ctx) => ctx.input],
  [() => builder().preModelCall("model", []), { messages: [{ role: "user", content: "after" }] }, (ctx) => ctx.messages],
  [
    () => builder().postModelCall("model", "before", [], "stop"),
    { response: { content: "after", tool_calls: [{ name: "tool", args: {} }], finish_reason: "tool_calls" } },
    (ctx) => ctx.response,
  ],
  [() => builder().preToolCall("call", "tool", {}), { args: { safe: true } }, (ctx) => ctx.tool_call.args],
  [() => builder().postToolCall("call", "tool", {}, "before"), { value: null }, (ctx) => ctx.tool_result.value],
  [() => builder().output("before"), { output: { content: "after" } }, (ctx) => ctx.output],
];

for (const [createContext, transform, payload] of cases) {
  test(`draft ${createContext().interception_point} transforms fold into the next interceptor`, async () => {
    const ctx = createContext();
    const before = contextIdentity(ctx);
    const expected = Object.values(transform)[0];
    let seen;
    const emitter = new InterceptionEmitter(SPEC_VERSION_DRAFT);
    emitter.register({ intercept: () => ({ verdict: { decision: "transform", transform } }) });
    emitter.register({
      intercept(context) {
        seen = payload(context);
        assert.equal("target" in context, false);
        return { verdict: { decision: "allow" }, extensions: { provider: { diagnostic: "not-enforcement" } } };
      },
    });
    const result = await emitter.emit(ctx);
    assert.deepEqual(seen, expected);
    assert.deepEqual(payload(ctx), expected);
    assert.deepEqual(result.target, expected);
    assert.equal("target" in ctx, false);
    assert.notEqual(result.record.enforced_identity, before);
    assert.equal("transform" in result.record.verdict, false);
    assert.equal(JSON.stringify(result.record).includes("not-enforcement"), false);
    assert.deepEqual(payload(applyTransformCtx(createContext(), transform)), expected);
  });
}

test("draft response parsing preserves envelopes, null transforms and metadata", () => {
  const response = {
    verdict: { decision: "transform", transform: { value: null } },
    extensions: { provider: { receipt: "r1" } },
  };
  const parsed = parseInterceptorResponse(JSON.stringify(response), SPEC_VERSION_DRAFT, "post_tool_call");
  assert.deepEqual(parsed, response);
  assert.deepEqual(serializeInterceptorResponse(parsed, SPEC_VERSION_DRAFT, "post_tool_call"), response);
  assert.deepEqual(
    serializeInterceptorResponse({ verdict: { decision: "allow" } }, SPEC_VERSION_DRAFT, "input"),
    { verdict: { decision: "allow" } },
  );
  for (const raw of [
    '{"verdict":{"decision":"allow"},"verdict":{"decision":"deny"}}',
    '{"verdict":{"decision":"transform","transform":{"value":1,"value":2}}}',
    '{"verdict":{"decision":"allow"},"extensions":{"provider":{"id":18446744073709551616}}}',
  ]) {
    assert.throws(() => parseInterceptorResponse(raw, SPEC_VERSION_DRAFT, "post_tool_call"),
      (error) => error.code === HostError.VerdictInvalid);
  }
});

test("draft rejects bare verdicts, another hook's payload and transforms at lifecycle boundaries", async () => {
  for (const [ctx, response] of [
    [builder().input("before"), { decision: "allow" }],
    [builder().input("before"), { verdict: { decision: "transform", transform: { args: {} } } }],
    [builder().agentStartup([]), { verdict: { decision: "transform", transform: { args: {} } } }],
    [builder().agentShutdown("completed"), { verdict: { decision: "transform", transform: { args: {} } } }],
  ]) {
    const emitter = new InterceptionEmitter(SPEC_VERSION_DRAFT);
    emitter.register({ intercept: () => response });
    assert.equal((await emitter.emitUnchecked(ctx)).verdict.reason, HostError.VerdictInvalid);
  }
});

test("malformed draft requests are rejected before interception or transformation", async () => {
  const ctx = builder().preToolCall("call", "tool", {});
  ctx.tool_call.args = [];
  let called = false;
  const emitter = new InterceptionEmitter(SPEC_VERSION_DRAFT);
  emitter.register({ intercept() {
    called = true;
    return { verdict: { decision: "allow" } };
  } });
  assert.equal((await emitter.emitUnchecked(ctx)).verdict.reason, HostError.ContextInvalid);
  assert.equal(called, false);
  assert.throws(() => contextIdentity(ctx), (error) => error.code === HostError.ContextInvalid);
  assert.throws(() => applyTransformCtx(ctx, { args: {} }), (error) => error.code === HostError.ContextInvalid);
});

test("standalone draft composition preserves hook replacements and rejects mismatched hooks", () => {
  const transform = { decision: "transform", transform: { value: null } };
  const warnings = [{ reason: HostWarning.ControlFailed, message: "control failed" }];
  const result = composeAggregate(Composition.strictest(), [
    transform, { decision: "allow", warnings },
  ], SPEC_VERSION_DRAFT, "post_tool_call");
  assert.deepEqual(result.combined, { ...transform, warnings });
  assert.throws(
    () => composeAggregate(Composition.strictest(), [transform], SPEC_VERSION_DRAFT, "pre_tool_call"),
    (error) => error.code === HostError.VerdictInvalid,
  );
  assert.throws(
    () => composeAggregate(Composition.strictest(), [transform], SPEC_VERSION_DRAFT, "agent_shutdown"),
    (error) => error.code === HostError.VerdictInvalid,
  );
});

test("draft parallel composition applies its winner and evaluate_only leaves the payload intact", async () => {
  for (const mode of [EnforcementMode.Enforce, EnforcementMode.EvaluateOnly]) {
    const ctx = builder().preToolCall("call", "tool", { before: true });
    const before = contextIdentity(ctx);
    const snapshots = [];
    const emitter = new InterceptionEmitter(SPEC_VERSION_DRAFT, mode).setComposition(Composition.strictest());
    emitter.register({ intercept: () => ({ verdict: { decision: "transform", transform: { args: { after: true } } } }) });
    emitter.register({ intercept(context) {
      snapshots.push(context.tool_call.args);
      return { verdict: { decision: "allow" } };
    } });
    const record = await emitter.emitUnchecked(ctx);
    assert.deepEqual(snapshots, [{ before: true }]);
    assert.deepEqual(ctx.tool_call.args, mode === EnforcementMode.Enforce ? { after: true } : { before: true });
    assert.equal(record.input_identity === record.enforced_identity, mode === EnforcementMode.EvaluateOnly);
    assert.equal(record.input_identity, before);
    assert.equal("transform" in record.verdict, false);
  }
});

test("draft approval receives the target-free request and refuses a transform resolution", async () => {
  for (const verdict of [
    { decision: "allow" },
    { decision: "transform", transform: { args: { unsafe: true } } },
  ]) {
    const emitter = new InterceptionEmitter(SPEC_VERSION_DRAFT, EnforcementMode.Enforce, {
      resolve(request) {
        assert.equal("target" in request.context, false);
        return { outcome: "approve", context_identity: request.context_identity, verdict };
      },
    });
    emitter.register({ intercept: () => ({ verdict: { decision: "deny", approval: {} } }) });
    const record = await emitter.emitUnchecked(builder().preToolCall("call", "tool", {}));
    assert.equal(record.verdict.decision, verdict.decision === "allow" ? "allow" : "deny");
    if (verdict.decision === "transform") assert.equal(record.verdict.reason, HostError.VerdictInvalid);
  }
});
