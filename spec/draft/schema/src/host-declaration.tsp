// Copyright (c) Microsoft. All rights reserved.

using TypeSpec.JsonSchema;
namespace AgentHooks;

/** Grammar of a registered provider, resolver, redactor or binding id. */
@pattern("^[a-z][a-z0-9_-]{0,63}$")
scalar Reference extends string;

@minValue(1)
@maxValue(3600000)
scalar BoundedTimeoutMs extends integer;

/** A bound in milliseconds; null is unbounded. */
union TimeoutMs {
  BoundedTimeoutMs,
  null,
}

/** Conformance capability vocabulary, with buffering declared separately. */
enum Capability {
  ModelCalls: "model_calls",
  ToolCalls: "tool_calls",
  ParallelToolCalls: "parallel_tool_calls",
  Streaming: "streaming",
  MultiTurn: "multi_turn",
  Int64Json: "int64_json",
  BigintJson: "bigint_json",
  IncrementalOutput: "incremental_output",
  HostDeclaration: "host_declaration",
}

enum ToolSeamHostError {
  Continue: "continue",
  Terminate: "terminate",
}

enum OnError {
  Deny: "deny",
  Continue: "continue",
}

/** Optional and informative; never checked against code. */
@extension("additionalProperties", false)
model Host {
  @pattern("^[a-z0-9_-]{1,64}$")
  name: string;

  @minLength(1)
  @maxLength(64)
  version?: string;
}

/** Unconsulted profile knobs are refused by the loader, never cleared. */
@extension("additionalProperties", false)
model CompositionConfig {
  @extension("default", "sequential/first_deny")
  profile?: CompositionProfile;

  /** Consulted only by sequential/first_deny. */
  on_approval?: OnApproval;

  /** Consulted only by parallel/unanimous. */
  on_disagreement?: ConflictResolution;

  /** Consulted only by parallel/strictest. */
  on_transform_conflict?: ConflictResolution;
}

@extension("additionalProperties", false)
model ApprovalConfig {
  /** Registered resolver, or null to leave liftable denies in force. */
  @pattern("^[a-z][a-z0-9_-]{0,63}$")
  resolver?: string | null;

  @pattern("^[a-z][a-z0-9_-]{0,63}$")
  redactor?: string | null;
}

@extension("additionalProperties", false)
model PostureConfig {
  /** Must equal the posture implemented by the host. */
  @extension("default", "continue")
  tool_seam_host_error?: ToolSeamHostError;
}

@extension("additionalProperties", false)
model TimeoutsConfig {
  /** Default 5000; null explicitly means unbounded. */
  interceptor_ms?: TimeoutMs;

  /** Defaults to interceptor_ms. */
  approval_resolver_ms?: TimeoutMs;
}

@extension("additionalProperties", false)
model RecordsConfig {
  /** Null is unbounded; finite bounds must canonicalize without rounding. */
  @minValue(1)
  @maxValue(9007199254740991)
  max_buffered?: integer | null;
}

@extension("additionalProperties", false)
model FailureConfig {
  /** Document default inherited by each binding. */
  @extension("default", "deny")
  on_error?: OnError;
}

/** Host configuration; omitted members take the specification's defaults. */
@extension("additionalProperties", false)
model Configuration {
  @extension("default", "enforce")
  mode?: Mode;

  composition?: CompositionConfig;

  /** jcs-sha256, a registered non-jcs custom name, or null for unbound identity. */
  @pattern("^(jcs-sha256|(?!jcs)[a-z][a-z0-9_-]{0,63})$")
  identity_provider?: string | null;

  approval?: ApprovalConfig;
  posture?: PostureConfig;
  timeouts?: TimeoutsConfig;
  records?: RecordsConfig;
  failure?: FailureConfig;
}

@extension("additionalProperties", false)
model FirstDenySupport {
  @uniqueItems
  @minItems(1)
  on_approval?: OnApproval[];
}

@extension("additionalProperties", false)
model RunAllSupport {}

@extension("additionalProperties", false)
model StrictestSupport {
  @uniqueItems
  @minItems(1)
  on_transform_conflict?: ConflictResolution[];
}

@extension("additionalProperties", false)
model UnanimousSupport {
  @uniqueItems
  @minItems(1)
  on_disagreement?: ConflictResolution[];
}

/** Only the knobs a profile consults may appear. */
@extension("additionalProperties", false)
model ProfileSupport {
  `sequential/first_deny`?: FirstDenySupport;
  `sequential/run_all`?: RunAllSupport;
  `parallel/strictest`?: StrictestSupport;
  `parallel/unanimous`?: UnanimousSupport;
}

model SurfaceBase {
  /** Lifecycle points form the floor; model/tool points may be omitted in pairs. */
  @uniqueItems
  @minItems(4)
  @maxItems(8)
  interception_points?: InterceptionPoint[];

  @uniqueItems
  capabilities?: Capability[];

  profiles?: ProfileSupport;
}

/** Buffered output is the default; exposure_bound must be absent. */
@extension("additionalProperties", false)
model BufferedSurface {
  ...SurfaceBase;

  @extension("default", true)
  buffered_output?: true;
}

/** Streaming output must explicitly declare its exposure bound. */
@extension("additionalProperties", false)
model UnbufferedSurface {
  ...SurfaceBase;
  buffered_output: false;

  @minLength(1)
  @maxLength(512)
  exposure_bound: string;
}

union Surface {
  BufferedSurface,
  UnbufferedSurface,
}

/** One interceptor binding (section 7.7.4). */
@extension("additionalProperties", false)
model Binding {
  /** Unique within bindings; persisted as the verdict slot's name. */
  id: Reference;

  /** Registry lookup key, never a path, class, module or URL to load. */
  @pattern("^[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_-]*)+$")
  @maxLength(128)
  kind: string;

  /** Kind-specific JSON passed unchanged to its resolver; defaults to {}. */
  config?: unknown;

  /** Defaults to every point in the declared surface. */
  @uniqueItems
  @minItems(1)
  at?: InterceptionPoint[];

  timeout_ms?: TimeoutMs;

  /** Inherits configuration.failure.on_error. */
  on_error?: OnError;
}

/**
 * Host declaration whose spec member selects its format and behavior.
 * Every object is closed except binding config and extension values.
 * The loader checks knob consistency, lifecycle floors and registered names.
 * [document policy](../examples/HostDeclaration/document-policy.json)
 * [default failure posture](../examples/HostDeclaration/default-failure-posture.json)
 * [failure posture](../examples/HostDeclaration/failure-posture.json)
 * [streaming](../examples/HostDeclaration/streaming-document-policy.json)
 */
@summary("Agent Hooks - host declaration document (agent-hooks/draft)")
@extension("additionalProperties", false)
model HostDeclaration {
  configuration?: Configuration;

  /** Required, ordered dispatch list. The loader checks binding id uniqueness. */
  @maxItems(256)
  bindings: Binding[];

  /** Ignored by the loader; kept for editors. */
  $schema?: string;

  spec: "agent-hooks/draft";

  /** Operator label for logs, never stamped on records. */
  @pattern("^[a-z0-9][a-z0-9._-]{0,63}$")
  id?: string;

  host?: Host;

  /** Must be a subset of the host's implemented surface. */
  surface?: Surface;

  extensions?: Extensions;
}
