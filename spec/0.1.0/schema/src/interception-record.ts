// Copyright (c) Microsoft. All rights reserved.

// interception-record.schema.json: the host-side record of one emission (§10.3).

import { CompositionProfile, ConflictResolution, Mode, OnApproval } from "./common";
import { InterceptionPoint } from "./interception-point";
import { Decision } from "./verdict";

/**
 * The transform member of the projection: path only.
 * @additionalProperties false
 */
export interface TransformProjection {
  path: string;
}

/**
 * Presence only; members are stripped by the projection.
 * @additionalProperties false
 */
export interface ApprovalPresence {}

/**
 * The payload-free projection of the combined verdict (§10.3): transform.value
 * dropped, approval members stripped, messages truncated to 256 UTF-8 bytes.
 * warnings[].reason may carry host_warning:control_failed (§6.3.1, §11.1).
 */
export interface VerdictProjection {
  transform?: TransformProjection;
  approval?: ApprovalPresence;
}

/**
 * W3C Trace Context identifiers echoed from the context's optional trace block
 * (§4.5, §10.3).
 * @additionalProperties false
 */
export interface Trace {
  trace_id?: string;
  span_id?: string;
}

/** The host_error reasons a continue posture may substitute for (§6.3.1). */
export enum SubstitutedFor {
  InterceptorFailed = "host_error:interceptor_failed",
  InterceptorTimeout = "host_error:interceptor_timeout",
  VerdictInvalid = "host_error:verdict_invalid",
}

/**
 * Payload-free summary of one interceptor's verdict (§10.3).
 * @additionalProperties false
 */
export interface VerdictSlot {
  /** @minimum 0 */
  index: number;
  decision: Decision;
  reason?: string | null;
  /** Host-chosen payload-free registration identifier for the interceptor at index (§10.3). */
  name?: string;
  /**
   * Present iff this slot's verdict is the allow the host substituted under
   * on_error: continue (§6.3.1): the host_error reason the §6.3 deny would have
   * carried. The entry's decision is allow and reason is absent.
   */
  substituted_for?: SubstitutedFor;
}

/** Consultation outcomes a record names (§7.6). */
export enum ResolvedBy {
  Approval = "approval",
  Rejection = "rejection",
}

/**
 * Host-side record of one emission (AGENT-HOOKS-0.1 §10.3). Payload-free:
 * identities (when a provider is declared) bind the record to the exact
 * pre/post-composition context; session_id/sequence/decided_by provide ordering
 * and attribution; composition makes the record interpretable without
 * out-of-band host configuration.
 *
 * Two rules relate members and cannot be typed, so they are written as JSON
 * Schema in the allOf tag below and copied through by the generator: verdicts
 * is REQUIRED under the multi-verdict profiles (§7.4), and the identities are
 * null when identity_provider is null (§10.3).
 * @title Agent Hooks — interception record
 * @additionalProperties false
 * @allOf [{"if": {"properties": {"composition": {"type": "object", "properties": {"profile": {"enum": ["sequential/run_all", "parallel/strictest", "parallel/unanimous"]}}}}}, "then": {"required": ["verdicts"]}}, {"description": "§10.3: identities are null when identity_provider is null.", "if": {"properties": {"identity_provider": {"const": null}}}, "then": {"properties": {"input_identity": {"const": null}, "enforced_identity": {"const": null}}}}]
 */
export interface InterceptionRecord {
  interception_point: InterceptionPoint;
  mode: Mode;
  verdict: VerdictProjection;
  /** Identity provider output on the context before dispatch; null iff identity_provider is null. */
  input_identity: string | null;
  /** Identity provider output after composition completes; null iff identity_provider is null. */
  enforced_identity: string | null;
  /**
   * The declared identity provider (§10.1): "jcs-sha256", a host-defined id
   * (name rules enforced: ^[a-z][a-z0-9_-]*$ and never a jcs prefix), or null
   * (identity-unbound).
   * @pattern ^(jcs-sha256|(?!jcs)[a-z][a-z0-9_-]*)$
   */
  identity_provider: string | null;
  /** ctx.session.id — correlates records across a session. */
  session_id: string;
  /** ctx.sequence — total order of records within the session (§12.2.3). */
  sequence: number;
  /**
   * OPTIONAL. The context's RFC 3339 timestamp, copied verbatim (§10.3); absent
   * when the context lacked the field.
   */
  timestamp?: string;
  /**
   * OPTIONAL. W3C Trace Context identifiers echoed from the context's optional
   * trace block (§4.5, §10.3); absent when the context carried neither member.
   */
  trace?: Trace;
  /**
   * Registration index of the interceptor whose verdict won aggregation or whose
   * liftable deny was consulted (§7.6); null for a pure-allow combination or a
   * host-synthesized verdict.
   * @minimum 0
   */
  decided_by?: number | null;
  /**
   * The composition profile and knobs in effect for this emission (§7.1).
   * @additionalProperties false
   */
  composition: {
    profile: CompositionProfile;
    on_approval?: OnApproval;
    on_disagreement?: ConflictResolution;
    on_transform_conflict?: ConflictResolution;
  };
  /**
   * OPTIONAL. The host declaration contract version the emitter was built from
   * (§7.7.8), e.g. agent-hooks-declaration/1.0. Present iff the emitter was
   * constructed from a declaration document; absent for a host configured in
   * code. One closed-grammar string, so payload-free by construction.
   * @pattern ^agent-hooks-declaration/[0-9]+\.[0-9]+$
   */
  declaration?: string;
  /**
   * Payload-free per-interceptor summary. REQUIRED in multi-verdict profiles
   * (sequential/run_all, parallel/*) and whenever any slot carries
   * substituted_for (§6.3.1); otherwise OPTIONAL in sequential/first_deny.
   */
  verdicts?: VerdictSlot[];
  /**
   * true iff one or more registered interceptors were never invoked in this
   * emission (short-circuit, approval-stop, or a failed fold-transform). Defined
   * for the sequential profiles (§7.4).
   */
  fold_truncated?: boolean;
  /**
   * Consultation outcome (§7.6, §10.3): "approval" iff a permit resolution
   * substituted for a verdict; "rejection" iff the seam was consulted and did not
   * lift the deny; absent/null iff never consulted.
   */
  resolved_by?: ResolvedBy | null;
  /**
   * Number of interceptors registered at emission time (§10.3).
   * @minimum 0
   */
  interceptors_registered: number;
}
