// Copyright (c) Microsoft. All rights reserved.

using TypeSpec.JsonSchema;
namespace AgentHooks;

/** Enforcement modes (section 8). */
enum Mode {
  Enforce: "enforce",
  EvaluateOnly: "evaluate_only",
}

/** Composition profiles (section 7.1). */
enum CompositionProfile {
  SequentialFirstDeny: "sequential/first_deny",
  SequentialRunAll: "sequential/run_all",
  ParallelStrictest: "parallel/strictest",
  ParallelUnanimous: "parallel/unanimous",
}

/** Values of the on_approval knob (section 7.2). */
enum OnApproval {
  Stop: "stop",
  Resume: "resume",
}

/** Values of the on_disagreement and on_transform_conflict knobs. */
enum ConflictResolution {
  Deny: "deny",
  Approval: "approval",
}

/** Namespaced extensions (section 4.6); values are unconstrained JSON. */
@extension("propertyNames", #{ pattern: "^[a-z][a-z0-9_]*$" })
model Extensions is Record<unknown>;

/** An open JSON object, not an arbitrary JSON value. */
model JsonObject {}
