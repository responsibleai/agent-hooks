// Copyright (c) Microsoft. All rights reserved.

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
 * An emitter can also be built from a host declaration document (§7.7)
 * through {@link InterceptionEmitter.fromDeclaration} and the path, JSON
 * and value forms. The document is validated and resolved by the Rust
 * core; this module runs the host's kind resolvers (step 11 of §7.7.6),
 * seals the emitter (§7.7.7) and stamps the contract version on every
 * record (§7.7.8).
 *
 * Fail-closed defaults: an `enforce`-mode emission with zero interceptors
 * bound at the point yields `deny host_error:no_interceptor` (§7), and
 * {@link InterceptionEmitter.emit} **throws** {@link InterceptionBlocked}
 * on any block — the ignorable-result variant is the explicitly named
 * {@link InterceptionEmitter.emitUnchecked}.
 *
 * Failure posture (§6.3.1): every registration is `on_error: deny`
 * unless a declaration binding or {@link InterceptionEmitter.registerWithOptions}
 * says `continue`. Under `continue` the three covered failures (raise,
 * timeout, invalid verdict) settle to an allow carrying
 * `host_warning:control_failed` in the failing slot, the record keeps
 * the reason as `verdicts[].substituted_for`, and the principal is told
 * through {@link InterceptionEmitter.setControlFailureNotifier}, which
 * must exist before such a registration is accepted. Cancellation,
 * approval failures, context failures, transform failures,
 * `no_interceptor` and an explicit deny never continue.
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
  ControlFailureNotice,
  ControlFailureNotifier,
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
  JsonValue,
  ManagedInterceptor,
  ManagedInterceptorOutcome,
  OnError,
  RegistrationError,
  RegistrationOptions,
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
import {
  BindingContext,
  DeclarationError,
  DeclarationErrorClass,
  HostDeclaration,
  HostRegistry,
  ResolvedDeclaration,
  resolveDeclaration,
} from "./declaration";
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

/** Thrown when a setter or `register` is called on an emitter built
 * from a host declaration (§7.7.7): the declaration must stay what ran. */
/** Recursively freeze a JSON-shaped value in place and return it. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export class EmitterSealed extends Error {
  constructor(what: string) {
    super(
      `${what}: this emitter was built from a host declaration and is sealed (see spec §7.7.7)`,
    );
    this.name = "EmitterSealed";
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

/** Payload-free per-interceptor summaries for the record (§10.3).
 * `substituted[i]` is the `host_error:*` reason the host substituted an
 * allow for in slot `i` under `on_error: continue` (§6.3.1), else
 * `null`. */
function summaries(verdicts: Verdict[], substituted: ReadonlyArray<string | null>): VerdictSummary[] {
  return verdicts.map((v, index) => ({
    index,
    decision: v.decision,
    ...(v.reason != null ? { reason: v.reason } : {}),
    ...(substituted[index] != null ? { substituted_for: substituted[index] as string } : {}),
  }));
}

/** Attach `substituted_for` positionally to summaries the core built. */
function withSubstitutions(
  sums: VerdictSummary[],
  substituted: ReadonlyArray<string | null>,
): VerdictSummary[] {
  return sums.map((s) =>
    substituted[s.index] != null ? { ...s, substituted_for: substituted[s.index] as string } : s,
  );
}

/** What runs for one registration: a standard interceptor the emitter
 * times itself, or a managed one that owns its own deadline (§6.3). */
type BoundInterceptor =
  | { managed: false; interceptor: Interceptor }
  | { managed: true; interceptor: ManagedInterceptor };

/** One registered interceptor with its binding facts (§7.7.5): the
 * payload-free name stamped on `verdicts[].name`, the points it runs at
 * (`null` = every point, the pre-declaration behaviour), its timeout
 * (`undefined` = the emitter-wide value, `null` = unbounded) and its
 * failure posture (§6.3.1). */
interface Bound {
  interceptor: BoundInterceptor;
  name: string | null;
  at: ReadonlySet<InterceptionPoint> | null;
  timeoutMs: number | null | undefined;
  onError: OnError;
}

/** One failed interceptor call (§6.3) before the failure posture is
 * applied: the reserved reason, a payload-free detail, and whether
 * `on_error: continue` may substitute for it. Only the three covered
 * failures are continuable; a cancelled managed outcome is not. */
interface CallFailure {
  reason: HostError;
  detail?: string;
  continuable: boolean;
}

function covered(reason: HostError, detail?: string): CallFailure {
  return { reason, detail, continuable: true };
}

function isCallFailure(v: Verdict | CallFailure): v is CallFailure {
  return "continuable" in v;
}

/** What one slot settled to: the verdict in the slot and, when the
 * host substituted an allow under `on_error: continue`, the reason it
 * stands in for (§6.3.1, §10.3 `substituted_for`). */
interface Settled {
  verdict: Verdict;
  substitutedFor: string | null;
}

