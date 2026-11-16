// Copyright (c) Microsoft. All rights reserved.

using TypeSpec.JsonSchema;
namespace AgentHooks;

enum Decision {
  Allow: "allow",
  Deny: "deny",
  Transform: "transform",
}

/** A recorded concern that does not affect control flow (section 5.1). */
@extension("additionalProperties", false)
model Warning {
  /** Host error and warning namespaces are reserved for the host. */
  @pattern("^(?!host_error:|host_warning:).*")
  reason?: string | null;

  message?: string | null;
}

/** Named URIs an auditor may consult; hosts must not dereference automatically. */
model VerificationPointers is Record<string>;

/** Offline-verifiable evidence attached to a verdict (section 14). */
@extension("additionalProperties", false)
model Evidence {
  artefact?: string | null;
  verification_pointers?: VerificationPointers;
}

model VerdictBase {
  @pattern("^(?!host_error:).*")
  reason?: string | null;

  message?: string | null;
  warnings?: Warning[] | null;
  evidence?: Evidence;

  /** Labels the host persists with produced data and resurfaces at later hooks. */
  result_labels?: string[] | null;
}

/**
 * Proceed; warnings do not affect control flow.
 * [allow](../examples/Verdict/allow.json)
 * [with warning](../examples/Verdict/allow-with-warning.json)
 * [with evidence](../examples/Verdict/allow-with-evidence.json)
 */
@extension("additionalProperties", false)
model AllowVerdict {
  ...VerdictBase;
  decision: Decision.Allow;
}

/**
 * Stop the action; an approval block makes the deny liftable.
 * [deny](../examples/Verdict/deny.json)
 * [with approval](../examples/Verdict/deny-with-approval.json)
 */
@extension("additionalProperties", false)
model DenyVerdict {
  ...VerdictBase;
  decision: Decision.Deny;
  approval?: JsonObject;
}

/**
 * Proceed with the hook-specific replacement payload.
 * [input](../examples/Verdict/transform-input.json)
 * [messages](../examples/Verdict/transform-messages.json)
 * [output](../examples/Verdict/transform-output.json)
 * [response](../examples/Verdict/transform-response.json)
 * [args](../examples/Verdict/transform-tool-args.json)
 * [value](../examples/Verdict/transform-tool-result.json)
 */
@extension("additionalProperties", false)
model TransformVerdict<TTransform> {
  ...VerdictBase;
  decision: Decision.Transform;
  transform: TTransform;
}

union NonTransformVerdict {
  AllowVerdict,
  DenyVerdict,
}
alias Verdict<TTransform> =
  | AllowVerdict
  | DenyVerdict
  | TransformVerdict<TTransform>;
