// Copyright (c) Microsoft. All rights reserved.

// approval.schema.json: the approval request and resolution shapes (§9).
// The file has no root type: validators reference its definitions.

import { AgentContext } from "./agent-context";
import { InterceptionPoint } from "./interception-point";
import { AllowVerdict, Decision, DenyVerdict, TransformVerdict } from "./verdict";

/**
 * The liftable deny being consulted: an interceptor's (passes §5,
 * verdict.schema.json) or the host-synthesized §7.5 shape, whose reason is a
 * reserved host_error:* string that §5 forbids interceptors to emit — so this
 * member is validated against the §5 schema only when its reason is not
 * host_error:*.
 */
export interface LiftableDeny {
  decision: Decision.Deny;
  [member: string]: unknown;
}

/**
 * What the host hands the resolver (§9).
 * @additionalProperties false
 */
export interface ApprovalRequest {
  context_identity: string | null;
  interception_point: InterceptionPoint;
  verdict: LiftableDeny;
  /** The AgentContext as presented to the resolver. MAY be redacted per host policy. */
  context?: AgentContext;
}

/** How a consultation ended (§9). */
export enum Outcome {
  Approve = "approve",
  Reject = "reject",
  Unresolved = "unresolved",
}

interface ResolutionBase {
  /**
   * MUST equal the request's context_identity byte for byte (echo rule, §9);
   * null echoes as null.
   */
  context_identity: string | null;
}

/**
 * approve: the resolver lifts the deny with an allow or transform verdict.
 * @additionalProperties false
 */
export interface ApproveResolution extends ResolutionBase {
  outcome: Outcome.Approve;
  verdict: AllowVerdict | TransformVerdict;
}

/**
 * reject: the resolver keeps a deny.
 * @additionalProperties false
 */
export interface RejectResolution extends ResolutionBase {
  outcome: Outcome.Reject;
  verdict: DenyVerdict;
}

/**
 * unresolved: no decision; the deny stands and no verdict is carried.
 * @additionalProperties false
 */
export interface UnresolvedResolution extends ResolutionBase {
  outcome: Outcome.Unresolved;
}

/** What the resolver returns (§9). */
export type ApprovalResolution = ApproveResolution | RejectResolution | UnresolvedResolution;
