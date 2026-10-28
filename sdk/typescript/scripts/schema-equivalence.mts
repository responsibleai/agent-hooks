#!/usr/bin/env tsx
// Copyright (c) Microsoft. All rights reserved.

// Differential validation of two schema sets, and a normalized structural
// diff between them. Used to show that regenerated schemas admit and reject
// the same instances as the schemas they replace.
//
//   tsx scripts/schema-equivalence.mts --old <git-ref|dir> [--new <dir>]
//       [--random <mutants per seed>] [--seed <n>] [--structural-diff]
//
// --old takes a git ref (the schemas are read with git show) or a directory
// laid out like spec/schema. --new defaults to the checkout's spec/schema.
//
// The corpus for every validation target is the seeds of every shape (the
// conformance vectors, the golden files and hand-written instances), plus
// systematic mutations of the target's own seeds driven by the old schema:
// each member dropped, wrong-typed, set to each enum value and one value
// outside it, pattern probes, numeric and length boundaries, an unknown
// member at each object, nullable members set to null, absent members added
// from the schema. Seeded random mutants add breadth. Every instance is
// validated with Ajv (2020-12) against the old and the new schema; the two
// verdicts must agree for every instance.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ID_BASE = "https://responsibleai.github.io/agent-hooks/schema/v0.1/";
const POINTS = [
  "agent_startup",
  "input",
  "pre_model_call",
  "post_model_call",
  "pre_tool_call",
  "post_tool_call",
  "output",
  "agent_shutdown",
];

// ---- arguments --------------------------------------------------------------

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const OLD = arg("--old");
const NEW = arg("--new", join(ROOT, "spec", "schema"))!;
const RANDOM = Number(arg("--random", "150"));
const SEED = Number(arg("--seed", "1"));
const STRUCTURAL = process.argv.includes("--structural-diff");
if (!OLD) {
  console.error("usage: schema-equivalence.mts --old <git-ref|dir> [--new <dir>] [--structural-diff]");
  process.exit(2);
}

// ---- schema sets ------------------------------------------------------------

type SchemaSet = Map<string, Obj>; // path under spec/schema -> document

function loadSet(source: string): SchemaSet {
  const set: SchemaSet = new Map();
  if (existsSync(source)) {
    const files = [
      ...readdirSync(source).filter((f) => f.endsWith(".schema.json")),
      ...readdirSync(join(source, "agent-context")).map((f) => `agent-context/${f}`),
    ];
    for (const f of files) set.set(f, JSON.parse(readFileSync(join(source, f), "utf8")));
    return set;
  }
  const listing = execFileSync("git", ["ls-tree", "-r", "--name-only", source, "--", "spec/schema"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  for (const path of listing.split("\n").filter((p) => p.endsWith(".schema.json"))) {
    const text = execFileSync("git", ["show", `${source}:${path}`], { cwd: ROOT, encoding: "utf8" });
    set.set(path.slice("spec/schema/".length), JSON.parse(text));
  }
  return set;
}

function makeAjv(set: SchemaSet): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: true });
  addFormats(ajv);
  for (const doc of set.values()) ajv.addSchema(doc);
  return ajv;
}

// Local references resolve against the file; sibling-file references
// against the set, by bare name or by $id.
interface Located {
  node: Obj;
  file: string;
}

function deref(set: SchemaSet, file: string, node: Json, depth = 0): Located {
  if (depth > 32 || node === null || typeof node !== "object" || Array.isArray(node)) {
    return { node: typeof node === "boolean" ? {} : (node as Obj), file };
  }
  const ref = node.$ref;
  if (typeof ref !== "string") return { node, file };
  let [target, pointer] = ref.split("#");
  let doc: Obj | undefined;
  let docFile = file;
  if (target === "") {
    doc = set.get(file);
  } else {
    const name = target.startsWith(ID_BASE) ? target.slice(ID_BASE.length) : target;
    docFile = name;
    doc = set.get(name);
  }
  if (!doc) throw new Error(`${file}: cannot resolve ${ref}`);
  let found: Json = doc;
  for (const seg of (pointer ?? "").split("/").filter(Boolean)) {
    found = (found as Obj)[decodeURIComponent(seg).replace(/~1/g, "/").replace(/~0/g, "~")];
    if (found === undefined) throw new Error(`${file}: ${ref} does not exist`);
  }
  const resolved = deref(set, docFile, found, depth + 1);
  const siblings = { ...node };
  delete siblings.$ref;
  return { node: { ...resolved.node, ...siblings }, file: resolved.file };
}

