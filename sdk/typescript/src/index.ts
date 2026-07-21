// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
/**
 * agent-hooks: framework-neutral agent lifecycle hook contract.
 * Implements AGENT-HOOKS-0.1. Lifted and adapted from
 * `policy-engine/sdk/node/src/index.ts`.
 */

import { native, AgentHooksCoreError } from "./native";
export { AgentHooksCoreError };

/** Spec version this SDK implements (§4.1 `spec` field). */
export const SPEC_VERSION = "agent-hooks/0.1";

/** Name of the default identity provider (§10.1, §10.2). */
export const JCS_SHA256 = "jcs-sha256";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The closed set of agent lifecycle interception points (§3). */
export const InterceptionPoint = Object.freeze({
  AgentStartup: "agent_startup",
  Input: "input",
  PreModelCall: "pre_model_call",
  PostModelCall: "post_model_call",
  PreToolCall: "pre_tool_call",
  PostToolCall: "post_tool_call",
  Output: "output",
  AgentShutdown: "agent_shutdown",
} as const);
export type InterceptionPoint = (typeof InterceptionPoint)[keyof typeof InterceptionPoint];

/** Whether a `transform` verdict is permitted at `hp` (§3, §4.3). */
export function transformPermitted(hp: InterceptionPoint): boolean {
  return hp !== InterceptionPoint.AgentStartup && hp !== InterceptionPoint.AgentShutdown;
}

/** Verdict decision values (§5.1). Three, closed: `warn` is `allow` +
 * `warnings[]`; `escalate` is `deny` + an `approval` block. */
export const Decision = Object.freeze({
  Allow: "allow",
  Deny: "deny",
  Transform: "transform",
} as const);
export type Decision = (typeof Decision)[keyof typeof Decision];

/** Whether the action proceeds under `d` (§2 permit class). */
export function permits(d: Decision): boolean {
  return d === Decision.Allow || d === Decision.Transform;
}

/** Whether the host acts on verdicts (§8). */
export const EnforcementMode = Object.freeze({
  Enforce: "enforce",
  EvaluateOnly: "evaluate_only",
} as const);
export type EnforcementMode = (typeof EnforcementMode)[keyof typeof EnforcementMode];

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

/** A single `$target`-rooted replacement (§5.2). */
export interface Transform {
  /** Path rooted at `$target` (or the deprecated `$policy_target` alias). */
  path: string;
  value: JsonValue;
}

/** Opaque pointer to an offline-verifiable artefact (§5.3). */
export interface Evidence {
  artefact?: string | null;
  verification_pointers?: Record<string, string>;
}

/** A recorded concern that does not affect control flow (§5.1). */
export interface Warning {
  reason?: string | null;
  message?: string | null;
}

/** Interceptor return value (§5). */
export interface Verdict {
  decision: Decision;
  reason?: string | null;
  message?: string | null;
  /** Recorded concerns; permitted on any decision (§5.1). */
  warnings?: Warning[];
  /** Present only on `deny`: marks the deny as liftable by the approval
   * seam (§9). MAY be empty; reserved for approver-facing parameters. */
  approval?: Record<string, JsonValue>;
  transform?: Transform;
  evidence?: Evidence;
  result_labels?: string[];
}

/** Constructor sugar for the three-verdict vocabulary (§5.1). Merges
 * with the `Verdict` interface: `Verdict.warn(...)`, `Verdict.escalate(...)`. */
export const Verdict = Object.freeze({
  /** The trivial permit verdict. */
  allow(): Verdict {
    return { decision: Decision.Allow };
  },
  /** What earlier drafts called `warn`: an `allow` carrying one
   * warning (§5.1). */
  warn(reason?: string, message?: string): Verdict {
    return { decision: Decision.Allow, warnings: [{ reason, message }] };
  },
  /** A plain, final deny: no `approval` block, so the approval seam
   * cannot lift it (§5.1). */
  deny(reason?: string, message?: string): Verdict {
    return { decision: Decision.Deny, reason, message };
  },
  /** What earlier drafts called `escalate`: a liftable deny — denied
   * as-is unless the approval seam lifts it (§5.1, §9). */
  escalate(reason?: string, message?: string): Verdict {
    return { decision: Decision.Deny, reason, message, approval: {} };
  },
});

