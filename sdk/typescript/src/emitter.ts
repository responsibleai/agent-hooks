// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
/**
 * Host-side emitter: dispatch context → interceptors → composition →
 * combined verdict → record (§6–§10).
 *
 * Per-language orchestrator over the Rust core:
 *
 * - Interceptor dispatch (§7) and approval-seam resolution (§9) stay here
 *   because they call back into user JS code.
 * - Verdict validation (§5), transform application (§5.2, §7.4),
 *   severity-max aggregation (§7.3, via `composeAggregate`), identity
 *   computation (§10), and record building (§10.3) delegate to the Rust
 *   core so behaviour is byte-identical across SDKs.
 *
 * Composition is host configuration (§7.1): the profile is set on the
 * emitter (default `sequential/first_deny, on_approval: stop`) and
 * recorded on every emission. "Parallel" profiles are implemented with
 * serial dispatch over isolated snapshots — §7.2: parallel names
 * isolation semantics, not scheduling.
 *
 * Fail-closed defaults: an `enforce`-mode emission with zero registered
 * interceptors yields `deny host_error:no_interceptor` (§7), and
 * {@link InterceptionEmitter.emit} **throws** {@link InterceptionBlocked}
 * on any block — the ignorable-result variant is the explicitly named
 * {@link InterceptionEmitter.emitUnchecked}.
 *
 * Concurrency (§12.2): emissions for different tool calls may interleave
 * on the event loop; sequence assignment and record append are atomic on
 * a single JS thread. Sharing one emitter across workers is unsupported.
 */

import {
  AgentContext,
  ApprovalOutcome,
  ApprovalResolver,
  Composition,
  CompositionConfig,
  CompositionProfile,
  Decision,
  EnforcementMode,
  FinalizeMeta,
  HostError,
  IdentityProvider,
  EmitOutcome,
  InterceptionBlocked,
  InterceptionPoint,
  InterceptionRecord,
  Interceptor,
  JCS_SHA256,
  Verdict,
  VerdictSummary,
  Warning,
  findNonFinite,
  finalize,
  hostErrorVerdict,
  isLiftable,
  nonFiniteDetail,
  permits,
  proceeds,
} from "./index";
import { AgentHooksCoreError, native } from "./native";

/** §7 RECOMMENDED interceptor/resolver timeout (milliseconds). */
export const DEFAULT_TIMEOUT_MS = 5000;

/** Internal sentinel for a §7 timeout breach. */
class InterceptTimeout extends Error {
  constructor() {
    super("interceptor/resolver timeout");
    this.name = "InterceptTimeout";
  }
}

/** Whether a verdict was synthesized by the host (§11) rather than
 * returned by an interceptor or resolver. */
function isHostSynthesized(v: Verdict): boolean {
  return v.reason?.startsWith("host_error:") ?? false;
}

// ---- §7.3 metadata unions (mirrors sdk/rust/core/src/composition.rs) --------

/** First-seen-ordered union of `warnings` from every verdict (§7.3). */
function unionWarnings(pool: Verdict[]): Warning[] {
  const out: Warning[] = [];
  const seen = new Set<string>();
  for (const v of pool) {
    for (const w of v.warnings ?? []) {
      const key = JSON.stringify([w.reason ?? null, w.message ?? null]);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(w);
      }
    }
  }
  return out;
}

/** First-seen-ordered union of `result_labels` from every **permit**
 * verdict (§7.3; §5.4 drops labels when the emission does not proceed). */
function unionLabels(pool: Verdict[]): string[] {
  const out: string[] = [];
  for (const v of pool) {
    if (!permits(v.decision)) continue;
    for (const l of v.result_labels ?? []) {
      if (!out.includes(l)) out.push(l);
    }
  }
  return out;
}

/** Apply the §7.3 metadata unions to a combined verdict. */
function withUnions(combined: Verdict, pool: Verdict[]): Verdict {
  const out: Verdict = { ...combined };
  const warnings = unionWarnings(pool);
  if (warnings.length > 0) out.warnings = warnings;
  if (permits(out.decision)) {
    const labels = unionLabels(pool);
    if (labels.length > 0) out.result_labels = labels;
  }
  return out;
}

