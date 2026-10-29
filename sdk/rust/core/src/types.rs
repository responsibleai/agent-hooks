// Copyright (c) Microsoft. All rights reserved.

//! Core types for AGENT-HOOKS-0.1 (§3, §5, §7, §8, §9, §10.3, §11).

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;

/// Spec version this crate implements (§4.1 `spec` field).
pub const SPEC_VERSION: &str = "agent-hooks/0.1";

/// Name of the default identity provider (§10.1, §10.2).
pub const JCS_SHA256: &str = "jcs-sha256";

/// The host declaration contract version this crate writes and
/// accepts (§7.7.2). Independent of [`SPEC_VERSION`] (the wire
/// contract) and of the package version. 1.1 adds the optional
/// `on_error` members (§6.3, §7.7.5); a document without them keeps
/// its 1.0 meaning.
pub const DECLARATION_VERSION: &str = "agent-hooks-declaration/1.1";

/// The previous minor, still accepted (§7.7.2).
const DECLARATION_1_0: &str = "agent-hooks-declaration/1.0";

/// Every declaration contract version this crate's loader accepts
/// (§7.7.2), oldest first. A document carrying any other
/// `declaration` value is refused with
/// `declaration_error:version_unsupported`.
pub const SUPPORTED_DECLARATION_VERSIONS: &[&str] = &[DECLARATION_1_0, DECLARATION_VERSION];

/// §10.1 host-defined identity-provider name rules: must match
/// `^[a-z][a-z0-9_-]*$` and must not begin with `jcs` (reserved so a
/// custom provider cannot claim golden-vector semantics).
pub fn validate_provider_name(name: &str) -> Result<(), (HostError, String)> {
    let mut chars = name.chars();
    let head_ok = chars.next().is_some_and(|c| c.is_ascii_lowercase());
    let rest_ok =
        chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
    if !head_ok || !rest_ok {
        return Err((
            HostError::ContextInvalid,
            "identity provider name must match ^[a-z][a-z0-9_-]*$ (see spec 10.1)".into(),
        ));
    }
    if name.starts_with("jcs") {
        return Err((
            HostError::ContextInvalid,
            "identity provider names beginning with 'jcs' are reserved (see spec 10.1)".into(),
        ));
    }
    Ok(())
}

/// The closed set of agent lifecycle interception points (§3).
///
/// `Ord` follows declaration order, which is the §3 lifecycle order
/// (`agent_startup` < `input` < … < `agent_shutdown`) — NOT
/// lexicographic wire-name order. `Display` prints the wire name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
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

impl fmt::Display for InterceptionPoint {
    /// The wire name (`pre_tool_call`, …).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
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

impl HostError {
    /// Whether this is one of the three interceptor failures that
    /// `on_error` covers (§6.3): the interceptor raised or panicked,
    /// exceeded its timeout, or returned a value that fails §5
    /// validation. Every other reason stays fail closed with no knob.
    pub fn is_control_failure(self) -> bool {
        matches!(
            self,
            Self::InterceptorFailed | Self::InterceptorTimeout | Self::VerdictInvalid
        )
    }

    /// Parse a `host_error:*` wire string back to its variant.
    pub fn from_wire(s: &str) -> Option<Self> {
        const ALL: [HostError; 14] = [
            HostError::ContextInvalid,
            HostError::InterceptorFailed,
            HostError::InterceptorTimeout,
            HostError::VerdictInvalid,
            HostError::TransformInvalid,
            HostError::TransformTargetForbidden,
            HostError::TransformConflict,
            HostError::CompositionDisagreement,
            HostError::ApprovalResolverFailed,
            HostError::ApprovalUnresolved,
            HostError::ApprovalIdentityMismatch,
            HostError::AdapterUnsupported,
            HostError::StreamingUnsupported,
            HostError::NoInterceptor,
        ];
        ALL.into_iter().find(|e| e.to_string() == s)
    }
}

/// Reserved `host_warning:*` reasons a host synthesizes (§6.3,
/// `spec/reserved-warnings.json`). Interceptors MUST NOT emit them;
/// the §5 gate refuses such a verdict as `verdict_invalid`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum HostWarning {
    /// A registration whose `on_error` is `continue` failed and the
    /// host substituted an allow for its slot.
    #[error("host_warning:control_failed")]
    ControlFailed,
}

