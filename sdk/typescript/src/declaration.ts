// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
/**
 * Host declaration document (spec §7.7): the loader, the registry it
 * resolves against, and the builder for the code path.
 *
 * A declaration is one JSON object that fixes a host's configuration
 * (§7.1, §8, §10.1, §13.1), its declared surface (§13.1) and its
 * interceptor bindings. It is a versioned contract of its own
 * (`agent-hooks-declaration/<major>.<minor>`, §7.7.2), separate from
 * the wire version `SPEC_VERSION` and from the package version.
 *
 * Every normative check lives in the Rust core. This module does the
 * two things only the wrapper can do: read a file (step 1 of §7.7.6)
 * and run the host's kind resolvers (step 11, in `emitter.ts`). Steps
 * 2 to 10 cross the native boundary as JSON text, so a document yields
 * the same refusal class here as in every other SDK.
 */

import { open, stat } from "node:fs/promises";

import {
  AgentContext,
  ApprovalResolver,
  CompositionConfig,
  CompositionProfile,
  EnforcementMode,
  InterceptionPoint,
  Interceptor,
  JsonValue,
  OnApproval,
  SynthesisPolicy,
  findNonFinite,
  nonFiniteDetail,
} from "./index";
import { AgentHooksCoreError, native } from "./native";

/** The declaration contract version this SDK writes and accepts
 * (§7.7.2). A test pins it to the core's `declaration_versions()`. */
export const DECLARATION_VERSION = "agent-hooks-declaration/1.0";

/** Every contract version the loader accepts (§7.7.2). Any other
 * `declaration` value is refused as `declaration_error:version_unsupported`. */
export const SUPPORTED_DECLARATION_VERSIONS: readonly string[] = Object.freeze([
  DECLARATION_VERSION,
]);

/** Largest document the text and file paths accept, in bytes (§7.7.3). */
export const MAX_DOCUMENT_BYTES = 1 << 20;

/** Deepest nesting the text paths accept (§7.7.3). */
export const MAX_DEPTH = 32;

/** Most entries in `bindings` (§7.7.3). */
export const MAX_BINDINGS = 256;

/** Longest binding `id`, registered name and document `id` (§7.7.3). */
export const MAX_ID_LEN = 64;

/** Longest binding `kind` (§7.7.5). */
export const MAX_KIND_LEN = 128;

/** Longest refusal detail (§7.7.3). */
export const MAX_DETAIL_LEN = 512;

/** Largest `timeout_ms`, `interceptor_ms` and `approval_resolver_ms` (§7.7.3). */
export const MAX_TIMEOUT_MS = 3_600_000;

/** The closed capability vocabulary a surface may name (§7.7.4). */
export const CAPABILITIES: readonly string[] = Object.freeze([
  "model_calls",
  "tool_calls",
  "parallel_tool_calls",
  "streaming",
  "multi_turn",
  "int64_json",
  "bigint_json",
  "incremental_output",
  "host_declaration",
]);

/** §3 lifecycle order; the order sets of points are written in. */
const POINT_ORDER: readonly InterceptionPoint[] = Object.freeze([
  "agent_startup",
  "input",
  "pre_model_call",
  "post_model_call",
  "pre_tool_call",
  "post_tool_call",
  "output",
  "agent_shutdown",
] as InterceptionPoint[]);

/** The §3.2 floor every surface carries. */
const FLOOR_POINTS: readonly InterceptionPoint[] = Object.freeze([
  "agent_startup",
  "input",
  "output",
  "agent_shutdown",
] as InterceptionPoint[]);

const RESERVED_KIND_SEGMENTS: readonly string[] = Object.freeze(["agent_hooks", "ctk"]);

// ---- errors -----------------------------------------------------------------

/** The eleven refusal classes (§7.7.6), in pipeline order. */
export const DeclarationErrorClass = Object.freeze({
  Unreadable: "declaration_error:unreadable",
  Malformed: "declaration_error:malformed",
  VersionUnsupported: "declaration_error:version_unsupported",
  SpecUnsupported: "declaration_error:spec_unsupported",
  UnknownField: "declaration_error:unknown_field",
  InvalidField: "declaration_error:invalid_field",
  Inconsistent: "declaration_error:inconsistent",
  SurfaceUnsupported: "declaration_error:surface_unsupported",
  ReferenceUnresolved: "declaration_error:reference_unresolved",
  KindUnknown: "declaration_error:kind_unknown",
  BindingRejected: "declaration_error:binding_rejected",
} as const);
export type DeclarationErrorClass = (typeof DeclarationErrorClass)[keyof typeof DeclarationErrorClass];

