// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
/**
 * CTK runner: load vectors, drive a harness, assert `expect`.
 *
 * The assertion engine, capability skip check, and scripted
 * interceptor/resolver evaluation live in the Rust core (native.ctk*).
 * This module keeps only vector globbing, the recording wrapper, the
 * host declaration seam (§7.7.9: the CTK registry, the construction
 * path proof and the `load` outcome) and the orchestration loop that
 * calls the native `Harness`.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentContext,
  ApprovalRequest,
  ApprovalResolution,
  Composition,
  CompositionConfig,
  CompositionProfile,
  DeclarationBuilder,
  DeclarationError,
  EnforcementMode,
  HostDeclaration,
  HostRegistry,
  HostSurface,
  InterceptionPoint,
  Interceptor,
  JsonValue,
  KnobSupport,
  ResolvedDeclaration,
  Verdict,
  canonicalDeclaration,
} from "../index";
import { resolveDeclaration, resolveSurfaceOnly } from "../declaration";
import { native } from "../native";
import type { Harness, LoadRecord, RunRecord, Scenario } from "./index";

export interface VectorResult {
  id: string;
  title: string;
  part?: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  failures: string[];
}

export function loadVectors(dir: string): JsonValue[] {
  const vectors = readdirSync(dir)
    .filter((f) => /^AH-CTK-.*\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as JsonValue);
  if (vectors.length === 0) {
    // A runner fed zero vectors reports 100% pass — a false
    // conformance signal (§13.2). Fail loudly instead.
    throw new Error(`no AH-CTK-*.json vectors found in ${dir}`);
  }
  return vectors;
}

/** Replays one `interceptor_script` rule list via the Rust core. */
class ScriptedInterceptor implements Interceptor {
  protected readonly rulesJson: string;
  constructor(rules: JsonValue) {
    this.rulesJson = JSON.stringify(rules);
  }
  intercept(ctx: AgentContext): Verdict {
    const w = JSON.parse(native.ctkScriptedIntercept(this.rulesJson, JSON.stringify(ctx)));
    if (w !== null && typeof w === "object" && "__ctk_fault__" in w) {
      if ((w as Record<string, unknown>).__ctk_fault__ === "mutate") {
        // §7 isolation fault (TM-05): tamper with the received context
        // in-place; the emitter's copy isolation must keep enforcement,
        // identity, and siblings unaffected.
        (ctx as Record<string, unknown>).target = "TAMPERED";
        const tc = (ctx as Record<string, unknown>).tool_call;
        if (tc && typeof tc === "object") {
          (tc as Record<string, unknown>).args = { tampered: true };
        }
        return { decision: "allow", reason: "ctk:mutated" } as Verdict;
      }
      // Fault injection: exercise §6.3 interceptor_failed.
      throw new Error("ctk scripted fault: raise");
    }
    return w;
  }
}

/** Wraps the scripted interceptor and records every ctx passed. */
class RecordingInterceptor extends ScriptedInterceptor {
  readonly recorded: AgentContext[] = [];
  override intercept(ctx: AgentContext): Verdict {
    this.recorded.push(JSON.parse(JSON.stringify(ctx)));
    return super.intercept(ctx);
  }
}

class ScriptedResolver {
  private readonly rulesJson: string;
  constructor(rules: JsonValue) {
    this.rulesJson = JSON.stringify(rules);
  }
  resolve(req: ApprovalRequest): ApprovalResolution {
    // §10.1: identity may be null (null provider). The scripted engine
    // works in strings; "" round-trips to null below.
    const requestIdentity = req.context_identity ?? "";
    const r = JSON.parse(
      native.ctkScriptedResolve(this.rulesJson, JSON.stringify(req.context), requestIdentity),
    );
    if (r !== null && typeof r === "object" && "__ctk_fault__" in r) {
      // Fault injection: exercise §9 approval_resolver_failed.
      throw new Error("ctk scripted fault: raise");
    }
    if (r.context_identity === "" && req.context_identity === null) {
      r.context_identity = null;
    }
    return r;
  }
}

/** §9 redaction seam, CTK convention: each listed path is replaced
 * with "[redacted]" via the §5.2/§4.3 transform machinery; a path that
 * does not resolve at the escalating point is left untouched. */
