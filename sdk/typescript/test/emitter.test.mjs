// Copyright (c) Microsoft. All rights reserved.

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

// ---- §10.3 host projection failure ------------------------------------------

test("recordHostFailure synthesizes the rejection-shape record", () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce);
  e.register(scripted({ decision: "allow" }));
  const r = e.recordHostFailure("pre_tool_call", {
    detail: "TypeError",
    session_id: "s",
    sequence: 7,
    timestamp: "2026-01-01T00:00:00Z",
  });
  assert.equal(r.interception_point, "pre_tool_call");
  assert.equal(r.verdict.decision, Decision.Deny);
  assert.equal(r.verdict.reason, "host_error:context_invalid");
  assert.equal(r.verdict.message, "TypeError");
  // §10.3 rejection shape: null identities under the declared
  // provider, nothing dispatched.
  assert.equal(r.identity_provider, "jcs-sha256");
  assert.equal(r.input_identity, null);
  assert.equal(r.enforced_identity, null);
  assert.equal(r.decided_by, null);
  assert.equal(r.verdicts, undefined, "no interceptor ran");
  assert.equal(r.interceptors_registered, 1);
  // Envelope facts the host supplied.
  assert.equal(r.session_id, "s");
  assert.equal(r.sequence, 7);
  assert.equal(r.timestamp, "2026-01-01T00:00:00Z");
  // The record entered the emitter's stream like any emission.
  assert.equal(e.records.length, 1);
});

test("recordHostFailure defaults are the §10.3 unknown values", () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce);
  const r = e.recordHostFailure("output");
  assert.equal(r.session_id, "");
  assert.equal(r.sequence, -1);
  assert.equal(r.timestamp, undefined);
  assert.equal(r.verdict.message, undefined);
  assert.equal(r.interceptors_registered, 0);
});

test("recordHostFailure records in evaluate_only and hits the sink", () => {
  // §8: synthesis still records in evaluate_only — records are the
  // point — and the mode member keeps the record from implying a
  // block happened.
  const e = new InterceptionEmitter(EnforcementMode.EvaluateOnly);
  const seen = [];
  e.setRecordSink((r) => seen.push(r));
  const r = e.recordHostFailure("pre_tool_call", { detail: "TypeError" });
  assert.equal(r.mode, EnforcementMode.EvaluateOnly);
  assert.equal(r.verdict.reason, "host_error:context_invalid");
  assert.deepEqual(seen, [r]);
});

test("recordHostFailure detail is truncated by the §10.3 projection", () => {
  const e = new InterceptionEmitter(EnforcementMode.Enforce);
  const r = e.recordHostFailure("pre_tool_call", { detail: "x".repeat(300) });
  assert.ok(r.verdict.message.endsWith("…"));
  assert.ok(Buffer.byteLength(r.verdict.message, "utf8") <= 256 + Buffer.byteLength("…"));
});

// ---- failure posture: on_error (§6.3.1) -----------------------------------
//
// Mirrors the on_error tests in sdk/rust/core/src/emitter.rs. The
// default is deny on every registration call; continue is opened per
// registration, needs the principal channel first, covers exactly the
// three §6.3 failures, and leaves a substituted allow plus
// substituted_for in the failing slot.

import {
  HostWarning,
  OnError,
  RegistrationError,
  isControlFailure,
} from "../dist/index.js";

/** An emitter with a notifier that collects notices. */
function withNotifier(mode = EnforcementMode.Enforce, resolver = null, timeoutMs = undefined) {
  const notices = [];
  const e =
    timeoutMs === undefined
      ? new InterceptionEmitter(mode, resolver)
      : new InterceptionEmitter(mode, resolver, timeoutMs);
  e.setControlFailureNotifier((n) => notices.push(n));
  return { e, notices };
}

const bestEffort = (name) => ({ name, onError: OnError.Continue });

const panics = {
  intercept() {
    throw new Error("SECRET-PAYLOAD must not leak");
  },
};
const malformed = scripted({ decision: "transform" }); // §5: transform without a transform block
const hangs = { intercept: () => new Promise(() => {}) };

