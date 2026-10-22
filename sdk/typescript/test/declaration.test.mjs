// Copyright (c) Microsoft. All rights reserved.

// Host declaration document (spec §7.7): the loader, the registry, the
// three construction paths, sealing, record stamping and the refusal
// classes a vector cannot express (HARNESS.md "Coverage boundaries").
// Mirrors sdk/rust/core/tests/declaration.rs.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAPABILITIES,
  DECLARATION_VERSION,
  DeclarationBuilder,
  DeclarationError,
  DeclarationErrorClass,
  EmitterSealed,
  EnforcementMode,
  HostDeclaration,
  HostRegistry,
  HostRegistryError,
  HostSurface,
  InterceptionEmitter,
  MAX_DETAIL_LEN,
  MAX_DOCUMENT_BYTES,
  SUPPORTED_DECLARATION_VERSIONS,
  canonicalDeclaration,
  declarationVersions,
} from "../dist/index.js";
import { builderFromValue } from "../dist/ctk/index.js";

// 1.0 documents: they load unchanged under the 1.1 loader (§7.7.2).
const V = "agent-hooks-declaration/1.0";
// The current contract version, which the builder writes by default.
const V11 = "agent-hooks-declaration/1.1";

const ctx = (point = "pre_tool_call", seq = 0) => ({
  spec: "agent-hooks/0.1",
  interception_point: point,
  timestamp: "t",
  sequence: seq,
  agent: { id: "a", framework: "x" },
  session: { id: "s" },
  target: { url: "evil" },
  tool_call: { id: "tc", name: "t", args: { url: "evil" } },
});

const startup = (seq = 0) => ({
  spec: "agent-hooks/0.1",
  interception_point: "agent_startup",
  timestamp: "t",
  sequence: seq,
  agent: { id: "a", framework: "x" },
  session: { id: "s" },
  target: { tools_registered: [] },
  agent_init: { tools_registered: [] },
});

const allow = { intercept: () => ({ decision: "allow" }) };
const denyAll = { intercept: () => ({ decision: "deny", reason: "x:no" }) };

/** A full-surface registry with one allow kind and one deny kind. */
function registry(extra = (r) => r) {
  const surface = HostSurface.fromCapabilities(["model_calls", "tool_calls", "host_declaration"]);
  return extra(
    new HostRegistry(surface)
      .kind("com.example.allow", () => allow)
      .kind("com.example.deny", () => denyAll),
  );
}

const minimal = () => ({
  declaration: V,
  bindings: [{ id: "allow", kind: "com.example.allow" }],
});

function refused(fn, code, pointer) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof DeclarationError, `expected DeclarationError, got ${err}`);
  assert.equal(err.code, code);
  if (pointer !== undefined) {
    assert.ok(
      err.findings.some((f) => f.pointer === pointer),
      `no finding at ${pointer}: ${JSON.stringify(err.findings)}`,
    );
  }
  return err;
}

async function refusedAsync(fn, code) {
  let err;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof DeclarationError, `expected DeclarationError, got ${err}`);
  assert.equal(err.code, code);
  return err;
}

// ---- versions ----------------------------------------------------------------

test("declaration version constants match the core", () => {
  const v = declarationVersions();
  assert.equal(DECLARATION_VERSION, v.current);
  assert.deepEqual([...SUPPORTED_DECLARATION_VERSIONS], v.supported);
  assert.equal(DECLARATION_VERSION, V11);
  assert.deepEqual([...SUPPORTED_DECLARATION_VERSIONS], [V, V11]);
});

test("capability vocabulary is the closed list", () => {
  assert.deepEqual(
    [...CAPABILITIES].sort(),
    [
      "bigint_json",
      "host_declaration",
      "incremental_output",
      "int64_json",
      "model_calls",
      "multi_turn",
      "parallel_tool_calls",
      "streaming",
      "tool_calls",
    ],
  );
});

// ---- the three paths and the builder --------------------------------------------

test("minimal document loads with every default filled", () => {
  const em = InterceptionEmitter.fromDeclarationValue(minimal(), registry());
  const d = em.declaration;
  assert.equal(d.declaration, V);
  assert.equal(d.spec, "agent-hooks/0.1");
  assert.deepEqual(d.configuration.composition, {
    profile: "sequential/first_deny",
    on_approval: "stop",
  });
  assert.equal(d.configuration.mode, "enforce");
  assert.equal(d.configuration.identity_provider, "jcs-sha256");
  assert.deepEqual(d.configuration.approval, { resolver: null, redactor: null });
  assert.deepEqual(d.configuration.timeouts, { interceptor_ms: 5000, approval_resolver_ms: 5000 });
  assert.deepEqual(d.configuration.records, { max_buffered: null });
  assert.equal(d.bindings.length, 1);
  assert.equal(d.bindings[0].at.length, 8);
  assert.equal(d.bindings[0].timeout_ms, 5000);
  assert.deepEqual(d.surface.capabilities, ["host_declaration", "model_calls", "tool_calls"]);
});

