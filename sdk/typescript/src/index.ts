// Copyright (c) Microsoft. All rights reserved.

/**
 * agent-hooks: framework-neutral agent lifecycle hook contract.
 * Generated draft wire types with explicit legacy 0.1 runtime compatibility.
 */

import { native, AgentHooksCoreError } from "./native";
import {
  Decision,
  InterceptionPoint,
  Mode as EnforcementMode,
  CompositionProfile,
  OnError,
  Outcome as ApprovalOutcome,
  type AgentContext,
  type Evidence,
  type Warning,
  type AllowVerdict,
  type DenyVerdict,
  type JsonValue,
  type OnApproval,
  type ConflictResolution,
  type CompositionConfig as WireCompositionConfig,
  type InputHookResponse,
  type PreModelHookResponse,
  type PostModelHookResponse,
  type PreToolHookResponse,
  type PostToolHookResponse,
  type OutputHookResponse,
  type AgentStartupHookResponse,
  type AgentShutdownHookResponse,
  type InterceptionRecord,
  type request as ApprovalRequest,
  type resolution as ApprovalResolution,
} from "./generated/types";
import {
  draftResponse, draftTransform, draftContextWithTarget, withoutTarget,
  validateDraftContext, restoreDraftResponse,
} from "./draft";
export * from "./generated/types";
export { EnforcementMode, ApprovalOutcome };
export type { ApprovalRequest, ApprovalResolution };
export type { HostDeclaration as HostDeclarationDocument } from "./generated/types";
export { AgentHooksCoreError };

/** The wire string of specification 0.1 (§4.1 `spec`). */
export const SPEC_VERSION_0_1 = "agent-hooks/0.1";

/** The wire string of the draft specification, `spec/draft/`. The draft
 * changes without notice and is never claimed; a cut copies it to a
 * numbered version with a wire string of its own (VERSIONING.md). */
export const SPEC_VERSION_DRAFT = "agent-hooks/draft";

/** The specification versions this SDK supports, oldest first; each
 * names a `spec/<entry>/` folder, and the last numbered entry is the
 * newest released version (VERSIONING.md). None is a default: a host
 * names the version it runs under when it builds a context or an
 * emitter ({@link SPEC_VERSION_0_1} or {@link SPEC_VERSION_DRAFT}), or
 * in its declaration's `spec` member. A test pins it to the core. */
export const SUPPORTED_SPEC_VERSIONS: readonly string[] = Object.freeze(["0.1", "draft"]);

/** The wire strings of {@link SUPPORTED_SPEC_VERSIONS}, in the same order. */
export const SUPPORTED_SPEC_WIRE_VERSIONS: readonly string[] = Object.freeze(
  SUPPORTED_SPEC_VERSIONS.map((v) => `agent-hooks/${v}`),
);

/** Whether `wire` names a specification version this SDK supports. */
export function isSupportedSpecVersion(wire: unknown): wire is string {
  return typeof wire === "string" && SUPPORTED_SPEC_WIRE_VERSIONS.includes(wire);
}

/** The wire string `wire` when it names a supported specification
 * version; otherwise a `RangeError` naming the supported ones. Every
 * constructor that takes a version runs its argument through this. */
export function requireSpecVersion(wire: unknown, what = "spec"): string {
  if (isSupportedSpecVersion(wire)) return wire;
  throw new RangeError(
    `${what} must name a supported specification version, one of ${SUPPORTED_SPEC_WIRE_VERSIONS.join(", ")} (SUPPORTED_SPEC_VERSIONS); got ${JSON.stringify(wire)}`,
  );
}

/** Name of the default identity provider (§10.1, §10.2). */
export const JCS_SHA256 = "jcs-sha256";

/** Whether a `transform` verdict is permitted at `hp` (§3, §4.3). */
export function transformPermitted(hp: InterceptionPoint): boolean {
  return hp !== InterceptionPoint.AgentStartup && hp !== InterceptionPoint.AgentShutdown;
}

/** Whether the action proceeds under `d` (§2 permit class). */
export function permits(d: Decision): boolean {
  return d === Decision.Allow || d === Decision.Transform;
}

/** Reserved `host_error:*` reasons a host synthesizes (§11). */
export const HostError = Object.freeze({
  ContextInvalid: "host_error:context_invalid",
  InterceptorFailed: "host_error:interceptor_failed",
  InterceptorTimeout: "host_error:interceptor_timeout",
  VerdictInvalid: "host_error:verdict_invalid",
  TransformInvalid: "host_error:transform_invalid",
  TransformTargetForbidden: "host_error:transform_target_forbidden",
  TransformConflict: "host_error:transform_conflict",
  CompositionDisagreement: "host_error:composition_disagreement",
  ApprovalResolverFailed: "host_error:approval_resolver_failed",
  ApprovalUnresolved: "host_error:approval_unresolved",
  ApprovalIdentityMismatch: "host_error:approval_identity_mismatch",
  AdapterUnsupported: "host_error:adapter_unsupported",
  StreamingUnsupported: "host_error:streaming_unsupported",
  NoInterceptor: "host_error:no_interceptor",
} as const);
export type HostError = (typeof HostError)[keyof typeof HostError];

