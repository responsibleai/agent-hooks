// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! Host-side emitter for Rust-native hosts: dispatch context →
//! interceptors → composition → combined verdict → record (§6–§10).
//!
//! Unlike the FFI-bound SDKs, this emitter calls the crate's primitives
//! directly (no JSON round-trip). Semantics are identical and pinned by
//! the same CTK vectors.
//!
//! Composition is host configuration (§7.1): the profile is set on the
//! emitter (default `sequential/first_deny, on_approval: stop`) and
//! recorded on every emission. "Parallel" profiles are implemented with
//! serial dispatch over isolated snapshots — §7.2: parallel names
//! isolation semantics, not scheduling.
//!
//! Fail-closed defaults: an `enforce`-mode emission with zero registered
//! interceptors yields `deny host_error:no_interceptor` (§7), and
//! [`InterceptionEmitter::emit`] returns `Err(InterceptionBlocked)` on
//! any block — the ignorable-record variant is the explicitly named
//! [`InterceptionEmitter::emit_unchecked`].
//!
//! # Timeouts and panic isolation (§6.3, §7)
//!
//! Interceptor and resolver panics are always isolated: a panic
//! becomes that component's §6.3/§9 failure deny, never a host crash.
//! The §7 RECOMMENDED 5000 ms timeout is emitter-owned **with the
//! `tokio-timeout` feature** ([`InterceptionEmitter::set_timeout`]) —
//! parity with the Python/TypeScript/.NET/Go emitters. Without the
//! feature the crate stays runtime-agnostic and hosts on other
//! runtimes own the timeout at the interceptor boundary. Note that a
//! host-side wrapper interceptor must NOT return `host_error:*`
//! reasons itself — the §5 gate treats that as spoofing (TM-02); use
//! the feature or fail the future.

use crate::canonical;
use crate::composition::{
    aggregate_strictest, all_denies_liftable, is_unanimous_allow, summaries_named, with_unions,
    Aggregate, CompositionConfig, CompositionProfile, OnApproval, SynthesisPolicy,
};
use crate::declaration::{
    self, BindingContext, DeclarationError, DeclarationErrorClass, HostDeclaration, HostRegistry,
    ResolvedDeclaration,
};
use crate::enforce::{apply_transform_to_ctx, finalize, validate_transform, FinalizeMeta};
use crate::types::{
    AgentContext, ApprovalOutcome, ApprovalRequest, ApprovalResolution, ApprovalResolver, Decision,
    EnforcementMode, HostError, InterceptionPoint, InterceptionRecord, Interceptor, Verdict,
    VerdictSummary, JCS_SHA256,
};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fmt;
use std::path::Path;
use std::sync::Arc;

/// Returned by [`InterceptionEmitter::emit`] on a proceeding emission:
/// the record plus the **effective** (post-composition) target the
/// guarded action MUST consume (§4.3 — a reference captured before
/// `emit` may predate a transform).
#[derive(Debug, Clone)]
pub struct EmitOutcome {
    pub record: InterceptionRecord,
    pub target: Value,
}

/// Returned by [`InterceptionEmitter::emit`] when the combined verdict
/// blocks the guarded action (§6).
#[derive(Debug, Clone)]
pub struct InterceptionBlocked {
    pub record: InterceptionRecord,
}

impl fmt::Display for InterceptionBlocked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} blocked: {} ({})",
            self.record.interception_point.as_str(),
            self.record.verdict.decision.as_str(),
            self.record.verdict.reason.as_deref().unwrap_or("no reason"),
        )
    }
}

impl std::error::Error for InterceptionBlocked {}

/// The host-declared identity provider (§10.1).
pub enum IdentityProvider {
    /// The shipped default (§10.2): JCS + SHA-256 over the closed
    /// required+conditional projection; fail-closed I-JSON domain.
    JcsSha256,
    /// Identity-unbound: approvals bind by correlation only; records
    /// carry `null` identities and self-describe as unbound.
    Null,
    /// A host-supplied pure function. The echo and record rules (§10.1)
    /// still apply; the golden vectors do not. Construct via
    /// [`IdentityProvider::custom`], which enforces the §10.1 name
    /// rules.
    Custom {
        name: String,
        f: Box<dyn Fn(&AgentContext) -> String + Send + Sync>,
    },
}

impl IdentityProvider {
    /// Build a custom provider, enforcing the §10.1 name rules
    /// (`^[a-z][a-z0-9_-]*$`, no `jcs` prefix — a custom provider must
    /// not claim golden-vector semantics).
    pub fn custom(
        name: impl Into<String>,
        f: impl Fn(&AgentContext) -> String + Send + Sync + 'static,
    ) -> Result<Self, (HostError, String)> {
        let name = name.into();
        crate::types::validate_provider_name(&name)?;
        Ok(Self::Custom {
            name,
            f: Box::new(f),
        })
    }
}

impl IdentityProvider {
    fn name(&self) -> Option<String> {
        match self {
            Self::JcsSha256 => Some(JCS_SHA256.to_owned()),
            Self::Null => None,
            Self::Custom { name, .. } => Some(name.clone()),
        }
    }

    /// `Ok(None)` iff the provider is `Null`; `Err` iff the default
    /// provider rejected the value domain (§10.2) or a custom provider
    /// failed (§10.1: raise/panic fails closed as `context_invalid` —
    /// a provider that cannot compute MUST NOT silently unbind the
    /// emission).
    fn compute(&self, ctx: &AgentContext) -> Result<Option<String>, (HostError, String)> {
        match self {
            Self::JcsSha256 => canonical::context_identity(ctx).map(Some),
            Self::Null => Ok(None),
            Self::Custom { f, .. } => {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(ctx)))
                    .map(Some)
                    .map_err(|_| {
                        (
                            HostError::ContextInvalid,
                            "identity provider failed (see spec §10.1)".into(),
                        )
                    })
            }
        }
    }
}

/// §6.3/§7: invoke one interceptor with panic isolation and (with the
/// `tokio-timeout` feature) the emitter-owned timeout. `Err` carries a
/// host-synthesized failure verdict that MUST bypass the §5 gate — the
/// gate exists to stop *interceptors* spoofing reserved reasons, not
/// the host substituting them (TM-02).
async fn call_isolated(
    interceptor: &dyn Interceptor,
    ctx: &AgentContext,
    #[allow(unused_variables)] limit: Option<std::time::Duration>,
) -> Result<Verdict, Verdict> {
    use futures_util::FutureExt;
    let fut = std::panic::AssertUnwindSafe(interceptor.intercept(ctx)).catch_unwind();
    #[cfg(feature = "tokio-timeout")]
    let caught = match limit {
        Some(d) => match tokio::time::timeout(d, fut).await {
            Ok(c) => c,
            Err(_) => {
                return Err(Verdict::host_error(HostError::InterceptorTimeout, None));
            }
        },
        None => fut.await,
    };
    #[cfg(not(feature = "tokio-timeout"))]
    let caught = fut.await;
    caught.map_err(|_| {
        Verdict::host_error(
            HostError::InterceptorFailed,
            Some("interceptor panicked (see spec §6.3)".into()),
        )
    })
}

/// Whether a verdict was synthesized by the host (§11) rather than
/// returned by an interceptor or resolver.
fn is_host_synthesized(v: &Verdict) -> bool {
    v.reason
        .as_deref()
        .is_some_and(|r| r.starts_with("host_error:"))
}

/// Envelope facts for [`InterceptionEmitter::record_host_failure`]:
/// what the host still knows about an emission whose context it could
/// not construct (§10.3 "Host projection failure"). Everything is
/// optional — an absent member records the §10.3 unknown value
/// (`session_id: ""`, `sequence: -1`, `timestamp` absent).
#[derive(Debug, Clone, Default)]
pub struct HostFailure {
    /// Payload-free failure detail — an exception **type name** or a
    /// path, never the content that failed to project (§14 data
    /// minimization). Recorded as the verdict `message` (truncated by
    /// the §10.3 projection).
    pub detail: Option<String>,
    /// `session.id` of the failed emission, when the host knows it.
    pub session_id: Option<String>,
    /// The sequence number the failed emission would have carried. The
    /// host SHOULD consume the next number from its context source so
    /// records stay totally ordered within the session (§10.3).
    pub sequence: Option<i64>,
    /// RFC 3339 event time, when the host has one.
    pub timestamp: Option<String>,
}

/// §9/§14 approval redactor: produces the context placed in every
/// ApprovalRequest.
pub type ApprovalRedactor = Box<dyn Fn(&AgentContext) -> AgentContext + Send + Sync>;

/// Per-emission record callback (§10.3).
pub type RecordSink = Box<dyn Fn(&InterceptionRecord) + Send + Sync>;

/// How one registration is bounded (§7, §7.7.5).
enum BoundTimeout {
    /// The emitter-wide [`InterceptionEmitter::set_timeout`] value.
    Inherit,
    /// `timeout_ms: null` in a declaration.
    Unbounded,
    /// A per-binding bound from a declaration.
    Bounded(std::time::Duration),
}