test("value, JSON, file and builder paths resolve to one canonical form", async () => {
  const doc = {
    declaration: V,
    configuration: { composition: { profile: "parallel/strictest" }, timeouts: { interceptor_ms: 4000 } },
    bindings: [
      { id: "audit", kind: "com.example.allow", timeout_ms: 2000 },
      { id: "rewrite", kind: "com.example.deny", at: ["pre_tool_call", "output"] },
    ],
  };
  const reg = registry();
  const text = JSON.stringify(doc);
  const dir = mkdtempSync(join(tmpdir(), "agent-hooks-decl-"));
  try {
    const path = join(dir, "decl.json");
    writeFileSync(path, text, "utf8");
    const builder = HostDeclaration.builder()
      .version(V)
      .composition({ profile: "parallel/strictest" })
      .interceptorTimeoutMs(4000)
      .bind("audit", "com.example.allow", undefined, undefined, 2000)
      .bind("rewrite", "com.example.deny", undefined, ["output", "pre_tool_call"]);
    const emitters = [
      InterceptionEmitter.fromDeclarationValue(doc, reg),
      InterceptionEmitter.fromDeclarationJson(text, reg),
      await InterceptionEmitter.fromDeclarationPath(path, reg),
      InterceptionEmitter.fromDeclaration(builder.build(), reg),
    ];
    const forms = emitters.map((e) => canonicalDeclaration(e.declaration));
    for (const f of forms) assert.equal(f, forms[0]);
    // Equal resolved declarations and equal registries yield
    // byte-identical records (§7.7.7).
    const records = [];
    for (const e of emitters) {
      const r = await e.emitUnchecked(ctx());
      records.push(JSON.stringify(r));
    }
    for (const r of records) assert.equal(r, records[0]);
    const r0 = JSON.parse(records[0]);
    assert.equal(r0.declaration, V);
    assert.equal(r0.composition.on_transform_conflict, "deny");
    assert.equal(r0.interceptors_registered, 2);
    assert.equal(r0.verdicts[0].name, "audit");
    assert.equal(r0.verdicts[1].name, "rewrite");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("builderFromValue keeps an explicit config: null", () => {
  // `null` is a value the spec allows for `config`; only an absent
  // member takes the `{}` default. The builder path must agree with
  // the value path, as it does in the Rust runner.
  const doc = { declaration: V, bindings: [{ id: "a", kind: "com.example.allow", config: null }] };
  const reg = registry();
  const viaValue = InterceptionEmitter.fromDeclarationValue(doc, reg);
  const viaBuilder = InterceptionEmitter.fromDeclaration(builderFromValue(doc).build(), reg);
  assert.equal(canonicalDeclaration(viaBuilder.declaration), canonicalDeclaration(viaValue.declaration));
  assert.equal(viaValue.declaration.bindings[0].config, null);
});

const configKey = (key) =>
  `{"declaration":"${V}","bindings":[{"id":"a","kind":"com.example.allow","config":{"key":${key}}}]}`;

test("an integer above 2^53 - 1 anywhere in the document is refused at its pointer", () => {
  // #129: `config` is opaque to the loader except for the integer
  // domain (§7.7.6). The text path sees the token as written, so a
  // value JSON.parse would round is refused before anything rounds it.
  const invalid = "declaration_error:invalid_field";
  for (const key of ["9007199254740992", "-9007199254740992", "18446744073709551615", "18446744073709551616"]) {
    const e = refused(() => HostDeclaration.fromJson(configKey(key)), invalid, "/bindings/0/config/key");
    assert.equal(e.findings.length, 1);
    assert.ok(!e.findings[0].detail.includes(key), e.findings[0].detail);
    refused(() => InterceptionEmitter.fromDeclarationJson(configKey(key), registry()), invalid, "/bindings/0/config/key");
  }
  // 2^53 is the smallest refused magnitude and still exact in
  // JavaScript, so the value path reaches the core with the same token.
  refused(
    () => InterceptionEmitter.fromDeclarationValue(JSON.parse(configKey("9007199254740992")), registry()),
    invalid,
    "/bindings/0/config/key",
  );
});

test("an integer at the bound (2^53 - 1) inside a binding config loads and canonicalises", () => {
  const text = configKey("9007199254740991");
  const decl = HostDeclaration.fromJson(text);
  assert.ok(decl.toJson().includes("9007199254740991"));
  assert.equal(decl.toValue().bindings[0].config.key, 9007199254740991);
  for (const em of [
    InterceptionEmitter.fromDeclarationJson(text, registry()),
    InterceptionEmitter.fromDeclarationValue(JSON.parse(text), registry()),
  ]) {
    assert.equal(em.declaration.bindings[0].config.key, 9007199254740991);
    assert.ok(canonicalDeclaration(em.declaration).includes('"key":9007199254740991'));
  }
});

test("builder writes what a file would and is validated like one", () => {
  const b = new DeclarationBuilder()
    .spec("agent-hooks/0.1")
    .id("prod")
    .host("example-runtime", "3.2.0")
    .mode(EnforcementMode.EvaluateOnly)
    .composition({ profile: "parallel/unanimous", on_disagreement: "approval" })
    .identityProvider("jcs-sha256")
    .approvalResolver(null)
    .approvalRedactor(null)
    .toolSeamHostError("continue")
    .interceptorTimeoutMs(5000)
    .approvalResolverTimeoutMs(30000)
    .maxBufferedRecords(10)
    .surfacePoints(["agent_startup", "input", "output", "agent_shutdown"])
    .surfaceCapabilities(["host_declaration"])
    .surfaceProfile("parallel/unanimous", { on_disagreement: ["deny", "approval"] })
    .bufferedOutput(true)
    .surfaceDeclarationVersions([V, V11])
    .bind("a", "com.example.allow", { x: 1 })
    .extension("acme", { note: "kept verbatim" });
  const value = b.toValue();
  assert.equal(value.declaration, V11);
  assert.deepEqual(value.host, { name: "example-runtime", version: "3.2.0" });
  assert.deepEqual(value.configuration.composition, {
    profile: "parallel/unanimous",
    on_disagreement: "approval",
  });
  assert.deepEqual(value.extensions, { acme: { note: "kept verbatim" } });
  const em = InterceptionEmitter.fromDeclaration(b.build(), registry());
  assert.equal(em.declaration.configuration.mode, "evaluate_only");
  assert.deepEqual(em.declaration.extensions, { acme: { note: "kept verbatim" } });
  // An unknown member set through raw() is refused like a file.
  refused(
    () => new DeclarationBuilder().raw("policy", {}).build(),
    DeclarationErrorClass.UnknownField,
    "/policy",
  );
});

// ---- records -----------------------------------------------------------------------

test("records stamp declaration iff declaration-built; code path is unchanged", async () => {
  const declared = InterceptionEmitter.fromDeclarationValue(minimal(), registry());
  const r1 = await declared.emitUnchecked(ctx());
  assert.equal(r1.declaration, V);
  assert.equal(r1.verdicts[0].name, "allow");
  const legacy = new InterceptionEmitter();
  legacy.register(allow);
  const r2 = await legacy.emitUnchecked(ctx());
  assert.ok(!("declaration" in r2));
  assert.ok(!("name" in r2.verdicts[0]));
  // Host projection failure records stamp it too (§7.7.8).
  const hf = declared.recordHostFailure("input", { detail: "TypeError" });
  assert.equal(hf.declaration, V);
  assert.equal(hf.interceptors_registered, 1);
  const hf2 = legacy.recordHostFailure("input", { detail: "TypeError" });
  assert.ok(!("declaration" in hf2));
});

test("per-point bindings count and index only what runs at the point", async () => {
  const doc = {
    declaration: V,
    bindings: [
      { id: "a", kind: "com.example.deny", at: ["pre_tool_call"] },
      { id: "b", kind: "com.example.allow" },
    ],
  };
  const em = InterceptionEmitter.fromDeclarationValue(doc, registry());
  const s = await em.emitUnchecked(startup(0));
  assert.equal(s.interceptors_registered, 1);
  assert.equal(s.verdicts[0].name, "b");
  assert.equal(s.verdict.decision, "allow");
  const t = await em.emitUnchecked(ctx("pre_tool_call", 1));
  assert.equal(t.interceptors_registered, 2);
  assert.equal(t.decided_by, 0);
  assert.equal(t.verdicts[0].name, "a");
  assert.equal(t.verdict.decision, "deny");
  assert.equal(t.fold_truncated, true);
});

test("register(at) filters the code path the same way", async () => {
  const em = new InterceptionEmitter();
  em.register(denyAll, "a", ["pre_tool_call"]).register(allow, "b");
  const s = await em.emitUnchecked(startup(0));
  assert.equal(s.interceptors_registered, 1);
  assert.equal(s.verdicts[0].name, "b");
  const t = await em.emitUnchecked(ctx("pre_tool_call", 1));
  assert.equal(t.interceptors_registered, 2);
  assert.equal(t.verdict.decision, "deny");
  assert.ok(!("declaration" in t));
});

test("a surface point with no binding denies host_error:no_interceptor", async () => {
  const doc = {
    declaration: V,
    bindings: [{ id: "only-tools", kind: "com.example.allow", at: ["pre_tool_call"] }],
  };
  const em = InterceptionEmitter.fromDeclarationValue(doc, registry());
  const s = await em.emitUnchecked(startup());
  assert.equal(s.verdict.reason, "host_error:no_interceptor");
  assert.equal(s.interceptors_registered, 0);
  assert.equal(s.declaration, V);
});

// ---- sealing -------------------------------------------------------------------------

test("a declaration-built emitter is sealed", () => {
  const em = InterceptionEmitter.fromDeclarationValue(minimal(), registry());
  assert.throws(() => em.register(allow), EmitterSealed);
  assert.throws(() => em.setComposition({ profile: "sequential/run_all" }), EmitterSealed);
  assert.throws(() => em.setIdentityProvider(null), EmitterSealed);
  assert.throws(() => em.setApprovalRedactor((c) => c), EmitterSealed);
  assert.throws(() => em.setMaxRecords(1), EmitterSealed);
  // Delivery, not content: still allowed (§7.7.7).
  em.setRecordSink(() => {});
  assert.deepEqual(em.takeRecords(), []);
});

test("writing through emitter.declaration changes nothing", async () => {
  const doc = {
    declaration: V,
    bindings: [
      { id: "a", kind: "com.example.deny" },
      { id: "b", kind: "com.example.allow" },
    ],
  };
  const em = InterceptionEmitter.fromDeclarationValue(doc, registry());
  const decl = em.declaration;
  assert.ok(Object.isFrozen(decl));
  assert.ok(Object.isFrozen(decl.configuration.composition));
  assert.ok(Object.isFrozen(decl.bindings[0].at));
  assert.ok(Object.isFrozen(decl.surface.interception_points));
  // Frozen objects swallow writes in sloppy mode and throw in strict
  // mode; either way the value must not move.
  assert.throws(() => {
    decl.configuration.composition.profile = "sequential/run_all";
  }, TypeError);
  assert.throws(() => {
    decl.bindings[0].at.push("agent_startup");
  }, TypeError);
  assert.equal(decl.configuration.composition.profile, "sequential/first_deny");
  const before = canonicalDeclaration(decl);
  const r = await em.emitUnchecked(ctx());
  assert.equal(r.composition.profile, "sequential/first_deny");
  assert.equal(r.verdicts.length, 1);
  assert.equal(r.fold_truncated, true);
  assert.equal(canonicalDeclaration(em.declaration), before);
});

test("a kind resolver cannot widen its binding through the context", async () => {
  let seen;
  const reg = registry((r) =>
    r.kind("com.example.widen", (_config, context) => {
      seen = context.at;
      assert.ok(Object.isFrozen(context.at));
      assert.throws(() => context.at.push("agent_startup"), TypeError);
      return allow;
    }),
  );
  const doc = {
    declaration: V,
    bindings: [{ id: "narrow", kind: "com.example.widen", at: ["pre_tool_call"] }],
  };
  const em = InterceptionEmitter.fromDeclarationValue(doc, reg);
  assert.deepEqual([...seen], ["pre_tool_call"]);
  assert.deepEqual(em.declaration.bindings[0].at, ["pre_tool_call"]);
  const s = await em.emitUnchecked(startup(0));
  assert.equal(s.interceptors_registered, 0);
  assert.equal(s.verdict.reason, "host_error:no_interceptor");
  const t = await em.emitUnchecked(ctx("pre_tool_call", 1));
  assert.equal(t.interceptors_registered, 1);
  assert.equal(t.verdict.decision, "allow");
});

test("register(at) refuses an empty point set", () => {
  const em = new InterceptionEmitter();
  assert.throws(() => em.register(allow, "a", []), RangeError);
  assert.throws(() => em.register(allow, "a", new Set()), RangeError);
  assert.equal(em.records.length, 0);
});

test("the builder refuses a __proto__ key the same way the value path does", () => {
  refused(
    () => HostDeclaration.fromValue({ ...minimal(), extensions: JSON.parse('{"__proto__": 1}') }),
    DeclarationErrorClass.InvalidField,
    "/extensions/__proto__",
  );
  refused(
    () => new DeclarationBuilder().bind("allow", "com.example.allow").extension("__proto__", 1).build(),
    DeclarationErrorClass.InvalidField,
    "/extensions/__proto__",
  );
  refused(
    () => new DeclarationBuilder().bind("allow", "com.example.allow").raw("__proto__", {}).build(),
    DeclarationErrorClass.UnknownField,
    "/__proto__",
  );
  const built = new DeclarationBuilder().raw("__proto__", {}).toValue();
  assert.ok(Object.hasOwn(built, "__proto__"));
});

// ---- refusal classes -----------------------------------------------------------------

test("version_unsupported: reserved major, missing, higher minor, non-string", () => {
  for (const declaration of [
    "agent-hooks-declaration/0.1",
    "agent-hooks-declaration/1.2",
    "agent-hooks-declaration/1.9",
    1,
    undefined,
  ]) {
    const doc = { ...minimal() };
    if (declaration === undefined) delete doc.declaration;
    else doc.declaration = declaration;
    const err = refused(
      () => HostDeclaration.fromValue(doc),
      DeclarationErrorClass.VersionUnsupported,
      "/declaration",
    );
    assert.deepEqual(err.accepted, [V, V11]);
    assert.match(err.message, /accepted: agent-hooks-declaration\/1\.0, agent-hooks-declaration\/1\.1/);
  }
});

test("spec_unsupported", () => {
  refused(
    () => HostDeclaration.fromValue({ ...minimal(), spec: "agent-hooks/9.0" }),
    DeclarationErrorClass.SpecUnsupported,
    "/spec",
  );
});

test("unknown_field at the top level and nested", () => {
  refused(
    () => HostDeclaration.fromValue({ ...minimal(), policy: {} }),
    DeclarationErrorClass.UnknownField,
    "/policy",
  );
  refused(
    () =>
      HostDeclaration.fromValue({
        ...minimal(),
        configuration: { composition: { profile: "sequential/first_deny", on_timeout: "deny" } },
      }),
    DeclarationErrorClass.UnknownField,
    "/configuration/composition/on_timeout",
  );
});

test("invalid_field", () => {
  refused(
    () => HostDeclaration.fromValue({ ...minimal(), configuration: { mode: "audit" } }),
    DeclarationErrorClass.InvalidField,
    "/configuration/mode",
  );
  refused(
    () => HostDeclaration.fromValue({ ...minimal(), configuration: { timeouts: { interceptor_ms: 0 } } }),
    DeclarationErrorClass.InvalidField,
    "/configuration/timeouts/interceptor_ms",
  );
});

test("inconsistent: unconsulted knob, floor, duplicate id", () => {
  refused(
    () =>
      HostDeclaration.fromValue({
        ...minimal(),
        configuration: { composition: { profile: "sequential/run_all", on_approval: "resume" } },
      }),
    DeclarationErrorClass.Inconsistent,
    "/configuration/composition/on_approval",
  );
  refused(
    () =>
      HostDeclaration.fromValue({
        ...minimal(),
        surface: {
          interception_points: ["agent_startup", "input", "pre_tool_call", "post_tool_call", "output"],
        },
      }),
    DeclarationErrorClass.Inconsistent,
    "/surface/interception_points",
  );
  refused(
    () =>
      HostDeclaration.fromValue({
        declaration: V,
        bindings: [
          { id: "a", kind: "com.example.allow" },
          { id: "a", kind: "com.example.allow" },
        ],
      }),
    DeclarationErrorClass.Inconsistent,
    "/bindings/1/id",
  );
});

test("surface_unsupported against a narrowed host surface", () => {
  // The floor-only SDK default: no tool or model points.
  const narrow = new HostRegistry(HostSurface.sdkDefault()).kind("com.example.allow", () => allow);
  refused(
    () =>
      InterceptionEmitter.fromDeclarationValue(
        {
          ...minimal(),
          surface: {
            interception_points: [
              "agent_startup",
              "input",
              "pre_tool_call",
              "post_tool_call",
              "output",
              "agent_shutdown",
            ],
            capabilities: ["host_declaration", "tool_calls"],
          },
        },
        narrow,
      ),
    DeclarationErrorClass.SurfaceUnsupported,
    "/surface/interception_points",
  );
  refused(
    () =>
      InterceptionEmitter.fromDeclarationValue(
        { ...minimal(), configuration: { posture: { tool_seam_host_error: "terminate" } } },
        narrow,
      ),
    DeclarationErrorClass.SurfaceUnsupported,
    "/configuration/posture/tool_seam_host_error",
  );
  refused(
    () =>
      InterceptionEmitter.fromDeclarationValue(
        { ...minimal(), surface: { declaration_versions: [V, "agent-hooks-declaration/0.1"] } },
        narrow,
      ),
    DeclarationErrorClass.SurfaceUnsupported,
  );
  // A binding at a point outside the filled surface: step 7 runs again
  // on the host's surface once the absent `surface` is filled from it.
  refused(
    () =>
      InterceptionEmitter.fromDeclarationValue(
        { declaration: V, bindings: [{ id: "a", kind: "com.example.allow", at: ["pre_tool_call"] }] },
        narrow,
      ),
    DeclarationErrorClass.Inconsistent,
    "/bindings/0/at",
  );
  // Absent surface resolves to the host's own, never past it.
  const em = InterceptionEmitter.fromDeclarationValue(minimal(), narrow);
  assert.deepEqual(em.declaration.surface.interception_points, [
    "agent_startup",
    "input",
    "output",
    "agent_shutdown",
  ]);
  assert.deepEqual(em.declaration.surface.capabilities, ["host_declaration"]);
});

test("reference_unresolved, kind_unknown, binding_rejected", () => {
  refused(
    () =>
      InterceptionEmitter.fromDeclarationValue(
        { ...minimal(), configuration: { identity_provider: "hmac-sha256-k1" } },
        registry(),
      ),
    DeclarationErrorClass.ReferenceUnresolved,
    "/configuration/identity_provider",
  );
  refused(
    () =>
      InterceptionEmitter.fromDeclarationValue(
        { ...minimal(), configuration: { approval: { resolver: "operator-queue" } } },
        registry(),
      ),
    DeclarationErrorClass.ReferenceUnresolved,
    "/configuration/approval/resolver",
  );
  refused(
    () =>
      InterceptionEmitter.fromDeclarationValue(
        { declaration: V, bindings: [{ id: "x", kind: "com.example.nonexistent" }] },
        registry(),
      ),
    DeclarationErrorClass.KindUnknown,
    "/bindings/0/kind",
  );
  // All kinds are checked before any resolver runs (§7.7.6 step 10).
  let ran = false;
  const reg = registry((r) =>
    r.kind("com.example.counting", () => {
      ran = true;
      return allow;
    }),
  );
  refused(
    () =>
      InterceptionEmitter.fromDeclarationValue(
        {
          declaration: V,
          bindings: [
            { id: "a", kind: "com.example.counting" },
            { id: "b", kind: "com.example.nonexistent" },
          ],
        },
        reg,
      ),
    DeclarationErrorClass.KindUnknown,
    "/bindings/1/kind",
  );
  assert.equal(ran, false);
  // A resolver that throws, or returns a non-interceptor, refuses the
  // document; the message names the id and the kind, never the config.
  const bad = registry((r) =>
    r
      .kind("com.example.throws", (config) => {
        throw new Error(`unsupported option ${Object.keys(config).join(",")}`);
      })
      .kind("com.example.wrong", () => ({ notAnInterceptor: true })),
  );
  const e1 = refused(
    () =>
      InterceptionEmitter.fromDeclarationValue(
        { declaration: V, bindings: [{ id: "t", kind: "com.example.throws", config: { secret: "s3" } }] },
        bad,
      ),
    DeclarationErrorClass.BindingRejected,
    "/bindings/0",
  );
  assert.match(e1.message, /binding "t" \(kind "com.example.throws"\) rejected: unsupported option secret/);
  assert.doesNotMatch(e1.message, /s3/);
  const e2 = refused(
    () =>
      InterceptionEmitter.fromDeclarationValue(
        { declaration: V, bindings: [{ id: "w", kind: "com.example.wrong" }] },
        bad,
      ),
    DeclarationErrorClass.BindingRejected,
    "/bindings/0",
  );
  assert.match(e2.message, /did not return an interceptor/);
  // An async resolver is refused the same way, and the message says why.
  const asyncReg = registry((r) => r.kind("com.example.async", async () => allow));
  const e3 = refused(
    () =>
      InterceptionEmitter.fromDeclarationValue(
        { declaration: V, bindings: [{ id: "p", kind: "com.example.async" }] },
        asyncReg,
      ),
    DeclarationErrorClass.BindingRejected,
    "/bindings/0",
  );
  assert.match(e3.message, /returned a Promise; kind resolvers are synchronous/);
});

test("a resolver message is bounded in the findings and in the message alike", () => {
  const long = "x".repeat(5000);
  const loud = registry((r) =>
    r.kind("com.example.loud", () => {
      throw new Error(long);
    }),
  );
  const e = refused(
    () =>
      InterceptionEmitter.fromDeclarationValue(
        { declaration: V, bindings: [{ id: "l", kind: "com.example.loud" }] },
        loud,
      ),
    DeclarationErrorClass.BindingRejected,
    "/bindings/0",
  );
  assert.equal(Array.from(e.findings[0].detail).length, MAX_DETAIL_LEN);
  assert.doesNotMatch(e.message, /x{513}/);
  assert.ok(e.message.length < 700, `message is ${e.message.length} characters`);
  // The same bound holds when findings arrive directly.
  const direct = new DeclarationError(DeclarationErrorClass.BindingRejected, [
    { pointer: "/bindings/0", detail: long },
  ]);
  assert.doesNotMatch(direct.message, /x{513}/);
  assert.equal(Array.from(direct.findings[0].detail).length, MAX_DETAIL_LEN);
});

test("register(at) refuses an unknown point name at call time", () => {
  const em = new InterceptionEmitter();
  assert.throws(
    () => em.register(allow, "x", ["pre_tool_cal"]),
    (err) => err instanceof RangeError && /unknown interception point "pre_tool_cal"/.test(err.message),
  );
  em.register(allow, "y", ["pre_tool_call"]);
});

test("malformed: not JSON, root not an object, duplicate keys, depth, non-finite value", () => {
  refused(() => HostDeclaration.fromJson("{not json"), DeclarationErrorClass.Malformed);
  refused(() => HostDeclaration.fromJson("[]"), DeclarationErrorClass.Malformed);
  refused(
    () => HostDeclaration.fromJson(`{"declaration": "${V}", "declaration": "${V}", "bindings": []}`),
    DeclarationErrorClass.Malformed,
  );
  const deep = "[".repeat(40) + "]".repeat(40);
  refused(
    () => HostDeclaration.fromJson(`{"declaration": "${V}", "bindings": [], "extensions": {"x": ${deep}}}`),
    DeclarationErrorClass.Malformed,
  );
  refused(
    () => HostDeclaration.fromValue({ ...minimal(), extensions: { x: Number.NaN } }),
    DeclarationErrorClass.Malformed,
  );
  refused(
    () => HostDeclaration.fromJson("x".repeat(MAX_DOCUMENT_BYTES + 1)),
    DeclarationErrorClass.Malformed,
  );
});

test("unreadable: missing path, directory, byte-order mark, invalid UTF-8, oversize", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-hooks-decl-"));
  try {
    await refusedAsync(
      () => HostDeclaration.fromPath(join(dir, "missing.json")),
      DeclarationErrorClass.Unreadable,
    );
    await refusedAsync(() => HostDeclaration.fromPath(dir), DeclarationErrorClass.Unreadable);
    const bom = join(dir, "bom.json");
    writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(minimal()))]));
    const e = await refusedAsync(() => HostDeclaration.fromPath(bom), DeclarationErrorClass.Unreadable);
    assert.match(e.message, /byte-order mark/);
    const bad = join(dir, "utf8.json");
    writeFileSync(bad, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    await refusedAsync(() => HostDeclaration.fromPath(bad), DeclarationErrorClass.Unreadable);
    const big = join(dir, "big.json");
    writeFileSync(big, Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x20));
    await refusedAsync(() => HostDeclaration.fromPath(big), DeclarationErrorClass.Unreadable);
    // A good file loads, and the class is construction-time: no emitter.
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify(minimal()), "utf8");
    const d = await HostDeclaration.fromPath(good);
    assert.equal(d.version, V);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- registry --------------------------------------------------------------------------