/** Payload-free per-interceptor summaries for the record (§10.3). */
function summaries(verdicts: Verdict[]): VerdictSummary[] {
  return verdicts.map((v, index) => ({
    index,
    decision: v.decision,
    ...(v.reason != null ? { reason: v.reason } : {}),
  }));
}

/** Internal result of one profile dispatch. */
interface DispatchOutcome {
  combined: Verdict;
  decidedBy: number | null;
  verdicts: VerdictSummary[];
  foldTruncated: boolean | null;
  resolvedBy: "approval" | "rejection" | null;
}

function synthesized(err: HostError, detail?: string): DispatchOutcome {
  return {
    combined: hostErrorVerdict(err, detail),
    decidedBy: null,
    verdicts: [],
    foldTruncated: null,
    resolvedBy: null,
  };
}

/** What a seam consultation produced (§7.6, §9). Not consulted: no
 * resolver, `evaluate_only`, or `agent_shutdown` — the liftable deny
 * stands as-is. Otherwise a resolution (or a host-synthesized failure
 * verdict) substitutes for the triggering verdict; `permitted` is true
 * for an `approve` outcome carrying a permit verdict. */
type Consultation =
  | { consulted: false }
  | { consulted: true; verdict: Verdict; permitted: boolean };

const NOT_CONSULTED: Consultation = { consulted: false };

export class InterceptionEmitter {
  private readonly interceptors: Interceptor[] = [];
  private _records: InterceptionRecord[] = [];
  private composition: CompositionConfig = Composition.default();
  private identity: IdentityProvider = JCS_SHA256;
  private readonly names: Array<string | null> = [];
  private approvalRedactor: ((ctx: AgentContext) => AgentContext) | null = null;
  private recordSink: ((record: InterceptionRecord) => void) | null = null;
  private maxRecords: number | null = null;
  private _recordsDropped = 0;

  /**
   * `timeoutMs` bounds each interceptor `intercept()` and resolver
   * `resolve()` call (§7, RECOMMENDED default 5000 ms); breach fails
   * closed with `host_error:interceptor_timeout` (interceptor) or
   * `host_error:approval_resolver_failed` (resolver). Only async work
   * can be preempted — a synchronous interceptor that blocks the event
   * loop cannot be interrupted. `timeoutMs: null` disables enforcement.
   */
  constructor(
    private readonly mode: EnforcementMode = EnforcementMode.Enforce,
    private readonly resolver: ApprovalResolver | null = null,
    private readonly timeoutMs: number | null = DEFAULT_TIMEOUT_MS,
  ) {}

