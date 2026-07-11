// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! Core types for AGENT-HOOKS-0.1 (§3, §5, §7, §8, §9, §10.3, §11).

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Spec version this crate implements (§4.1 `spec` field).
pub const SPEC_VERSION: &str = "agent-hooks/0.1";

/// Name of the default identity provider (§10.1, §10.2).
pub const JCS_SHA256: &str = "jcs-sha256";

/// The closed set of agent lifecycle interception points (§3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InterceptionPoint {
    AgentStartup,
    Input,
    PreModelCall,
    PostModelCall,
    PreToolCall,
    PostToolCall,
    Output,
    AgentShutdown,
}

impl InterceptionPoint {
    /// Wire name (snake_case).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AgentStartup => "agent_startup",
            Self::Input => "input",
            Self::PreModelCall => "pre_model_call",
            Self::PostModelCall => "post_model_call",
            Self::PreToolCall => "pre_tool_call",
            Self::PostToolCall => "post_tool_call",
            Self::Output => "output",
            Self::AgentShutdown => "agent_shutdown",
        }
    }

    /// Whether a `transform` verdict is permitted at this point (§3, §4.3).
    pub fn transform_permitted(self) -> bool {
        !matches!(self, Self::AgentStartup | Self::AgentShutdown)
    }
}

/// Verdict decision values (§5.1). Three, closed: `warn` is `allow` +
/// `warnings[]`; `escalate` is `deny` + an `approval` block.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    Deny,
    Transform,
}

impl Decision {
    /// Wire name (snake_case).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
            Self::Transform => "transform",
        }
    }

    /// Whether the action proceeds under this decision (§2 permit class).
    pub fn permits(self) -> bool {
        matches!(self, Self::Allow | Self::Transform)
    }
}

/// Whether the host acts on verdicts (§8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnforcementMode {
    Enforce,
    EvaluateOnly,
}

/// Reserved `host_error:*` reasons a host synthesizes (§11).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum HostError {
    #[error("host_error:context_invalid")]
    ContextInvalid,
    #[error("host_error:interceptor_failed")]
    InterceptorFailed,
    #[error("host_error:interceptor_timeout")]
    InterceptorTimeout,
    #[error("host_error:verdict_invalid")]
    VerdictInvalid,
    #[error("host_error:transform_invalid")]
    TransformInvalid,
    #[error("host_error:transform_target_forbidden")]
    TransformTargetForbidden,
    /// §7.5: two or more transforms against the same snapshot in a
    /// parallel profile.
    #[error("host_error:transform_conflict")]
    TransformConflict,
    /// §7.5: non-unanimous outcome under `parallel/unanimous`.
    #[error("host_error:composition_disagreement")]
    CompositionDisagreement,
    #[error("host_error:approval_resolver_failed")]
    ApprovalResolverFailed,
    #[error("host_error:approval_unresolved")]
    ApprovalUnresolved,
    /// §9 echo rule: the resolution's `context_identity` did not match
    /// the request's byte for byte.
    #[error("host_error:approval_identity_mismatch")]
    ApprovalIdentityMismatch,
    #[error("host_error:adapter_unsupported")]
    AdapterUnsupported,
    #[error("host_error:streaming_unsupported")]
    StreamingUnsupported,
    /// §7: an `enforce`-mode emission with zero registered interceptors
    /// fails closed rather than silently allowing everything.
    #[error("host_error:no_interceptor")]
    NoInterceptor,
}

/// A single `$target`-rooted replacement (§5.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transform {
    /// Path rooted at `$target` (or the deprecated `$policy_target` alias).
    pub path: String,
    /// New value to set at `path`. Serialized only when non-null: the
    /// §10.3 record projection drops it (target content); the §5 wire
    /// gate checks presence manually, so interceptor wire verdicts
    /// still require the member.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub value: Value,
}

/// Opaque pointer to an offline-verifiable artefact (§5.3).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Evidence {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artefact: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub verification_pointers: BTreeMap<String, String>,
}

/// §5.3: maximum UTF-8 byte length of the RFC 8785 canonical
/// serialization of the `evidence` member. Breach fails §5 validation
/// (`verdict_invalid`).
pub const EVIDENCE_MAX_BYTES: usize = 10240;

