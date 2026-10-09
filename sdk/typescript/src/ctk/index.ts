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
  HostRegistry,
  HostSurface,
  Interceptor,
  JsonValue,
} from "../index";

export { loadVectors, runVector, runVectors, VectorResult, builderFromValue, provePaths } from "./runner";
export { ReferenceHarness, REFERENCE_DECLARATION } from "./reference";

/** Host-declared capability subset (§3.2, §13.1): the closed list of
 * `conformance/vectors.schema.json` with `host_declaration` (§7.7.9).
 * `buffered_output` is a value, not a presence, and is not listed. */
export type Capability =
  | "model_calls"
  | "tool_calls"
  | "parallel_tool_calls"
  | "streaming"
  | "multi_turn"
  | "int64_json"
  | "bigint_json"
  | "incremental_output"
  | "host_declaration";

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

/** What loading the vector's host declaration produced (§7.7.9), as
 * the runner records it. */
export interface LoadRecord {
  outcome: "accepted" | "refused";
  /** The `declaration_error:*` code on refusal. */
  class?: string;
  /** Whether the value, JSON, file and builder paths resolved to one
   * canonical form (or refused with one class). */
  paths_equivalent?: boolean;
  detail?: string;
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
  /** Set by the runner for vectors carrying `host_declaration`
   * (§7.7.9); a harness never fills it. */
  load?: LoadRecord;
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

  /** The code surface (§7.7.4) a declaration is resolved against. When
   * absent the runner derives it from `capabilities` and
   * `toolSeamHostError` (`HostSurface.fromCapabilities`): the §3.2
   * floor plus the model points iff `model_calls` plus the tool points
   * iff `tool_calls`, every profile with every knob value. A host
   * declaring `incremental_output` implements this to add its exposure
   * bound; the derived surface alone is refused for such a host. */
  hostSurface?(): HostSurface;

  /** The host's own declaration document (§7.7.9), when it has one.
   * The runner resolves it against the code surface and reads the
   * capabilities and posture a run is assessed against from the
   * resolved form, so what the CTK ran against is what a claim cites.
   * Absent keeps the code-declared surface. */
  declaration?(): JsonValue | undefined;

  /** Wire one declaration vector (§7.7.9): the harness MUST build its
   * emitter from `document` and `registry` through the loader
   * (`InterceptionEmitter.fromDeclarationValue`) and let the
   * `DeclarationError` propagate, never fall back to the field-based
   * `setup`. The document and the registry carry the interceptors,
   * resolver, composition and identity provider. Only harnesses
   * declaring the `host_declaration` capability receive this call. */
  setupDeclared?(scenario: Scenario, document: JsonValue, registry: HostRegistry): void;
}
