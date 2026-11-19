// Copyright (c) Microsoft. All rights reserved.

namespace AgentHooks;

/** The three decisions (§5). */
enum Decision {
  Allow: "allow",
  Deny: "deny",
  Transform: "transform",
}

/** A recorded concern that does not affect control flow (§5.1). */
model Warning {
  ...Record<never>;

  /**
   * Interceptor-supplied warning identifier. The host_error: prefix is reserved
   * for host-synthesized failures (§11) and host_warning: for host-synthesized
   * warnings (§11.1); an interceptor warning with either prefix fails §5
   * validation.
   */
  @pattern("^(?!host_error:|host_warning:).*")
  reason?: string | null;

  message?: string | null;
}

/** Named URIs an auditor MAY consult. Hosts MUST NOT dereference automatically (§14). */
model VerificationPointers is Record<string>;

/** Offline-verifiable evidence attached to a verdict (§14). */
model Evidence {
  ...Record<never>;

  /** Content address (sha256:<hex>) or URI of an offline-verifiable proof. */
  artefact?: string | null;

  verification_pointers?: VerificationPointers;
}

/** Members every decision may carry. */
model VerdictBase {
  /**
   * Interceptor-supplied machine identifier. The host_error: prefix is reserved
   * for host-synthesized failures (§11).
   */
  @pattern("^(?!host_error:).*")
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

// Example: [allow](../examples/Verdict/allow.json)
// Example: [with warning](../examples/Verdict/allow-with-warning.json)
// Example: [with evidence](../examples/Verdict/allow-with-evidence.json)
/** allow: proceed. Absorbs warn through warnings[] (§5.1). */
model AllowVerdict {
  ...Record<never>;
  ...VerdictBase;
  decision: Decision.Allow;
}

// Example: [deny](../examples/Verdict/deny.json)
// Example: [with approval](../examples/Verdict/deny-with-approval.json)
/** deny: stop the action. Absorbs escalate through the approval block (§5.1). */
model DenyVerdict {
  ...Record<never>;
  ...VerdictBase;
  decision: Decision.Deny;

  /**
   * Present only on deny: marks the deny as liftable by the approval seam (§9).
   * MAY be empty; reserved for approver-facing parameters.
   */
  approval?: JsonObject;
}

// Example: [input](../examples/Verdict/transform-input.json)
// Example: [messages](../examples/Verdict/transform-messages.json)
// Example: [output](../examples/Verdict/transform-output.json)
// Example: [response](../examples/Verdict/transform-response.json)
// Example: [args](../examples/Verdict/transform-tool-args.json)
// Example: [value](../examples/Verdict/transform-tool-result.json)
/** transform: proceed with the hook-specific replacement payload. */
model TransformVerdict<TTransform> {
  ...Record<never>;
  ...VerdictBase;
  decision: Decision.Transform;
  transform: TTransform;
}

/** Verdict choices for hooks that do not support transforms. */
union NonTransformVerdict {
  AllowVerdict,
  DenyVerdict,
}
/**
 * Interceptor return value (AGENT-HOOKS-0.1 §5). Three decisions: allow (absorbs
 * warn via warnings[]), deny (absorbs escalate via the approval block), transform.
 * A verdict carries decision content only; composition is host configuration
 * (§7.1).
 */
alias Verdict<TTransform> =
  | AllowVerdict
  | DenyVerdict
  | TransformVerdict<TTransform>;
