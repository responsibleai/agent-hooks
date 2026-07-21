// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Emitter tests: composition profiles (§7), approval seam (§9), identity
// provider seam (§10.1), and the P-004 marshalling guards. Mirrors
// sdk/rust/core/src/emitter.rs tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AgentHooksCoreError,
  ApprovalOutcome,
  Composition,
  Decision,
  EnforcementMode,
  HostError,
  InterceptionEmitter,
  Verdict,
  isLiftable,
  validateVerdict,
} from "../dist/index.js";

const ctx = () => ({
  spec: "agent-hooks/0.1",
  interception_point: "pre_tool_call",
  timestamp: "t",
  sequence: 0,
  agent: { id: "a", framework: "x" },
  session: { id: "s" },
  target: { url: "evil" },
  tool_call: { id: "tc", name: "t", args: { url: "evil" } },
});

/** Interceptor that always returns (a copy of) `v` and counts calls. */
function scripted(v) {
  const i = {
    calls: 0,
    intercept() {
      i.calls++;
      return structuredClone(v);
    },
  };
  return i;
}

const transform = (path, value) => ({ decision: "transform", transform: { path, value } });
const deny = () => ({ decision: "deny" });

/** Resolver that echoes the request identity (§9 echo rule) and counts calls. */
function approver(outcome, verdict) {
  const r = {
    calls: 0,
    resolve(req) {
      r.calls++;
      return { outcome, context_identity: req.context_identity, verdict };
    },
  };
  return r;
}

// ---- verdict vocabulary (§5.1) ----------------------------------------------

test("sugar: warn is allow+warnings, escalate is deny+approval", () => {
  const w = Verdict.warn("pii", "found ssn");
  assert.equal(w.decision, Decision.Allow);
  assert.equal(w.warnings.length, 1);
  assert.equal(w.warnings[0].reason, "pii");
  const e = Verdict.escalate("check");
  assert.equal(e.decision, Decision.Deny);
  assert.deepEqual(e.approval, {});
  assert.ok(isLiftable(e));
  assert.ok(!isLiftable(deny()));
});

test("sugar: deny is a plain, final deny", () => {
  const d = Verdict.deny("policy", "blocked");
  assert.equal(d.decision, Decision.Deny);
  assert.equal(d.reason, "policy");
  assert.equal(d.message, "blocked");
  assert.equal(d.approval, undefined);
  assert.ok(!isLiftable(d));
  validateVerdict(d);
});

test("wire: warn/escalate decisions and misplaced approval fail the §5 gate", () => {
  for (const bad of [
    { decision: "warn" },
    { decision: "escalate" },
    { decision: "allow", approval: {} },
    { decision: "allow", warnings: ["x"] },
  ]) {
    assert.throws(
      () => validateVerdict(bad),
      (e) => e instanceof AgentHooksCoreError && e.code === HostError.VerdictInvalid,
    );
  }
  // The three-verdict shapes pass.
  validateVerdict(Verdict.warn("w"));
  validateVerdict(Verdict.escalate("e"));
  validateVerdict(transform("$target.url", "x"));
});

// ---- sequential/run_all (§7.4) ----------------------------------------------

test("run_all runs everything and strictest wins", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  e.setComposition(Composition.runAll());
  const late = scripted(Verdict.warn("late"));
  e.register(scripted(deny())).register(late);
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Deny);
  assert.equal(late.calls, 1, "run_all: everything runs");
  assert.equal(r.verdicts.length, 2);
  assert.equal(r.decided_by, 0);
  // §7.3: warnings union onto the deny combination.
  assert.equal(r.verdict.warnings.length, 1);
  assert.equal(r.fold_truncated, undefined, "not defined outside first_deny");
});