test("registry refuses reserved segments, bad grammar and duplicates", () => {
  const reg = new HostRegistry(HostSurface.sdkDefault());
  assert.throws(() => reg.kind("agent_hooks.allow", () => allow), HostRegistryError);
  assert.throws(() => reg.kind("ctk.scripted", () => allow), HostRegistryError);
  assert.throws(() => reg.kind("nodot", () => allow), HostRegistryError);
  assert.throws(() => reg.kind("Com.Example", () => allow), HostRegistryError);
  reg.kind("com.example.allow", () => allow);
  assert.throws(() => reg.kind("com.example.allow", () => allow), HostRegistryError);
  assert.throws(() => reg.identityProvider("jcs-custom", () => "x"), HostRegistryError);
  assert.throws(() => reg.approvalResolver("Bad Name", { resolve: () => ({}) }), HostRegistryError);
  reg.approvalResolver("queue", { resolve: () => ({}) });
  assert.throws(() => reg.approvalResolver("queue", { resolve: () => ({}) }), HostRegistryError);
  // The conformance registry opens ctk only.
  const ctk = HostRegistry.forConformance(HostSurface.sdkDefault());
  ctk.kind("ctk.scripted", () => allow);
  assert.throws(() => ctk.kind("agent_hooks.x", () => allow), HostRegistryError);
  assert.deepEqual(reg.names(), {
    identity_providers: [],
    approval_resolvers: ["queue"],
    approval_redactors: [],
    kinds: ["com.example.allow"],
  });
});