// ---- seeds ------------------------------------------------------------------

type Shape =
  | "verdict"
  | "response"
  | "resolution"
  | "request"
  | "context"
  | "record"
  | "declaration"
  | "point";

const seeds = new Map<Shape, Json[]>();
function seed(shape: Shape, ...values: Json[]): void {
  const list = seeds.get(shape) ?? [];
  for (const v of values) if (v !== undefined) list.push(v);
  seeds.set(shape, list);
}

function collectFromRepository(): void {
  const vectorsDir = join(ROOT, "conformance", "vectors");
  for (const f of readdirSync(vectorsDir)) {
    const v = JSON.parse(readFileSync(join(vectorsDir, f), "utf8")) as Obj;
    const scripts = [
      ...((v.interceptor_script as Obj[] | undefined) ?? []),
      ...(((v.interceptor_scripts as Obj[][] | undefined) ?? []).flat()),
    ];
    for (const rule of scripts) if (rule.return !== undefined) seed("verdict", rule.return);
    for (const rule of (v.approval_script as Obj[] | undefined) ?? []) {
      const r = rule.resolve as Obj | undefined;
      if (r) {
        seed("resolution", r, { context_identity: "ctk", ...r }, { context_identity: null, ...r });
        if (r.verdict !== undefined) seed("verdict", r.verdict);
      }
    }
    for (const key of ["host_declaration", "host_declaration_invalid"]) {
      if (v[key] !== undefined && typeof v[key] === "object") seed("declaration", v[key]);
    }
  }
  const identity = JSON.parse(readFileSync(join(ROOT, "conformance", "golden", "identity.json"), "utf8")) as Obj;
  for (const fx of identity.fixtures as Obj[]) if (fx.ctx !== undefined) seed("context", fx.ctx);
  const response = JSON.parse(
    readFileSync(join(ROOT, "conformance", "golden", "interceptor-response.json"), "utf8"),
  ) as Obj;
  for (const key of ["valid", "invalid"]) {
    for (const item of response[key] as Obj[]) if (item.input !== undefined) seed("response", item.input);
  }
  const declaration = JSON.parse(readFileSync(join(ROOT, "conformance", "golden", "declaration.json"), "utf8")) as Obj;
  for (const fx of declaration.fixtures as Obj[]) if (fx.document !== undefined) seed("declaration", fx.document);
}