/** Reserved `host_warning:*` reasons a host synthesizes (§11.1,
 * `spec/draft/reserved-warnings.json`). Under the draft interceptors MUST
 * NOT emit them; the §5 gate refuses such a verdict as
 * `host_error:verdict_invalid`. 0.1 reserves `host_error:*` only. */
export const HostWarning = Object.freeze({
  /** A registration whose `on_error` is `continue` failed and the host
   * substituted an allow for its slot (§6.3.1). */
  ControlFailed: "host_warning:control_failed",
} as const);
export type HostWarning = (typeof HostWarning)[keyof typeof HostWarning];

/** The three failures `on_error` covers (§6.3.1). */
export function isControlFailure(reason: string): boolean {
  return (
    reason === HostError.InterceptorFailed ||
    reason === HostError.InterceptorTimeout ||
    reason === HostError.VerdictInvalid
  );
}

/** What the host tells the principal when a control failed and the
 * action continued (§6.3.1). Payload-free: the registration label, the
 * reserved reason and the host-synthesized message, never context or
 * target content. */
export interface ControlFailureNotice {
  /** The interception point of the emission, when the context carried
   * a parseable one. */
  interception_point?: InterceptionPoint;
  /** Dispatch index of the failing registration (`verdicts[].index`). */
  index: number;
  /** The registration name (a declaration binding id) or
   * `interceptor-<index>` for an unnamed code registration. */
  binding: string;
  /** The underlying `host_error:*` reason, also recorded as
   * `verdicts[].substituted_for`. */
  reason: string;
  /** `<binding>: <reason>; host continued`. */
  message: string;
}

/** Host callback that relays a {@link ControlFailureNotice} to the
 * principal (§6.3.1): the user in an interactive session, otherwise
 * the agent through the host's own message channel. A notifier that
 * throws withdraws the continuation: the deny stands. */
export type ControlFailureNotifier = (notice: ControlFailureNotice) => void;

/** Options for {@link InterceptionEmitter.registerWithOptions} and
 * {@link InterceptionEmitter.registerManaged} (§7.7.5, §6.3.1). */
export interface RegistrationOptions {
  /** Payload-free name recorded on `verdicts[].name` (§10.3). */
  name?: string;
  /** Points the interceptor runs at; omitted binds every point. */
  at?: Iterable<InterceptionPoint>;
  /** Failure posture; `deny` when omitted. `continue` needs a
   * notifier set first ({@link InterceptionEmitter.setControlFailureNotifier}). */
  onError?: OnError;
}

/** Thrown by {@link InterceptionEmitter.registerWithOptions} and
 * {@link InterceptionEmitter.registerManaged} when a registration asks
 * for `on_error: continue` on an emitter under 0.1, which defines no
 * failure posture, or on one with no control failure notifier. Nothing
 * is registered then. */
export class RegistrationError extends Error {
  constructor(public readonly detail: string) {
    super(`registration refused: ${detail}`);
    this.name = "RegistrationError";
  }
}

/** A single `$target`-rooted replacement (§5.2). */
export interface LegacyTransform {
  /** Path rooted at `$target` (or the deprecated `$policy_target` alias). */
  path: string;
  value: JsonValue;
}

/** Released 0.1 interceptor verdict; draft interceptors return a HookResponse. */
export interface LegacyVerdict {
  decision: Decision;
  reason?: string | null;
  message?: string | null;
  /** Recorded concerns; permitted on any decision (§5.1). */
  warnings?: Warning[] | null;
  /** Present only on `deny`: marks the deny as liftable by the approval
   * seam (§9). MAY be empty; reserved for approver-facing parameters. */
  approval?: Record<string, JsonValue>;
  transform?: LegacyTransform;
  evidence?: Evidence;
  result_labels?: string[] | null;
}

export type Verdict = (
  | AgentStartupHookResponse | InputHookResponse | PreModelHookResponse | PostModelHookResponse
  | PreToolHookResponse | PostToolHookResponse | OutputHookResponse | AgentShutdownHookResponse
)["verdict"];
export type HookResponse = Omit<AgentStartupHookResponse, "verdict"> & { verdict: Verdict };
export type Transform = Extract<Verdict, { decision: "transform" }>["transform"];
export type RuntimeAgentContext = AgentContext | LegacyAgentContext;
export type RuntimeInterceptionRecord = InterceptionRecord | LegacyInterceptionRecord;