/** One problem a load step found: a JSON pointer into the document
 * (`/bindings/1/kind`; the empty string is the root) and a detail that
 * names members, kinds and ids but never binding configuration. */
export interface Finding {
  pointer: string;
  detail: string;
}

function truncate(s: string): string {
  const chars = Array.from(s);
  if (chars.length <= MAX_DETAIL_LEN) return s;
  return chars.slice(0, MAX_DETAIL_LEN - 1).join("") + "…";
}

/** A refused declaration (§7.7.6). Carries one class, every finding
 * that step produced and, for `version_unsupported`, the accepted
 * version set. Thrown by every construction path; never a verdict. */
export class DeclarationError extends Error {
  readonly findings: readonly Finding[];
  readonly accepted: readonly string[];

  constructor(
    /** The namespaced code, `declaration_error:<class>`. */
    public readonly code: DeclarationErrorClass,
    findings: readonly Finding[],
    accepted: readonly string[] = [],
  ) {
    // Bound the findings before anything reads them: the message, the
    // `findings` list and every log line built from either carry the
    // same 512-character detail (§7.7.6), so a resolver cannot push an
    // unbounded string into a host's log through `.message`.
    const bounded = DeclarationError.bound(findings);
    super(DeclarationError.describe(code, bounded));
    this.name = "DeclarationError";
    this.findings = bounded;
    this.accepted = [...accepted];
  }

  /** One finding under `code`. */
  static single(code: DeclarationErrorClass, pointer: string, detail: string): DeclarationError {
    return new DeclarationError(code, [{ pointer, detail }]);
  }

  /** Rebuild the error the core reported across the native boundary:
   * `code` is the `declaration_error:*` string and `detail` the JSON
   * `{"findings": [...], "accepted": [...]}`. */
  static fromCore(code: string, detail: string): DeclarationError {
    let findings: Finding[] = [];
    let accepted: string[] = [];
    try {
      const parsed = JSON.parse(detail) as { findings?: Finding[]; accepted?: string[] };
      findings = parsed.findings ?? [];
      accepted = parsed.accepted ?? [];
    } catch {
      findings = [{ pointer: "", detail }];
    }
    return new DeclarationError(code as DeclarationErrorClass, findings, accepted);
  }

  /** Copy `findings` with every detail truncated to {@link MAX_DETAIL_LEN}. */
  private static bound(findings: readonly Finding[]): Finding[] {
    return findings.map((f) => ({ pointer: f.pointer, detail: truncate(f.detail) }));
  }

  /** `code: pointer: detail; pointer: detail` (the Rust `Display`). */
  private static describe(code: string, findings: readonly Finding[]): string {
    let out = code;
    findings.forEach((f, i) => {
      out += i === 0 ? ": " : "; ";
      out += f.pointer === "" ? f.detail : `${f.pointer}: ${f.detail}`;
    });
    return out;
  }
}

/** A host registry programming error: a duplicate or reserved name, or
 * a code surface the core rejects. Distinct from
 * {@link DeclarationError}: the document is not at fault. */
export class HostRegistryError extends Error {
  constructor(detail: string) {
    super(`host registry: ${detail}`);
    this.name = "HostRegistryError";
  }
}

/** Run a native declaration call and retype its failures: a
 * `declaration_error:*` code becomes {@link DeclarationError};
 * `marshal_error` (the wrapper described its own surface wrongly)
 * becomes {@link HostRegistryError}. */
function declarationCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AgentHooksCoreError) {
      if (e.code.startsWith("declaration_error:")) {
        throw DeclarationError.fromCore(e.code, e.detail);
      }
      if (e.code === "marshal_error") {
        throw new HostRegistryError(e.detail);
      }
    }
    throw e;
  }
}

// ---- surface ----------------------------------------------------------------

/** What the host does with the run after a `host_error:*` deny at the
 * tool seam (§6.2, §13.1). */
export type ToolSeamPosture = "continue" | "terminate";

/** Whether a build bounds interceptor and resolver execution (§7).
 * This SDK always does, in its own event loop. */
export type TimeoutSupport = "bounded" | "unbounded";

/** The knob values a host supports for one profile (§13.1). Only the
 * knobs the profile consults are present. */
export interface KnobSupport {
  on_approval?: OnApproval[];
  on_disagreement?: SynthesisPolicy[];
  on_transform_conflict?: SynthesisPolicy[];
}