function handWritten(): void {
  const base = {
    spec: "agent-hooks/0.1",
    timestamp: "2026-01-01T00:00:00Z",
    sequence: 0,
    agent: { id: "a", framework: "maf" },
    session: { id: "s" },
    target: null,
  };
  const payload: Record<string, Obj> = {
    agent_startup: { agent_init: { tools_registered: ["t"] } },
    input: { input: { content: "hi", role: "user" } },
    pre_model_call: { model: { id: "m" }, messages: [{ role: "user", content: "hi" }] },
    post_model_call: {
      model: { id: "m" },
      response: { content: "x", tool_calls: [{ name: "t", args: {} }], finish_reason: "stop" },
    },
    pre_tool_call: { tool_call: { id: "c", name: "t", args: {} } },
    post_tool_call: { tool_call: { id: "c", name: "t", args: {} }, tool_result: { value: 1, is_error: false } },
    output: { output: { content: "x" } },
    agent_shutdown: { summary: { reason: "completed" } },
  };
  const rich = {
    request_id: "r",
    usage: { prompt_tokens: 1, completion_tokens: 2 },
    tools: [{ name: "t", description: "d", schema: {} }],
    trace: { trace_id: "t", span_id: "s" },
    tenant: { id: "t", name: "n" },
    actor: { id: "u", kind: "human" },
    budgets: { tool_call_count: 1, token_count: 2.5, elapsed_seconds: 0.1, cost_usd: 0 },
    extensions: { ns: { k: 1 } },
  };
  for (const p of POINTS) {
    seed(
      "context",
      { ...base, interception_point: p, ...payload[p] },
      { ...base, interception_point: p, ...payload[p], ...rich },
      { ...base, interception_point: p },
      { ...base, interception_point: p, ...payload[p], tool_call: { id: "c", name: "t", args: {}, extra: 1 } },
      { ...base, interception_point: p, ...payload[p], model: { id: "m", extra: 1 } },
    );
  }
  seed(
    "verdict",
    { decision: "allow" },
    {
      decision: "allow",
      reason: "ok",
      message: "m",
      warnings: [{ reason: "w", message: "x" }],
      evidence: { artefact: "sha256:ab", verification_pointers: { a: "https://x" } },
      result_labels: ["pii"],
    },
    { decision: "allow", reason: null, message: null, warnings: null, result_labels: null },
    { decision: "deny", reason: "policy", approval: {} },
    { decision: "deny", approval: { ticket: 1 } },
    { decision: "transform", transform: { path: "$target.args", value: 1 } },
    { decision: "transform", transform: { path: "$policy_target[0]" } },
    { decision: "allow", transform: { path: "$target" } },
    { decision: "transform" },
    { decision: "allow", approval: {} },
    { decision: "transform", approval: {}, transform: { path: "$target" } },
    { decision: "warn" },
    {},
    { decision: "deny", reason: "host_error:x" },
    { decision: "allow", warnings: [{ reason: "host_warning:x" }] },
    { decision: "allow", evidence: { artefact: null } },
  );
  seed(
    "response",
    { verdict: { decision: "allow" } },
    { verdict: { decision: "allow" }, extensions: { prov: { receipt: "r" } } },
    { verdict: { decision: "allow" }, extensions: { "Bad-Key": 1 } },
    { verdict: { decision: "allow" }, extra: 1 },
    { decision: "allow", verdict: { decision: "allow" } },
    { verdict: { decision: "transform" } },
  );
  seed(
    "resolution",
    { outcome: "approve", context_identity: "abc", verdict: { decision: "allow" } },
    { outcome: "approve", context_identity: null, verdict: { decision: "transform", transform: { path: "$target" } } },
    { outcome: "approve", context_identity: "a", verdict: { decision: "deny" } },
    { outcome: "reject", context_identity: "a", verdict: { decision: "deny" } },
    { outcome: "reject", context_identity: "a", verdict: { decision: "deny", approval: {} } },
    { outcome: "reject", context_identity: "a", verdict: { decision: "allow" } },
    { outcome: "unresolved", context_identity: "a" },
    { outcome: "unresolved", context_identity: "a", verdict: { decision: "deny" } },
    { outcome: "approve", context_identity: "a" },
    { outcome: "approve", verdict: { decision: "allow" } },
    { outcome: "maybe", context_identity: "a" },
  );
  const ctx = { ...base, interception_point: "pre_tool_call", ...payload.pre_tool_call };
  seed(
    "request",
    { context_identity: "abc", interception_point: "pre_tool_call", verdict: { decision: "deny", reason: "host_error:interceptor_failed" } },
    { context_identity: "abc", interception_point: "pre_tool_call", verdict: { decision: "deny", approval: {} }, context: ctx },
    { context_identity: null, interception_point: "input", verdict: { decision: "allow" } },
    { context_identity: "a", interception_point: "bogus", verdict: { decision: "deny" } },
    { context_identity: "a", interception_point: "input", verdict: { decision: "deny" }, extra: 1 },
    { context_identity: "a", interception_point: "input", verdict: { decision: "deny" }, context: { ...ctx, interception_point: "input" } },
  );
  const record = {
    interception_point: "pre_tool_call",
    mode: "enforce",
    verdict: {},
    input_identity: "i",
    enforced_identity: "e",
    identity_provider: "jcs-sha256",
    session_id: "s",
    sequence: 0,
    composition: { profile: "sequential/first_deny" },
    interceptors_registered: 1,
  };
  seed(
    "record",
    record,
    { ...record, composition: { profile: "sequential/run_all" }, verdicts: [{ index: 0, decision: "allow" }] },
    { ...record, composition: { profile: "sequential/run_all" } },
    { ...record, composition: { profile: "parallel/strictest", on_transform_conflict: "deny" } },
    { ...record, composition: { profile: "parallel/unanimous", on_disagreement: "approval" }, verdicts: [] },
    { ...record, identity_provider: null, input_identity: null, enforced_identity: null },
    { ...record, identity_provider: null },
    { ...record, identity_provider: "myprov" },
    { ...record, identity_provider: "jcsx" },
    { ...record, identity_provider: "" },
    { ...record, verdict: { transform: { path: "$target" }, approval: {} } },
    { ...record, verdict: { transform: { path: "$target", value: 1 } } },
    { ...record, verdict: { approval: { ticket: 1 } } },
    { ...record, decided_by: null, resolved_by: null, fold_truncated: true, timestamp: "2026-01-01T00:00:00Z", trace: { trace_id: "t" } },
    { ...record, decided_by: 0, resolved_by: "approval", declaration: "agent-hooks-declaration/1.0" },
    { ...record, resolved_by: "other" },
    {
      ...record,
      composition: { profile: "sequential/first_deny", on_approval: "resume" },
      verdicts: [{ index: 0, decision: "allow", name: "b", substituted_for: "host_error:interceptor_timeout" }],
    },
    { ...record, extra: 1 },
  );
  const binding = { id: "b1", kind: "ns.kind", config: { any: [1] }, at: ["input"], timeout_ms: 10 };
  const configuration = {
    mode: "enforce",
    composition: { profile: "sequential/first_deny", on_approval: "stop" },
    identity_provider: "jcs-sha256",
    approval: { resolver: "r", redactor: null },
    posture: { tool_seam_host_error: "continue" },
    timeouts: { interceptor_ms: 5000, approval_resolver_ms: null },
    records: { max_buffered: 9007199254740991 },
  };
  const surface = {
    interception_points: POINTS,
    capabilities: ["model_calls", "tool_calls"],
    profiles: {
      "sequential/first_deny": { on_approval: ["stop", "resume"] },
      "sequential/run_all": {},
      "parallel/strictest": { on_transform_conflict: ["deny"] },
      "parallel/unanimous": { on_disagreement: ["approval"] },
    },
    declaration_versions: ["agent-hooks-declaration/1.0", "agent-hooks-declaration/1.1"],
  };
  for (const v of ["1.0", "1.1"]) {
    const doc = { declaration: `agent-hooks-declaration/${v}`, bindings: [] as Json[] };
    seed(
      "declaration",
      doc,
      { $schema: "x", ...doc, spec: "agent-hooks/0.1", id: "op-1", host: { name: "h", version: "1" }, configuration, surface, bindings: [binding], extensions: { ns: 1 } },
      { ...doc, surface: { ...surface, buffered_output: true } },
      { ...doc, surface: { ...surface, buffered_output: false, exposure_bound: "one chunk" } },
      { ...doc, surface: { ...surface, buffered_output: false } },
      { ...doc, surface: { ...surface, exposure_bound: "x" } },
      { ...doc, surface: { declaration_versions: ["bogus"] } },
      { ...doc, surface: { interception_points: ["input"] } },
      { ...doc, configuration: { identity_provider: "jcs-x" } },
      { ...doc, configuration: { identity_provider: null } },
      { ...doc, configuration: { identity_provider: "custom_provider" } },
      { ...doc, configuration: { failure: { on_error: "continue" } } },
      { ...doc, bindings: [{ ...binding, on_error: "deny" }] },
      { ...doc, bindings: [{ id: "b", kind: "nodot" }] },
      { ...doc, bindings: [{ id: "b", kind: "ns.k", timeout_ms: 0 }] },
      { ...doc, configuration: { records: { max_buffered: 0 } } },
      { ...doc, extensions: { "Bad": 1 } },
    );
  }
  seed("point", ...POINTS, "bogus", 1, null);
}