test("run_all consults at most once when every deny is liftable", async () => {
  const a = approver(ApprovalOutcome.Approve, Verdict.allow());
  const e = new InterceptionEmitter(EnforcementMode.Enforce, a);
  e.setComposition(Composition.runAll());
  e.register(scripted(Verdict.escalate("first"))).register(scripted(Verdict.escalate("second")));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Allow);
  assert.equal(a.calls, 1, "seam consulted exactly once per emission");
  assert.equal(r.resolved_by, "approval");
  assert.equal(r.decided_by, 0);
});

test("run_all does not consult when a plain deny exists", async () => {
  const a = approver(ApprovalOutcome.Approve, Verdict.allow());
  const e = new InterceptionEmitter(EnforcementMode.Enforce, a);
  e.setComposition(Composition.runAll());
  e.register(scripted(Verdict.escalate("liftable"))).register(scripted(deny()));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Deny);
  assert.equal(a.calls, 0, "a plain deny makes lifting pointless");
  assert.equal(r.decided_by, 1, "plain deny dominates liftable (§5.1 severity)");
  assert.equal(r.resolved_by, undefined);
});

// ---- parallel/strictest (§7.5) ----------------------------------------------

test("parallel strictest transform conflict fails closed", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  e.setComposition(Composition.strictest("deny"));
  e.register(scripted(transform("$target.url", "a")));
  e.register(scripted(transform("$target.url", "b")));
  const c = ctx();
  const r = await e.emitUnchecked(c);
  assert.equal(r.verdict.reason, HostError.TransformConflict);
  // Snapshot isolation: neither transform applied.
  assert.equal(c.target.url, "evil");
});

test("parallel strictest transform conflict with approval knob consults the seam", async () => {
  const a = approver(ApprovalOutcome.Approve, transform("$target.url", "resolved"));
  const e = new InterceptionEmitter(EnforcementMode.Enforce, a);
  e.setComposition(Composition.strictest("approval"));
  e.register(scripted(transform("$target.url", "a")));
  e.register(scripted(transform("$target.url", "b")));
  const c = ctx();
  const r = await e.emitUnchecked(c);
  assert.equal(a.calls, 1);
  assert.equal(r.verdict.decision, Decision.Transform);
  assert.equal(c.target.url, "resolved", "resolver's transform applied");
  assert.equal(r.resolved_by, "approval");
  assert.equal(r.decided_by, null, "synthesized trigger has no deciding index");
});

test("parallel strictest single transform applies", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  e.setComposition(Composition.strictest("deny"));
  e.register(scripted(Verdict.allow()));
  e.register(scripted(transform("$target.url", "safe")));
  const c = ctx();
  const r = await e.emitUnchecked(c);
  assert.equal(r.verdict.decision, Decision.Transform);
  assert.equal(r.decided_by, 1);
  assert.equal(c.target.url, "safe");
  assert.equal(c.tool_call.args.url, "safe", "§4.3 write-back");
  assert.notEqual(r.input_identity, r.enforced_identity);
});

test("parallel isolation: no interceptor observes another's transform", async () => {
  const seen = [];
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  e.setComposition(Composition.strictest("deny"));
  e.register(scripted(transform("$target.url", "rewritten")));
  e.register({
    intercept(c) {
      seen.push(c.target.url);
      return Verdict.allow();
    },
  });
  await e.emitUnchecked(ctx());
  assert.deepEqual(seen, ["evil"], "identical untransformed snapshot");
});

// ---- parallel/unanimous (§7.5) ----------------------------------------------

test("unanimous disagreement synthesizes", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  e.setComposition(Composition.unanimous("deny", "deny"));
  e.register(scripted(Verdict.allow()));
  e.register(scripted(transform("$target.url", "x")));
  const c = ctx();
  const r = await e.emitUnchecked(c);
  assert.equal(r.verdict.reason, HostError.CompositionDisagreement);
  assert.equal(c.target.url, "evil", "transform not applied");
  assert.equal(r.decided_by, null);
  assert.equal(r.verdicts.length, 2);
});