function assertSubstituted(r, index, binding, reason) {
  const s = r.verdicts[index];
  assert.equal(s.decision, "allow", JSON.stringify(s));
  assert.equal("reason" in s, false, JSON.stringify(s));
  assert.equal(s.name, binding);
  assert.equal(s.substituted_for, reason);
  const expected = { reason: HostWarning.ControlFailed, message: `${binding}: ${reason}; host continued` };
  assert.ok(
    (r.verdict.warnings ?? []).some((w) => JSON.stringify(w) === JSON.stringify(expected)),
    `warning missing from the §7.3 union: ${JSON.stringify(r.verdict.warnings)}`,
  );
}

test("on_error: exported vocabulary", () => {
  assert.equal(OnError.Deny, "deny");
  assert.equal(OnError.Continue, "continue");
  assert.equal(HostWarning.ControlFailed, "host_warning:control_failed");
  for (const r of [HostError.InterceptorFailed, HostError.InterceptorTimeout, HostError.VerdictInvalid]) {
    assert.ok(isControlFailure(r), r);
  }
  for (const r of [
    HostError.ContextInvalid,
    HostError.ApprovalResolverFailed,
    HostError.TransformInvalid,
    HostError.NoInterceptor,
    "ctk:deny",
  ]) {
    assert.ok(!isControlFailure(r), r);
  }
});

test("on_error continue substitutes an allow for a raise", async () => {
  const { e, notices } = withNotifier();
  e.registerWithOptions(panics, bestEffort("defender"));
  e.register(scripted(Verdict.allow()), "audit");
  const c = ctx();
  const r = await e.emitUnchecked(c);
  assert.equal(r.verdict.decision, Decision.Allow);
  assert.equal("reason" in r.verdict, false);
  assert.equal(r.verdict.warnings.length, 1);
  assert.equal(r.verdicts.length, 2, "the fold continued past the failure");
  assertSubstituted(r, 0, "defender", HostError.InterceptorFailed);
  assert.equal("substituted_for" in r.verdicts[1], false);
  assert.equal(r.decided_by, null, "a substituted allow decides nothing");
  assert.equal(r.fold_truncated, false);
  assert.equal(c.target.url, "evil", "target unchanged");
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0], {
    interception_point: "pre_tool_call",
    index: 0,
    binding: "defender",
    reason: HostError.InterceptorFailed,
    message: "defender: host_error:interceptor_failed; host continued",
  });
  // §14: the exception text and the target never reach the record or
  // the notice.
  const all = JSON.stringify(r) + JSON.stringify(notices);
  assert.ok(!all.includes("SECRET") && !all.includes("evil"), all);
});

test("on_error continue substitutes an allow for an invalid verdict", async () => {
  const { e, notices } = withNotifier();
  e.registerWithOptions(malformed, bestEffort("defender"));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Allow);
  assertSubstituted(r, 0, "defender", HostError.VerdictInvalid);
  assert.equal(notices[0].reason, HostError.VerdictInvalid);
  // A non-finite number in the verdict is the same failure.
  const { e: e2 } = withNotifier();
  e2.registerWithOptions(scripted(transform("$target.url", Infinity)), bestEffort("nan"));
  const c = ctx();
  const r2 = await e2.emitUnchecked(c);
  assertSubstituted(r2, 0, "nan", HostError.VerdictInvalid);
  assert.equal(c.target.url, "evil", "corrupted transform never applied");
});

test("on_error continue substitutes an allow for a timeout", async () => {
  const { e, notices } = withNotifier(EnforcementMode.Enforce, null, 20);
  e.registerWithOptions(hangs, bestEffort("defender"));
  e.register(scripted(Verdict.allow()));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Allow);
  assert.equal(r.verdicts.length, 2);
  assertSubstituted(r, 0, "defender", HostError.InterceptorTimeout);
  assert.equal(notices[0].reason, HostError.InterceptorTimeout);
});

