// Copyright (c) Microsoft. All rights reserved.

// host-declaration-<version>.schema.json: the host declaration document (§7.7).
// 1.1 extends 1.0 with the two failure-posture members (§6.3.1), so the two
// contract versions cannot drift apart.

import { CompositionProfile, ConflictResolution, Extensions, Mode, OnApproval } from "./common";
import { InterceptionPoint } from "./interception-point";

/**
 * Grammar of a registered name: provider, resolver, redactor or binding id.
 * @pattern ^[a-z][a-z0-9_-]{0,63}$
 */
export type Reference = string;

/**
 * A bound in milliseconds; null is unbounded.
 * @minimum 1
 * @maximum 3600000
 */
export type TimeoutMs = number | null;

/**
 * The conformance capability vocabulary (§13.1, conformance/vectors.schema.json)
 * less buffered_output, which is the boolean surface member, plus
 * host_declaration.
 */
export enum Capability {
  ModelCalls = "model_calls",
  ToolCalls = "tool_calls",
  ParallelToolCalls = "parallel_tool_calls",
  Streaming = "streaming",
  MultiTurn = "multi_turn",
  Int64Json = "int64_json",
  BigintJson = "bigint_json",
  IncrementalOutput = "incremental_output",
  HostDeclaration = "host_declaration",
}

/** The tool-seam posture a host implements (§13.1). */
export enum ToolSeamHostError {
  Continue = "continue",
  Terminate = "terminate",
}

/** The failure posture (§6.3.1). */
export enum OnError {
  Deny = "deny",
  Continue = "continue",
}

/**
 * OPTIONAL and informative; never checked against code.
 * @additionalProperties false
 */
export interface Host {
  /**
   * Same grammar as agent.framework (§4.1).
   * @pattern ^[a-z0-9_-]{1,64}$
   */
  name: string;
  /**
   * @minLength 1
   * @maxLength 64
   */
  version?: string;
}

/**
 * §7.2. A knob the declared profile does not consult is refused, never cleared;
 * a consulted knob left unset takes the §7.2 default.
 * @additionalProperties false
 */
export interface CompositionConfig {
  /** @default "sequential/first_deny" */
  profile?: CompositionProfile;
  /** Consulted by sequential/first_deny only; refused under any other profile (§7.7.3). */
  on_approval?: OnApproval;
  /** Consulted by parallel/unanimous only. */
  on_disagreement?: ConflictResolution;
  /** Consulted by parallel/strictest only. */
  on_transform_conflict?: ConflictResolution;
}

/** @additionalProperties false */
export interface ApprovalConfig {
  /**
   * §9. A registered approval resolver by reference, or null: liftable denies
   * stay denies.
   * @pattern ^[a-z][a-z0-9_-]{0,63}$
   */
  resolver?: string | null;
  /**
   * §9 redaction seam. A registered approval redactor by reference, or null.
   * @pattern ^[a-z][a-z0-9_-]{0,63}$
   */
  redactor?: string | null;
}

/** @additionalProperties false */
export interface PostureConfig {
  /**
   * §13.1. Must equal the posture the host's code implements.
   * @default "continue"
   */
  tool_seam_host_error?: ToolSeamHostError;
}

/** @additionalProperties false */
export interface TimeoutsConfig {
  /** §7 interceptor bound; default 5000. null means unbounded and must be written out. */
  interceptor_ms?: TimeoutMs;
  /** §9 resolver bound; defaults to the value of interceptor_ms. */
  approval_resolver_ms?: TimeoutMs;
}

/** @additionalProperties false */
export interface RecordsConfig {
  /**
   * In-memory record buffer bound; null (the default) is unbounded. The maximum
   * is 2^53 - 1 so the resolved document always canonicalises (§4.4).
   * @minimum 1
   * @maximum 9007199254740991
   */
  max_buffered?: number | null;
}

/** @additionalProperties false */
export interface FailureConfig {
  /**
   * §6.3.1. The document default every binding's on_error inherits. deny keeps
   * the §6.3 substituted deny; continue substitutes an allow carrying
   * host_warning:control_failed and records the cause in substituted_for.
   * Since 1.1.
   * @default "deny"
   */
  on_error?: OnError;
}

/**
 * Host configuration (§7.1). Every member is OPTIONAL; defaults are the values
 * the specification already names and fail closed.
 * @additionalProperties false
 */
export interface Configuration10 {
  /**
   * §8.
   * @default "enforce"
   */
  mode?: Mode;
  composition?: CompositionConfig;
  /**
   * §10.1: "jcs-sha256" (the default), a registered custom provider name
   * (^[a-z][a-z0-9_-]{0,63}$, never a jcs prefix), or null (identity-unbound).
   * @pattern ^(jcs-sha256|(?!jcs)[a-z][a-z0-9_-]{0,63})$
   */
  identity_provider?: string | null;
  approval?: ApprovalConfig;
  posture?: PostureConfig;
  timeouts?: TimeoutsConfig;
  records?: RecordsConfig;
}