/// One registered interceptor with its binding facts (§7.7.5): the
/// payload-free name stamped on `verdicts[].name`, the points it runs
/// at (`None` = every point, the pre-declaration behaviour) and its
/// timeout.
struct Bound {
    interceptor: Box<dyn Interceptor>,
    name: Option<String>,
    at: Option<BTreeSet<InterceptionPoint>>,
    timeout: BoundTimeout,
}

impl Bound {
    fn runs_at(&self, point: Option<InterceptionPoint>) -> bool {
        match (&self.at, point) {
            (None, _) => true,
            (Some(set), Some(p)) => set.contains(&p),
            // An unparseable point never reaches dispatch (§4
            // validation denies first); count every binding so the
            // record is conservative.
            (Some(_), None) => true,
        }
    }
}

/// Adapts a registry-shared resolver to the owned `Box` the emitter
/// holds, so one [`HostRegistry`] can build many emitters.
struct SharedResolver(Arc<dyn ApprovalResolver>);

#[async_trait::async_trait]
impl ApprovalResolver for SharedResolver {
    async fn resolve(&self, request: ApprovalRequest<'_>) -> ApprovalResolution {
        self.0.resolve(request).await
    }
}

fn point_of(ctx: &AgentContext) -> Option<InterceptionPoint> {
    ctx.get("interception_point")
        .and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
}

/// Internal result of one profile dispatch.
struct DispatchOutcome {
    combined: Verdict,
    decided_by: Option<u32>,
    verdicts: Vec<VerdictSummary>,
    fold_truncated: Option<bool>,
    resolved_by: Option<&'static str>,
}

impl DispatchOutcome {
    fn synthesized(err: HostError, detail: Option<String>) -> Self {
        Self {
            combined: Verdict::host_error(err, detail),
            decided_by: None,
            verdicts: Vec::new(),
            fold_truncated: None,
            resolved_by: None,
        }
    }
}

/// What a seam consultation produced (§7.6, §9).
enum Consultation {
    /// Seam not consulted: no resolver, `evaluate_only`, or
    /// `agent_shutdown`. The liftable deny stands as-is.
    NotConsulted,
    /// A resolution (or a host-synthesized failure verdict) that
    /// substitutes for the triggering verdict. `permitted` is true for
    /// an `approve` outcome carrying a permit verdict.
    Substituted {
        verdict: Box<Verdict>,
        permitted: bool,
    },
}

/// Host-side helper that implements §6–§10 once so adapters don't have
/// to. One instance per session.
pub struct InterceptionEmitter {
    interceptors: Vec<Bound>,
    resolver: Option<Box<dyn ApprovalResolver>>,
    mode: EnforcementMode,
    composition: CompositionConfig,
    identity: IdentityProvider,
    approval_redactor: Option<ApprovalRedactor>,
    /// §7 emitter-owned timeout (None = unbounded; enforced only with
    /// the `tokio-timeout` feature).
    timeout: Option<std::time::Duration>,
    /// §9 resolver bound (`approval_resolver_ms`, §7.7.3); enforced
    /// only with the `tokio-timeout` feature.
    #[cfg_attr(not(feature = "tokio-timeout"), allow(dead_code))]
    resolver_timeout: Option<std::time::Duration>,
    record_sink: Option<RecordSink>,
    max_records: Option<usize>,
    records_dropped: u64,
    records: Vec<InterceptionRecord>,
    /// §7.7.7: a declaration-built emitter refuses reconfiguration.
    sealed: bool,
    /// The resolved declaration this emitter was built from, if any.
    declaration: Option<ResolvedDeclaration>,
}

impl fmt::Debug for InterceptionEmitter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InterceptionEmitter")
            .field("mode", &self.mode)
            .field("composition", &self.composition)
            .field("identity_provider", &self.identity.name())
            .field("interceptors", &self.interceptors.len())
            .field("sealed", &self.sealed)
            .field("declaration", &self.declaration_version())
            .finish_non_exhaustive()
    }
}

impl InterceptionEmitter {
    pub fn new(mode: EnforcementMode, resolver: Option<Box<dyn ApprovalResolver>>) -> Self {
        Self {
            interceptors: Vec::new(),
            resolver,
            mode,
            composition: CompositionConfig::default(),
            identity: IdentityProvider::JcsSha256,
            approval_redactor: None,
            timeout: None,
            resolver_timeout: None,
            record_sink: None,
            max_records: None,
            records_dropped: 0,
            records: Vec::new(),
            sealed: false,
            declaration: None,
        }
    }

    // ---- host declaration (§7.7) -------------------------------------------

    /// Build an emitter from a validated declaration: steps 8 to 11 of
    /// §7.7.6 (resolve against the registry's surface and names, then
    /// run every binding's kind resolver). The result is sealed
    /// (§7.7.7) and stamps `declaration` on every record (§7.7.8).
    pub fn from_declaration(
        decl: HostDeclaration,
        registry: &HostRegistry,
    ) -> Result<Self, DeclarationError> {
        let resolved = declaration::resolve(&decl, registry.surface(), &registry.names())?;
        Self::from_resolved(resolved, registry)
    }

    /// [`HostDeclaration::from_path`] then [`Self::from_declaration`].
    pub fn from_declaration_path(
        path: impl AsRef<Path>,
        registry: &HostRegistry,
    ) -> Result<Self, DeclarationError> {
        Self::from_declaration(HostDeclaration::from_path(path)?, registry)
    }

    /// [`HostDeclaration::from_json`] then [`Self::from_declaration`].
    pub fn from_declaration_json(
        text: &str,
        registry: &HostRegistry,
    ) -> Result<Self, DeclarationError> {
        Self::from_declaration(HostDeclaration::from_json(text)?, registry)
    }

    /// [`HostDeclaration::from_value`] then [`Self::from_declaration`].
    pub fn from_declaration_value(
        value: Value,
        registry: &HostRegistry,
    ) -> Result<Self, DeclarationError> {
        Self::from_declaration(HostDeclaration::from_value(value)?, registry)
    }

    /// The resolved declaration this emitter runs under, when it was
    /// built from one (§7.7.7). Its canonical JSON is the equivalence
    /// oracle for the construction paths.
    pub fn declaration(&self) -> Option<&ResolvedDeclaration> {
        self.declaration.as_ref()
    }