/** Every value of every knob the profile consults (§7.2). */
export function fullKnobSupport(profile: CompositionProfile): KnobSupport {
  switch (profile) {
    case "sequential/first_deny":
      return { on_approval: ["resume", "stop"] };
    case "parallel/strictest":
      return { on_transform_conflict: ["approval", "deny"] };
    case "parallel/unanimous":
      return { on_disagreement: ["approval", "deny"] };
    default:
      return {};
  }
}

/** The informative `host` block of a document. */
export interface HostInfo {
  name: string;
  version?: string;
}

/** What the host's code can honour (§7.7.4, §13.1): the one value the
 * loader checks a document against and the CTK derives the harness
 * surface from. A document may select a subset of this, never more.
 * The shape is the core's `HostSurface` JSON form. */
export interface HostSurface {
  /** Points the host emits. Always includes the §3.2 floor. */
  interception_points: InterceptionPoint[];
  /** Closed vocabulary ({@link CAPABILITIES}). */
  capabilities: string[];
  /** Profiles and the knob values supported under each. */
  profiles: Partial<Record<CompositionProfile, KnobSupport>>;
  /** The posture the code implements (§13.1). */
  tool_seam_host_error: ToolSeamPosture;
  /** Whether the host may declare `buffered_output: false` (§12.1a). */
  streams_unbuffered: boolean;
  /** The §12.1a exposure bound the host enforces. Required when
   * `capabilities` names `incremental_output`. */
  exposure_bound?: string;
  /** Whether this build bounds execution. Always `"bounded"` here:
   * the emitter races every call against its timeout. */
  interceptor_timeout: TimeoutSupport;
  /** Contract versions the host accepts; a subset of
   * {@link SUPPORTED_DECLARATION_VERSIONS}. */
  declaration_versions: string[];
}

function sortedPoints(points: Iterable<InterceptionPoint>): InterceptionPoint[] {
  const set = new Set(points);
  return POINT_ORDER.filter((p) => set.has(p));
}