/**
 * Host configuration (§7.1). Every member is OPTIONAL; defaults are the values
 * the specification already names and fail closed. 1.1 adds failure.
 * @additionalProperties false
 */
export interface Configuration11 extends Configuration10 {
  failure?: FailureConfig;
}

/** @additionalProperties false */
export interface FirstDenySupport {
  /**
   * @uniqueItems true
   * @minItems 1
   */
  on_approval?: OnApproval[];
}

/** @additionalProperties false */
export interface RunAllSupport {}

/** @additionalProperties false */
export interface StrictestSupport {
  /**
   * @uniqueItems true
   * @minItems 1
   */
  on_transform_conflict?: ConflictResolution[];
}

/** @additionalProperties false */
export interface UnanimousSupport {
  /**
   * @uniqueItems true
   * @minItems 1
   */
  on_disagreement?: ConflictResolution[];
}

/**
 * Profiles and the knob values supported under each (§13.1). Only the knobs a
 * profile consults may appear; an absent knob member means the §7.2 default
 * value only.
 * @additionalProperties false
 */
export interface ProfileSupport {
  "sequential/first_deny"?: FirstDenySupport;
  "sequential/run_all"?: RunAllSupport;
  "parallel/strictest"?: StrictestSupport;
  "parallel/unanimous"?: UnanimousSupport;
}

interface SurfaceBase {
  /**
   * Points the host emits; always includes agent_startup, input, output and
   * agent_shutdown (§3.2), and omits the model or tool points only in pairs.
   * @uniqueItems true
   * @minItems 4
   * @maxItems 8
   */
  interception_points?: InterceptionPoint[];
  /** @uniqueItems true */
  capabilities?: Capability[];
  profiles?: ProfileSupport;
  /**
   * Contract versions the host accepts (§7.7.2); includes the document's own.
   * Each item matches ^agent-hooks-declaration/[0-9]+\.[0-9]+$, written in the
   * allOf tag of the two surface variants.
   * @uniqueItems true
   * @minItems 1
   */
  declaration_versions?: string[];
}

/**
 * The surface of a host that buffers output (§12.1a), the default:
 * exposure_bound is absent.
 * The allOf tag carries the item grammar of declaration_versions, which the
 * generator cannot place on array items from a type alias.
 * @allOf [{"properties": {"declaration_versions": {"type": "array", "items": {"type": "string", "pattern": "^agent-hooks-declaration/[0-9]+\\.[0-9]+$"}}}}]
 * @additionalProperties false
 */
export interface BufferedSurface extends SurfaceBase {
  /**
   * §12.1a. false must be declared explicitly and requires exposure_bound.
   * @default true
   */
  buffered_output?: true;
}

/**
 * The surface of a host that streams output (§12.1a): buffered_output is
 * written as false and exposure_bound is present.
 * The allOf tag carries the item grammar of declaration_versions, which the
 * generator cannot place on array items from a type alias.
 * @allOf [{"properties": {"declaration_versions": {"type": "array", "items": {"type": "string", "pattern": "^agent-hooks-declaration/[0-9]+\\.[0-9]+$"}}}}]
 * @additionalProperties false
 */
export interface UnbufferedSurface extends SurfaceBase {
  /** §12.1a. false must be declared explicitly and requires exposure_bound. */
  buffered_output: false;
  /**
   * §12.1a. Present iff buffered_output is false.
   * @minLength 1
   * @maxLength 512
   */
  exposure_bound: string;
}

/** The declared surface (§13.1) in file form, by output posture. */
export type Surface = BufferedSurface | UnbufferedSurface;

/**
 * One interceptor binding (§7.7.4).
 * @additionalProperties false
 */
export interface Binding10 {
  /** Unique in the array; stamped on verdicts[].name (§10.3). */
  id: Reference;
  /**
   * A lookup key into the host's kind registry and nothing more: never a path,
   * class name, URL or module the loader interprets. At least one dot, so every
   * kind carries a namespace the host controls. The first segments agent_hooks
   * and ctk are reserved. This specification defines no kinds.
   * @pattern ^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$
   * @maxLength 128
   */
  kind: string;
  /**
   * Kind-specific; handed to the kind resolver unchanged. The loader interprets
   * none of it; its one check here is the document-wide integer bound of §7.7.6
   * (no integer token above 2^53 - 1, so the resolved form canonicalises).
   * Default {}.
   */
  config?: unknown;
  /**
   * Points this binding runs at, each in the surface. Default: every surface
   * point.
   * @uniqueItems true
   * @minItems 1
   */
  at?: InterceptionPoint[];
  /** Per-binding bound. Default: configuration.timeouts.interceptor_ms; null is unbounded. */
  timeout_ms?: TimeoutMs;
}