    /// Step 11 and construction. Every reference is looked up again in
    /// the registry's own maps, so bookkeeping drift between the names
    /// the core checked and what the registry holds fails closed.
    fn from_resolved(
        resolved: ResolvedDeclaration,
        registry: &HostRegistry,
    ) -> Result<Self, DeclarationError> {
        let cfg = &resolved.configuration;
        let resolver: Option<Box<dyn ApprovalResolver>> = match &cfg.approval.resolver {
            None => None,
            Some(name) => Some(Box::new(SharedResolver(
                registry.approval_resolver_ref(name).ok_or_else(|| {
                    DeclarationError::new(
                        DeclarationErrorClass::ReferenceUnresolved,
                        "/configuration/approval/resolver",
                        format!("approval resolver {name:?} vanished from the registry"),
                    )
                })?,
            ))),
        };
        let identity = match cfg.identity_provider.as_deref() {
            None => IdentityProvider::Null,
            Some(JCS_SHA256) => IdentityProvider::JcsSha256,
            Some(name) => {
                let f = registry.identity_fn(name).ok_or_else(|| {
                    DeclarationError::new(
                        DeclarationErrorClass::ReferenceUnresolved,
                        "/configuration/identity_provider",
                        format!("identity provider {name:?} vanished from the registry"),
                    )
                })?;
                IdentityProvider::custom(name, move |ctx| f(ctx)).map_err(|(_, d)| {
                    DeclarationError::new(
                        DeclarationErrorClass::InvalidField,
                        "/configuration/identity_provider",
                        d,
                    )
                })?
            }
        };
        let approval_redactor: Option<ApprovalRedactor> = match &cfg.approval.redactor {
            None => None,
            Some(name) => {
                let f = registry.redactor_fn(name).ok_or_else(|| {
                    DeclarationError::new(
                        DeclarationErrorClass::ReferenceUnresolved,
                        "/configuration/approval/redactor",
                        format!("approval redactor {name:?} vanished from the registry"),
                    )
                })?;
                Some(Box::new(move |ctx: &AgentContext| f(ctx)))
            }
        };

        let mut interceptors = Vec::with_capacity(resolved.bindings.len());
        for (i, b) in resolved.bindings.iter().enumerate() {
            let pointer = format!("/bindings/{i}");
            let Some(resolver_fn) = registry.kind_resolver(&b.kind) else {
                return Err(DeclarationError::new(
                    DeclarationErrorClass::KindUnknown,
                    format!("{pointer}/kind"),
                    format!("kind {:?} vanished from the registry", b.kind),
                ));
            };
            let timeout = b.timeout_ms.map(std::time::Duration::from_millis);
            let bctx = BindingContext {
                id: &b.id,
                kind: &b.kind,
                at: &b.at,
                timeout,
                host: resolved.host.as_ref(),
                declaration_version: &resolved.declaration,
            };
            // §7.7.5: a resolver error, panic or non-interceptor return
            // refuses the document; the message is bounded and the
            // config is never echoed by the loader.
            let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                resolver_fn(&b.config, &bctx)
            }));
            let interceptor = match built {
                Ok(Ok(i)) => i,
                Ok(Err(msg)) => {
                    return Err(DeclarationError::new(
                        DeclarationErrorClass::BindingRejected,
                        pointer,
                        format!("binding {:?} (kind {:?}) rejected: {msg}", b.id, b.kind),
                    ))
                }
                Err(_) => {
                    return Err(DeclarationError::new(
                        DeclarationErrorClass::BindingRejected,
                        pointer,
                        format!(
                            "binding {:?} (kind {:?}) rejected: resolver panicked",
                            b.id, b.kind
                        ),
                    ))
                }
            };
            interceptors.push(Bound {
                interceptor,
                name: Some(b.id.clone()),
                at: Some(b.at.clone()),
                timeout: match timeout {
                    Some(d) => BoundTimeout::Bounded(d),
                    None => BoundTimeout::Unbounded,
                },
            });
        }

        Ok(Self {
            interceptors,
            resolver,
            mode: cfg.mode,
            composition: cfg.composition,
            identity,
            approval_redactor,
            timeout: cfg
                .timeouts
                .interceptor_ms
                .map(std::time::Duration::from_millis),
            resolver_timeout: cfg
                .timeouts
                .approval_resolver_ms
                .map(std::time::Duration::from_millis),
            record_sink: None,
            max_records: cfg.records.max_buffered.map(|n| n as usize),
            records_dropped: 0,
            records: Vec::new(),
            sealed: true,
            declaration: Some(resolved),
        })
    }

    /// §7.7.7: a declaration-built emitter refuses reconfiguration;
    /// otherwise the declaration would not be what ran.
    fn unsealed(&self, what: &str) {
        assert!(
            !self.sealed,
            "{what}: this emitter was built from a host declaration and is sealed (see spec §7.7.7)"
        );
    }

    pub fn mode(&self) -> EnforcementMode {
        self.mode
    }

    /// Declare the composition profile for subsequent emissions (§7.1).
    ///
    /// The default (`sequential/first_deny`, `on_approval: stop`) is
    /// the configuration §14 warns about: after an approval lifts a
    /// liftable deny, interceptors registered after the escalating one
    /// never run for that emission (`fold_truncated` on the record).
    /// Register must-run controls first, or use `sequential/run_all` /
    /// a parallel profile. See docs/PRODUCTION.md.
    pub fn set_composition(&mut self, composition: CompositionConfig) -> &mut Self {
        self.unsealed("set_composition");
        self.composition = composition;
        self
    }

    /// Declare the identity provider (§10.1). A `Custom` provider
    /// whose name violates the §10.1 rules is rejected — prefer
    /// [`IdentityProvider::custom`], which validates at construction.
    pub fn set_identity_provider(
        &mut self,
        provider: IdentityProvider,
    ) -> Result<&mut Self, (HostError, String)> {
        self.unsealed("set_identity_provider");
        if let IdentityProvider::Custom { name, .. } = &provider {
            crate::types::validate_provider_name(name)?;
        }
        self.identity = provider;
        Ok(self)
    }

    /// All interception records emitted so far in this session, in
    /// order (§10.3). Subject to [`Self::set_max_records`]; durable
    /// audit storage is the host's job via [`Self::set_record_sink`]
    /// or [`Self::take_records`].
    pub fn records(&self) -> &[InterceptionRecord] {
        &self.records
    }

    /// Drain the in-memory record buffer (retention stays bounded on
    /// long-running sessions).
    pub fn take_records(&mut self) -> Vec<InterceptionRecord> {
        std::mem::take(&mut self.records)
    }

    /// Register a per-emission record callback (§10.3). The sink is
    /// invoked synchronously after every emission, before the record
    /// is buffered; a sink panic is swallowed (the emission outcome is
    /// already decided — audit delivery is the host's liveness
    /// concern, not the control plane's).
    pub fn set_record_sink(
        &mut self,
        sink: impl Fn(&InterceptionRecord) + Send + Sync + 'static,
    ) -> &mut Self {
        self.record_sink = Some(Box::new(sink));
        self
    }

    /// Bound the in-memory record buffer: when full, the OLDEST record
    /// is dropped and [`Self::records_dropped`] increments. Unbounded
    /// by default.
    pub fn set_max_records(&mut self, max: usize) -> &mut Self {
        self.unsealed("set_max_records");
        self.max_records = Some(max);
        self
    }

    /// Records evicted by the [`Self::set_max_records`] bound.
    pub fn records_dropped(&self) -> u64 {
        self.records_dropped
    }

    /// Bound each interceptor call with the §7 timeout (RECOMMENDED
    /// default 5000 ms); breach fails closed with
    /// `host_error:interceptor_timeout`. Enforced only with the
    /// `tokio-timeout` feature — without it the crate is
    /// runtime-agnostic and the timeout stays host-owned (module docs).
    pub fn set_timeout(&mut self, limit: std::time::Duration) -> &mut Self {
        self.unsealed("set_timeout");
        self.timeout = Some(limit);
        self
    }

    /// Register the §9/§14 approval redactor: a pure function producing
    /// the context to place in every ApprovalRequest. The §9 identity
    /// is computed over the redacted context (binding the approval to
    /// what the approver saw); the record's identities are unaffected.
    /// Hosts SHOULD document removed paths under
    /// `extensions.<host>.redacted` (§14).
    pub fn set_approval_redactor(
        &mut self,
        f: impl Fn(&AgentContext) -> AgentContext + Send + Sync + 'static,
    ) -> &mut Self {
        self.unsealed("set_approval_redactor");
        self.approval_redactor = Some(Box::new(f));
        self
    }

    /// Register an interceptor at every interception point, unnamed.
    /// Registration order is dispatch order (§7).
    pub fn register(&mut self, interceptor: Box<dyn Interceptor>) -> &mut Self {
        self.register_at(interceptor, None, None)
    }

    /// Register an interceptor with a payload-free `name` (stamped on
    /// `verdicts[].name`, §10.3) at the given points only (`None` =
    /// every point). At point P the interceptors that run are those
    /// bound there, in registration order; `interceptors_registered`,
    /// `verdicts[].index` and `decided_by` count and index that list
    /// (§7.7.8).
    pub fn register_at(
        &mut self,
        interceptor: Box<dyn Interceptor>,
        name: Option<String>,
        at: Option<BTreeSet<InterceptionPoint>>,
    ) -> &mut Self {
        self.unsealed("register");
        self.interceptors.push(Bound {
            interceptor,
            name,
            at,
            timeout: BoundTimeout::Inherit,
        });
        self
    }

    /// The interceptors bound at the context's point, in dispatch
    /// order (§7.7.8).
    fn active(&self, ctx: &AgentContext) -> Vec<&Bound> {
        let point = point_of(ctx);
        self.interceptors
            .iter()
            .filter(|b| b.runs_at(point))
            .collect()
    }

    fn limit(&self, b: &Bound) -> Option<std::time::Duration> {
        match b.timeout {
            BoundTimeout::Inherit => self.timeout,
            BoundTimeout::Unbounded => None,
            BoundTimeout::Bounded(d) => Some(d),
        }
    }

    fn declaration_version(&self) -> Option<String> {
        self.declaration.as_ref().map(|d| d.declaration.clone())
    }

    // -------------------------------------------------------------------------

    /// Run the emission and return `Err(InterceptionBlocked)` if the
    /// guarded action must not proceed (§6). Primary entry point; the
    /// safe path is the default.
    pub async fn emit(
        &mut self,
        ctx: &mut AgentContext,
    ) -> Result<EmitOutcome, InterceptionBlocked> {
        let record = self.emit_unchecked(ctx).await;
        if record.proceeds() {
            // §4.3/§10.3: hand back the effective (post-composition)
            // target so the natural pattern consumes the transformed
            // value — a target captured before emit may be stale.
            let target = ctx.get("target").cloned().unwrap_or(Value::Null);
            Ok(EmitOutcome { record, target })
        } else {
            Err(InterceptionBlocked { record })
        }
    }

    /// Run the emission and return the record without a block error.
    /// The caller MUST inspect [`InterceptionRecord::proceeds`] and halt
    /// the guarded action itself; prefer [`Self::emit`].
    pub async fn emit_unchecked(&mut self, ctx: &mut AgentContext) -> InterceptionRecord {
        // §4/§6.3: an invalid envelope is denied before any interceptor
        // or identity provider sees it — no dispatch, no identities, no
        // plausible record over a partial preimage.
        let outcome = if let Err((e, detail)) = canonical::validate_envelope(ctx) {
            Some(DispatchOutcome::synthesized(e, Some(detail)))
        } else {
            None
        };
        let envelope_invalid = outcome.is_some();
        // §10.3: input identity binds to the context BEFORE dispatch, so
        // neither interceptor mutation nor fold-through can retroactively
        // alter what the record claims was evaluated.
        let (input_identity, outcome) = if envelope_invalid {
            (None, outcome)
        } else {
            match self.identity.compute(ctx) {
                Ok(id) => (id, None),
                // §10.1/§10.2: the provider rejected the value domain,
                // raised, or panicked. Fail closed before any
                // interceptor runs.
                Err((e, detail)) => (None, Some(DispatchOutcome::synthesized(e, Some(detail)))),
            }
        };
        let outcome = match outcome {
            Some(o) => o,
            None => self.dispatch(ctx).await,
        };

        let meta = FinalizeMeta {
            input_identity,
            identity_provider: self.identity.name(),
            enforced_identity: match &self.identity {
                IdentityProvider::Custom { .. } if !envelope_invalid => {
                    self.identity.compute(ctx).ok().flatten()
                }
                _ => None, // finalize computes (default) or leaves null
            },
            // Native hosts build in-memory Values, which cannot carry
            // the raw-text coercion class (Number has no beyond-u64
            // form); the in-memory check inside finalize is complete.
            jcs_input_rejected: false,
            // §10.3: reuse input_identity when the context
            // bytes cannot have changed — evaluate_only never applies
            // transforms (§8); in enforce mode, no transform anywhere
            // in the dispatch (including a substituted resolution)
            // means no fold mutated the context. Conservative: any
            // transform or substitution forces a fresh computation.
            unchanged_since_input: self.mode == EnforcementMode::EvaluateOnly
                || (outcome.resolved_by.is_none()
                    && outcome.combined.decision != Decision::Transform
                    && outcome
                        .verdicts
                        .iter()
                        .all(|v| v.decision != Decision::Transform)),
            decided_by: outcome.decided_by,
            composition: self.composition,
            declaration: self.declaration_version(),
            verdicts: outcome.verdicts,
            fold_truncated: outcome.fold_truncated,
            resolved_by: outcome.resolved_by,
            interceptors_registered: self.active(ctx).len() as u32,
        };
        let record = finalize(ctx, outcome.combined, self.mode, meta);
        self.deliver(record)
    }

    /// §10.3/§11 host projection failure: synthesize and deliver the
    /// fail-closed record for an emission whose `AgentContext` the host
    /// could not construct at all — its own projection to the wire
    /// failed before anything existed to [`emit`](Self::emit) (e.g. a
    /// tool-call argument getter raised during to-wire conversion at
    /// the chat seam). Without this the host can only fail the action
    /// closed *recordless*; with it the trail stays complete under
    /// host-side faults.
    ///
    /// The record is the §10.3 rejection shape: the payload-free
    /// projection of a `deny host_error:context_invalid` carrying
    /// `failure.detail` (payload-free: a type name or path, never
    /// content) as its message; `null` identities under the declared
    /// provider; `decided_by: null`; no per-interceptor summaries (no
    /// interceptor ran); envelope members from [`HostFailure`], with
    /// the §10.3 unknown values (`""`/`-1`) where absent. It takes the
    /// next slot in the record stream (sink, then buffer) like any
    /// emission. In `enforce` mode the host MUST still fail the action
    /// closed; in `evaluate_only` the record documents the host fault
    /// without implying enforcement (§8) — the action failed on its
    /// own, not on a verdict.
    pub fn record_host_failure(
        &mut self,
        point: InterceptionPoint,
        failure: HostFailure,
    ) -> InterceptionRecord {
        // Deliberately partial basis: only the envelope facts the host
        // still knows. It never passes §4 validation (`spec` is
        // absent), so `finalize` always yields the §10.3 rejection
        // shape — null identities under the declared provider — and
        // keeps the synthesized `context_invalid` deny (with the
        // host's detail) instead of substituting its own.
        let mut basis = AgentContext::new();
        basis.insert(
            "interception_point".into(),
            Value::String(point.as_str().to_owned()),
        );
        if let Some(sid) = failure.session_id {
            basis.insert("session".into(), serde_json::json!({ "id": sid }));
        }
        if let Some(seq) = failure.sequence {
            basis.insert("sequence".into(), Value::from(seq));
        }
        if let Some(ts) = failure.timestamp {
            basis.insert("timestamp".into(), Value::String(ts));
        }
        let verdict = Verdict::host_error(HostError::ContextInvalid, failure.detail);
        let meta = FinalizeMeta {
            input_identity: None,
            identity_provider: self.identity.name(),
            enforced_identity: None,
            jcs_input_rejected: false,
            unchanged_since_input: false,
            decided_by: None,
            composition: self.composition,
            declaration: self.declaration_version(),
            verdicts: Vec::new(),
            fold_truncated: None,
            resolved_by: None,
            interceptors_registered: self
                .interceptors
                .iter()
                .filter(|b| b.runs_at(Some(point)))
                .count() as u32,
        };
        let record = finalize(&basis, verdict, self.mode, meta);
        self.deliver(record)
    }

    /// Deliver a record to the sink and the bounded buffer (§10.3).
    fn deliver(&mut self, record: InterceptionRecord) -> InterceptionRecord {
        if let Some(sink) = &self.record_sink {
            // Audit delivery must not take down the control plane.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(&record)));
        }
        if let Some(max) = self.max_records {
            while self.records.len() >= max.max(1) {
                self.records.remove(0);
                self.records_dropped += 1;
            }
        }
        self.records.push(record.clone());
        record
    }

    // -------------------------------------------------------------------------

    /// Profile dispatch (§7.4–§7.5). Returns the combined verdict and
    /// its record metadata.
    async fn dispatch(&self, ctx: &mut AgentContext) -> DispatchOutcome {
        let active = self.active(ctx);
        if active.is_empty() {
            // §7: zero interceptors fails closed, profile-independent.
            // Register an explicit allow-all interceptor for a
            // deliberate passthrough. With per-point bindings (§7.7.5)
            // this is per point: a surface point with no binding
            // denies.
            return DispatchOutcome::synthesized(HostError::NoInterceptor, None);
        }
        match self.composition.profile {
            CompositionProfile::SequentialFirstDeny => self.dispatch_first_deny(ctx, &active).await,
            CompositionProfile::SequentialRunAll => self.dispatch_run_all(ctx, &active).await,
            CompositionProfile::ParallelStrictest | CompositionProfile::ParallelUnanimous => {
                self.dispatch_parallel(ctx, &active).await
            }
        }
    }

    /// §10.3 summaries with the bound names attached positionally.
    fn summaries(verdicts: &[Verdict], active: &[&Bound]) -> Vec<VerdictSummary> {
        let names: Vec<Option<String>> = active.iter().map(|b| b.name.clone()).collect();
        summaries_named(verdicts, &names)
    }

    /// `sequential/first_deny` (§7.4): fold-through, first deny
    /// short-circuits; a liftable deny consults the seam, then `stop`
    /// or `resume` per the knob.
    ///
    /// `per_interceptor` stays index-aligned with registration order
    /// (one entry per invoked interceptor, §10.3 summaries); `pool`
    /// additionally holds substituted resolutions for the §7.3 unions.
    async fn dispatch_first_deny(
        &self,
        ctx: &mut AgentContext,
        active: &[&Bound],
    ) -> DispatchOutcome {
        let n = active.len();
        let on_approval = self.composition.on_approval.unwrap_or(OnApproval::Stop);
        let mut per_interceptor: Vec<Verdict> = Vec::new();
        let mut pool: Vec<Verdict> = Vec::new();
        let mut last_transform: Option<(u32, Verdict)> = None;
        let mut resolved_by: Option<&'static str> = None;
        let truncated = |i: usize| Some(i + 1 < n);

        for (i, bound) in active.iter().enumerate() {
            let idx = i as u32;
            // §7: isolation is the `&AgentContext` borrow itself — the
            // interceptor cannot mutate through it, so no defensive
            // clone is needed (previously one full deep copy per
            // interceptor per emission).
            // §5 gate on the interceptor's own return; host-synthesized
            // failure substitutions (Err) bypass it (TM-02 is about
            // interceptor spoofing, not host substitution).
            let v = match call_isolated(bound.interceptor.as_ref(), &*ctx, self.limit(bound)).await
            {
                Ok(v) if v.validate().is_err() => {
                    Verdict::host_error(HostError::VerdictInvalid, None)
                }
                Ok(v) => v,
                Err(f) => f,
            };
            per_interceptor.push(v.clone());
            pool.push(v.clone());
            if is_host_synthesized(&v) {
                // §6.3: malformed verdict fails closed and — in this
                // profile — short-circuits like any deny. The failure
                // deny is attributed to the failing interceptor
                // (§10.3 decided_by), matching the aggregation
                // profiles.
                return DispatchOutcome {
                    combined: with_unions(v, &pool),
                    decided_by: Some(idx),
                    verdicts: Self::summaries(&per_interceptor, active),
                    fold_truncated: truncated(i),
                    resolved_by,
                };
            }

            match v.decision {
                Decision::Deny => {
                    match self.consult(ctx, &v).await {
                        Consultation::NotConsulted => {
                            return DispatchOutcome {
                                combined: with_unions(v, &pool),
                                decided_by: Some(idx),
                                verdicts: Self::summaries(&per_interceptor, active),
                                fold_truncated: truncated(i),
                                resolved_by,
                            }
                        }
                        Consultation::Substituted { verdict, permitted } => {
                            let verdict = *verdict;
                            // §10.3: any consultation is recorded — permit
                            // substitution as "approval", everything else as
                            // "rejection".
                            resolved_by = Some(if permitted { "approval" } else { "rejection" });
                            if !permitted {
                                // Reject / unresolved / echo violation:
                                // a deny stands (§9).
                                let synthesized = is_host_synthesized(&verdict);
                                return DispatchOutcome {
                                    combined: with_unions(verdict, &pool),
                                    decided_by: if synthesized { None } else { Some(idx) },
                                    verdicts: Self::summaries(&per_interceptor, active),
                                    fold_truncated: truncated(i),
                                    resolved_by,
                                };
                            }
                            resolved_by = Some("approval");
                            // §7.6: the permit resolution substitutes at
                            // this position; its transform folds like an
                            // interceptor's (§7.4).
                            let sub = if verdict.decision == Decision::Transform {
                                self.fold_transform(ctx, verdict)
                            } else {
                                verdict
                            };
                            if !sub.decision.permits() {
                                return DispatchOutcome {
                                    combined: sub,
                                    decided_by: None,
                                    verdicts: Self::summaries(&per_interceptor, active),
                                    fold_truncated: truncated(i),
                                    resolved_by,
                                };
                            }
                            pool.push(sub.clone());
                            match on_approval {
                                OnApproval::Stop => {
                                    // §7.4 stop: the resolution is the
                                    // combined verdict; the emission
                                    // ends. fold_truncated makes the
                                    // skip legible.
                                    return DispatchOutcome {
                                        combined: with_unions(sub, &pool),
                                        decided_by: Some(idx),
                                        verdicts: Self::summaries(&per_interceptor, active),
                                        fold_truncated: truncated(i),
                                        resolved_by,
                                    };
                                }
                                OnApproval::Resume => {
                                    if sub.decision == Decision::Transform {
                                        last_transform = Some((idx, sub));
                                    }
                                    // fold continues at i+1
                                }
                            }
                        }
                    }
                }
                Decision::Transform => {
                    let v = self.fold_transform(ctx, v);
                    if !v.decision.permits() {
                        // Transform failed closed (host-synthesized §5.2).
                        return DispatchOutcome {
                            combined: v,
                            decided_by: None,
                            verdicts: Self::summaries(&per_interceptor, active),
                            fold_truncated: truncated(i),
                            resolved_by,
                        };
                    }
                    last_transform = Some((idx, v));
                }
                Decision::Allow => {}
            }
        }

        // No standing deny: combined is the last transform, else allow.
        let (combined, decided_by) = match last_transform {
            Some((idx, v)) => (v, Some(idx)),
            None => (Verdict::allow(), None),
        };
        DispatchOutcome {
            combined: with_unions(combined, &pool),
            decided_by,
            verdicts: Self::summaries(&per_interceptor, active),
            fold_truncated: Some(false),
            resolved_by,
        }
    }

    /// `sequential/run_all` (§7.4): everything runs, transforms fold
    /// through for visibility, severity-max aggregate; the seam is
    /// consulted at most once, only when the winner is liftable.
    async fn dispatch_run_all(&self, ctx: &mut AgentContext, active: &[&Bound]) -> DispatchOutcome {
        let mut all: Vec<Verdict> = Vec::new();
        for bound in active.iter() {
            // §6.3 per-interceptor: a malformed verdict becomes that
            // interceptor's synthesized deny; the rest still run.
            // Host-synthesized substitutions (Err) bypass the §5 gate.
            let v = match call_isolated(bound.interceptor.as_ref(), &*ctx, self.limit(bound)).await
            {
                Ok(v) if v.validate().is_err() => {
                    Verdict::host_error(HostError::VerdictInvalid, None)
                }
                Ok(v) => v,
                Err(f) => f,
            };
            if v.decision == Decision::Transform {
                let folded = self.fold_transform(ctx, v);
                if !folded.decision.permits() {
                    // §7.4: a transform that fails to apply
                    // short-circuits in both sequential profiles.
                    all.push(folded.clone());
                    return DispatchOutcome {
                        combined: folded,
                        decided_by: None,
                        verdicts: Self::summaries(&all, active),
                        fold_truncated: None,
                        resolved_by: None,
                    };
                }
                all.push(folded);
            } else {
                all.push(v);
            }
        }
        self.aggregate_and_consult(ctx, all, true, None, active)
            .await
    }

    /// Parallel profiles (§7.5): isolated snapshots, no fold; serial
    /// dispatch (isolation semantics, not scheduling).
    async fn dispatch_parallel(
        &self,
        ctx: &mut AgentContext,
        active: &[&Bound],
    ) -> DispatchOutcome {
        let snapshot = ctx.clone();
        let mut all: Vec<Verdict> = Vec::new();
        for bound in active.iter() {
            // Host-synthesized substitutions (Err) bypass the §5 gate.
            let v = match call_isolated(
                bound.interceptor.as_ref(),
                &snapshot.clone(),
                self.limit(bound),
            )
            .await
            {
                Ok(v) if v.validate().is_err() => {
                    Verdict::host_error(HostError::VerdictInvalid, None)
                }
                Ok(v) => v,
                Err(f) => f,
            };
            all.push(v);
        }

        if self.composition.profile == CompositionProfile::ParallelUnanimous {
            return self.aggregate_unanimous(ctx, all, active).await;
        }
        self.aggregate_and_consult(ctx, all, false, None, active)
            .await
    }

    /// Severity-max aggregation + winner handling, shared by `run_all`
    /// (`sequential == true`) and `parallel/strictest`.
    async fn aggregate_and_consult(
        &self,
        ctx: &mut AgentContext,
        all: Vec<Verdict>,
        sequential: bool,
        resolved_by: Option<&'static str>,
        active: &[&Bound],
    ) -> DispatchOutcome {
        let verdicts = Self::summaries(&all, active);
        let mut resolved_by = resolved_by;
        match aggregate_strictest(&all, sequential) {
            Aggregate::TransformConflict(idxs) => {
                // §7.5: transforms against the same snapshot do not
                // compose.
                let detail = format!("conflicting transforms from interceptors {idxs:?}");
                let policy = self
                    .composition
                    .on_transform_conflict
                    .unwrap_or(SynthesisPolicy::Deny);
                let combined = self
                    .synthesize_and_maybe_consult(
                        ctx,
                        HostError::TransformConflict,
                        detail,
                        policy,
                        &all,
                        &mut resolved_by,
                    )
                    .await;
                DispatchOutcome {
                    combined,
                    decided_by: None,
                    verdicts,
                    fold_truncated: None,
                    resolved_by,
                }
            }
            Aggregate::Winner(i) => {
                let idx = i as u32;
                let winner = all[i].clone();
                match winner.decision {
                    Decision::Deny => {
                        // A liftable winner implies no plain deny exists
                        // (severity), so the §7.4 "every deny is
                        // liftable" consult precondition holds.
                        debug_assert!(!winner.is_liftable() || all_denies_liftable(&all));
                        match self.consult(ctx, &winner).await {
                            Consultation::NotConsulted => DispatchOutcome {
                                combined: with_unions(winner, &all),
                                decided_by: Some(idx),
                                verdicts,
                                fold_truncated: None,
                                resolved_by,
                            },
                            Consultation::Substituted { verdict, permitted } => {
                                let verdict = *verdict;
                                // §10.3: any consultation is recorded — permit
                                // substitution as "approval", everything else as
                                // "rejection".
                                resolved_by =
                                    Some(if permitted { "approval" } else { "rejection" });
                                let synthesized = is_host_synthesized(&verdict);
                                let combined = if permitted {
                                    resolved_by = Some("approval");
                                    let sub = if verdict.decision == Decision::Transform {
                                        self.fold_transform(ctx, verdict)
                                    } else {
                                        verdict
                                    };
                                    if sub.decision.permits() {
                                        let mut pool = all.clone();
                                        pool.push(sub.clone());
                                        with_unions(sub, &pool)
                                    } else {
                                        sub
                                    }
                                } else {
                                    with_unions(verdict, &all)
                                };
                                DispatchOutcome {
                                    decided_by: if synthesized && !permitted {
                                        None
                                    } else {
                                        Some(idx)
                                    },
                                    combined,
                                    verdicts,
                                    fold_truncated: None,
                                    resolved_by,
                                }
                            }
                        }
                    }
                    Decision::Transform => {
                        // Sequential: already folded during dispatch.
                        // Parallel: apply the single winning transform now.
                        let winner = if sequential {
                            winner
                        } else {
                            let folded = self.fold_transform(ctx, winner);
                            if !folded.decision.permits() {
                                return DispatchOutcome {
                                    combined: folded,
                                    decided_by: None,
                                    verdicts,
                                    fold_truncated: None,
                                    resolved_by,
                                };
                            }
                            folded
                        };
                        DispatchOutcome {
                            combined: with_unions(winner, &all),
                            decided_by: Some(idx),
                            verdicts,
                            fold_truncated: None,
                            resolved_by,
                        }
                    }
                    Decision::Allow => DispatchOutcome {
                        combined: with_unions(Verdict::allow(), &all),
                        decided_by: None,
                        verdicts,
                        fold_truncated: None,
                        resolved_by,
                    },
                }
            }
        }
    }

    /// `parallel/unanimous` (§7.5): anything but unanimous allow is a
    /// disagreement.
    async fn aggregate_unanimous(
        &self,
        ctx: &mut AgentContext,
        all: Vec<Verdict>,
        active: &[&Bound],
    ) -> DispatchOutcome {
        let verdicts = Self::summaries(&all, active);
        if is_unanimous_allow(&all) {
            return DispatchOutcome {
                combined: with_unions(Verdict::allow(), &all),
                decided_by: None,
                verdicts,
                fold_truncated: None,
                resolved_by: None,
            };
        }
        let mut resolved_by: Option<&'static str> = None;
        let policy = self
            .composition
            .on_disagreement
            .unwrap_or(SynthesisPolicy::Deny);
        let combined = self
            .synthesize_and_maybe_consult(
                ctx,
                HostError::CompositionDisagreement,
                "non-unanimous outcome under parallel/unanimous".into(),
                policy,
                &all,
                &mut resolved_by,
            )
            .await;
        DispatchOutcome {
            combined,
            decided_by: None,
            verdicts,
            fold_truncated: None,
            resolved_by,
        }
    }

    /// §7.5 `"deny" | "approval"` synthesis: a plain deny, or a liftable
    /// one consulted through the seam (the resolver — typically a human
    /// — may resolve with an allow, a transform, or a reject).
    async fn synthesize_and_maybe_consult(
        &self,
        ctx: &mut AgentContext,
        err: HostError,
        detail: String,
        policy: SynthesisPolicy,
        pool: &[Verdict],
        resolved_by: &mut Option<&'static str>,
    ) -> Verdict {
        match policy {
            SynthesisPolicy::Deny => with_unions(Verdict::host_error(err, Some(detail)), pool),
            SynthesisPolicy::Approval => {
                let liftable = Verdict::host_error_liftable(err, Some(detail));
                match self.consult(ctx, &liftable).await {
                    Consultation::NotConsulted => with_unions(liftable, pool),
                    Consultation::Substituted { verdict, permitted } => {
                        let verdict = *verdict;
                        // §10.3: any consultation is recorded — permit
                        // substitution as "approval", everything else as
                        // "rejection".
                        *resolved_by = Some(if permitted { "approval" } else { "rejection" });
                        if permitted {
                            *resolved_by = Some("approval");
                            let sub = if verdict.decision == Decision::Transform {
                                self.fold_transform(ctx, verdict)
                            } else {
                                verdict
                            };
                            // §7.3 step 2: the substituting resolution
                            // carries the emission's unions, like every
                            // other combined verdict.
                            if sub.decision.permits() {
                                let mut with_sub = pool.to_vec();
                                with_sub.push(sub.clone());
                                return with_unions(sub, &with_sub);
                            }
                            return sub;
                        }
                        with_unions(verdict, pool)
                    }
                }
            }
        }
    }

    /// Apply (enforce) or validate (evaluate_only) one transform (§7.4, §8).
    fn fold_transform(&self, ctx: &mut AgentContext, v: Verdict) -> Verdict {
        let t = match &v.transform {
            Some(t) => t.clone(),
            None => return Verdict::host_error(HostError::TransformInvalid, None),
        };
        let result = match self.mode {
            EnforcementMode::Enforce => apply_transform_to_ctx(ctx, &t),
            EnforcementMode::EvaluateOnly => validate_transform(ctx, &t),
        };
        match result {
            Ok(()) => v,
            Err(e) => Verdict::host_error(e, Some(t.path)),
        }
    }

    /// Consult the approval seam for a liftable deny (§9), when the
    /// profile conditions allow it: `enforce` mode, not
    /// `agent_shutdown`, a resolver registered, and the verdict
    /// actually liftable. Enforces the echo rule and the §9
    /// outcome/verdict consistency requirements.
    async fn consult(&self, ctx: &AgentContext, verdict: &Verdict) -> Consultation {
        if !verdict.is_liftable() || self.mode != EnforcementMode::Enforce {
            return Consultation::NotConsulted;
        }
        // §6.1a: nothing to approve at agent_shutdown.
        if ctx.get("interception_point").and_then(Value::as_str) == Some("agent_shutdown") {
            return Consultation::NotConsulted;
        }
        // §9: no resolver → the deny stands. Conformant, not an error.
        let Some(resolver) = &self.resolver else {
            return Consultation::NotConsulted;
        };

        // §9/§14: the host's approval redactor minimizes the context
        // that egresses through the seam. The identity is computed over
        // the context ACTUALLY placed in the request (post-redaction) —
        // binding the approval to what the approver saw.
        let redacted;
        let presented: &AgentContext = match &self.approval_redactor {
            Some(f) => {
                redacted = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(ctx))) {
                    Ok(c) => c,
                    Err(_) => {
                        return Consultation::Substituted {
                            verdict: Box::new(Verdict::host_error(
                                HostError::ApprovalResolverFailed,
                                Some("approval redactor panicked (see spec §9)".into()),
                            )),
                            permitted: false,
                        }
                    }
                };
                &redacted
            }
            None => ctx,
        };

        // §9: identity of the context as presented to the resolver —
        // consultation time, after any transforms that folded earlier
        // and after any redaction.
        let identity = match self.identity.compute(presented) {
            Ok(id) => id,
            Err((e, detail)) => {
                return Consultation::Substituted {
                    verdict: Box::new(Verdict::host_error(e, Some(detail))),
                    permitted: false,
                }
            }
        };

        let ip: InterceptionPoint = ctx
            .get("interception_point")
            .and_then(Value::as_str)
            .and_then(|s| s.parse().ok())
            .unwrap_or(InterceptionPoint::AgentStartup);
        // §6.3/§9: a panicking resolver is a resolver failure, never a
        // host crash.
        use futures_util::FutureExt;
        let fut = std::panic::AssertUnwindSafe(resolver.resolve(ApprovalRequest {
            context_identity: identity.clone(),
            interception_point: ip,
            verdict,
            context: presented,
        }))
        .catch_unwind();
        // §9: a resolver that times out is a resolver failure
        // (`approval_resolver_ms`, §7.7.3); bounded only with the
        // `tokio-timeout` feature, like the interceptor timeout.
        #[cfg(feature = "tokio-timeout")]
        let caught = match self.resolver_timeout {
            Some(d) => match tokio::time::timeout(d, fut).await {
                Ok(c) => c,
                Err(_) => {
                    return Consultation::Substituted {
                        verdict: Box::new(Verdict::host_error(
                            HostError::ApprovalResolverFailed,
                            Some("resolver timed out (see spec §9)".into()),
                        )),
                        permitted: false,
                    }
                }
            },
            None => fut.await,
        };
        #[cfg(not(feature = "tokio-timeout"))]
        let caught = fut.await;
        let res = match caught {
            Ok(res) => res,
            Err(_) => {
                return Consultation::Substituted {
                    verdict: Box::new(Verdict::host_error(
                        HostError::ApprovalResolverFailed,
                        Some("resolver panicked (see spec §9)".into()),
                    )),
                    permitted: false,
                }
            }
        };

        let fail = |e: HostError| Consultation::Substituted {
            verdict: Box::new(Verdict::host_error(e, None)),
            permitted: false,
        };
        // §9 echo rule (byte-for-byte; None echoes as None).
        if res.context_identity != identity {
            return fail(HostError::ApprovalIdentityMismatch);
        }
        let Some(rv) = res.verdict else {
            return fail(HostError::ApprovalUnresolved);
        };
        if res.outcome == ApprovalOutcome::Unresolved {
            return fail(HostError::ApprovalUnresolved);
        }
        // §9: the resolver's verdict crosses the same §5 gate as an
        // interceptor's, and outcome/decision must agree (approve MUST
        // carry a permit, reject MUST carry a deny).
        if rv.validate().is_err() {
            return fail(HostError::VerdictInvalid);
        }
        let permitted = match res.outcome {
            ApprovalOutcome::Approve => {
                if !rv.decision.permits() {
                    return fail(HostError::VerdictInvalid);
                }
                true
            }
            ApprovalOutcome::Reject => {
                if rv.decision != Decision::Deny {
                    return fail(HostError::VerdictInvalid);
                }
                false
            }
            ApprovalOutcome::Unresolved => unreachable!("handled above"),
        };
        Consultation::Substituted {
            verdict: Box::new(rv),
            permitted,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ApprovalResolution, Transform};
    use async_trait::async_trait;
    use serde_json::json;

    struct Scripted(Verdict);
    #[async_trait]
    impl Interceptor for Scripted {
        async fn intercept(&self, _ctx: &AgentContext) -> Verdict {
            self.0.clone()
        }
    }

    struct Approver(ApprovalOutcome, Verdict);
    #[async_trait]
    impl ApprovalResolver for Approver {
        async fn resolve(&self, req: ApprovalRequest<'_>) -> crate::ApprovalResolution {
            crate::ApprovalResolution {
                outcome: self.0,
                context_identity: req.context_identity.clone(), // echo rule
                verdict: Some(self.1.clone()),
            }
        }
    }

    fn ctx() -> AgentContext {
        json!({
            "spec": "agent-hooks/0.1",
            "interception_point": "pre_tool_call",
            "timestamp": "t", "sequence": 0,
            "agent": {"id": "a", "framework": "x"}, "session": {"id": "s"},
            "target": {"url": "evil"},
            "tool_call": {"id": "tc", "name": "t", "args": {"url": "evil"}}
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn transform(path: &str, value: serde_json::Value) -> Verdict {
        Verdict {
            decision: Decision::Transform,
            transform: Some(Transform {
                path: path.into(),
                value,
            }),
            ..Verdict::allow()
        }
    }

    fn deny() -> Verdict {
        Verdict {
            decision: Decision::Deny,
            ..Verdict::allow()
        }
    }

    #[tokio::test]
    async fn run_all_runs_everything_and_strictest_wins() {
        let mut e = InterceptionEmitter::new(EnforcementMode::Enforce, None);
        e.set_composition(CompositionConfig::run_all());
        e.register(Box::new(Scripted(deny())));
        e.register(Box::new(Scripted(Verdict::warn(Some("late".into()), None))));
        let mut c = ctx();
        let r = e.emit_unchecked(&mut c).await;
        assert_eq!(r.verdict.decision, Decision::Deny);
        assert_eq!(r.verdicts.len(), 2, "run_all: everything runs");
        assert_eq!(r.decided_by, Some(0));
        // §7.3: warnings union onto the deny combination.
        assert_eq!(r.verdict.warnings.len(), 1);
        assert!(r.fold_truncated.is_none(), "not defined outside first_deny");
    }

    #[tokio::test]
    async fn parallel_strictest_transform_conflict_fails_closed() {
        let mut e = InterceptionEmitter::new(EnforcementMode::Enforce, None);
        e.set_composition(CompositionConfig::strictest(SynthesisPolicy::Deny));
        e.register(Box::new(Scripted(transform("$target.url", json!("a")))));
        e.register(Box::new(Scripted(transform("$target.url", json!("b")))));
        let mut c = ctx();
        let r = e.emit_unchecked(&mut c).await;
        assert_eq!(
            r.verdict.reason.as_deref(),
            Some("host_error:transform_conflict")
        );
        // Snapshot isolation: neither transform applied.
        assert_eq!(c["target"]["url"], json!("evil"));
    }

    #[tokio::test]
    async fn parallel_strictest_single_transform_applies() {
        let mut e = InterceptionEmitter::new(EnforcementMode::Enforce, None);
        e.set_composition(CompositionConfig::strictest(SynthesisPolicy::Deny));
        e.register(Box::new(Scripted(Verdict::allow())));
        e.register(Box::new(Scripted(transform("$target.url", json!("safe")))));
        let mut c = ctx();
        let r = e.emit_unchecked(&mut c).await;
        assert_eq!(r.verdict.decision, Decision::Transform);
        assert_eq!(r.decided_by, Some(1));
        assert_eq!(c["target"]["url"], json!("safe"));
        assert_ne!(r.input_identity, r.enforced_identity);
    }

    #[tokio::test]
    async fn unanimous_disagreement_synthesizes() {
        let mut e = InterceptionEmitter::new(EnforcementMode::Enforce, None);
        e.set_composition(CompositionConfig::unanimous(
            SynthesisPolicy::Deny,
            SynthesisPolicy::Deny,
        ));
        e.register(Box::new(Scripted(Verdict::allow())));
        e.register(Box::new(Scripted(transform("$target.url", json!("x")))));
        let mut c = ctx();
        let r = e.emit_unchecked(&mut c).await;
        assert_eq!(
            r.verdict.reason.as_deref(),
            Some("host_error:composition_disagreement")
        );
        assert_eq!(c["target"]["url"], json!("evil"), "transform not applied");
        assert_eq!(r.decided_by, None);
    }

    #[tokio::test]
    async fn first_deny_no_resolver_deny_stands_without_error() {
        let mut e = InterceptionEmitter::new(EnforcementMode::Enforce, None);
        e.register(Box::new(Scripted(Verdict::escalate(
            Some("check".into()),
            None,
        ))));
        let mut c = ctx();
        let r = e.emit_unchecked(&mut c).await;
        // §9: no resolver → the liftable deny stands, NOT an error.
        assert_eq!(r.verdict.decision, Decision::Deny);
        assert_eq!(r.verdict.reason.as_deref(), Some("check"));
        assert!(r.verdict.is_liftable());
        assert_eq!(r.resolved_by, None);
    }

    #[tokio::test]
    async fn first_deny_stop_truncates_and_records_substitution() {
        let mut e = InterceptionEmitter::new(
            EnforcementMode::Enforce,
            Some(Box::new(Approver(
                ApprovalOutcome::Approve,
                Verdict::allow(),
            ))),
        );
        e.set_composition(CompositionConfig::first_deny(OnApproval::Stop));
        e.register(Box::new(Scripted(Verdict::escalate(None, None))));
        e.register(Box::new(Scripted(deny()))); // must be skipped
        let mut c = ctx();
        let r = e.emit_unchecked(&mut c).await;
        assert_eq!(r.verdict.decision, Decision::Allow);
        assert_eq!(r.fold_truncated, Some(true));
        assert_eq!(r.resolved_by, Some("approval"));
        assert_eq!(r.decided_by, Some(0));
    }

    #[tokio::test]
    async fn first_deny_resume_continues_the_fold() {
        let mut e = InterceptionEmitter::new(
            EnforcementMode::Enforce,
            Some(Box::new(Approver(
                ApprovalOutcome::Approve,
                Verdict::allow(),
            ))),
        );
        e.set_composition(CompositionConfig::first_deny(OnApproval::Resume));
        e.register(Box::new(Scripted(Verdict::escalate(None, None))));
        e.register(Box::new(Scripted(deny()))); // now runs — and denies
        let mut c = ctx();
        let r = e.emit_unchecked(&mut c).await;
        assert_eq!(r.verdict.decision, Decision::Deny);
        assert_eq!(r.decided_by, Some(1));
        assert_eq!(r.resolved_by, Some("approval"));
        assert_eq!(r.fold_truncated, Some(false));
    }

    #[tokio::test]
    async fn echo_rule_violation_fails_closed() {
        struct BadEcho;
        #[async_trait]
        impl ApprovalResolver for BadEcho {
            async fn resolve(&self, _req: ApprovalRequest<'_>) -> crate::ApprovalResolution {
                crate::ApprovalResolution {
                    outcome: ApprovalOutcome::Approve,
                    context_identity: Some("sha256:forged".into()),
                    verdict: Some(Verdict::allow()),
                }
            }
        }
        let mut e = InterceptionEmitter::new(EnforcementMode::Enforce, Some(Box::new(BadEcho)));
        e.register(Box::new(Scripted(Verdict::escalate(None, None))));
        let mut c = ctx();
        let r = e.emit_unchecked(&mut c).await;
        assert_eq!(
            r.verdict.reason.as_deref(),
            Some("host_error:approval_identity_mismatch")
        );
    }

    #[tokio::test]
    async fn null_provider_unbound_record() {
        let mut e = InterceptionEmitter::new(EnforcementMode::Enforce, None);
        e.set_identity_provider(IdentityProvider::Null).unwrap();
        e.register(Box::new(Scripted(Verdict::allow())));
        let mut c = ctx();
        let r = e.emit_unchecked(&mut c).await;
        assert!(r.input_identity.is_none());
        assert!(r.enforced_identity.is_none());
        assert!(r.identity_provider.is_none());
    }

    #[tokio::test]
    async fn default_provider_rejects_big_int_before_dispatch() {
        let mut e = InterceptionEmitter::new(EnforcementMode::Enforce, None);
        e.register(Box::new(Scripted(Verdict::allow())));
        let mut c = ctx();
        c.insert("target".into(), json!({"id": 9_007_199_254_740_993_i64}));
        let r = e.emit_unchecked(&mut c).await;
        assert_eq!(
            r.verdict.reason.as_deref(),
            Some("host_error:context_invalid")
        );
        assert!(r
            .verdict
            .message
            .as_deref()
            .unwrap()
            .contains("string-encode"));
        assert!(r.verdicts.is_empty(), "no interceptor ran");
    }

    #[tokio::test]
    async fn shutdown_never_consults() {
        let mut e = InterceptionEmitter::new(
            EnforcementMode::Enforce,
            Some(Box::new(Approver(
                ApprovalOutcome::Approve,
                Verdict::allow(),
            ))),
        );
        e.register(Box::new(Scripted(Verdict::escalate(None, None))));
        let mut c = ctx();
        c.insert("interception_point".into(), json!("agent_shutdown"));
        c.insert("summary".into(), json!({"reason": "completed"}));
        let r = e.emit_unchecked(&mut c).await;
        // §6.1a: the liftable deny is recorded, the seam untouched.
        assert!(r.verdict.is_liftable());
        assert_eq!(r.resolved_by, None);
    }

    /// Returns a §5-invalid value so the host synthesizes the §6.3
    /// failure deny in the interceptor's slot.
    struct Malformed;
    #[async_trait]
    impl Interceptor for Malformed {
        async fn intercept(&self, _ctx: &AgentContext) -> Verdict {
            Verdict {
                reason: Some("host_error:forged".into()),
                ..Verdict::allow()
            }
        }
    }

    #[tokio::test]
    async fn first_deny_attributes_failure_deny_to_failing_interceptor() {
        let mut e = InterceptionEmitter::new(EnforcementMode::Enforce, None);
        e.register(Box::new(Scripted(Verdict::allow())));
        e.register(Box::new(Malformed));
        e.register(Box::new(Scripted(Verdict::allow())));
        let mut c = ctx();
        let r = e.emit_unchecked(&mut c).await;
        assert_eq!(
            r.verdict.reason.as_deref(),
            Some("host_error:verdict_invalid")
        );
        // §10.3: the §6.3 failure deny carries the FAILING
        // interceptor's index in every profile.
        assert_eq!(r.decided_by, Some(1));
        assert_eq!(r.fold_truncated, Some(true));
    }
    #[tokio::test]
    async fn panicking_interceptor_fails_closed() {
        // §6.3: a panic is that interceptor's failure, not a
        // host crash.
        struct Panics;
        #[async_trait::async_trait]
        impl Interceptor for Panics {
            async fn intercept(&self, _c: &AgentContext) -> Verdict {
                panic!("SECRET-PAYLOAD must not leak");
            }
        }
        let mut e = InterceptionEmitter::new(EnforcementMode::Enforce, None);
        e.register(Box::new(Panics));
        let r = e.emit_unchecked(&mut ctx()).await;
        assert!(!r.proceeds());
        assert_eq!(
            r.verdict.reason.as_deref(),
            Some("host_error:interceptor_failed")
        );
        assert!(!r
            .verdict
            .message
            .as_deref()
            .unwrap_or("")
            .contains("SECRET"));
    }

    #[cfg(feature = "tokio-timeout")]
    #[tokio::test]
    async fn emitter_timeout_fails_closed() {
        struct Slow;
        #[async_trait::async_trait]
        impl Interceptor for Slow {
            async fn intercept(&self, _c: &AgentContext) -> Verdict {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                Verdict::allow()
            }
        }
        let mut e = InterceptionEmitter::new(EnforcementMode::Enforce, None);
        e.set_timeout(std::time::Duration::from_millis(20));
        e.register(Box::new(Slow));
        let r = e.emit_unchecked(&mut ctx()).await;
        assert_eq!(
            r.verdict.reason.as_deref(),
            Some("host_error:interceptor_timeout")
        );
        assert_eq!(r.verdict.decision, Decision::Deny);
    }

    #[tokio::test]
    async fn host_failure_synthesizes_rejection_shape_record() {
        // §10.3 host projection failure: the host could not construct
        // a context at all; the synthesized record is the rejection
        // shape with the host's envelope facts.
        let mut e = InterceptionEmitter::new(EnforcementMode::Enforce, None);
        e.register(Box::new(Scripted(Verdict::allow())));
        let r = e.record_host_failure(
            InterceptionPoint::PreToolCall,
            HostFailure {
                detail: Some("InvalidOperationException".into()),
                session_id: Some("s".into()),
                sequence: Some(7),
                timestamp: Some("2026-01-01T00:00:00Z".into()),
            },
        );
        assert!(!r.proceeds());
        assert_eq!(r.interception_point, InterceptionPoint::PreToolCall);
        assert_eq!(
            r.verdict.reason.as_deref(),
            Some("host_error:context_invalid")
        );
        assert_eq!(
            r.verdict.message.as_deref(),
            Some("InvalidOperationException")
        );
        // §10.3 rejection shape: null identities under the declared
        // provider, nothing dispatched.
        assert_eq!(r.identity_provider.as_deref(), Some(JCS_SHA256));
        assert!(r.input_identity.is_none() && r.enforced_identity.is_none());
        assert_eq!(r.decided_by, None);
        assert!(r.verdicts.is_empty(), "no interceptor ran");
        assert_eq!(r.interceptors_registered, 1);
        // Envelope facts the host supplied.
        assert_eq!(r.session_id, "s");
        assert_eq!(r.sequence, 7);
        assert_eq!(r.timestamp.as_deref(), Some("2026-01-01T00:00:00Z"));
        // The record entered the emitter's stream like any emission.
        assert_eq!(e.records().len(), 1);
    }

    #[tokio::test]
    async fn host_failure_defaults_are_the_unknown_values() {
        let mut e = InterceptionEmitter::new(EnforcementMode::Enforce, None);
        let r = e.record_host_failure(InterceptionPoint::Output, HostFailure::default());
        assert_eq!(r.session_id, "");
        assert_eq!(r.sequence, -1);
        assert!(r.timestamp.is_none());
        assert!(r.verdict.message.is_none());
        assert_eq!(r.interceptors_registered, 0);
    }

    #[tokio::test]
    async fn host_failure_records_in_evaluate_only_without_implying_enforcement() {
        // §8: synthesis still records in evaluate_only — records are
        // the point — and the mode member keeps the record from
        // implying a block happened.
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let seen = Arc::new(AtomicUsize::new(0));
        let seen2 = seen.clone();
        let mut e = InterceptionEmitter::new(EnforcementMode::EvaluateOnly, None);
        e.set_record_sink(move |_r| {
            seen2.fetch_add(1, Ordering::SeqCst);
        });
        let r = e.record_host_failure(InterceptionPoint::PreToolCall, HostFailure::default());
        assert_eq!(r.mode, EnforcementMode::EvaluateOnly);
        assert_eq!(
            r.verdict.reason.as_deref(),
            Some("host_error:context_invalid")
        );
        assert_eq!(seen.load(Ordering::SeqCst), 1, "sink saw the record");
    }

    #[tokio::test]
    async fn host_failure_detail_is_truncated_by_the_projection() {
        // §10.3: the synthesized verdict crosses the same payload-free
        // projection as every combined verdict.
        let mut e = InterceptionEmitter::new(EnforcementMode::Enforce, None);
        let r = e.record_host_failure(
            InterceptionPoint::PreToolCall,
            HostFailure {
                detail: Some("x".repeat(300)),
                ..HostFailure::default()
            },
        );
        let m = r.verdict.message.unwrap();
        assert!(m.ends_with('…') && m.len() <= 256 + '…'.len_utf8());
    }

    #[tokio::test]
    async fn record_sink_and_ring_buffer() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let seen = Arc::new(AtomicUsize::new(0));
        let seen2 = seen.clone();
        let mut e = InterceptionEmitter::new(EnforcementMode::Enforce, None);
        e.register(Box::new(Scripted(Verdict::allow())));
        e.set_record_sink(move |_r| {
            seen2.fetch_add(1, Ordering::SeqCst);
        });
        e.set_max_records(2);
        for _ in 0..5 {
            let _ = e.emit_unchecked(&mut ctx()).await;
        }
        assert_eq!(seen.load(Ordering::SeqCst), 5);
        assert_eq!(e.records().len(), 2);
        assert_eq!(e.records_dropped(), 3);
        assert_eq!(e.take_records().len(), 2);
        assert!(e.records().is_empty());
    }

    #[tokio::test]
    async fn approval_redactor_binds_identity_to_presented_context() {
        // §9: the request identity covers the REDACTED context,
        // and the redacted field never reaches the resolver.
        use std::sync::Mutex;
        struct Capture(Mutex<Option<(String, String)>>);
        #[async_trait::async_trait]
        impl ApprovalResolver for Capture {
            async fn resolve(&self, req: ApprovalRequest<'_>) -> ApprovalResolution {
                let ctx_json = serde_json::to_string(req.context).unwrap();
                *self.0.lock().unwrap() =
                    Some((req.context_identity.clone().unwrap_or_default(), ctx_json));
                ApprovalResolution {
                    outcome: ApprovalOutcome::Approve,
                    context_identity: req.context_identity.clone(),
                    verdict: Some(Verdict::allow()),
                }
            }
        }
        let captured = std::sync::Arc::new(Capture(Mutex::new(None)));
        struct Escalates;
        #[async_trait::async_trait]
        impl Interceptor for Escalates {
            async fn intercept(&self, _c: &AgentContext) -> Verdict {
                Verdict::escalate(Some("check".into()), None)
            }
        }
        struct Shared(std::sync::Arc<Capture>);
        #[async_trait::async_trait]
        impl ApprovalResolver for Shared {
            async fn resolve(&self, req: ApprovalRequest<'_>) -> ApprovalResolution {
                self.0.resolve(req).await
            }
        }
        let mut e = InterceptionEmitter::new(
            EnforcementMode::Enforce,
            Some(Box::new(Shared(captured.clone()))),
        );
        e.register(Box::new(Escalates));
        e.set_approval_redactor(|ctx| {
            let mut c = ctx.clone();
            if let Some(Value::Object(tc)) = c.get_mut("tool_call") {
                tc.insert("args".into(), serde_json::json!({"REDACTED": true}));
            }
            c.insert("target".into(), serde_json::json!({"REDACTED": true}));
            c
        });
        let r = e.emit_unchecked(&mut ctx()).await;
        assert!(r.proceeds());
        let (identity, presented) = captured.0.lock().unwrap().clone().unwrap();
        assert!(
            !presented.contains("evil"),
            "unredacted content egressed: {presented}"
        );
        // The echoed identity matched what the emitter computed over
        // the redacted context (approve succeeded), and differs from
        // the record's own (unredacted) identities.
        assert_ne!(Some(identity.as_str()), r.input_identity.as_deref());
    }
}