export function redactPaths(ctx: AgentContext, paths: readonly string[]): AgentContext {
  let out = JSON.stringify(ctx);
  for (const path of paths) {
    try {
      out = native.applyTransformCtx(out, path, '"[redacted]"');
    } catch {
      /* unresolvable at this point: skip */
    }
  }
  return JSON.parse(out) as AgentContext;
}

/** The scripted interceptors and resolver a vector carries, shared by
 * the field-based and the declaration path. */
class Scripts {
  readonly scripts: JsonValue[];
  readonly approval: JsonValue[];
  readonly redact: string[];
  /** Script 0 records: `expect.interceptions` describes each emission
   * as the first interceptor saw it. One recorder per vector run, so
   * the declaration path and the field path record alike. */
  readonly recorder: RecordingInterceptor | null;

  constructor(v: Record<string, JsonValue>) {
    // Multi-interceptor vectors (§7.1 fold-through) use
    // interceptor_scripts; single-interceptor vectors use
    // interceptor_script. An empty interceptor_scripts registers zero
    // interceptors (§7 fail-closed vector).
    this.scripts = (v.interceptor_scripts as JsonValue[] | undefined) ?? [v.interceptor_script];
    this.approval = (v.approval_script as JsonValue[] | undefined) ?? [];
    this.redact = (v.redact_for_approval as string[] | undefined) ?? [];
    this.recorder = this.scripts.length > 0 ? new RecordingInterceptor(this.scripts[0]) : null;
  }

  /** Scripted interceptor `i`; only index 0 records. */
  interceptor(i: number): Interceptor | undefined {
    if (i >= this.scripts.length) return undefined;
    return i === 0 ? (this.recorder as Interceptor) : new ScriptedInterceptor(this.scripts[i]);
  }

  interceptors(): Interceptor[] {
    return this.scripts.map((_, i) => this.interceptor(i) as Interceptor);
  }

  /** NB: [] is truthy in JS, so an empty approval_script registers NO
   * resolver (matches the Rust/Python runners; exercised by AH-CTK-032). */
  resolver(): ScriptedResolver | null {
    return this.approval.length > 0 ? new ScriptedResolver(this.approval) : null;
  }

  recorded(): AgentContext[] {
    return this.recorder?.recorded ?? [];
  }

  /** The CTK registry for a declaration vector (§7.7.9): kind
   * `ctk.scripted` (config `{"script": i}`), identity provider
   * `ctk-fault`, approval resolver `ctk-scripted`, redactor
   * `ctk-redact`. */
  registry(surface: HostSurface): HostRegistry {
    const redact = [...this.redact];
    return HostRegistry.forConformance(surface)
      .kind("ctk.scripted", (config, ctx) => {
        const script = (config as Record<string, JsonValue> | null)?.["script"];
        if (typeof script !== "number" || !Number.isInteger(script) || script < 0) {
          throw new Error("config.script must be an unsigned integer index");
        }
        const i = this.interceptor(script);
        if (i === undefined) {
          throw new Error(`config.script ${script} is out of range for binding ${ctx.id}`);
        }
        return i;
      })
      .identityProvider("ctk-fault", () => {
        throw new Error("ctk scripted provider fault");
      })
      .approvalResolver("ctk-scripted", new ScriptedResolver(this.approval))
      .approvalRedactor("ctk-redact", (ctx) => redactPaths(ctx, redact));
  }
}

function runRecordToWire(rr: RunRecord, postures: Record<string, string>): string {
  return JSON.stringify({
    outcome: rr.outcome,
    final_output: rr.final_output ?? null,
    tool_invocations: rr.tool_invocations,
    error: rr.error ?? null,
    identities: rr.identities.map(([i, e]) => ({ input_identity: i, enforced_identity: e })),
    records: rr.records,
    // Harness *declarations* (§13.1), not observed behavior: the engine
    // selects expect.run_outcome_by_posture entries by them.
    postures,
    ...(rr.load !== undefined ? { load: rr.load } : {}),
  });
}

// ---- builder from a value (§7.7.7, the code path) ----------------------------

const POINTS: readonly string[] = Object.values(InterceptionPoint);
const PROFILES: readonly string[] = Object.values(CompositionProfile);

function isObject(v: JsonValue | undefined): v is Record<string, JsonValue> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function pointsOf(v: JsonValue): InterceptionPoint[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: InterceptionPoint[] = [];
  for (const p of v) {
    if (typeof p !== "string" || !POINTS.includes(p)) return undefined;
    out.push(p as InterceptionPoint);
  }
  return out;
}

