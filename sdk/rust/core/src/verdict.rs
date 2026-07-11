// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! Verdict wire normalization (§5).

use crate::types::{Decision, Evidence, HostError, Transform, Verdict, Warning};
use serde_json::Value;

/// Parse and validate an interceptor's wire return value into a `Verdict`
/// per §5. Any violation yields `HostError::VerdictInvalid` with a detail
/// message; the caller synthesizes the `deny` verdict.
pub fn from_wire(raw: &Value) -> Result<Verdict, (HostError, String)> {
    let obj = raw
        .as_object()
        .ok_or((HostError::VerdictInvalid, "verdict must be a JSON object".into()))?;

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
                    let reason = match m.get("reason") {
                        None | Some(Value::Null) => None,
                        Some(Value::String(s)) if !s.starts_with("host_error:") => {
                            Some(s.clone())
                        }
                        _ => {
                            return Err((
                                HostError::VerdictInvalid,
                                "warnings[].reason must be a non-reserved string".into(),
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
            let path = t
                .get("path")
                .and_then(Value::as_str)
                .ok_or((HostError::VerdictInvalid, "transform.path missing".into()))?;
            if !(path.starts_with("$target") || path.starts_with("$policy_target")) {
                return Err((
                    HostError::TransformTargetForbidden,
                    format!("transform.path must be rooted at $target (got {path:?})"),
                ));
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
        Some(Value::Object(_)) => Some(
            serde_json::from_value::<Evidence>(obj["evidence"].clone())
                .map_err(|e| (HostError::VerdictInvalid, format!("evidence: {e}")))?,
        ),
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
    fn from_wire_allow() {
        let v = from_wire(&json!({"decision": "allow"})).unwrap();
        assert_eq!(v.decision, Decision::Allow);
    }

    #[test]
    fn from_wire_transform_roundtrip() {
        let v = from_wire(&json!({
            "decision": "transform",
            "reason": "redact",
            "transform": {"path": "$target.url", "value": "x"},
            "result_labels": ["pii"]
        }))
        .unwrap();
        assert_eq!(v.decision, Decision::Transform);
        assert_eq!(v.transform.as_ref().unwrap().path, "$target.url");
        assert_eq!(v.result_labels, vec!["pii"]);
    }

    #[test]
    fn from_wire_rejects_bad_decision() {
        assert!(from_wire(&json!({"decision": "maybe"})).is_err());
    }

    #[test]
    fn from_wire_rejects_removed_decisions() {
        // §5.1: warn and escalate are not wire decisions anymore.
        assert!(from_wire(&json!({"decision": "warn"})).is_err());
        assert!(from_wire(&json!({"decision": "escalate"})).is_err());
    }

    #[test]
    fn from_wire_liftable_deny() {
        let v = from_wire(&json!({"decision": "deny", "approval": {}})).unwrap();
        assert!(v.is_liftable());
        let v = from_wire(&json!({"decision": "deny"})).unwrap();
        assert!(!v.is_liftable());
    }

    #[test]
    fn from_wire_approval_only_on_deny() {
        assert!(from_wire(&json!({"decision": "allow", "approval": {}})).is_err());
        assert!(from_wire(&json!({"decision": "deny", "approval": []})).is_err());
    }

    #[test]
    fn from_wire_warnings() {
        let v = from_wire(&json!({
            "decision": "allow",
            "warnings": [{"reason": "pii", "message": "found ssn"}]
        }))
        .unwrap();
        assert_eq!(v.warnings.len(), 1);
        assert_eq!(v.warnings[0].reason.as_deref(), Some("pii"));
        assert!(from_wire(&json!({"decision": "allow", "warnings": ["x"]})).is_err());
        assert!(from_wire(&json!({
            "decision": "allow",
            "warnings": [{"reason": "host_error:x"}]
        }))
        .is_err());
    }

    #[test]
    fn from_wire_rejects_host_error_reason() {
        let e = from_wire(&json!({"decision": "deny", "reason": "host_error:x"})).unwrap_err();
        assert_eq!(e.0, HostError::VerdictInvalid);
    }

    #[test]
    fn from_wire_transform_body_required() {
        assert!(from_wire(&json!({"decision": "transform"})).is_err());
    }

    #[test]
    fn from_wire_transform_body_forbidden() {
        assert!(from_wire(&json!({
            "decision": "allow",
            "transform": {"path": "$target.x", "value": 1}
        }))
        .is_err());
    }

    #[test]
    fn evidence_over_cap_fails_wire_gate() {
        let big = "x".repeat(crate::types::EVIDENCE_MAX_BYTES + 1);
        let raw = serde_json::json!({
            "decision": "allow",
            "evidence": {"artefact": big}
        });
        let (e, d) = from_wire(&raw).unwrap_err();
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
        assert!(from_wire(&raw).is_ok());
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
        assert_eq!(v.validate(), Err(HostError::VerdictInvalid));
    }
}