test("on_error: deny stays the default for every registration call", async () => {
  const { e, notices } = withNotifier();
  e.register(panics);
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Deny);
  assert.equal(r.verdict.reason, HostError.InterceptorFailed);
  assert.equal("substituted_for" in r.verdicts[0], false);
  assert.equal(r.decided_by, 0);
  assert.equal(notices.length, 0);

  const e2 = new InterceptionEmitter();
  e2.registerWithOptions(malformed, {});
  e2.registerWithOptions(malformed);
  const r2 = await e2.emitUnchecked(ctx());
  assert.equal(r2.verdict.reason, HostError.VerdictInvalid);
  assert.equal("substituted_for" in r2.verdicts[0], false);

  const e3 = new InterceptionEmitter();
  e3.registerWithOptions(panics, { name: "x", onError: OnError.Deny });
  const r3 = await e3.emitUnchecked(ctx());
  assert.equal(r3.verdict.reason, HostError.InterceptorFailed);
  assert.equal(r3.verdicts[0].name, "x");
});

test("on_error continue without a notifier is refused at registration", async () => {
  const e = new InterceptionEmitter();
  assert.throws(
    () => e.registerWithOptions(scripted(Verdict.allow()), bestEffort("x")),
    (err) => err instanceof RegistrationError && /control failure notifier/.test(err.message) && /x/.test(err.detail),
  );
  const managed = { interceptManaged: () => ({ outcome: "timeout" }) };
  assert.throws(() => e.registerManaged(managed, bestEffort("m")), RegistrationError);
  // Nothing was registered.
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.reason, HostError.NoInterceptor);
  assert.equal(r.interceptors_registered, 0);
  // Deny needs no channel; after the channel exists, continue is accepted.
  e.registerWithOptions(scripted(Verdict.allow()), {});
  e.setControlFailureNotifier(() => {});
  e.registerWithOptions(scripted(Verdict.allow()), bestEffort("x"));
  e.registerManaged(managed, bestEffort("m"));
  const r2 = await e.emitUnchecked(ctx());
  assert.equal(r2.interceptors_registered, 3);
});

test("on_error value and at are validated at registration", () => {
  const { e } = withNotifier();
  assert.throws(() => e.registerWithOptions(scripted(Verdict.allow()), { onError: "ignore" }), RangeError);
  assert.throws(() => e.registerWithOptions(scripted(Verdict.allow()), { at: ["pre_tool_cal"] }), RangeError);
  assert.throws(() => e.registerWithOptions(scripted(Verdict.allow()), { at: [] }), RangeError);
  assert.throws(() => e.setControlFailureNotifier("not a function"), TypeError);
  e.registerWithOptions(scripted(Verdict.allow()), { at: ["output"], onError: OnError.Deny });
});

test("a notifier that throws withdraws the continuation", async () => {
  // A principal that could not be told means the deny stands: silent
  // continuation is not reachable through a broken channel.
  const e = new InterceptionEmitter();
  e.setControlFailureNotifier(() => {
    throw new Error("channel down");
  });
  e.registerWithOptions(panics, bestEffort("defender"));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Deny);
  assert.equal(r.verdict.reason, HostError.InterceptorFailed);
  assert.match(r.verdict.message, /notifier/);
  assert.equal("substituted_for" in r.verdicts[0], false);
  assert.equal(r.verdict.warnings, undefined);
  assert.equal(r.decided_by, 0);
});

test("on_error continue never covers cancellation", async () => {
  const { e, notices } = withNotifier();
  e.registerManaged({ interceptManaged: () => ({ outcome: "cancelled" }) }, bestEffort("defender"));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Deny);
  assert.equal(r.verdict.reason, HostError.InterceptorFailed);
  assert.match(r.verdict.message, /cancelled/);
  assert.equal("substituted_for" in r.verdicts[0], false);
  assert.equal(r.decided_by, 0);
  assert.equal(notices.length, 0);
});

