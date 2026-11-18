// Copyright (c) Microsoft. All rights reserved.

using TypeSpec.JsonSchema;
namespace AgentHooks;

/** Presence only; members are stripped by the projection. */
@extension("additionalProperties", false)
model ApprovalPresence {}

/** Warning metadata retained in a payload-free record projection. */
@extension("additionalProperties", false)
model WarningProjection {
  reason?: string;
  message?: string;
}

/**
 * A payload-free projection of the combined verdict (§10.3): transform
 * details are omitted, approval members stripped, messages truncated to
 * 256 UTF-8 bytes.
 * warnings[].reason may carry host_warning:control_failed (§6.3.1, §11.1).
 */
@extension("additionalProperties", false)
model VerdictProjection {
  decision: Decision;
  reason?: string;
  message?: string;
  warnings?: WarningProjection[];
  evidence?: Evidence;
  result_labels?: string[];
  approval?: ApprovalPresence;
}

/**
 * W3C Trace Context identifiers echoed from the context's optional trace block
 * (§4.5, §10.3).
 */
@extension("additionalProperties", false)
model Trace {
  trace_id?: string;
  span_id?: string;
}

/** The host_error reasons a continue posture may substitute for (§6.3.1). */
enum SubstitutedFor {
  InterceptorFailed: "host_error:interceptor_failed",
  InterceptorTimeout: "host_error:interceptor_timeout",
  VerdictInvalid: "host_error:verdict_invalid",
}

/** Payload-free summary of one interceptor's verdict (§10.3). */
@extension("additionalProperties", false)
model VerdictSlot {
  @minValue(0)
  index: integer;

  decision: Decision;
  reason?: string;

  /** Host-chosen payload-free registration identifier for the interceptor at index (§10.3). */
  name?: string;

  /**
   * Present iff this slot's verdict is the allow the host substituted under
   * on_error: continue (§6.3.1): the host_error reason the §6.3 deny would have
   * carried. The entry's decision is allow and reason is absent.
   */
  substituted_for?: SubstitutedFor;
}

/** Consultation outcomes a record names (§7.6). */
enum ResolvedBy {
  Approval: "approval",
  Rejection: "rejection",
}

// Example: [allow](../examples/InterceptionRecord/allow.json)
// Example: [approved transform](../examples/InterceptionRecord/approved-transform.json)
// Example: [continued timeout](../examples/InterceptionRecord/continued-after-timeout.json)
/**
 * Host-side record of one emission (AGENT-HOOKS-0.1 §10.3). Payload-free:
 * identities (when a provider is declared) bind the record to the exact
 * pre/post-composition context; session_id/sequence/decided_by provide ordering
 * and attribution; composition makes the record interpretable without
 * out-of-band host configuration.
 *
 * Two rules relate members and cannot be typed, so they are written as JSON
 * Schema in the allOf extension below and copied through by the emitter: verdicts
 * is REQUIRED under the multi-verdict profiles (§7.4), and the identities are
 * null when identity_provider is null (§10.3).
 */
@summary("Agent Hooks — interception record")
@extension("additionalProperties", false)
@extension(
  "allOf",
  #[
    #{
      `if`: #{
        properties: #{
          composition: #{
            type: "object",
            properties: #{
              profile: #{
                `enum`: #[
                  "sequential/run_all",
                  "parallel/strictest",
                  "parallel/unanimous"
                ],
              },
            },
          },
        },
      },
      then: #{ required: #["verdicts"] },
    },
    #{
      description: "§10.3: identities are null when identity_provider is null.",
      `if`: #{ properties: #{ identity_provider: #{ `const`: null } } },
      then: #{
        properties: #{
          input_identity: #{ `const`: null },
          enforced_identity: #{ `const`: null },
        },
      },
    }
  ]
)
model InterceptionRecord {
  interception_point: InterceptionPoint;
  mode: Mode;
  verdict: VerdictProjection;

  /** Identity provider output on the context before dispatch; null iff identity_provider is null. */
  input_identity: string | null;

  /** Identity provider output after composition completes; null iff identity_provider is null. */
  enforced_identity: string | null;

  /**
   * The declared identity provider (§10.1): "jcs-sha256", a host-defined id
   * (name rules enforced: ^[a-z][a-z0-9_-]*$ and never a jcs prefix), or null
   * (identity-unbound).
   */
  @pattern("^(jcs-sha256|(?!jcs)[a-z][a-z0-9_-]*)$")
  identity_provider: string | null;

  /** ctx.session.id — correlates records across a session. */
  session_id: string;

  /** ctx.sequence — total order of records within the session (§12.2.3). */
  sequence: integer;

  /**
   * OPTIONAL. The context's RFC 3339 timestamp, copied verbatim (§10.3); absent
   * when the context lacked the field.
   */
  timestamp?: string;

  /**
   * OPTIONAL. W3C Trace Context identifiers echoed from the context's optional
   * trace block (§4.5, §10.3); absent when the context carried neither member.
   */
  trace?: Trace;

  /**
   * Registration index of the interceptor whose verdict won aggregation or whose
   * liftable deny was consulted (§7.6); null for a pure-allow combination or a
   * host-synthesized verdict.
   */
  @minValue(0)
  decided_by?: integer | null;

  /** The composition profile and knobs in effect for this emission (§7.1). */
  @extension("additionalProperties", false)
  composition: {
    profile: CompositionProfile;
    on_approval?: OnApproval;
    on_disagreement?: ConflictResolution;
    on_transform_conflict?: ConflictResolution;
  };

  /**
   * Payload-free per-interceptor summary. REQUIRED in multi-verdict profiles
   * (sequential/run_all, parallel/*) and whenever any slot carries
   * substituted_for (§6.3.1); otherwise OPTIONAL in sequential/first_deny.
   */
  verdicts?: VerdictSlot[];

  /**
   * true iff one or more registered interceptors were never invoked in this
   * emission (short-circuit, approval-stop, or a failed fold-transform). Defined
   * for the sequential profiles (§7.4).
   */
  fold_truncated?: boolean;

  /**
   * Consultation outcome (§7.6, §10.3): "approval" iff a permit resolution
   * substituted for a verdict; "rejection" iff the seam was consulted and did not
   * lift the deny; absent iff never consulted.
   */
  resolved_by?: ResolvedBy;

  /** Number of interceptors registered at emission time (§10.3). */
  @minValue(0)
  interceptors_registered: integer;
}