test("unanimous allow proceeds with unioned metadata", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  e.setComposition(Composition.unanimous("deny", "deny"));
  e.register(scripted(Verdict.allow()));
  e.register(scripted({ decision: "allow", result_labels: ["l"] }));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Allow);
  assert.deepEqual(r.verdict.result_labels, ["l"]);
});

test("unanimous disagreement with approval knob consults the seam", async () => {
  const a = approver(ApprovalOutcome.Approve, Verdict.allow());
  const e = new InterceptionEmitter(EnforcementMode.Enforce, a);
  e.setComposition(Composition.unanimous("approval", "deny"));
  e.register(scripted(Verdict.allow()));
  e.register(scripted(deny()));
  const r = await e.emitUnchecked(ctx());
  assert.equal(a.calls, 1);
  assert.equal(r.verdict.decision, Decision.Allow);
  assert.equal(r.resolved_by, "approval");
  assert.equal(r.decided_by, null);
});

// ---- sequential/first_deny (§7.4) --------------------------------------------

test("first_deny: no resolver, liftable deny stands without error", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  e.register(scripted(Verdict.escalate("check")));
  const r = await e.emitUnchecked(ctx());
  // §9: no resolver → the liftable deny stands, NOT an error.
  assert.equal(r.verdict.decision, Decision.Deny);
  assert.equal(r.verdict.reason, "check");
  assert.ok(isLiftable(r.verdict));
  assert.equal(r.resolved_by, undefined);
});

test("first_deny stop truncates and records the substitution", async () => {
  const e = new InterceptionEmitter(
    EnforcementMode.Enforce,
    approver(ApprovalOutcome.Approve, Verdict.allow()),
  );
  e.setComposition(Composition.firstDeny("stop"));
  const skipped = scripted(deny());
  e.register(scripted(Verdict.escalate())).register(skipped);
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Allow);
  assert.equal(skipped.calls, 0, "interceptors after the denying one never run");
  assert.equal(r.fold_truncated, true);
  assert.equal(r.resolved_by, "approval");
  assert.equal(r.decided_by, 0);
});

test("first_deny resume continues the fold", async () => {
  const e = new InterceptionEmitter(
    EnforcementMode.Enforce,
    approver(ApprovalOutcome.Approve, Verdict.allow()),
  );
  e.setComposition(Composition.firstDeny("resume"));
  e.register(scripted(Verdict.escalate())).register(scripted(deny())); // now runs — and denies
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Deny);
  assert.equal(r.decided_by, 1);
  assert.equal(r.resolved_by, "approval");
  assert.equal(r.fold_truncated, false);
});

test("first_deny: zero interceptors fails closed", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.reason, HostError.NoInterceptor);
});

// ---- approval seam (§9) --------------------------------------------------------

test("echo rule violation fails closed", async () => {
  const badEcho = {
    resolve: () => ({
      outcome: ApprovalOutcome.Approve,
      context_identity: "sha256:forged",
      verdict: Verdict.allow(),
    }),
  };
  const e = new InterceptionEmitter(EnforcementMode.Enforce, badEcho);
  e.register(scripted(Verdict.escalate()));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.reason, HostError.ApprovalIdentityMismatch);
});

test("approve with a block verdict is verdict_invalid", async () => {
  const e = new InterceptionEmitter(
    EnforcementMode.Enforce,
    approver(ApprovalOutcome.Approve, deny()),
  );
  e.register(scripted(Verdict.escalate()));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.reason, HostError.VerdictInvalid);
});

test("reject with a permit verdict is verdict_invalid", async () => {
  const e = new InterceptionEmitter(
    EnforcementMode.Enforce,
    approver(ApprovalOutcome.Reject, Verdict.allow()),
  );
  e.register(scripted(Verdict.escalate()));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.reason, HostError.VerdictInvalid);
});