test("on_error continue never covers approval failures", async () => {
  const raises = {
    resolve() {
      throw new Error("resolver down");
    },
  };
  const { e, notices } = withNotifier(EnforcementMode.Enforce, raises);
  e.registerWithOptions(scripted(Verdict.escalate("check")), bestEffort("gate"));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Deny);
  assert.equal(r.verdict.reason, HostError.ApprovalResolverFailed);
  assert.equal(r.resolved_by, "rejection");
  assert.equal("substituted_for" in r.verdicts[0], false);
  assert.equal(notices.length, 0);
  // Echo violation: the same.
  const badEcho = {
    resolve: () => ({ outcome: "approve", context_identity: "sha256:forged", verdict: Verdict.allow() }),
  };
  const { e: e2 } = withNotifier(EnforcementMode.Enforce, badEcho);
  e2.registerWithOptions(scripted(Verdict.escalate()), bestEffort("gate"));
  const r2 = await e2.emitUnchecked(ctx());
  assert.equal(r2.verdict.reason, HostError.ApprovalIdentityMismatch);
  // Resolver timeout: the same.
  const slow = { resolve: () => new Promise(() => {}) };
  const { e: e3 } = withNotifier(EnforcementMode.Enforce, slow, 20);
  e3.registerWithOptions(scripted(Verdict.escalate()), bestEffort("gate"));
  const r3 = await e3.emitUnchecked(ctx());
  assert.equal(r3.verdict.reason, HostError.ApprovalResolverFailed);
  assert.equal(r3.verdict.message, "timeout");
});

test("on_error continue never covers context failure, an explicit deny or no_interceptor", async () => {
  const { e, notices } = withNotifier();
  e.registerWithOptions(panics, bestEffort("defender"));
  // Context failure: the provider rejects the value domain before any
  // interceptor runs.
  const big = ctx();
  big.target = { id: 9007199254740992 };
  const r = await e.emitUnchecked(big);
  assert.equal(r.verdict.reason, HostError.ContextInvalid);
  assert.equal(r.verdicts, undefined);
  // Invalid envelope: the same.
  const bare = ctx();
  delete bare.spec;
  const r2 = await e.emitUnchecked(bare);
  assert.equal(r2.verdict.reason, HostError.ContextInvalid);
  // An explicit deny is a decision, not a failure.
  const { e: e2 } = withNotifier();
  e2.registerWithOptions(scripted(Verdict.deny("policy")), bestEffort("policy"));
  const r3 = await e2.emitUnchecked(ctx());
  assert.equal(r3.verdict.decision, Decision.Deny);
  assert.equal(r3.verdict.reason, "policy");
  assert.equal("substituted_for" in r3.verdicts[0], false);
  // No interceptor at the point: the §7 deny, continue or not.
  const { e: e3 } = withNotifier();
  e3.registerWithOptions(scripted(Verdict.allow()), { ...bestEffort("output-only"), at: ["output"] });
  const r4 = await e3.emitUnchecked(ctx());
  assert.equal(r4.verdict.reason, HostError.NoInterceptor);
  assert.equal(notices.length, 0);
});

test("on_error continue never covers transform failure", async () => {
  const { e, notices } = withNotifier();
  // A well-formed transform whose path does not resolve fails to
  // apply (§5.2, §7.4), not §6.3: the deny stands.
  e.registerWithOptions(scripted(transform("$target.missing.deep.path", "x")), bestEffort("rewrite"));
  const c = ctx();
  const r = await e.emitUnchecked(c);
  assert.equal(r.verdict.decision, Decision.Deny);
  assert.match(r.verdict.reason, /^host_error:transform_/);
  assert.equal(r.decided_by, null);
  assert.equal("substituted_for" in r.verdicts[0], false);
  assert.equal(c.target.url, "evil");
  assert.equal(notices.length, 0);
  // A transform rooted outside $target never passes the §5 gate, so it
  // is the invalid-verdict failure, which continue does cover.
  const { e: e2 } = withNotifier();
  e2.registerWithOptions(scripted(transform("$other.url", "x")), bestEffort("rewrite"));
  const r2 = await e2.emitUnchecked(ctx());
  assertSubstituted(r2, 0, "rewrite", HostError.VerdictInvalid);
});