/**
 * One interceptor binding (§7.7.4). 1.1 adds on_error.
 * @additionalProperties false
 */
export interface Binding11 extends Binding10 {
  /**
   * §6.3.1 failure posture for this binding: what the host does when the
   * interceptor raises, times out or returns an invalid verdict. Default:
   * configuration.failure.on_error. Since 1.1.
   */
  on_error?: OnError;
}

interface HostDeclarationBase {
  /** Ignored by the loader; kept for editors. */
  $schema?: string;
  /**
   * OPTIONAL. The wire version the document was written for; the loader's
   * major, and a minor no greater than the loader's. Defaults to the loader's
   * SPEC_VERSION.
   * @pattern ^agent-hooks/[0-9]+\.[0-9]+$
   */
  spec?: string;
  /**
   * OPTIONAL. An operator label for logs. Never stamped on records.
   * @pattern ^[a-z0-9][a-z0-9._-]{0,63}$
   */
  id?: string;
  host?: Host;
  /**
   * The declared surface (§13.1) in file form. OPTIONAL: when absent the host's
   * own code surface applies. Every stated member must be a subset of what the
   * host's code reports; a document a conformance claim cites carries this block
   * explicitly.
   */
  surface?: Surface;
  /**
   * Host-specific extras, kept verbatim and never read by the loader. Keys
   * follow the §4.6 namespace rule; the §4.6 reserved namespaces apply.
   */
  extensions?: Extensions;
}

/**
 * A host declaration document (AGENT-HOOKS-0.1 §7.7): one JSON object that
 * fixes a host's configuration (§7.1, §8, §10.1, §13.1), its declared surface
 * (§13.1) and its interceptor bindings. The document is a versioned contract of
 * its own, separate from the wire version agent-hooks/0.1 and from package
 * versions; this file describes agent-hooks-declaration/1.0. Every object is
 * closed except bindings[].config and the values under extensions. This schema
 * is self-contained so a settings validator can use it alone. Rules it cannot
 * express (knob consistency, the §3.2 floor, surface against the host's code,
 * registered names) live in the loader (§7.7.6).
 * @title Agent Hooks — host declaration document (agent-hooks-declaration/1.0)
 * @additionalProperties false
 */
export interface HostDeclaration10 extends HostDeclarationBase {
  /**
   * The declaration contract version (§7.7.2). A loader refuses any value
   * outside the set it accepts with declaration_error:version_unsupported.
   * Major 0 is reserved for the conformance kit.
   */
  declaration: "agent-hooks-declaration/1.0";
  configuration?: Configuration10;
  /**
   * Ordered: array order is dispatch order. REQUIRED, so an empty-deny host
   * (zero bindings) is written down rather than arrived at by omission. Binding
   * ids are unique.
   * @maxItems 256
   */
  bindings: Binding10[];
}

/**
 * A host declaration document (AGENT-HOOKS-0.1 §7.7): one JSON object that
 * fixes a host's configuration (§7.1, §8, §10.1, §13.1), its declared surface
 * (§13.1) and its interceptor bindings. The document is a versioned contract of
 * its own, separate from the wire version agent-hooks/0.1 and from package
 * versions; this file describes agent-hooks-declaration/1.1. 1.1 adds two
 * OPTIONAL members over 1.0: configuration.failure.on_error, the document
 * default failure posture, and bindings[].on_error, the per-binding posture
 * (§6.3.1); a document that uses neither means the same under both versions. A
 * 1.0 document validates against host-declaration-1.0.schema.json. Every object
 * is closed except bindings[].config and the values under extensions. This
 * schema is self-contained so a settings validator can use it alone. Rules it
 * cannot express (knob consistency, the §3.2 floor, surface against the host's
 * code, registered names) live in the loader (§7.7.6).
 * @title Agent Hooks — host declaration document (agent-hooks-declaration/1.1)
 * @additionalProperties false
 */
export interface HostDeclaration11 extends HostDeclarationBase {
  /**
   * The declaration contract version (§7.7.2). A loader refuses any value
   * outside the set it accepts with declaration_error:version_unsupported.
   * Major 0 is reserved for the conformance kit.
   */
  declaration: "agent-hooks-declaration/1.1";
  configuration?: Configuration11;
  /**
   * Ordered: array order is dispatch order. REQUIRED, so an empty-deny host
   * (zero bindings) is written down rather than arrived at by omission. Binding
   * ids are unique.
   * @maxItems 256
   */
  bindings: Binding11[];
}