test("shutdown never consults", async () => {
  const a = approver(ApprovalOutcome.Approve, Verdict.allow());
  const e = new InterceptionEmitter(EnforcementMode.Enforce, a);
  e.register(scripted(Verdict.escalate()));
  const c = ctx();
  c.interception_point = "agent_shutdown";
  c.summary = { reason: "completed" };
  c.target = c.summary;
  delete c.tool_call;
  const r = await e.emitUnchecked(c);
  // §6.1a: the liftable deny is recorded, the seam untouched.
  assert.ok(isLiftable(r.verdict));
  assert.equal(a.calls, 0);
  assert.equal(r.resolved_by, undefined);
});

test("evaluate_only never consults and proceeds", async () => {
  const a = approver(ApprovalOutcome.Approve, Verdict.allow());
  const e = new InterceptionEmitter(EnforcementMode.EvaluateOnly, a);
  e.register(scripted(Verdict.escalate("check")));
  const r = await e.emitUnchecked(ctx());
  assert.equal(a.calls, 0);
  assert.ok(isLiftable(r.verdict), "the deny is recorded as returned");
  assert.equal(r.mode, EnforcementMode.EvaluateOnly);
});

// ---- identity provider seam (§10.1) -------------------------------------------

test("null provider yields an unbound record", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  e.setIdentityProvider(null);
  e.register(scripted(Verdict.allow()));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.input_identity, null);
  assert.equal(r.enforced_identity, null);
  assert.equal(r.identity_provider, null);
});

test("null provider: null identity echoes as null through the seam", async () => {
  const seen = [];
  const a = {
    resolve(req) {
      seen.push(req.context_identity);
      return {
        outcome: ApprovalOutcome.Approve,
        context_identity: req.context_identity,
        verdict: Verdict.allow(),
      };
    },
  };
  const e = new InterceptionEmitter(EnforcementMode.Enforce, a);
  e.setIdentityProvider(null);
  e.register(scripted(Verdict.escalate()));
  const r = await e.emitUnchecked(ctx());
  assert.deepEqual(seen, [null], "identity-unbound consultation");
  assert.equal(r.verdict.decision, Decision.Allow);
});

test("custom provider: name and identities recorded, echo enforced against it", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  e.setIdentityProvider({ name: "host-hash", fn: (c) => `host:${c.session.id}` });
  e.register(scripted(Verdict.allow()));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.identity_provider, "host-hash");
  assert.equal(r.input_identity, "host:s");
  assert.equal(r.enforced_identity, "host:s");
});

test("default provider rejects out-of-range integrals before dispatch", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  const i = scripted(Verdict.allow());
  e.register(i);
  const c = ctx();
  // 2^53: already outside the ±(2^53−1) I-JSON domain (§10.2).
  c.target = { id: 9007199254740992 };
  c.tool_call = { id: "tc", name: "t", args: { id: 9007199254740992 } };
  const r = await e.emitUnchecked(c);
  assert.equal(r.verdict.reason, HostError.ContextInvalid);
  assert.match(r.verdict.message, /string-encode/);
  assert.equal(i.calls, 0, "no interceptor ran");
  assert.equal(r.input_identity, null);
  assert.equal(r.enforced_identity, null);
  assert.equal(r.identity_provider, "jcs-sha256", "declared provider still recorded");
});

// ---- P-004 marshalling guard (§4.4) --------------------------------------------

test("NaN in the context fails closed before dispatch", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  const i = scripted(Verdict.allow());
  e.register(i);
  const c = ctx();
  c.target = { amount: NaN };
  const r = await e.emitUnchecked(c);
  assert.equal(r.verdict.reason, HostError.ContextInvalid);
  assert.match(r.verdict.message, /non-finite/);
  assert.equal(i.calls, 0, "no interceptor ran");
  assert.equal(r.input_identity, null);
});

test("Infinity in an interceptor's verdict fails the §5 gate", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  e.register(scripted(transform("$target.url", Infinity)));
  const c = ctx();
  const r = await e.emitUnchecked(c);
  assert.equal(r.verdict.reason, HostError.VerdictInvalid);
  assert.match(r.verdict.message, /non-finite/);
  assert.equal(c.target.url, "evil", "corrupted transform never applied");
});