/// What a registration does when its interceptor fails (§6.3): the
/// three covered failures are a raise or panic, a timeout and a
/// §5-invalid return value. `Deny` is the default and the fail-closed
/// posture; `Continue` substitutes an allow carrying
/// `host_warning:control_failed` in the failing registration's
/// composition slot, records the underlying reason and tells the
/// principal. Nothing else is affected by this setting.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnError {
    #[default]
    Deny,
    Continue,
}

impl OnError {
    /// Wire name (`deny` | `continue`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Deny => "deny",
            Self::Continue => "continue",
        }
    }

    /// Parse a wire name; `None` outside the closed set.
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "deny" => Some(Self::Deny),
            "continue" => Some(Self::Continue),
            _ => None,
        }
    }
}

/// What the host tells the principal when a control failed and the
/// action continued (§6.3). Payload-free: the binding label, the
/// reserved reason and the host-synthesized message; never context
/// or target content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlFailureNotice {
    /// The interception point of the emission, when the context
    /// carried a parseable one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interception_point: Option<InterceptionPoint>,
    /// Dispatch index of the failing registration (`verdicts[].index`).
    pub index: u32,
    /// The registration name (a declaration binding id) or
    /// `interceptor-<index>` for an unnamed code registration.
    pub binding: String,
    /// The underlying `host_error:*` reason, also recorded as
    /// `verdicts[].substituted_for`.
    pub reason: String,
    /// The warning message: `<binding>: <reason>; host continued`.
    pub message: String,
}

/// Host callback that tells the principal a control failed and the
/// action continued (§6.3). Shared by every emitter a registry builds.
pub type ControlFailureNotifier = std::sync::Arc<dyn Fn(&ControlFailureNotice) + Send + Sync>;

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
#[serde(deny_unknown_fields)]
pub struct Evidence {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artefact: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub verification_pointers: BTreeMap<String, String>,
}