/// A recorded concern that does not affect control flow (§5.1).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Warning {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Interceptor return value (§5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Verdict {
    pub decision: Decision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Recorded concerns; permitted on any decision (§5.1).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<Warning>,
    /// Present only on `deny`: marks the deny as liftable by the
    /// approval seam (§9). MAY be empty; reserved for approver-facing
    /// parameters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval: Option<serde_json::Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transform: Option<Transform>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub result_labels: Vec<String>,
}

impl Verdict {
    /// The trivial permit verdict.
    pub const fn allow() -> Self {
        Self {
            decision: Decision::Allow,
            reason: None,
            message: None,
            warnings: Vec::new(),
            approval: None,
            transform: None,
            evidence: None,
            result_labels: Vec::new(),
        }
    }

    /// Constructor sugar for what earlier drafts called `warn`: an
    /// `allow` carrying one warning (§5.1).
    pub fn warn(reason: Option<String>, message: Option<String>) -> Self {
        Self {
            warnings: vec![Warning { reason, message }],
            ..Self::allow()
        }
    }

    /// Constructor sugar for what earlier drafts called `escalate`: a
    /// liftable deny — denied as-is unless the approval seam lifts it
    /// (§5.1, §9).
    pub fn escalate(reason: Option<String>, message: Option<String>) -> Self {
        Self {
            decision: Decision::Deny,
            reason,
            message,
            approval: Some(serde_json::Map::new()),
            ..Self::allow()
        }
    }

    /// Host-synthesized deny verdict for a §11 failure.
    pub fn host_error(err: HostError, message: Option<String>) -> Self {
        Self {
            decision: Decision::Deny,
            reason: Some(err.to_string()),
            message,
            ..Self::allow()
        }
    }

    /// Host-synthesized **liftable** deny (§7.5 `"approval"` knob
    /// value): the failure is consultable rather than final.
    pub fn host_error_liftable(err: HostError, message: Option<String>) -> Self {
        Self {
            approval: Some(serde_json::Map::new()),
            ..Self::host_error(err, message)
        }
    }

    /// A deny carrying an `approval` block (§5.1).
    pub fn is_liftable(&self) -> bool {
        self.decision == Decision::Deny && self.approval.is_some()
    }

    /// Validate per §5; returns `Err(HostError::VerdictInvalid)` on violation.
    pub fn validate(&self) -> Result<(), HostError> {
        if let Some(r) = &self.reason {
            if r.starts_with("host_error:") {
                return Err(HostError::VerdictInvalid);
            }
        }
        if self.approval.is_some() && self.decision != Decision::Deny {
            return Err(HostError::VerdictInvalid);
        }
        if let Some(e) = &self.evidence {
            // §5.3: measured as the UTF-8 byte length of the canonical
            // serialization of the evidence member.
            let v = serde_json::to_value(e).map_err(|_| HostError::VerdictInvalid)?;
            if crate::canonical::canonical_json(&v).len() > EVIDENCE_MAX_BYTES {
                return Err(HostError::VerdictInvalid);
            }
        }
        // NB: an or-pattern guard applies to every alternative, so the
        // two invalid shapes need separate arms (NOW-06).
        match (self.decision, &self.transform) {
            (Decision::Transform, None) => Err(HostError::VerdictInvalid),
            (d, Some(_)) if d != Decision::Transform => Err(HostError::VerdictInvalid),
            _ => Ok(()),
        }
    }
}

/// Wire-shaped agent context (§4). Use `serde_json::Map` so it round-trips to
/// the schema without translation; helpers in `canonical.rs` operate on it.
pub type AgentContext = serde_json::Map<String, Value>;

/// Payload-free per-interceptor summary on the record (§10.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VerdictSummary {
    pub index: u32,
    pub decision: Decision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Host-side record of one emission (§10.3).
