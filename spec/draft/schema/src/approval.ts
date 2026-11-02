// Copyright (c) Microsoft. All rights reserved.

// approval.schema.json: the approval request and resolution shapes (§9).
// Validators reference its definitions by pointer, including #/$defs/request
// and #/$defs/resolution. The latter is materialized from DefaultResolution
// because JSON Schema cannot encode a TypeScript generic.

import { AgentContext } from "./agent-context";
import {
  InputHookTransform,
  OutputHookTransform,
  PostModelHookTransform,
  PostToolHookTransform,
  PreModelHookTransform,
  PreToolHookTransform,
} from "./hook-responses";
import { InterceptionPoint } from "./interception-point";
import { AllowVerdict, Decision, DenyVerdict, Transform, TransformVerdict } from "./verdict";

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
 * @example [collection-access.json](../examples/ApprovalRequest/collection-access.json)
 */
export interface request {
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
 * @example [approve-allow.json](../examples/ApprovalResolution/approve-allow.json)
 * @example [approve-transform.json](../examples/ApprovalResolution/approve-transform.json)
 */
export interface ApproveResolution<TTransform = Transform> extends ResolutionBase {
  outcome: Outcome.Approve;
  verdict: AllowVerdict | TransformVerdict<TTransform>;
}

/** Lifecycle approval can lift a deny only with an allow verdict. */
export interface NonTransformApproveResolution extends ResolutionBase {
  outcome: Outcome.Approve;
  verdict: AllowVerdict;
}

/**
 * reject: the resolver keeps a deny.
 * @additionalProperties false
 * @example [reject.json](../examples/ApprovalResolution/reject.json)
 */
export interface RejectResolution extends ResolutionBase {
  outcome: Outcome.Reject;
  verdict: DenyVerdict;
}

/**
 * unresolved: no decision; the deny stands and no verdict is carried.
 * @additionalProperties false
 * @example [unresolved.json](../examples/ApprovalResolution/unresolved.json)
 */
export interface UnresolvedResolution extends ResolutionBase {
  outcome: Outcome.Unresolved;
}

/** What the resolver returns (§9). */
export type resolution<TTransform = Transform> =
  | ApproveResolution<TTransform>
  | RejectResolution
  | UnresolvedResolution;

/** Concrete schema representation of the generic union's legacy default. */
export type DefaultResolution = resolution<Transform>;

export type NonTransformResolution =
  | NonTransformApproveResolution
  | RejectResolution
  | UnresolvedResolution;

export type AgentStartupResolution = NonTransformResolution;
export type InputResolution = resolution<InputHookTransform>;
export type PreModelResolution = resolution<PreModelHookTransform>;
export type PostModelResolution = resolution<PostModelHookTransform>;
export type PreToolResolution = resolution<PreToolHookTransform>;
export type PostToolResolution = resolution<PostToolHookTransform>;
export type OutputResolution = resolution<OutputHookTransform>;
export type AgentShutdownResolution = NonTransformResolution;