/** Whether `v` is a typed managed outcome (§6.3). */
function isManagedOutcome(v: unknown): v is ManagedInterceptorOutcome {
  if (v === null || typeof v !== "object") return false;
  const o = (v as { outcome?: unknown }).outcome;
  return o === "verdict" || o === "timeout" || o === "cancelled" || o === "failed";
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

/** Envelope facts for {@link InterceptionEmitter.recordHostFailure}:
 * what the host still knows about an emission whose context it could
 * not construct (§10.3 "Host projection failure"). Everything is
 * optional — an absent member records the §10.3 unknown value
 * (`session_id: ""`, `sequence: -1`, `timestamp` absent). */
export interface HostFailure {
  /** Payload-free failure detail — an exception **type name** or a
   * path, never the content that failed to project (§14 data
   * minimization). Recorded as the verdict `message` (truncated by
   * the §10.3 projection). */
  detail?: string;
  /** `session.id` of the failed emission, when the host knows it. */
  session_id?: string;
  /** The sequence number the failed emission would have carried. The
   * host SHOULD consume the next number from its context source so
   * records stay totally ordered within the session (§10.3). */
  sequence?: number;
  /** RFC 3339 event time, when the host has one. */
  timestamp?: string;
}

/** Whether `v` looks like an interceptor (§7): an object with an
 * `intercept` method. */
function isInterceptor(v: unknown): v is Interceptor {
  return (
    v !== null &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { intercept?: unknown }).intercept === "function"
  );
}

/** Whether `v` looks like a managed interceptor (§6.3): an object with
 * an `interceptManaged` method. */
function isManagedInterceptor(v: unknown): v is ManagedInterceptor {
  return (
    v !== null &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { interceptManaged?: unknown }).interceptManaged === "function"
  );
}

/** Validate `at` from a plain-JS caller: the point set is closed (§3). */
function pointSet(at: Iterable<InterceptionPoint> | undefined): Set<InterceptionPoint> | null {
  if (at === undefined) return null;
  // The compile-time type does not protect plain-JS callers: a
  // misspelled point must not bind nowhere without a word.
  const points = new Set<InterceptionPoint>();
  const known: readonly string[] = Object.values(InterceptionPoint);
  for (const p of at) {
    if (!known.includes(p)) {
      throw new RangeError(
        `unknown interception point ${JSON.stringify(p)}: the point set is closed (§3)`,
      );
    }
    points.add(p);
  }
  if (points.size === 0) {
    throw new RangeError(
      "at must name at least one interception point; omit it to bind every point (§7.7.5)",
    );
  }
  return points;
}

/** Validate `onError` from a plain-JS caller: the value set is closed
 * (§6.3.1); omitted is `deny`. */
function onErrorOf(v: OnError | undefined): OnError {
  if (v === undefined) return OnError.Deny;
  if (v !== OnError.Deny && v !== OnError.Continue) {
    throw new RangeError(
      `unknown on_error value ${JSON.stringify(v)}: "deny" | "continue" (§6.3.1)`,
    );
  }
  return v;
}

export class InterceptionEmitter {
  private readonly interceptors: Bound[] = [];
  private _records: InterceptionRecord[] = [];
  private composition: CompositionConfig = Composition.default();
  private identity: IdentityProvider = JCS_SHA256;
  private approvalRedactor: ((ctx: AgentContext) => AgentContext) | null = null;
  private recordSink: ((record: InterceptionRecord) => void) | null = null;
  private maxRecords: number | null = null;
  private _recordsDropped = 0;
  private readonly mode: EnforcementMode;
  private resolver: ApprovalResolver | null;
  /** §7 emitter-wide interceptor bound; `null` disables enforcement. */
  private timeoutMs: number | null;
  /** §9 resolver bound (`approval_resolver_ms`, §7.7.3); `null` disables. */
  private resolverTimeoutMs: number | null;
  /** §7.7.7: a declaration-built emitter refuses reconfiguration. */
  private sealed = false;
  /** The resolved declaration this emitter was built from, if any. */
  private _declaration: ResolvedDeclaration | null = null;
  /** §6.3.1: the principal channel a continuation is announced on. */
  private notifier: ControlFailureNotifier | null = null;

  /**
   * `timeoutMs` bounds each interceptor `intercept()` and resolver
   * `resolve()` call (§7, RECOMMENDED default 5000 ms); breach fails
   * closed with `host_error:interceptor_timeout` (interceptor) or
   * `host_error:approval_resolver_failed` (resolver). Only async work
   * can be preempted — a synchronous interceptor that blocks the event
   * loop cannot be interrupted. `timeoutMs: null` disables enforcement.
   */
  constructor(
    mode: EnforcementMode = EnforcementMode.Enforce,
    resolver: ApprovalResolver | null = null,
    timeoutMs: number | null = DEFAULT_TIMEOUT_MS,
  ) {
    this.mode = mode;
    this.resolver = resolver;
    this.timeoutMs = timeoutMs;
    this.resolverTimeoutMs = timeoutMs;
  }

  // ---- host declaration (§7.7) ----------------------------------------------