function sortedStrings(items: Iterable<string>): string[] {
  return [...new Set(items)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Constructors for {@link HostSurface}. The core validates the
 * surface (floor, pairs, closed vocabularies) when a document is
 * resolved against it; a surface that fails there is a
 * {@link HostRegistryError}, never a refusal of the document. */
export const HostSurface = Object.freeze({
  /** The smallest honest surface for this SDK: the lifecycle floor,
   * `host_declaration`, every profile with every knob value, posture
   * `continue`, buffered output, bounded timeouts and every accepted
   * contract version. A host adds what its runtime does. */
  sdkDefault(): HostSurface {
    return {
      interception_points: [...FLOOR_POINTS],
      capabilities: ["host_declaration"],
      profiles: {
        "sequential/first_deny": fullKnobSupport("sequential/first_deny"),
        "sequential/run_all": {},
        "parallel/strictest": fullKnobSupport("parallel/strictest"),
        "parallel/unanimous": fullKnobSupport("parallel/unanimous"),
      },
      tool_seam_host_error: "continue",
      streams_unbuffered: false,
      interceptor_timeout: "bounded",
      declaration_versions: [...SUPPORTED_DECLARATION_VERSIONS],
    };
  },

  /** The surface the CTK derives from a harness's capability list and
   * posture (§7.7.9): the floor plus the model points iff
   * `model_calls` plus the tool points iff `tool_calls`. A list naming
   * `incremental_output` needs {@link HostSurface.withExposureBound}
   * on top, or the core refuses the surface. */
  fromCapabilities(caps: Iterable<string>, posture: ToolSeamPosture = "continue"): HostSurface {
    const s = HostSurface.sdkDefault();
    s.tool_seam_host_error = posture;
    const points = new Set<InterceptionPoint>(FLOOR_POINTS);
    const capabilities = new Set<string>();
    for (const c of caps) {
      if (c === "model_calls") {
        points.add("pre_model_call");
        points.add("post_model_call");
      } else if (c === "tool_calls") {
        points.add("pre_tool_call");
        points.add("post_tool_call");
      } else if (c === "incremental_output") {
        s.streams_unbuffered = true;
      }
      capabilities.add(c);
    }
    s.interception_points = sortedPoints(points);
    s.capabilities = sortedStrings(capabilities);
    return s;
  },

  /** Add points (the model pair, the tool pair, or both). */
  withPoints(surface: HostSurface, points: Iterable<InterceptionPoint>): HostSurface {
    return {
      ...surface,
      interception_points: sortedPoints([...surface.interception_points, ...points]),
    };
  },

  /** Add capabilities. */
  withCapabilities(surface: HostSurface, caps: Iterable<string>): HostSurface {
    return { ...surface, capabilities: sortedStrings([...surface.capabilities, ...caps]) };
  },

  /** State the §12.1a exposure bound an incremental host enforces. Also
   * marks the host as able to declare `buffered_output: false`. */
  withExposureBound(surface: HostSurface, bound: string): HostSurface {
    return { ...surface, streams_unbuffered: true, exposure_bound: bound };
  },
});

// ---- registry ---------------------------------------------------------------

/** What a kind resolver learns about the binding it builds (§7.7.5). */
export interface BindingContext {
  id: string;
  kind: string;
  /** The resolved `at` set, in lifecycle order. */
  at: readonly InterceptionPoint[];
  /** The resolved per-binding bound in milliseconds; `null` is unbounded. */
  timeoutMs: number | null;
  host: HostInfo | null;
  declarationVersion: string;
}

/** Host code that turns one binding's `config` into one interceptor,
 * or refuses it by throwing. The thrown message MUST NOT echo the
 * config (§7.7.5); the loader never does. */
export type KindResolver = (config: JsonValue, context: BindingContext) => Interceptor;

/** The names a registry holds, derived from what was registered and
 * never hand-written (§7.7.5). */
export interface RegistryNames {
  identity_providers: string[];
  approval_resolvers: string[];
  approval_redactors: string[];
  kinds: string[];
}

/** Reference grammar for resolver and redactor names and binding ids:
 * `^[a-z][a-z0-9_-]{0,63}$`. */
export function validReference(s: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(s) && s.length <= MAX_ID_LEN;
}

/** Binding kind grammar (§7.7.5): dot-separated lowercase segments, at
 * least two, at most 128 characters. */
export function validKind(s: string): boolean {
  if (s.length > MAX_KIND_LEN) return false;
  const segs = s.split(".");
  return segs.length >= 2 && segs.every((seg) => /^[a-z][a-z0-9_-]*$/.test(seg));
}

/** Everything a host registers in code for a declaration to reference
 * (§7.7.5): the code surface, kind resolvers, custom identity
 * providers, approval resolvers and approval redactors. One registry
 * can build many emitters. */
export class HostRegistry {
  private readonly kinds = new Map<string, KindResolver>();
  private readonly identityProviders = new Map<string, (ctx: AgentContext) => string>();
  private readonly approvalResolvers = new Map<string, ApprovalResolver>();
  private readonly approvalRedactors = new Map<string, (ctx: AgentContext) => AgentContext>();

  /** A registry over the given code surface. Kinds under the reserved
   * `agent_hooks` and `ctk` segments are refused. */
  constructor(
    public readonly surface: HostSurface,
    private readonly allowReserved = false,
  ) {}

  /** The conformance kit's registry: as the constructor, but the `ctk`
   * kind segment may be registered. */
  static forConformance(surface: HostSurface): HostRegistry {
    return new HostRegistry(surface, true);
  }

  /** Register a kind resolver. */
  kind(kind: string, resolver: KindResolver): this {
    if (!validKind(kind)) {
      throw new HostRegistryError(
        `kind ${JSON.stringify(kind)} does not match the kind grammar (see spec §7.7.5)`,
      );
    }
    const head = kind.split(".")[0];
    if (RESERVED_KIND_SEGMENTS.includes(head) && !(this.allowReserved && head === "ctk")) {
      throw new HostRegistryError(
        `kind ${JSON.stringify(kind)} uses the reserved segment ${JSON.stringify(head)} (see spec §7.7.5)`,
      );
    }
    if (this.kinds.has(kind)) {
      throw new HostRegistryError(`kind ${JSON.stringify(kind)} registered twice`);
    }
    if (typeof resolver !== "function") {
      throw new HostRegistryError(`kind ${JSON.stringify(kind)} resolver is not a function`);
    }
    this.kinds.set(kind, resolver);
    return this;
  }

  /** Register a custom identity provider (§10.1 name rules apply). */
  identityProvider(name: string, fn: (ctx: AgentContext) => string): this {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || name.startsWith("jcs")) {
      throw new HostRegistryError(
        `identity provider name ${JSON.stringify(name)} must match ^[a-z][a-z0-9_-]*$ and must not begin with 'jcs' (see spec §10.1)`,
      );
    }
    if (name.length > MAX_ID_LEN) {
      throw new HostRegistryError(
        `identity provider name ${JSON.stringify(name)} exceeds ${MAX_ID_LEN} characters`,
      );
    }
    if (this.identityProviders.has(name)) {
      throw new HostRegistryError(`identity provider ${JSON.stringify(name)} registered twice`);
    }
    this.identityProviders.set(name, fn);
    return this;
  }

  /** Register an approval resolver under a reference name. */
  approvalResolver(name: string, resolver: ApprovalResolver): this {
    HostRegistry.checkReference(name, "approval resolver");
    if (this.approvalResolvers.has(name)) {
      throw new HostRegistryError(`approval resolver ${JSON.stringify(name)} registered twice`);
    }
    this.approvalResolvers.set(name, resolver);
    return this;
  }

  /** Register an approval redactor under a reference name. */
  approvalRedactor(name: string, fn: (ctx: AgentContext) => AgentContext): this {
    HostRegistry.checkReference(name, "approval redactor");
    if (this.approvalRedactors.has(name)) {
      throw new HostRegistryError(`approval redactor ${JSON.stringify(name)} registered twice`);
    }
    this.approvalRedactors.set(name, fn);
    return this;
  }

  /** The registered names, derived (§7.7.5). */
  names(): RegistryNames {
    return {
      identity_providers: sortedStrings(this.identityProviders.keys()),
      approval_resolvers: sortedStrings(this.approvalResolvers.keys()),
      approval_redactors: sortedStrings(this.approvalRedactors.keys()),
      kinds: sortedStrings(this.kinds.keys()),
    };
  }

  /** The `host_json` the core's `declaration_resolve` takes: the surface
   * plus the registered names. */
  hostDescription(): string {
    return JSON.stringify({ surface: this.surface, ...this.names() });
  }

  /** @internal */
  kindResolver(kind: string): KindResolver | undefined {
    return this.kinds.get(kind);
  }

  /** @internal */
  identityFn(name: string): ((ctx: AgentContext) => string) | undefined {
    return this.identityProviders.get(name);
  }

  /** @internal */
  approvalResolverRef(name: string): ApprovalResolver | undefined {
    return this.approvalResolvers.get(name);
  }

  /** @internal */
  redactorFn(name: string): ((ctx: AgentContext) => AgentContext) | undefined {
    return this.approvalRedactors.get(name);
  }

  private static checkReference(name: string, what: string): void {
    if (!validReference(name)) {
      throw new HostRegistryError(
        `${what} name ${JSON.stringify(name)} does not match ^[a-z][a-z0-9_-]{0,63}$`,
      );
    }
  }
}

// ---- document ---------------------------------------------------------------

/** A declaration that passed steps 2 to 7 (§7.7.6): parsed, of an
 * accepted version, closed, well-typed and internally consistent as
 * stated. Not yet checked against any host; `InterceptionEmitter.
 * fromDeclaration` does that. */
export class HostDeclaration {
  /** `text` is the core's serialization of the validated document and
   * is what every later core call receives, so integers beyond 2^53
   * inside `bindings[].config` reach steps 8 to 10 as the file had
   * them. `doc` is the JavaScript view of the same text. */
  private constructor(
    private readonly doc: Record<string, JsonValue>,
    private readonly text: string,
  ) {}

  /** Step 1 then {@link HostDeclaration.fromJson}: open exactly `path`,
   * require a regular file of at most {@link MAX_DOCUMENT_BYTES},
   * strict UTF-8 without a byte-order mark, read once. */
  static async fromPath(path: string): Promise<HostDeclaration> {
    const unreadable = (detail: string) =>
      DeclarationError.single(DeclarationErrorClass.Unreadable, "", detail);
    let size: number;
    try {
      const st = await stat(path);
      if (!st.isFile()) throw unreadable("not a regular file");
      size = st.size;
    } catch (e) {
      if (e instanceof DeclarationError) throw e;
      throw unreadable(`cannot stat: ${ioClass(e)}`);
    }
    if (size > MAX_DOCUMENT_BYTES) {
      throw unreadable(`document is ${size} bytes; the bound is ${MAX_DOCUMENT_BYTES}`);
    }
    // Read through a bounded loop: a file that grows between the stat
    // and the read is still loaded only up to the bound plus one byte,
    // then refused.
    const buf = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
    let total = 0;
    try {
      const fh = await open(path, "r");
      try {
        while (total < buf.length) {
          const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
          if (bytesRead === 0) break;
          total += bytesRead;
        }
      } finally {
        await fh.close();
      }
    } catch (e) {
      throw unreadable(`cannot read: ${ioClass(e)}`);
    }
    if (total > MAX_DOCUMENT_BYTES) {
      throw unreadable(`document is ${total} bytes; the bound is ${MAX_DOCUMENT_BYTES}`);
    }
    const bytes = buf.subarray(0, total);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw unreadable("document starts with a byte-order mark");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw unreadable("document is not valid UTF-8");
    }
    return HostDeclaration.fromJson(text);
  }

  /** Steps 2 to 7 over JSON text, in the core. */
  static fromJson(text: string): HostDeclaration {
    const validated = declarationCall(() => native.declarationValidate(text));
    return new HostDeclaration(JSON.parse(validated) as Record<string, JsonValue>, validated);
  }

  /** Steps 2 to 7 over an in-memory value: serialized and handed to
   * {@link HostDeclaration.fromJson}, so size, depth and shape checks
   * are the same code on every path. A non-finite number, which
   * `JSON.stringify` would corrupt to `null`, is refused as
   * `malformed` first. */
  static fromValue(value: unknown): HostDeclaration {
    const hit = findNonFinite(value);
    if (hit !== null) {
      throw DeclarationError.single(
        DeclarationErrorClass.Malformed,
        "",
        `cannot serialize: ${nonFiniteDetail(hit)}`,
      );
    }
    let text: string | undefined;
    try {
      text = JSON.stringify(value);
    } catch (e) {
      throw DeclarationError.single(
        DeclarationErrorClass.Malformed,
        "",
        `cannot serialize: ${(e as Error)?.constructor?.name ?? "Error"}`,
      );
    }
    if (text === undefined) {
      throw DeclarationError.single(
        DeclarationErrorClass.Malformed,
        "",
        "cannot serialize: value has no JSON form",
      );
    }
    return HostDeclaration.fromJson(text);
  }

  /** A builder for the code path (§7.7.7). */
  static builder(): DeclarationBuilder {
    return new DeclarationBuilder();
  }

  /** The document's own `declaration` value. */
  get version(): string {
    const v = this.doc["declaration"];
    return typeof v === "string" ? v : "";
  }

  /** The validated document, verbatim (including `$schema`). A copy.
   * Integers beyond 2^53 inside `bindings[].config` are rounded in this
   * view; {@link HostDeclaration.toJson} keeps them exact. */
  toValue(): Record<string, JsonValue> {
    return JSON.parse(this.text) as Record<string, JsonValue>;
  }

  /** @internal The validated document as JSON text, as the core
   * serialized it. */
  toJson(): string {
    return this.text;
  }
}