test("first_deny: failure deny attributed to failing interceptor (§10.3 D3)", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  e.register(scripted(Verdict.allow()));
  e.register({ intercept: () => { throw new Error("boom"); } });
  e.register(scripted(Verdict.allow()));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.reason, HostError.InterceptorFailed);
  assert.equal(r.decided_by, 1);
  assert.equal(r.fold_truncated, true);
});

test("record verdict is the payload-free projection (§10.3 D2)", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  e.register(scripted(transform("$target.url", "safe")));
  const c = ctx();
  const r = await e.emitUnchecked(c);
  assert.equal(r.verdict.decision, Decision.Transform);
  assert.equal(r.verdict.transform.path, "$target.url");
  assert.equal("value" in r.verdict.transform, false, "record drops transform.value");
  assert.equal(c.target.url, "safe", "in-process enforcement unaffected");
});

test("evidence beyond 10240 canonical bytes fails the §5 gate (D5)", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  e.register(scripted({ decision: "allow", evidence: { artefact: "x".repeat(10300) } }));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Deny);
  assert.equal(r.verdict.reason, HostError.VerdictInvalid);
});

// ---- record semantics (§4, §10.1, §10.3) ----------------------------------

test("envelope: missing conditional field fails closed pre-dispatch", async () => {
  const em = new InterceptionEmitter();
  let ran = false;
  em.register({ intercept: () => { ran = true; return { decision: "allow" }; } });
  const c = ctx();
  delete c.tool_call;
  const r = await em.emitUnchecked(c);
  assert.equal(r.verdict.reason, "host_error:context_invalid");
  assert.equal(ran, false);
  assert.equal(r.input_identity, null);
  assert.equal(r.interceptors_registered, 1);
});

test("provider name rules enforced (§10.1)", () => {
  const em = new InterceptionEmitter();
  assert.throws(() => em.setIdentityProvider({ name: "jcs-fake", fn: () => "x" }));
  assert.throws(() => em.setIdentityProvider({ name: "Bad", fn: () => "x" }));
  em.setIdentityProvider({ name: "myco-hash", fn: () => "x" });
});

test("custom provider failure fails closed, type-name-only detail", async () => {
  const em = new InterceptionEmitter();
  em.setIdentityProvider({
    name: "myco-hash",
    fn: () => { throw new Error("SECRET-PAYLOAD"); },
  });
  em.register({ intercept: () => ({ decision: "allow" }) });
  const r = await em.emitUnchecked(ctx());
  assert.equal(r.verdict.reason, "host_error:context_invalid");
  assert.ok(!(r.verdict.message ?? "").includes("SECRET-PAYLOAD"));
  assert.equal(r.identity_provider, "myco-hash");
});

test("rejected consultation records resolved_by rejection (§10.3)", async () => {
  const em = new InterceptionEmitter("enforce", {
    resolve: (req) => ({
      outcome: "reject",
      context_identity: req.context_identity,
      verdict: { decision: "deny", reason: "no" },
    }),
  });
  em.register({ intercept: () => Verdict.escalate("check") });
  const r = await em.emitUnchecked(ctx());
  assert.equal(r.resolved_by, "rejection");
  assert.equal(r.verdict.reason, "no");
});

test("verdicts[].name carries registration names (§10.3)", async () => {
  const em = new InterceptionEmitter();
  em.setComposition(Composition.runAll());
  em.register({ intercept: () => ({ decision: "allow" }) }, "pii-scan");
  em.register({ intercept: () => ({ decision: "allow" }) });
  const r = await em.emitUnchecked(ctx());
  assert.equal(r.verdicts[0].name, "pii-scan");
  assert.equal(r.verdicts[1].name, undefined);
  assert.equal(r.interceptors_registered, 2);
});