// ---- schema-guided mutation --------------------------------------------------

interface Guide {
  properties: Map<string, Located>;
  items?: Located;
  self: Obj;
}

// Every member name the old schema knows at this level, across applicators.
function guide(set: SchemaSet, file: string, node: Obj): Guide {
  const g: Guide = { properties: new Map(), self: node };
  const visit = (n: Json, f: string, depth: number) => {
    if (depth > 10 || n === null || typeof n !== "object" || Array.isArray(n)) return;
    const { node: d, file: df } = deref(set, f, n);
    for (const [k, v] of Object.entries((d.properties as Obj | undefined) ?? {})) {
      if (!g.properties.has(k)) g.properties.set(k, deref(set, df, v));
    }
    if (d.items !== undefined && g.items === undefined) g.items = deref(set, df, d.items);
    for (const key of ["allOf", "anyOf", "oneOf"]) for (const m of (d[key] as Json[] | undefined) ?? []) visit(m, df, depth + 1);
    for (const key of ["if", "then", "else", "not"]) if (d[key] !== undefined) visit(d[key], df, depth + 1);
  };
  visit(node, file, 0);
  return g;
}

const PATTERN_PROBES = [
  "", "x", "a b", "A", "0abc", "-", "a_b-c", "jcs", "jcsx", "jcs-sha256", "jcs-sha256x",
  "host_error:x", "host_warning:x", "$target", "$target.a", "$policy_target[0]", "$targets", "$other",
  "agent-hooks/0.1", "agent-hooks/1", "agent-hooks-declaration/1.0", "agent-hooks-declaration/x",
  `sha256:${"0".repeat(64)}`, "sha256:zz", "ns.kind", "nokind", "a.", ".a", "a".repeat(64), "a".repeat(65),
  "2026-01-01T00:00:00Z", "not-a-date",
];
const TYPE_PROBES: Json[] = [null, true, 0, -1, 1.5, "x", [], {}];