function ioClass(e: unknown): string {
  const err = e as { code?: unknown; name?: unknown };
  if (typeof err?.code === "string") return err.code;
  if (typeof err?.name === "string") return err.name;
  return "Error";
}

// ---- resolved form ----------------------------------------------------------

/** Resolved configuration: every default filled (§7.7.3). */
export interface ResolvedConfiguration {
  mode: EnforcementMode;
  composition: CompositionConfig;
  identity_provider: string | null;
  approval: { resolver: string | null; redactor: string | null };
  posture: { tool_seam_host_error: ToolSeamPosture };
  timeouts: { interceptor_ms: number | null; approval_resolver_ms: number | null };
  records: { max_buffered: number | null };
}

/** Resolved surface (§7.7.4): the document's, or the code's when the
 * document stated none. */
export interface ResolvedSurface {
  interception_points: InterceptionPoint[];
  capabilities: string[];
  profiles: Partial<Record<CompositionProfile, KnobSupport>>;
  buffered_output: boolean;
  exposure_bound?: string;
  declaration_versions: string[];
}

/** One binding with `at` and `timeout_ms` filled. */
export interface ResolvedBinding {
  id: string;
  kind: string;
  config: JsonValue;
  at: InterceptionPoint[];
  timeout_ms: number | null;
}