  /** Race `fn`'s result against the §7 timeout. */
  private async withTimeout<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.timeoutMs === null) return fn();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => fn())(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new InterceptTimeout()), this.timeoutMs!);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  get records(): readonly InterceptionRecord[] {
    return this._records;
  }

  /** Register an interceptor, optionally with a host-chosen
   * payload-free `name` recorded on `verdicts[].name` (§10.3). */
  register(interceptor: Interceptor, name?: string): this {
    this.interceptors.push(interceptor);
    this.names.push(name ?? null);
    return this;
  }

  /** Declare the composition profile for subsequent emissions (§7.1). */
  setComposition(composition: CompositionConfig): this {
    this.composition = composition;
    return this;
  }

  /** Declare the identity provider (§10.1). Default `"jcs-sha256"`.
   * §10.1 name rules are enforced: a custom provider name must match
   * `^[a-z][a-z0-9_-]*$` and must not begin with `jcs` (reserved so a
   * custom function can never claim golden-vector semantics). */
  setIdentityProvider(provider: IdentityProvider): this {
    if (provider !== null && provider !== JCS_SHA256) {
      if (!/^[a-z][a-z0-9_-]*$/.test(provider.name) || provider.name.startsWith("jcs")) {
        throw new RangeError(
          "identity provider name must match ^[a-z][a-z0-9_-]*$ and must not begin with 'jcs' (§10.1)",
        );
      }
    }
    this.identity = provider;
    return this;
  }

  /** Register the §9/§14 approval redactor: a pure function producing
   * the context to place in every ApprovalRequest. The §9 identity is
   * computed over the redacted context (binding the approval to what
   * the approver saw); the record's identities are unaffected. A
   * redactor that throws fails the consultation closed as
   * `host_error:approval_resolver_failed`. */
  setApprovalRedactor(redactor: (ctx: AgentContext) => AgentContext): this {
    this.approvalRedactor = redactor;
    return this;
  }

  /** Register a per-emission record callback (§10.3), invoked
   * synchronously after every emission before buffering; a sink
   * exception is swallowed (audit delivery is the host's liveness
   * concern, not the control plane's). */
  setRecordSink(sink: (record: InterceptionRecord) => void): this {
    this.recordSink = sink;
    return this;
  }

  /** Bound the in-memory record buffer: when full, the OLDEST record
   * is dropped and {@link recordsDropped} increments. Unbounded by
   * default. */
  setMaxRecords(max: number): this {
    this.maxRecords = max;
    return this;
  }

  /** Records evicted by the {@link setMaxRecords} bound. */
  get recordsDropped(): number {
    return this._recordsDropped;
  }

  /** Drain the in-memory record buffer (retention stays bounded on
   * long-running sessions). */
  takeRecords(): InterceptionRecord[] {
    const out = this._records;
    this._records = [];
    return out;
  }

  /** Run the emission and **throw** {@link InterceptionBlocked} if the
   * guarded action must not proceed (§6). Primary entry point.
   *
   * Returns the record plus the **effective** (post-composition)
   * target the guarded action MUST consume (§4.3) — a reference
   * captured before `emit` may predate a transform. */
  async emit(ctx: AgentContext): Promise<EmitOutcome> {
    const record = await this.emitUnchecked(ctx);
    if (!proceeds(record)) throw new InterceptionBlocked(record);
    return { record, target: (ctx as Record<string, unknown>)["target"] };
  }

  /** Run the emission and return the record without throwing. The
   * caller MUST inspect `proceeds` and halt the guarded action itself;
   * prefer {@link emit}. */
  async emitUnchecked(ctx: AgentContext): Promise<InterceptionRecord> {
    // §4.4/P-004 marshalling guard: JSON.stringify silently corrupts
    // NaN/±Infinity to null, so scan BEFORE any serialization and fail
    // closed. No interceptor runs on a context the guard rejected.
    let inputIdentity: string | null = null;
    let outcome: DispatchOutcome | null = null;
    const hit = findNonFinite(ctx);
    if (hit !== null) {
      outcome = synthesized(HostError.ContextInvalid, nonFiniteDetail(hit));
    } else {
      // §4/§6.3: an invalid envelope is denied before any interceptor
      // or identity provider sees it; §10.3: input identity binds to
      // the context BEFORE dispatch.
      try {
        native.validateEnvelope(JSON.stringify(ctx));
        inputIdentity = this.identityOf(ctx);
      } catch (e) {
        // §10.1/§10.2: envelope invalid, value domain rejected, or the
        // provider itself failed. Fail closed before any interceptor
        // runs.
        outcome = synthesized(...codeAndDetail(e));
      }
    }
    const identityFailed = outcome !== null;
    if (outcome === null) outcome = await this.dispatch(ctx);

    const providerName =
      this.identity === null ? null : this.identity === JCS_SHA256 ? JCS_SHA256 : this.identity.name;
    const meta: FinalizeMeta = {
      input_identity: inputIdentity,
      identity_provider: providerName,
      enforced_identity:
        // Custom providers only; the core computes jcs-sha256 itself.
        // A provider that fails here yields honest absence (§10.1) —
        // the pre-dispatch failure path already denies.
        !identityFailed && this.identity !== null && this.identity !== JCS_SHA256
          ? this.tryCustomIdentity(ctx)
          : null,
      decided_by: outcome.decidedBy,
      composition: this.composition,
      verdicts: outcome.verdicts.map((v) => ({
        ...v,
        ...(this.names[v.index] != null ? { name: this.names[v.index] as string } : {}),
      })),
      fold_truncated: outcome.foldTruncated,
      resolved_by: outcome.resolvedBy,
      interceptors_registered: this.interceptors.length,
    };

    let record: InterceptionRecord;
    if (identityFailed) {
      // The provider rejected the context (or the marshalling guard
      // did), so the core must not recompute an enforced identity from
      // a serialization the guard would have refused: pass a null
      // provider and restore the declared name on the record.
      record = JSON.parse(
        native.finalize(
          JSON.stringify(ctx),
          JSON.stringify(outcome.combined),
          this.mode,
          JSON.stringify({ ...meta, identity_provider: null }),
        ),
      );
      record.identity_provider = providerName;
    } else {
      record = finalize(ctx, outcome.combined, this.mode, meta);
    }
    if (this.recordSink) {
      // Audit delivery must not take down the control plane (§10.3).
      try {
        this.recordSink(record);
      } catch {
        /* swallowed by design */
      }
    }
    if (this.maxRecords !== null) {
      while (this._records.length >= Math.max(this.maxRecords, 1)) {
        this._records.shift();
        this._recordsDropped += 1;
      }
    }
    this._records.push(record);
    return record;
  }

  // ---------------------------------------------------------------------------

  /** Profile dispatch (§7.4–§7.5). Returns the combined verdict and
   * its record metadata. */
  private async dispatch(ctx: AgentContext): Promise<DispatchOutcome> {
    if (this.interceptors.length === 0) {
      // §7: zero interceptors fails closed, profile-independent.
      // Register an explicit allow-all interceptor for a deliberate
      // passthrough.
      return synthesized(HostError.NoInterceptor);
    }
    switch (this.composition.profile) {
      case CompositionProfile.SequentialFirstDeny:
        return this.dispatchFirstDeny(ctx);
      case CompositionProfile.SequentialRunAll:
        return this.dispatchRunAll(ctx);
      default:
        return this.dispatchParallel(ctx);
    }
  }

  /** Invoke one interceptor on its own copy of `ctx` (§7) and pass the
   * result through the §5 gate. Never throws: every failure becomes the
   * §6.3 synthesized deny. */
  private async invoke(interceptor: Interceptor, ctx: AgentContext): Promise<Verdict> {
    let v: Verdict;
    try {
      // §7: each interceptor gets its own copy — in-place mutation of
      // the copy cannot alter enforcement.
      v = await this.withTimeout(() => interceptor.intercept(structuredClone(ctx)));
    } catch (e) {
      if (e instanceof InterceptTimeout) {
        return hostErrorVerdict(HostError.InterceptorTimeout);
      }
      return hostErrorVerdict(
        HostError.InterceptorFailed,
        (e as Error)?.constructor?.name ?? "Error",
      );
    }
    return this.gate(v);
  }

  /** §5 gate: normalize a wire verdict or synthesize the §6.3 deny. The
   * non-finite pre-scan runs first — JSON.stringify would silently
   * corrupt NaN/±Infinity to null before the core could reject them. */
  private gate(v: Verdict): Verdict {
    const hit = findNonFinite(v);
    if (hit !== null) return hostErrorVerdict(HostError.VerdictInvalid, nonFiniteDetail(hit));
    try {
      return JSON.parse(native.validateVerdict(JSON.stringify(v)));
    } catch (e) {
      const [code, detail] = codeAndDetail(e, HostError.VerdictInvalid);
      return hostErrorVerdict(code, detail);
    }
  }

  /** `sequential/first_deny` (§7.4): fold-through, first deny
   * short-circuits; a liftable deny consults the seam, then `stop` or
   * `resume` per the knob.
   *
   * `perInterceptor` stays index-aligned with registration order (one
   * entry per invoked interceptor, §10.3 summaries); `pool`
   * additionally holds substituted resolutions for the §7.3 unions. */
  private async dispatchFirstDeny(ctx: AgentContext): Promise<DispatchOutcome> {
    const n = this.interceptors.length;
    const onApproval = this.composition.on_approval ?? "stop";
    const perInterceptor: Verdict[] = [];
    const pool: Verdict[] = [];
    let lastTransform: [number, Verdict] | null = null;
    let resolvedBy: "approval" | "rejection" | null = null;
    const truncated = (i: number) => i + 1 < n;

    for (let i = 0; i < n; i++) {
      let v = await this.invoke(this.interceptors[i], ctx);
      perInterceptor.push(v);
      pool.push(v);
      if (isHostSynthesized(v)) {
        // §6.3: malformed verdict fails closed and — in this profile —
        // short-circuits like any deny. The failure deny is attributed
        // to the failing interceptor (§10.3 decided_by), matching the
        // aggregation profiles.
        return {
          combined: withUnions(v, pool),
          decidedBy: i,
          verdicts: summaries(perInterceptor),
          foldTruncated: truncated(i),
          resolvedBy,
        };
      }

      if (v.decision === Decision.Deny) {
        const c = await this.consult(ctx, v);
        if (!c.consulted) {
          return {
            combined: withUnions(v, pool),
            decidedBy: i,
            verdicts: summaries(perInterceptor),
            foldTruncated: truncated(i),
            resolvedBy,
          };
        }
        if (!c.permitted) {
          // Reject / unresolved / echo violation: a deny stands (§9);
          // the consultation is still recorded (§10.3 resolved_by).
          return {
            combined: withUnions(c.verdict, pool),
            decidedBy: isHostSynthesized(c.verdict) ? null : i,
            verdicts: summaries(perInterceptor),
            foldTruncated: truncated(i),
            resolvedBy: "rejection",
          };
        }
        resolvedBy = "approval";
        // §7.6: the permit resolution substitutes at this position; its
        // transform folds like an interceptor's (§7.4).
        const sub =
          c.verdict.decision === Decision.Transform ? this.foldTransform(ctx, c.verdict) : c.verdict;
        if (!permits(sub.decision)) {
          return {
            combined: sub,
            decidedBy: null,
            verdicts: summaries(perInterceptor),
            foldTruncated: truncated(i),
            resolvedBy,
          };
        }
        pool.push(sub);
        if (onApproval === "stop") {
          // §7.4 stop: the resolution is the combined verdict; the
          // emission ends. fold_truncated makes the skip legible.
          return {
            combined: withUnions(sub, pool),
            decidedBy: i,
            verdicts: summaries(perInterceptor),
            foldTruncated: truncated(i),
            resolvedBy,
          };
        }
        // resume: the fold continues at i+1.
        if (sub.decision === Decision.Transform) lastTransform = [i, sub];
      } else if (v.decision === Decision.Transform) {
        v = this.foldTransform(ctx, v);
        if (!permits(v.decision)) {
          // Transform failed closed (host-synthesized §5.2).
          return {
            combined: v,
            decidedBy: null,
            verdicts: summaries(perInterceptor),
            foldTruncated: truncated(i),
            resolvedBy,
          };
        }
        lastTransform = [i, v];
      }
    }

    // No standing deny: combined is the last transform, else allow.
    const [combined, decidedBy]: [Verdict, number | null] =
      lastTransform !== null ? [lastTransform[1], lastTransform[0]] : [Verdict.allow(), null];
    return {
      combined: withUnions(combined, pool),
      decidedBy,
      verdicts: summaries(perInterceptor),
      foldTruncated: false,
      resolvedBy,
    };
  }

  /** `sequential/run_all` (§7.4): everything runs, transforms fold
   * through for visibility, severity-max aggregate; the seam is
   * consulted at most once, only when the winner is liftable (which
   * implies every deny in the emission is liftable — a single plain
   * deny already won the severity order). */
  private async dispatchRunAll(ctx: AgentContext): Promise<DispatchOutcome> {
    const all: Verdict[] = [];
    for (const interceptor of this.interceptors) {
      // §6.3 per-interceptor: a malformed verdict becomes that
      // interceptor's synthesized deny; the rest still run.
      const v = await this.invoke(interceptor, ctx);
      if (v.decision === Decision.Transform) {
        const folded = this.foldTransform(ctx, v);
        if (!permits(folded.decision)) {
          // §7.4: a transform that fails to apply short-circuits in
          // both sequential profiles.
          all.push(folded);
          return {
            combined: folded,
            decidedBy: null,
            verdicts: summaries(all),
            foldTruncated: null,
            resolvedBy: null,
          };
        }
        all.push(folded);
      } else {
        all.push(v);
      }
    }
    return this.aggregateAndConsult(ctx, all);
  }

  /** Parallel profiles (§7.5): isolated snapshots, no fold; serial
   * dispatch (isolation semantics, not scheduling). */
  private async dispatchParallel(ctx: AgentContext): Promise<DispatchOutcome> {
    // Every interceptor receives its own copy of the same untransformed
    // snapshot ({@link invoke} clones per call).
    const snapshot = structuredClone(ctx);
    const all: Verdict[] = [];
    for (const interceptor of this.interceptors) {
      all.push(await this.invoke(interceptor, snapshot));
    }
    return this.aggregateAndConsult(ctx, all);
  }

  /** Severity-max aggregation + winner handling, shared by `run_all`
   * and both parallel profiles. Aggregation — including the §7.5
   * transform-conflict and `parallel/unanimous` disagreement synthesis
   * per the declared knobs — delegates to the core's
   * `composeAggregate` so all SDKs agree; the seam consultation and
   * transform application stay here (they call back into user JS). */
  private async aggregateAndConsult(ctx: AgentContext, all: Verdict[]): Promise<DispatchOutcome> {
    let agg: {
      combined: Verdict;
      decided_by: number | null;
      consult: boolean;
      apply_transform: boolean;
      verdicts: VerdictSummary[];
    };
    try {
      agg = JSON.parse(
        native.composeAggregate(JSON.stringify(this.composition), JSON.stringify(all)),
      );
    } catch (e) {
      return synthesized(...codeAndDetail(e));
    }
    let combined = agg.combined;
    let decidedBy = agg.decided_by;
    let resolvedBy: "approval" | "rejection" | null = null;

    // Parallel winner: apply the single winning transform now
    // (sequential transforms already folded during dispatch).
    if (agg.apply_transform) {
      combined = this.foldTransform(ctx, combined);
      if (!permits(combined.decision)) {
        return {
          combined,
          decidedBy: null,
          verdicts: agg.verdicts,
          foldTruncated: null,
          resolvedBy,
        };
      }
    }

    // The combined verdict is a liftable deny the profile says to
    // consult (§7.4–§7.5); environment checks (resolver present, mode,
    // shutdown) live in {@link consult}.
    if (agg.consult) {
      const c = await this.consult(ctx, combined);
      if (c.consulted) {
        if (c.permitted) {
          resolvedBy = "approval";
          // §7.6: the resolution substitutes; a transform applies on
          // top of the context as composed so far.
          const sub =
            c.verdict.decision === Decision.Transform
              ? this.foldTransform(ctx, c.verdict)
              : c.verdict;
          combined = permits(sub.decision) ? withUnions(sub, [...all, sub]) : sub;
        } else {
          // §10.3: consultation without a permit substitution.
          resolvedBy = "rejection";
          combined = withUnions(c.verdict, all);
          if (isHostSynthesized(c.verdict)) decidedBy = null;
        }
      }
    }
    return {
      combined,
      decidedBy,
      verdicts: agg.verdicts,
      foldTruncated: null,
      resolvedBy,
    };
  }

  /** Apply (enforce) or validate (evaluate_only) one transform (§7.4, §8). */
  private foldTransform(ctx: AgentContext, v: Verdict): Verdict {
    const t = v.transform;
    if (!t) return hostErrorVerdict(HostError.TransformInvalid);
    try {
      if (this.mode === EnforcementMode.Enforce) {
        const newCtx: AgentContext = JSON.parse(
          native.applyTransformCtx(JSON.stringify(ctx), t.path, JSON.stringify(t.value)),
        );
        for (const k of Object.keys(ctx)) delete (ctx as Record<string, unknown>)[k];
        Object.assign(ctx, newCtx);
      } else {
        native.validateTransformCtx(JSON.stringify(ctx), t.path, JSON.stringify(t.value));
      }
    } catch (e) {
      const [code, detail] = codeAndDetail(e, HostError.TransformInvalid);
      return hostErrorVerdict(code, detail);
    }
    return v;
  }

  /** The declared provider's output for `ctx` (§10.1); `null` iff the
   * provider is `null`. Throws {@link AgentHooksCoreError} iff the
   * provider rejected the context (§10.2 fail-closed value domain). */
  /** Custom-provider identity, or null when the provider fails (the
   * emission has already been decided at this point). */
  private tryCustomIdentity(ctx: AgentContext): string | null {
    try {
      return this.identityOf(ctx);
    } catch {
      return null;
    }
  }

  private identityOf(ctx: AgentContext): string | null {
    if (this.identity === null) return null;
    if (this.identity === JCS_SHA256) return native.contextIdentity(JSON.stringify(ctx));
    try {
      return this.identity.fn(ctx);
    } catch (e) {
      // §14/TM-09: exception *type* only — a provider error message can
      // embed the context it was hashing.
      throw new AgentHooksCoreError(
        HostError.ContextInvalid,
        `identity provider failed: ${(e as Error)?.constructor?.name ?? "Error"} (see spec §10.1)`,
      );
    }
  }

  /** Consult the approval seam for a liftable deny (§9), when the
   * profile conditions allow it: `enforce` mode, not `agent_shutdown`,
   * a resolver registered, and the verdict actually liftable. Enforces
   * the echo rule and the §9 outcome/verdict consistency requirements. */
  private async consult(ctx: AgentContext, verdict: Verdict): Promise<Consultation> {
    if (!isLiftable(verdict) || this.mode !== EnforcementMode.Enforce) return NOT_CONSULTED;
    // §6.1a: nothing to approve at agent_shutdown.
    if (ctx.interception_point === InterceptionPoint.AgentShutdown) return NOT_CONSULTED;
    // §9: no resolver → the deny stands. Conformant, not an error.
    if (!this.resolver) return NOT_CONSULTED;

    const fail = (err: HostError, detail?: string): Consultation => ({
      consulted: true,
      verdict: hostErrorVerdict(err, detail),
      permitted: false,
    });

    // §9/§14: the host's approval redactor minimizes the context
    // egressing through the seam; a throwing redactor fails closed.
    let presented = ctx;
    if (this.approvalRedactor) {
      try {
        presented = this.approvalRedactor(ctx);
      } catch (e) {
        return fail(
          HostError.ApprovalResolverFailed,
          (e as Error)?.constructor?.name ?? "Error",
        );
      }
    }

    // §9: identity of the context as presented to the resolver —
    // consultation time, after any transforms that folded earlier and
    // after any redaction.
    let identity: string | null;
    try {
      identity = this.identityOf(presented);
    } catch (e) {
      const [code, detail] = codeAndDetail(e);
      return fail(code, detail);
    }

    let res;
    try {
      res = await this.withTimeout(() =>
        this.resolver!.resolve({
          context_identity: identity,
          interception_point: ctx.interception_point,
          verdict,
          context: presented,
        }),
      );
    } catch (e) {
      if (e instanceof InterceptTimeout) {
        return fail(HostError.ApprovalResolverFailed, "timeout");
      }
      return fail(HostError.ApprovalResolverFailed, (e as Error)?.constructor?.name ?? "Error");
    }

    // §9 echo rule (byte-for-byte; null echoes as null).
    if ((res.context_identity ?? null) !== identity) {
      return fail(HostError.ApprovalIdentityMismatch);
    }
    if (!res.verdict || res.outcome === ApprovalOutcome.Unresolved) {
      return fail(HostError.ApprovalUnresolved);
    }
    // §9: the resolver's verdict crosses the same §5 gate as an
    // interceptor's, and outcome/decision must agree (approve MUST
    // carry a permit, reject MUST carry a deny).
    const rv = this.gate(res.verdict);
    if (isHostSynthesized(rv)) {
      return fail(HostError.VerdictInvalid, rv.message ?? undefined);
    }
    let permitted: boolean;
    if (res.outcome === ApprovalOutcome.Approve) {
      if (!permits(rv.decision)) return fail(HostError.VerdictInvalid, "approve with a block verdict");
      permitted = true;
    } else {
      if (rv.decision !== Decision.Deny) return fail(HostError.VerdictInvalid, "reject with a permit verdict");
      permitted = false;
    }
    return { consulted: true, verdict: rv, permitted };
  }
}

/** `(code, detail)` of a native failure; anything else maps to
 * `fallback` with the stringified error as detail. */
function codeAndDetail(e: unknown, fallback: HostError = HostError.ContextInvalid): [HostError, string] {
  if (e instanceof AgentHooksCoreError) return [e.code as HostError, e.message];
  return [fallback, String(e)];
}