function stringsOf(v: JsonValue): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== "string") return undefined;
    out.push(s);
  }
  return out;
}

function isUint(v: JsonValue | undefined): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Rebuild a document through {@link DeclarationBuilder}, member by
 * member (§7.7.7, the code path). Members the typed setters cannot
 * express exactly (an unknown member, a wrong type) go through
 * {@link DeclarationBuilder.raw}, so the result is validated like the
 * file it came from. Mirrors the Rust runner's `builder_from_value`. */
export function builderFromValue(doc: JsonValue): DeclarationBuilder {
  let b = DeclarationBuilder.empty();
  if (!isObject(doc)) return b;
  for (const [k, v] of Object.entries(doc)) {
    if (k === "declaration" && typeof v === "string") b = b.version(v);
    else if (k === "spec" && typeof v === "string") b = b.spec(v);
    else if (k === "id" && typeof v === "string") b = b.id(v);
    else if (
      k === "host" &&
      isObject(v) &&
      Object.keys(v).every((hk) => hk === "name" || hk === "version") &&
      typeof v["name"] === "string" &&
      (v["version"] === undefined || typeof v["version"] === "string")
    ) {
      b = b.host(v["name"], v["version"] as string | undefined);
    } else if (k === "configuration" && isObject(v)) {
      b = typedConfiguration(b, v) ?? b.raw(k, v);
    } else if (k === "surface" && isObject(v)) {
      b = typedSurface(b, v) ?? b.raw(k, v);
    } else if (k === "bindings" && Array.isArray(v)) {
      b = typedBindings(b, v) ?? b.raw(k, v);
    } else if (k === "extensions" && isObject(v)) {
      for (const [ek, ev] of Object.entries(v)) b = b.extension(ek, ev);
    } else {
      b = b.raw(k, v);
    }
  }
  return b;
}

function typedConfiguration(
  b: DeclarationBuilder,
  c: Record<string, JsonValue>,
): DeclarationBuilder | undefined {
  for (const [k, v] of Object.entries(c)) {
    if (k === "mode" && typeof v === "string") {
      if (v !== "enforce" && v !== "evaluate_only") return undefined;
      b = b.mode(v as EnforcementMode);
    } else if (k === "composition" && isObject(v)) {
      const known = ["profile", "on_approval", "on_disagreement", "on_transform_conflict"];
      if (!Object.keys(v).every((ck) => known.includes(ck))) return undefined;
      const cfg: CompositionConfig = { profile: CompositionProfile.SequentialFirstDeny };
      const profile = v["profile"];
      if (profile !== undefined) {
        if (typeof profile !== "string" || !PROFILES.includes(profile)) return undefined;
        cfg.profile = profile as CompositionProfile;
      }
      for (const [kk, vv] of Object.entries(v)) {
        if (kk === "profile") continue;
        if (typeof vv !== "string") return undefined;
        if (kk === "on_approval" && (vv === "stop" || vv === "resume")) cfg.on_approval = vv;
        else if (kk === "on_disagreement" && (vv === "deny" || vv === "approval")) {
          cfg.on_disagreement = vv;
        } else if (kk === "on_transform_conflict" && (vv === "deny" || vv === "approval")) {
          cfg.on_transform_conflict = vv;
        } else return undefined;
      }
      b = b.composition(cfg);
    } else if (k === "identity_provider" && (v === null || typeof v === "string")) {
      b = b.identityProvider(v);
    } else if (k === "approval" && isObject(v)) {
      for (const [ak, av] of Object.entries(v)) {
        if (av !== null && typeof av !== "string") return undefined;
        if (ak === "resolver") b = b.approvalResolver(av);
        else if (ak === "redactor") b = b.approvalRedactor(av);
        else return undefined;
      }
    } else if (k === "posture" && isObject(v)) {
      if (Object.keys(v).length !== 1) return undefined;
      const p = v["tool_seam_host_error"];
      if (p !== "continue" && p !== "terminate") return undefined;
      b = b.toolSeamHostError(p);
    } else if (k === "timeouts" && isObject(v)) {
      for (const [tk, tv] of Object.entries(v)) {
        if (tv !== null && !isUint(tv)) return undefined;
        if (tk === "interceptor_ms") b = b.interceptorTimeoutMs(tv);
        else if (tk === "approval_resolver_ms") b = b.approvalResolverTimeoutMs(tv);
        else return undefined;
      }
    } else if (k === "records" && isObject(v)) {
      if (Object.keys(v).length !== 1) return undefined;
      const n = v["max_buffered"];
      if (n !== null && !isUint(n)) return undefined;
      b = b.maxBufferedRecords(n ?? null);
    } else {
      return undefined;
    }
  }
  return b;
}