// ---- emitter seams (mirror sdk/python/tests/test_emitter_seams.py)

test("approval redactor binds identity to the presented context", async () => {
  let presented = null;
  let identity = null;
  const resolver = {
    resolve(req) {
      presented = JSON.stringify(req.context);
      identity = req.context_identity;
      return {
        outcome: ApprovalOutcome.Approve,
        context_identity: req.context_identity,
        verdict: { decision: Decision.Allow },
      };
    },
  };
  const e = new InterceptionEmitter(EnforcementMode.Enforce, resolver);
  e.register({ intercept: () => Verdict.escalate("check") });
  e.setApprovalRedactor((c) => {
    const out = structuredClone(c);
    out.target = { REDACTED: true };
    out.tool_call.args = { REDACTED: true };
    return out;
  });
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.resolved_by, "approval");
  assert.ok(!presented.includes("evil"), `unredacted content egressed: ${presented}`);
  assert.notEqual(identity, r.input_identity);
});

test("throwing redactor fails the consultation closed", async () => {
  const resolver = {
    resolve() {
      throw new Error("resolver must not be reached");
    },
  };
  const e = new InterceptionEmitter(EnforcementMode.Enforce, resolver);
  e.register({ intercept: () => Verdict.escalate("check") });
  e.setApprovalRedactor(() => {
    throw new Error("SECRET must not leak");
  });
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Deny);
  assert.equal(r.verdict.reason, HostError.ApprovalResolverFailed);
  assert.ok(!(r.verdict.message ?? "").includes("SECRET"));
});

test("record sink and ring buffer", async () => {
  const seen = [];
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  e.register(scripted(Verdict.allow()));
  e.setRecordSink((r) => seen.push(r.sequence));
  e.setMaxRecords(2);
  for (let i = 0; i < 5; i++) await e.emitUnchecked(ctx());
  assert.equal(seen.length, 5);
  assert.equal(e.records.length, 2);
  assert.equal(e.recordsDropped, 3);
  assert.equal(e.takeRecords().length, 2);
  assert.equal(e.records.length, 0);
});

test("sink exception is swallowed", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  e.register(scripted(Verdict.allow()));
  e.setRecordSink(() => {
    throw new Error("sink down");
  });
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Allow);
});

test("emit returns the effective (post-transform) target", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null);
  e.register({
    intercept: () => ({
      decision: Decision.Transform,
      transform: { path: "$target.url", value: "clean" },
    }),
  });
  const out = await e.emit(ctx());
  assert.equal(out.target.url, "clean");
  assert.equal(out.record.verdict.decision, Decision.Transform);
});

// ---- closed §7.2 profile set enforced at configuration time --------------

test("setComposition rejects an unknown profile at call time", () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce);
  assert.throws(
    () => e.setComposition({ profile: "sequential/frist_deny" }),
    RangeError,
    "typo'd profile must be rejected before any emission",
  );
});

test("setComposition rejects knob values outside the closed set", () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce);
  assert.throws(
    () => e.setComposition({ profile: "sequential/first_deny", on_approval: "pause" }),
    RangeError,
  );
  assert.throws(
    () => e.setComposition({ profile: "parallel/unanimous", on_disagreement: "escalate" }),
    RangeError,
  );
  assert.throws(
    () => e.setComposition({ profile: "parallel/strictest", on_transform_conflict: "merge" }),
    RangeError,
  );
});

test("setComposition accepts every declared §7.2 profile", async () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce);
  for (const c of [
    Composition.default(),
    Composition.firstDeny("resume"),
    Composition.runAll(),
    Composition.strictest("approval"),
    Composition.unanimous("deny", "approval"),
  ]) {
    e.setComposition(c); // must not throw
  }
  // The last declared profile is the one recorded on the emission.
  e.register(scripted(Verdict.allow()));
  const rec = await e.emitUnchecked(ctx());
  assert.equal(rec.composition.profile, "parallel/unanimous");
});