  /** Build an emitter from a validated declaration: steps 8 to 11 of
   * §7.7.6 (resolve against the registry's surface and names in the
   * core, then run every binding's kind resolver). The result is
   * sealed (§7.7.7) and stamps `declaration` on every record (§7.7.8).
   * Throws {@link DeclarationError} on refusal; no emitter exists then. */
  static fromDeclaration(declaration: HostDeclaration, registry: HostRegistry): InterceptionEmitter {
    const resolved = resolveDeclaration(declaration, registry);
    return InterceptionEmitter.fromResolved(resolved, registry);
  }

  /** {@link HostDeclaration.fromPath} then {@link fromDeclaration}. */
  static async fromDeclarationPath(
    path: string,
    registry: HostRegistry,
  ): Promise<InterceptionEmitter> {
    return InterceptionEmitter.fromDeclaration(await HostDeclaration.fromPath(path), registry);
  }

  /** {@link HostDeclaration.fromJson} then {@link fromDeclaration}. */
  static fromDeclarationJson(text: string, registry: HostRegistry): InterceptionEmitter {
    return InterceptionEmitter.fromDeclaration(HostDeclaration.fromJson(text), registry);
  }

  /** {@link HostDeclaration.fromValue} then {@link fromDeclaration}. */
  static fromDeclarationValue(value: unknown, registry: HostRegistry): InterceptionEmitter {
    return InterceptionEmitter.fromDeclaration(HostDeclaration.fromValue(value), registry);
  }

  /** The resolved declaration this emitter runs under, when it was
   * built from one (§7.7.7). Its canonical JSON is the equivalence
   * oracle for the construction paths. The value is frozen all the
   * way down: writing through it has no effect on dispatch or records.
   * `null` for an emitter configured in code. */
  get declaration(): ResolvedDeclaration | null {
    return this._declaration;
  }

  /** Step 11 and construction. Every reference is looked up again in
   * the registry's own maps, so bookkeeping drift between the names the
   * core checked and what the registry holds fails closed. */
  private static fromResolved(
    resolved: ResolvedDeclaration,
    registry: HostRegistry,
  ): InterceptionEmitter {
    const cfg = resolved.configuration;
    let resolver: ApprovalResolver | null = null;
    if (cfg.approval.resolver !== null) {
      const name = cfg.approval.resolver;
      const r = registry.approvalResolverRef(name);
      if (r === undefined) {
        throw DeclarationError.single(
          DeclarationErrorClass.ReferenceUnresolved,
          "/configuration/approval/resolver",
          `approval resolver ${JSON.stringify(name)} vanished from the registry`,
        );
      }
      resolver = r;
    }
    let identity: IdentityProvider;
    if (cfg.identity_provider === null) {
      identity = null;
    } else if (cfg.identity_provider === JCS_SHA256) {
      identity = JCS_SHA256;
    } else {
      const name = cfg.identity_provider;
      const fn = registry.identityFn(name);
      if (fn === undefined) {
        throw DeclarationError.single(
          DeclarationErrorClass.ReferenceUnresolved,
          "/configuration/identity_provider",
          `identity provider ${JSON.stringify(name)} vanished from the registry`,
        );
      }
      identity = { name, fn };
    }
    let approvalRedactor: ((ctx: AgentContext) => AgentContext) | null = null;
    if (cfg.approval.redactor !== null) {
      const name = cfg.approval.redactor;
      const fn = registry.redactorFn(name);
      if (fn === undefined) {
        throw DeclarationError.single(
          DeclarationErrorClass.ReferenceUnresolved,
          "/configuration/approval/redactor",
          `approval redactor ${JSON.stringify(name)} vanished from the registry`,
        );
      }
      approvalRedactor = fn;
    }

    const notifier = registry.controlFailureNotifierRef();
    const bound: Bound[] = [];
    resolved.bindings.forEach((b, i) => {
      const pointer = `/bindings/${i}`;
      const standard = registry.kindResolver(b.kind);
      const managed = registry.managedKindResolver(b.kind);
      if (standard === undefined && managed === undefined) {
        throw DeclarationError.single(
          DeclarationErrorClass.KindUnknown,
          `${pointer}/kind`,
          `kind ${JSON.stringify(b.kind)} vanished from the registry`,
        );
      }
      // §6.3.1: a continuation must be announced, so a document that
      // resolves a binding to `continue` needs the registry's principal
      // channel before it loads. Refusing here, not falling back to
      // deny at emission, keeps a configured `continue` from silently
      // not applying. The pointer names where the posture came from.
      const onError = onErrorOf(b.on_error);
      if (onError === OnError.Continue && notifier === null) {
        const at =
          b.on_error === cfg.failure.on_error
            ? "/configuration/failure/on_error"
            : `${pointer}/on_error`;
        throw DeclarationError.single(
          DeclarationErrorClass.BindingRejected,
          at,
          `binding ${JSON.stringify(b.id)} resolves to on_error: continue but the host registry has no control failure notifier (see spec §6.3.1)`,
        );
      }
      // The dispatch set is fixed before the resolver runs and the
      // context carries a frozen copy, so a resolver cannot widen its
      // own binding (the Rust core hands out `&BTreeSet` for the same
      // reason).
      const at = new Set(b.at);
      const context: BindingContext = {
        id: b.id,
        kind: b.kind,
        at: Object.freeze([...b.at]),
        timeoutMs: b.timeout_ms,
        onError,
        host: resolved.host ?? null,
        declarationVersion: resolved.declaration,
      };
      // §7.7.5: a resolver that throws or returns a non-interceptor
      // refuses the document; the message is bounded and the config is
      // never echoed by the loader.
      let built: unknown;
      try {
        built = standard !== undefined ? standard(b.config, context) : managed!(b.config, context);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "resolver threw a non-Error value";
        throw DeclarationError.single(
          DeclarationErrorClass.BindingRejected,
          pointer,
          `binding ${JSON.stringify(b.id)} (kind ${JSON.stringify(b.kind)}) rejected: ${msg}`,
        );
      }
      let interceptor: BoundInterceptor;
      if (standard !== undefined && isInterceptor(built)) {
        interceptor = { managed: false, interceptor: built };
      } else if (standard === undefined && isManagedInterceptor(built)) {
        interceptor = { managed: true, interceptor: built };
      } else {
        const why =
          built instanceof Promise
            ? "resolver returned a Promise; kind resolvers are synchronous"
            : standard !== undefined
              ? "resolver did not return an interceptor"
              : "resolver did not return a managed interceptor";
        throw DeclarationError.single(
          DeclarationErrorClass.BindingRejected,
          pointer,
          `binding ${JSON.stringify(b.id)} (kind ${JSON.stringify(b.kind)}) rejected: ${why}`,
        );
      }
      bound.push({
        interceptor,
        name: b.id,
        at,
        timeoutMs: b.timeout_ms,
        onError,
      });
    });

    const em = new InterceptionEmitter(cfg.mode, resolver, cfg.timeouts.interceptor_ms);
    em.resolverTimeoutMs = cfg.timeouts.approval_resolver_ms;
    em.notifier = notifier;
    // The emitter owns its own copy of the composition and the
    // declaration it exposes is frozen all the way down, so the seal
    // cannot be bypassed by writing through `emitter.declaration`.
    em.composition = { ...cfg.composition };
    em.identity = identity;
    em.approvalRedactor = approvalRedactor;
    em.maxRecords = cfg.records.max_buffered;
    em.interceptors.push(...bound);
    em._declaration = deepFreeze(resolved);
    em.sealed = true;
    return em;
  }

