// Copyright (c) Microsoft. All rights reserved.

//! Verdict wire normalization (§5).

use crate::types::{Decision, Evidence, HostError, SpecVersion, Transform, Verdict, Warning};
use serde_json::Value;

/// Parse a strict Verdict without discarding duplicate object members.
pub fn from_json(text: &str, spec: SpecVersion) -> Result<Verdict, (HostError, String)> {
    let raw = crate::response::parse_checked(text)?;
    from_wire(&raw, spec)
}

pub(crate) fn check_json_domain(raw: &Value) -> Result<(), (HostError, String)> {
    crate::canonical::check_depth(raw).map_err(|_| {
        (
            HostError::VerdictInvalid,
            "result exceeds the JSON nesting limit (§12.3)".into(),
        )
    })
}

fn require_members(
    value: &serde_json::Map<String, Value>,
    allowed: &[&str],
) -> Result<(), (HostError, String)> {
    if value.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err((
            HostError::VerdictInvalid,
            "verdict contains an unknown member (§5)".into(),
        ));
    }
    Ok(())
}

/// Parse and validate an interceptor's wire return value into a `Verdict`
/// per §5. Any violation yields `HostError::VerdictInvalid` with a detail
/// message; the caller synthesizes the `deny` verdict.
pub fn from_wire(raw: &Value, spec: SpecVersion) -> Result<Verdict, (HostError, String)> {
    check_json_domain(raw)?;
    let obj = raw.as_object().ok_or((
        HostError::VerdictInvalid,
        "verdict must be a JSON object".into(),
    ))?;
    require_members(
        obj,
        &[
            "decision",
            "reason",
            "message",
            "warnings",
            "approval",
            "transform",
            "evidence",
            "result_labels",
        ],
    )?;

    let decision = match obj.get("decision").and_then(Value::as_str) {
        Some("allow") => Decision::Allow,
        Some("deny") => Decision::Deny,
        Some("transform") => Decision::Transform,
        // The closed set is three (§5.1): warn is allow+warnings,
        // escalate is deny+approval. The old wire names fail closed.
        other => {
            return Err((
                HostError::VerdictInvalid,
                format!("verdict.decision invalid: {other:?} (§5.1: allow|deny|transform)"),
            ))
        }
    };

    let reason = opt_string(obj, "reason")?;
    if let Some(r) = &reason {
        if r.starts_with("host_error:") {
            return Err((
                HostError::VerdictInvalid,
                "verdict.reason MUST NOT start with 'host_error:' (§5)".into(),
            ));
        }
    }
    let message = opt_string(obj, "message")?;

    let warnings = match obj.get("warnings") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|w| match w {
                Value::Object(m) => {
                    require_members(m, &["reason", "message"])?;
                    // Reserved for the host: host_error:* under every
                    // version, host_warning:* under the draft (§11.1).
                    let reserved = |s: &str| {
                        s.starts_with("host_error:")
                            || (spec.reserves_host_warnings() && s.starts_with("host_warning:"))
                    };
                    let reason = match m.get("reason") {
                        None | Some(Value::Null) => None,
                        Some(Value::String(s)) if !reserved(s) => Some(s.clone()),
                        _ => {
                            return Err((
                                HostError::VerdictInvalid,
                                if spec.reserves_host_warnings() {
                                    "warnings[].reason must be a non-reserved string (host_error:* and host_warning:* are host-only, §5, §11.1)".into()
                                } else {
                                    "warnings[].reason must be a non-reserved string (host_error:* is host-only, §5)".into()
                                },
                            ))
                        }
                    };
                    let message = match m.get("message") {
                        None | Some(Value::Null) => None,
                        Some(Value::String(s)) => Some(s.clone()),
                        _ => {
                            return Err((
                                HostError::VerdictInvalid,
                                "warnings[].message must be string or null".into(),
                            ))
                        }
                    };
                    Ok(Warning { reason, message })
                }
                _ => Err((
                    HostError::VerdictInvalid,
                    "warnings must be an array of objects (§5)".into(),
                )),
            })
            .collect::<Result<_, _>>()?,
        Some(_) => {
            return Err((
                HostError::VerdictInvalid,
                "warnings must be an array of objects (§5)".into(),
            ))
        }
    };

    let approval = match obj.get("approval") {
        None | Some(Value::Null) => None,
        Some(Value::Object(m)) => {
            if decision != Decision::Deny {
                return Err((
                    HostError::VerdictInvalid,
                    "approval block permitted only on deny (§5.1)".into(),
                ));
            }
            Some(m.clone())
        }
        Some(_) => {
            return Err((
                HostError::VerdictInvalid,
                "verdict.approval must be an object (§5)".into(),
            ))
        }
    };

    let transform = match obj.get("transform") {
        None | Some(Value::Null) => None,
        Some(Value::Object(t)) => {
            require_members(t, &["path", "value"])?;
            let path = t
                .get("path")
                .and_then(Value::as_str)
                .ok_or((HostError::VerdictInvalid, "transform.path missing".into()))?;
            // §5 gate and §5.2 application MUST agree byte-for-byte
            // on the accepted path language: validate with the same
            // parser apply uses, mapping its error codes through
            // unchanged.
            if let Err(e) = crate::path::parse(path) {
                let detail = match e {
                    HostError::TransformTargetForbidden => {
                        format!("transform.path must be rooted at $target (got {path:?})")
                    }
                    _ => format!("transform.path rejected by the §5.2 grammar (got {path:?})"),
                };
                return Err((e, detail));
            }
            // §5.2: value is any JSON value including null; an absent
            // member is equivalent to null (the record projection and
            // SDK marshalling drop nulls, so the two forms MUST agree).
            let value = t.get("value").cloned().unwrap_or(Value::Null);
            Some(Transform {
                path: path.to_string(),
                value,
            })
        }
        Some(_) => {
            return Err((
                HostError::VerdictInvalid,
                "verdict.transform must be {path, value}".into(),
            ))
        }
    };

    match (decision, &transform) {
        (Decision::Transform, None) => {
            return Err((
                HostError::VerdictInvalid,
                "transform body REQUIRED when decision=='transform' (§5)".into(),
            ))
        }
        (d, Some(_)) if d != Decision::Transform => {
            return Err((
                HostError::VerdictInvalid,
                "transform body FORBIDDEN when decision!='transform' (§5)".into(),
            ))
        }
        _ => {}
    }

    let evidence = match obj.get("evidence") {
        None | Some(Value::Null) => None,
        Some(Value::Object(object)) => {
            require_members(object, &["artefact", "verification_pointers"])?;
            Some(
                serde_json::from_value::<Evidence>(obj["evidence"].clone())
                    .map_err(|e| (HostError::VerdictInvalid, format!("evidence: {e}")))?,
            )
        }
        Some(_) => {
            return Err((
                HostError::VerdictInvalid,
                "verdict.evidence must be an object".into(),
            ))
        }
    };
    if let Some(e) = &evidence {
        // §5.3 size cap: UTF-8 bytes of the canonical serialization of
        // the evidence member (as it propagates to the record).
        let v = serde_json::to_value(e)
            .map_err(|e| (HostError::VerdictInvalid, format!("evidence: {e}")))?;
        let n = crate::canonical::canonical_json(&v).len();
        if n > crate::types::EVIDENCE_MAX_BYTES {
            return Err((
                HostError::VerdictInvalid,
                format!(
                    "evidence canonical size {n} exceeds {} bytes (\u{00a7}5.3)",
                    crate::types::EVIDENCE_MAX_BYTES
                ),
            ));
        }
    }

    let result_labels = match obj.get("result_labels") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| {
                v.as_str().map(str::to_owned).ok_or((
                    HostError::VerdictInvalid,
                    "result_labels must be an array of strings".into(),
                ))
            })
            .collect::<Result<_, _>>()?,
        Some(_) => {
            return Err((
                HostError::VerdictInvalid,
                "result_labels must be an array of strings".into(),
            ))
        }
    };

    Ok(Verdict {
        decision,
        reason,
        message,
        warnings,
        approval,
        transform,
        evidence,
        result_labels,
    })
}