function typedSurface(
  b: DeclarationBuilder,
  sf: Record<string, JsonValue>,
): DeclarationBuilder | undefined {
  const buffered = sf["buffered_output"];
  if (buffered !== undefined && typeof buffered !== "boolean") return undefined;
  const bound = sf["exposure_bound"];
  if (bound !== undefined && typeof bound !== "string") return undefined;
  if (buffered !== undefined) b = b.bufferedOutput(buffered, bound);
  else if (bound !== undefined) return undefined;
  for (const [k, v] of Object.entries(sf)) {
    if (k === "interception_points") {
      const points = pointsOf(v);
      if (points === undefined) return undefined;
      b = b.surfacePoints(points);
    } else if (k === "capabilities") {
      const caps = stringsOf(v);
      if (caps === undefined) return undefined;
      b = b.surfaceCapabilities(caps);
    } else if (k === "declaration_versions") {
      const versions = stringsOf(v);
      if (versions === undefined) return undefined;
      b = b.surfaceDeclarationVersions(versions);
    } else if (k === "profiles") {
      if (!isObject(v)) return undefined;
      for (const [name, knobs] of Object.entries(v)) {
        if (!PROFILES.includes(name) || !isObject(knobs)) return undefined;
        const support: KnobSupport = {};
        for (const [knob, values] of Object.entries(knobs)) {
          const list = stringsOf(values);
          if (list === undefined) return undefined;
          if (knob === "on_approval") {
            if (!list.every((x) => x === "stop" || x === "resume")) return undefined;
            support.on_approval = list as KnobSupport["on_approval"];
          } else if (knob === "on_disagreement" || knob === "on_transform_conflict") {
            if (!list.every((x) => x === "deny" || x === "approval")) return undefined;
            support[knob] = list as KnobSupport["on_disagreement"];
          } else return undefined;
        }
        b = b.surfaceProfile(name as CompositionProfile, support);
      }
    } else if (k === "buffered_output" || k === "exposure_bound") {
      /* handled above */
    } else {
      return undefined;
    }
  }
  return b;
}

function typedBindings(b: DeclarationBuilder, items: JsonValue[]): DeclarationBuilder | undefined {
  const known = ["id", "kind", "config", "at", "timeout_ms"];
  if (items.length === 0) {
    // The written-down empty-deny host (§7.7.5): `bind` is never
    // called, so the member is set explicitly.
    return b.raw("bindings", []);
  }
  for (const item of items) {
    if (!isObject(item)) return undefined;
    if (!Object.keys(item).every((k) => known.includes(k))) return undefined;
    const id = item["id"];
    const kind = item["kind"];
    if (typeof id !== "string" || typeof kind !== "string") return undefined;
    // An explicit `null` is a value the spec allows; only an absent
    // member takes the default, as in the Rust runner.
    const config = "config" in item ? item["config"] : {};
    let at: InterceptionPoint[] | undefined;
    if (item["at"] !== undefined) {
      at = pointsOf(item["at"]);
      if (at === undefined) return undefined;
    }
    let timeout: number | null | undefined;
    const t = item["timeout_ms"];
    if (t === undefined) timeout = undefined;
    else if (t === null) timeout = null;
    else if (isUint(t)) timeout = t;
    else return undefined;
    b = b.bind(id, kind, config, at, timeout);
  }
  return b;
}

// ---- construction path proof (§7.7.7) -------------------------------------------

/** Resolve `doc` through the four construction paths (§7.7.7) and
 * compare: value, JSON text, a temporary file and the builder. Equal
 * canonical forms, or equal refusal classes, prove the paths
 * equivalent. Returns `[equivalent, detail]`. */