/** Released 0.1 response envelope. Draft responses are always hook-specific envelopes. */
export interface LegacyInterceptorResponse {
  verdict: LegacyVerdict;
  extensions?: Record<string, JsonValue>;
}
export type InterceptorResponse = HookResponse;
export type { VerdictSlot as VerdictSummary } from "./generated/types";

/** Constructor sugar for the three-verdict vocabulary (§5.1). Draft responses wrap these in `verdict`. */
export const Verdict = Object.freeze({
  /** The trivial permit verdict. */
  allow(): AllowVerdict {
    return { decision: Decision.Allow };
  },
  /** What earlier drafts called `warn`: an `allow` carrying one
   * warning (§5.1). */
  warn(reason?: string, message?: string): AllowVerdict {
    return { decision: Decision.Allow, warnings: [{ reason, message }] };
  },
  /** A plain, final deny: no `approval` block, so the approval seam
   * cannot lift it (§5.1). */
  deny(reason?: string, message?: string): DenyVerdict {
    return { decision: Decision.Deny, reason, message };
  },
  /** What earlier drafts called `escalate`: a liftable deny — denied
   * as-is unless the approval seam lifts it (§5.1, §9). */
  escalate(reason?: string, message?: string): DenyVerdict {
    return { decision: Decision.Deny, reason, message, approval: {} };
  },
});

/** The trivial permit verdict. */
export const ALLOW: Readonly<AllowVerdict> = Object.freeze({ decision: Decision.Allow });

/** Host-synthesized deny verdict for a §11 failure. */
export function hostErrorVerdict(err: HostError, message?: string): Extract<Verdict, { decision: "deny" }> {
  return { decision: Decision.Deny, reason: err, message };
}

/** Host-synthesized **liftable** deny (§7.5 `"approval"` knob value):
 * the failure is consultable rather than final. */
export function hostErrorLiftable(err: HostError, message?: string): Extract<Verdict, { decision: "deny" }> {
  return { ...hostErrorVerdict(err, message), approval: {} };
}

/** A deny carrying an `approval` block (§5.1). */
export function isLiftable(v: Verdict | LegacyVerdict): boolean {
  return v.decision === Decision.Deny && v.approval != null;
}

// ---- Composition (§7) -------------------------------------------------------

/** `"deny" | "approval"` knob value (§7.5): synthesize a plain deny, or
 * a liftable one and consult the seam. */
export type SynthesisPolicy = ConflictResolution;

/** The composition profile and knobs in effect for one emission
 * (§7.1, §10.3). Serialized verbatim into the record's `composition`
 * block. */
export type CompositionConfig = WireCompositionConfig & { profile: CompositionProfile };

/** Constructors for the closed profile set (§7.2). */
export const Composition = Object.freeze({
  /** The default: `sequential/first_deny` with `on_approval: stop`. A
   * default, not a conformance baseline — no profile is mandatory. */
  default(): CompositionConfig {
    return { profile: CompositionProfile.SequentialFirstDeny, on_approval: "stop" };
  },
  firstDeny(onApproval: OnApproval = "stop"): CompositionConfig {
    return { profile: CompositionProfile.SequentialFirstDeny, on_approval: onApproval };
  },
  runAll(): CompositionConfig {
    return { profile: CompositionProfile.SequentialRunAll };
  },
  strictest(onTransformConflict: SynthesisPolicy = "deny"): CompositionConfig {
    return {
      profile: CompositionProfile.ParallelStrictest,
      on_transform_conflict: onTransformConflict,
    };
  },
  unanimous(
    onDisagreement: SynthesisPolicy = "deny",
    onTransformConflict: SynthesisPolicy = "deny",
  ): CompositionConfig {
    return {
      profile: CompositionProfile.ParallelUnanimous,
      on_disagreement: onDisagreement,
      on_transform_conflict: onTransformConflict,
    };
  },
});

// ---- Identity provider (§10.1) ----------------------------------------------

/** The host-declared identity provider (§10.1):
 *
 * - `"jcs-sha256"` — the shipped default (§10.2); fail-closed I-JSON
 *   domain; in effect unless the host configures otherwise.
 * - `{name, fn}` — a host-supplied pure function. The echo and record
 *   rules (§10.1) still apply; the golden vectors do not.
 * - `null` — identity-unbound: approvals bind by correlation only;
 *   records carry `null` identities and self-describe as unbound. */