///
/// Payload-free by design: the identities (when a provider is
/// declared) bind the record to the exact pre/post-composition context
/// without duplicating the (possibly sensitive) payload into audit
/// storage. `composition` makes the record interpretable without
/// out-of-band knowledge of host configuration.
#[derive(Debug, Clone, Serialize)]
pub struct InterceptionRecord {
    pub interception_point: InterceptionPoint,
    pub mode: EnforcementMode,
    /// The combined verdict (§7.3), possibly host-synthesized or
    /// approval-substituted.
    pub verdict: Verdict,
    /// Provider output before dispatch; `None` iff `identity_provider`
    /// is `None` (or the provider itself rejected the context).
    pub input_identity: Option<String>,
    /// Provider output after composition completes.
    pub enforced_identity: Option<String>,
    /// The declared identity provider (§10.1).
    pub identity_provider: Option<String>,
    /// `ctx.session.id` — correlates records across a session.
    pub session_id: String,
    /// `ctx.sequence` — total order of records within the session
    /// (§12.2.3). `-1` when the context lacked the required field.
    pub sequence: i64,
    /// Registration index of the interceptor whose verdict won the
    /// aggregation or whose liftable deny was consulted (§7.6). `None`
    /// for a pure-allow combination or a host-synthesized verdict.
    pub decided_by: Option<u32>,
    /// The composition profile and knobs in effect (§7.1).
    pub composition: crate::composition::CompositionConfig,
    /// Per-interceptor summary; populated in multi-verdict profiles
    /// (`sequential/run_all`, `parallel/*`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub verdicts: Vec<VerdictSummary>,
    /// `true` iff one or more registered interceptors were never
    /// invoked in this emission. Defined only for
    /// `sequential/first_deny` (§7.4).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fold_truncated: Option<bool>,
    /// `"approval"` iff an approval resolution substituted for a
    /// verdict in this emission (§7.6).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<&'static str>,
}

impl InterceptionRecord {
    /// Whether the guarded action executes (§6, §8).
    pub fn proceeds(&self) -> bool {
        matches!(self.mode, EnforcementMode::EvaluateOnly) || self.verdict.decision.permits()
    }
}

/// Interceptor protocol (§7).
#[async_trait]
pub trait Interceptor: Send + Sync {
    /// Receive an `AgentContext` and return a `Verdict`.
    async fn intercept(&self, context: &AgentContext) -> Verdict;
}

/// Approval resolver outcome (§9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalOutcome {
    Approve,
    Reject,
    Unresolved,
}

/// What the host hands the resolver when a profile consults the seam
/// (§9). `context_identity` is `None` when the identity provider is
/// `null` (§10.1) — the approval is then identity-unbound.
#[derive(Debug, Clone)]
pub struct ApprovalRequest<'a> {
    pub context_identity: Option<String>,
    pub interception_point: InterceptionPoint,
    pub verdict: &'a Verdict,
    pub context: &'a AgentContext,
}

/// What the resolver returns (§9). `context_identity` MUST echo the
/// request's byte for byte (`None` echoes as `None`).
#[derive(Debug, Clone)]
pub struct ApprovalResolution {
    pub outcome: ApprovalOutcome,
    pub context_identity: Option<String>,
    pub verdict: Option<Verdict>,
}

/// Host-registered resolver for liftable denies (§9).
#[async_trait]
pub trait ApprovalResolver: Send + Sync {
    /// Resolve a consultation. The returned resolution's
    /// `context_identity` MUST echo the request's (§9 echo rule).
    async fn resolve(&self, request: ApprovalRequest<'_>) -> ApprovalResolution;
}

#[cfg(test)]
mod verdict_validate_tests {
    use super::*;

    #[test]
    fn transform_without_body_invalid() {
        let v = Verdict {
            decision: Decision::Transform,
            ..Verdict::allow()
        };
        assert_eq!(v.validate(), Err(HostError::VerdictInvalid));
    }

    #[test]
    fn body_on_non_transform_invalid() {
        let v = Verdict {
            transform: Some(Transform {
                path: "$target.x".into(),
                value: serde_json::json!(1),
            }),
            ..Verdict::allow()
        };
        assert_eq!(v.validate(), Err(HostError::VerdictInvalid));
    }

    #[test]
    fn reserved_reason_invalid() {
        let v = Verdict {
            reason: Some("host_error:x".into()),
            ..Verdict::allow()
        };
        assert_eq!(v.validate(), Err(HostError::VerdictInvalid));
    }

    #[test]
    fn approval_only_on_deny() {
        let v = Verdict {
            approval: Some(serde_json::Map::new()),
            ..Verdict::allow()
        };
        assert_eq!(v.validate(), Err(HostError::VerdictInvalid));
        assert!(Verdict::escalate(None, None).validate().is_ok());
        assert!(Verdict::escalate(None, None).is_liftable());
    }

    #[test]
    fn warn_sugar_is_allow_with_warning() {
        let v = Verdict::warn(Some("pii".into()), None);
        assert_eq!(v.decision, Decision::Allow);
        assert_eq!(v.warnings.len(), 1);
        assert!(v.validate().is_ok());
    }
}
