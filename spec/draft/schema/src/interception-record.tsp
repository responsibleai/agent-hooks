// Copyright (c) Microsoft. All rights reserved.

using TypeSpec.JsonSchema;
namespace AgentHooks;

/** Presence only; members are stripped by the record projection. */
@extension("additionalProperties", false)
model ApprovalPresence {}

/** Warning metadata retained in a payload-free record projection. */
@extension("additionalProperties", false)
model WarningProjection {
  reason?: string | null;
  message?: string | null;
}

/**
 * Payload-free combined verdict: transforms are omitted, approval members
 * stripped, and messages truncated to 256 UTF-8 bytes by the runtime.
 * Warning reasons may carry host_warning:control_failed.
 */
@extension("additionalProperties", false)
model VerdictProjection {
  decision: Decision;
  reason?: string | null;
  message?: string | null;
  warnings?: WarningProjection[] | null;
  evidence?: Evidence;
  result_labels?: string[] | null;
  approval?: ApprovalPresence;
}

/** W3C Trace Context identifiers echoed from the context. */
@extension("additionalProperties", false)
model Trace {
  trace_id?: string;
  span_id?: string;
}

enum SubstitutedFor {
  InterceptorFailed: "host_error:interceptor_failed",
  InterceptorTimeout: "host_error:interceptor_timeout",
  VerdictInvalid: "host_error:verdict_invalid",
}

/** Payload-free summary of one interceptor's verdict (section 10.3). */
@extension("additionalProperties", false)
model VerdictSlot {
  @minValue(0)
  index: integer;

  decision: Decision;
  reason?: string | null;

  /** Host-chosen, payload-free registration identifier. */
  name?: string;

  /** Failure replaced with an allow by on_error: continue. */
  substituted_for?: SubstitutedFor;
}

enum ResolvedBy {
  Approval: "approval",
  Rejection: "rejection",
}

/**
 * Host-side, payload-free record of one emission (section 10.3).
 * Conditional JSON Schema keywords express relationships between members.
 * [allow](../examples/InterceptionRecord/allow.json)
 * [approved transform](../examples/InterceptionRecord/approved-transform.json)
 * [continued timeout](../examples/InterceptionRecord/continued-after-timeout.json)
 */
@summary("Agent Hooks - interception record")
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
      description: "Identities are null when identity_provider is null (section 10.3).",
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

  /** Identity before dispatch; null iff identity_provider is null. */
  input_identity: string | null;

  /** Identity after composition; null iff identity_provider is null. */
  enforced_identity: string | null;

  @pattern("^(jcs-sha256|(?!jcs)[a-z][a-z0-9_-]*)$")
  identity_provider: string | null;

  /** ctx.session.id correlates records across a session. */
  session_id: string;

  /** ctx.sequence totally orders the records within a session. */
  sequence: integer;

  /** Context timestamp, copied verbatim when present. */
  timestamp?: string;

  trace?: Trace;

  /** Winning registration index; null for pure-allow or synthesized results. */
  @minValue(0)
  decided_by?: integer | null;

  @extension("additionalProperties", false)
  composition: {
    profile: CompositionProfile;
    on_approval?: OnApproval;
    on_disagreement?: ConflictResolution;
    on_transform_conflict?: ConflictResolution;
  };

  /** Required for multi-verdict profiles; runtime also requires failure slots. */
  verdicts?: VerdictSlot[];

  /** Whether sequential dispatch skipped any registered interceptor. */
  fold_truncated?: boolean;

  /** Absent or null when the approval seam was never consulted. */
  resolved_by?: ResolvedBy | null;

  @minValue(0)
  interceptors_registered: integer;
}