export type IdentityProvider =
  | typeof JCS_SHA256
  | { name: string; fn: (ctx: RuntimeAgentContext) => string }
  | null;

/** Wire-shaped agent context (§4). Required core typed; conditional and
 * optional fields indexed. */
export interface LegacyAgentContext {
  spec: "agent-hooks/0.1";
  interception_point: InterceptionPoint;
  timestamp: string;
  sequence: number;
  agent: { id: string; framework: string; name?: string; version?: string };
  session: { id: string; started_at?: string; turn?: number };
  target: JsonValue;
  extensions?: Record<string, JsonValue>;
  [conditional: string]: JsonValue | undefined;
}

/** Payload-free per-interceptor summary on the record (§10.3). */
export interface LegacyVerdictSummary {
  index: number;
  decision: Decision;
  reason?: string | null;
  /** Host-chosen payload-free registration identifier (§10.3). */
  name?: string;
  /** Present iff the host substituted an allow for this registration's
   * failure under `on_error: continue` (§6.3.1, §10.3): the underlying
   * `host_error:*` reason. The entry's `decision` is then `allow` and
   * its `reason` absent. */
  substituted_for?: string;
}

/** Host-side record of one emission (§10.3).
 *
 * Payload-free by design: the identities (when a provider is declared)
 * bind the record to the exact pre/post-composition context without
 * duplicating the (possibly sensitive) payload into audit storage.
 * `composition` makes the record interpretable without out-of-band
 * knowledge of host configuration. */
export interface LegacyInterceptionRecord {
  interception_point: InterceptionPoint;
  mode: EnforcementMode;
  /** The combined verdict (§7.3), possibly host-synthesized or
   * approval-substituted. */
  verdict: LegacyVerdict;
  /** Provider output before dispatch; `null` iff `identity_provider` is
   * `null` (or the provider itself rejected the context). */
  input_identity: string | null;
  /** Provider output after composition completes. */
  enforced_identity: string | null;
  /** The declared identity provider (§10.1). */
  identity_provider: string | null;
  /** `ctx.session.id` — correlates records across a session. */
  session_id: string;
  /** `ctx.sequence` — total order within the session (§12.2.3). */
  sequence: number;
  /** RFC 3339 instant copied from `ctx.timestamp` (§10.3); absent when
   * the context lacked the field. */
  timestamp?: string;
  /** W3C Trace Context correlation echoed from the context's optional
   * `trace` block (§4.5); absent when the context carried none. */
  trace?: { trace_id?: string; span_id?: string };
  /** Registration index of the interceptor whose verdict won the
   * aggregation or whose liftable deny was consulted (§7.6); `null`
   * for a pure-allow combination or a host-synthesized verdict. */
  decided_by: number | null;
  /** The composition profile and knobs in effect (§7.1). */
  composition: CompositionConfig;
  /** The host declaration contract version the emitter was built from
   * (§7.7.8), e.g. `agent-hooks-declaration/1.0`. Present iff the
   * emitter was constructed from a declaration document; absent for
   * an emitter configured in code. */
  declaration?: string;
  /** Per-interceptor summary; populated in multi-verdict profiles
   * (`sequential/run_all`, `parallel/*`) and whenever a slot was
   * substituted under `on_error: continue` (§6.3.1). */
  verdicts?: LegacyVerdictSummary[];
  /** `true` iff one or more registered interceptors were never invoked
   * in this emission (short-circuit, approval-stop, or a failed
   * fold-transform). Defined for the sequential profiles (§7.4). */
  fold_truncated?: boolean;
  /** Consultation outcome (§7.6, §10.3): `"approval"` iff a permit
   * resolution substituted; `"rejection"` iff consulted without a
   * lift; absent iff never consulted. */
  resolved_by?: "approval" | "rejection" | null;
  /** Interceptors bound at the emitted point (§10.3, §7.7.8). */
  interceptors_registered: number;
}

/** Whether the guarded action executes (§6, §8). */
export function proceeds(r: RuntimeInterceptionRecord): boolean {
  return r.mode === EnforcementMode.EvaluateOnly || permits(r.verdict.decision);
}

/** Interceptor protocol (§7). */
export type ContextForSpec<S extends string> =
  S extends typeof SPEC_VERSION_DRAFT ? AgentContext :
  S extends typeof SPEC_VERSION_0_1 ? LegacyAgentContext : RuntimeAgentContext;
export type RecordForSpec<S extends string> =
  S extends typeof SPEC_VERSION_DRAFT ? InterceptionRecord :
  S extends typeof SPEC_VERSION_0_1 ? LegacyInterceptionRecord : RuntimeInterceptionRecord;
