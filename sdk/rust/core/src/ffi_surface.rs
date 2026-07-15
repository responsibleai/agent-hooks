// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! JSON-string FFI surface shared by all language bindings.
//!
//! Every function here takes and returns UTF-8 JSON strings so the same
//! surface works over PyO3, napi-rs, and a plain C ABI. Bindings marshal
//! their native string type to `&str` / `String` and delegate here; no
//! per-binding logic.
//!
//! Errors are returned as `Err((host_error_code, detail))` where
//! `host_error_code` is the §11 wire string (e.g.
//! `"host_error:verdict_invalid"`); bindings raise a native exception
//! carrying both.

use crate::composition::{
    aggregate_strictest, is_unanimous_allow, summaries, with_unions, Aggregate, CompositionConfig,
    CompositionProfile, SynthesisPolicy,
};
use crate::enforce::FinalizeMeta;
use crate::types::{EnforcementMode, Verdict};
use crate::{canonical, enforce as enforce_mod, path, verdict, AgentContext, HostError, Transform};
use serde_json::Value;

/// `(host_error_code, detail_message)`
pub type FfiError = (String, String);

fn err(e: HostError, detail: impl Into<String>) -> FfiError {
    (e.to_string(), detail.into())
}

fn parse_json(s: &str, what: &str) -> Result<Value, FfiError> {
    serde_json::from_str(s).map_err(|e| err(HostError::ContextInvalid, format!("{what}: {e}")))
}

/// §10.2: canonical JSON of an arbitrary value (RFC 8785). Rejects
/// integer literals beyond ±(2⁵³−1): serde would coerce them to f64
/// before serialization, silently rewriting the bytes (§4.4 "never
/// normalize").
pub fn canonical_json(value_json: &str) -> Result<String, FfiError> {
    let v = parse_json(value_json, "value")?;
    canonical::scan_raw_integer_domain(value_json).map_err(|(e, d)| err(e, d))?;
    Ok(canonical::canonical_json(&v))
}

/// §10.2: the `jcs-sha256` identity provider. Fails closed
/// (`host_error:context_invalid` with remediation detail) on a
/// non-I-JSON projection. The raw-text scan runs here (not only in
/// `canonical::context_identity`) because integer literals beyond the
/// u64/i64 range are already lossy after `serde_json::from_str` — the
/// in-memory check alone cannot see them.
pub fn context_identity(ctx_json: &str) -> Result<String, FfiError> {
    let ctx: AgentContext = serde_json::from_str(ctx_json)
        .map_err(|e| err(HostError::ContextInvalid, format!("ctx: {e}")))?;
    canonical::scan_projection_raw(ctx_json).map_err(|(e, d)| err(e, d))?;
    canonical::context_identity(&ctx).map_err(|(e, d)| err(e, d))
}

/// §5: validate an interceptor's wire return value. Returns the normalized
/// verdict as JSON on success.
pub fn validate_verdict(verdict_json: &str) -> Result<String, FfiError> {
    let raw = parse_json(verdict_json, "verdict")?;
    let v = verdict::from_wire(&raw).map_err(|(e, d)| err(e, d))?;
    Ok(serde_json::to_string(&v).expect("verdict serialize"))
}

/// §5.2: apply a transform path to a target. Returns the new target JSON.
pub fn apply_transform(
    target_json: &str,
    path_str: &str,
    value_json: &str,
) -> Result<String, FfiError> {
    let target = parse_json(target_json, "target")?;
    let value = parse_json(value_json, "value")?;
    let result = path::apply(target, path_str, value).map_err(|e| err(e, path_str))?;
    Ok(serde_json::to_string(&result).expect("target serialize"))
}

/// §7.4 fold-through / §7.5 winner application: apply one transform to
/// the context's `target` (and its conditional alias) so its effect is
/// observable. Returns the updated context JSON.
pub fn apply_transform_ctx(
    ctx_json: &str,
    path_str: &str,
    value_json: &str,
) -> Result<String, FfiError> {
    let mut ctx: AgentContext = serde_json::from_str(ctx_json)
        .map_err(|e| err(HostError::ContextInvalid, format!("ctx: {e}")))?;
    let value = parse_json(value_json, "value")?;
    let t = Transform {
        path: path_str.to_owned(),
        value,
    };
    enforce_mod::apply_transform_to_ctx(&mut ctx, &t).map_err(|e| err(e, path_str))?;
    Ok(serde_json::to_string(&ctx).expect("ctx serialize"))
}