/** The trivial permit verdict. */
export const ALLOW: Readonly<Verdict> = Object.freeze({ decision: Decision.Allow });

/** Host-synthesized deny verdict for a §11 failure. */
export function hostErrorVerdict(err: HostError, message?: string): Verdict {
  return { decision: Decision.Deny, reason: err, message };
}

/** Host-synthesized **liftable** deny (§7.5 `"approval"` knob value):
 * the failure is consultable rather than final. */
export function hostErrorLiftable(err: HostError, message?: string): Verdict {
  return { ...hostErrorVerdict(err, message), approval: {} };
}

/** A deny carrying an `approval` block (§5.1). */
export function isLiftable(v: Verdict): boolean {
  return v.decision === Decision.Deny && v.approval != null;
}

// ---- Composition (§7) -------------------------------------------------------

/** The closed profile set (§7.2). */
export const CompositionProfile = Object.freeze({
  SequentialFirstDeny: "sequential/first_deny",
  SequentialRunAll: "sequential/run_all",
  ParallelStrictest: "parallel/strictest",
  ParallelUnanimous: "parallel/unanimous",
} as const);
export type CompositionProfile = (typeof CompositionProfile)[keyof typeof CompositionProfile];

/** `sequential/first_deny` knob (§7.4): what a permit resolution does
 * to the rest of the fold. */
export type OnApproval = "stop" | "resume";

/** `"deny" | "approval"` knob value (§7.5): synthesize a plain deny, or
 * a liftable one and consult the seam. */
export type SynthesisPolicy = "deny" | "approval";

/** The composition profile and knobs in effect for one emission
 * (§7.1, §10.3). Serialized verbatim into the record's `composition`
 * block. */
export interface CompositionConfig {
  profile: CompositionProfile;
  /** `sequential/first_deny` only. */
  on_approval?: OnApproval;
  /** `parallel/unanimous` only. */
  on_disagreement?: SynthesisPolicy;
  /** Parallel profiles only. */
  on_transform_conflict?: SynthesisPolicy;
}

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
  | { name: string; fn: (ctx: AgentContext) => string }
  | null;

/** Wire-shaped agent context (§4). Required core typed; conditional and
 * optional fields indexed. */