/** The resolved declaration (§7.7.3 "Resolved form"): every default
 * filled, composition knobs resolved exactly as §7.2 resolves them,
 * `$schema` dropped, sets sorted. Its canonical JSON
 * ({@link canonicalDeclaration}) is the equivalence oracle for the
 * construction paths (§7.7.7). */
export interface ResolvedDeclaration {
  declaration: string;
  spec: string;
  id?: string;
  host?: HostInfo;
  configuration: ResolvedConfiguration;
  surface: ResolvedSurface;
  bindings: ResolvedBinding[];
  extensions: Record<string, JsonValue>;
}

/** RFC 8785 canonical JSON of a resolved declaration (the core's
 * `canonical_json`). */
export function canonicalDeclaration(resolved: ResolvedDeclaration): string {
  return native.canonicalJson(JSON.stringify(resolved));
}

/** Steps 8 to 10 of §7.7.6 (after steps 2 to 7 again, in the core):
 * resolve a validated declaration against the registry's surface and
 * names. Throws {@link DeclarationError} on refusal. */
export function resolveDeclaration(
  declaration: HostDeclaration,
  registry: HostRegistry,
): ResolvedDeclaration {
  const resolved = declarationCall(() =>
    native.declarationResolve(declaration.toJson(), registry.hostDescription()),
  );
  return JSON.parse(resolved) as ResolvedDeclaration;
}