/// §8 `evaluate_only`: validate a transform against the context's
/// current target without applying it. Returns `"null"` on success.
pub fn validate_transform_ctx(
    ctx_json: &str,
    path_str: &str,
    value_json: &str,
) -> Result<String, FfiError> {
    let ctx: AgentContext = serde_json::from_str(ctx_json)
        .map_err(|e| err(HostError::ContextInvalid, format!("ctx: {e}")))?;
    let value = parse_json(value_json, "value")?;
    let t = Transform {
        path: path_str.to_owned(),
        value,
    };
    enforce_mod::validate_transform(&ctx, &t).map_err(|e| err(e, path_str))?;
    Ok("null".to_owned())
}

/// §7.3/§7.5 aggregation for the multi-verdict profiles. Bindings drive
/// dispatch natively (they own interceptor callbacks and the transform
/// fold) and delegate every aggregation decision here so all SDKs agree.
///
/// Input: the composition config JSON (§10.3 `composition` block) and
/// the array of §5-normalized verdicts, index-aligned with registration
/// order. Output JSON:
///
/// ```jsonc
/// {
///   "combined": <verdict>,        // winner (or synthesized) with §7.3 unions
///   "decided_by": 0 | null,       // aggregation winner index
///   "consult": true | false,      // combined is a liftable deny the profile
///                                 // says to consult (env checks — resolver
///                                 // present, mode, shutdown — stay native)
///   "apply_transform": true | false // parallel only: combined is the single
///                                 // winning transform, not yet applied
/// }
/// ```
pub fn compose_aggregate(composition_json: &str, verdicts_json: &str) -> Result<String, FfiError> {
    let cfg: CompositionConfig = serde_json::from_str(composition_json)
        .map_err(|e| err(HostError::ContextInvalid, format!("composition: {e}")))?;
    let raw: Vec<Value> = serde_json::from_str(verdicts_json)
        .map_err(|e| err(HostError::VerdictInvalid, format!("verdicts: {e}")))?;
    if raw.is_empty() {
        return Err(err(HostError::NoInterceptor, "empty verdict list"));
    }
    // §5 gate at the FFI seam (a third-party binding must not be able
    // to aggregate un-vetted verdicts): every entry either passes §5
    // validation or is exactly the host-synthesized §6.3/§7.5 shape —
    // a deny with a reserved host_error:* reason and no transform
    // (optionally liftable). Anything else fails the aggregation.
    let all: Vec<Verdict> = raw
        .iter()
        .map(|v| serde_json::from_value::<Verdict>(v.clone()))
        .collect::<Result<_, _>>()
        .map_err(|e| err(HostError::VerdictInvalid, format!("verdicts: {e}")))?;
    for (i, v) in all.iter().enumerate() {
        let synthesized_shape = v.decision == crate::Decision::Deny
            && v.reason
                .as_deref()
                .is_some_and(|r| r.starts_with("host_error:"))
            && v.transform.is_none();
        if !synthesized_shape {
            v.validate()
                .map_err(|e| err(e, format!("verdicts[{i}]: fails the §5 gate")))?;
        }
    }

    let sequential = cfg.profile.is_sequential();
    let (combined, decided_by, apply_transform) = match cfg.profile {
        CompositionProfile::ParallelUnanimous if !is_unanimous_allow(&all) => {
            let policy = cfg.on_disagreement.unwrap_or(SynthesisPolicy::Deny);
            let v = match policy {
                SynthesisPolicy::Deny => Verdict::host_error(
                    HostError::CompositionDisagreement,
                    Some("non-unanimous outcome under parallel/unanimous".into()),
                ),
                SynthesisPolicy::Approval => Verdict::host_error_liftable(
                    HostError::CompositionDisagreement,
                    Some("non-unanimous outcome under parallel/unanimous".into()),
                ),
            };
            (with_unions(v, &all), None, false)
        }
        _ => match aggregate_strictest(&all, sequential) {
            Aggregate::TransformConflict(idxs) => {
                let policy = cfg.on_transform_conflict.unwrap_or(SynthesisPolicy::Deny);
                let detail = format!("conflicting transforms from interceptors {idxs:?}");
                let v = match policy {
                    SynthesisPolicy::Deny => {
                        Verdict::host_error(HostError::TransformConflict, Some(detail))
                    }
                    SynthesisPolicy::Approval => {
                        Verdict::host_error_liftable(HostError::TransformConflict, Some(detail))
                    }
                };
                (with_unions(v, &all), None, false)
            }
            Aggregate::Winner(i) => {
                let winner = all[i].clone();
                let decided_by = match winner.decision {
                    crate::Decision::Allow => None,
                    _ => Some(i as u32),
                };
                let apply = !sequential && winner.decision == crate::Decision::Transform;
                (with_unions(winner, &all), decided_by, apply)
            }
        },
    };

    let consult = combined.is_liftable();
    let out = serde_json::json!({
        "combined": combined,
        "decided_by": decided_by,
        "consult": consult,
        "apply_transform": apply_transform,
        "verdicts": summaries(&all),
    });
    Ok(out.to_string())
}

