// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! Stateless enforcement primitives (§6, §7.4, §8, §10.3).
//!
//! Transform application happens **during** dispatch in sequential
//! profiles (each interceptor sees the prior transforms' effect, §7.4)
//! and once, on the winner, in parallel profiles (§7.5). The
//! per-language emitter loop calls [`apply_transform_to_ctx`] at those
//! points and [`finalize`] once at the end to compute identities and
//! build the [`InterceptionRecord`]. Both are pure; everything that
//! calls back into user code stays in the wrapper.

use crate::canonical::{context_identity, validate_envelope};
use crate::composition::CompositionConfig;
use crate::path;
use crate::types::{
    AgentContext, EnforcementMode, HostError, InterceptionPoint, InterceptionRecord, Transform,
    Verdict, VerdictSummary, JCS_SHA256,
};
use serde_json::Value;
use std::str::FromStr;

impl FromStr for InterceptionPoint {
    type Err = HostError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "agent_startup" => Ok(Self::AgentStartup),
            "input" => Ok(Self::Input),
            "pre_model_call" => Ok(Self::PreModelCall),
            "post_model_call" => Ok(Self::PostModelCall),
            "pre_tool_call" => Ok(Self::PreToolCall),
            "post_tool_call" => Ok(Self::PostToolCall),
            "output" => Ok(Self::Output),
            "agent_shutdown" => Ok(Self::AgentShutdown),
            _ => Err(HostError::ContextInvalid),
        }
    }
}

fn interception_point_of(ctx: &AgentContext) -> Result<InterceptionPoint, HostError> {
    ctx.get("interception_point")
        .and_then(Value::as_str)
        .ok_or(HostError::ContextInvalid)?
        .parse()
}

/// Apply one `transform` to the context's `target` and mirror it into
/// the conditional field it aliases (§4.3, §5.2). Fails closed on a
/// forbidden point or unresolvable path; the caller synthesizes the
/// `host_error` deny. In `evaluate_only` mode callers use
/// [`validate_transform`] instead (§8: validated, not applied).
pub fn apply_transform_to_ctx(
    ctx: &mut AgentContext,
    transform: &Transform,
) -> Result<(), HostError> {
    let ip = interception_point_of(ctx)?;
    if !ip.transform_permitted() {
        return Err(HostError::TransformTargetForbidden);
    }
    let target = ctx.get("target").cloned().unwrap_or(Value::Null);
    let applied = path::apply(target, &transform.path, transform.value.clone())?;
    ctx.insert("target".into(), applied.clone());
    write_back_target(ip, ctx, &applied);
    Ok(())
}

/// §8 `evaluate_only`: validate a transform against the current target
/// without applying it.
pub fn validate_transform(ctx: &AgentContext, transform: &Transform) -> Result<(), HostError> {
    let ip = interception_point_of(ctx)?;
    if !ip.transform_permitted() {
        return Err(HostError::TransformTargetForbidden);
    }
    let target = ctx.get("target").cloned().unwrap_or(Value::Null);
    path::apply(target, &transform.path, transform.value.clone()).map(|_| ())
}

/// Everything [`finalize`] needs beyond the context and combined
/// verdict (§10.3).
#[derive(Debug, Clone, Default)]
pub struct FinalizeMeta {
    /// Provider output computed **before** dispatch; `None` when the
    /// identity provider is `null` or rejected the context.
    pub input_identity: Option<String>,
    /// The declared provider name (§10.1). When `Some(JCS_SHA256)`,
    /// [`finalize`] computes `enforced_identity` from the post-fold
    /// context itself; a custom provider's host passes
    /// `enforced_identity` explicitly.
    pub identity_provider: Option<String>,
    /// Pre-computed post-composition identity for custom providers.
    /// Ignored when `identity_provider == Some(JCS_SHA256)`.
    pub enforced_identity: Option<String>,
    /// True when the raw-text scan (§10.2) rejected the context at a
    /// JSON funnel: the parsed `ctx` then holds already-coerced
    /// numbers, so the JCS arm MUST NOT compute an identity from it
    /// (it would hash the rounded bytes). The record keeps the
    /// declared provider name with `null` identities — the §10.3
    /// rejection shape.
    pub jcs_input_rejected: bool,
    /// True when no transform was applied to the context after
    /// `input_identity` was computed (allow paths, evaluate_only): the
    /// bytes are unchanged, so the JCS arm reuses `input_identity`
    /// instead of re-canonicalizing and re-hashing the full payload
    /// (NEXT-19). Defaults to `false` (compute — the safe direction);
    /// only set by emitters that track fold state.
    pub unchanged_since_input: bool,
    pub decided_by: Option<u32>,
    pub composition: CompositionConfig,
    /// Per-interceptor summaries (multi-verdict profiles, §10.3).
    pub verdicts: Vec<VerdictSummary>,
    /// Sequential profiles (§7.4).
    pub fold_truncated: Option<bool>,
    /// Consultation outcome: `"approval"` / `"rejection"` / none
    /// (§7.6, §10.3).
    pub resolved_by: Option<&'static str>,
    /// Interceptors registered at emission time (§10.3).
    pub interceptors_registered: u32,
}

