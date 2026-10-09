// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! Host declaration document (§7.7): loader, validation, resolution
//! and the host registry it resolves against.
//!
//! A declaration is one JSON object that fixes a host's configuration
//! (§7.1, §8, §10.1, §13.1), its declared surface (§13.1) and its
//! interceptor bindings. The document is a versioned contract of its
//! own (`agent-hooks-declaration/<major>.<minor>`, §7.7.2), separate
//! from the wire version [`SPEC_VERSION`] and from the package
//! version.
//!
//! Loading is a pipeline (§7.7.6). Every step runs only when the one
//! before it passed, so a given document yields exactly one refusal
//! class on every SDK:
//!
//! | Step | Where | Check | Class |
//! | --- | --- | --- | --- |
//! | 1 | [`HostDeclaration::from_path`] | regular file, size, UTF-8 | `unreadable` |
//! | 2 | [`HostDeclaration::from_json`] | JSON object, no duplicate keys, depth | `malformed` |
//! | 3 | same | `declaration` in the accepted set | `version_unsupported` |
//! | 4 | same | `spec` compatible with the loader | `spec_unsupported` |
//! | 5 | same | no unknown member at a closed level | `unknown_field` |
//! | 6 | same | types, enums, patterns, ranges | `invalid_field` |
//! | 7 | same, and again in [`resolve`] with the filled surface for the floor, pairs and `at` | internal consistency; the composition against a stated `surface.profiles` | `inconsistent` |
//! | 8 | [`resolve`] | surface and configuration, the configured composition included, honoured by the host's [`HostSurface`] | `surface_unsupported` |
//! | 9 | [`resolve`] | named provider, resolver and redactor registered | `reference_unresolved` |
//! | 10 | [`resolve`] | every binding kind registered | `kind_unknown` |
//! | 11 | `InterceptionEmitter::from_declaration` | kind resolvers run | `binding_rejected` |
//!
//! Refusals are construction errors ([`DeclarationError`]), never
//! verdicts: no emitter exists yet, so there is no record to carry a
//! §11 reason. The eleven classes are inventoried in
//! `spec/declaration-errors.json`.
//!
//! Nothing in the pipeline drops, clears or defaults a member the
//! document stated. Defaults fill absent members only, and a document
//! whose stated members the host cannot honour is refused whole.

use crate::canonical;
use crate::composition::{
    knob_default, knob_values, CompositionConfig, CompositionProfile, OnApproval, SynthesisPolicy,
};
use crate::types::{
    validate_provider_name, AgentContext, ApprovalResolver, EnforcementMode, InterceptionPoint,
    Interceptor, DECLARATION_VERSION, JCS_SHA256, SPEC_VERSION, SUPPORTED_DECLARATION_VERSIONS,
};
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

// ---- fixed bounds (§7.7.6) ---------------------------------------------------

/// Largest document the text paths accept, in bytes.
pub const MAX_DOCUMENT_BYTES: usize = 1 << 20;
/// Deepest container nesting (the root object is depth 1).
pub const MAX_DEPTH: usize = 32;
/// Most bindings one document may carry.
pub const MAX_BINDINGS: usize = 256;
/// Longest binding `id`, reference name and document `id`.
pub const MAX_ID_LEN: usize = 64;
/// Longest binding `kind`.
pub const MAX_KIND_LEN: usize = 128;
/// Longest `exposure_bound` and longest refusal detail.
pub const MAX_DETAIL_LEN: usize = 512;
/// Largest timeout, in milliseconds (one hour).
pub const MAX_TIMEOUT_MS: u64 = 3_600_000;
/// Smallest declared surface: the §3.2 lifecycle floor.
pub const FLOOR_POINTS: [InterceptionPoint; 4] = [
    InterceptionPoint::AgentStartup,
    InterceptionPoint::Input,
    InterceptionPoint::Output,
    InterceptionPoint::AgentShutdown,
];

/// The closed capability vocabulary a surface may name (§13.1,
/// `conformance/vectors.schema.json`). `buffered_output` is a value,
/// not a presence, and travels as the boolean surface member instead.
pub const CAPABILITIES: &[&str] = &[
    "model_calls",
    "tool_calls",
    "parallel_tool_calls",
    "streaming",
    "multi_turn",
    "int64_json",
    "bigint_json",
    "incremental_output",
    "host_declaration",
];

const ALL_POINTS: [InterceptionPoint; 8] = [
    InterceptionPoint::AgentStartup,
    InterceptionPoint::Input,
    InterceptionPoint::PreModelCall,
    InterceptionPoint::PostModelCall,
    InterceptionPoint::PreToolCall,
    InterceptionPoint::PostToolCall,
    InterceptionPoint::Output,
    InterceptionPoint::AgentShutdown,
];
const RESERVED_KIND_SEGMENTS: [&str; 2] = ["agent_hooks", "ctk"];

// ---- errors ------------------------------------------------------------------

/// The eleven refusal classes (§7.7.6), in pipeline order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeclarationErrorClass {
    Unreadable,
    Malformed,
    VersionUnsupported,
    SpecUnsupported,
    UnknownField,
    InvalidField,
    Inconsistent,
    SurfaceUnsupported,
    ReferenceUnresolved,
    KindUnknown,
    BindingRejected,
}

impl DeclarationErrorClass {
    /// Every class, in pipeline order.
    pub const ALL: [Self; 11] = [
        Self::Unreadable,
        Self::Malformed,
        Self::VersionUnsupported,
        Self::SpecUnsupported,
        Self::UnknownField,
        Self::InvalidField,
        Self::Inconsistent,
        Self::SurfaceUnsupported,
        Self::ReferenceUnresolved,
        Self::KindUnknown,
        Self::BindingRejected,
    ];

    /// The bare class name (`unknown_field`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unreadable => "unreadable",
            Self::Malformed => "malformed",
            Self::VersionUnsupported => "version_unsupported",
            Self::SpecUnsupported => "spec_unsupported",
            Self::UnknownField => "unknown_field",
            Self::InvalidField => "invalid_field",
            Self::Inconsistent => "inconsistent",
            Self::SurfaceUnsupported => "surface_unsupported",
            Self::ReferenceUnresolved => "reference_unresolved",
            Self::KindUnknown => "kind_unknown",
            Self::BindingRejected => "binding_rejected",
        }
    }

    /// The namespaced code (`declaration_error:unknown_field`).
    pub fn code(self) -> &'static str {
        match self {
            Self::Unreadable => "declaration_error:unreadable",
            Self::Malformed => "declaration_error:malformed",
            Self::VersionUnsupported => "declaration_error:version_unsupported",
            Self::SpecUnsupported => "declaration_error:spec_unsupported",
            Self::UnknownField => "declaration_error:unknown_field",
            Self::InvalidField => "declaration_error:invalid_field",
            Self::Inconsistent => "declaration_error:inconsistent",
            Self::SurfaceUnsupported => "declaration_error:surface_unsupported",
            Self::ReferenceUnresolved => "declaration_error:reference_unresolved",
            Self::KindUnknown => "declaration_error:kind_unknown",
            Self::BindingRejected => "declaration_error:binding_rejected",
        }
    }

    /// Parse a namespaced code or a bare class name.
    pub fn from_code(s: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|c| c.code() == s || c.as_str() == s)
    }
}

impl fmt::Display for DeclarationErrorClass {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

/// One problem a load step found: a JSON pointer into the document
/// (`/bindings/1/kind`; the empty string is the root) and a detail
/// that names members, kinds and ids but never binding configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    pub pointer: String,
    pub detail: String,
}

/// A refused declaration (§7.7.6). Carries one class, every finding
/// that step produced and, for `version_unsupported`, the accepted
/// version set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeclarationError {
    pub class: DeclarationErrorClass,
    pub findings: Vec<Finding>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accepted: Vec<String>,
}

impl DeclarationError {
    /// One finding under `class`.
    pub fn new(
        class: DeclarationErrorClass,
        pointer: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            class,
            findings: vec![Finding {
                pointer: pointer.into(),
                detail: truncate(detail.into()),
            }],
            accepted: Vec::new(),
        }
    }

    fn many(class: DeclarationErrorClass, findings: Vec<Finding>) -> Self {
        Self {
            class,
            findings,
            accepted: Vec::new(),
        }
    }

    fn version(detail: impl Into<String>) -> Self {
        Self {
            class: DeclarationErrorClass::VersionUnsupported,
            findings: vec![Finding {
                pointer: "/declaration".into(),
                detail: truncate(format!(
                    "{}; accepted: {}",
                    detail.into(),
                    SUPPORTED_DECLARATION_VERSIONS.join(", ")
                )),
            }],
            accepted: SUPPORTED_DECLARATION_VERSIONS
                .iter()
                .map(|s| (*s).to_owned())
                .collect(),
        }
    }

    /// The namespaced code (`declaration_error:<class>`), the value
    /// that crosses the FFI in `AhResult.error_code`.
    pub fn code(&self) -> &'static str {
        self.class.code()
    }

    /// The FFI detail: `{"findings": [...], "accepted": [...]}`.
    pub fn detail_json(&self) -> String {
        serde_json::json!({ "findings": self.findings, "accepted": self.accepted }).to_string()
    }
}

impl fmt::Display for DeclarationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.class.code())?;
        for (i, finding) in self.findings.iter().enumerate() {
            let sep = if i == 0 { ": " } else { "; " };
            if finding.pointer.is_empty() {
                write!(f, "{sep}{}", finding.detail)?;
            } else {
                write!(f, "{sep}{}: {}", finding.pointer, finding.detail)?;
            }
        }
        Ok(())
    }
}

impl std::error::Error for DeclarationError {}

/// A host registry programming error (duplicate or reserved name).
/// Distinct from [`DeclarationError`]: the document is not at fault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryError {
    pub detail: String,
}

impl fmt::Display for RegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "host registry: {}", self.detail)
    }
}

impl std::error::Error for RegistryError {}

/// Bound a detail at [`MAX_DETAIL_LEN`] characters, the ellipsis
/// included, so a truncated detail never exceeds the §7.7.3 bound.
fn truncate(s: String) -> String {
    if s.chars().count() <= MAX_DETAIL_LEN {
        return s;
    }
    let mut out: String = s.chars().take(MAX_DETAIL_LEN - 1).collect();
    out.push('…');
    out
}

/// RFC 6901 pointer segment escaping.
fn ptr(parent: &str, key: &str) -> String {
    format!("{parent}/{}", key.replace('~', "~0").replace('/', "~1"))
}

// ---- surface and registry ----------------------------------------------------

/// What the host does with the run after a `host_error:*` deny at the
/// tool seam (§6.2, §13.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolSeamPosture {
    Continue,
    Terminate,
}

impl ToolSeamPosture {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Continue => "continue",
            Self::Terminate => "terminate",
        }
    }
}

/// Whether this build can bound interceptor and resolver execution
/// (§7). The Rust core bounds only with the `tokio-timeout` feature;
/// the wrapper SDKs always bound.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeoutSupport {
    Bounded,
    Unbounded,
}

/// The knob values a host supports for one profile (§13.1 "profiles
/// and knob values supported"). Only the knobs the profile consults
/// are present; an empty set for a consulted knob is never valid.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KnobSupport {
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub on_approval: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub on_disagreement: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub on_transform_conflict: BTreeSet<String>,
}

impl KnobSupport {
    /// Every value of every knob the profile consults.
    pub fn full(profile: CompositionProfile) -> Self {
        let mut k = Self::default();
        for knob in profile.consulted_knobs() {
            *k.knob_mut(knob) = knob_values(knob).iter().map(|v| (*v).to_owned()).collect();
        }
        k
    }

    /// The §7.2 default value only, for every knob the profile consults.
    pub fn defaults_only(profile: CompositionProfile) -> Self {
        let mut k = Self::default();
        for knob in profile.consulted_knobs() {
            if let Some(d) = knob_default(knob) {
                k.knob_mut(knob).insert(d.to_owned());
            }
        }
        k
    }

    fn knob(&self, knob: &str) -> &BTreeSet<String> {
        match knob {
            "on_approval" => &self.on_approval,
            "on_disagreement" => &self.on_disagreement,
            _ => &self.on_transform_conflict,
        }
    }

    fn knob_mut(&mut self, knob: &str) -> &mut BTreeSet<String> {
        match knob {
            "on_approval" => &mut self.on_approval,
            "on_disagreement" => &mut self.on_disagreement,
            _ => &mut self.on_transform_conflict,
        }
    }

    /// Whether `self` names only knob values `other` also names.
    fn subset_of(&self, other: &Self) -> bool {
        self.on_approval.is_subset(&other.on_approval)
            && self.on_disagreement.is_subset(&other.on_disagreement)
            && self
                .on_transform_conflict
                .is_subset(&other.on_transform_conflict)
    }
}

/// What the host's code can honour (§7.7.4, §13.1): the one value the
/// loader checks a document against and the CTK derives the harness
/// surface from. A document may select a subset of this, never more.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostSurface {
    /// Points the host emits. Always includes the §3.2 floor.
    pub interception_points: BTreeSet<InterceptionPoint>,
    /// Closed vocabulary ([`CAPABILITIES`]).
    pub capabilities: BTreeSet<String>,
    /// Profiles and the knob values supported under each.
    pub profiles: BTreeMap<CompositionProfile, KnobSupport>,
    /// The posture the code implements (§13.1).
    pub tool_seam_host_error: ToolSeamPosture,
    /// Whether the host may declare `buffered_output: false` (§12.1a).
    pub streams_unbuffered: bool,
    /// The §12.1a exposure bound the host enforces. Required when
    /// `capabilities` names `incremental_output`; a document that
    /// states no `surface` resolves to `buffered_output: false` with
    /// this bound (§7.7.4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exposure_bound: Option<String>,
    /// Whether this build bounds execution. Filled from this build by
    /// every constructor and never settable by a host; read it with
    /// [`interceptor_timeout`](Self::interceptor_timeout). The JSON
    /// form carries it because a wrapper SDK, which bounds in its own
    /// runtime, states it through the FFI `host_json`.
    interceptor_timeout: TimeoutSupport,
    /// Contract versions the host accepts; a subset of
    /// [`SUPPORTED_DECLARATION_VERSIONS`].
    pub declaration_versions: BTreeSet<String>,
}

fn build_timeout_support() -> TimeoutSupport {
    if cfg!(feature = "tokio-timeout") {
        TimeoutSupport::Bounded
    } else {
        TimeoutSupport::Unbounded
    }
}

impl HostSurface {
    /// The smallest honest surface for this crate: the lifecycle
    /// floor, `host_declaration`, every profile with every knob value,
    /// posture `continue`, buffered output, this build's timeout
    /// support and every accepted contract version. A host adds what
    /// its runtime does.
    pub fn sdk_default() -> Self {
        Self {
            interception_points: FLOOR_POINTS.into_iter().collect(),
            capabilities: ["host_declaration".to_owned()].into_iter().collect(),
            profiles: CompositionProfile::ALL
                .into_iter()
                .map(|p| (p, KnobSupport::full(p)))
                .collect(),
            tool_seam_host_error: ToolSeamPosture::Continue,
            streams_unbuffered: false,
            exposure_bound: None,
            interceptor_timeout: build_timeout_support(),
            declaration_versions: SUPPORTED_DECLARATION_VERSIONS
                .iter()
                .map(|s| (*s).to_owned())
                .collect(),
        }
    }