test("an invalid host surface is a registry error, not a refusal", () => {
  const surface = HostSurface.sdkDefault();
  surface.interception_points = ["agent_startup", "input", "output"];
  const reg = new HostRegistry(surface).kind("com.example.allow", () => allow);
  assert.throws(() => InterceptionEmitter.fromDeclarationValue(minimal(), reg), HostRegistryError);
});

// ---- registered references in use ----------------------------------------------------------

test("custom provider, resolver and redactor are taken from the registry", async () => {
  let redacted = false;
  let seen = null;
  const reg = registry((r) =>
    r
      .identityProvider("hmac-sha256-k1", (c) => `mac:${c.sequence}`)
      .approvalResolver("queue", {
        resolve(req) {
          seen = req.context;
          return { outcome: "approve", context_identity: req.context_identity, verdict: { decision: "allow" } };
        },
      })
      .approvalRedactor("strip", (c) => {
        redacted = true;
        return { ...c, target: "[redacted]" };
      })
      .kind("com.example.escalate", () => ({
        intercept: () => ({ decision: "deny", reason: "x:approve-me", approval: {} }),
      })),
  );
  const em = InterceptionEmitter.fromDeclarationValue(
    {
      declaration: V,
      configuration: {
        identity_provider: "hmac-sha256-k1",
        approval: { resolver: "queue", redactor: "strip" },
      },
      bindings: [{ id: "e", kind: "com.example.escalate" }],
    },
    reg,
  );
  const r = await em.emitUnchecked(ctx());
  assert.equal(r.identity_provider, "hmac-sha256-k1");
  assert.equal(r.input_identity, "mac:0");
  assert.equal(r.verdict.decision, "allow");
  assert.equal(r.resolved_by, "approval");
  assert.equal(redacted, true);
  assert.equal(seen.target, "[redacted]");
});