export type ResponseForSpec<S extends string> =
  S extends typeof SPEC_VERSION_DRAFT ? HookResponse :
  S extends typeof SPEC_VERSION_0_1 ? LegacyVerdict : HookResponse | LegacyVerdict;
export interface Interceptor<S extends string = string> {
  intercept(context: ContextForSpec<S>): ResponseForSpec<S> | Promise<ResponseForSpec<S>>;
}

/** Typed completion of a {@link ManagedInterceptor} (§6.3, timeout
 * ownership). `timeout` is reported only after the interceptor has
 * cancelled and cleaned up its external work; `cancelled` is never a
 * timeout and never continues. */
export type ManagedInterceptorOutcome<R = HookResponse | LegacyVerdict> =
  /** A verdict; it crosses the same §5 gate as any interceptor's. */
  | { outcome: "verdict"; verdict: R }
  /** The work exceeded the resolved bound and has been cleaned up.
   * Recorded as `host_error:interceptor_timeout`; eligible for
   * `on_error: continue`. */
  | { outcome: "timeout" }
  /** The host or runtime cancelled the emission. Recorded as
   * `host_error:interceptor_failed`; never continues. */
  | { outcome: "cancelled" }
  /** The work failed. `detail` is payload-free (an error type name,
   * never content). Recorded as `host_error:interceptor_failed`;
   * eligible for `continue`. */
  | { outcome: "failed"; detail?: string };

/** An interceptor that owns external work (a child process, an HTTP
 * call) and therefore its own deadline (§6.3). The emitter does not
 * wrap it in the outer timer; it hands the interceptor the resolved
 * bound for the registration (`null` is unbounded), and the
 * interceptor MUST cancel and clean up the work before it reports
 * `timeout`. Register through {@link InterceptionEmitter.registerManaged}
 * or a {@link ManagedKindResolver}. */
export interface ManagedInterceptor<S extends string = string> {
  interceptManaged(
    context: ContextForSpec<S>,
    boundMs: number | null,
  ): ManagedInterceptorOutcome<ResponseForSpec<S>> | Promise<ManagedInterceptorOutcome<ResponseForSpec<S>>>;
}

/** `context_identity` is `null` when the identity provider is `null`
 * (§10.1) — the approval is then identity-unbound. */
export interface LegacyApprovalRequest {
  context_identity: string | null;
  interception_point: InterceptionPoint;
  verdict: LegacyVerdict;
  context: RuntimeAgentContext;
}

/** The resolution's `context_identity` MUST echo the request's byte for
 * byte (`null` echoes as `null`, §9 echo rule). */
export interface LegacyApprovalResolution {
  outcome: ApprovalOutcome;
  context_identity: string | null;
  verdict?: LegacyVerdict;
}

export type ApprovalRequestForSpec<S extends string> =
  S extends typeof SPEC_VERSION_DRAFT ? ApprovalRequest :
  S extends typeof SPEC_VERSION_0_1 ? LegacyApprovalRequest : ApprovalRequest | LegacyApprovalRequest;
export type ApprovalResolutionForSpec<S extends string> =
  S extends typeof SPEC_VERSION_DRAFT ? ApprovalResolution :
  S extends typeof SPEC_VERSION_0_1 ? LegacyApprovalResolution : ApprovalResolution | LegacyApprovalResolution;
export interface ApprovalResolver<S extends string = string> {
  resolve(request: ApprovalRequestForSpec<S>): ApprovalResolutionForSpec<S> | Promise<ApprovalResolutionForSpec<S>>;
}

// ---- Non-finite guard (§4.4, §10.2) -----------------------------------------
//
// `JSON.stringify` silently corrupts NaN/±Infinity to `null`, so every
// marshalling point below pre-scans and fails closed
// (`host_error:context_invalid`) instead of letting the corrupted value
// cross the boundary. The core never sees a non-finite number (it is
// unrepresentable in JSON), which is exactly why the guard must live on
// the JS side of the funnel.

/** Depth-first scan for non-finite numbers. Returns the dotted path of
 * the first offender, or `null` when the value is clean. */
export function findNonFinite(v: unknown, path = "$"): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? null : path;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = findNonFinite(v[i], `${path}[${i}]`);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (v !== null && typeof v === "object") {
    for (const [k, item] of Object.entries(v)) {
      const hit = findNonFinite(item, `${path}.${k}`);
      if (hit !== null) return hit;
    }
    return null;
  }
  return null;
}

/** §4.4 remediation detail for a non-finite number at `path`. */
export function nonFiniteDetail(path: string): string {
  return `${path}: non-finite number (NaN/Infinity) is not representable in JSON; remove or string-encode it, see spec §4.4`;
}