function jsonType(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function sample(set: SchemaSet, fileIn: string, raw: Json, depth = 0): Json {
  if (raw === true || raw === undefined) return "x";
  if (raw === false) return "x";
  const { node: s, file } = deref(set, fileIn, raw);
  if (depth > 8) return "x";
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum)) return (s.enum as Json[])[0];
  for (const key of ["anyOf", "oneOf"]) if (Array.isArray(s[key])) return sample(set, file, (s[key] as Json[])[0], depth + 1);
  if (Array.isArray(s.allOf)) return sample(set, file, (s.allOf as Json[])[0], depth + 1);
  let type = s.type;
  if (Array.isArray(type)) type = type[0];
  switch (type) {
    case "string": {
      const p = s.pattern as string | undefined;
      if (p) for (const probe of PATTERN_PROBES) if (new RegExp(p).test(probe)) return probe;
      const min = (s.minLength as number | undefined) ?? 1;
      return "a".repeat(Math.max(1, min));
    }
    case "integer":
    case "number":
      return (s.minimum as number | undefined) ?? 0;
    case "boolean":
      return true;
    case "null":
      return null;
    case "array": {
      const n = (s.minItems as number | undefined) ?? 0;
      const item = s.items === undefined ? "x" : sample(set, file, s.items, depth + 1);
      const items: Json[] = [];
      const itemSchema = s.items === undefined ? {} : deref(set, file, s.items).node;
      const pool = Array.isArray(itemSchema.enum) ? (itemSchema.enum as Json[]) : [item];
      for (let i = 0; i < n; i++) items.push(pool[i % pool.length]);
      return items;
    }
    case "object": {
      const out: Obj = {};
      for (const name of (s.required as string[] | undefined) ?? []) {
        const prop = ((s.properties as Obj | undefined) ?? {})[name];
        out[name] = sample(set, file, prop ?? true, depth + 1);
      }
      return out;
    }
    default:
      return "x";
  }
}