/** Steps 7 (on the filled surface) and 8 against a code surface alone,
 * without a registry: what the CTK runner uses on a harness's own
 * document to learn the surface a run is assessed against (§7.7.9). */
export function resolveSurfaceOnly(
  declaration: HostDeclaration,
  surface: HostSurface,
): ResolvedDeclaration {
  const resolved = declarationCall(() =>
    native.declarationResolveSurface(declaration.toJson(), JSON.stringify(surface)),
  );
  return JSON.parse(resolved) as ResolvedDeclaration;
}

/** The contract versions the core writes and accepts (§7.7.2). */
export function declarationVersions(): { current: string; supported: string[] } {
  return JSON.parse(native.declarationVersions()) as { current: string; supported: string[] };
}

// ---- builder (code path) ----------------------------------------------------

/** A null-prototype object: every key, `__proto__` included, is an
 * own member that serializes, so the builder path refuses exactly what
 * the value path refuses. */
function plain(): Record<string, JsonValue> {
  return Object.create(null) as Record<string, JsonValue>;
}

/** Builds a declaration document in code, one setter per member
 * (§7.7.7). {@link DeclarationBuilder.build} hands the document to
 * {@link HostDeclaration.fromValue}, so the code path is validated by
 * the same function, with the same classes, as a file. */
export class DeclarationBuilder {
  private readonly doc: Record<string, JsonValue>;

  /** A builder with `declaration` set to {@link DECLARATION_VERSION}
   * and an empty `bindings` array. */
  constructor() {
    this.doc = plain();
    this.doc["declaration"] = DECLARATION_VERSION;
    this.doc["bindings"] = [];
  }

  /** A builder with no member set at all, not even `declaration` or
   * `bindings`. For harnesses that must express an incomplete
   * document; a host wants the constructor. */
  static empty(): DeclarationBuilder {
    const b = new DeclarationBuilder();
    delete b.doc["declaration"];
    delete b.doc["bindings"];
    return b;
  }

  private configuration(): Record<string, JsonValue> {
    return this.sub(this.doc, "configuration");
  }

  private configurationSub(key: string): Record<string, JsonValue> {
    return this.sub(this.configuration(), key);
  }

  private surface(): Record<string, JsonValue> {
    return this.sub(this.doc, "surface");
  }