test("approval_resolver_ms bounds the resolver", async () => {
  const reg = registry((r) =>
    r
      .approvalResolver("slow", {
        resolve: () => new Promise(() => {}),
      })
      .kind("com.example.escalate", () => ({
        intercept: () => ({ decision: "deny", reason: "x:approve-me", approval: {} }),
      })),
  );
  const em = InterceptionEmitter.fromDeclarationValue(
    {
      declaration: V,
      configuration: { approval: { resolver: "slow" }, timeouts: { approval_resolver_ms: 20 } },
      bindings: [{ id: "e", kind: "com.example.escalate" }],
    },
    reg,
  );
  const r = await em.emitUnchecked(ctx());
  assert.equal(r.verdict.reason, "host_error:approval_resolver_failed");
  assert.equal(r.resolved_by, "rejection");
});

test("per-binding timeout_ms bounds that interceptor only", async () => {
  const reg = registry((r) =>
    r.kind("com.example.slow", () => ({ intercept: () => new Promise(() => {}) })),
  );
  const em = InterceptionEmitter.fromDeclarationValue(
    {
      declaration: V,
      configuration: { composition: { profile: "sequential/run_all" } },
      bindings: [
        { id: "slow", kind: "com.example.slow", timeout_ms: 20 },
        { id: "ok", kind: "com.example.allow" },
      ],
    },
    reg,
  );
  const r = await em.emitUnchecked(ctx());
  assert.equal(r.verdicts[0].reason, "host_error:interceptor_timeout");
  assert.equal(r.verdicts[1].decision, "allow");
  assert.equal(r.verdict.reason, "host_error:interceptor_timeout");
});

