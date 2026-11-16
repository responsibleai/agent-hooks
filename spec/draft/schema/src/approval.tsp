// Copyright (c) Microsoft. All rights reserved.

using TypeSpec.JsonSchema;
namespace AgentHooks;

/** A consulted deny may carry a host-synthesized host_error reason. */
model LiftableDeny {
  decision: Decision.Deny;
  ...Record<unknown>;
}

/**
 * What the host hands the resolver (section 9).
 * The public fragment remains approval.schema.json#/$defs/request.
 * [request](../examples/ApprovalRequest/collection-access.json)
 */
@extension("additionalProperties", false)
model request {
  context_identity: string | null;
  interception_point: InterceptionPoint;
  verdict: LiftableDeny;

  /** The context as presented to the resolver; may be redacted. */
  context?: AgentContext;
}

enum Outcome {
  Approve: "approve",
  Reject: "reject",
  Unresolved: "unresolved",
}

model ResolutionBase {
  /** Must echo the request's identity byte for byte; null echoes as null. */
  context_identity: string | null;
}

/**
 * The resolver lifts the deny with an allow.
 * [approve](../examples/ApprovalResolution/approve-allow.json)
 */
@extension("additionalProperties", false)
model ApproveResolution {
  ...ResolutionBase;
  outcome: Outcome.Approve;
  verdict: AllowVerdict;
}

/**
 * The resolver keeps a deny.
 * [reject](../examples/ApprovalResolution/reject.json)
 */
@extension("additionalProperties", false)
model RejectResolution {
  ...ResolutionBase;
  outcome: Outcome.Reject;
  verdict: DenyVerdict;
}

/**
 * No decision; the deny stands and no verdict is carried.
 * [unresolved](../examples/ApprovalResolution/unresolved.json)
 */
@extension("additionalProperties", false)
model UnresolvedResolution {
  ...ResolutionBase;
  outcome: Outcome.Unresolved;
}

/** What the resolver returns; the public fragment keeps this name. */
union resolution {
  ApproveResolution,
  RejectResolution,
  UnresolvedResolution,
}