test("the substituted allow takes the slot in every profile", async () => {
  for (const composition of [Composition.runAll(), Composition.strictest("deny"), Composition.unanimous("deny", "deny")]) {
    const { e, notices } = withNotifier();
    e.setComposition(composition);
    e.register(scripted(Verdict.warn("pii")));
    e.registerWithOptions(panics, bestEffort("defender"));
    const r = await e.emitUnchecked(ctx());
    assert.equal(r.verdict.decision, Decision.Allow, JSON.stringify([composition, r.verdict]));
    // §7.3: both warnings, first seen first.
    assert.equal(r.verdict.warnings.length, 2, composition.profile);
    assert.equal(r.verdict.warnings[0].reason, "pii");
    assertSubstituted(r, 1, "defender", HostError.InterceptorFailed);
    assert.equal("substituted_for" in r.verdicts[0], false);
    assert.equal(r.decided_by, null);
    assert.equal(notices.length, 1, composition.profile);
  }
  // A plain deny elsewhere still wins; the substituted slot keeps its
  // warning in the union and its substituted_for, and the principal is
  // told even though the action does not proceed.
  const { e, notices } = withNotifier();
  e.setComposition(Composition.runAll());
  e.registerWithOptions(panics, bestEffort("defender"));
  e.register(scripted(deny()));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Deny);
  assert.equal(r.decided_by, 1);
  assert.equal(r.verdicts[0].substituted_for, HostError.InterceptorFailed);
  assert.equal(r.verdict.warnings[0].reason, HostWarning.ControlFailed);
  assert.equal(notices.length, 1);
});

test("first_deny: the substituted slot does not short-circuit", async () => {
  const { e } = withNotifier();
  e.registerWithOptions(panics, bestEffort("defender"));
  e.register(scripted(deny()), "guard");
  e.register(scripted(Verdict.allow()), "never");
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Deny);
  assert.equal(r.decided_by, 1);
  assert.equal(r.fold_truncated, true);
  assert.equal(r.verdicts.length, 2);
  assert.equal(r.verdicts[0].substituted_for, HostError.InterceptorFailed);
  assert.equal(r.verdict.warnings[0].reason, HostWarning.ControlFailed);
});

test("an unnamed continue registration is labelled by its index", async () => {
  const { e, notices } = withNotifier();
  e.register(scripted(Verdict.allow()));
  e.registerWithOptions(panics, { onError: OnError.Continue });
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdicts[1].substituted_for, HostError.InterceptorFailed);
  assert.equal("name" in r.verdicts[1], false);
  assert.equal(notices[0].binding, "interceptor-1");
  assert.equal(r.verdict.warnings[0].message, "interceptor-1: host_error:interceptor_failed; host continued");
});

test("an interceptor cannot emit the reserved warning", async () => {
  const spoof = { decision: "allow", warnings: [{ reason: HostWarning.ControlFailed, message: "looks substituted" }] };
  assert.throws(() => validateVerdict(spoof), (e) => e instanceof AgentHooksCoreError && e.code === HostError.VerdictInvalid);
  const e = new InterceptionEmitter();
  e.register(scripted(spoof));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Deny);
  assert.equal(r.verdict.reason, HostError.VerdictInvalid);
  assert.equal(r.verdict.warnings, undefined, "the spoofed warning is dropped");
  // Under continue the spoof is still an invalid verdict; what the
  // record shows is the host's own substitution, with the real reason.
  const { e: e2 } = withNotifier();
  e2.registerWithOptions(scripted(spoof), bestEffort("spoofer"));
  const r2 = await e2.emitUnchecked(ctx());
  assert.equal(r2.verdict.decision, Decision.Allow);
  assertSubstituted(r2, 0, "spoofer", HostError.VerdictInvalid);
  assert.equal(r2.verdict.warnings[0].message, "spoofer: host_error:verdict_invalid; host continued");
});