// ---- failure posture: on_error in a declaration (§6.3.1, §7.7.3, §7.7.5) ---
//
// Mirrors the on_error tests in sdk/rust/core/src/declaration.rs and
// tests/declaration.rs. Validation runs in the core; what this SDK
// owns is the resolved form it reads back, the binding context it
// hands resolvers, the registry's notifier and managed kinds, and the
// builder members.

const throws = {
  intercept() {
    throw new Error("boom");
  },
};

/** A registry with a notifier that collects notices plus a kind that
 * always throws. */
function postureRegistry(extra = (r) => r) {
  const notices = [];
  const reg = registry((r) =>
    extra(
      r
        .kind("com.example.flaky", () => throws)
        .controlFailureNotifier((n) => notices.push(n)),
    ),
  );
  return { reg, notices };
}

test("on_error: a 1.0 document resolves to deny everywhere and keeps its version", async () => {
  const doc = {
    declaration: V,
    configuration: { composition: { profile: "sequential/run_all" } },
    bindings: [
      { id: "flaky", kind: "com.example.flaky" },
      { id: "second", kind: "com.example.allow" },
    ],
  };
  const em = InterceptionEmitter.fromDeclarationValue(doc, registry((r) => r.kind("com.example.flaky", () => throws)));
  assert.equal(em.declaration.declaration, V);
  assert.deepEqual(em.declaration.configuration.failure, { on_error: "deny" });
  assert.equal(em.declaration.bindings[0].on_error, "deny");
  assert.equal(em.declaration.bindings[1].on_error, "deny");
  const r = await em.emitUnchecked(ctx());
  assert.equal(r.declaration, V);
  assert.equal(r.verdict.decision, "deny");
  assert.equal(r.verdict.reason, "host_error:interceptor_failed");
  assert.equal(r.decided_by, 0);
  assert.equal("substituted_for" in r.verdicts[0], false);
  assert.equal(r.verdicts[1].decision, "allow");
});