  /** §7.7.7: a declaration-built emitter refuses reconfiguration;
   * otherwise the declaration would not be what ran. */
  private unsealed(what: string): void {
    if (this.sealed) throw new EmitterSealed(what);
  }

  /** Race `fn`'s result against a timeout (§7). `limitMs: null` runs
   * unbounded. */
  private async withTimeout<T>(fn: () => T | Promise<T>, limitMs: number | null): Promise<T> {
    if (limitMs === null) return fn();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => fn())(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new InterceptTimeout()), limitMs);
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
   * payload-free `name` recorded on `verdicts[].name` (§10.3) and the
   * points it runs at (`at`; omitted = every point). At point P the
   * interceptors that run are those bound there, in registration
   * order; `interceptors_registered`, `verdicts[].index` and
   * `decided_by` count and index that list (§7.7.8). Throws
   * {@link EmitterSealed} on a declaration-built emitter. */
  register(interceptor: Interceptor, name?: string, at?: Iterable<InterceptionPoint>): this {
    this.unsealed("register");
    // `register` always means on_error: deny (§6.3.1); only the options
    // form can open the default, and it needs the notifier first.
    this.pushBound({ managed: false, interceptor }, { name, at });
    return this;
  }

  /** {@link register} with every registration option named (§7.7.5,
   * §6.3.1). `onError: "continue"` is refused with
   * {@link RegistrationError}, and nothing is registered, unless
   * {@link setControlFailureNotifier} ran first: a continuation the
   * principal cannot be told about is not conformant. Throws
   * {@link EmitterSealed} on a declaration-built emitter. */
  registerWithOptions(interceptor: Interceptor, options: RegistrationOptions = {}): this {
    this.unsealed("registerWithOptions");
    this.pushBound({ managed: false, interceptor }, options);
    return this;
  }

  /** Register an interceptor that owns its own deadline (§6.3). The
   * emitter does not time it; on every call it receives the bound this
   * registration resolves to (the emitter-wide timeout, or `null` when
   * that is disabled) and reports a typed outcome: `verdict`
   * (gated like any return), `timeout` (after cleanup; follows
   * `onError`), `failed` (follows `onError`) or `cancelled` (always
   * `deny host_error:interceptor_failed`). Same refusals as
   * {@link registerWithOptions}. */
  registerManaged(interceptor: ManagedInterceptor, options: RegistrationOptions = {}): this {
    this.unsealed("registerManaged");
    this.pushBound({ managed: true, interceptor }, options);
    return this;
  }

  /** Set the principal channel (§6.3.1): the callback that tells the
   * user, or the agent through the host's own message channel, that a
   * control failed and the action continued. Required before any
   * registration with `onError: "continue"`. Allowed on a sealed
   * emitter: like the record sink it is a host channel, not declared
   * configuration (§7.7.7). */
  setControlFailureNotifier(notifier: ControlFailureNotifier): this {
    if (typeof notifier !== "function") {
      throw new TypeError("control failure notifier must be a function");
    }
    this.notifier = notifier;
    return this;
  }

  private pushBound(interceptor: BoundInterceptor, options: RegistrationOptions): void {
    const points = pointSet(options.at);
    const onError = onErrorOf(options.onError);
    if (onError === OnError.Continue && this.notifier === null) {
      throw new RegistrationError(
        `${options.name ?? "unnamed registration"}: on_error is continue but the emitter has no control failure notifier; call setControlFailureNotifier first (see spec §6.3.1)`,
      );
    }
    this.interceptors.push({
      interceptor,
      name: options.name ?? null,
      at: points,
      timeoutMs: undefined,
      onError,
    });
  }

  /**
   * Declare the composition profile for subsequent emissions (§7.1).
   * The profile and knob values are validated against the closed §7.2
   * sets at call time (the compile-time types do not protect plain-JS
   * callers): an undeclared value throws `RangeError` so no emission
   * can start under semantics the operator did not declare.
   *
   * The default (`sequential/first_deny`, `on_approval: stop`) is the
   * configuration §14 warns about: after an approval lifts a liftable
   * deny, interceptors registered after the escalating one never run
   * for that emission (`fold_truncated` on the record). Register
   * must-run controls first, or use `sequential/run_all` / a parallel
   * profile. See docs/PRODUCTION.md.
   */
  setComposition(composition: CompositionConfig): this {
    this.unsealed("setComposition");
    const profiles: string[] = Object.values(CompositionProfile);
    if (!profiles.includes(composition.profile)) {
      throw new RangeError(
        `unknown composition profile ${JSON.stringify(composition.profile)}: the profile set is closed (§7.2)`,
      );
    }
    const knobs: ReadonlyArray<[string, string | undefined, readonly string[]]> = [
      ["on_approval", composition.on_approval, ["stop", "resume"]],
      ["on_disagreement", composition.on_disagreement, ["deny", "approval"]],
      ["on_transform_conflict", composition.on_transform_conflict, ["deny", "approval"]],
    ];
    for (const [name, value, allowed] of knobs) {
      if (value !== undefined && !allowed.includes(value)) {
        throw new RangeError(
          `unknown ${name} value ${JSON.stringify(value)}: ${allowed.map((a) => `"${a}"`).join(" | ")} (§7.4–§7.5)`,
        );
      }
    }
    this.composition = composition;
    return this;
  }

  /** Declare the identity provider (§10.1). Default `"jcs-sha256"`.
   * §10.1 name rules are enforced: a custom provider name must match
   * `^[a-z][a-z0-9_-]*$` and must not begin with `jcs` (reserved so a
   * custom function can never claim golden-vector semantics). */
  setIdentityProvider(provider: IdentityProvider): this {
    this.unsealed("setIdentityProvider");
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
    this.unsealed("setApprovalRedactor");
    this.approvalRedactor = redactor;
    return this;
  }

  /** Register a per-emission record callback (§10.3), invoked
   * synchronously after every emission before buffering; a sink
   * exception is swallowed (audit delivery is the host's liveness
   * concern, not the control plane's). Allowed on a sealed emitter: it
   * changes where records go, not what they say (§7.7.7). */
  setRecordSink(sink: (record: InterceptionRecord) => void): this {
    this.recordSink = sink;
    return this;
  }

  /** Bound the in-memory record buffer: when full, the OLDEST record
   * is dropped and {@link recordsDropped} increments. Unbounded by
   * default. */
  setMaxRecords(max: number): this {
    this.unsealed("setMaxRecords");
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
    const active = this.active(ctx);
    if (outcome === null) outcome = await this.dispatch(ctx, active);

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
      declaration: this._declaration?.declaration ?? null,
      // §10.3 summaries with the bound names attached positionally.
      verdicts: outcome.verdicts.map((v) => ({
        ...v,
        ...(active[v.index]?.name != null ? { name: active[v.index].name as string } : {}),
      })),
      fold_truncated: outcome.foldTruncated,
      resolved_by: outcome.resolvedBy,
      interceptors_registered: active.length,
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
    return this.deliver(record);
  }

  /** §10.3/§11 host projection failure: synthesize and deliver the
   * fail-closed record for an emission whose `AgentContext` the host
   * could not construct at all — its own projection to the wire failed
   * before anything existed to {@link emit} (e.g. a tool-call argument
   * getter threw during to-wire conversion at the chat seam). Without
   * this the host can only fail the action closed *recordless*; with
   * it the trail stays complete under host-side faults.
   *
   * The record is the §10.3 rejection shape: the payload-free
   * projection of a `deny host_error:context_invalid` carrying
   * `failure.detail` (payload-free: a type name or path, never
   * content) as its message; `null` identities under the declared
   * provider; `decided_by: null`; no per-interceptor summaries (no
   * interceptor ran); envelope members from {@link HostFailure}, with
   * the §10.3 unknown values (`""`/`-1`) where absent. It takes the
   * next slot in the record stream (sink, then buffer) like any
   * emission. In `enforce` mode the host MUST still fail the action
   * closed; in `evaluate_only` the record documents the host fault
   * without implying enforcement (§8). */
  recordHostFailure(point: InterceptionPoint, failure: HostFailure = {}): InterceptionRecord {
    // Deliberately partial basis: only the envelope facts the host
    // still knows. It never passes §4 validation (`spec` is absent),
    // so the core's finalize always yields the §10.3 rejection shape —
    // null identities under the declared provider — and keeps the
    // synthesized `context_invalid` deny (with the host's detail)
    // instead of substituting its own.
    const basis: Record<string, unknown> = { interception_point: point };
    if (failure.session_id !== undefined) basis["session"] = { id: failure.session_id };
    if (failure.sequence !== undefined) basis["sequence"] = failure.sequence;
    if (failure.timestamp !== undefined) basis["timestamp"] = failure.timestamp;
    const providerName =
      this.identity === null ? null : this.identity === JCS_SHA256 ? JCS_SHA256 : this.identity.name;
    const record = finalize(
      basis as unknown as AgentContext,
      hostErrorVerdict(HostError.ContextInvalid, failure.detail),
      this.mode,
      {
        input_identity: null,
        identity_provider: providerName,
        enforced_identity: null,
        decided_by: null,
        composition: this.composition,
        declaration: this._declaration?.declaration ?? null,
        verdicts: null,
        fold_truncated: null,
        resolved_by: null,
        interceptors_registered: this.interceptors.filter((b) => runsAt(b, point)).length,
      },
    );
    return this.deliver(record);
  }

  /** Deliver a record to the sink and the bounded buffer (§10.3). */
  private deliver(record: InterceptionRecord): InterceptionRecord {
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

  /** The interceptors bound at the context's point, in dispatch order
   * (§7.7.8). */
  private active(ctx: AgentContext): Bound[] {
    const point = pointOf(ctx);
    return this.interceptors.filter((b) => runsAt(b, point));
  }

  /** The bound a registration runs under: its own, else the emitter's. */
  private limit(b: Bound): number | null {
    return b.timeoutMs === undefined ? this.timeoutMs : b.timeoutMs;
  }

  /** Profile dispatch (§7.4–§7.5). Returns the combined verdict and
   * its record metadata. */
  private async dispatch(ctx: AgentContext, active: Bound[]): Promise<DispatchOutcome> {
    if (active.length === 0) {
      // §7: zero interceptors fails closed, profile-independent.
      // Register an explicit allow-all interceptor for a deliberate
      // passthrough. With per-point bindings (§7.7.5) this is per
      // point: a surface point with no binding denies.
      return synthesized(HostError.NoInterceptor);
    }
    switch (this.composition.profile) {
      case CompositionProfile.SequentialFirstDeny:
        return this.dispatchFirstDeny(ctx, active);
      case CompositionProfile.SequentialRunAll:
        return this.dispatchRunAll(ctx, active);
      case CompositionProfile.ParallelStrictest:
      case CompositionProfile.ParallelUnanimous:
        return this.dispatchParallel(ctx, active);
      default:
        // Unreachable through the public API: setComposition validates
        // against the closed §7.2 set. Fail closed rather than silently
        // dispatch under undeclared semantics.
        return synthesized(HostError.ContextInvalid, "undeclared composition profile (§7.2)");
    }
  }

  /** Invoke one interceptor on its own copy of `ctx` (§7), pass the
   * result through the §5 gate and apply the registration's failure
   * posture (§6.3.1). Never throws: every failure settles to the §6.3
   * deny or, under `continue`, to the substituted allow. `idx` is the
   * dispatch index of the registration (`verdicts[].index`). */
  private async invoke(bound: Bound, ctx: AgentContext, idx: number): Promise<Settled> {
    const out = await this.call(bound, ctx);
    if (!isCallFailure(out)) return { verdict: out, substitutedFor: null };
    return this.settle(ctx, idx, bound, out);
  }

  /** The raw call: a gated verdict, or the failure it produced. */
  private async call(bound: Bound, ctx: AgentContext): Promise<Verdict | CallFailure> {
    if (bound.interceptor.managed) return this.callManaged(bound.interceptor.interceptor, ctx, bound);
    let v: Verdict;
    try {
      // §7: each interceptor gets its own copy — in-place mutation of
      // the copy cannot alter enforcement.
      const interceptor = bound.interceptor.interceptor;
      v = await this.withTimeout(() => interceptor.intercept(structuredClone(ctx)), this.limit(bound));
    } catch (e) {
      if (e instanceof InterceptTimeout) return covered(HostError.InterceptorTimeout);
      return covered(HostError.InterceptorFailed, (e as Error)?.constructor?.name ?? "Error");
    }
    return this.gated(v);
  }

  /** A managed interceptor (§6.3) owns its deadline: it receives the
   * resolved bound and is not raced against a second timer. Its typed
   * outcome is mapped by the core so every SDK agrees; `cancelled` is
   * the one failure `on_error: continue` never covers. */
  private async callManaged(
    interceptor: ManagedInterceptor,
    ctx: AgentContext,
    bound: Bound,
  ): Promise<Verdict | CallFailure> {
    let outcome: unknown;
    try {
      outcome = await interceptor.interceptManaged(structuredClone(ctx), this.limit(bound));
    } catch (e) {
      return covered(HostError.InterceptorFailed, (e as Error)?.constructor?.name ?? "Error");
    }
    if (!isManagedOutcome(outcome)) {
      // A value that is not a typed outcome is a return that fails
      // validation (§6.3), like a malformed verdict.
      return covered(
        HostError.VerdictInvalid,
        "managed outcome is not one of verdict | timeout | cancelled | failed (see spec §6.3)",
      );
    }
    if (outcome.outcome === "verdict") return this.gated(outcome.verdict);
    let mapped: {
      verdict: Verdict;
      failure: { reason: HostError; detail: string | null; continuable: boolean } | null;
    };
    try {
      mapped = JSON.parse(
        native.managedOutcome(
          JSON.stringify(
            outcome.outcome === "failed"
              ? { outcome: "failed", ...(outcome.detail !== undefined ? { detail: String(outcome.detail) } : {}) }
              : { outcome: outcome.outcome },
          ),
        ),
      );
    } catch (e) {
      const [code, detail] = codeAndDetail(e, HostError.InterceptorFailed);
      return { reason: code, detail, continuable: false };
    }
    if (mapped.failure === null) return this.gated(mapped.verdict);
    return {
      reason: mapped.failure.reason,
      detail: mapped.failure.detail ?? undefined,
      continuable: mapped.failure.continuable,
    };
  }

  /** §5 gate as a call result: the normalized verdict, or the
   * `verdict_invalid` failure. */
  private gated(v: Verdict): Verdict | CallFailure {
    const g = this.gate(v);
    if (isHostSynthesized(g)) return covered(HostError.VerdictInvalid, g.message ?? undefined);
    return g;
  }

  /** Apply the registration's failure posture to one failed call
   * (§6.3.1). Under `deny`, or for a failure `continue` does not cover,
   * the §6.3 deny stands in the slot. Under `continue` the principal is
   * told first; only then does the substituted allow take the slot, so
   * a channel that fails withdraws the continuation and the deny
   * stands. The core builds the substituted shape and the notice so
   * every SDK writes the same bytes. */
  private settle(ctx: AgentContext, idx: number, bound: Bound, failure: CallFailure): Settled {
    const deny = (detail?: string): Settled => ({
      verdict: hostErrorVerdict(failure.reason, detail),
      substitutedFor: null,
    });
    if (bound.onError !== OnError.Continue || !failure.continuable) return deny(failure.detail);
    const binding = bound.name ?? `interceptor-${idx}`;
    let sub: { verdict: Verdict; substituted_for: string; notice: ControlFailureNotice };
    try {
      const point = pointOf(ctx);
      sub = JSON.parse(
        native.controlFailureSubstitute(
          JSON.stringify({
            binding,
            reason: failure.reason,
            index: idx,
            ...(point !== null ? { interception_point: point } : {}),
          }),
        ),
      );
    } catch {
      // The core refused the request (a reason continue does not
      // cover): the deny stands, as it must.
      return deny(failure.detail);
    }
    if (this.notifier === null) {
      return deny("on_error: continue without a control failure notifier; the deny stands (see spec §6.3.1)");
    }
    try {
      this.notifier(sub.notice);
    } catch {
      return deny("control failure notifier failed; the deny stands (see spec §6.3.1)");
    }
    return { verdict: sub.verdict, substitutedFor: sub.substituted_for };
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
   * `perInterceptor` stays index-aligned with dispatch order (one
   * entry per invoked interceptor, §10.3 summaries); `pool`
   * additionally holds substituted resolutions for the §7.3 unions. */
  private async dispatchFirstDeny(ctx: AgentContext, active: Bound[]): Promise<DispatchOutcome> {
    const n = active.length;
    const onApproval = this.composition.on_approval ?? "stop";
    const perInterceptor: Verdict[] = [];
    const substituted: Array<string | null> = [];
    const pool: Verdict[] = [];
    let lastTransform: [number, Verdict] | null = null;
    let resolvedBy: "approval" | "rejection" | null = null;
    const truncated = (i: number) => i + 1 < n;

    for (let i = 0; i < n; i++) {
      // §6.3.1: a slot substituted under `continue` holds an allow and
      // the fold goes on; it never short-circuits.
      const settled = await this.invoke(active[i], ctx, i);
      let v = settled.verdict;
      perInterceptor.push(v);
      substituted.push(settled.substitutedFor);
      pool.push(v);
      if (isHostSynthesized(v)) {
        // §6.3: malformed verdict fails closed and — in this profile —
        // short-circuits like any deny. The failure deny is attributed
        // to the failing interceptor (§10.3 decided_by), matching the
        // aggregation profiles.
        return {
          combined: withUnions(v, pool),
          decidedBy: i,
          verdicts: summaries(perInterceptor, substituted),
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
            verdicts: summaries(perInterceptor, substituted),
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
            verdicts: summaries(perInterceptor, substituted),
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
            verdicts: summaries(perInterceptor, substituted),
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
            verdicts: summaries(perInterceptor, substituted),
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
            verdicts: summaries(perInterceptor, substituted),
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
      verdicts: summaries(perInterceptor, substituted),
      foldTruncated: false,
      resolvedBy,
    };
  }

  /** `sequential/run_all` (§7.4): everything runs, transforms fold
   * through for visibility, severity-max aggregate; the seam is
   * consulted at most once, only when the winner is liftable (which
   * implies every deny in the emission is liftable — a single plain
   * deny already won the severity order). */
  private async dispatchRunAll(ctx: AgentContext, active: Bound[]): Promise<DispatchOutcome> {
    const all: Verdict[] = [];
    const substituted: Array<string | null> = [];
    for (let i = 0; i < active.length; i++) {
      // §6.3 per-interceptor: a malformed verdict becomes that
      // interceptor's synthesized deny (or, under `continue`, the
      // substituted allow); the rest still run.
      const settled = await this.invoke(active[i], ctx, i);
      const v = settled.verdict;
      substituted.push(settled.substitutedFor);
      if (v.decision === Decision.Transform) {
        const folded = this.foldTransform(ctx, v);
        if (!permits(folded.decision)) {
          // §7.4: a transform that fails to apply short-circuits in
          // both sequential profiles.
          all.push(folded);
          return {
            combined: folded,
            decidedBy: null,
            verdicts: summaries(all, substituted),
            foldTruncated: null,
            resolvedBy: null,
          };
        }
        all.push(folded);
      } else {
        all.push(v);
      }
    }
    return this.aggregateAndConsult(ctx, all, substituted);
  }

  /** Parallel profiles (§7.5): isolated snapshots, no fold; serial
   * dispatch (isolation semantics, not scheduling). */
  private async dispatchParallel(ctx: AgentContext, active: Bound[]): Promise<DispatchOutcome> {
    // Every interceptor receives its own copy of the same untransformed
    // snapshot ({@link invoke} clones per call).
    const snapshot = structuredClone(ctx);
    const all: Verdict[] = [];
    const substituted: Array<string | null> = [];
    for (let i = 0; i < active.length; i++) {
      const settled = await this.invoke(active[i], snapshot, i);
      all.push(settled.verdict);
      substituted.push(settled.substitutedFor);
    }
    return this.aggregateAndConsult(ctx, all, substituted);
  }

  /** Severity-max aggregation + winner handling, shared by `run_all`
   * and both parallel profiles. Aggregation — including the §7.5
   * transform-conflict and `parallel/unanimous` disagreement synthesis
   * per the declared knobs — delegates to the core's
   * `composeAggregate` so all SDKs agree; the seam consultation and
   * transform application stay here (they call back into user JS). */
  private async aggregateAndConsult(
    ctx: AgentContext,
    all: Verdict[],
    substituted: ReadonlyArray<string | null>,
  ): Promise<DispatchOutcome> {
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
    // §10.3: the core's summaries carry no substitution; attach
    // `substituted_for` positionally, as the names are attached later.
    const verdicts = withSubstitutions(agg.verdicts, substituted);
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
          verdicts,
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
      verdicts,
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

  /** Custom-provider identity, or null when the provider fails (the
   * emission has already been decided at this point). */
  private tryCustomIdentity(ctx: AgentContext): string | null {
    try {
      return this.identityOf(ctx);
    } catch {
      return null;
    }
  }

  /** The declared provider's output for `ctx` (§10.1); `null` iff the
   * provider is `null`. Throws {@link AgentHooksCoreError} iff the
   * provider rejected the context (§10.2 fail-closed value domain). */
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
      res = await this.withTimeout(
        () =>
          this.resolver!.resolve({
            context_identity: identity,
            interception_point: ctx.interception_point,
            verdict,
            context: presented,
          }),
        this.resolverTimeoutMs,
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

/** The context's interception point when it names one. */
function pointOf(ctx: AgentContext): InterceptionPoint | null {
  const p = (ctx as Record<string, JsonValue | undefined>)["interception_point"];
  return typeof p === "string" && (Object.values(InterceptionPoint) as string[]).includes(p)
    ? (p as InterceptionPoint)
    : null;
}

/** Whether a registration runs at `point` (§7.7.5). A registration
 * without an `at` filter runs everywhere. An unparseable point never
 * reaches dispatch (§4 validation denies first); every binding counts
 * then so the record is conservative. */
function runsAt(b: Bound, point: InterceptionPoint | null): boolean {
  if (b.at === null) return true;
  if (point === null) return true;
  return b.at.has(point);
}

/** `(code, detail)` of a native failure; anything else maps to
 * `fallback` with the stringified error as detail. */
function codeAndDetail(e: unknown, fallback: HostError = HostError.ContextInvalid): [HostError, string] {
  if (e instanceof AgentHooksCoreError) return [e.code as HostError, e.message];
  return [fallback, String(e)];
}