/** Marshalling guard: `JSON.stringify` that fails closed
 * (`host_error:context_invalid`) on non-finite numbers instead of
 * silently corrupting them to `null` (§4.4). */
function marshal(v: unknown): string {
  const hit = findNonFinite(v);
  if (hit !== null) throw new AgentHooksCoreError(HostError.ContextInvalid, nonFiniteDetail(hit));
  return JSON.stringify(v);
}

// ---- Canonical JSON & context identity (§10) -------------------------------
//
// Delegates to the Rust core via napi-rs so every SDK produces
// byte-identical output. The pure-TS implementation was removed once the
// core became canonical (see sdk/rust/core/src/canonical.rs).

/** Serialize per §10.2 (RFC 8785). Implemented by the Rust core. */
export function canonicalJson(v: JsonValue): string {
  return native.canonicalJson(marshal(v));
}

/** `"sha256:" + hex(SHA-256(canonicalJson(ctx_rc)))` (§10.2). Fails
 * closed (`host_error:context_invalid` with remediation detail) on a
 * non-I-JSON projection — integrals beyond ±(2^53−1), non-finite
 * numbers. Rust core. */
export function contextIdentity(ctx: RuntimeAgentContext): string {
  if (ctx.spec === SPEC_VERSION_DRAFT) validateDraftContext(ctx);
  return native.contextIdentity(marshal(ctx));
}

/** Validate a verdict. Draft validation requires its interception point. */
export function validateVerdict(v: Verdict | LegacyVerdict, spec: string, point?: InterceptionPoint): void {
  requireSpecVersion(spec);
  if (spec === SPEC_VERSION_DRAFT) {
    if (!point) throw new TypeError("Draft verdict validation requires an interception point");
    const response = draftResponse({ verdict: v }, point);
    native.validateVerdict(spec, marshal(response.verdict));
  } else {
    native.validateVerdict(spec, marshal(v));
  }
}

/** Parse a draft hook response, or a released 0.1 verdict/envelope. Draft calls require a point. */
export function parseInterceptorResponse(
  value: unknown,
  spec: typeof SPEC_VERSION_DRAFT,
  point: InterceptionPoint,
): InterceptorResponse;
export function parseInterceptorResponse(value: unknown, spec: typeof SPEC_VERSION_0_1): LegacyInterceptorResponse;
export function parseInterceptorResponse(
  value: unknown,
  spec: string,
  point?: InterceptionPoint,
): InterceptorResponse | LegacyInterceptorResponse;
export function parseInterceptorResponse(
  value: unknown,
  spec: string,
  point?: InterceptionPoint,
): InterceptorResponse | LegacyInterceptorResponse {
  requireSpecVersion(spec);
  if (spec === SPEC_VERSION_DRAFT) {
    if (!point) throw new TypeError("Draft response parsing requires an interception point");
    // Let the native parser reject duplicate members and oversized metadata
    // before JSON.parse loses those distinctions.
    const raw = typeof value === "string" ? value : marshal(value);
    const response = draftResponse(JSON.parse(native.parseResponseJson(raw)), point);
    const normalized = JSON.parse(native.normalizeInterceptorResponse(spec, marshal(response)));
    return restoreDraftResponse(normalized, point);
  }
  const wire = typeof value === "string" ? value : marshal(value);
  return JSON.parse(
    native.normalizeInterceptorResponse(requireSpecVersion(spec), wire),
  ) as LegacyInterceptorResponse;
}

/** Draft responses stay enveloped; legacy 0.1 responses without metadata serialize as bare verdicts. */
export function serializeInterceptorResponse(
  response: InterceptorResponse | LegacyInterceptorResponse,
  spec: string = SPEC_VERSION_0_1,
  point?: InterceptionPoint,
): JsonValue {
  requireSpecVersion(spec);
  if (spec === SPEC_VERSION_DRAFT) {
    if (!point) throw new TypeError("Draft response serialization requires an interception point");
    parseInterceptorResponse(response, SPEC_VERSION_DRAFT, point);
    return JSON.parse(marshal(response));
  }
  if (response.extensions == null || Object.keys(response.extensions).length === 0) {
    return response.verdict as unknown as JsonValue;
  }
  return {
    verdict: response.verdict as unknown as JsonValue,
    extensions: response.extensions,
  };
}

/** §5.2: apply a `$target`-rooted transform. Returns a new object. Rust core. */
export function applyTransform(target: JsonValue, path: string, value: JsonValue): JsonValue {
  return JSON.parse(native.applyTransform(marshal(target), path, marshal(value)));
}