test("on_error: binding member and document default resolve as §7.7.5 says", () => {
  const seen = [];
  const { reg } = postureRegistry((r) =>
    r.kind("com.example.see", (_config, context) => {
      seen.push([context.id, context.onError, context.timeoutMs]);
      return allow;
    }),
  );
  const em = InterceptionEmitter.fromDeclarationValue(
    {
      declaration: V11,
      configuration: { failure: { on_error: "continue" } },
      bindings: [
        { id: "inherits", kind: "com.example.see" },
        { id: "overrides", kind: "com.example.see", on_error: "deny", timeout_ms: 250 },
      ],
    },
    reg,
  );
  const d = em.declaration;
  assert.equal(d.declaration, V11);
  assert.deepEqual(d.configuration.failure, { on_error: "continue" });
  assert.equal(d.bindings[0].on_error, "continue");
  assert.equal(d.bindings[1].on_error, "deny");
  assert.deepEqual(seen, [
    ["inherits", "continue", 5000],
    ["overrides", "deny", 250],
  ]);
  // An explicit document default of deny with a binding that opens it.
  const em2 = InterceptionEmitter.fromDeclarationValue(
    {
      declaration: V11,
      configuration: { failure: { on_error: "deny" } },
      bindings: [{ id: "opens", kind: "com.example.see", on_error: "continue" }],
    },
    reg,
  );
  assert.equal(em2.declaration.configuration.failure.on_error, "deny");
  assert.equal(em2.declaration.bindings[0].on_error, "continue");
  // A 1.1 document without either member means what 1.0 meant.
  const em3 = InterceptionEmitter.fromDeclarationValue({ ...minimal(), declaration: V11 }, reg);
  assert.equal(em3.declaration.configuration.failure.on_error, "deny");
  assert.equal(em3.declaration.bindings[0].on_error, "deny");
});

test("on_error: declared continue substitutes, declared deny does not, and the principal is told", async () => {
  const { reg, notices } = postureRegistry();
  const em = InterceptionEmitter.fromDeclarationValue(
    {
      declaration: V11,
      configuration: { composition: { profile: "sequential/run_all" }, failure: { on_error: "continue" } },
      bindings: [
        { id: "flaky", kind: "com.example.flaky" },
        { id: "strict", kind: "com.example.flaky", on_error: "deny" },
        { id: "second", kind: "com.example.allow" },
      ],
    },
    reg,
  );
  const r = await em.emitUnchecked(ctx());
  // The strict binding's deny wins; the flaky slot was substituted.
  assert.equal(r.verdict.decision, "deny");
  assert.equal(r.verdict.reason, "host_error:interceptor_failed");
  assert.equal(r.decided_by, 1);
  assert.equal(r.verdicts[0].decision, "allow");
  assert.equal(r.verdicts[0].name, "flaky");
  assert.equal(r.verdicts[0].substituted_for, "host_error:interceptor_failed");
  assert.equal("reason" in r.verdicts[0], false);
  assert.equal(r.verdicts[1].reason, "host_error:interceptor_failed");
  assert.equal("substituted_for" in r.verdicts[1], false);
  assert.deepEqual(r.verdict.warnings, [
    { reason: "host_warning:control_failed", message: "flaky: host_error:interceptor_failed; host continued" },
  ]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].binding, "flaky");
  assert.equal(notices[0].message, "flaky: host_error:interceptor_failed; host continued");
  // Alone, the continuation proceeds with decided_by null.
  const em2 = InterceptionEmitter.fromDeclarationValue(
    { declaration: V11, bindings: [{ id: "flaky", kind: "com.example.flaky", on_error: "continue" }] },
    reg,
  );
  const r2 = await em2.emitUnchecked(ctx("pre_tool_call", 1));
  assert.equal(r2.verdict.decision, "allow");
  assert.equal(r2.decided_by, null);
  assert.equal(r2.fold_truncated, false);
  assert.equal(r2.verdicts[0].substituted_for, "host_error:interceptor_failed");
  assert.equal(r2.declaration, V11);
});

test("on_error: continue without a registry notifier is binding_rejected at the posture's pointer", () => {
  const noChannel = registry((r) => r.kind("com.example.flaky", () => throws));
  // Stated on the binding: the binding member is at fault.
  refused(
    () =>
      InterceptionEmitter.fromDeclarationValue(
        { declaration: V11, bindings: [{ id: "flaky", kind: "com.example.flaky", on_error: "continue" }] },
        noChannel,
      ),
    DeclarationErrorClass.BindingRejected,
    "/bindings/0/on_error",
  );
  // Inherited from the document default: the default is at fault.
  const e = refused(
    () =>
      InterceptionEmitter.fromDeclarationValue(
        {
          declaration: V11,
          configuration: { failure: { on_error: "continue" } },
          bindings: [{ id: "flaky", kind: "com.example.flaky" }],
        },
        noChannel,
      ),
    DeclarationErrorClass.BindingRejected,
    "/configuration/failure/on_error",
  );
  assert.match(e.message, /control failure notifier/);
  // Deny needs no channel.
  InterceptionEmitter.fromDeclarationValue(
    {
      declaration: V11,
      configuration: { failure: { on_error: "deny" } },
      bindings: [{ id: "flaky", kind: "com.example.flaky", on_error: "deny" }],
    },
    noChannel,
  );
  // With the channel the same document loads.
  const { reg } = postureRegistry();
  InterceptionEmitter.fromDeclarationValue(
    { declaration: V11, bindings: [{ id: "flaky", kind: "com.example.flaky", on_error: "continue" }] },
    reg,
  );
  assert.throws(() => new HostRegistry(HostSurface.sdkDefault()).controlFailureNotifier("nope"), HostRegistryError);
});

test("on_error: refusal classes for the 1.1 members", () => {
  // Outside the closed set: invalid_field at the member.
  for (const bad of ["ignore", "Continue", true, null]) {
    refused(
      () => HostDeclaration.fromValue({ declaration: V11, bindings: [{ id: "a", kind: "com.example.allow", on_error: bad }] }),
      DeclarationErrorClass.InvalidField,
      "/bindings/0/on_error",
    );
    refused(
      () => HostDeclaration.fromValue({ ...minimal(), declaration: V11, configuration: { failure: { on_error: bad } } }),
      DeclarationErrorClass.InvalidField,
      "/configuration/failure/on_error",
    );
  }
  // Under a 1.0 version string: unknown_field; the document opts in by
  // writing 1.1.
  refused(
    () => HostDeclaration.fromValue({ declaration: V, bindings: [{ id: "a", kind: "com.example.allow", on_error: "continue" }] }),
    DeclarationErrorClass.UnknownField,
    "/bindings/0/on_error",
  );
  refused(
    () => HostDeclaration.fromValue({ ...minimal(), configuration: { failure: { on_error: "deny" } } }),
    DeclarationErrorClass.UnknownField,
    "/configuration/failure",
  );
  // An unknown member inside failure is unknown at that level.
  refused(
    () => HostDeclaration.fromValue({ ...minimal(), declaration: V11, configuration: { failure: { on_timeout: "deny" } } }),
    DeclarationErrorClass.UnknownField,
    "/configuration/failure/on_timeout",
  );
  // A host whose surface accepts 1.0 only refuses a 1.1 document as
  // version_unsupported with its own accepted set (the "1.0 loader
  // refuses 1.1" case, §7.7.2).
  const surface = { ...HostSurface.fromCapabilities(["host_declaration"]), declaration_versions: [V] };
  const reg = new HostRegistry(surface).kind("com.example.allow", () => allow);
  const e = refused(
    () => InterceptionEmitter.fromDeclarationValue({ ...minimal(), declaration: V11 }, reg),
    DeclarationErrorClass.VersionUnsupported,
    "/declaration",
  );
  assert.deepEqual(e.accepted, [V]);
  InterceptionEmitter.fromDeclarationValue(minimal(), reg);
});