/// §10.3: build the `InterceptionRecord` for one completed emission.
/// `options_json`:
///
/// ```jsonc
/// {
///   "input_identity": "..." | null,
///   "identity_provider": "jcs-sha256" | "<host-defined>" | null,
///   "enforced_identity": "..." | null,  // custom providers only;
///                                       // jcs-sha256 is computed here
///   "decided_by": 0 | null,
///   "composition": { "profile": "...", ... },   // REQUIRED
///   "verdicts": [ {"index", "decision", "reason"?}, ... ],
///   "fold_truncated": true | false,     // sequential profiles only
///   "resolved_by": "approval" | "rejection" | null,
///   "interceptors_registered": 0
/// }
/// ```
pub fn finalize(
    ctx_json: &str,
    verdict_json: &str,
    mode: &str,
    options_json: &str,
) -> Result<String, FfiError> {
    let ctx: AgentContext = serde_json::from_str(ctx_json)
        .map_err(|e| err(HostError::ContextInvalid, format!("ctx: {e}")))?;
    let v: Verdict = serde_json::from_str(verdict_json)
        .map_err(|e| err(HostError::VerdictInvalid, format!("verdict: {e}")))?;
    let mode = match mode {
        "enforce" => EnforcementMode::Enforce,
        "evaluate_only" => EnforcementMode::EvaluateOnly,
        _ => return Err(err(HostError::ContextInvalid, format!("mode: {mode}"))),
    };
    let opts: Value = parse_json(options_json, "options")?;
    let composition: CompositionConfig = serde_json::from_value(
        opts.get("composition").cloned().unwrap_or(Value::Null),
    )
    .map_err(|e| {
        err(
            HostError::ContextInvalid,
            format!("options.composition: {e}"),
        )
    })?;
    let verdicts = match opts.get("verdicts") {
        None | Some(Value::Null) => Vec::new(),
        Some(v) => serde_json::from_value(v.clone())
            .map_err(|e| err(HostError::ContextInvalid, format!("options.verdicts: {e}")))?,
    };
    let opt_str = |k: &str| opts.get(k).and_then(Value::as_str).map(str::to_owned);
    // jcs-sha256 computes enforced_identity core-side from this ctx,
    // but the parse above already coerced any beyond-u64 literal — so
    // when the raw-text scan rejects, identity computation is
    // suppressed (null identities, §10.3 rejection shape) rather than
    // hashing the rounded bytes. Never an error here: finalize builds
    // the fail-closed record for exactly these contexts.
    let jcs_input_rejected = opt_str("identity_provider").as_deref() == Some("jcs-sha256")
        && canonical::scan_projection_raw(ctx_json).is_err();
    let unchanged_since_input = opts
        .get("unchanged_since_input")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let meta = FinalizeMeta {
        input_identity: opt_str("input_identity"),
        identity_provider: opt_str("identity_provider"),
        enforced_identity: opt_str("enforced_identity"),
        jcs_input_rejected,
        unchanged_since_input,
        decided_by: opts
            .get("decided_by")
            .and_then(Value::as_u64)
            .map(|d| d as u32),
        composition,
        verdicts,
        fold_truncated: opts.get("fold_truncated").and_then(Value::as_bool),
        resolved_by: match opts.get("resolved_by").and_then(Value::as_str) {
            Some("approval") => Some("approval"),
            Some("rejection") => Some("rejection"),
            _ => None,
        },
        interceptors_registered: opts
            .get("interceptors_registered")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
    };
    // §10.1: a host-defined provider name must satisfy the name rules;
    // a wrapper that lets "jcs-fake" through would let records claim
    // golden-vector semantics.
    if let Some(name) = meta.identity_provider.as_deref() {
        if name != crate::types::JCS_SHA256 {
            crate::types::validate_provider_name(name)
                .map_err(|(e, d)| err(e, format!("options.identity_provider: {d}")))?;
        }
    }
    let record = enforce_mod::finalize(&ctx, v, mode, meta);
    Ok(serde_json::to_string(&record).expect("record serialize"))
}