/** Apply a draft hook replacement, or a legacy 0.1 path/value transform, returning the updated context. */
export function applyTransformCtx(
  ctx: AgentContext,
  transform: Transform,
): AgentContext;
export function applyTransformCtx(ctx: LegacyAgentContext, path: string, value: JsonValue): LegacyAgentContext;
export function applyTransformCtx(
  ctx: RuntimeAgentContext,
  transform: Transform | string,
  value?: JsonValue,
): RuntimeAgentContext {
  if (ctx.spec === SPEC_VERSION_DRAFT) {
    if (typeof transform === "string") throw new TypeError("Draft transforms use hook-specific payloads, not paths");
    validateDraftContext(ctx);
    const response = draftResponse({ verdict: { decision: "transform", transform } }, ctx.interception_point);
    const t = response.verdict.transform!;
    const result = withoutTarget(JSON.parse(native.applyTransformCtx(
      marshal(draftContextWithTarget(ctx)), t.path, marshal(t.value),
    )));
    validateDraftContext(result);
    return result;
  }
  if (typeof transform !== "string") throw new TypeError("0.1 transforms require a path and value");
  return JSON.parse(native.applyTransformCtx(marshal(ctx), transform, marshal(value)));
}

/** Validate a transform against the context without mutating it (§8). */
export function validateTransformCtx(ctx: AgentContext, transform: Transform): void;
export function validateTransformCtx(ctx: LegacyAgentContext, path: string, value: JsonValue): void;
export function validateTransformCtx(ctx: RuntimeAgentContext, transform: Transform | string, value?: JsonValue): void {
  if (ctx.spec === SPEC_VERSION_DRAFT) {
    if (typeof transform === "string") throw new TypeError("Draft transforms use hook-specific payloads, not paths");
    applyTransformCtx(ctx, transform);
  } else {
    if (typeof transform !== "string") throw new TypeError("0.1 transforms require a path and value");
    native.validateTransformCtx(marshal(ctx), transform, marshal(value));
  }
}

/** Everything {@link finalize} needs beyond the context and combined
 * verdict (§10.3). */
export interface FinalizeMeta {
  /** Provider output computed **before** dispatch; `null` when the
   * identity provider is `null` or rejected the context. */
  input_identity?: string | null;
  /** The declared provider name (§10.1). When `"jcs-sha256"`, the core
   * computes `enforced_identity` from the post-fold context itself; a
   * custom provider's host passes `enforced_identity` explicitly. */
  identity_provider?: string | null;
  /** Pre-computed post-composition identity for custom providers.
   * Ignored when `identity_provider == "jcs-sha256"`. */
  enforced_identity?: string | null;
  decided_by?: number | null;
  /** REQUIRED: the profile and knobs in effect (§7.1). */
  composition: CompositionConfig;
  /** The declaration contract version the emitter was built from
   * (§7.7.8); absent or `null` for an emitter configured in code. The
   * core never defaults it. */
  declaration?: string | null;
  /** Per-interceptor summaries (multi-verdict profiles, §10.3). */
  verdicts?: LegacyVerdictSummary[] | null;
  /** Sequential profiles (§7.4). */
  fold_truncated?: boolean | null;
  /** Consultation outcome: `"approval"` / `"rejection"` / none (§7.6). */
  resolved_by?: "approval" | "rejection" | null;
  /** Interceptors registered at emission time (§10.3). */
  interceptors_registered?: number;
}

/** §10.3: build the `InterceptionRecord` for one completed emission.
 * `meta.input_identity` MUST have been computed before interceptor
 * dispatch; transforms were already applied during the §7.4 fold. Rust
 * core. */
export function finalize(ctx: AgentContext, verdict: Verdict, mode: EnforcementMode, meta: FinalizeMeta): InterceptionRecord;
export function finalize(ctx: LegacyAgentContext, verdict: LegacyVerdict, mode: EnforcementMode, meta: FinalizeMeta): LegacyInterceptionRecord;
export function finalize(ctx: RuntimeAgentContext, verdict: Verdict | LegacyVerdict, mode: EnforcementMode, meta: FinalizeMeta): RuntimeInterceptionRecord;
export function finalize(
  ctx: RuntimeAgentContext,
  verdict: Verdict | LegacyVerdict,
  mode: EnforcementMode,
  meta: FinalizeMeta,
): RuntimeInterceptionRecord {
  const record = JSON.parse(
    native.finalize(
      marshal(ctx),
      marshal("transform" in verdict && verdict.transform && !("path" in verdict.transform)
        ? { ...verdict, transform: draftTransform(verdict.transform) } : verdict),
      mode,
      JSON.stringify({
        input_identity: meta.input_identity ?? null,
        identity_provider: meta.identity_provider ?? null,
        enforced_identity: meta.enforced_identity ?? null,
        decided_by: meta.decided_by ?? null,
        composition: meta.composition,
        declaration: meta.declaration ?? null,
        verdicts: meta.verdicts ?? null,
        fold_truncated: meta.fold_truncated ?? null,
        resolved_by: meta.resolved_by ?? null,
        interceptors_registered: meta.interceptors_registered ?? 0,
      }),
    ),
  );
  if (ctx.spec === SPEC_VERSION_DRAFT) delete record.verdict.transform;
  return record;
}