export async function provePaths(
  doc: JsonValue,
  registry: HostRegistry,
  tag: string,
): Promise<[boolean, string]> {
  const text = JSON.stringify(doc);
  // A private directory, not a guessable name in the shared tmpdir: a
  // planted symlink there could redirect the write.
  let dir: string | undefined;
  let path = "";
  const resolveWith = (
    load: () => HostDeclaration,
  ): { ok: true; resolved: ResolvedDeclaration } | { ok: false; error: unknown } => {
    try {
      return { ok: true, resolved: resolveDeclaration(load(), registry) };
    } catch (e) {
      return { ok: false, error: e };
    }
  };
  let fromFile: HostDeclaration | undefined;
  let fileError: unknown;
  try {
    dir = mkdtempSync(join(tmpdir(), "agent-hooks-ctk-"));
    path = join(dir, `${tag}.json`);
    writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
    try {
      fromFile = await HostDeclaration.fromPath(path);
    } catch (e) {
      fileError = e;
    }
  } catch (e) {
    fileError = DeclarationError.single(
      "declaration_error:unreadable",
      "",
      `cannot write temporary file: ${(e as Error)?.constructor?.name ?? "Error"}`,
    );
  } finally {
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  const outcomes: Array<[string, ReturnType<typeof resolveWith>]> = [
    ["value", resolveWith(() => HostDeclaration.fromValue(doc))],
    ["json", resolveWith(() => HostDeclaration.fromJson(text))],
    [
      "file",
      fromFile !== undefined
        ? resolveWith(() => fromFile as HostDeclaration)
        : { ok: false, error: fileError },
    ],
    ["builder", resolveWith(() => builderFromValue(doc).build())],
  ];
  const keyOf = (r: ReturnType<typeof resolveWith>): string => {
    if (r.ok) return `ok:${canonicalDeclaration(r.resolved)}`;
    const e = r.error;
    return `err:${e instanceof DeclarationError ? e.code : `other:${String(e)}`}`;
  };
  const keys = outcomes.map(([, r]) => keyOf(r));
  if (keys.every((k) => k === keys[0])) return [true, ""];
  let detail = "";
  outcomes.forEach(([name, r]) => {
    detail += `${name}: ${r.ok ? "accepted" : String(r.error)}; `;
  });
  const oks = keys.filter((k) => k.startsWith("ok:"));
  if (oks.length >= 2 && oks[0] !== oks[1]) {
    let pos = 0;
    while (pos < oks[0].length && pos < oks[1].length && oks[0][pos] === oks[1][pos]) pos++;
    detail += `first difference at byte ${pos}`;
  }
  return [false, detail];
}

// ---- one vector ---------------------------------------------------------------------

function fail(v: Record<string, JsonValue>, failures: string[]): VectorResult {
  return {
    id: v.id as string,
    title: v.title as string,
    part: (v.part as string | undefined) ?? undefined,
    status: "fail",
    detail: "",
    failures,
  };
}

/** The code surface a harness reports (§13.1), or the one derived from
 * its capabilities and posture. */
function codeSurfaceOf(harness: Harness): HostSurface {
  return (
    harness.hostSurface?.() ??
    HostSurface.fromCapabilities(harness.capabilities, harness.toolSeamHostError ?? "continue")
  );
}

/** What a run assesses the harness against: its capabilities and
 * posture, read from its resolved declaration when it ships one
 * (§7.7.9) and from the Harness fields otherwise. */
export interface AssessedSurface {
  capabilities: string[];
  posture: string;
}

/** Resolve the harness's own declaration against its code surface.
 * Throws {@link DeclarationError} on refusal. {@link runVectors} calls
 * this once before the first vector, as §7.7.9 asks; {@link runVector}
 * calls it when no resolved surface is handed in. */
export function assessHarness(harness: Harness): AssessedSurface {
  const own = harness.declaration?.();
  if (own === undefined) {
    return {
      capabilities: [...harness.capabilities],
      posture: harness.toolSeamHostError ?? "continue",
    };
  }
  const resolved: ResolvedDeclaration = resolveSurfaceOnly(
    HostDeclaration.fromValue(own),
    codeSurfaceOf(harness),
  );
  return {
    capabilities: [...resolved.surface.capabilities],
    posture: resolved.configuration.posture.tool_seam_host_error,
  };
}

export async function runVector(
  harness: Harness,
  vector: JsonValue,
  assessed?: AssessedSurface,
): Promise<VectorResult> {
  const v = vector as Record<string, JsonValue>;
  const vectorJson = JSON.stringify(vector);

  // §7.7.9: a harness with its own declaration is assessed against the
  // resolved document, so what ran is what a claim cites.
  const codeSurface = codeSurfaceOf(harness);
  let caps: string[];
  let posture: string;
  try {
    ({ capabilities: caps, posture } = assessed ?? assessHarness(harness));
  } catch (e) {
    return fail(v, [`harness declaration refused: ${e}`]);
  }

  const capsJson = JSON.stringify([...caps].sort());
  const skip = JSON.parse(native.ctkShouldSkip(vectorJson, capsJson));
  if (skip !== null) {
    return {
      id: v.id as string,
      title: v.title as string,
      part: (v.part as string | undefined) ?? undefined,
      status: "skip",
      detail: skip,
      failures: [],
    };
  }

  const scripts = new Scripts(v);
  const mode = ((v.mode as string) ?? "enforce") as EnforcementMode;
  // §13.2: composition vectors carry the profile/knobs they apply to;
  // absent means the pre-P-003 default (`sequential/first_deny, stop`).
  const composition =
    (v.composition as unknown as CompositionConfig | undefined) ?? Composition.default();
  // §10.1: absent → the default provider; explicit null → unbound.
  const identityProvider =
    'identity_provider' in v
      ? (v.identity_provider as 'jcs-sha256' | 'ctk-fault' | null)
      : 'jcs-sha256';

  let rr: RunRecord;
  const document = v.host_declaration;
  if (document !== undefined) {
    // §7.7.9: a declaration vector builds the emitter through the
    // loader. The runner proves the construction paths itself, then
    // hands the document and the CTK registry to the harness.
    const registry = scripts.registry(codeSurface);
    const [pathsEquivalent, pathDetail] = await provePaths(document, registry, v.id as string);
    if (harness.setupDeclared === undefined) {
      return fail(v, [
        `harness ${JSON.stringify(harness.name)} declares host_declaration but does not implement setupDeclared`,
      ]);
    }
    let refused: DeclarationError | null = null;
    try {
      harness.setupDeclared(v.scenario as unknown as Scenario, document, registry);
    } catch (e) {
      if (!(e instanceof DeclarationError)) {
        harness.teardown();
        return fail(v, [`harness.setupDeclared threw a non-declaration error: ${e}`]);
      }
      refused = e;
    }
    if (refused !== null) {
      harness.teardown();
      const load: LoadRecord = {
        outcome: "refused",
        class: refused.code,
        paths_equivalent: pathsEquivalent,
        detail: pathDetail === "" ? refused.message : `${refused.message}; paths: ${pathDetail}`,
      };
      rr = {
        outcome: "error",
        final_output: null,
        tool_invocations: [],
        error: refused.message,
        identities: [],
        records: [],
        load,
      };
    } else {
      try {
        rr = await harness.run();
      } catch (e) {
        return fail(v, [`harness.run threw: ${e}`]);
      } finally {
        harness.teardown();
      }
      rr.load = {
        outcome: "accepted",
        paths_equivalent: pathsEquivalent,
        ...(pathDetail !== "" ? { detail: pathDetail } : {}),
      };
    }
  } else {
    harness.setup(
      v.scenario as unknown as Scenario,
      scripts.interceptors(),
      scripts.resolver(),
      mode,
      composition,
      identityProvider,
      scripts.redact,
    );
    try {
      rr = await harness.run();
    } catch (e) {
      return fail(v, [`harness.run threw: ${e}`]);
    } finally {
      harness.teardown();
    }
  }

  // §13.1 posture declaration; absent means the spec default.
  const postures = { tool_seam_host_error: posture };
  return JSON.parse(
    native.ctkAssert(vectorJson, JSON.stringify(scripts.recorded()), runRecordToWire(rr, postures)),
  );
}

export async function runVectors(
  harnessFactory: () => Harness,
  vectors: JsonValue[],
): Promise<VectorResult[]> {
  const out: VectorResult[] = [];
  // Resolve the harness declaration once, before the first vector
  // (§7.7.9); a refusal fails every vector with the findings.
  let assessed: AssessedSurface | undefined;
  let refusal: unknown;
  try {
    assessed = assessHarness(harnessFactory());
  } catch (e) {
    refusal = e;
  }
  for (const v of vectors) {
    if (assessed === undefined) {
      out.push(fail(v as Record<string, JsonValue>, [`harness declaration refused: ${refusal}`]));
      continue;
    }
    out.push(await runVector(harnessFactory(), v, assessed));
  }
  return out;
}