    /// Build and validate a surface. `interceptor_timeout` is filled
    /// from this build; a host never claims a bound it cannot keep.
    /// `exposure_bound` is required iff `capabilities` names
    /// `incremental_output`.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        interception_points: impl IntoIterator<Item = InterceptionPoint>,
        capabilities: impl IntoIterator<Item = String>,
        profiles: BTreeMap<CompositionProfile, KnobSupport>,
        tool_seam_host_error: ToolSeamPosture,
        streams_unbuffered: bool,
        exposure_bound: Option<String>,
        declaration_versions: impl IntoIterator<Item = String>,
    ) -> Result<Self, DeclarationError> {
        let s = Self {
            interception_points: interception_points.into_iter().collect(),
            capabilities: capabilities.into_iter().collect(),
            profiles,
            tool_seam_host_error,
            streams_unbuffered,
            exposure_bound,
            interceptor_timeout: build_timeout_support(),
            declaration_versions: declaration_versions.into_iter().collect(),
        };
        s.validate()?;
        Ok(s)
    }

    /// Add the model points, the tool points, or both.
    pub fn with_points(mut self, points: impl IntoIterator<Item = InterceptionPoint>) -> Self {
        self.interception_points.extend(points);
        self
    }

    /// Add capabilities.
    pub fn with_capabilities(mut self, caps: impl IntoIterator<Item = String>) -> Self {
        self.capabilities.extend(caps);
        self
    }

    /// State the §12.1a exposure bound an incremental host enforces.
    /// Also marks the host as able to declare `buffered_output: false`.
    pub fn with_exposure_bound(mut self, bound: impl Into<String>) -> Self {
        self.exposure_bound = Some(bound.into());
        self.streams_unbuffered = true;
        self
    }

    /// The surface the CTK derives from a harness's capability list
    /// and posture (§7.7.9): the floor plus the model points iff
    /// `model_calls` plus the tool points iff `tool_calls`. A list
    /// naming `incremental_output` yields a surface without its
    /// exposure bound, which [`validate`](Self::validate) refuses; such
    /// a host states the bound with
    /// [`with_exposure_bound`](Self::with_exposure_bound).
    pub fn from_capabilities(
        caps: impl IntoIterator<Item = String>,
        posture: ToolSeamPosture,
    ) -> Self {
        let mut s = Self::sdk_default();
        s.tool_seam_host_error = posture;
        s.capabilities.clear();
        for c in caps {
            match c.as_str() {
                "model_calls" => {
                    s.interception_points
                        .insert(InterceptionPoint::PreModelCall);
                    s.interception_points
                        .insert(InterceptionPoint::PostModelCall);
                }
                "tool_calls" => {
                    s.interception_points.insert(InterceptionPoint::PreToolCall);
                    s.interception_points
                        .insert(InterceptionPoint::PostToolCall);
                }
                "incremental_output" => s.streams_unbuffered = true,
                _ => {}
            }
            s.capabilities.insert(c);
        }
        s
    }

    /// Whether this build bounds interceptor and resolver execution.
    pub fn interceptor_timeout(&self) -> TimeoutSupport {
        self.interceptor_timeout
    }

    /// Test-suite hook: state a timeout support this build may not
    /// have, so equivalence tests that compare records, never timing,
    /// run the default timeouts on every build. Not part of the stable
    /// API; a host never calls it.
    #[doc(hidden)]
    pub fn assume_timeout_support_for_tests(mut self, support: TimeoutSupport) -> Self {
        self.interceptor_timeout = support;
        self
    }

    /// Check the surface against the closed vocabularies, the §3.2
    /// floor and the §3.2 omission pairs. A host surface that fails
    /// here is a programming error; [`resolve`] refuses every document
    /// against it.
    pub fn validate(&self) -> Result<(), DeclarationError> {
        let mut findings = Vec::new();
        for p in FLOOR_POINTS {
            if !self.interception_points.contains(&p) {
                findings.push(Finding {
                    pointer: "/surface/interception_points".into(),
                    detail: format!("host surface lacks the §3.2 floor point {p}"),
                });
            }
        }
        let has = |p: InterceptionPoint| self.interception_points.contains(&p);
        let model_points =
            has(InterceptionPoint::PreModelCall) && has(InterceptionPoint::PostModelCall);
        let tool_points =
            has(InterceptionPoint::PreToolCall) && has(InterceptionPoint::PostToolCall);
        if has(InterceptionPoint::PreModelCall) != has(InterceptionPoint::PostModelCall) {
            findings.push(Finding {
                pointer: "/surface/interception_points".into(),
                detail: "host surface omits one model point; pre_model_call and post_model_call are omitted together or not at all (see spec §3.2)".into(),
            });
        }
        if has(InterceptionPoint::PreToolCall) != has(InterceptionPoint::PostToolCall) {
            findings.push(Finding {
                pointer: "/surface/interception_points".into(),
                detail: "host surface omits one tool point; pre_tool_call and post_tool_call are omitted together or not at all (see spec §3.2)".into(),
            });
        }
        if self.capabilities.contains("model_calls") != model_points {
            findings.push(Finding {
                pointer: "/surface/capabilities".into(),
                detail:
                    "host surface lists model_calls iff it emits both model points (see spec §3.2)"
                        .into(),
            });
        }
        if self.capabilities.contains("tool_calls") != tool_points {
            findings.push(Finding {
                pointer: "/surface/capabilities".into(),
                detail:
                    "host surface lists tool_calls iff it emits both tool points (see spec §3.2)"
                        .into(),
            });
        }
        for c in &self.capabilities {
            if !CAPABILITIES.contains(&c.as_str()) {
                findings.push(Finding {
                    pointer: "/surface/capabilities".into(),
                    detail: format!("host surface names an unknown capability {c:?}"),
                });
            }
        }
        if self.capabilities.contains("incremental_output") {
            if !self.streams_unbuffered {
                findings.push(Finding {
                    pointer: "/surface/capabilities".into(),
                    detail: "host surface names incremental_output but cannot declare buffered_output: false".into(),
                });
            }
            match &self.exposure_bound {
                None => findings.push(Finding {
                    pointer: "/surface/exposure_bound".into(),
                    detail: "host surface names incremental_output without an exposure bound (see spec §12.1a)".into(),
                }),
                Some(b) if b.is_empty() || b.chars().count() > MAX_DETAIL_LEN => {
                    findings.push(Finding {
                        pointer: "/surface/exposure_bound".into(),
                        detail: format!(
                            "host surface exposure bound must be 1 to {MAX_DETAIL_LEN} characters"
                        ),
                    })
                }
                Some(_) => {}
            }
        }
        for v in &self.declaration_versions {
            if !SUPPORTED_DECLARATION_VERSIONS.contains(&v.as_str()) {
                findings.push(Finding {
                    pointer: "/surface/declaration_versions".into(),
                    detail: format!("host surface accepts {v:?}, which this SDK does not support"),
                });
            }
        }
        for (profile, knobs) in &self.profiles {
            for knob in profile.consulted_knobs() {
                if knobs.knob(knob).is_empty() {
                    findings.push(Finding {
                        pointer: ptr("/surface/profiles", profile.as_str()),
                        detail: format!("host surface supports no value for consulted knob {knob}"),
                    });
                }
            }
            if !knobs.subset_of(&KnobSupport::full(*profile)) {
                findings.push(Finding {
                    pointer: ptr("/surface/profiles", profile.as_str()),
                    detail: "host surface names a knob the profile does not consult or a value outside the closed set".into(),
                });
            }
        }
        if findings.is_empty() {
            Ok(())
        } else {
            Err(DeclarationError::many(
                DeclarationErrorClass::SurfaceUnsupported,
                findings,
            ))
        }
    }
}

/// The names a registry holds, derived from what was registered and
/// never hand-written (§7.7.5). Steps 9 and 10 check against this.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryNames {
    #[serde(default)]
    pub identity_providers: BTreeSet<String>,
    #[serde(default)]
    pub approval_resolvers: BTreeSet<String>,
    #[serde(default)]
    pub approval_redactors: BTreeSet<String>,
    #[serde(default)]
    pub kinds: BTreeSet<String>,
}

/// What the FFI `declaration_resolve` call receives as `host_json`:
/// the surface plus the four registry name sets, spelled out so the
/// object is closed. serde does not honour `deny_unknown_fields`
/// through `flatten`, so a flattened [`RegistryNames`] would let a
/// misspelled set (`kind` for `kinds`) pass and surface later as a
/// refusal of the document instead of a wrapper defect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostDescription {
    pub surface: HostSurface,
    #[serde(default)]
    pub identity_providers: BTreeSet<String>,
    #[serde(default)]
    pub approval_resolvers: BTreeSet<String>,
    #[serde(default)]
    pub approval_redactors: BTreeSet<String>,
    #[serde(default)]
    pub kinds: BTreeSet<String>,
}

impl HostDescription {
    /// The registry names the description carries.
    pub fn names(&self) -> RegistryNames {
        RegistryNames {
            identity_providers: self.identity_providers.clone(),
            approval_resolvers: self.approval_resolvers.clone(),
            approval_redactors: self.approval_redactors.clone(),
            kinds: self.kinds.clone(),
        }
    }
}

/// What a kind resolver learns about the binding it builds (§7.7.5).
#[derive(Debug, Clone)]
pub struct BindingContext<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub at: &'a BTreeSet<InterceptionPoint>,
    /// The resolved per-binding bound; `None` is unbounded.
    pub timeout: Option<Duration>,
    pub host: Option<&'a HostInfo>,
    pub declaration_version: &'a str,
}

/// Host code that turns one binding's `config` into one interceptor,
/// or refuses it with a message (which MUST NOT echo the config).
pub type KindResolver =
    Box<dyn Fn(&Value, &BindingContext<'_>) -> Result<Box<dyn Interceptor>, String> + Send + Sync>;

type IdentityFn = Arc<dyn Fn(&AgentContext) -> String + Send + Sync>;
type RedactorFn = Arc<dyn Fn(&AgentContext) -> AgentContext + Send + Sync>;

/// Everything a host registers in code for a declaration to reference
/// (§7.7.5): the code surface, kind resolvers, custom identity
/// providers, approval resolvers and approval redactors.
pub struct HostRegistry {
    surface: HostSurface,
    allow_reserved: bool,
    kinds: BTreeMap<String, KindResolver>,
    identity_providers: BTreeMap<String, IdentityFn>,
    approval_resolvers: BTreeMap<String, Arc<dyn ApprovalResolver>>,
    approval_redactors: BTreeMap<String, RedactorFn>,
}

impl fmt::Debug for HostRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HostRegistry")
            .field("surface", &self.surface)
            .field("names", &self.names())
            .finish()
    }
}

