// Copyright (c) Microsoft. All rights reserved.

namespace AgentHooks;

/**
 * The liftable deny being consulted: an interceptor's (passes §5,
 * verdict.schema.json) or the host-synthesized §7.5 shape, whose reason is a
 * reserved host_error:* string that §5 forbids interceptors to emit — so this
 * member is validated against the §5 schema only when its reason is not
 * host_error:*.
 */
model LiftableDeny {
  decision: Decision.Deny;
  ...Record<unknown>;
}

// Example: [request](../examples/ApprovalRequest/collection-access.json)
/** What the host hands the resolver (§9). */
model request {
  ...Record<never>;
  context_identity: string | null;
  interception_point: InterceptionPoint;
  verdict: LiftableDeny;

  /** The AgentContext as presented to the resolver. MAY be redacted per host policy. */
  context?: AgentContext;
}

/** How a consultation ended (§9). */
enum Outcome {
  Approve: "approve",
  Reject: "reject",
  Unresolved: "unresolved",
}

model ResolutionBase {
  /**
   * MUST equal the request's context_identity byte for byte (echo rule, §9);
   * null echoes as null.
   */
  context_identity: string | null;
}

// Example: [approve](../examples/ApprovalResolution/approve-allow.json)
/** approve: the resolver lifts the deny with an allow verdict. */
model ApproveResolution {
  ...Record<never>;
  ...ResolutionBase;
  outcome: Outcome.Approve;
  verdict: AllowVerdict;
}

// Example: [reject](../examples/ApprovalResolution/reject.json)
/** reject: the resolver keeps a deny. */
model RejectResolution {
  ...Record<never>;
  ...ResolutionBase;
  outcome: Outcome.Reject;
  verdict: DenyVerdict;
}

// Example: [unresolved](../examples/ApprovalResolution/unresolved.json)
/** unresolved: no decision; the deny stands and no verdict is carried. */
model UnresolvedResolution {
  ...Record<never>;
  ...ResolutionBase;
  outcome: Outcome.Unresolved;
}

/** What the resolver returns (§9). */
union resolution {
  ApproveResolution,
  RejectResolution,
  UnresolvedResolution,
}