/// AGENT-HOOKS-0.1 §5.3 evidence cap: the maximum UTF-8 byte length
/// of the RFC 8785 canonical serialization of the `evidence` member
/// (measure with [`canonical_json`](crate::canonical_json)).
/// [`Verdict::validate`] and the §5 wire gate enforce it; a breach is
/// `verdict_invalid`. Re-exported at the crate root so a consumer can
/// check evidence size before validation instead of hard-coding the
/// number.
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

    /// Constructor sugar for a plain, final deny: no `approval` block,
    /// so the approval seam cannot lift it (§5.1).
    pub fn deny(reason: Option<String>, message: Option<String>) -> Self {
        Self {
            decision: Decision::Deny,
            reason,
            message,
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

    /// The message of the §6.3 substituted allow and of the principal
    /// notice: `<binding>: <host_error reason>; host continued`. Built
    /// from the registration label and the reserved reason only, so it
    /// never carries target-derived content.
    pub fn control_failure_message(binding: &str, reason: HostError) -> String {
        format!("{binding}: {reason}; host continued")
    }

    /// The allow the host substitutes for a failing registration whose
    /// `on_error` is `continue` (§6.3): decision `allow`, one warning
    /// with reason `host_warning:control_failed`, nothing else.
    /// `reason` MUST be one of the three covered failures
    /// ([`HostError::is_control_failure`]).
    pub fn control_failure_substitute(binding: &str, reason: HostError) -> Self {
        debug_assert!(reason.is_control_failure());
        Self::warn(
            Some(HostWarning::ControlFailed.to_string()),
            Some(Self::control_failure_message(binding, reason)),
        )
    }

    /// Whether this verdict is exactly the shape
    /// [`Self::control_failure_substitute`] produces. The FFI
    /// aggregation gate lets that host shape through where an
    /// interceptor-returned `host_warning:*` would be refused.
    pub fn is_control_failure_substitute(&self) -> bool {
        self.decision == Decision::Allow
            && self.reason.is_none()
            && self.message.is_none()
            && self.approval.is_none()
            && self.transform.is_none()
            && self.evidence.is_none()
            && self.result_labels.is_empty()
            && self.warnings.len() == 1
            && self.warnings[0].reason.as_deref() == Some("host_warning:control_failed")
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
        // §6.3: `host_warning:*` is reserved for the host, like
        // `host_error:*`; an interceptor that emits either spoofs a
        // host substitution.
        if self.warnings.iter().any(|w| {
            w.reason
                .as_deref()
                .is_some_and(|r| r.starts_with("host_error:") || r.starts_with("host_warning:"))
        }) {
            return Err(HostError::VerdictInvalid);
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
        // two invalid shapes need separate arms (an or-pattern guard
        // once let transform-without-body through).
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

/// W3C Trace Context correlation echoed onto the record from the
/// context's optional `trace` block (§4.5, §10.3). Payload-free:
/// identifiers only. Lets audit/SIEM sinks join records to OTel
/// spans without host-side stitching.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraceContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
}

/// Payload-free per-interceptor summary on the record (§10.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VerdictSummary {
    pub index: u32,
    pub decision: Decision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Host-chosen registration name for the interceptor at `index`
    /// (§10.3). Payload-free: an identifier, never verdict/target
    /// content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Present iff the host substituted an allow for this
    /// registration's failure under `on_error: continue` (§6.3,
    /// §10.3): the underlying `host_error:*` reason, so an auditor can
    /// count continuations and see their cause.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub substituted_for: Option<String>,
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
    /// RFC 3339 instant copied from `ctx.timestamp` (§10.3); absent
    /// when the context lacked the field. Gives audit/SIEM sinks an
    /// event time without payload duplication.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    /// Trace correlation echoed from the context's optional `trace`
    /// block (§4.5); absent when the context carried none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace: Option<TraceContext>,
    /// Registration index of the interceptor whose verdict won the
    /// aggregation or whose liftable deny was consulted (§7.6). `None`
    /// for a pure-allow combination or a host-synthesized verdict.
    pub decided_by: Option<u32>,
    /// The composition profile and knobs in effect (§7.1).
    pub composition: crate::composition::CompositionConfig,
    /// The host declaration contract version the emitter was built
    /// from (§7.7.8), e.g. `agent-hooks-declaration/1.0`. Present iff
    /// the emitter was constructed from a declaration document;
    /// absent for an emitter configured in code. One closed-grammar
    /// string, so payload-free by construction.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub declaration: Option<String>,
    /// Per-interceptor summary; populated in multi-verdict profiles
    /// (`sequential/run_all`, `parallel/*`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub verdicts: Vec<VerdictSummary>,
    /// `true` iff one or more registered interceptors were never
    /// invoked in this emission (short-circuit, approval-stop, or a
    /// failed fold-transform). Defined for the sequential profiles
    /// (§7.4).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fold_truncated: Option<bool>,
    /// Consultation outcome (§7.6, §10.3): `"approval"` iff a permit
    /// resolution substituted for a verdict; `"rejection"` iff the
    /// seam was consulted and did **not** lift the deny (reject,
    /// unresolved, resolver failure, or echo violation); absent iff
    /// the seam was never consulted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<&'static str>,
    /// Number of interceptors registered at emission time (§10.3) —
    /// lets a record reader detect skipped interceptors without host
    /// configuration.
    pub interceptors_registered: u32,
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

    /// Optional host-chosen identifier recorded on `verdicts[].name`
    /// (§10.3). MUST be payload-free.
    fn name(&self) -> Option<String> {
        None
    }
}

/// Typed completion of a [`ManagedInterceptor`] (§6.3, timeout
/// ownership). `Timeout` is reported only after the interceptor has
/// cancelled and cleaned up its external work; `Cancelled` is never a
/// timeout and never continues.
#[derive(Debug, Clone, PartialEq)]
pub enum ManagedInterceptorOutcome {
    /// A verdict; it crosses the same §5 gate as any interceptor's.
    Verdict(Box<Verdict>),
    /// The work exceeded the resolved bound and has been cleaned up.
    /// Recorded as `host_error:interceptor_timeout`; eligible for
    /// `on_error: continue`.
    Timeout,
    /// The host or runtime cancelled the emission. Recorded as
    /// `host_error:interceptor_failed`; a cancelled outcome never
    /// continues, whatever `on_error` says.
    Cancelled,
    /// The work failed. The optional detail is payload-free (an error
    /// type name, never content). Recorded as
    /// `host_error:interceptor_failed`; eligible for `continue`.
    Failed(Option<String>),
}

/// An interceptor that owns external work (a process, an HTTP call)
/// and therefore its own deadline (§6.3). The emitter does not wrap it
/// in the outer timer; instead it hands the interceptor the resolved
/// bound for the registration, and the interceptor MUST cancel and
/// clean up the work before it reports [`ManagedInterceptorOutcome::Timeout`].
#[async_trait]
pub trait ManagedInterceptor: Send + Sync {
    /// Run against `context` under `bound` (`None` is unbounded) and
    /// report a typed outcome.
    async fn intercept_managed(
        &self,
        context: &AgentContext,
        bound: Option<std::time::Duration>,
    ) -> ManagedInterceptorOutcome;

    /// Optional host-chosen identifier recorded on `verdicts[].name`
    /// (§10.3). MUST be payload-free.
    fn name(&self) -> Option<String> {
        None
    }
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
    fn reserved_warning_reasons_invalid_for_interceptors() {
        for reason in [
            "host_warning:control_failed",
            "host_warning:x",
            "host_error:x",
        ] {
            let v = Verdict::warn(Some(reason.into()), None);
            assert_eq!(v.validate(), Err(HostError::VerdictInvalid), "{reason}");
        }
        assert!(Verdict::warn(Some("host_warnings".into()), None)
            .validate()
            .is_ok());
    }

    #[test]
    fn control_failure_substitute_shape() {
        let v = Verdict::control_failure_substitute("egress", HostError::InterceptorTimeout);
        assert_eq!(v.decision, Decision::Allow);
        assert_eq!(v.warnings.len(), 1);
        assert_eq!(
            v.warnings[0].reason.as_deref(),
            Some("host_warning:control_failed")
        );
        assert_eq!(
            v.warnings[0].message.as_deref(),
            Some("egress: host_error:interceptor_timeout; host continued")
        );
        assert!(v.is_control_failure_substitute());
        assert!(!Verdict::allow().is_control_failure_substitute());
        let labelled = Verdict {
            result_labels: vec!["l".into()],
            ..Verdict::control_failure_substitute("egress", HostError::InterceptorTimeout)
        };
        assert!(!labelled.is_control_failure_substitute());
        // The host shape is reserved: an interceptor returning it fails
        // the gate.
        assert_eq!(v.validate(), Err(HostError::VerdictInvalid));
        assert!(HostError::InterceptorFailed.is_control_failure());
        assert!(HostError::InterceptorTimeout.is_control_failure());
        assert!(HostError::VerdictInvalid.is_control_failure());
        assert!(!HostError::ContextInvalid.is_control_failure());
        assert!(!HostError::ApprovalResolverFailed.is_control_failure());
        assert_eq!(
            HostError::from_wire("host_error:no_interceptor"),
            Some(HostError::NoInterceptor)
        );
        assert_eq!(HostError::from_wire("host_error:nope"), None);
        assert_eq!(OnError::default(), OnError::Deny);
        assert_eq!(OnError::from_wire("continue"), Some(OnError::Continue));
        assert_eq!(OnError::from_wire("allow"), None);
    }

    #[test]
    fn warn_sugar_is_allow_with_warning() {
        let v = Verdict::warn(Some("pii".into()), None);
        assert_eq!(v.decision, Decision::Allow);
        assert_eq!(v.warnings.len(), 1);
        assert!(v.validate().is_ok());
    }

    #[test]
    fn deny_sugar_is_final_deny() {
        let v = Verdict::deny(Some("policy".into()), Some("blocked".into()));
        assert_eq!(v.decision, Decision::Deny);
        assert_eq!(v.reason.as_deref(), Some("policy"));
        assert_eq!(v.message.as_deref(), Some("blocked"));
        assert!(!v.is_liftable());
        assert!(v.validate().is_ok());
    }
    #[test]
    fn provider_name_rules() {
        assert!(validate_provider_name("myco-hasher").is_ok());
        assert!(validate_provider_name("a1_b-c").is_ok());
        assert!(validate_provider_name("jcs-sha256").is_err()); // reserved
        assert!(validate_provider_name("jcsx").is_err());
        assert!(validate_provider_name("Bad").is_err());
        assert!(validate_provider_name("1abc").is_err());
        assert!(validate_provider_name("").is_err());
    }
}