/// §4 envelope validation (fail closed). Returns the empty string on a
/// valid envelope; callers receive an `FfiError` with the value-free
/// detail otherwise. Wrappers call this at the top of every emission
/// (§6.3) and synthesize the `context_invalid` deny themselves so the
/// fail-closed record still carries best-effort envelope fields.
pub fn validate_envelope(ctx_json: &str) -> Result<String, FfiError> {
    let ctx: AgentContext = serde_json::from_str(ctx_json)
        .map_err(|e| err(HostError::ContextInvalid, format!("ctx: {e}")))?;
    canonical::validate_envelope(&ctx).map_err(|(e, d)| err(e, d))?;
    Ok(String::new())
}

/// Version stamp for binding sanity checks.
pub fn spec_version() -> &'static str {
    crate::SPEC_VERSION
}

// ---- CTK engine (§13.2) ----------------------------------------------------

/// Evaluate a vector's `interceptor_script` against `ctx`. Returns the
/// verdict JSON the scripted interceptor produced.
pub fn ctk_scripted_intercept(rules_json: &str, ctx_json: &str) -> Result<String, FfiError> {
    let rules: Vec<Value> = serde_json::from_str(rules_json)
        .map_err(|e| err(HostError::ContextInvalid, format!("rules: {e}")))?;
    let ctx = parse_json(ctx_json, "ctx")?;
    let out = crate::ctk_engine::scripted_intercept(&rules, &ctx);
    Ok(serde_json::to_string(&out).expect("verdict serialize"))
}

/// Evaluate a vector's `approval_script` against the request context.
/// Returns `{outcome, context_identity, verdict?}` echoing `identity`.
pub fn ctk_scripted_resolve(
    rules_json: &str,
    ctx_json: &str,
    identity: &str,
) -> Result<String, FfiError> {
    let rules: Vec<Value> = serde_json::from_str(rules_json)
        .map_err(|e| err(HostError::ContextInvalid, format!("rules: {e}")))?;
    let ctx = parse_json(ctx_json, "ctx")?;
    let out = crate::ctk_engine::scripted_resolve(&rules, &ctx, identity);
    Ok(serde_json::to_string(&out).expect("resolution serialize"))
}

/// Determine whether a vector should be skipped for a harness. Returns
/// `null` (no skip) or a detail string.
pub fn ctk_should_skip(vector_json: &str, harness_caps_json: &str) -> Result<String, FfiError> {
    let vector = parse_json(vector_json, "vector")?;
    let caps: Vec<String> = serde_json::from_str(harness_caps_json)
        .map_err(|e| err(HostError::ContextInvalid, format!("caps: {e}")))?;
    let caps_ref: Vec<&str> = caps.iter().map(String::as_str).collect();
    let out = crate::ctk_engine::should_skip(&vector, &caps_ref);
    Ok(serde_json::to_string(&out).expect("skip serialize"))
}