test("managed interceptor receives the bound and reports typed outcomes", async () => {
  const bounds = [];
  const outcomes = [];
  const managed = {
    interceptManaged(c, boundMs) {
      bounds.push(boundMs);
      assert.equal(c.target.url, "evil");
      return outcomes.shift();
    },
  };
  // The emitter-wide bound is handed through; the emitter does not
  // race the call against a second timer.
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null, 1234);
  e.registerManaged(managed, { name: "proc" });
  outcomes.push({ outcome: "verdict", verdict: Verdict.warn("scanned") });
  let r = await e.emitUnchecked(ctx());
  assert.deepEqual(bounds, [1234]);
  assert.equal(r.verdict.decision, Decision.Allow);
  assert.equal(r.verdict.warnings[0].reason, "scanned");
  assert.equal(r.verdicts[0].name, "proc");
  // The managed verdict crosses the §5 gate like any other.
  outcomes.push({ outcome: "verdict", verdict: { decision: "allow", reason: "host_error:forged" } });
  r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.reason, HostError.VerdictInvalid);
  // Typed failures under the default posture: all deny, attributed.
  outcomes.push({ outcome: "timeout" });
  r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.reason, HostError.InterceptorTimeout);
  assert.equal(r.decided_by, 0);
  outcomes.push({ outcome: "failed", detail: "ECONNRESET" });
  r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.reason, HostError.InterceptorFailed);
  assert.equal(r.verdict.message, "ECONNRESET");
  outcomes.push({ outcome: "cancelled" });
  r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.reason, HostError.InterceptorFailed);
  // A value that is not a typed outcome fails validation.
  outcomes.push({ decision: "allow" });
  r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.reason, HostError.VerdictInvalid);
  // A managed interceptor that throws is a raise.
  const thrower = new InterceptionEmitter();
  thrower.registerManaged({ interceptManaged: () => Promise.reject(new TypeError("x")) });
  r = await thrower.emitUnchecked(ctx());
  assert.equal(r.verdict.reason, HostError.InterceptorFailed);
  assert.equal(r.verdict.message, "TypeError");
  // `null` timeout: unbounded, handed through as null.
  const unbounded = new InterceptionEmitter(EnforcementMode.Enforce, null, null);
  unbounded.registerManaged(managed);
  outcomes.push({ outcome: "verdict", verdict: Verdict.allow() });
  await unbounded.emitUnchecked(ctx());
  assert.equal(bounds.at(-1), null);
});

test("managed interceptor is not wrapped in a second timer", async () => {
  // A 60 ms managed call under a 20 ms emitter bound still returns its
  // verdict: the deadline is the interceptor's to keep.
  const e = new InterceptionEmitter(EnforcementMode.Enforce, null, 20);
  let seen = null;
  e.registerManaged({
    interceptManaged: (c, boundMs) =>
      new Promise((resolve) => {
        seen = boundMs;
        setTimeout(() => resolve({ outcome: "verdict", verdict: Verdict.allow() }), 60);
      }),
  });
  const r = await e.emitUnchecked(ctx());
  assert.equal(seen, 20);
  assert.equal(r.verdict.decision, Decision.Allow);
});

test("managed timeout and failed follow on_error; cancelled does not", async () => {
  const outcomes = [];
  const { e, notices } = withNotifier();
  e.registerManaged({ interceptManaged: () => outcomes.shift() }, bestEffort("proc"));
  e.register(scripted(Verdict.allow()), "audit");
  outcomes.push({ outcome: "timeout" });
  let r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Allow);
  assertSubstituted(r, 0, "proc", HostError.InterceptorTimeout);
  assert.equal(r.verdicts.length, 2);
  outcomes.push({ outcome: "failed", detail: "ECONNRESET" });
  r = await e.emitUnchecked(ctx());
  assertSubstituted(r, 0, "proc", HostError.InterceptorFailed);
  assert.ok(!JSON.stringify(r).includes("ECONNRESET"), "the detail stays out of the substituted shape");
  outcomes.push({ outcome: "verdict", verdict: { decision: "transform" } });
  r = await e.emitUnchecked(ctx());
  assertSubstituted(r, 0, "proc", HostError.VerdictInvalid);
  assert.equal(notices.length, 3);
  outcomes.push({ outcome: "cancelled" });
  r = await e.emitUnchecked(ctx());
  assert.equal(r.verdict.decision, Decision.Deny);
  assert.equal(r.verdict.reason, HostError.InterceptorFailed);
  assert.equal(r.verdicts.length, 1, "a deny short-circuits first_deny");
  assert.equal(notices.length, 3, "no notice for a cancellation");
});

test("evaluate_only: a continuation is recorded the same way", async () => {
  const { e, notices } = withNotifier(EnforcementMode.EvaluateOnly);
  e.registerWithOptions(panics, bestEffort("defender"));
  const r = await e.emitUnchecked(ctx());
  assert.equal(r.mode, "evaluate_only");
  assertSubstituted(r, 0, "defender", HostError.InterceptorFailed);
  assert.equal(notices.length, 1);
});
