// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
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
  MAX_DOCUMENT_BYTES,
  SUPPORTED_DECLARATION_VERSIONS,
  canonicalDeclaration,
  declarationVersions,
} from "../dist/index.js";
import { builderFromValue } from "../dist/ctk/index.js";

const V = "agent-hooks-declaration/1.0";

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
  assert.equal(DECLARATION_VERSION, V);
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

test("a validated document keeps integers beyond 2^53 for the core", () => {
  const big = "18446744073709551615";
  const text = `{"declaration":"${V}","bindings":[{"id":"a","kind":"com.example.allow","config":{"key":${big}}}]}`;
  const decl = HostDeclaration.fromJson(text);
  assert.ok(decl.toJson().includes(big));
  // The resolved form is a JavaScript value and rounds; the load
  // checks ran on the exact text.
  const em = InterceptionEmitter.fromDeclarationJson(text, registry());
  assert.equal(em.declaration.bindings[0].id, "a");
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
    .surfaceDeclarationVersions([V])
    .bind("a", "com.example.allow", { x: 1 })
    .extension("acme", { note: "kept verbatim" });
  const value = b.toValue();
  assert.equal(value.declaration, V);
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

// ---- refusal classes -----------------------------------------------------------------

test("version_unsupported: reserved major, missing, higher minor, non-string", () => {
  for (const declaration of ["agent-hooks-declaration/0.1", "agent-hooks-declaration/1.9", 1, undefined]) {
    const doc = { ...minimal() };
    if (declaration === undefined) delete doc.declaration;
    else doc.declaration = declaration;
    const err = refused(
      () => HostDeclaration.fromValue(doc),
      DeclarationErrorClass.VersionUnsupported,
      "/declaration",
    );
    assert.deepEqual(err.accepted, [V]);
    assert.match(err.message, /accepted: agent-hooks-declaration\/1\.0/);
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
