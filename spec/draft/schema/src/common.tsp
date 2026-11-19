// Copyright (c) Microsoft. All rights reserved.

using TypeSpec.JsonSchema;
namespace AgentHooks;

/** Enforcement modes (§8). */
enum Mode {
  Enforce: "enforce",
  EvaluateOnly: "evaluate_only",
}

/** Composition profiles (§7.1), in §7.2 table order. */
enum CompositionProfile {
  SequentialFirstDeny: "sequential/first_deny",
  SequentialRunAll: "sequential/run_all",
  ParallelStrictest: "parallel/strictest",
  ParallelUnanimous: "parallel/unanimous",
}

/** Values of the on_approval knob (§7.2). */
enum OnApproval {
  Stop: "stop",
  Resume: "resume",
}

/** Values of the on_disagreement and on_transform_conflict knobs (§7.2). */
enum ConflictResolution {
  Deny: "deny",
  Approval: "approval",
}

/**
 * Namespaced extensions (§4.6): any value under a key that follows the
 * namespace rule.
 */
@extension("propertyNames", #{ pattern: "^[a-z][a-z0-9_]*$" })
model Extensions is Record<unknown>;

/** An open JSON object, not an arbitrary JSON value. */
model JsonObject is Record<unknown>;