function* mutate(set: SchemaSet, file: string, schema: Obj, value: Json, depth = 0): Generator<Json> {
  if (depth > 6) return;
  if (Array.isArray(value)) {
    const g = guide(set, file, schema);
    const items = g.items ?? { node: {}, file };
    yield [];
    if (value.length > 0) {
      yield [value[0], value[0]];
      yield value.slice(0, -1);
      for (const m of mutate(set, items.file, items.node, value[0], depth + 1)) yield [m, ...value.slice(1)];
    }
    for (const n of [(g.self.minItems as number) - 1, (g.self.maxItems as number) + 1, g.self.minItems as number]) {
      if (Number.isFinite(n) && n >= 0 && n <= 300) {
        const item = value[0] ?? sample(set, items.file, items.node);
        yield Array.from({ length: n }, () => item);
      }
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    for (const probe of TYPE_PROBES) if (jsonType(probe) !== jsonType(value)) yield probe;
    if (typeof value === "string") for (const probe of PATTERN_PROBES) yield probe;
    if (typeof value === "number") {
      for (const n of [schema.minimum, schema.maximum]) {
        if (typeof n === "number") for (const d of [-1, 0, 1, 0.5]) yield n + d;
      }
      yield 1.5;
      yield -1;
    }
    if (typeof value === "boolean") yield !value;
    if (Array.isArray(schema.enum)) {
      for (const e of schema.enum as Json[]) yield e;
      yield "__not_in_enum__";
    }
    if (schema.const !== undefined) yield schema.const === "x" ? "y" : "x";
    return;
  }
  const g = guide(set, file, schema);
  const obj = value as Obj;
  yield { ...obj, __unknown__: 1 };
  const names = new Set([...g.properties.keys(), ...Object.keys(obj)]);
  for (const name of names) {
    const located = g.properties.get(name) ?? { node: {}, file };
    const prop = located.node;
    if (name in obj) {
      const rest = { ...obj };
      delete rest[name];
      yield rest;
      for (const m of mutate(set, located.file, prop, obj[name], depth + 1)) yield { ...obj, [name]: m };
      const types = Array.isArray(prop.type) ? prop.type : [prop.type];
      if (types.includes("null")) yield { ...obj, [name]: null };
    } else {
      yield { ...obj, [name]: sample(set, located.file, prop) };
      if (Array.isArray(prop.enum)) for (const e of prop.enum as Json[]) yield { ...obj, [name]: e };
    }
  }
}

// ---- seeded random mutants -----------------------------------------------------

function rng(seedValue: number): () => number {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS: Json[] = [
  null, true, false, 0, 1, -1, 1.5, 2 ** 53, "", "x", "allow", "deny", "transform", "approve", "reject",
  "unresolved", "input", "output", "agent_startup", "jcs-sha256", "jcsx", "enforce", "evaluate_only",
  "sequential/first_deny", "parallel/strictest", "stop", "resume", "approval", "rejection", "continue",
  "host_error:x", "$target", "agent-hooks-declaration/1.1", "agent-hooks/0.1", [], {}, { a: 1 }, ["x"],
];

function randomMutant(random: () => number, value: Json): Json {
  const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
  const clone = structuredClone(value) as Json;
  const edits = 1 + Math.floor(random() * 3);
  for (let i = 0; i < edits; i++) {
    let node: Json = clone;
    let parent: Obj | Json[] | null = null;
    let key: string | number = "";
    while (node !== null && typeof node === "object" && random() < 0.7) {
      const keys = Array.isArray(node) ? node.map((_, j) => j) : Object.keys(node);
      if (keys.length === 0) break;
      parent = node as Obj | Json[];
      key = pick(keys as (string | number)[]);
      node = (parent as Obj)[key as string];
    }
    if (parent === null) {
      return pick(TOKENS);
    }
    const op = random();
    if (Array.isArray(parent)) {
      if (op < 0.3) parent.splice(key as number, 1);
      else if (op < 0.6) parent[key as number] = pick(TOKENS);
      else parent.push(structuredClone(parent[0] ?? pick(TOKENS)));
    } else if (op < 0.3) {
      delete parent[key as string];
    } else if (op < 0.75) {
      parent[key as string] = pick(TOKENS);
    } else {
      parent[pick(["extra", "__x", "Bad-Key", "ns", "verdict", "transform", "approval", "exposure_bound", "on_error", "failure"])] = pick(TOKENS);
    }
  }
  return clone;
}

// ---- targets ------------------------------------------------------------------

interface Target {
  name: string;
  file: string;
  shape: Shape;
  oldPointer: string;
  newPointer: string;
}

const TARGETS: Target[] = [
  { name: "interception-point", file: "interception-point.schema.json", shape: "point", oldPointer: "", newPointer: "" },
  { name: "verdict", file: "verdict.schema.json", shape: "verdict", oldPointer: "", newPointer: "" },
  { name: "interceptor-response", file: "interceptor-response.schema.json", shape: "response", oldPointer: "", newPointer: "" },
  { name: "approval request", file: "approval.schema.json", shape: "request", oldPointer: "#/$defs/request", newPointer: "#/$defs/ApprovalRequest" },
  { name: "approval resolution", file: "approval.schema.json", shape: "resolution", oldPointer: "#/$defs/resolution", newPointer: "#/$defs/ApprovalResolution" },
  { name: "agent-context", file: "agent-context.schema.json", shape: "context", oldPointer: "", newPointer: "" },
  ...POINTS.map((p) => ({ name: `agent-context/${p}`, file: `agent-context/${p}.schema.json`, shape: "context" as Shape, oldPointer: "", newPointer: "" })),
  { name: "interception-record", file: "interception-record.schema.json", shape: "record", oldPointer: "", newPointer: "" },
  { name: "host-declaration-1.0", file: "host-declaration-1.0.schema.json", shape: "declaration", oldPointer: "", newPointer: "" },
  { name: "host-declaration-1.1", file: "host-declaration-1.1.schema.json", shape: "declaration", oldPointer: "", newPointer: "" },
];

function pointerSchema(set: SchemaSet, file: string, pointer: string): Obj {
  let node: Json = set.get(file)!;
  for (const seg of pointer.replace(/^#\//, "").split("/").filter(Boolean)) node = (node as Obj)[seg];
  return node as Obj;
}

// ---- structural diff ------------------------------------------------------------

const ANNOTATIONS = new Set(["title", "description", "$id", "$schema", "$comment", "examples", "default"]);

function normalize(set: SchemaSet, file: string, node: Json, depth = 0): Json {
  if (node === true) return {};
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => normalize(set, file, n, depth + 1));
  if (depth > 40) return "<depth>";
  let obj = node as Obj;
  if (typeof obj.$ref === "string") {
    const ref = obj.$ref;
    const target = ref.split("#")[0];
    const nextFile = target === "" ? file : target.startsWith(ID_BASE) ? target.slice(ID_BASE.length) : target;
    obj = deref(set, file, obj).node;
    file = nextFile;
  }
  const out: Obj = {};
  for (const key of Object.keys(obj).sort()) {
    if (ANNOTATIONS.has(key) || key === "$defs") continue;
    let v = normalize(set, file, obj[key], depth + 1);
    if ((key === "type" || key === "enum" || key === "required") && Array.isArray(v)) {
      v = [...v].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(v)) {
      v = [...v].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    out[key] = v;
  }
  // Spellings that admit the same instances.
  if (out.additionalProperties === true) delete out.additionalProperties;
  if (isEmptyObject(out.additionalProperties)) delete out.additionalProperties;
  if (isEmptyObject(out.properties)) delete out.properties;
  if (Array.isArray(out.enum) && (out.enum as Json[]).length === 1 && out.const === undefined) {
    out.const = (out.enum as Json[])[0];
    delete out.enum;
  }
  const literals = out.const !== undefined ? [out.const] : Array.isArray(out.enum) ? (out.enum as Json[]) : null;
  if (literals && typeof out.type === "string" && literals.every((l) => jsonType(l) === out.type)) delete out.type;
  // A nullable member: anyOf [X, {type: null}] and type [..., null] (with null in enum) mean the same.
  const branches = out.anyOf as Json[] | undefined;
  if (branches && branches.length === 2) {
    const nul = branches.findIndex((b) => ['{"type":"null"}', '{"const":null}'].includes(JSON.stringify(b)));
    const other = branches[1 - nul];
    if (nul >= 0 && other !== null && typeof other === "object" && !Array.isArray(other)) {
      const merged = { ...(other as Obj) };
      const t = merged.type;
      const types = Array.isArray(t) ? [...t] : t === undefined ? [] : [t];
      if (Array.isArray(merged.enum)) {
        for (const e of merged.enum as Json[]) if (!types.includes(jsonType(e))) types.push(jsonType(e));
        merged.enum = [...(merged.enum as Json[]), null].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      merged.type = [...types, "null"].sort() as Json;
      delete out.anyOf;
      return { ...out, ...merged };
    }
  }
  return out;
}

function isEmptyObject(v: Json | undefined): boolean {
  return v !== undefined && v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
}

function diff(a: Json, b: Json, path: string, out: string[]): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diff((a as Obj)[k], (b as Obj)[k], `${path}/${k}`, out);
    }
    return;
  }
  const show = (v: Json) => (v === undefined ? "(absent)" : JSON.stringify(v).slice(0, 160));
  out.push(`${path || "/"}\n    old: ${show(a)}\n    new: ${show(b)}`);
}

// ---- main ------------------------------------------------------------------------

function main(): number {
  const oldSet = loadSet(OLD!);
  const newSet = loadSet(NEW);
  if (STRUCTURAL) {
    let total = 0;
    for (const t of TARGETS) {
      const a = normalize(oldSet, t.file, pointerSchema(oldSet, t.file, t.oldPointer));
      const b = normalize(newSet, t.file, pointerSchema(newSet, t.file, t.newPointer));
      const lines: string[] = [];
      diff(a, b, "", lines);
      total += lines.length;
      console.log(`== ${t.name}: ${lines.length} differing path(s)`);
      for (const l of lines.slice(0, 12)) console.log(`  ${l}`);
      if (lines.length > 12) console.log(`  ... ${lines.length - 12} more`);
    }
    console.log(`structural diff: ${total} differing path(s) after normalization`);
    return 0;
  }
  const oldAjv = makeAjv(oldSet);
  const newAjv = makeAjv(newSet);
  collectFromRepository();
  handWritten();
  const everySeed = [...seeds.values()].flat();
  const random = rng(SEED);
  let totalInstances = 0;
  let totalDisagreements = 0;
  const examples: string[] = [];
  console.log("target                        instances  valid(old)  valid(new)  disagree");
  for (const t of TARGETS) {
    const validateOld = oldAjv.getSchema(ID_BASE + t.file + t.oldPointer);
    const validateNew = newAjv.getSchema(ID_BASE + t.file + t.newPointer);
    if (!validateOld || !validateNew) throw new Error(`${t.name}: validator missing`);
    const own = seeds.get(t.shape) ?? [];
    const oldSchema = pointerSchema(oldSet, t.file, t.oldPointer);
    const corpus = new Map<string, Json>();
    const add = (v: Json) => {
      const key = JSON.stringify(v);
      if (key !== undefined && !corpus.has(key)) corpus.set(key, v);
    };
    for (const s of everySeed) add(s);
    for (const s of own) {
      for (const m of mutate(oldSet, t.file, oldSchema, s)) add(m);
      for (let i = 0; i < RANDOM; i++) add(randomMutant(random, s));
    }
    let validOld = 0;
    let validNew = 0;
    let disagree = 0;
    for (const instance of corpus.values()) {
      const a = validateOld(instance) === true;
      const b = validateNew(instance) === true;
      if (a) validOld++;
      if (b) validNew++;
      if (a !== b) {
        disagree++;
        if (examples.length < 20) {
          examples.push(`${t.name}: old ${a ? "accepts" : "rejects"}, new ${b ? "accepts" : "rejects"}: ${JSON.stringify(instance).slice(0, 300)}`);
        }
      }
    }
    totalInstances += corpus.size;
    totalDisagreements += disagree;
    console.log(
      `${t.name.padEnd(29)} ${String(corpus.size).padStart(9)}  ${String(validOld).padStart(10)}  ${String(validNew).padStart(10)}  ${String(disagree).padStart(8)}`,
    );
  }
  console.log(`total: ${totalInstances} instances across ${TARGETS.length} targets, ${totalDisagreements} disagreements (seed ${SEED}, ${RANDOM} random mutants per seed)`);
  for (const e of examples) console.log(`  ${e}`);
  return totalDisagreements ? 1 : 0;
}

process.exit(main());