/** §7.3/§7.5 aggregation for the multi-verdict profiles: severity-max
 * winner (or synthesized conflict/disagreement verdict) with the §7.3
 * metadata unions. Rust core. */
type AggregateResult<V> = {
  combined: V;
  decided_by: number | null;
  consult: boolean;
  apply_transform: boolean;
  verdicts: LegacyVerdictSummary[];
};

export function composeAggregate(
  composition: CompositionConfig,
  verdicts: Verdict[],
  spec: typeof SPEC_VERSION_DRAFT,
  point: InterceptionPoint,
): AggregateResult<Verdict>;
export function composeAggregate(
  composition: CompositionConfig,
  verdicts: LegacyVerdict[],
  spec: typeof SPEC_VERSION_0_1,
): AggregateResult<LegacyVerdict>;
export function composeAggregate(
  composition: CompositionConfig,
  verdicts: (Verdict | LegacyVerdict)[],
  spec: string,
  point?: InterceptionPoint,
): AggregateResult<Verdict | LegacyVerdict>;
export function composeAggregate(
  composition: CompositionConfig,
  verdicts: (Verdict | LegacyVerdict)[],
  spec: string,
  point?: InterceptionPoint,
): AggregateResult<Verdict | LegacyVerdict> {
  requireSpecVersion(spec);
  if (spec === SPEC_VERSION_DRAFT && !point) {
    throw new TypeError("Draft composition requires an interception point");
  }
  const adapted = verdicts.map((verdict) => {
    if (spec !== SPEC_VERSION_DRAFT || !point || !("transform" in verdict)) return verdict;
    const response = draftResponse({
      verdict: { decision: verdict.decision, transform: verdict.transform },
    }, point);
    return { ...verdict, ...response.verdict };
  });
  const result: AggregateResult<LegacyVerdict> = JSON.parse(
    native.composeAggregate(spec, JSON.stringify(composition), marshal(adapted)),
  );
  return spec === SPEC_VERSION_DRAFT && point
    ? { ...result, combined: restoreDraftResponse({ verdict: result.combined }, point).verdict }
    : result;
}

export { AgentContextBuilder } from "./builder";
export { InterceptionEmitter, EmitterSealed } from "./emitter";
export type { HostFailure } from "./emitter";
export {
  CAPABILITIES,
  DECLARATION_VERSION,
  DeclarationBuilder,
  DeclarationError,
  DeclarationErrorClass,
  HostDeclaration,
  HostRegistry,
  HostRegistryError,
  HostSurface,
  MAX_BINDINGS,
  MAX_DEPTH,
  MAX_DETAIL_LEN,
  MAX_DOCUMENT_BYTES,
  MAX_ID_LEN,
  MAX_KIND_LEN,
  MAX_TIMEOUT_MS,
  SUPPORTED_DECLARATION_VERSIONS,
  canonicalDeclaration,
  acceptedDeclarationVersions,
  currentDeclarationVersion,
  declarationVersions,
  fullKnobSupport,
  validKind,
  validReference,
} from "./declaration";
export type {
  BindingContext,
  BindingOptions,
  Finding,
  HostInfo,
  KindResolver,
  KnobSupport,
  ManagedKindResolver,
  RegistryNames,
  ResolvedBinding,
  ResolvedConfiguration,
  ResolvedDeclaration,
  ResolvedFailure,
  ResolvedSurface,
  TimeoutSupport,
  ToolSeamPosture,
} from "./declaration";

/** Returned by `InterceptionEmitter.emit` on a proceeding emission:
 * the record plus the **effective** (post-composition) target the
 * guarded action MUST consume (§4.3). */
export interface EmitOutcome<R extends RuntimeInterceptionRecord = RuntimeInterceptionRecord> {
  record: R;
  target: unknown;
}

/** Raised by a host when a verdict blocks the guarded action (§6). */
export class InterceptionBlocked extends Error {
  constructor(public readonly result: RuntimeInterceptionRecord) {
    super(
      `${result.interception_point} blocked: ${result.verdict.decision} (${result.verdict.reason ?? "no reason"})`,
    );
    this.name = "InterceptionBlocked";
  }
}