export interface AgentContext {
  spec: string;
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
export interface VerdictSummary {
  index: number;
  decision: Decision;
  reason?: string | null;
  /** Host-chosen payload-free registration identifier (§10.3). */
  name?: string;
}

/** Host-side record of one emission (§10.3).
 *
 * Payload-free by design: the identities (when a provider is declared)
 * bind the record to the exact pre/post-composition context without
 * duplicating the (possibly sensitive) payload into audit storage.
 * `composition` makes the record interpretable without out-of-band
 * knowledge of host configuration. */
export interface InterceptionRecord {
  interception_point: InterceptionPoint;
  mode: EnforcementMode;
  /** The combined verdict (§7.3), possibly host-synthesized or
   * approval-substituted. */
  verdict: Verdict;
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
  /** Per-interceptor summary; populated in multi-verdict profiles
   * (`sequential/run_all`, `parallel/*`). */
  verdicts?: VerdictSummary[];
  /** `true` iff one or more registered interceptors were never invoked
   * in this emission (short-circuit, approval-stop, or a failed
   * fold-transform). Defined for the sequential profiles (§7.4). */
  fold_truncated?: boolean;
  /** Consultation outcome (§7.6, §10.3): `"approval"` iff a permit
   * resolution substituted; `"rejection"` iff consulted without a
   * lift; absent iff never consulted. */
  resolved_by?: "approval" | "rejection" | null;
  /** Interceptors registered at emission time (§10.3). */
  interceptors_registered: number;
}

/** Whether the guarded action executes (§6, §8). */
export function proceeds(r: InterceptionRecord): boolean {
  return r.mode === EnforcementMode.EvaluateOnly || permits(r.verdict.decision);
}

/** Interceptor protocol (§7). */
export interface Interceptor {
  intercept(context: AgentContext): Verdict | Promise<Verdict>;
}

/** Approval seam (§9). */
export const ApprovalOutcome = Object.freeze({
  Approve: "approve",
  Reject: "reject",
  Unresolved: "unresolved",
} as const);
export type ApprovalOutcome = (typeof ApprovalOutcome)[keyof typeof ApprovalOutcome];

/** `context_identity` is `null` when the identity provider is `null`
 * (§10.1) — the approval is then identity-unbound. */
export interface ApprovalRequest {
  context_identity: string | null;
  interception_point: InterceptionPoint;
  verdict: Verdict;
  context: AgentContext;
}

/** The resolution's `context_identity` MUST echo the request's byte for
 * byte (`null` echoes as `null`, §9 echo rule). */
export interface ApprovalResolution {
  outcome: ApprovalOutcome;
  context_identity: string | null;
  verdict?: Verdict;
}

export interface ApprovalResolver {
  resolve(request: ApprovalRequest): ApprovalResolution | Promise<ApprovalResolution>;
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
export function contextIdentity(ctx: AgentContext): string {
  return native.contextIdentity(marshal(ctx));
}

/** §5: validate an interceptor's wire return value. Rust core. */
export function validateVerdict(v: Verdict): void {
  native.validateVerdict(marshal(v));
}

/** §5.2: apply a `$target`-rooted transform. Returns a new object. Rust core. */
export function applyTransform(target: JsonValue, path: string, value: JsonValue): JsonValue {
  return JSON.parse(native.applyTransform(marshal(target), path, marshal(value)));
}

/** §7.4 fold-through: apply one transform to the context's `target` (and
 * its conditional alias) so the next interceptor sees the effect. Returns
 * the updated context. Rust core. */
export function applyTransformCtx(
  ctx: AgentContext,
  path: string,
  value: JsonValue,
): AgentContext {
  return JSON.parse(native.applyTransformCtx(marshal(ctx), path, marshal(value)));
}

/** §8 `evaluate_only`: validate a transform against the context's current
 * target without applying it. Rust core. */
export function validateTransformCtx(ctx: AgentContext, path: string, value: JsonValue): void {
  native.validateTransformCtx(marshal(ctx), path, marshal(value));
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
  /** Per-interceptor summaries (multi-verdict profiles, §10.3). */
  verdicts?: VerdictSummary[] | null;
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
export function finalize(
  ctx: AgentContext,
  verdict: Verdict,
  mode: EnforcementMode,
  meta: FinalizeMeta,
): InterceptionRecord {
  return JSON.parse(
    native.finalize(
      marshal(ctx),
      marshal(verdict),
      mode,
      JSON.stringify({
        input_identity: meta.input_identity ?? null,
        identity_provider: meta.identity_provider ?? null,
        enforced_identity: meta.enforced_identity ?? null,
        decided_by: meta.decided_by ?? null,
        composition: meta.composition,
        verdicts: meta.verdicts ?? null,
        fold_truncated: meta.fold_truncated ?? null,
        resolved_by: meta.resolved_by ?? null,
        interceptors_registered: meta.interceptors_registered ?? 0,
      }),
    ),
  );
}

/** §7.3/§7.5 aggregation for the multi-verdict profiles: severity-max
 * winner (or synthesized conflict/disagreement verdict) with the §7.3
 * metadata unions. Rust core. */
export function composeAggregate(
  composition: CompositionConfig,
  verdicts: Verdict[],
): {
  combined: Verdict;
  decided_by: number | null;
  consult: boolean;
  apply_transform: boolean;
  verdicts: VerdictSummary[];
} {
  return JSON.parse(native.composeAggregate(JSON.stringify(composition), marshal(verdicts)));
}

export { AgentContextBuilder } from "./builder";
export { InterceptionEmitter } from "./emitter";

/** Raised by a host when a verdict blocks the guarded action (§6). */
/** Returned by `InterceptionEmitter.emit` on a proceeding emission:
 * the record plus the **effective** (post-composition) target the
 * guarded action MUST consume (§4.3). */
export interface EmitOutcome {
  record: InterceptionRecord;
  target: unknown;
}

export class InterceptionBlocked extends Error {
  constructor(public readonly result: InterceptionRecord) {
    super(
      `${result.interception_point} blocked: ${result.verdict.decision} (${result.verdict.reason ?? "no reason"})`,
    );
    this.name = "InterceptionBlocked";
  }
}
