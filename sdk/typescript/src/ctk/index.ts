// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
/**
 * Conformance Test Kit (§13.2).
 *
 * The assertion engine and scripted interceptor/resolver live in the
 * Rust core; this module defines the `Harness` interface framework
 * adapters implement, plus the runner and reference harness that use it.
 */

import type {
  ApprovalResolver,
  CompositionConfig,
  EnforcementMode,
  Interceptor,
  JsonValue,
} from "../index";

export { loadVectors, runVector, runVectors, VectorResult } from "./runner";
export { ReferenceHarness } from "./reference";

/** Host-declared capability subset (§3.2). */
export type Capability =
  | "model_calls"
  | "tool_calls"
  | "parallel_tool_calls"
  | "streaming"
  | "multi_turn";

export type RunOutcome = "completed" | "blocked" | "suspended" | "error";

/** Hermetic scripted run loaded from a CTK vector (wire-shaped). */
export interface Scenario {
  input: { content: JsonValue; role: "user" | "system" | "external" };
  tools?: Array<{
    name: string;
    schema?: Record<string, JsonValue>;
    behavior: Array<{ when_args?: Record<string, JsonValue>; return: JsonValue; is_error?: boolean }>;
  }>;
  model_script?: Array<{
    respond: {
      content: JsonValue;
      tool_calls: Array<{ id: string; name: string; args: Record<string, JsonValue> }>;
      finish_reason: string;
    };
  }>;
}

/** What `Harness.run` returns to the CTK runner. */
export interface RunRecord {
  outcome: RunOutcome;
  final_output: JsonValue | null;
  tool_invocations: Array<{ name: string; args: Record<string, JsonValue> }>;
  error?: string;
  /** `(input_identity, enforced_identity)` per interception, in order,
   * from the harness's emitter (`null` under a `null` identity
   * provider, §10.1). Enables `expect.identities_equal`. */
  identities: Array<[string | null, string | null]>;
  /** Wire-shaped `InterceptionRecord`s (§10.3), one per emission, in
   * order. Enables `expect.records` assertions. */
  records: JsonValue[];
}

/** The single interface a framework adapter implements for the CTK. */
export interface Harness {
  readonly name: string;
  readonly capabilities: ReadonlySet<Capability>;

  /** Declared §6.2 posture at the tool seam (§13.1): what the host does
   * with the run after a `host_error:*` deny at
   * `pre_tool_call`/`post_tool_call`. `"continue"` (the default —
   * surface a tool error to the model and keep the loop going) or
   * `"terminate"` (the host's own semantics terminate the turn, which
   * §6.2 explicitly permits). The runner forwards this declaration so
   * `expect.run_outcome_by_posture` vectors resolve to the single
   * outcome this surface must produce. */
  readonly toolSeamHostError?: "continue" | "terminate";

  /** Wire the scenario's mock model + tools into the framework,
   * register the interceptors and resolver, set the enforcement mode,
   * the vector's composition profile (§7.1), and its identity provider
   * (§10.1; vectors declare `"jcs-sha256"` or `null` — custom providers
   * are functions and not vector-expressible). When
   * `redactForApproval` is non-empty the harness MUST register a §9
   * approval redactor that replaces each listed §5.2 path in the
   * request context's target with the string `"[redacted]"`
   * (write-back mirrored per §4.3), leaving unresolvable paths
   * untouched. */
  setup(
    scenario: Scenario,
    interceptors: Interceptor[],
    resolver: ApprovalResolver | null,
    mode: EnforcementMode,
    composition: CompositionConfig,
    identityProvider: 'jcs-sha256' | 'ctk-fault' | null,
    redactForApproval?: string[],
  ): void;

  run(): Promise<RunRecord>;

  teardown(): void;
}