/// Reference grammar for resolver and redactor names and binding ids:
/// `^[a-z][a-z0-9_-]{0,63}$`.
pub fn valid_reference(s: &str) -> bool {
    let mut chars = s.chars();
    s.len() <= MAX_ID_LEN
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Binding kind grammar (§7.7.5): dot-separated lowercase segments,
/// at least two, at most 128 characters.
pub fn valid_kind(s: &str) -> bool {
    s.len() <= MAX_KIND_LEN && {
        let segs: Vec<&str> = s.split('.').collect();
        segs.len() >= 2 && segs.iter().all(|seg| valid_reference_segment(seg))
    }
}

fn valid_reference_segment(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn kind_first_segment(kind: &str) -> &str {
    kind.split('.').next().unwrap_or("")
}

impl HostRegistry {
    /// A registry over the given code surface. Kinds under the
    /// reserved `agent_hooks` and `ctk` segments are refused.
    pub fn new(surface: HostSurface) -> Self {
        Self {
            surface,
            allow_reserved: false,
            kinds: BTreeMap::new(),
            identity_providers: BTreeMap::new(),
            approval_resolvers: BTreeMap::new(),
            approval_redactors: BTreeMap::new(),
        }
    }

    /// The conformance kit's registry: as [`Self::new`], but the `ctk`
    /// kind segment may be registered.
    pub fn for_conformance(surface: HostSurface) -> Self {
        Self {
            allow_reserved: true,
            ..Self::new(surface)
        }
    }

    pub fn surface(&self) -> &HostSurface {
        &self.surface
    }

    /// Register a kind resolver.
    pub fn kind(mut self, kind: &str, f: KindResolver) -> Result<Self, RegistryError> {
        if !valid_kind(kind) {
            return Err(RegistryError {
                detail: format!("kind {kind:?} does not match the kind grammar (see spec §7.7.5)"),
            });
        }
        let head = kind_first_segment(kind);
        if RESERVED_KIND_SEGMENTS.contains(&head) && !(self.allow_reserved && head == "ctk") {
            return Err(RegistryError {
                detail: format!(
                    "kind {kind:?} uses the reserved segment {head:?} (see spec §7.7.5)"
                ),
            });
        }
        if self.kinds.contains_key(kind) {
            return Err(RegistryError {
                detail: format!("kind {kind:?} registered twice"),
            });
        }
        self.kinds.insert(kind.to_owned(), f);
        Ok(self)
    }

    /// Register a custom identity provider (§10.1 name rules apply).
    pub fn identity_provider(
        mut self,
        name: &str,
        f: impl Fn(&AgentContext) -> String + Send + Sync + 'static,
    ) -> Result<Self, RegistryError> {
        validate_provider_name(name).map_err(|(_, d)| RegistryError { detail: d })?;
        if name.len() > MAX_ID_LEN {
            return Err(RegistryError {
                detail: format!("identity provider name {name:?} exceeds {MAX_ID_LEN} characters"),
            });
        }
        if self.identity_providers.contains_key(name) {
            return Err(RegistryError {
                detail: format!("identity provider {name:?} registered twice"),
            });
        }
        self.identity_providers.insert(name.to_owned(), Arc::new(f));
        Ok(self)
    }

    /// Register an approval resolver under a reference name.
    pub fn approval_resolver(
        mut self,
        name: &str,
        resolver: Box<dyn ApprovalResolver>,
    ) -> Result<Self, RegistryError> {
        check_reference(name, "approval resolver")?;
        if self.approval_resolvers.contains_key(name) {
            return Err(RegistryError {
                detail: format!("approval resolver {name:?} registered twice"),
            });
        }
        self.approval_resolvers
            .insert(name.to_owned(), Arc::from(resolver));
        Ok(self)
    }

    /// Register an approval redactor under a reference name.
    pub fn approval_redactor(
        mut self,
        name: &str,
        f: impl Fn(&AgentContext) -> AgentContext + Send + Sync + 'static,
    ) -> Result<Self, RegistryError> {
        check_reference(name, "approval redactor")?;
        if self.approval_redactors.contains_key(name) {
            return Err(RegistryError {
                detail: format!("approval redactor {name:?} registered twice"),
            });
        }
        self.approval_redactors.insert(name.to_owned(), Arc::new(f));
        Ok(self)
    }

    /// The registered names, derived (§7.7.5).
    pub fn names(&self) -> RegistryNames {
        RegistryNames {
            identity_providers: self.identity_providers.keys().cloned().collect(),
            approval_resolvers: self.approval_resolvers.keys().cloned().collect(),
            approval_redactors: self.approval_redactors.keys().cloned().collect(),
            kinds: self.kinds.keys().cloned().collect(),
        }
    }

    pub(crate) fn kind_resolver(&self, kind: &str) -> Option<&KindResolver> {
        self.kinds.get(kind)
    }

    pub(crate) fn identity_fn(&self, name: &str) -> Option<IdentityFn> {
        self.identity_providers.get(name).cloned()
    }

    pub(crate) fn approval_resolver_ref(&self, name: &str) -> Option<Arc<dyn ApprovalResolver>> {
        self.approval_resolvers.get(name).cloned()
    }

    pub(crate) fn redactor_fn(&self, name: &str) -> Option<RedactorFn> {
        self.approval_redactors.get(name).cloned()
    }
}

fn check_reference(name: &str, what: &str) -> Result<(), RegistryError> {
    if valid_reference(name) {
        Ok(())
    } else {
        Err(RegistryError {
            detail: format!("{what} name {name:?} does not match ^[a-z][a-z0-9_-]{{0,63}}$"),
        })
    }
}

// ---- document types ----------------------------------------------------------

/// The informative `host` block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// A declaration that passed steps 2 to 7 (§7.7.6): parsed, of an
/// accepted version, closed, well-typed and internally consistent as
/// stated. Not yet checked against any host; see [`resolve`].
#[derive(Debug, Clone, PartialEq)]
pub struct HostDeclaration {
    doc: Map<String, Value>,
}

impl HostDeclaration {
    /// Step 1 then [`Self::from_json`]: open exactly `path`, require a
    /// regular file of at most [`MAX_DOCUMENT_BYTES`], strict UTF-8
    /// without a byte-order mark, read once.
    pub fn from_path(path: impl AsRef<Path>) -> Result<Self, DeclarationError> {
        let path = path.as_ref();
        let unreadable =
            |detail: String| DeclarationError::new(DeclarationErrorClass::Unreadable, "", detail);
        let meta = std::fs::metadata(path)
            .map_err(|e| unreadable(format!("cannot stat: {}", io_class(&e))))?;
        if !meta.is_file() {
            return Err(unreadable("not a regular file".into()));
        }
        if meta.len() > MAX_DOCUMENT_BYTES as u64 {
            return Err(unreadable(format!(
                "document is {} bytes; the bound is {MAX_DOCUMENT_BYTES}",
                meta.len()
            )));
        }
        let bytes = std::fs::read(path)
            .map_err(|e| unreadable(format!("cannot read: {}", io_class(&e))))?;
        if bytes.len() > MAX_DOCUMENT_BYTES {
            return Err(unreadable(format!(
                "document is {} bytes; the bound is {MAX_DOCUMENT_BYTES}",
                bytes.len()
            )));
        }
        if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            return Err(unreadable("document starts with a byte-order mark".into()));
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| unreadable("document is not valid UTF-8".into()))?;
        Self::from_json(text)
    }

    /// Steps 2 to 7 over JSON text.
    pub fn from_json(text: &str) -> Result<Self, DeclarationError> {
        let value = parse_checked(text)?;
        let Value::Object(doc) = value else {
            return Err(DeclarationError::new(
                DeclarationErrorClass::Malformed,
                "",
                "document root is not a JSON object",
            ));
        };
        Self::from_object(doc)
    }

    /// Steps 2 to 7 over an in-memory value: serialized with
    /// `serde_json` and handed to [`Self::from_json`], so size, depth
    /// and shape checks are the same code on every path.
    pub fn from_value(value: Value) -> Result<Self, DeclarationError> {
        let text = serde_json::to_string(&value).map_err(|e| {
            DeclarationError::new(
                DeclarationErrorClass::Malformed,
                "",
                format!("cannot serialize: {e}"),
            )
        })?;
        Self::from_json(&text)
    }

    fn from_object(doc: Map<String, Value>) -> Result<Self, DeclarationError> {
        check_version(&doc)?; // 3
        check_spec(&doc)?; // 4
        check_unknown_fields(&doc)?; // 5
        check_fields(&doc)?; // 6
        check_consistency(&doc, None)?; // 7, as stated
        Ok(Self { doc })
    }

    /// A builder for the code path.
    pub fn builder() -> DeclarationBuilder {
        DeclarationBuilder::default()
    }

    /// The document's own `declaration` value.
    pub fn version(&self) -> &str {
        self.doc["declaration"].as_str().unwrap_or_default()
    }

    /// The validated document, verbatim (including `$schema`).
    pub fn as_value(&self) -> Value {
        Value::Object(self.doc.clone())
    }
}

fn io_class(e: &std::io::Error) -> String {
    format!("{:?}", e.kind())
}

// ---- step 2: checked parse ---------------------------------------------------

struct Checked {
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for Checked {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Checked {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }

    fn visit_bool<E>(self, v: bool) -> Result<Value, E>
    where
        E: de::Error,
    {
        Ok(Value::Bool(v))
    }
    fn visit_i64<E>(self, v: i64) -> Result<Value, E>
    where
        E: de::Error,
    {
        Ok(Value::from(v))
    }
    fn visit_u64<E>(self, v: u64) -> Result<Value, E>
    where
        E: de::Error,
    {
        Ok(Value::from(v))
    }
    fn visit_f64<E>(self, v: f64) -> Result<Value, E>
    where
        E: de::Error,
    {
        Ok(serde_json::Number::from_f64(v)
            .map(Value::Number)
            .unwrap_or(Value::Null))
    }
    fn visit_str<E>(self, v: &str) -> Result<Value, E>
    where
        E: de::Error,
    {
        Ok(Value::String(v.to_owned()))
    }
    fn visit_string<E>(self, v: String) -> Result<Value, E>
    where
        E: de::Error,
    {
        Ok(Value::String(v))
    }
    fn visit_unit<E>(self) -> Result<Value, E>
    where
        E: de::Error,
    {
        Ok(Value::Null)
    }
    fn visit_none<E>(self) -> Result<Value, E>
    where
        E: de::Error,
    {
        Ok(Value::Null)
    }
    fn visit_some<D: de::Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        d.deserialize_any(self)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        if self.depth + 1 > MAX_DEPTH {
            return Err(de::Error::custom(format!(
                "nesting deeper than {MAX_DEPTH}"
            )));
        }
        let mut out = Vec::new();
        while let Some(v) = seq.next_element_seed(Checked {
            depth: self.depth + 1,
        })? {
            out.push(v);
        }
        Ok(Value::Array(out))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        if self.depth + 1 > MAX_DEPTH {
            return Err(de::Error::custom(format!(
                "nesting deeper than {MAX_DEPTH}"
            )));
        }
        let mut out = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if out.contains_key(&key) {
                return Err(de::Error::custom(format!("duplicate key {key:?}")));
            }
            let v = map.next_value_seed(Checked {
                depth: self.depth + 1,
            })?;
            out.insert(key, v);
        }
        Ok(Value::Object(out))
    }
}

/// Parse one JSON text under the §7.7.6 bounds: at most
/// [`MAX_DOCUMENT_BYTES`], no duplicate keys, nesting at most
/// [`MAX_DEPTH`], nothing after the value.
fn parse_checked(text: &str) -> Result<Value, DeclarationError> {
    let malformed = |d: String| DeclarationError::new(DeclarationErrorClass::Malformed, "", d);
    if text.len() > MAX_DOCUMENT_BYTES {
        return Err(malformed(format!(
            "document is {} bytes; the bound is {MAX_DOCUMENT_BYTES}",
            text.len()
        )));
    }
    let mut de = serde_json::Deserializer::from_str(text);
    let value = Checked { depth: 0 }
        .deserialize(&mut de)
        .map_err(|e| malformed(format!("not a valid JSON document: {e}")))?;
    de.end()
        .map_err(|e| malformed(format!("trailing content after the document: {e}")))?;
    Ok(value)
}

// ---- step 3 and 4: versions ---------------------------------------------------

fn check_version(doc: &Map<String, Value>) -> Result<(), DeclarationError> {
    match doc.get("declaration") {
        None => Err(DeclarationError::version("declaration is missing")),
        Some(Value::String(v)) if SUPPORTED_DECLARATION_VERSIONS.contains(&v.as_str()) => Ok(()),
        Some(Value::String(v)) => Err(DeclarationError::version(format!(
            "declaration {v:?} is not accepted by this loader"
        ))),
        Some(_) => Err(DeclarationError::version("declaration is not a string")),
    }
}

/// Parse `agent-hooks/<major>.<minor>`.
fn parse_spec(s: &str) -> Option<(u64, u64)> {
    let rest = s.strip_prefix("agent-hooks/")?;
    let (maj, min) = rest.split_once('.')?;
    let ok = |p: &str| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) && p.len() <= 9;
    if !ok(maj) || !ok(min) {
        return None;
    }
    Some((maj.parse().ok()?, min.parse().ok()?))
}

fn check_spec(doc: &Map<String, Value>) -> Result<(), DeclarationError> {
    let Some(spec) = doc.get("spec") else {
        return Ok(());
    };
    let unsupported =
        |d: String| DeclarationError::new(DeclarationErrorClass::SpecUnsupported, "/spec", d);
    let Some(s) = spec.as_str() else {
        return Err(unsupported("spec is not a string".into()));
    };
    let Some((maj, min)) = parse_spec(s) else {
        return Err(unsupported(format!(
            "spec {s:?} is not of the form agent-hooks/<major>.<minor>"
        )));
    };
    let (lmaj, lmin) = parse_spec(SPEC_VERSION).expect("SPEC_VERSION is well-formed");
    if maj != lmaj || min > lmin {
        return Err(unsupported(format!(
            "spec {s:?} is not supported by this loader (it implements {SPEC_VERSION})"
        )));
    }
    Ok(())
}

// ---- step 5: closed levels ----------------------------------------------------

const ROOT_KEYS: &[&str] = &[
    "$schema",
    "declaration",
    "spec",
    "id",
    "host",
    "configuration",
    "surface",
    "bindings",
    "extensions",
];
const HOST_KEYS: &[&str] = &["name", "version"];
const CONFIGURATION_KEYS: &[&str] = &[
    "mode",
    "composition",
    "identity_provider",
    "approval",
    "posture",
    "timeouts",
    "records",
];
const COMPOSITION_KEYS: &[&str] = &[
    "profile",
    "on_approval",
    "on_disagreement",
    "on_transform_conflict",
];
const APPROVAL_KEYS: &[&str] = &["resolver", "redactor"];
const POSTURE_KEYS: &[&str] = &["tool_seam_host_error"];
const TIMEOUT_KEYS: &[&str] = &["interceptor_ms", "approval_resolver_ms"];
const RECORD_KEYS: &[&str] = &["max_buffered"];
const SURFACE_KEYS: &[&str] = &[
    "interception_points",
    "capabilities",
    "profiles",
    "buffered_output",
    "exposure_bound",
    "declaration_versions",
];
const BINDING_KEYS: &[&str] = &["id", "kind", "config", "at", "timeout_ms"];

fn unknown_in(obj: &Map<String, Value>, allowed: &[&str], pointer: &str, out: &mut Vec<Finding>) {
    for k in obj.keys() {
        if !allowed.contains(&k.as_str()) {
            out.push(Finding {
                pointer: ptr(pointer, k),
                detail: format!("unknown member {k:?}"),
            });
        }
    }
}

fn object_at<'a>(parent: &'a Map<String, Value>, key: &str) -> Option<&'a Map<String, Value>> {
    parent.get(key).and_then(Value::as_object)
}

fn check_unknown_fields(doc: &Map<String, Value>) -> Result<(), DeclarationError> {
    let mut f = Vec::new();
    unknown_in(doc, ROOT_KEYS, "", &mut f);
    if let Some(host) = object_at(doc, "host") {
        unknown_in(host, HOST_KEYS, "/host", &mut f);
    }
    if let Some(cfg) = object_at(doc, "configuration") {
        unknown_in(cfg, CONFIGURATION_KEYS, "/configuration", &mut f);
        if let Some(c) = object_at(cfg, "composition") {
            unknown_in(c, COMPOSITION_KEYS, "/configuration/composition", &mut f);
        }
        if let Some(a) = object_at(cfg, "approval") {
            unknown_in(a, APPROVAL_KEYS, "/configuration/approval", &mut f);
        }
        if let Some(p) = object_at(cfg, "posture") {
            unknown_in(p, POSTURE_KEYS, "/configuration/posture", &mut f);
        }
        if let Some(t) = object_at(cfg, "timeouts") {
            unknown_in(t, TIMEOUT_KEYS, "/configuration/timeouts", &mut f);
        }
        if let Some(r) = object_at(cfg, "records") {
            unknown_in(r, RECORD_KEYS, "/configuration/records", &mut f);
        }
    }
    if let Some(surface) = object_at(doc, "surface") {
        unknown_in(surface, SURFACE_KEYS, "/surface", &mut f);
        if let Some(profiles) = object_at(surface, "profiles") {
            for (name, knobs) in profiles {
                let p = ptr("/surface/profiles", name);
                match CompositionProfile::from_wire(name) {
                    None => f.push(Finding {
                        pointer: p,
                        detail: format!("unknown profile {name:?}"),
                    }),
                    Some(profile) => {
                        if let Some(obj) = knobs.as_object() {
                            unknown_in(obj, profile.consulted_knobs(), &p, &mut f);
                        }
                    }
                }
            }
        }
    }
    if let Some(bindings) = doc.get("bindings").and_then(Value::as_array) {
        for (i, b) in bindings.iter().enumerate() {
            if let Some(obj) = b.as_object() {
                unknown_in(obj, BINDING_KEYS, &format!("/bindings/{i}"), &mut f);
            }
        }
    }
    if f.is_empty() {
        Ok(())
    } else {
        Err(DeclarationError::many(
            DeclarationErrorClass::UnknownField,
            f,
        ))
    }
}

// ---- step 6: types, enums, patterns, ranges -----------------------------------

struct Fields {
    out: Vec<Finding>,
}

impl Fields {
    fn bad(&mut self, pointer: impl Into<String>, detail: impl Into<String>) {
        self.out.push(Finding {
            pointer: pointer.into(),
            detail: truncate(detail.into()),
        });
    }