/// Truncate to at most 256 UTF-8 bytes on a character boundary,
/// appending `…` when truncated (§10.3 projection).
fn truncate_message(s: &str) -> String {
    const MAX: usize = 256;
    if s.len() <= MAX {
        return s.to_owned();
    }
    let mut end = MAX;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// §10.3: the payload-free projection of a combined verdict. Drops
/// `transform.value` (target content by definition), strips `approval`
/// members, and truncates free-form messages; everything else — the
/// bounded, non-target-derived members — passes through.
pub fn payload_free_projection(v: &Verdict) -> Verdict {
    Verdict {
        decision: v.decision,
        reason: v.reason.clone(),
        message: v.message.as_deref().map(truncate_message),
        warnings: v
            .warnings
            .iter()
            .map(|w| crate::types::Warning {
                reason: w.reason.clone(),
                message: w.message.as_deref().map(truncate_message),
            })
            .collect(),
        approval: v.approval.as_ref().map(|_| serde_json::Map::new()),
        transform: v.transform.as_ref().map(|t| Transform {
            path: t.path.clone(),
            value: Value::Null,
        }),
        evidence: v.evidence.clone(),
        result_labels: v.result_labels.clone(),
    }
}

/// Build the [`InterceptionRecord`] for one completed emission (§10.3).
/// `meta.input_identity` MUST have been computed from the context
/// **before** interceptor dispatch; `enforced_identity` is computed
/// here (default provider) from the post-composition context, so the
/// two differ exactly when a transform was applied. The record carries
/// the [`payload_free_projection`] of the combined verdict, never the
/// verdict verbatim.
pub fn finalize(
    ctx: &AgentContext,
    verdict: Verdict,
    mode: EnforcementMode,
    meta: FinalizeMeta,
) -> InterceptionRecord {
    let mut verdict = verdict;
    let mut decided_by = meta.decided_by;
    // §10.2/§10.3 defense in depth: an envelope the §4 check rejects
    // MUST NOT earn a record with a normal verdict — emitters validate
    // before dispatch, but finalize re-checks so no third-party
    // binding can produce a plausible record over a partial preimage.
    // The record then carries best-effort envelope fields (`""`/`-1`),
    // null identities, and the fail-closed deny: the §10.3 rejection
    // shape, never a plausible one.
    let envelope_invalid = validate_envelope(ctx).err();
    if let Some((e, detail)) = &envelope_invalid {
        if !is_context_invalid(&verdict) {
            verdict = Verdict::host_error(*e, Some(detail.clone()));
            decided_by = None;
        }
    }
    let ip = interception_point_of(ctx).unwrap_or(InterceptionPoint::AgentStartup);
    let session_id = ctx
        .get("session")
        .and_then(|s| s.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let sequence = ctx.get("sequence").and_then(Value::as_i64).unwrap_or(-1);
    // §10.3: payload-free copies for audit/SIEM correlation. String
    // members only; a malformed envelope simply yields absence.
    let timestamp = ctx
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let trace = ctx.get("trace").and_then(Value::as_object).and_then(|t| {
        let tc = crate::types::TraceContext {
            trace_id: t.get("trace_id").and_then(Value::as_str).map(str::to_owned),
            span_id: t.get("span_id").and_then(Value::as_str).map(str::to_owned),
        };
        (tc.trace_id.is_some() || tc.span_id.is_some()).then_some(tc)
    });
    let enforced_identity = match meta.identity_provider.as_deref() {
        _ if envelope_invalid.is_some() => None,
        Some(JCS_SHA256) if meta.jcs_input_rejected => {
            // The raw-text scan rejected the (FFI-marshalled) context.
            // With a null input_identity this is the pre-dispatch
            // rejection — the emitter already denied. With a present
            // input_identity the *input* was clean, so a fold-applied
            // transform introduced the violation: same §10.3 post-fold
            // rule as the in-memory arm below — fail closed.
            if meta.input_identity.is_some() && verdict.decision.permits() {
                verdict = Verdict::host_error(
                    HostError::ContextInvalid,
                    Some(
                        "post-fold context left the I-JSON domain; \
                         string-encode 64-bit identifiers, see spec §4.4"
                            .into(),
                    ),
                );
                decided_by = None;
            }
            None
        }
        // §10.3: with no fold-applied transform the post-composition
        // bytes are the pre-dispatch bytes — reuse the already-computed
        // input identity (skips a full canonicalize+hash on the
        // allow path). Only when the input identity exists: a None
        // input with a declared jcs provider is the rejection shape.
        Some(JCS_SHA256) if meta.unchanged_since_input && meta.input_identity.is_some() => {
            meta.input_identity.clone()
        }
        Some(JCS_SHA256) => match context_identity(ctx) {
            Ok(id) => Some(id),
            // §10.2/§10.3: the post-fold context left the provider's
            // domain (a transform introduced a non-I-JSON value). The
            // identity chain is broken exactly where a transform
            // changed the action, so the emission fails closed instead
            // of proceeding with a null enforced identity.
            Err((e, detail)) => {
                if verdict.decision.permits() {
                    verdict = Verdict::host_error(e, Some(detail));
                    decided_by = None;
                }
                None
            }
        },
        Some(_) => meta.enforced_identity,
        None => None,
    };
    let input_identity = if envelope_invalid.is_some() {
        None
    } else {
        meta.input_identity
    };
    InterceptionRecord {
        interception_point: ip,
        mode,
        verdict: payload_free_projection(&verdict),
        input_identity,
        enforced_identity,
        identity_provider: meta.identity_provider,
        session_id,
        sequence,
        timestamp,
        trace,
        decided_by,
        composition: meta.composition.with_knob_defaults(),
        verdicts: meta.verdicts,
        fold_truncated: meta.fold_truncated,
        resolved_by: meta.resolved_by,
        interceptors_registered: meta.interceptors_registered,
    }
}

/// Whether a verdict is already the fail-closed `context_invalid`
/// deny (avoids double-substitution in [`finalize`]).
fn is_context_invalid(v: &Verdict) -> bool {
    v.decision == crate::types::Decision::Deny
        && v.reason.as_deref() == Some("host_error:context_invalid")
}

/// Mirror the transformed target back into the conditional field it
/// aliases (§4.3).
fn write_back_target(ip: InterceptionPoint, ctx: &mut AgentContext, transformed: &Value) {
    match ip {
        InterceptionPoint::Input => {
            ctx.insert("input".into(), transformed.clone());
        }
        InterceptionPoint::PreModelCall => {
            ctx.insert("messages".into(), transformed.clone());
        }
        InterceptionPoint::PostModelCall => {
            ctx.insert("response".into(), transformed.clone());
        }
        InterceptionPoint::PreToolCall => {
            if let Some(Value::Object(tc)) = ctx.get_mut("tool_call") {
                tc.insert("args".into(), transformed.clone());
            }
        }
        InterceptionPoint::PostToolCall => {
            if let Some(Value::Object(tr)) = ctx.get_mut("tool_result") {
                tr.insert("value".into(), transformed.clone());
            }
        }
        InterceptionPoint::Output => {
            ctx.insert("output".into(), transformed.clone());
        }
        InterceptionPoint::AgentStartup | InterceptionPoint::AgentShutdown => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Decision;
    use serde_json::json;

    fn ctx(ip: &str, target: Value) -> AgentContext {
        json!({
            "spec": "agent-hooks/0.1",
            "interception_point": ip,
            "timestamp": "2026-01-01T00:00:00Z",
            "sequence": 0,
            "agent": {"id": "a", "framework": "test"},
            "session": {"id": "s"},
            "target": target,
            "tool_call": {"id": "tc-1", "name": "t", "args": target}
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn default_meta(ctx: &AgentContext) -> FinalizeMeta {
        FinalizeMeta {
            input_identity: context_identity(ctx).ok(),
            identity_provider: Some(JCS_SHA256.to_owned()),
            ..FinalizeMeta::default()
        }
    }

    #[test]
    fn record_copies_timestamp_and_echoes_trace() {
        let mut c = ctx("pre_tool_call", json!({"url": "x"}));
        c.insert(
            "trace".into(),
            json!({"trace_id": "0af7651916cd43dd8448eb211c80319c", "span_id": "b7ad6b7169203331"}),
        );
        let r = finalize(
            &c,
            Verdict::allow(),
            EnforcementMode::Enforce,
            default_meta(&c),
        );
        assert_eq!(r.timestamp.as_deref(), Some("2026-01-01T00:00:00Z"));
        let t = r.trace.expect("trace echoed");
        assert_eq!(
            t.trace_id.as_deref(),
            Some("0af7651916cd43dd8448eb211c80319c")
        );
        assert_eq!(t.span_id.as_deref(), Some("b7ad6b7169203331"));
        // wire shape: absent-when-None members
        let wire = serde_json::to_value(finalize(
            &ctx("pre_tool_call", json!({"url": "x"})),
            Verdict::allow(),
            EnforcementMode::Enforce,
            default_meta(&ctx("pre_tool_call", json!({"url": "x"}))),
        ))
        .unwrap();
        assert!(
            wire.get("trace").is_none(),
            "trace absent without context trace"
        );
        assert!(wire.get("timestamp").is_some());
    }

    #[test]
    fn trace_with_foreign_members_only_is_absent() {
        let mut c = ctx("pre_tool_call", json!({"url": "x"}));
        c.insert("trace".into(), json!({"vendor": "x"}));
        let r = finalize(
            &c,
            Verdict::allow(),
            EnforcementMode::Enforce,
            default_meta(&c),
        );
        assert!(r.trace.is_none());
    }

    #[test]
    fn allow_identities_equal() {
        let c = ctx("pre_tool_call", json!({"url": "x"}));
        let r = finalize(
            &c,
            Verdict::allow(),
            EnforcementMode::Enforce,
            default_meta(&c),
        );
        assert_eq!(r.input_identity, r.enforced_identity);
        assert!(r.input_identity.is_some());
        assert_eq!(r.identity_provider.as_deref(), Some(JCS_SHA256));
        assert!(r.proceeds());
    }

    #[test]
    fn null_provider_null_identities() {
        let c = ctx("pre_tool_call", json!({"url": "x"}));
        let r = finalize(
            &c,
            Verdict::allow(),
            EnforcementMode::Enforce,
            FinalizeMeta::default(),
        );
        assert!(r.input_identity.is_none());
        assert!(r.enforced_identity.is_none());
        assert!(r.identity_provider.is_none());
    }

    #[test]
    fn custom_provider_uses_supplied_identity() {
        let c = ctx("pre_tool_call", json!({"url": "x"}));
        let meta = FinalizeMeta {
            input_identity: Some("host:1".into()),
            enforced_identity: Some("host:1".into()),
            identity_provider: Some("host-hash".into()),
            ..FinalizeMeta::default()
        };
        let r = finalize(&c, Verdict::allow(), EnforcementMode::Enforce, meta);
        assert_eq!(r.enforced_identity.as_deref(), Some("host:1"));
        assert_eq!(r.identity_provider.as_deref(), Some("host-hash"));
    }

    #[test]
    fn transform_applies_and_writes_back() {
        let mut c = ctx("pre_tool_call", json!({"url": "evil"}));
        let input_id = context_identity(&c).ok();
        let t = Transform {
            path: "$target.url".into(),
            value: json!("safe"),
        };
        apply_transform_to_ctx(&mut c, &t).unwrap();
        assert_eq!(c["target"]["url"], json!("safe"));
        assert_eq!(c["tool_call"]["args"]["url"], json!("safe"));
        let v = Verdict {
            decision: Decision::Transform,
            transform: Some(t),
            ..Verdict::allow()
        };
        let meta = FinalizeMeta {
            input_identity: input_id,
            identity_provider: Some(JCS_SHA256.to_owned()),
            ..FinalizeMeta::default()
        };
        let r = finalize(&c, v, EnforcementMode::Enforce, meta);
        assert_ne!(r.input_identity, r.enforced_identity);
    }

    #[test]
    fn transform_forbidden_at_startup() {
        let mut c = ctx("agent_startup", json!({}));
        let t = Transform {
            path: "$target.x".into(),
            value: json!(1),
        };
        assert_eq!(
            apply_transform_to_ctx(&mut c, &t),
            Err(HostError::TransformTargetForbidden)
        );
    }

    #[test]
    fn evaluate_only_validates_without_applying() {
        let c = ctx("pre_tool_call", json!({"url": "evil"}));
        let t = Transform {
            path: "$target.url".into(),
            value: json!("safe"),
        };
        validate_transform(&c, &t).unwrap();
        assert_eq!(c["target"]["url"], json!("evil"));
        assert_eq!(
            validate_transform(
                &c,
                &Transform {
                    path: "$target.missing.x".into(),
                    value: json!(0)
                }
            ),
            Err(HostError::TransformInvalid)
        );
    }

    #[test]
    fn projection_drops_transform_value_and_strips_approval() {
        let mut approval = serde_json::Map::new();
        approval.insert("ticket".into(), json!("T-1"));
        let v = Verdict {
            decision: crate::types::Decision::Transform,
            transform: Some(Transform {
                path: "$target.url".into(),
                value: json!({"secret": "payload"}),
            }),
            approval: None,
            message: Some("x".repeat(300)),
            ..Verdict::allow()
        };
        let p = payload_free_projection(&v);
        // The projected transform serializes without a value member.
        let wire = serde_json::to_value(&p).unwrap();
        assert!(wire["transform"].get("value").is_none());
        let t = p.transform.expect("path kept");
        assert_eq!(t.path, "$target.url");
        assert!(t.value.is_null());
        let msg = p.message.expect("message kept");
        assert!(msg.ends_with('…') && msg.len() <= 256 + '…'.len_utf8());

        let d = Verdict {
            approval: Some(approval),
            ..Verdict::escalate(Some("r".into()), None)
        };
        let pd = payload_free_projection(&d);
        assert_eq!(pd.approval, Some(serde_json::Map::new()));
    }

    #[test]
    fn projection_truncates_on_char_boundary() {
        let v = Verdict {
            message: Some("é".repeat(200)), // 400 UTF-8 bytes
            ..Verdict::allow()
        };
        let m = payload_free_projection(&v).message.unwrap();
        assert!(m.len() <= 256 + '…'.len_utf8());
        assert!(m.ends_with('…'));
        assert!(m.chars().all(|c| c == 'é' || c == '…'));
    }

    #[test]
    fn finalize_records_projected_verdict() {
        let mut c = ctx("pre_tool_call", json!({"url": "evil"}));
        let t = Transform {
            path: "$target.url".into(),
            value: json!("safe"),
        };
        apply_transform_to_ctx(&mut c, &t).unwrap();
        let v = Verdict {
            decision: crate::types::Decision::Transform,
            transform: Some(t),
            ..Verdict::allow()
        };
        let r = finalize(&c, v, EnforcementMode::Enforce, FinalizeMeta::default());
        let rt = r.verdict.transform.expect("path kept on record");
        assert!(rt.value.is_null());
    }
    #[test]
    fn post_fold_rejection_fails_closed() {
        // NEXT-02/§10.3: a transform that pushed the context outside
        // the I-JSON domain must convert the emission to a deny, not
        // proceed with a null enforced identity.
        let mut c = ctx("pre_tool_call", json!({"id": 1}));
        let input_id = context_identity(&c).ok();
        // Simulate a folded transform introducing a beyond-2^53 int.
        c.insert("target".into(), json!({"id": 9_007_199_254_740_993_i64}));
        let meta = FinalizeMeta {
            input_identity: input_id,
            identity_provider: Some(JCS_SHA256.to_owned()),
            ..FinalizeMeta::default()
        };
        let r = finalize(&c, Verdict::allow(), EnforcementMode::Enforce, meta);
        assert!(!r.proceeds());
        assert_eq!(
            r.verdict.reason.as_deref(),
            Some("host_error:context_invalid")
        );
        assert!(r.enforced_identity.is_none());
        assert!(r.input_identity.is_some());
    }

    #[test]
    fn envelope_invalid_never_plausible() {
        // NEXT-01/§10.3: an invalid envelope cannot earn a normal
        // verdict or identities, whatever the caller passed.
        let mut c = ctx("pre_tool_call", json!({}));
        c.remove("session");
        let meta = FinalizeMeta {
            input_identity: Some("sha256:beef".into()),
            identity_provider: Some(JCS_SHA256.to_owned()),
            ..FinalizeMeta::default()
        };
        let r = finalize(&c, Verdict::allow(), EnforcementMode::Enforce, meta);
        assert!(!r.proceeds());
        assert_eq!(
            r.verdict.reason.as_deref(),
            Some("host_error:context_invalid")
        );
        assert!(r.input_identity.is_none() && r.enforced_identity.is_none());
        assert_eq!(r.session_id, "");
    }

    #[test]
    fn knob_defaults_recorded() {
        // §7.2/§10.3: records carry resolved knobs even when the host
        // left them unset.
        let c = ctx("pre_tool_call", json!({}));
        let r = finalize(
            &c,
            Verdict::allow(),
            EnforcementMode::Enforce,
            default_meta(&c),
        );
        assert_eq!(
            r.composition.on_approval,
            Some(crate::composition::OnApproval::Stop)
        );
        assert!(r.composition.on_disagreement.is_none());
    }
}
