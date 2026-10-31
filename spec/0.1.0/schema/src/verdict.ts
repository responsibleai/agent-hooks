// Copyright (c) Microsoft. All rights reserved.

// verdict.schema.json: the interceptor return value (§5).

/** The three decisions (§5). */
export enum Decision {
  Allow = "allow",
  Deny = "deny",
  Transform = "transform",
}

/**
 * A recorded concern that does not affect control flow (§5.1).
 * @additionalProperties false
 */
export interface Warning {
  /**
   * Interceptor-supplied warning identifier. The host_error: prefix is reserved
   * for host-synthesized failures (§11) and host_warning: for host-synthesized
   * warnings (§11.1); an interceptor warning with either prefix fails §5
   * validation.
   * @pattern ^(?!host_error:|host_warning:).*
   */
  reason?: string | null;
  message?: string | null;
}

/**
 * The transform body (§5.2).
 * @additionalProperties false
 */
export interface Transform {
  /**
   * JSONPath rooted at $target (§5.2). $policy_target is a deprecated alias
   * accepted through agent-hooks v0.2.
   * @pattern ^\$(target|policy_target)(\.|\[|$)
   */
  path: string;
  /** Any JSON value, including null. An absent member is equivalent to null (§5.2). */
  value?: unknown;
}

/** Named URIs an auditor MAY consult. Hosts MUST NOT dereference automatically (§14). */
export interface VerificationPointers {
  [name: string]: string;
}

/**
 * Offline-verifiable evidence attached to a verdict (§14).
 * @additionalProperties false
 */
export interface Evidence {
  /** Content address (sha256:<hex>) or URI of an offline-verifiable proof. */
  artefact?: string | null;
  verification_pointers?: VerificationPointers;
}

/** Members every decision may carry. */
interface VerdictBase {
  /**
   * Interceptor-supplied machine identifier. The host_error: prefix is reserved
   * for host-synthesized failures (§11).
   * @pattern ^(?!host_error:).*
   */
  reason?: string | null;
  /** Human-readable text for the caller. */
  message?: string | null;
  /**
   * Recorded concerns that do not affect control flow (§5.1). Permitted on any
   * decision; unioned across an emission's verdicts (§7.3). Reasons starting with
   * host_warning: are reserved for the host (§11.1).
   */
  warnings?: Warning[] | null;
  evidence?: Evidence;
  /**
   * Interceptor-supplied labels the host MUST persist with the produced data and
   * resurface on later interception points (§5.4).
   */
  result_labels?: string[] | null;
}

/**
 * allow: proceed. Absorbs warn through warnings[] (§5.1).
 * @additionalProperties false
 */
export interface AllowVerdict extends VerdictBase {
  decision: Decision.Allow;
}

/**
 * deny: stop the action. Absorbs escalate through the approval block (§5.1).
 * @additionalProperties false
 */
export interface DenyVerdict extends VerdictBase {
  decision: Decision.Deny;
  /**
   * Present only on deny: marks the deny as liftable by the approval seam (§9).
   * MAY be empty; reserved for approver-facing parameters.
   */
  approval?: object;
}

/**
 * transform: proceed with the target rewritten. The transform body is REQUIRED
 * (§5).
 * @additionalProperties false
 */
export interface TransformVerdict extends VerdictBase {
  decision: Decision.Transform;
  transform: Transform;
}

/**
 * Interceptor return value (AGENT-HOOKS-0.1 §5). Three decisions: allow (absorbs
 * warn via warnings[]), deny (absorbs escalate via the approval block), transform.
 * A verdict carries decision content only; composition is host configuration
 * (§7.1).
 * @title Agent Hooks — verdict
 */
export type Verdict = AllowVerdict | DenyVerdict | TransformVerdict;