    fn string<'a>(&mut self, v: Option<&'a Value>, pointer: &str) -> Option<&'a str> {
        match v {
            None => None,
            Some(Value::String(s)) => Some(s.as_str()),
            Some(_) => {
                self.bad(pointer, "must be a string");
                None
            }
        }
    }

    fn object<'a>(
        &mut self,
        v: Option<&'a Value>,
        pointer: &str,
    ) -> Option<&'a Map<String, Value>> {
        match v {
            None => None,
            Some(Value::Object(o)) => Some(o),
            Some(_) => {
                self.bad(pointer, "must be an object");
                None
            }
        }
    }

    fn array<'a>(&mut self, v: Option<&'a Value>, pointer: &str) -> Option<&'a [Value]> {
        match v {
            None => None,
            Some(Value::Array(a)) => Some(a.as_slice()),
            Some(_) => {
                self.bad(pointer, "must be an array");
                None
            }
        }
    }

    fn enum_str(&mut self, v: Option<&Value>, pointer: &str, allowed: &[&str]) {
        if let Some(s) = self.string(v, pointer) {
            if !allowed.contains(&s) {
                self.bad(pointer, format!("{s:?} is not one of {allowed:?}"));
            }
        }
    }

    /// Integer in `lo..=hi`, or `null` when `nullable`.
    fn int_or_null(&mut self, v: Option<&Value>, pointer: &str, lo: u64, hi: u64) {
        match v {
            None | Some(Value::Null) => {}
            Some(n) => match n.as_u64() {
                Some(x) if x >= lo && x <= hi => {}
                _ => self.bad(
                    pointer,
                    format!("must be an integer from {lo} to {hi}, or null"),
                ),
            },
        }
    }

    /// Array of strings from a closed set, each at most once.
    fn string_set(
        &mut self,
        v: Option<&Value>,
        pointer: &str,
        allowed: &[&str],
        min: usize,
    ) -> Option<BTreeSet<String>> {
        let arr = self.array(v, pointer)?;
        let mut seen = BTreeSet::new();
        let mut ok = true;
        for (i, item) in arr.iter().enumerate() {
            let p = format!("{pointer}/{i}");
            match item.as_str() {
                None => {
                    self.bad(&p, "must be a string");
                    ok = false;
                }
                Some(s) if !allowed.is_empty() && !allowed.contains(&s) => {
                    self.bad(&p, format!("{s:?} is not one of {allowed:?}"));
                    ok = false;
                }
                Some(s) => {
                    if !seen.insert(s.to_owned()) {
                        self.bad(&p, format!("{s:?} is listed twice; the member is a set"));
                        ok = false;
                    }
                }
            }
        }
        if arr.len() < min {
            self.bad(pointer, format!("must list at least {min} item(s)"));
            ok = false;
        }
        ok.then_some(seen)
    }
}

fn check_fields(doc: &Map<String, Value>) -> Result<(), DeclarationError> {
    let mut f = Fields { out: Vec::new() };
    f.string(doc.get("$schema"), "/$schema");
    if let Some(id) = f.string(doc.get("id"), "/id") {
        let mut chars = id.chars();
        let ok = id.len() <= MAX_ID_LEN
            && chars
                .next()
                .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            && chars.all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-'
            });
        if !ok {
            f.bad("/id", "must match ^[a-z0-9][a-z0-9._-]{0,63}$");
        }
    }
    if let Some(host) = f.object(doc.get("host"), "/host") {
        match f.string(host.get("name"), "/host/name") {
            None if !host.contains_key("name") => {
                f.bad("/host/name", "required when host is present")
            }
            Some(n) => {
                let ok = !n.is_empty()
                    && n.len() <= 64
                    && n.chars().all(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-'
                    });
                if !ok {
                    f.bad("/host/name", "must match ^[a-z0-9_-]{1,64}$");
                }
            }
            None => {}
        }
        if let Some(v) = f.string(host.get("version"), "/host/version") {
            if v.is_empty() || v.chars().count() > 64 {
                f.bad("/host/version", "must be 1 to 64 characters");
            }
        }
    }
    if let Some(cfg) = f.object(doc.get("configuration"), "/configuration") {
        f.enum_str(
            cfg.get("mode"),
            "/configuration/mode",
            &["enforce", "evaluate_only"],
        );
        if let Some(c) = f.object(cfg.get("composition"), "/configuration/composition") {
            f.enum_str(
                c.get("profile"),
                "/configuration/composition/profile",
                &CompositionProfile::ALL.map(|p| p.as_str()),
            );
            for knob in ["on_approval", "on_disagreement", "on_transform_conflict"] {
                f.enum_str(
                    c.get(knob),
                    &ptr("/configuration/composition", knob),
                    knob_values(knob),
                );
            }
        }
        match cfg.get("identity_provider") {
            None | Some(Value::Null) => {}
            Some(Value::String(s)) if s == JCS_SHA256 => {}
            Some(Value::String(s)) => {
                if s.len() > MAX_ID_LEN || validate_provider_name(s).is_err() {
                    f.bad(
                        "/configuration/identity_provider",
                        "custom provider names must match ^[a-z][a-z0-9_-]{0,63}$ and not begin with jcs (see spec §10.1)",
                    );
                }
            }
            Some(_) => f.bad(
                "/configuration/identity_provider",
                "must be a string or null",
            ),
        }
        if let Some(a) = f.object(cfg.get("approval"), "/configuration/approval") {
            for key in APPROVAL_KEYS {
                let p = ptr("/configuration/approval", key);
                match a.get(*key) {
                    None | Some(Value::Null) => {}
                    Some(Value::String(s)) if valid_reference(s) => {}
                    Some(Value::String(_)) => f.bad(&p, "must match ^[a-z][a-z0-9_-]{0,63}$"),
                    Some(_) => f.bad(&p, "must be a string or null"),
                }
            }
        }
        if let Some(p) = f.object(cfg.get("posture"), "/configuration/posture") {
            f.enum_str(
                p.get("tool_seam_host_error"),
                "/configuration/posture/tool_seam_host_error",
                &["continue", "terminate"],
            );
        }
        if let Some(t) = f.object(cfg.get("timeouts"), "/configuration/timeouts") {
            for key in TIMEOUT_KEYS {
                f.int_or_null(
                    t.get(*key),
                    &ptr("/configuration/timeouts", key),
                    1,
                    MAX_TIMEOUT_MS,
                );
            }
        }
        if let Some(r) = f.object(cfg.get("records"), "/configuration/records") {
            f.int_or_null(
                r.get("max_buffered"),
                "/configuration/records/max_buffered",
                1,
                u64::MAX,
            );
        }
    }
    if let Some(surface) = f.object(doc.get("surface"), "/surface") {
        let point_names = ALL_POINTS.map(|p| p.as_str());
        if let Some(points) = f.string_set(
            surface.get("interception_points"),
            "/surface/interception_points",
            &point_names,
            4,
        ) {
            if points.len() > 8 {
                f.bad("/surface/interception_points", "must list at most 8 points");
            }
        }
        f.string_set(
            surface.get("capabilities"),
            "/surface/capabilities",
            CAPABILITIES,
            0,
        );
        if let Some(profiles) = f.object(surface.get("profiles"), "/surface/profiles") {
            for (name, knobs) in profiles {
                let p = ptr("/surface/profiles", name);
                if let (Some(profile), Some(obj)) = (
                    CompositionProfile::from_wire(name),
                    f.object(Some(knobs), &p),
                ) {
                    for knob in profile.consulted_knobs() {
                        if obj.contains_key(*knob) {
                            f.string_set(obj.get(*knob), &ptr(&p, knob), knob_values(knob), 1);
                        }
                    }
                }
            }
        }
        let buffered = match surface.get("buffered_output") {
            None => true,
            Some(Value::Bool(b)) => *b,
            Some(_) => {
                f.bad("/surface/buffered_output", "must be a boolean");
                true
            }
        };
        let has_bound = surface.contains_key("exposure_bound");
        if let Some(b) = f.string(surface.get("exposure_bound"), "/surface/exposure_bound") {
            if b.is_empty() || b.chars().count() > MAX_DETAIL_LEN {
                f.bad(
                    "/surface/exposure_bound",
                    format!("must be 1 to {MAX_DETAIL_LEN} characters"),
                );
            }
        }
        if has_bound && buffered {
            f.bad(
                "/surface/exposure_bound",
                "permitted only when buffered_output is false",
            );
        }
        if !has_bound && !buffered {
            f.bad(
                "/surface/exposure_bound",
                "required when buffered_output is false (see spec §12.1a)",
            );
        }
        if let Some(arr) = f.array(
            surface.get("declaration_versions"),
            "/surface/declaration_versions",
        ) {
            let mut seen = BTreeSet::new();
            for (i, v) in arr.iter().enumerate() {
                let p = format!("/surface/declaration_versions/{i}");
                match v.as_str() {
                    Some(s) if parse_declaration_version(s).is_some() => {
                        if !seen.insert(s) {
                            f.bad(&p, format!("{s:?} is listed twice; the member is a set"));
                        }
                    }
                    Some(_) => f.bad(&p, "must match ^agent-hooks-declaration/[0-9]+\\.[0-9]+$"),
                    None => f.bad(&p, "must be a string"),
                }
            }
            if arr.is_empty() {
                f.bad(
                    "/surface/declaration_versions",
                    "must list at least one version",
                );
            }
        }
    }
    match doc.get("bindings") {
        None => f.bad("/bindings", "required"),
        Some(Value::Array(bindings)) => {
            if bindings.len() > MAX_BINDINGS {
                f.bad(
                    "/bindings",
                    format!("must list at most {MAX_BINDINGS} bindings"),
                );
            }
            for (i, b) in bindings.iter().enumerate() {
                let bp = format!("/bindings/{i}");
                let Some(obj) = f.object(Some(b), &bp) else {
                    continue;
                };
                match f.string(obj.get("id"), &ptr(&bp, "id")) {
                    None if !obj.contains_key("id") => f.bad(ptr(&bp, "id"), "required"),
                    Some(id) if !valid_reference(id) => {
                        f.bad(ptr(&bp, "id"), "must match ^[a-z][a-z0-9_-]{0,63}$")
                    }
                    _ => {}
                }
                match f.string(obj.get("kind"), &ptr(&bp, "kind")) {
                    None if !obj.contains_key("kind") => f.bad(ptr(&bp, "kind"), "required"),
                    Some(k) if !valid_kind(k) => f.bad(
                        ptr(&bp, "kind"),
                        format!("must match ^[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_-]*)+$ with at most {MAX_KIND_LEN} characters"),
                    ),
                    _ => {}
                }
                f.string_set(obj.get("at"), &ptr(&bp, "at"), &point_names_static(), 1);
                f.int_or_null(
                    obj.get("timeout_ms"),
                    &ptr(&bp, "timeout_ms"),
                    1,
                    MAX_TIMEOUT_MS,
                );
            }
        }
        Some(_) => f.bad("/bindings", "must be an array"),
    }
    if let Some(ext) = f.object(doc.get("extensions"), "/extensions") {
        for k in ext.keys() {
            let mut chars = k.chars();
            let ok = chars.next().is_some_and(|c| c.is_ascii_lowercase())
                && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
            if !ok {
                f.bad(
                    ptr("/extensions", k),
                    "extension keys must match ^[a-z][a-z0-9_]*$ (see spec §4.6)",
                );
            }
        }
    }
    if f.out.is_empty() {
        Ok(())
    } else {
        Err(DeclarationError::many(
            DeclarationErrorClass::InvalidField,
            f.out,
        ))
    }
}

fn point_names_static() -> [&'static str; 8] {
    ALL_POINTS.map(|p| p.as_str())
}

/// Parse `agent-hooks-declaration/<major>.<minor>`.
pub fn parse_declaration_version(s: &str) -> Option<(u64, u64)> {
    let rest = s.strip_prefix("agent-hooks-declaration/")?;
    let (maj, min) = rest.split_once('.')?;
    let ok = |p: &str| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) && p.len() <= 9;
    if !ok(maj) || !ok(min) {
        return None;
    }
    Some((maj.parse().ok()?, min.parse().ok()?))
}

// ---- resolution and step 7 ----------------------------------------------------

/// Resolved configuration: every default filled (§7.7.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedConfiguration {
    pub mode: EnforcementMode,
    pub composition: CompositionConfig,
    pub identity_provider: Option<String>,
    pub approval: ResolvedApproval,
    pub posture: ResolvedPosture,
    pub timeouts: ResolvedTimeouts,
    pub records: ResolvedRecords,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedApproval {
    pub resolver: Option<String>,
    pub redactor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedPosture {
    pub tool_seam_host_error: ToolSeamPosture,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedTimeouts {
    pub interceptor_ms: Option<u64>,
    pub approval_resolver_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedRecords {
    pub max_buffered: Option<u64>,
}

/// Resolved surface (§7.7.4): the document's, or the code's when the
/// document stated none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedSurface {
    pub interception_points: BTreeSet<InterceptionPoint>,
    pub capabilities: BTreeSet<String>,
    pub profiles: BTreeMap<CompositionProfile, KnobSupport>,
    pub buffered_output: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exposure_bound: Option<String>,
    pub declaration_versions: BTreeSet<String>,
}

/// One binding with `at` and `timeout_ms` filled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedBinding {
    pub id: String,
    pub kind: String,
    pub config: Value,
    pub at: BTreeSet<InterceptionPoint>,
    pub timeout_ms: Option<u64>,
}

/// The resolved declaration (§7.7.3 "Resolved form"): every default
/// filled, composition knobs resolved exactly as
/// [`CompositionConfig::with_knob_defaults`] resolves them, `$schema`
/// dropped, sets sorted. Its canonical JSON is the equivalence oracle
/// for the three construction paths (§7.7.7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedDeclaration {
    pub declaration: String,
    pub spec: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<HostInfo>,
    pub configuration: ResolvedConfiguration,
    pub surface: ResolvedSurface,
    pub bindings: Vec<ResolvedBinding>,
    pub extensions: Map<String, Value>,
}

impl ResolvedDeclaration {
    /// RFC 8785 canonical JSON of the resolved form.
    pub fn canonical_json(&self) -> String {
        canonical::canonical_json(
            &serde_json::to_value(self).expect("resolved declaration serializes"),
        )
    }

    /// The composition `finalize` stamps; `with_knob_defaults` is a
    /// no-op on it.
    pub fn composition(&self) -> CompositionConfig {
        self.configuration.composition
    }

    /// The declared identity provider name (`None` is unbound).
    pub fn identity_provider(&self) -> Option<&str> {
        self.configuration.identity_provider.as_deref()
    }

    pub fn bindings(&self) -> &[ResolvedBinding] {
        &self.bindings
    }

    /// The contract version the document carried.
    pub fn version(&self) -> &str {
        &self.declaration
    }
}

fn get_str<'a>(m: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    m.get(k).and_then(Value::as_str)
}

fn get_obj<'a>(m: &'a Map<String, Value>, k: &str) -> Option<&'a Map<String, Value>> {
    m.get(k).and_then(Value::as_object)
}

/// `None` when absent, `Some(None)` when `null`, `Some(Some(n))`.
fn get_int_or_null(m: &Map<String, Value>, k: &str) -> Option<Option<u64>> {
    match m.get(k) {
        None => None,
        Some(Value::Null) => Some(None),
        Some(v) => Some(v.as_u64()),
    }
}