/// Run the assertion pass for one vector. Returns `VectorResult` JSON.
pub fn ctk_assert(
    vector_json: &str,
    recorded_json: &str,
    run_record_json: &str,
) -> Result<String, FfiError> {
    let vector = parse_json(vector_json, "vector")?;
    let recorded: Vec<Value> = serde_json::from_str(recorded_json)
        .map_err(|e| err(HostError::ContextInvalid, format!("recorded: {e}")))?;
    let rr: crate::ctk_engine::RunRecord = serde_json::from_str(run_record_json)
        .map_err(|e| err(HostError::ContextInvalid, format!("run_record: {e}")))?;
    let out = crate::ctk_engine::assert_vector(&vector, &recorded, &rr);
    Ok(serde_json::to_string(&out).expect("result serialize"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compose_aggregate_strictest_winner() {
        let out = compose_aggregate(
            r#"{"profile": "parallel/strictest"}"#,
            &json!([
                {"decision": "allow"},
                {"decision": "deny", "reason": "nope"},
                {"decision": "deny", "approval": {}}
            ])
            .to_string(),
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["decided_by"], 1); // plain deny dominates liftable
        assert_eq!(v["consult"], false);
        assert_eq!(v["combined"]["decision"], "deny");
        assert_eq!(v["verdicts"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn compose_aggregate_liftable_consult() {
        let out = compose_aggregate(
            r#"{"profile": "parallel/strictest"}"#,
            &json!([{"decision": "allow"}, {"decision": "deny", "approval": {}}]).to_string(),
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["consult"], true);
        assert_eq!(v["decided_by"], 1);
    }

    #[test]
    fn compose_aggregate_transform_conflict() {
        let t = json!({"decision": "transform", "transform": {"path": "$target.x", "value": 1}});
        let out = compose_aggregate(
            r#"{"profile": "parallel/strictest", "on_transform_conflict": "deny"}"#,
            &json!([t, t]).to_string(),
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["combined"]["reason"], "host_error:transform_conflict");
        assert_eq!(v["consult"], false);

        let out = compose_aggregate(
            r#"{"profile": "parallel/strictest", "on_transform_conflict": "approval"}"#,
            &json!([t, t]).to_string(),
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["consult"], true);
    }

    #[test]
    fn compose_aggregate_unanimous() {
        let out = compose_aggregate(
            r#"{"profile": "parallel/unanimous", "on_disagreement": "deny"}"#,
            &json!([{"decision": "allow"}, {"decision": "transform",
                     "transform": {"path": "$target.x", "value": 1}}])
            .to_string(),
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["combined"]["reason"],
            "host_error:composition_disagreement"
        );
        // Unanimous allow:
        let out = compose_aggregate(
            r#"{"profile": "parallel/unanimous", "on_disagreement": "deny"}"#,
            &json!([{"decision": "allow"}, {"decision": "allow", "result_labels": ["l"]}])
                .to_string(),
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["combined"]["decision"], "allow");
        assert_eq!(v["combined"]["result_labels"], json!(["l"]));
    }

    #[test]
    fn compose_aggregate_parallel_single_transform_flagged() {
        let out = compose_aggregate(
            r#"{"profile": "parallel/strictest"}"#,
            &json!([{"decision": "allow"},
                    {"decision": "transform", "transform": {"path": "$target.x", "value": 1}}])
            .to_string(),
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["apply_transform"], true);
        assert_eq!(v["decided_by"], 1);
    }

    #[test]
    fn finalize_options_shape() {
        let ctx = json!({
            "spec": "agent-hooks/0.1", "interception_point": "input",
            "timestamp": "t", "sequence": 0,
            "agent": {"id": "a", "framework": "x"}, "session": {"id": "s"},
            "target": {"content": "hi", "role": "user"},
            "input": {"content": "hi", "role": "user"}
        })
        .to_string();
        let input_id = context_identity(&ctx).unwrap();
        let out = finalize(
            &ctx,
            r#"{"decision": "allow"}"#,
            "enforce",
            &json!({
                "input_identity": input_id,
                "identity_provider": "jcs-sha256",
                "decided_by": null,
                "composition": {"profile": "sequential/first_deny", "on_approval": "stop"},
                "fold_truncated": false
            })
            .to_string(),
        )
        .unwrap();
        let r: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(r["input_identity"], r["enforced_identity"]);
        assert_eq!(r["identity_provider"], "jcs-sha256");
        assert_eq!(r["composition"]["profile"], "sequential/first_deny");
        assert_eq!(r["fold_truncated"], false);
    }

    #[test]
    fn context_identity_rejects_big_int() {
        let ctx = json!({
            "spec": "agent-hooks/0.1", "interception_point": "pre_tool_call",
            "timestamp": "t", "sequence": 0,
            "agent": {"id": "a", "framework": "x"}, "session": {"id": "s"},
            "target": {"id": 9007199254740993_i64},
            "tool_call": {"id": "tc", "name": "t", "args": {"id": 9007199254740993_i64}}
        })
        .to_string();
        let (code, detail) = context_identity(&ctx).unwrap_err();
        assert_eq!(code, "host_error:context_invalid");
        assert!(detail.contains("string-encode"), "{detail}");
    }
}