fn opt_string(
    obj: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, (HostError, String)> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err((
            HostError::VerdictInvalid,
            format!("verdict.{key} must be string or null"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn gate_and_apply_agree_on_path_language() {
        // near-miss roots the old prefix check accepted
        for (path, want) in [
            ("$targets.x", crate::types::HostError::TransformInvalid),
            ("$targetfoo", crate::types::HostError::TransformInvalid),
            (
                "$snapshot.x",
                crate::types::HostError::TransformTargetForbidden,
            ),
            ("$target.", crate::types::HostError::TransformInvalid),
        ] {
            let w = serde_json::json!({
                "decision": "transform",
                "transform": {"path": path, "value": 1}
            });
            let gate = from_wire(&w, SpecVersion::Draft).expect_err("gate must reject");
            assert_eq!(gate.0, want, "gate error for {path}");
            let apply = crate::path::parse(path).expect_err("parse must reject");
            assert_eq!(gate.0, apply, "gate/apply divergence for {path}");
        }
        // the accepted language still passes both layers
        for path in ["$target", "$target.a", "$target[0]", "$policy_target.a"] {
            let w = serde_json::json!({
                "decision": "transform",
                "transform": {"path": path, "value": 1}
            });
            assert!(
                from_wire(&w, SpecVersion::Draft).is_ok(),
                "gate rejects valid {path}"
            );
            assert!(crate::path::parse(path).is_ok());
        }
    }

    #[test]
    fn from_wire_allow() {
        let v = from_wire(&json!({"decision": "allow"}), SpecVersion::Draft).unwrap();
        assert_eq!(v.decision, Decision::Allow);
    }

    #[test]
    fn from_wire_transform_roundtrip() {
        let v = from_wire(
            &json!({
                "decision": "transform",
                "reason": "redact",
                "transform": {"path": "$target.url", "value": "x"},
                "result_labels": ["pii"]
            }),
            SpecVersion::Draft,
        )
        .unwrap();
        assert_eq!(v.decision, Decision::Transform);
        assert_eq!(v.transform.as_ref().unwrap().path, "$target.url");
        assert_eq!(v.result_labels, vec!["pii"]);
    }

    #[test]
    fn from_wire_rejects_bad_decision() {
        assert!(from_wire(&json!({"decision": "maybe"}), SpecVersion::Draft).is_err());
    }

    #[test]
    fn from_wire_rejects_removed_decisions() {
        // §5.1: warn and escalate are not wire decisions anymore.
        assert!(from_wire(&json!({"decision": "warn"}), SpecVersion::Draft).is_err());
        assert!(from_wire(&json!({"decision": "escalate"}), SpecVersion::Draft).is_err());
    }

    #[test]
    fn from_wire_liftable_deny() {
        let v = from_wire(
            &json!({"decision": "deny", "approval": {}}),
            SpecVersion::Draft,
        )
        .unwrap();
        assert!(v.is_liftable());
        let v = from_wire(&json!({"decision": "deny"}), SpecVersion::Draft).unwrap();
        assert!(!v.is_liftable());
    }

    #[test]
    fn from_wire_approval_only_on_deny() {
        assert!(from_wire(
            &json!({"decision": "allow", "approval": {}}),
            SpecVersion::Draft
        )
        .is_err());
        assert!(from_wire(
            &json!({"decision": "deny", "approval": []}),
            SpecVersion::Draft
        )
        .is_err());
    }

    #[test]
    fn from_wire_warnings() {
        let v = from_wire(
            &json!({
                "decision": "allow",
                "warnings": [{"reason": "pii", "message": "found ssn"}]
            }),
            SpecVersion::Draft,
        )
        .unwrap();
        assert_eq!(v.warnings.len(), 1);
        assert_eq!(v.warnings[0].reason.as_deref(), Some("pii"));
        assert!(from_wire(
            &json!({"decision": "allow", "warnings": ["x"]}),
            SpecVersion::Draft
        )
        .is_err());
        assert!(from_wire(
            &json!({
                "decision": "allow",
                "warnings": [{"reason": "host_error:x"}]
            }),
            SpecVersion::Draft
        )
        .is_err());
        // §6.3: the host-only warning namespace is refused the same way.
        let e = from_wire(
            &json!({
                "decision": "allow",
                "warnings": [{"reason": "host_warning:control_failed", "message": "spoof"}]
            }),
            SpecVersion::Draft,
        )
        .unwrap_err();
        assert_eq!(e.0, HostError::VerdictInvalid);
    }

    #[test]
    fn from_wire_rejects_host_error_reason() {
        let e = from_wire(
            &json!({"decision": "deny", "reason": "host_error:x"}),
            SpecVersion::Draft,
        )
        .unwrap_err();
        assert_eq!(e.0, HostError::VerdictInvalid);
    }

    #[test]
    fn from_wire_transform_body_required() {
        assert!(from_wire(&json!({"decision": "transform"}), SpecVersion::Draft).is_err());
    }

    #[test]
    fn from_wire_transform_body_forbidden() {
        assert!(from_wire(
            &json!({
                "decision": "allow",
                "transform": {"path": "$target.x", "value": 1}
            }),
            SpecVersion::Draft
        )
        .is_err());
    }

    #[test]
    fn evidence_over_cap_fails_wire_gate() {
        let big = "x".repeat(crate::types::EVIDENCE_MAX_BYTES + 1);
        let raw = serde_json::json!({
            "decision": "allow",
            "evidence": {"artefact": big}
        });
        let (e, d) = from_wire(&raw, SpecVersion::Draft).unwrap_err();
        assert_eq!(e, HostError::VerdictInvalid);
        assert!(d.contains("exceeds 10240"));
    }

    #[test]
    fn evidence_at_cap_passes() {
        // canonical form: {"artefact":"<pad>"} — 15 bytes of framing.
        let pad = "x".repeat(crate::types::EVIDENCE_MAX_BYTES - 15);
        let raw = serde_json::json!({
            "decision": "allow",
            "evidence": {"artefact": pad}
        });
        assert!(from_wire(&raw, SpecVersion::Draft).is_ok());
    }

    #[test]
    fn evidence_cap_enforced_by_struct_validate() {
        let v = crate::types::Verdict {
            evidence: Some(crate::types::Evidence {
                artefact: Some("x".repeat(crate::types::EVIDENCE_MAX_BYTES + 1)),
                verification_pointers: Default::default(),
            }),
            ..crate::types::Verdict::allow()
        };
        assert_eq!(
            v.validate(SpecVersion::Draft),
            Err(HostError::VerdictInvalid)
        );
    }

    #[test]
    fn warning_prefix_reservation_follows_the_specification_version() {
        let w = json!({"decision": "allow", "warnings": [{"reason": "host_warning:x"}]});
        let v = from_wire(&w, SpecVersion::V0_1).unwrap();
        assert_eq!(v.warnings[0].reason.as_deref(), Some("host_warning:x"));
        let e = from_wire(&w, SpecVersion::Draft).unwrap_err();
        assert_eq!(e.0, HostError::VerdictInvalid);
        assert!(e.1.contains("host_warning:*"), "{}", e.1);
        let w = json!({"decision": "allow", "warnings": [{"reason": "host_error:x"}]});
        for spec in SpecVersion::ALL {
            let e = from_wire(&w, *spec).unwrap_err();
            assert_eq!(e.0, HostError::VerdictInvalid, "{spec}");
        }
    }
}