fn str_set(m: &Map<String, Value>, k: &str) -> Option<BTreeSet<String>> {
    m.get(k).and_then(Value::as_array).map(|a| {
        a.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

fn point_set(m: &Map<String, Value>, k: &str) -> Option<BTreeSet<InterceptionPoint>> {
    m.get(k).and_then(Value::as_array).map(|a| {
        a.iter()
            .filter_map(Value::as_str)
            .filter_map(|s| s.parse().ok())
            .collect()
    })
}

/// The document's composition as stated (knobs not yet resolved).
fn stated_composition(doc: &Map<String, Value>) -> CompositionConfig {
    let c = get_obj(doc, "configuration").and_then(|c| get_obj(c, "composition"));
    let profile = c
        .and_then(|c| get_str(c, "profile"))
        .and_then(CompositionProfile::from_wire)
        .unwrap_or(CompositionProfile::SequentialFirstDeny);
    let knob = |k: &str| c.and_then(|c| get_str(c, k));
    CompositionConfig {
        profile,
        on_approval: match knob("on_approval") {
            Some("stop") => Some(OnApproval::Stop),
            Some("resume") => Some(OnApproval::Resume),
            _ => None,
        },
        on_disagreement: match knob("on_disagreement") {
            Some("deny") => Some(SynthesisPolicy::Deny),
            Some("approval") => Some(SynthesisPolicy::Approval),
            _ => None,
        },
        on_transform_conflict: match knob("on_transform_conflict") {
            Some("deny") => Some(SynthesisPolicy::Deny),
            Some("approval") => Some(SynthesisPolicy::Approval),
            _ => None,
        },
    }
}

/// Fill the surface from the document and, for absent members, from
/// the code surface (`None` = fill nothing, keep stated members only).
fn resolve_surface(
    doc: &Map<String, Value>,
    code: Option<&HostSurface>,
) -> Option<ResolvedSurface> {
    let stated = get_obj(doc, "surface");
    let code = code?;
    let Some(s) = stated else {
        // §7.7.4: the host's own surface verbatim, including its
        // streaming posture. A host that mediates incrementally is
        // unbuffered and carries its exposure bound.
        let incremental = code.capabilities.contains("incremental_output");
        return Some(ResolvedSurface {
            interception_points: code.interception_points.clone(),
            capabilities: code.capabilities.clone(),
            profiles: code.profiles.clone(),
            buffered_output: !incremental,
            exposure_bound: if incremental {
                code.exposure_bound.clone()
            } else {
                None
            },
            declaration_versions: code.declaration_versions.clone(),
        });
    };
    let profiles = match get_obj(s, "profiles") {
        None => code.profiles.clone(),
        Some(p) => stated_profiles(p),
    };
    Some(ResolvedSurface {
        interception_points: point_set(s, "interception_points")
            .unwrap_or_else(|| code.interception_points.clone()),
        capabilities: str_set(s, "capabilities").unwrap_or_else(|| code.capabilities.clone()),
        profiles,
        buffered_output: s
            .get("buffered_output")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        exposure_bound: get_str(s, "exposure_bound").map(str::to_owned),
        declaration_versions: str_set(s, "declaration_versions")
            .unwrap_or_else(|| code.declaration_versions.clone()),
    })
}

fn stated_profiles(p: &Map<String, Value>) -> BTreeMap<CompositionProfile, KnobSupport> {
    let mut out = BTreeMap::new();
    for (name, knobs) in p {
        let Some(profile) = CompositionProfile::from_wire(name) else {
            continue;
        };
        let mut support = KnobSupport::defaults_only(profile);
        if let Some(obj) = knobs.as_object() {
            for knob in profile.consulted_knobs() {
                if let Some(set) = str_set(obj, knob) {
                    *support.knob_mut(knob) = set;
                }
            }
        }
        out.insert(profile, support);
    }
    out
}

/// Step 7. With `code` absent only members the document states are
/// checked; with `code` present the filled surface is checked too.
fn check_consistency(
    doc: &Map<String, Value>,
    code: Option<&HostSurface>,
) -> Result<(), DeclarationError> {
    let mut f = Vec::new();
    let stated_surface = get_obj(doc, "surface");
    // A finding on a surface member the document did not write names
    // the member as filled from the host surface (or defaulted), so an
    // operator is never pointed at text that is not there (§7.7.4).
    let filled_note = |pointer: &str| -> Option<String> {
        let member = pointer.strip_prefix("/surface/")?.split('/').next()?;
        if stated_surface.is_some_and(|s| s.contains_key(member)) {
            return None;
        }
        Some(match member {
            "buffered_output" | "exposure_bound" if stated_surface.is_some() => {
                format!(" (the document does not state /surface/{member}; the default applies)")
            }
            _ => format!(" (the document does not state /surface/{member}; it was filled from the host surface)"),
        })
    };
    let mut bad = |pointer: &str, detail: String| {
        let detail = match filled_note(pointer) {
            Some(note) => format!("{detail}{note}"),
            None => detail,
        };
        f.push(Finding {
            pointer: pointer.to_owned(),
            detail: truncate(detail),
        })
    };
    let surface = resolve_surface(doc, code);
    let points: Option<BTreeSet<InterceptionPoint>> = surface
        .as_ref()
        .map(|s| s.interception_points.clone())
        .or_else(|| stated_surface.and_then(|s| point_set(s, "interception_points")));
    let caps: Option<BTreeSet<String>> = surface
        .as_ref()
        .map(|s| s.capabilities.clone())
        .or_else(|| stated_surface.and_then(|s| str_set(s, "capabilities")));
    // The composition is checked against `surface.profiles` only when
    // the document states it; against the host's profiles it is a step
    // 8 check (`check_surface`), so the finding never points at a
    // member the document did not write.
    let profiles: Option<BTreeMap<CompositionProfile, KnobSupport>> = stated_surface
        .and_then(|s| get_obj(s, "profiles"))
        .map(stated_profiles);
    let versions: Option<BTreeSet<String>> = surface
        .as_ref()
        .map(|s| s.declaration_versions.clone())
        .or_else(|| stated_surface.and_then(|s| str_set(s, "declaration_versions")));
    let buffered = surface
        .as_ref()
        .map(|s| s.buffered_output)
        .or_else(|| {
            stated_surface
                .and_then(|s| s.get("buffered_output"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(true);

    // §3.2 floor and the omission pairs.
    if let Some(points) = &points {
        for p in FLOOR_POINTS {
            if !points.contains(&p) {
                bad(
                    "/surface/interception_points",
                    format!("the §3.2 floor requires {p}; omit only the model or tool points"),
                );
            }
        }
        let has = |p: InterceptionPoint| points.contains(&p);
        if has(InterceptionPoint::PreModelCall) != has(InterceptionPoint::PostModelCall) {
            bad(
                "/surface/interception_points",
                "pre_model_call and post_model_call are omitted together or not at all (see spec §3.2)".into(),
            );
        }
        if has(InterceptionPoint::PreToolCall) != has(InterceptionPoint::PostToolCall) {
            bad(
                "/surface/interception_points",
                "pre_tool_call and post_tool_call are omitted together or not at all (see spec §3.2)".into(),
            );
        }
        if let Some(caps) = &caps {
            let model_points =
                has(InterceptionPoint::PreModelCall) && has(InterceptionPoint::PostModelCall);
            let tool_points =
                has(InterceptionPoint::PreToolCall) && has(InterceptionPoint::PostToolCall);
            if caps.contains("model_calls") != model_points {
                bad(
                    "/surface/capabilities",
                    "model_calls is listed iff both model points are listed (see spec §3.2)".into(),
                );
            }
            if caps.contains("tool_calls") != tool_points {
                bad(
                    "/surface/capabilities",
                    "tool_calls is listed iff both tool points are listed (see spec §3.2)".into(),
                );
            }
        }
    }
    if let Some(caps) = &caps {
        if caps.contains("incremental_output") && buffered {
            bad(
                "/surface/capabilities",
                "incremental_output requires buffered_output: false (see spec §12.1)".into(),
            );
        }
    }

    // Knobs only under the profile that consults them; the configured
    // composition inside the declared surface.
    let stated = stated_composition(doc);
    let consulted = stated.profile.consulted_knobs();
    let knob_present = |k: &str| {
        get_obj(doc, "configuration")
            .and_then(|c| get_obj(c, "composition"))
            .is_some_and(|c| c.contains_key(k))
    };
    for knob in ["on_approval", "on_disagreement", "on_transform_conflict"] {
        if knob_present(knob) && !consulted.contains(&knob) {
            bad(
                &ptr("/configuration/composition", knob),
                format!(
                    "{} does not consult {knob}; the member is refused, not cleared",
                    stated.profile.as_str()
                ),
            );
        }
    }
    let resolved = stated.with_knob_defaults();
    if let Some(profiles) = &profiles {
        match profiles.get(&resolved.profile) {
            None => bad(
                "/configuration/composition/profile",
                format!("{} is not in surface.profiles", resolved.profile.as_str()),
            ),
            Some(support) => {
                let values: [(&str, Option<String>); 3] = [
                    (
                        "on_approval",
                        resolved.on_approval.map(|v| v.as_str().to_owned()),
                    ),
                    (
                        "on_disagreement",
                        resolved.on_disagreement.map(|v| v.as_str().to_owned()),
                    ),
                    (
                        "on_transform_conflict",
                        resolved
                            .on_transform_conflict
                            .map(|v| v.as_str().to_owned()),
                    ),
                ];
                for (knob, value) in values {
                    if let Some(v) = value {
                        if !support.knob(knob).contains(&v) {
                            bad(
                                &ptr("/configuration/composition", knob),
                                format!(
                                    "{v:?} is not in surface.profiles for {}",
                                    resolved.profile.as_str()
                                ),
                            );
                        }
                    }
                }
            }
        }
    }

    // The document's own version is in its accepted set.
    if let (Some(versions), Some(own)) = (&versions, get_str(doc, "declaration")) {
        if !versions.contains(own) {
            bad(
                "/surface/declaration_versions",
                format!("must include the document's own declaration {own:?}"),
            );
        }
    }

    // Bindings: `at` within the surface; unique ids.
    let mut ids = BTreeSet::new();
    for (i, b) in doc
        .get("bindings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let Some(obj) = b.as_object() else { continue };
        if let Some(id) = get_str(obj, "id") {
            if !ids.insert(id) {
                bad(
                    &format!("/bindings/{i}/id"),
                    format!("binding id {id:?} is used twice"),
                );
            }
        }
        if let (Some(at), Some(points)) = (point_set(obj, "at"), &points) {
            for p in at.difference(points) {
                bad(
                    &format!("/bindings/{i}/at"),
                    format!("{p} is not in surface.interception_points"),
                );
            }
        }
    }

    if f.is_empty() {
        Ok(())
    } else {
        Err(DeclarationError::many(
            DeclarationErrorClass::Inconsistent,
            f,
        ))
    }
}

/// Step 8: the resolved surface and configuration against the code.
fn check_surface(
    doc: &Map<String, Value>,
    resolved: &ResolvedDeclaration,
    code: &HostSurface,
) -> Result<(), DeclarationError> {
    let mut f = Vec::new();
    let mut bad = |pointer: &str, detail: String| {
        f.push(Finding {
            pointer: pointer.to_owned(),
            detail: truncate(detail),
        })
    };
    let s = &resolved.surface;
    for p in s.interception_points.difference(&code.interception_points) {
        bad(
            "/surface/interception_points",
            format!("the host does not emit {p}"),
        );
    }
    for c in s.capabilities.difference(&code.capabilities) {
        bad(
            "/surface/capabilities",
            format!("the host does not have capability {c:?}"),
        );
    }
    for (profile, support) in &s.profiles {
        match code.profiles.get(profile) {
            None => bad(
                &ptr("/surface/profiles", profile.as_str()),
                "the host does not support this profile".into(),
            ),
            Some(code_support) => {
                if !support.subset_of(code_support) {
                    bad(
                        &ptr("/surface/profiles", profile.as_str()),
                        "the host does not support every listed knob value".into(),
                    );
                }
            }
        }
    }
    for v in s
        .declaration_versions
        .difference(&code.declaration_versions)
    {
        bad(
            "/surface/declaration_versions",
            format!("the host does not accept {v:?}"),
        );
    }
    let composition = &resolved.configuration.composition;
    match code.profiles.get(&composition.profile) {
        None => bad(
            "/configuration/composition/profile",
            format!(
                "the host does not support profile {}",
                composition.profile.as_str()
            ),
        ),
        Some(support) => {
            let values: [(&str, Option<String>); 3] = [
                (
                    "on_approval",
                    composition.on_approval.map(|v| v.as_str().to_owned()),
                ),
                (
                    "on_disagreement",
                    composition.on_disagreement.map(|v| v.as_str().to_owned()),
                ),
                (
                    "on_transform_conflict",
                    composition
                        .on_transform_conflict
                        .map(|v| v.as_str().to_owned()),
                ),
            ];
            for (knob, value) in values {
                if let Some(v) = value {
                    if !support.knob(knob).contains(&v) {
                        bad(
                            &ptr("/configuration/composition", knob),
                            format!(
                                "the host does not support {knob} value {v:?} under {}",
                                composition.profile.as_str()
                            ),
                        );
                    }
                }
            }
        }
    }
    if !s.buffered_output && !code.streams_unbuffered {
        bad(
            "/surface/buffered_output",
            "the host buffers caller-bound output and cannot declare false".into(),
        );
    }
    let posture = resolved.configuration.posture.tool_seam_host_error;
    if posture != code.tool_seam_host_error {
        bad(
            "/configuration/posture/tool_seam_host_error",
            format!(
                "the host implements {}, not {}",
                code.tool_seam_host_error.as_str(),
                posture.as_str()
            ),
        );
    }
    if code.interceptor_timeout == TimeoutSupport::Unbounded {
        let fix = "this build cannot bound execution: write null or enable the timeout feature (see spec §7.7.6)";
        if resolved.configuration.timeouts.interceptor_ms.is_some() {
            bad("/configuration/timeouts/interceptor_ms", fix.into());
        }
        if resolved
            .configuration
            .timeouts
            .approval_resolver_ms
            .is_some()
        {
            bad("/configuration/timeouts/approval_resolver_ms", fix.into());
        }
        for (i, b) in resolved.bindings.iter().enumerate() {
            let stated = doc
                .get("bindings")
                .and_then(Value::as_array)
                .and_then(|a| a.get(i))
                .and_then(Value::as_object)
                .is_some_and(|o| o.get("timeout_ms").is_some_and(|t| !t.is_null()));
            if stated && b.timeout_ms.is_some() {
                bad(&format!("/bindings/{i}/timeout_ms"), fix.into());
            }
        }
    }
    if f.is_empty() {
        Ok(())
    } else {
        Err(DeclarationError::many(
            DeclarationErrorClass::SurfaceUnsupported,
            f,
        ))
    }
}

/// Steps 9 and 10.
fn check_names(
    resolved: &ResolvedDeclaration,
    names: &RegistryNames,
) -> Result<(), DeclarationError> {
    let mut f = Vec::new();
    if let Some(p) = resolved.identity_provider() {
        if p != JCS_SHA256 && !names.identity_providers.contains(p) {
            f.push(Finding {
                pointer: "/configuration/identity_provider".into(),
                detail: format!("no identity provider named {p:?} is registered"),
            });
        }
    }
    if let Some(r) = &resolved.configuration.approval.resolver {
        if !names.approval_resolvers.contains(r) {
            f.push(Finding {
                pointer: "/configuration/approval/resolver".into(),
                detail: format!("no approval resolver named {r:?} is registered"),
            });
        }
    }
    if let Some(r) = &resolved.configuration.approval.redactor {
        if !names.approval_redactors.contains(r) {
            f.push(Finding {
                pointer: "/configuration/approval/redactor".into(),
                detail: format!("no approval redactor named {r:?} is registered"),
            });
        }
    }
    if !f.is_empty() {
        return Err(DeclarationError::many(
            DeclarationErrorClass::ReferenceUnresolved,
            f,
        ));
    }
    for (i, b) in resolved.bindings.iter().enumerate() {
        if !names.kinds.contains(&b.kind) {
            f.push(Finding {
                pointer: format!("/bindings/{i}/kind"),
                detail: format!(
                    "no resolver is registered for kind {:?} (binding {:?})",
                    b.kind, b.id
                ),
            });
        }
    }
    if f.is_empty() {
        Ok(())
    } else {
        Err(DeclarationError::many(
            DeclarationErrorClass::KindUnknown,
            f,
        ))
    }
}

fn fill(doc: &Map<String, Value>, code: &HostSurface) -> ResolvedDeclaration {
    let cfg = get_obj(doc, "configuration");
    let sub = |k: &str| cfg.and_then(|c| get_obj(c, k));
    let mode = match cfg.and_then(|c| get_str(c, "mode")) {
        Some("evaluate_only") => EnforcementMode::EvaluateOnly,
        _ => EnforcementMode::Enforce,
    };
    let identity_provider = match cfg.and_then(|c| c.get("identity_provider")) {
        None => Some(JCS_SHA256.to_owned()),
        Some(Value::Null) => None,
        Some(v) => v.as_str().map(str::to_owned),
    };
    let approval = sub("approval");
    let interceptor_ms = sub("timeouts")
        .and_then(|t| get_int_or_null(t, "interceptor_ms"))
        .unwrap_or(Some(5000));
    let approval_resolver_ms = sub("timeouts")
        .and_then(|t| get_int_or_null(t, "approval_resolver_ms"))
        .unwrap_or(interceptor_ms);
    let surface = resolve_surface(doc, Some(code)).expect("code surface present");
    let bindings = doc
        .get("bindings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|b| ResolvedBinding {
            id: get_str(b, "id").unwrap_or_default().to_owned(),
            kind: get_str(b, "kind").unwrap_or_default().to_owned(),
            config: b
                .get("config")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new())),
            at: point_set(b, "at").unwrap_or_else(|| surface.interception_points.clone()),
            timeout_ms: get_int_or_null(b, "timeout_ms").unwrap_or(interceptor_ms),
        })
        .collect();
    ResolvedDeclaration {
        declaration: get_str(doc, "declaration").unwrap_or_default().to_owned(),
        spec: get_str(doc, "spec").unwrap_or(SPEC_VERSION).to_owned(),
        id: get_str(doc, "id").map(str::to_owned),
        host: get_obj(doc, "host").map(|h| HostInfo {
            name: get_str(h, "name").unwrap_or_default().to_owned(),
            version: get_str(h, "version").map(str::to_owned),
        }),
        configuration: ResolvedConfiguration {
            mode,
            composition: stated_composition(doc).with_knob_defaults(),
            identity_provider,
            approval: ResolvedApproval {
                resolver: approval
                    .and_then(|a| get_str(a, "resolver"))
                    .map(str::to_owned),
                redactor: approval
                    .and_then(|a| get_str(a, "redactor"))
                    .map(str::to_owned),
            },
            posture: ResolvedPosture {
                tool_seam_host_error: match sub("posture")
                    .and_then(|p| get_str(p, "tool_seam_host_error"))
                {
                    Some("terminate") => ToolSeamPosture::Terminate,
                    _ => ToolSeamPosture::Continue,
                },
            },
            timeouts: ResolvedTimeouts {
                interceptor_ms,
                approval_resolver_ms,
            },
            records: ResolvedRecords {
                max_buffered: sub("records")
                    .and_then(|r| get_int_or_null(r, "max_buffered"))
                    .unwrap_or(None),
            },
        },
        surface,
        bindings,
        extensions: get_obj(doc, "extensions").cloned().unwrap_or_default(),
    }
}

/// Steps 7 (on the filled surface) and 8: resolve a validated
/// declaration against the host's code surface without a registry.
/// The CTK uses this on a harness's own document to learn the surface
/// a run is assessed against (§7.7.9).
pub fn resolve_surface_only(
    decl: &HostDeclaration,
    surface: &HostSurface,
) -> Result<ResolvedDeclaration, DeclarationError> {
    surface.validate()?;
    check_consistency(&decl.doc, Some(surface))?;
    let resolved = fill(&decl.doc, surface);
    check_surface(&decl.doc, &resolved, surface)?;
    Ok(resolved)
}

/// Steps 7 (filled), 8, 9 and 10: resolve a validated declaration
/// against the host's surface and registered names.
pub fn resolve(
    decl: &HostDeclaration,
    surface: &HostSurface,
    names: &RegistryNames,
) -> Result<ResolvedDeclaration, DeclarationError> {
    let resolved = resolve_surface_only(decl, surface)?;
    check_names(&resolved, names)?;
    Ok(resolved)
}

/// Bring a document from an older accepted minor to `to` (§7.7.2).
/// For `agent-hooks-declaration/1.0` the only step is the identity;
/// the function exists so the shape is in place for later versions.
pub fn migrate(doc: Value, to: &str) -> Result<Value, DeclarationError> {
    if !SUPPORTED_DECLARATION_VERSIONS.contains(&to) {
        return Err(DeclarationError::version(format!(
            "cannot migrate to {to:?}"
        )));
    }
    let from = doc
        .get("declaration")
        .and_then(Value::as_str)
        .ok_or_else(|| DeclarationError::version("declaration is missing or not a string"))?;
    if from == to {
        return Ok(doc);
    }
    Err(DeclarationError::version(format!(
        "no migration step from {from:?} to {to:?}"
    )))
}

// ---- builder (code path) -----------------------------------------------------

/// Builds a declaration document in code, one setter per member
/// (§7.7.7). [`Self::build`] hands the document to
/// [`HostDeclaration::from_value`], so the code path is validated by
/// the same function, with the same classes, as a file.
#[derive(Debug, Clone)]
pub struct DeclarationBuilder {
    doc: Map<String, Value>,
}

impl Default for DeclarationBuilder {
    fn default() -> Self {
        let mut doc = Map::new();
        doc.insert(
            "declaration".into(),
            Value::String(DECLARATION_VERSION.into()),
        );
        doc.insert("bindings".into(), Value::Array(Vec::new()));
        Self { doc }
    }
}

impl DeclarationBuilder {
    /// A builder with no member set at all, not even `declaration` or
    /// `bindings`. For harnesses that must express an incomplete
    /// document; a host wants [`Default`].
    pub fn empty() -> Self {
        Self { doc: Map::new() }
    }

    fn configuration(&mut self) -> &mut Map<String, Value> {
        self.doc
            .entry("configuration")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .expect("configuration is an object")
    }

    fn configuration_sub(&mut self, key: &str) -> &mut Map<String, Value> {
        self.configuration()
            .entry(key)
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .expect("configuration member is an object")
    }

    fn surface(&mut self) -> &mut Map<String, Value> {
        self.doc
            .entry("surface")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .expect("surface is an object")
    }

    /// `declaration` (defaults to [`DECLARATION_VERSION`]).
    pub fn version(mut self, v: &str) -> Self {
        self.doc
            .insert("declaration".into(), Value::String(v.into()));
        self
    }

    pub fn spec(mut self, v: &str) -> Self {
        self.doc.insert("spec".into(), Value::String(v.into()));
        self
    }

    pub fn id(mut self, v: &str) -> Self {
        self.doc.insert("id".into(), Value::String(v.into()));
        self
    }

    pub fn host(mut self, name: &str, version: Option<&str>) -> Self {
        let mut h = Map::new();
        h.insert("name".into(), Value::String(name.into()));
        if let Some(v) = version {
            h.insert("version".into(), Value::String(v.into()));
        }
        self.doc.insert("host".into(), Value::Object(h));
        self
    }

    pub fn mode(mut self, mode: EnforcementMode) -> Self {
        let v = match mode {
            EnforcementMode::Enforce => "enforce",
            EnforcementMode::EvaluateOnly => "evaluate_only",
        };
        self.configuration()
            .insert("mode".into(), Value::String(v.into()));
        self
    }

    /// The composition as the host states it. Knobs the profile does
    /// not consult are written out and refused by [`Self::build`],
    /// exactly as in a file.
    pub fn composition(mut self, c: CompositionConfig) -> Self {
        let v = serde_json::to_value(c).expect("composition serializes");
        self.configuration().insert("composition".into(), v);
        self
    }

    /// `Some(name)` for `jcs-sha256` or a custom provider, `None` for
    /// identity-unbound (written as `null`).
    pub fn identity_provider(mut self, name: Option<&str>) -> Self {
        let v = name.map_or(Value::Null, |n| Value::String(n.into()));
        self.configuration().insert("identity_provider".into(), v);
        self
    }

    pub fn approval_resolver(mut self, name: Option<&str>) -> Self {
        let v = name.map_or(Value::Null, |n| Value::String(n.into()));
        self.configuration_sub("approval")
            .insert("resolver".into(), v);
        self
    }

    pub fn approval_redactor(mut self, name: Option<&str>) -> Self {
        let v = name.map_or(Value::Null, |n| Value::String(n.into()));
        self.configuration_sub("approval")
            .insert("redactor".into(), v);
        self
    }

    pub fn tool_seam_host_error(mut self, posture: ToolSeamPosture) -> Self {
        self.configuration_sub("posture").insert(
            "tool_seam_host_error".into(),
            Value::String(posture.as_str().into()),
        );
        self
    }

    /// `None` writes `null` (unbounded).
    pub fn interceptor_timeout_ms(mut self, ms: Option<u64>) -> Self {
        self.configuration_sub("timeouts")
            .insert("interceptor_ms".into(), ms.map_or(Value::Null, Value::from));
        self
    }

    /// `None` writes `null` (unbounded).
    pub fn approval_resolver_timeout_ms(mut self, ms: Option<u64>) -> Self {
        self.configuration_sub("timeouts").insert(
            "approval_resolver_ms".into(),
            ms.map_or(Value::Null, Value::from),
        );
        self
    }

    /// `None` writes `null` (unbounded).
    pub fn max_buffered_records(mut self, n: Option<u64>) -> Self {
        self.configuration_sub("records")
            .insert("max_buffered".into(), n.map_or(Value::Null, Value::from));
        self
    }

    pub fn surface_points(mut self, points: impl IntoIterator<Item = InterceptionPoint>) -> Self {
        let set: BTreeSet<InterceptionPoint> = points.into_iter().collect();
        self.surface().insert(
            "interception_points".into(),
            Value::Array(
                set.into_iter()
                    .map(|p| Value::String(p.as_str().into()))
                    .collect(),
            ),
        );
        self
    }

    pub fn surface_capabilities(mut self, caps: impl IntoIterator<Item = String>) -> Self {
        let set: BTreeSet<String> = caps.into_iter().collect();
        self.surface().insert(
            "capabilities".into(),
            Value::Array(set.into_iter().map(Value::String).collect()),
        );
        self
    }

    /// Declare support for one profile and its knob values.
    pub fn surface_profile(mut self, profile: CompositionProfile, knobs: KnobSupport) -> Self {
        let profiles = self
            .surface()
            .entry("profiles")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .expect("profiles is an object");
        profiles.insert(
            profile.as_str().into(),
            serde_json::to_value(knobs).expect("knob support serializes"),
        );
        self
    }

    /// `buffered_output` and, when `false`, the required exposure bound.
    pub fn buffered_output(mut self, buffered: bool, exposure_bound: Option<&str>) -> Self {
        self.surface()
            .insert("buffered_output".into(), Value::Bool(buffered));
        if let Some(b) = exposure_bound {
            self.surface()
                .insert("exposure_bound".into(), Value::String(b.into()));
        } else {
            self.surface().remove("exposure_bound");
        }
        self
    }

    pub fn surface_declaration_versions(
        mut self,
        versions: impl IntoIterator<Item = String>,
    ) -> Self {
        let set: BTreeSet<String> = versions.into_iter().collect();
        self.surface().insert(
            "declaration_versions".into(),
            Value::Array(set.into_iter().map(Value::String).collect()),
        );
        self
    }

    /// Append one binding. `at: None` binds at every surface point;
    /// `timeout_ms: None` inherits the configured interceptor timeout,
    /// `Some(None)` writes `null` (unbounded), `Some(Some(ms))` bounds.
    pub fn bind(
        mut self,
        id: &str,
        kind: &str,
        config: Value,
        at: Option<&[InterceptionPoint]>,
        timeout_ms: Option<Option<u64>>,
    ) -> Self {
        let mut b = Map::new();
        b.insert("id".into(), Value::String(id.into()));
        b.insert("kind".into(), Value::String(kind.into()));
        b.insert("config".into(), config);
        if let Some(at) = at {
            let set: BTreeSet<InterceptionPoint> = at.iter().copied().collect();
            b.insert(
                "at".into(),
                Value::Array(
                    set.into_iter()
                        .map(|p| Value::String(p.as_str().into()))
                        .collect(),
                ),
            );
        }
        if let Some(t) = timeout_ms {
            b.insert("timeout_ms".into(), t.map_or(Value::Null, Value::from));
        }
        self.doc
            .entry("bindings")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .expect("bindings is an array")
            .push(Value::Object(b));
        self
    }

    /// One `extensions` entry, kept verbatim.
    pub fn extension(mut self, key: &str, value: Value) -> Self {
        self.doc
            .entry("extensions")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .expect("extensions is an object")
            .insert(key.into(), value);
        self
    }

    /// Set a top-level member verbatim. For members this builder has
    /// no setter for; the result is validated like any other document
    /// (an unknown member is refused as `unknown_field`).
    pub fn raw(mut self, key: &str, value: Value) -> Self {
        self.doc.insert(key.into(), value);
        self
    }

    /// The document as built, before validation.
    pub fn to_value(&self) -> Value {
        Value::Object(self.doc.clone())
    }

    /// Validate (steps 2 to 7) through [`HostDeclaration::from_value`].
    pub fn build(self) -> Result<HostDeclaration, DeclarationError> {
        HostDeclaration::from_value(Value::Object(self.doc))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn surface() -> HostSurface {
        let mut s = HostSurface::sdk_default()
            .with_points(ALL_POINTS)
            .with_capabilities([
                "model_calls".into(),
                "tool_calls".into(),
                "int64_json".into(),
            ]);
        s.interceptor_timeout = TimeoutSupport::Bounded;
        s
    }

    fn names() -> RegistryNames {
        RegistryNames {
            identity_providers: ["hmac-sha256-k1".to_owned()].into_iter().collect(),
            approval_resolvers: ["operator-queue".to_owned()].into_iter().collect(),
            approval_redactors: ["strip-secrets".to_owned()].into_iter().collect(),
            kinds: [
                "com.example.allow".to_owned(),
                "com.example.egress".to_owned(),
            ]
            .into_iter()
            .collect(),
        }
    }

    fn minimal() -> Value {
        json!({
            "declaration": "agent-hooks-declaration/1.0",
            "bindings": [{ "id": "allow", "kind": "com.example.allow" }]
        })
    }

    fn load(v: Value) -> Result<ResolvedDeclaration, DeclarationError> {
        let d = HostDeclaration::from_value(v)?;
        resolve(&d, &surface(), &names())
    }

    fn class_of(v: Value) -> (DeclarationErrorClass, Vec<String>) {
        let e = load(v).expect_err("expected refusal");
        (
            e.class,
            e.findings.iter().map(|f| f.pointer.clone()).collect(),
        )
    }

    #[test]
    fn minimal_document_resolves_to_spec_defaults() {
        let r = load(minimal()).unwrap();
        assert_eq!(r.declaration, DECLARATION_VERSION);
        assert_eq!(r.spec, SPEC_VERSION);
        assert_eq!(r.configuration.mode, EnforcementMode::Enforce);
        assert_eq!(r.configuration.composition, CompositionConfig::default());
        assert_eq!(r.identity_provider(), Some(JCS_SHA256));
        assert_eq!(r.configuration.approval.resolver, None);
        assert_eq!(
            r.configuration.posture.tool_seam_host_error,
            ToolSeamPosture::Continue
        );
        assert_eq!(r.configuration.timeouts.interceptor_ms, Some(5000));
        assert_eq!(r.configuration.timeouts.approval_resolver_ms, Some(5000));
        assert_eq!(r.configuration.records.max_buffered, None);
        assert_eq!(r.surface.interception_points.len(), 8);
        assert!(r.surface.buffered_output);
        assert_eq!(r.bindings.len(), 1);
        assert_eq!(r.bindings[0].at.len(), 8);
        assert_eq!(r.bindings[0].timeout_ms, Some(5000));
        assert_eq!(r.bindings[0].config, json!({}));
    }

    #[test]
    fn version_checks_run_first() {
        let (c, p) = class_of(json!({"bindings": "nope", "policy": 1}));
        assert_eq!(c, DeclarationErrorClass::VersionUnsupported);
        assert_eq!(p, ["/declaration"]);
        let (c, _) =
            class_of(json!({"declaration": "agent-hooks-declaration/0.1", "bindings": []}));
        assert_eq!(c, DeclarationErrorClass::VersionUnsupported);
        let (c, _) =
            class_of(json!({"declaration": "agent-hooks-declaration/1.9", "bindings": []}));
        assert_eq!(c, DeclarationErrorClass::VersionUnsupported);
        let (c, _) = class_of(json!({"declaration": 1, "bindings": []}));
        assert_eq!(c, DeclarationErrorClass::VersionUnsupported);
        let e = load(json!({"declaration": "x", "bindings": []})).unwrap_err();
        assert_eq!(e.accepted, vec![DECLARATION_VERSION.to_owned()]);
        assert!(e.findings[0]
            .detail
            .contains("accepted: agent-hooks-declaration/1.0"));
    }

    #[test]
    fn spec_unsupported() {
        let mut v = minimal();
        v["spec"] = json!("agent-hooks/9.0");
        let (c, p) = class_of(v.clone());
        assert_eq!(c, DeclarationErrorClass::SpecUnsupported);
        assert_eq!(p, ["/spec"]);
        v["spec"] = json!("agent-hooks/0.0");
        assert!(
            load(v.clone()).is_ok(),
            "lower minor of the same major is accepted"
        );
        v["spec"] = json!("agent-hooks/0.1");
        assert!(load(v).is_ok());
    }

    #[test]
    fn unknown_fields_everywhere() {
        let mut v = minimal();
        v["policy"] = json!({});
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::UnknownField);
        assert_eq!(p, ["/policy"]);
        let mut v = minimal();
        v["configuration"] = json!({"composition": {"on_timeout": "deny"}});
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::UnknownField);
        assert_eq!(p, ["/configuration/composition/on_timeout"]);
        let mut v = minimal();
        v["bindings"][0]["extra"] = json!(1);
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::UnknownField);
        assert_eq!(p, ["/bindings/0/extra"]);
        let mut v = minimal();
        v["surface"] = json!({"profiles": {"sequential/run_all": {"on_approval": ["stop"]}}});
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::UnknownField);
        assert_eq!(p, ["/surface/profiles/sequential~1run_all/on_approval"]);
    }

    #[test]
    fn unknown_field_wins_over_invalid_field() {
        let mut v = minimal();
        v["policy"] = json!({});
        v["configuration"] = json!({"mode": "audit"});
        let (c, _) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::UnknownField);
    }

    #[test]
    fn invalid_fields() {
        let mut v = minimal();
        v["configuration"] = json!({"mode": "audit"});
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::InvalidField);
        assert_eq!(p, ["/configuration/mode"]);
        let mut v = minimal();
        v["configuration"] = json!({"identity_provider": "jcs-fake"});
        assert_eq!(class_of(v).0, DeclarationErrorClass::InvalidField);
        let mut v = minimal();
        v["configuration"] = json!({"timeouts": {"interceptor_ms": 0}});
        assert_eq!(class_of(v).0, DeclarationErrorClass::InvalidField);
        let mut v = minimal();
        v["bindings"][0]["kind"] = json!("nodot");
        assert_eq!(class_of(v).0, DeclarationErrorClass::InvalidField);
        let mut v = minimal();
        v["surface"] = json!({"buffered_output": false});
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::InvalidField);
        assert_eq!(p, ["/surface/exposure_bound"]);
        let mut v = minimal();
        v["extensions"] = json!({"Bad": 1});
        assert_eq!(class_of(v).0, DeclarationErrorClass::InvalidField);
        let mut v = minimal();
        v["surface"] = json!({"interception_points": ["input", "input", "output", "agent_startup", "agent_shutdown"]});
        assert_eq!(class_of(v).0, DeclarationErrorClass::InvalidField);
        let mut v = minimal();
        v["host"] = json!({"version": "1"});
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::InvalidField);
        assert_eq!(p, ["/host/name"]);
        let (c, _) = class_of(json!({"declaration": "agent-hooks-declaration/1.0"}));
        assert_eq!(c, DeclarationErrorClass::InvalidField);
    }

    #[test]
    fn knob_matrix() {
        use CompositionProfile as P;
        for profile in P::ALL {
            for knob in ["on_approval", "on_disagreement", "on_transform_conflict"] {
                let mut v = minimal();
                let value = knob_values(knob)[1];
                v["configuration"] =
                    json!({"composition": {"profile": profile.as_str(), knob: value}});
                let r = load(v);
                if profile.consulted_knobs().contains(&knob) {
                    let r = r.unwrap();
                    let got = serde_json::to_value(r.composition()).unwrap();
                    assert_eq!(got[knob], value, "{profile:?} {knob}");
                } else {
                    let e = r.unwrap_err();
                    assert_eq!(
                        e.class,
                        DeclarationErrorClass::Inconsistent,
                        "{profile:?} {knob}"
                    );
                    assert_eq!(
                        e.findings[0].pointer,
                        ptr("/configuration/composition", knob)
                    );
                }
            }
            // Defaults fill exactly as with_knob_defaults.
            let mut v = minimal();
            v["configuration"] = json!({"composition": {"profile": profile.as_str()}});
            let r = load(v).unwrap();
            let expect = CompositionConfig {
                profile,
                on_approval: None,
                ..CompositionConfig::default()
            };
            assert_eq!(r.composition(), expect.with_knob_defaults());
        }
    }

    #[test]
    fn floor_and_pairs() {
        let mut v = minimal();
        v["surface"] = json!({"interception_points": ["agent_startup", "input", "output", "pre_tool_call", "post_tool_call"]});
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::Inconsistent);
        // The stated-members pass (step 7 in from_value) reports the
        // floor; the capability pair is checked once defaults fill in.
        assert_eq!(p, ["/surface/interception_points"]);
        let mut v = minimal();
        v["surface"] = json!({"interception_points": ["agent_startup", "input", "output", "agent_shutdown", "pre_tool_call"]});
        assert_eq!(class_of(v).0, DeclarationErrorClass::Inconsistent);
        let mut v = minimal();
        v["surface"] = json!({"capabilities": ["host_declaration", "tool_calls"]});
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::Inconsistent);
        assert_eq!(p, ["/surface/capabilities"]);
        let mut v = minimal();
        v["surface"] = json!({"interception_points": ["agent_startup", "input", "output", "agent_shutdown"], "capabilities": ["host_declaration"]});
        assert!(load(v).is_ok());
    }

    #[test]
    fn surface_profiles_default_means_default_value_only() {
        let mut v = minimal();
        v["surface"] = json!({"profiles": {"sequential/first_deny": {}}});
        v["configuration"] = json!({"composition": {"on_approval": "resume"}});
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::Inconsistent);
        assert_eq!(p, ["/configuration/composition/on_approval"]);
        let mut v = minimal();
        v["surface"] = json!({"profiles": {"sequential/run_all": {}}});
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::Inconsistent);
        assert_eq!(p, ["/configuration/composition/profile"]);
    }

    #[test]
    fn declaration_versions_rules() {
        let mut v = minimal();
        v["surface"] = json!({"declaration_versions": ["agent-hooks-declaration/0.1", "agent-hooks-declaration/1.0"]});
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::SurfaceUnsupported);
        assert_eq!(p, ["/surface/declaration_versions"]);
        let mut v = minimal();
        v["surface"] = json!({"declaration_versions": ["agent-hooks-declaration/2.0"]});
        assert_eq!(
            class_of(v).0,
            DeclarationErrorClass::Inconsistent,
            "own version missing"
        );
    }

    #[test]
    fn bindings_consistency() {
        let mut v = minimal();
        v["bindings"] = json!([{"id": "a", "kind": "com.example.allow"}, {"id": "a", "kind": "com.example.allow"}]);
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::Inconsistent);
        assert_eq!(p, ["/bindings/1/id"]);
        let mut v = minimal();
        v["surface"] = json!({"interception_points": ["agent_startup", "input", "output", "agent_shutdown"], "capabilities": ["host_declaration"]});
        v["bindings"][0]["at"] = json!(["pre_tool_call"]);
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::Inconsistent);
        assert_eq!(p, ["/bindings/0/at"]);
    }

    #[test]
    fn surface_against_code() {
        let mut narrow = surface();
        narrow.interception_points = FLOOR_POINTS.into_iter().collect();
        narrow.capabilities = ["host_declaration".to_owned()].into_iter().collect();
        narrow
            .profiles
            .remove(&CompositionProfile::ParallelUnanimous);
        let d = HostDeclaration::from_value(minimal()).unwrap();
        let r = resolve(&d, &narrow, &names()).unwrap();
        assert_eq!(
            r.surface.interception_points.len(),
            4,
            "absent surface takes the code's"
        );
        let mut v = minimal();
        v["surface"] = json!({"interception_points": ["agent_startup", "input", "pre_tool_call", "post_tool_call", "output", "agent_shutdown"], "capabilities": ["host_declaration", "tool_calls"]});
        let d = HostDeclaration::from_value(v).unwrap();
        let e = resolve(&d, &narrow, &names()).unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
        assert_eq!(e.findings.len(), 3, "{e}");
        let mut v = minimal();
        v["surface"] = json!({"profiles": {"parallel/unanimous": {}}});
        v["configuration"] = json!({"composition": {"profile": "parallel/unanimous"}});
        let d = HostDeclaration::from_value(v).unwrap();
        let e = resolve(&d, &narrow, &names()).unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
        let mut v = minimal();
        v["configuration"] = json!({"posture": {"tool_seam_host_error": "terminate"}});
        let d = HostDeclaration::from_value(v).unwrap();
        let e = resolve(&d, &surface(), &names()).unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
        assert_eq!(
            e.findings[0].pointer,
            "/configuration/posture/tool_seam_host_error"
        );
        let mut v = minimal();
        v["surface"] = json!({"buffered_output": false, "exposure_bound": "none"});
        let d = HostDeclaration::from_value(v).unwrap();
        let e = resolve(&d, &surface(), &names()).unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
        assert_eq!(e.findings[0].pointer, "/surface/buffered_output");
    }

    #[test]
    fn composition_against_host_profiles_without_stated_surface_profiles() {
        // No `surface.profiles` in the document: the composition is
        // checked against the host's profiles in step 8, and the
        // finding names the host, not a member the document never wrote.
        let mut narrow = surface();
        narrow
            .profiles
            .remove(&CompositionProfile::ParallelUnanimous);
        let mut v = minimal();
        v["configuration"] = json!({"composition": {"profile": "parallel/unanimous"}});
        let d = HostDeclaration::from_value(v).unwrap();
        let e = resolve(&d, &narrow, &names()).unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
        assert_eq!(e.findings.len(), 1, "{e}");
        assert_eq!(e.findings[0].pointer, "/configuration/composition/profile");
        assert_eq!(
            e.findings[0].detail,
            "the host does not support profile parallel/unanimous"
        );
        assert!(!e.findings[0].detail.contains("surface.profiles"));

        let mut stop_only = surface();
        stop_only.profiles.insert(
            CompositionProfile::SequentialFirstDeny,
            KnobSupport {
                on_approval: ["stop".to_owned()].into_iter().collect(),
                ..KnobSupport::default()
            },
        );
        let mut v = minimal();
        v["configuration"] = json!({"composition": {"on_approval": "resume"}});
        let d = HostDeclaration::from_value(v).unwrap();
        let e = resolve(&d, &stop_only, &names()).unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
        assert_eq!(e.findings.len(), 1, "{e}");
        assert_eq!(
            e.findings[0].pointer,
            "/configuration/composition/on_approval"
        );
        assert_eq!(
            e.findings[0].detail,
            "the host does not support on_approval value \"resume\" under sequential/first_deny"
        );
        // The same document with a `surface` that states no `profiles`
        // member resolves the same way.
        let mut v = minimal();
        v["surface"] = json!({"capabilities": ["host_declaration", "model_calls", "tool_calls", "int64_json"]});
        v["configuration"] = json!({"composition": {"on_approval": "resume"}});
        let d = HostDeclaration::from_value(v).unwrap();
        let e = resolve(&d, &stop_only, &names()).unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
        assert_eq!(
            e.findings[0].pointer,
            "/configuration/composition/on_approval"
        );
        // The supported default value loads.
        let d = HostDeclaration::from_value(minimal()).unwrap();
        assert!(resolve(&d, &stop_only, &names()).is_ok());
    }

    #[test]
    fn truncate_keeps_details_within_the_bound() {
        let long = "é".repeat(MAX_DETAIL_LEN + 40);
        let t = truncate(long);
        assert_eq!(t.chars().count(), MAX_DETAIL_LEN);
        assert!(t.ends_with('…'));
        let exact = "a".repeat(MAX_DETAIL_LEN);
        assert_eq!(truncate(exact.clone()), exact);
    }

    #[test]
    fn timeouts_refused_on_unbounded_build() {
        let mut unbounded = surface();
        unbounded.interceptor_timeout = TimeoutSupport::Unbounded;
        let d = HostDeclaration::from_value(minimal()).unwrap();
        let e = resolve(&d, &unbounded, &names()).unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
        assert_eq!(
            e.findings[0].pointer,
            "/configuration/timeouts/interceptor_ms"
        );
        assert!(e.findings[0].detail.contains("write null"));
        let mut v = minimal();
        v["configuration"] = json!({"timeouts": {"interceptor_ms": null}});
        let d = HostDeclaration::from_value(v).unwrap();
        let r = resolve(&d, &unbounded, &names()).unwrap();
        assert_eq!(r.configuration.timeouts.interceptor_ms, None);
        assert_eq!(r.configuration.timeouts.approval_resolver_ms, None);
        assert_eq!(r.bindings[0].timeout_ms, None);
    }

    #[test]
    fn references_and_kinds() {
        let mut v = minimal();
        v["configuration"] = json!({"identity_provider": "hmac-sha256-k2"});
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::ReferenceUnresolved);
        assert_eq!(p, ["/configuration/identity_provider"]);
        let mut v = minimal();
        v["configuration"] = json!({"approval": {"resolver": "nobody", "redactor": "nobody"}});
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::ReferenceUnresolved);
        assert_eq!(
            p,
            [
                "/configuration/approval/resolver",
                "/configuration/approval/redactor"
            ]
        );
        let mut v = minimal();
        v["configuration"] = json!({"identity_provider": "hmac-sha256-k1", "approval": {"resolver": "operator-queue", "redactor": "strip-secrets"}});
        assert!(load(v).is_ok());
        let mut v = minimal();
        v["bindings"] = json!([{"id": "a", "kind": "com.example.allow"}, {"id": "b", "kind": "ctk.nonexistent"}, {"id": "c", "kind": "com.example.none"}]);
        let (c, p) = class_of(v);
        assert_eq!(c, DeclarationErrorClass::KindUnknown);
        assert_eq!(p, ["/bindings/1/kind", "/bindings/2/kind"]);
    }

    #[test]
    fn parse_bounds_and_duplicates() {
        let e = HostDeclaration::from_json(
            "{\"declaration\": 1, \"declaration\": 2, \"bindings\": []}",
        )
        .unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::Malformed);
        assert!(e.findings[0].detail.contains("duplicate key"), "{e}");
        let e = HostDeclaration::from_json("[]").unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::Malformed);
        let e = HostDeclaration::from_json("{} trailing").unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::Malformed);
        let deep = format!("{}{}", "[".repeat(40), "]".repeat(40));
        let e = HostDeclaration::from_json(&deep).unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::Malformed);
        assert!(e.findings[0].detail.contains("nesting"), "{e}");
        let big = format!(
            "{{\"declaration\":\"x\",\"pad\":\"{}\"}}",
            "a".repeat(MAX_DOCUMENT_BYTES)
        );
        let e = HostDeclaration::from_json(&big).unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::Malformed);
        assert!(e.findings[0].detail.contains("bytes"), "{e}");
        let e = HostDeclaration::from_json("").unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::Malformed);
    }

    #[test]
    fn builder_equals_json() {
        let built = HostDeclaration::builder()
            .mode(EnforcementMode::EvaluateOnly)
            .composition(CompositionConfig::strictest(SynthesisPolicy::Approval))
            .identity_provider(None)
            .approval_resolver(Some("operator-queue"))
            .interceptor_timeout_ms(Some(2000))
            .bind(
                "egress",
                "com.example.egress",
                json!({"allow_hosts": ["internal.example"]}),
                Some(&[InterceptionPoint::PreToolCall, InterceptionPoint::Output]),
                Some(Some(1000)),
            )
            .bind("allow", "com.example.allow", json!({}), None, None)
            .extension("acme", json!({"team": "sec"}))
            .build()
            .unwrap();
        let text = r#"{
            "declaration": "agent-hooks-declaration/1.0",
            "configuration": {
                "mode": "evaluate_only",
                "composition": {"profile": "parallel/strictest", "on_transform_conflict": "approval"},
                "identity_provider": null,
                "approval": {"resolver": "operator-queue"},
                "timeouts": {"interceptor_ms": 2000}
            },
            "bindings": [
                {"id": "egress", "kind": "com.example.egress", "config": {"allow_hosts": ["internal.example"]}, "at": ["output", "pre_tool_call"], "timeout_ms": 1000},
                {"id": "allow", "kind": "com.example.allow"}
            ],
            "extensions": {"acme": {"team": "sec"}}
        }"#;
        let parsed = HostDeclaration::from_json(text).unwrap();
        let a = resolve(&built, &surface(), &names()).unwrap();
        let b = resolve(&parsed, &surface(), &names()).unwrap();
        assert_eq!(a.canonical_json(), b.canonical_json());
        assert_eq!(a.bindings[1].timeout_ms, Some(2000));
        assert_eq!(a.bindings[0].timeout_ms, Some(1000));
        assert_eq!(a.configuration.timeouts.approval_resolver_ms, Some(2000));
        assert!(a.identity_provider().is_none());
        // Points serialize in lifecycle order, not lexically.
        let c = a.canonical_json();
        assert!(c.contains("\"at\":[\"pre_tool_call\",\"output\"]"), "{c}");
    }

    #[test]
    fn builder_refuses_like_a_file() {
        let e = HostDeclaration::builder()
            .composition(CompositionConfig {
                profile: CompositionProfile::SequentialRunAll,
                on_approval: Some(OnApproval::Resume),
                on_disagreement: None,
                on_transform_conflict: None,
            })
            .build()
            .unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::Inconsistent);
        let e = HostDeclaration::builder()
            .raw("policy", json!(1))
            .build()
            .unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::UnknownField);
    }

    #[test]
    fn schema_is_dropped_and_extensions_kept() {
        let mut v = minimal();
        v["$schema"] = json!("https://example/schema.json");
        v["extensions"] = json!({"acme": {"any": [1, 2]}});
        let r = load(v).unwrap();
        let c = r.canonical_json();
        assert!(!c.contains("$schema"));
        assert!(c.contains("\"extensions\":{\"acme\":{\"any\":[1,2]}}"));
    }

    #[test]
    fn registry_rules() {
        let allow: KindResolver = Box::new(|_, _| Err("never".into()));
        let r = HostRegistry::new(surface()).kind("ctk.scripted", allow);
        assert!(r.is_err(), "reserved segment");
        let allow: KindResolver = Box::new(|_, _| Err("never".into()));
        assert!(HostRegistry::new(surface())
            .kind("agent_hooks.x", allow)
            .is_err());
        let allow: KindResolver = Box::new(|_, _| Err("never".into()));
        assert!(HostRegistry::for_conformance(surface())
            .kind("ctk.scripted", allow)
            .is_ok());
        let allow: KindResolver = Box::new(|_, _| Err("never".into()));
        assert!(HostRegistry::new(surface()).kind("nodot", allow).is_err());
        let a: KindResolver = Box::new(|_, _| Err("never".into()));
        let b: KindResolver = Box::new(|_, _| Err("never".into()));
        assert!(HostRegistry::new(surface())
            .kind("com.x.a", a)
            .unwrap()
            .kind("com.x.a", b)
            .is_err());
        assert!(HostRegistry::new(surface())
            .identity_provider("jcs-x", |_| String::new())
            .is_err());
        assert!(HostRegistry::new(surface())
            .approval_redactor("Bad", |c| c.clone())
            .is_err());
        let reg = HostRegistry::new(surface())
            .identity_provider("hmac-sha256-k1", |_| "x".into())
            .unwrap()
            .approval_redactor("strip", |c| c.clone())
            .unwrap();
        let n = reg.names();
        assert!(n.identity_providers.contains("hmac-sha256-k1"));
        assert!(n.approval_redactors.contains("strip"));
        assert!(n.kinds.is_empty());
    }

    #[test]
    fn migrate_identity_and_refusals() {
        let v = minimal();
        assert_eq!(migrate(v.clone(), DECLARATION_VERSION).unwrap(), v);
        let e = migrate(v.clone(), "agent-hooks-declaration/2.0").unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::VersionUnsupported);
        let mut old = v;
        old["declaration"] = json!("agent-hooks-declaration/0.9");
        let e = migrate(old, DECLARATION_VERSION).unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::VersionUnsupported);
    }

    #[test]
    fn error_display_and_json() {
        let e = DeclarationError::new(
            DeclarationErrorClass::KindUnknown,
            "/bindings/0/kind",
            "no resolver",
        );
        assert_eq!(
            e.to_string(),
            "declaration_error:kind_unknown: /bindings/0/kind: no resolver"
        );
        assert_eq!(e.code(), "declaration_error:kind_unknown");
        let d: Value = serde_json::from_str(&e.detail_json()).unwrap();
        assert_eq!(d["findings"][0]["pointer"], "/bindings/0/kind");
        for c in DeclarationErrorClass::ALL {
            assert_eq!(DeclarationErrorClass::from_code(c.code()), Some(c));
            assert_eq!(DeclarationErrorClass::from_code(c.as_str()), Some(c));
        }
    }

    #[test]
    fn host_surface_validation() {
        let mut s = surface();
        s.capabilities.insert("buffered_output".into());
        assert!(s.validate().is_err());
        let mut s = surface();
        s.declaration_versions
            .insert("agent-hooks-declaration/0.1".into());
        assert!(s.validate().is_err());
        let mut s = surface();
        s.interception_points.remove(&InterceptionPoint::Input);
        assert!(s.validate().is_err());
        let d = HostDeclaration::from_value(minimal()).unwrap();
        assert_eq!(
            resolve(&d, &s, &names()).unwrap_err().class,
            DeclarationErrorClass::SurfaceUnsupported
        );
        // The §3.2 pairs are a host-side rule too: a surface that keeps
        // model_calls while omitting the model points is a programming
        // error, reported against the host, not against a document
        // whose absent `surface` was filled from it.
        let mut s = surface();
        s.interception_points
            .remove(&InterceptionPoint::PreModelCall);
        s.interception_points
            .remove(&InterceptionPoint::PostModelCall);
        let e = s.validate().unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
        assert_eq!(e.findings.len(), 1);
        assert_eq!(e.findings[0].pointer, "/surface/capabilities");
        assert!(e.findings[0]
            .detail
            .starts_with("host surface lists model_calls"));
        let e = resolve(&d, &s, &names()).unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
        assert!(e.findings[0].detail.contains("host surface"));
        let mut s = surface();
        s.interception_points
            .remove(&InterceptionPoint::PostToolCall);
        let e = s.validate().unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
        assert_eq!(e.findings.len(), 2);
        assert_eq!(e.findings[0].pointer, "/surface/interception_points");
        assert!(e.findings[0].detail.contains("one tool point"));
        assert_eq!(e.findings[1].pointer, "/surface/capabilities");
        let mut s = surface();
        s.capabilities.remove("tool_calls");
        assert_eq!(
            s.validate().unwrap_err().findings[0].pointer,
            "/surface/capabilities"
        );
        let s = HostSurface::from_capabilities(
            ["model_calls".to_owned(), "int64_json".to_owned()],
            ToolSeamPosture::Terminate,
        );
        assert_eq!(s.interception_points.len(), 6);
        assert!(!s
            .interception_points
            .contains(&InterceptionPoint::PreToolCall));
        assert_eq!(s.tool_seam_host_error, ToolSeamPosture::Terminate);
        assert!(s.validate().is_ok());
    }

    fn incremental_surface() -> HostSurface {
        let mut s = HostSurface::from_capabilities(
            [
                "model_calls".to_owned(),
                "incremental_output".to_owned(),
                "host_declaration".to_owned(),
            ],
            ToolSeamPosture::Continue,
        )
        .with_exposure_bound("one chunk");
        s.interceptor_timeout = TimeoutSupport::Bounded;
        s
    }

    #[test]
    fn incremental_host_surface_requires_its_exposure_bound() {
        let mut s = incremental_surface();
        s.exposure_bound = None;
        let e = s.validate().unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
        assert_eq!(e.findings[0].pointer, "/surface/exposure_bound");
        let mut s = incremental_surface();
        s.streams_unbuffered = false;
        assert_eq!(
            s.validate().unwrap_err().findings[0].pointer,
            "/surface/capabilities"
        );
        assert!(incremental_surface().validate().is_ok());
    }

    #[test]
    fn absent_surface_carries_the_incremental_host_surface_verbatim() {
        // §7.7.4: a document that states no surface resolves to the
        // host's own surface, streaming posture included, and is
        // never refused for a member it did not write.
        let d = HostDeclaration::from_value(minimal()).unwrap();
        let r = resolve(&d, &incremental_surface(), &names()).unwrap();
        assert!(!r.surface.buffered_output);
        assert_eq!(r.surface.exposure_bound.as_deref(), Some("one chunk"));
        assert!(r.surface.capabilities.contains("incremental_output"));
        assert_eq!(r.surface.interception_points.len(), 6);
        // The same document on a buffering host stays buffered.
        let r = load(minimal()).unwrap();
        assert!(r.surface.buffered_output);
        assert_eq!(r.surface.exposure_bound, None);
    }

    #[test]
    fn findings_on_filled_surface_members_say_so() {
        // Points stated, capabilities filled from an incremental host:
        // the stated default buffered_output: true contradicts the
        // filled incremental_output, and the finding names the fill.
        let mut v = minimal();
        v["surface"] = json!({
            "interception_points": [
                "agent_startup", "input", "pre_model_call", "post_model_call",
                "output", "agent_shutdown"
            ]
        });
        let d = HostDeclaration::from_value(v).unwrap();
        let e = resolve(&d, &incremental_surface(), &names()).unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::Inconsistent);
        assert_eq!(e.findings.len(), 1, "{e}");
        assert_eq!(e.findings[0].pointer, "/surface/capabilities");
        assert!(
            e.findings[0].detail.contains(
                "does not state /surface/capabilities; it was filled from the host surface"
            ),
            "{}",
            e.findings[0].detail
        );
        // A stated member gets no such note.
        let mut v = minimal();
        v["surface"] =
            json!({"capabilities": ["incremental_output", "host_declaration", "model_calls"]});
        let e = HostDeclaration::from_value(v).unwrap_err();
        assert_eq!(e.class, DeclarationErrorClass::Inconsistent);
        let f = e
            .findings
            .iter()
            .find(|f| f.pointer == "/surface/capabilities")
            .unwrap();
        assert!(!f.detail.contains("filled from"), "{}", f.detail);
        assert!(f.detail.contains("buffered_output: false"), "{}", f.detail);
    }

    #[test]
    fn mirrored_enums_match_record_schema() {
        let schema: Value = serde_json::from_str(include_str!(
            "../../../../spec/schema/interception-record.schema.json"
        ))
        .unwrap();
        let profiles: Vec<&str> = schema["properties"]["composition"]["properties"]["profile"]
            ["enum"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(profiles, CompositionProfile::ALL.map(|p| p.as_str()));
        for knob in ["on_approval", "on_disagreement", "on_transform_conflict"] {
            let vals: Vec<&str> = schema["properties"]["composition"]["properties"][knob]["enum"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .collect();
            assert_eq!(vals, knob_values(knob), "{knob}");
        }
        let decl: Value = serde_json::from_str(include_str!(
            "../../../../spec/schema/host-declaration-1.0.schema.json"
        ))
        .unwrap();
        let caps: Vec<&str> = decl["$defs"]["capability"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(caps, CAPABILITIES);
        let versions: Vec<&str> = decl["properties"]["declaration"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(versions, SUPPORTED_DECLARATION_VERSIONS);
    }
}
