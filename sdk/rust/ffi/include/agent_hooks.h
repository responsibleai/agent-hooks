// Copyright (c) Microsoft. All rights reserved.

/* C header for libagent_hooks_ffi. Kept in sync with sdk/rust/ffi/src/lib.rs. */

#ifndef AGENT_HOOKS_FFI_H
#define AGENT_HOOKS_FFI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    /* 1 on success, 0 on error. */
    uint8_t ok;
    /* On success: JSON result. On error: detail message. UTF-8, NUL-terminated. */
    char *value;
    /* On error: a host_error:* code, a declaration_error:* code (the two
     * ah_declaration_* functions; value is then JSON findings), or
     * "marshal_error" (invalid UTF-8 argument / unmarshalable result) or
     * "panic" (core defect caught at the boundary; the process is not
     * aborted). NULL on success. UTF-8, NUL-terminated. */
    char *error_code;
} AhResult;

/* Free an AhResult* returned by any ah_* function. */
void ah_free_result(AhResult *r);

/* Static string; do NOT free. */
const char *ah_spec_version(void);

AhResult *ah_canonical_json(const char *value_json);
AhResult *ah_context_identity(const char *ctx_json);

/* Section 4/6.3: envelope validation (fail closed, value-free detail).
 * Ok value is the empty string. */
AhResult *ah_validate_envelope(const char *ctx_json);
AhResult *ah_validate_verdict(const char *verdict_json);
/* Section 5.5: accepts a bare Verdict or InterceptorResponse and returns
 * the normalized envelope form. */
AhResult *ah_normalize_interceptor_response(const char *response_json);
AhResult *ah_apply_transform(const char *target_json, const char *path,
                             const char *value_json);
AhResult *ah_apply_transform_ctx(const char *ctx_json, const char *path,
                                 const char *value_json);
AhResult *ah_validate_transform_ctx(const char *ctx_json, const char *path,
                                    const char *value_json);
/* options_json: {input_identity?, identity_provider?, enforced_identity?,
 * decided_by?, composition, verdicts?, fold_truncated?, resolved_by?,
 * declaration?} (spec section 10.3). A verdicts entry is {index,
 * decision, reason?, name?, substituted_for?}; substituted_for names
 * the host_error reason an on_error: continue registration failed with
 * (section 6.3) and is accepted only on an allow. */
AhResult *ah_finalize(const char *ctx_json, const char *verdict_json,
                      const char *mode, const char *options_json);

/* Severity-max aggregation for multi-verdict composition profiles
 * (spec sections 7.3, 7.5). Returns {combined, decided_by, consult,
 * apply_transform, verdicts}. A verdicts entry may be the section 6.3
 * substituted allow (decision allow, one warning with reason
 * host_warning:control_failed, nothing else); the wrapper attaches
 * substituted_for to the returned summaries positionally. */
AhResult *ah_compose_aggregate(const char *composition_json,
                               const char *verdicts_json);

/* Failure posture on_error: continue (spec section 6.3).
 * ah_control_failure_substitute: request_json is {binding, reason,
 * index?, interception_point?}; binding is the payload-free label of
 * the failing registration (its declaration id, or interceptor-<index>)
 * and reason one of host_error:interceptor_failed,
 * host_error:interceptor_timeout, host_error:verdict_invalid. Ok value
 * is {verdict, substituted_for, notice}: the allow that takes the
 * registration's composition slot, the value for its summary entry's
 * substituted_for, and the notice {interception_point?, index, binding,
 * reason, message} the wrapper MUST relay to the principal before the
 * action continues. Any other reason is refused
 * (host_error:context_invalid): cancellation, approval failures,
 * context failures, transform failures and no_interceptor never
 * continue.
 * ah_managed_outcome: the typed outcome of an interceptor that owns its
 * own deadline. outcome_json is {"outcome": "verdict", "verdict": {...}}
 * | {"outcome": "timeout"} | {"outcome": "cancelled"} |
 * {"outcome": "failed", "detail"?: "<type name>"}. Ok value is
 * {verdict, failure}: the verdict for the slot under on_error: deny
 * and, when the outcome is a failure, {reason, detail, continuable}.
 * continuable is false for cancelled; a wrapper MUST NOT substitute an
 * allow for it. A verdict outcome crosses the section 5 gate. */
AhResult *ah_control_failure_substitute(const char *request_json);
AhResult *ah_managed_outcome(const char *outcome_json);

/* Host declaration document (spec section 7.7).
 * ah_declaration_versions: {"current": "...", "supported": [...]}.
 * ah_declaration_resolve: steps 2 to 10 of section 7.7.6. document_json
 * is the document text; host_json is {surface, identity_providers,
 * approval_resolvers, approval_redactors, kinds}, the wrapper's code
 * surface plus the names its registry holds. Ok value is the resolved
 * declaration JSON; on refusal error_code is declaration_error:<class>
 * and value is {"findings": [{pointer, detail}], "accepted": [...]}.
 * host_json is a closed object: one that does not parse, carries an
 * unknown member or describes a surface the core rejects (a missing
 * section 3.2 floor point, an unknown capability) is a wrapper defect
 * and comes back as marshal_error, not as a refusal of the document. */
AhResult *ah_declaration_versions(void);
AhResult *ah_declaration_resolve(const char *document_json,
                                 const char *host_json);

/* CTK engine (spec section 13.2) */
AhResult *ah_ctk_scripted_intercept(const char *rules_json,
                                    const char *ctx_json);
AhResult *ah_ctk_scripted_resolve(const char *rules_json,
                                  const char *ctx_json,
                                  const char *identity);
AhResult *ah_ctk_should_skip(const char *vector_json,
                             const char *harness_caps_json);
AhResult *ah_ctk_assert(const char *vector_json, const char *recorded_json,
                        const char *run_record_json);

#ifdef __cplusplus
}
#endif

#endif /* AGENT_HOOKS_FFI_H */