  private sub(parent: Record<string, JsonValue>, key: string): Record<string, JsonValue> {
    const existing = parent[key];
    if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
      return existing;
    }
    const fresh = plain();
    parent[key] = fresh;
    return fresh;
  }

  /** `declaration` (defaults to {@link DECLARATION_VERSION}). */
  version(v: string): this {
    this.doc["declaration"] = v;
    return this;
  }

  spec(v: string): this {
    this.doc["spec"] = v;
    return this;
  }

  id(v: string): this {
    this.doc["id"] = v;
    return this;
  }

  host(name: string, version?: string): this {
    const h = plain();
    h["name"] = name;
    if (version !== undefined) h["version"] = version;
    this.doc["host"] = h;
    return this;
  }

  mode(mode: EnforcementMode): this {
    this.configuration()["mode"] = mode;
    return this;
  }

  /** The composition as the host states it. Knobs the profile does not
   * consult are written out and refused by {@link build}, exactly as
   * in a file. */
  composition(c: CompositionConfig): this {
    const v = plain();
    v["profile"] = c.profile;
    if (c.on_approval !== undefined) v["on_approval"] = c.on_approval;
    if (c.on_disagreement !== undefined) v["on_disagreement"] = c.on_disagreement;
    if (c.on_transform_conflict !== undefined) v["on_transform_conflict"] = c.on_transform_conflict;
    this.configuration()["composition"] = v;
    return this;
  }

  /** A name for `jcs-sha256` or a custom provider, `null` for
   * identity-unbound. */
  identityProvider(name: string | null): this {
    this.configuration()["identity_provider"] = name;
    return this;
  }

  approvalResolver(name: string | null): this {
    this.configurationSub("approval")["resolver"] = name;
    return this;
  }

  approvalRedactor(name: string | null): this {
    this.configurationSub("approval")["redactor"] = name;
    return this;
  }

  toolSeamHostError(posture: ToolSeamPosture): this {
    this.configurationSub("posture")["tool_seam_host_error"] = posture;
    return this;
  }

  /** `null` writes `null` (unbounded). */
  interceptorTimeoutMs(ms: number | null): this {
    this.configurationSub("timeouts")["interceptor_ms"] = ms;
    return this;
  }

  /** `null` writes `null` (unbounded). */
  approvalResolverTimeoutMs(ms: number | null): this {
    this.configurationSub("timeouts")["approval_resolver_ms"] = ms;
    return this;
  }

  /** `null` writes `null` (unbounded). */
  maxBufferedRecords(n: number | null): this {
    this.configurationSub("records")["max_buffered"] = n;
    return this;
  }

  surfacePoints(points: Iterable<InterceptionPoint>): this {
    this.surface()["interception_points"] = sortedPoints(points);
    return this;
  }

  surfaceCapabilities(caps: Iterable<string>): this {
    this.surface()["capabilities"] = sortedStrings(caps);
    return this;
  }

  /** Declare support for one profile and its knob values. */
  surfaceProfile(profile: CompositionProfile, knobs: KnobSupport): this {
    const profiles = this.sub(this.surface(), "profiles");
    const k: Record<string, JsonValue> = {};
    if (knobs.on_approval && knobs.on_approval.length > 0) k["on_approval"] = [...knobs.on_approval];
    if (knobs.on_disagreement && knobs.on_disagreement.length > 0) {
      k["on_disagreement"] = [...knobs.on_disagreement];
    }
    if (knobs.on_transform_conflict && knobs.on_transform_conflict.length > 0) {
      k["on_transform_conflict"] = [...knobs.on_transform_conflict];
    }
    profiles[profile] = k;
    return this;
  }

  /** `buffered_output` and, when `false`, the required exposure bound. */
  bufferedOutput(buffered: boolean, exposureBound?: string): this {
    const s = this.surface();
    s["buffered_output"] = buffered;
    if (exposureBound !== undefined) s["exposure_bound"] = exposureBound;
    else delete s["exposure_bound"];
    return this;
  }

  surfaceDeclarationVersions(versions: Iterable<string>): this {
    this.surface()["declaration_versions"] = sortedStrings(versions);
    return this;
  }

  /** Append one binding. `at` omitted binds at every surface point;
   * `timeoutMs` omitted inherits the configured interceptor timeout,
   * `null` writes `null` (unbounded), a number bounds. */
  bind(
    id: string,
    kind: string,
    config: JsonValue = {},
    at?: Iterable<InterceptionPoint>,
    timeoutMs?: number | null,
  ): this {
    const b: Record<string, JsonValue> = { id, kind, config };
    if (at !== undefined) b["at"] = sortedPoints(at);
    if (timeoutMs !== undefined) b["timeout_ms"] = timeoutMs;
    const bindings = this.doc["bindings"];
    if (Array.isArray(bindings)) bindings.push(b);
    else this.doc["bindings"] = [b];
    return this;
  }

  /** One `extensions` entry, kept verbatim. */
  extension(key: string, value: JsonValue): this {
    this.sub(this.doc, "extensions")[key] = value;
    return this;
  }

  /** Set a top-level member verbatim. For members this builder has no
   * setter for; the result is validated like any other document (an
   * unknown member is refused as `unknown_field`). */
  raw(key: string, value: JsonValue): this {
    this.doc[key] = value;
    return this;
  }

  /** The document as built, before validation. A copy. */
  toValue(): Record<string, JsonValue> {
    return JSON.parse(JSON.stringify(this.doc)) as Record<string, JsonValue>;
  }

  /** Validate (steps 2 to 7) through {@link HostDeclaration.fromValue}. */
  build(): HostDeclaration {
    return HostDeclaration.fromValue(this.doc);
  }
}
