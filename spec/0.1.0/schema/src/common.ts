// Copyright (c) Microsoft. All rights reserved.

// Values that more than one schema states and that must agree between them.
// String enums keep their declaration order in the generated enum lists;
// a union of string literals would be alphabetised.

/** Enforcement modes (§8). */
export enum Mode {
  Enforce = "enforce",
  EvaluateOnly = "evaluate_only",
}

/** Composition profiles (§7.1), in §7.2 table order. */
export enum CompositionProfile {
  SequentialFirstDeny = "sequential/first_deny",
  SequentialRunAll = "sequential/run_all",
  ParallelStrictest = "parallel/strictest",
  ParallelUnanimous = "parallel/unanimous",
}

/** Values of the on_approval knob (§7.2). */
export enum OnApproval {
  Stop = "stop",
  Resume = "resume",
}

/** Values of the on_disagreement and on_transform_conflict knobs (§7.2). */
export enum ConflictResolution {
  Deny = "deny",
  Approval = "approval",
}

/**
 * Namespaced extensions (§4.6): any value under a key that follows the
 * namespace rule.
 * @propertyNames {"pattern": "^[a-z][a-z0-9_]*$"}
 */
export interface Extensions {
  [key: string]: unknown;
}