test("managed kinds: resolver output, name collision, the resolved bound", async () => {
  const bounds = [];
  const outcomes = [];
  const managed = {
    interceptManaged(_c, boundMs) {
      bounds.push(boundMs);
      return outcomes.shift();
    },
  };
  const contexts = [];
  const { reg, notices } = postureRegistry((r) =>
    r.managedKind("com.example.proc", (_config, context) => {
      contexts.push(context);
      return managed;
    }),
  );
  assert.ok(reg.names().kinds.includes("com.example.proc"), "managed kinds are registry names");
  // One name is managed or standard, never both.
  assert.throws(() => reg.kind("com.example.proc", () => allow), HostRegistryError);
  assert.throws(() => reg.managedKind("com.example.allow", () => managed), HostRegistryError);
  assert.throws(() => reg.managedKind("ctk.proc", () => managed), HostRegistryError);
  assert.throws(() => reg.managedKind("com.example.other", "not a function"), HostRegistryError);

  const em = InterceptionEmitter.fromDeclarationValue(
    {
      declaration: V11,
      configuration: { composition: { profile: "sequential/run_all" } },
      bindings: [
        { id: "bounded", kind: "com.example.proc", timeout_ms: 250, on_error: "continue" },
        { id: "unbounded", kind: "com.example.proc", timeout_ms: null },
      ],
    },
    reg,
  );
  assert.equal(contexts[0].timeoutMs, 250);
  assert.equal(contexts[0].onError, "continue");
  assert.equal(contexts[1].timeoutMs, null);
  assert.equal(contexts[1].onError, "deny");
  outcomes.push({ outcome: "timeout" }, { outcome: "verdict", verdict: { decision: "allow" } });
  const r = await em.emitUnchecked(ctx());
  assert.deepEqual(bounds, [250, null]);
  assert.equal(r.verdict.decision, "allow");
  assert.equal(r.verdicts[0].name, "bounded");
  assert.equal(r.verdicts[0].substituted_for, "host_error:interceptor_timeout");
  assert.equal(r.verdicts[1].decision, "allow");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].binding, "bounded");
  // Cancelled never continues, whatever the binding says.
  outcomes.push({ outcome: "cancelled" }, { outcome: "verdict", verdict: { decision: "allow" } });
  const r2 = await em.emitUnchecked(ctx("pre_tool_call", 1));
  assert.equal(r2.verdict.decision, "deny");
  assert.equal(r2.verdict.reason, "host_error:interceptor_failed");
  assert.equal(r2.decided_by, 0);
  assert.equal("substituted_for" in r2.verdicts[0], false);
  assert.equal(notices.length, 1);
  // A managed kind whose resolver returns a plain interceptor is
  // rejected, and so is a standard kind returning a managed one.
  refused(
    () =>
      InterceptionEmitter.fromDeclarationValue(
        { declaration: V11, bindings: [{ id: "a", kind: "com.example.wrong", config: {} }] },
        registry((r) => r.managedKind("com.example.wrong", () => allow)),
      ),
    DeclarationErrorClass.BindingRejected,
    "/bindings/0",
  );
  refused(
    () =>
      InterceptionEmitter.fromDeclarationValue(
        { declaration: V11, bindings: [{ id: "a", kind: "com.example.wrong", config: {} }] },
        registry((r) => r.kind("com.example.wrong", () => managed)),
      ),
    DeclarationErrorClass.BindingRejected,
    "/bindings/0",
  );
});

test("builder: failureOnError and bindWith write the 1.1 members; the builder path agrees with the value path", () => {
  const b = new DeclarationBuilder()
    .failureOnError("continue")
    .bindWith("flaky", "com.example.flaky", {}, { onError: "deny", timeoutMs: 100, at: ["output", "input"] })
    .bindWith("second", "com.example.allow");
  const value = b.toValue();
  assert.equal(value.declaration, V11);
  assert.deepEqual(value.configuration, { failure: { on_error: "continue" } });
  assert.deepEqual(value.bindings[0], {
    id: "flaky",
    kind: "com.example.flaky",
    config: {},
    at: ["input", "output"],
    timeout_ms: 100,
    on_error: "deny",
  });
  assert.deepEqual(value.bindings[1], { id: "second", kind: "com.example.allow", config: {} });
  const { reg } = postureRegistry();
  const viaBuilder = InterceptionEmitter.fromDeclaration(b.build(), reg);
  const viaValue = InterceptionEmitter.fromDeclarationValue(value, reg);
  const viaRunner = InterceptionEmitter.fromDeclaration(builderFromValue(value).build(), reg);
  assert.equal(canonicalDeclaration(viaBuilder.declaration), canonicalDeclaration(viaValue.declaration));
  assert.equal(canonicalDeclaration(viaRunner.declaration), canonicalDeclaration(viaValue.declaration));
  assert.equal(viaValue.declaration.bindings[1].on_error, "continue");
  // Written under 1.0 the builder's output is refused like a file.
  refused(
    () => new DeclarationBuilder().version(V).failureOnError("deny").bind("a", "com.example.allow").build(),
    DeclarationErrorClass.UnknownField,
    "/configuration/failure",
  );
});

test("sealed emitter: the notifier is a host channel, the registration options are not", () => {
  const { reg } = postureRegistry();
  const em = InterceptionEmitter.fromDeclarationValue(
    { declaration: V11, bindings: [{ id: "flaky", kind: "com.example.flaky", on_error: "continue" }] },
    reg,
  );
  em.setControlFailureNotifier(() => {});
  assert.throws(() => em.registerWithOptions(allow, { onError: "continue" }), EmitterSealed);
  assert.throws(() => em.registerManaged({ interceptManaged: () => ({ outcome: "timeout" }) }), EmitterSealed);
});
