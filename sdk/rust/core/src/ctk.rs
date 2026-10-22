// Copyright (c) Microsoft. All rights reserved.

//! Conformance Test Kit runner for Rust-native hosts (§13.2).
//!
//! The assertion engine, capability skip check, and scripted
//! interceptor/resolver evaluation live in [`crate::ctk_engine`]; this
//! module is the same thin glue the other SDK runners implement over
//! the FFI — vector globbing, the recording wrapper, and the
//! orchestration loop that drives the native [`Harness`]. The in-tree
//! [`ReferenceHarness`] is the CTK self-test target.

use crate::composition::CompositionConfig;
use crate::ctk_engine::{assert_vector, scripted_intercept, scripted_resolve, should_skip};
// Public seam for out-of-crate `Harness` implementors: every type the
// trait's signatures reference is importable from `agent_hooks::ctk`,
// and `async_trait` is re-exported so implementors don't need the
// dependency themselves.
pub use crate::ctk_engine::{IdentityPair, LoadRecord, RunRecord, VectorResult};
use crate::declaration::{resolve, resolve_surface_only, BindingContext, RegistryNames};
pub use crate::declaration::{
    DeclarationBuilder, DeclarationError, DeclarationErrorClass, HostDeclaration, HostRegistry,
    HostSurface, KindResolver, KnobSupport, ManagedKindResolver, ResolvedDeclaration,
    ToolSeamPosture,
};
use crate::emitter::{IdentityProvider, InterceptionBlocked, InterceptionEmitter};
use crate::types::{
    AgentContext, ApprovalRequest, ApprovalResolution, ApprovalResolver, EnforcementMode,
    InterceptionPoint, Interceptor, ManagedInterceptor, ManagedInterceptorOutcome, Verdict,
};
use crate::AgentContextBuilder;
pub use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Load all `AH-CTK-*.json` vectors from a directory, sorted by name.
pub fn load_vectors(dir: impl AsRef<Path>) -> std::io::Result<Vec<Value>> {
    let mut names: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("AH-CTK-") && n.ends_with(".json"))
        })
        .collect();
    names.sort();
    if names.is_empty() {
        // A runner fed zero vectors reports 100% pass — a false
        // conformance signal (§13.2). Fail loudly instead.
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no AH-CTK-*.json vectors found",
        ));
    }
    names
        .into_iter()
        .map(|p| {
            let text = std::fs::read_to_string(p)?;
            serde_json::from_str(&text).map_err(std::io::Error::other)
        })
        .collect()
}

/// A §5-invalid verdict shape (transform decision, no body) used to
/// surface scripted faults through the infallible Rust traits.
fn invalid_verdict() -> Verdict {
    Verdict {
        decision: crate::Decision::Transform,
        ..Verdict::allow()
    }
}

/// Replays one `interceptor_script` rule list via the CTK engine.
struct ScriptedInterceptor {
    rules: Vec<Value>,
    /// When set, every received context is deep-copied here before rule
    /// evaluation. Only the first-registered interceptor records:
    /// `expect.interceptions` describes each emission as it saw it.
    recorded: Option<Arc<Mutex<Vec<Value>>>>,
}

/// What a scripted rule asks the interceptor to do.
enum Scripted {
    Verdict(Box<Verdict>),
    /// `fault: raise`. The Rust `Interceptor` trait is infallible
    /// (§7), so the native analogue of an exception is a panic, which
    /// the emitter isolates into `host_error:interceptor_failed`, the
    /// reason the other SDKs record for a raise.
    Raise,
    /// `fault: hang`: do not return within the binding's bound.
    Hang,
    /// `fault: cancel`: the typed cancelled outcome of a managed
    /// interceptor (§6.3).
    Cancel,
}

impl ScriptedInterceptor {
    fn evaluate(&self, context: &AgentContext) -> Scripted {
        let ctx_value = Value::Object(context.clone());
        if let Some(rec) = &self.recorded {
            rec.lock()
                .expect("recorder poisoned")
                .push(ctx_value.clone());
        }
        let wire = scripted_intercept(&self.rules, &ctx_value);
        match wire.get("__ctk_fault__").and_then(Value::as_str) {
            // §7 isolation fault (TM-05): the trait takes &AgentContext,
            // so in-place mutation is statically impossible in Rust —
            // the isolation the vector probes is the type system
            // itself. Return the same allow the mutating wrappers
            // return.
            Some("mutate") => Scripted::Verdict(Box::new(
                crate::verdict_from_wire(
                    &serde_json::json!({"decision": "allow", "reason": "ctk:mutated"}),
                )
                .expect("static allow shape"),
            )),
            Some("raise") => Scripted::Raise,
            Some("hang") => Scripted::Hang,
            Some("cancel") => Scripted::Cancel,
            Some(_) => Scripted::Verdict(Box::new(invalid_verdict())),
            // A §5-malformed shape fails the emitter's gate and yields
            // host_error:verdict_invalid (fail closed either way).
            None => Scripted::Verdict(Box::new(
                crate::verdict_from_wire(&wire).unwrap_or_else(|_| invalid_verdict()),
            )),
        }
    }
}

/// `fault: hang` grace for a path with no bound to honour: the wrapper
/// returns allow once the bound plus this grace has passed, so an
/// unbounded host fails the vector instead of hanging it.
const HANG_GRACE: std::time::Duration = std::time::Duration::from_secs(10);

#[async_trait]
impl Interceptor for ScriptedInterceptor {
    async fn intercept(&self, context: &AgentContext) -> Verdict {
        match self.evaluate(context) {
            Scripted::Verdict(v) => *v,
            Scripted::Raise => panic!("ctk scripted fault: raise"),
            // The emitter's own timer (the `ctk` feature is a bounded
            // build) ends the call first; the allow after the grace is
            // what an unbounded host would see.
            Scripted::Hang => {
                tokio::time::sleep(HANG_GRACE).await;
                Verdict::allow()
            }
            // A standard interceptor has no cancelled outcome; the
            // nearest fail-closed analogue.
            Scripted::Cancel => invalid_verdict(),
        }
    }
}

/// The same script through the managed-interceptor path (§6.3, §7):
/// the `ctk.managed` kind of a declaration vector owns its own
/// deadline, so `hang` waits out the bound it was handed, cleans up
/// and reports the typed timeout, and `cancel` reports the typed
/// cancelled outcome. The emitter does not wrap it in a second timer.
struct ScriptedManagedInterceptor(ScriptedInterceptor);

#[async_trait]
impl ManagedInterceptor for ScriptedManagedInterceptor {
    async fn intercept_managed(
        &self,
        context: &AgentContext,
        bound: Option<std::time::Duration>,
    ) -> ManagedInterceptorOutcome {
        match self.0.evaluate(context) {
            Scripted::Verdict(v) => ManagedInterceptorOutcome::Verdict(v),
            Scripted::Raise => panic!("ctk scripted fault: raise"),
            Scripted::Hang => match bound {
                // The work (a sleep standing in for a process or a
                // request) is dropped at the deadline: cancelled and
                // cleaned up before the typed outcome is reported.
                Some(d) => {
                    let work = tokio::time::sleep(HANG_GRACE);
                    if tokio::time::timeout(d, work).await.is_err() {
                        ManagedInterceptorOutcome::Timeout
                    } else {
                        ManagedInterceptorOutcome::Verdict(Box::new(Verdict::allow()))
                    }
                }
                None => {
                    tokio::time::sleep(HANG_GRACE).await;
                    ManagedInterceptorOutcome::Verdict(Box::new(Verdict::allow()))
                }
            },
            Scripted::Cancel => ManagedInterceptorOutcome::Cancelled,
        }
    }
}

/// Replays a vector's `approval_script` via the CTK engine.
struct ScriptedResolver {
    rules: Vec<Value>,
}

#[async_trait]
impl ApprovalResolver for ScriptedResolver {
    async fn resolve(&self, request: ApprovalRequest<'_>) -> ApprovalResolution {
        let ctx_value = Value::Object(request.context.clone());
        // §10.1: identity may be None (null provider). The scripted
        // engine works in strings; "" round-trips to None below.
        let request_identity = request.context_identity.clone().unwrap_or_default();
        let out = scripted_resolve(&self.rules, &ctx_value, &request_identity);
        // Infallible resolver trait: a scripted "raise" maps to a
        // resolution whose verdict fails the §5 gate (fail closed).
        if out.get("__ctk_fault__").is_some() {
            return ApprovalResolution {
                outcome: crate::ApprovalOutcome::Approve,
                context_identity: request.context_identity.clone(),
                verdict: Some(invalid_verdict()),
            };
        }
        let outcome = match out["outcome"].as_str() {
            Some("approve") => crate::ApprovalOutcome::Approve,
            Some("reject") => crate::ApprovalOutcome::Reject,
            _ => crate::ApprovalOutcome::Unresolved,
        };
        let verdict = out
            .get("verdict")
            .map(|v| crate::verdict_from_wire(v).expect("malformed approval_script verdict"));
        let echoed = out["context_identity"].as_str().unwrap_or_default();
        ApprovalResolution {
            outcome,
            context_identity: if echoed.is_empty() && request.context_identity.is_none() {
                None
            } else {
                Some(echoed.to_owned())
            },
            verdict,
        }
    }
}

/// Everything one vector asks a harness to wire (§13.2). Bundled so
/// the seam can grow without breaking every implementor.
pub struct VectorSetup {
    pub scenario: Value,
    pub interceptors: Vec<Box<dyn Interceptor>>,
    pub resolver: Option<Box<dyn ApprovalResolver>>,
    pub mode: EnforcementMode,
    pub composition: CompositionConfig,
    pub identity_provider: IdentityProvider,
    /// §9 redaction seam paths; empty = no redactor.
    pub redact_for_approval: Vec<String>,
}

/// The single trait a framework adapter implements for the CTK.
#[async_trait]
pub trait Harness: Send {
    /// Framework identifier (e.g., `"reference-agent"`).
    fn name(&self) -> &str;

    /// Declared capability subset (§3.2), wire strings
    /// (`"model_calls"`, `"tool_calls"`, …).
    fn capabilities(&self) -> Vec<String>;

    /// Declared §6.2 posture at the tool seam (§13.1): what the host
    /// does with the run after a `host_error:*` deny at
    /// `pre_tool_call`/`post_tool_call`. `"continue"` (the default —
    /// surface a tool error to the model and keep the loop going) or
    /// `"terminate"` (the host's own semantics terminate the turn,
    /// which §6.2 explicitly permits). The runner forwards this
    /// declaration so `expect.run_outcome_by_posture` vectors resolve
    /// to the single outcome this surface must produce.
    fn tool_seam_host_error(&self) -> &str {
        "continue"
    }

    /// Wire one vector into the framework: the scenario's mock model +
    /// tools, the interceptors and resolver, the enforcement mode, the
    /// vector's composition profile (§7.1), its identity provider
    /// (§10.1), and — when `redact_for_approval` is non-empty — an
    /// approval redactor that replaces each listed §5.2 path in the
    /// request context's target with the string `"[redacted]"`
    /// (write-back mirrored per §4.3), leaving unresolvable paths
    /// untouched.
    fn setup(&mut self, setup: VectorSetup);

    /// Execute one session; return what happened.
    async fn run(&mut self) -> RunRecord;

    /// Tear down anything `setup` created.
    fn teardown(&mut self);

    /// The code surface (§7.7.4) a declaration is resolved against.
    /// The default derives it from [`Self::capabilities`] and
    /// [`Self::tool_seam_host_error`]: the §3.2 floor plus the model
    /// points iff `model_calls` plus the tool points iff `tool_calls`,
    /// every profile with every knob value, this build's timeout
    /// support and every accepted contract version. A host declaring
    /// `incremental_output` overrides this to add its exposure bound
    /// (`HostSurface::with_exposure_bound`); the derived surface alone
    /// is refused for such a host.
    fn host_surface(&self) -> HostSurface {
        let posture = if self.tool_seam_host_error() == "terminate" {
            ToolSeamPosture::Terminate
        } else {
            ToolSeamPosture::Continue
        };
        HostSurface::from_capabilities(self.capabilities(), posture)
    }

    /// The host's own declaration document (§7.7.9), when it has one.
    /// The runner resolves it against [`Self::host_surface`] and reads
    /// the capabilities and posture a run is assessed against from the
    /// resolved form, so what the CTK ran against is what a claim
    /// cites. `None` keeps the code-declared surface.
    fn declaration(&self) -> Option<Value> {
        None
    }

    /// Wire one declaration vector (§7.7.9): the harness MUST build its
    /// emitter from `document` and `registry` through the loader
    /// (`InterceptionEmitter::from_declaration_value`) and return the
    /// refusal, never fall back to the field-based construction.
    /// `setup.interceptors`, `resolver`, `composition` and
    /// `identity_provider` are empty or default here: the document and
    /// the registry carry them. Only harnesses declaring the
    /// `host_declaration` capability receive this call.
    fn setup_declared(
        &mut self,
        _setup: VectorSetup,
        _document: Value,
        _registry: HostRegistry,
    ) -> Result<(), DeclarationError> {
        Err(DeclarationError::new(
            DeclarationErrorClass::SurfaceUnsupported,
            "",
            format!(
                "harness {:?} declares host_declaration but does not implement setup_declared",
                self.name()
            ),
        ))
    }
}

/// The scripted interceptors and resolver a vector carries, shared by
/// the field-based and the declaration path.
struct Scripts {
    scripts: Vec<Vec<Value>>,
    approval: Vec<Value>,
    redact: Vec<String>,
    recorded: Arc<Mutex<Vec<Value>>>,
}

impl Scripts {
    fn of(vector: &Value) -> Self {
        // Multi-interceptor vectors (§7.1 fold-through) use
        // interceptor_scripts; single-interceptor vectors use
        // interceptor_script. An empty interceptor_scripts registers zero
        // interceptors (§7 fail-closed vector).
        let scripts: Vec<Vec<Value>> = match vector.get("interceptor_scripts") {
            Some(Value::Array(lists)) => lists
                .iter()
                .map(|l| l.as_array().cloned().unwrap_or_default())
                .collect(),
            _ => vec![vector["interceptor_script"]
                .as_array()
                .cloned()
                .unwrap_or_default()],
        };
        let approval = vector
            .get("approval_script")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let redact = vector
            .get("redact_for_approval")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        Self {
            scripts,
            approval,
            redact,
            recorded: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Scripted interceptor `i`; only index 0 records (`expect.
    /// interceptions` describes each emission as it saw it).
    fn interceptor(&self, i: usize) -> Option<Box<dyn Interceptor>> {
        let rules = self.scripts.get(i)?.clone();
        Some(Box::new(ScriptedInterceptor {
            rules,
            recorded: (i == 0).then(|| Arc::clone(&self.recorded)),
        }))
    }

    fn interceptors(&self) -> Vec<Box<dyn Interceptor>> {
        (0..self.scripts.len())
            .filter_map(|i| self.interceptor(i))
            .collect()
    }

    fn resolver(&self) -> Option<Box<dyn ApprovalResolver>> {
        (!self.approval.is_empty()).then(|| {
            Box::new(ScriptedResolver {
                rules: self.approval.clone(),
            }) as Box<dyn ApprovalResolver>
        })
    }

    /// The CTK registry for a declaration vector (§7.7.9): two kinds
    /// over the same scripted interceptor, identity provider
    /// `ctk-fault`, approval resolver `ctk-scripted`, redactor
    /// `ctk-redact`. For both kinds config `{"script": i}` selects
    /// `interceptor_scripts[i]` and script 0 records.
    ///
    /// `ctk.scripted` is a standard registration: the emitter wraps it
    /// in its own timer, so `fault: hang` blocks past the binding's
    /// `timeout_ms` and the emitter's `host_error:interceptor_timeout`
    /// path is what the vector observes (`AH-CTK-144`, `AH-CTK-145`).
    /// `ctk.managed` goes through the managed-interceptor path (§7):
    /// it receives the resolved bound and reports a typed outcome, so
    /// `fault: hang` reports `timeout` after cancelling its work and
    /// `fault: cancel` reports `cancelled` (`AH-CTK-150`). The
    /// principal channel is the harness's own: it adds its
    /// `control_failure_notifier` in `setup_declared` and reports what
    /// it delivered as `RunRecord.host_messages`.
    fn registry(&self, surface: HostSurface) -> HostRegistry {
        let scripts = self.scripts.clone();
        let recorded = Arc::clone(&self.recorded);
        let select = move |config: &Value, ctx: &BindingContext<'_>| {
            let i = config
                .get("script")
                .and_then(Value::as_u64)
                .ok_or_else(|| "config.script must be an unsigned integer index".to_owned())?
                as usize;
            let rules = scripts.get(i).cloned().ok_or_else(|| {
                format!("config.script {i} is out of range for binding {}", ctx.id)
            })?;
            Ok::<_, String>(ScriptedInterceptor {
                rules,
                recorded: (i == 0).then(|| Arc::clone(&recorded)),
            })
        };
        let select_managed = select.clone();
        let scripted: KindResolver =
            Box::new(move |config, ctx| Ok(Box::new(select(config, ctx)?) as Box<dyn Interceptor>));
        let managed: ManagedKindResolver = Box::new(move |config, ctx| {
            Ok(
                Box::new(ScriptedManagedInterceptor(select_managed(config, ctx)?))
                    as Box<dyn ManagedInterceptor>,
            )
        });
        let approval = self.approval.clone();
        let redact = self.redact.clone();
        HostRegistry::for_conformance(surface)
            .kind("ctk.scripted", scripted)
            .expect("ctk kinds are valid by construction")
            .managed_kind("ctk.managed", managed)
            .expect("ctk kinds are valid by construction")
            .identity_provider("ctk-fault", |_| panic!("ctk scripted provider fault"))
            .expect("ctk-fault satisfies the name rules")
            .approval_resolver(
                "ctk-scripted",
                Box::new(ScriptedResolver { rules: approval }),
            )
            .expect("ctk-scripted satisfies the name rules")
            .approval_redactor("ctk-redact", move |ctx| redact_paths(ctx, &redact))
            .expect("ctk-redact satisfies the name rules")
    }
}

/// §9 redaction seam, CTK convention: each listed path is replaced
/// with "[redacted]" via the §5.2/§4.3 transform machinery; a path
/// that does not resolve at the escalating point is left untouched.
fn redact_paths(ctx: &AgentContext, paths: &[String]) -> AgentContext {
    let mut c = ctx.clone();
    for path in paths {
        let t = crate::types::Transform {
            path: path.clone(),
            value: Value::String("[redacted]".into()),
        };
        let _ = crate::enforce::apply_transform_to_ctx(&mut c, &t);
    }
    c
}

/// Rebuild a document through [`DeclarationBuilder`], member by
/// member (§7.7.7, the code path). Members the typed setters cannot
/// express exactly (an unknown member, a wrong type) go through
/// [`DeclarationBuilder::raw`], so the result is validated like the
/// file it came from.
pub fn builder_from_value(doc: &Value) -> DeclarationBuilder {
    let mut b = DeclarationBuilder::empty();
    let Some(obj) = doc.as_object() else {
        return b;
    };
    for (k, v) in obj {
        b = match (k.as_str(), v) {
            ("declaration", Value::String(s)) => b.version(s),
            ("spec", Value::String(s)) => b.spec(s),
            ("id", Value::String(s)) => b.id(s),
            ("host", Value::Object(h))
                if h.keys().all(|k| k == "name" || k == "version")
                    && h.get("name").is_some_and(Value::is_string)
                    && h.get("version").map_or(true, Value::is_string) =>
            {
                b.host(
                    h["name"].as_str().unwrap_or(""),
                    h.get("version").and_then(Value::as_str),
                )
            }
            ("configuration", Value::Object(c)) => match typed_configuration(b.clone(), c) {
                Some(b2) => b2,
                None => b.raw(k, v.clone()),
            },
            ("surface", Value::Object(sf)) => match typed_surface(b.clone(), sf) {
                Some(b2) => b2,
                None => b.raw(k, v.clone()),
            },
            ("bindings", Value::Array(items)) => match typed_bindings(b.clone(), items) {
                Some(b2) => b2,
                None => b.raw(k, v.clone()),
            },
            ("extensions", Value::Object(e)) => {
                let mut b2 = b;
                for (ek, ev) in e {
                    b2 = b2.extension(ek, ev.clone());
                }
                b2
            }
            _ => b.raw(k, v.clone()),
        };
    }
    b
}

fn typed_configuration(
    mut b: DeclarationBuilder,
    c: &Map<String, Value>,
) -> Option<DeclarationBuilder> {
    for (k, v) in c {
        b = match (k.as_str(), v) {
            ("mode", Value::String(m)) => match m.as_str() {
                "enforce" => b.mode(EnforcementMode::Enforce),
                "evaluate_only" => b.mode(EnforcementMode::EvaluateOnly),
                _ => return None,
            },
            ("composition", Value::Object(comp)) => {
                let known = [
                    "profile",
                    "on_approval",
                    "on_disagreement",
                    "on_transform_conflict",
                ];
                if !comp.keys().all(|k| known.contains(&k.as_str())) {
                    return None;
                }
                let mut cfg = CompositionConfig {
                    on_approval: None,
                    ..CompositionConfig::default()
                };
                match comp.get("profile") {
                    None => {}
                    Some(Value::String(p)) => {
                        cfg.profile = crate::composition::CompositionProfile::from_wire(p)?;
                    }
                    Some(_) => return None,
                }
                for (kk, vv) in comp {
                    if kk == "profile" {
                        continue;
                    }
                    let s = vv.as_str()?;
                    match (kk.as_str(), s) {
                        ("on_approval", "stop") => cfg.on_approval = Some(crate::OnApproval::Stop),
                        ("on_approval", "resume") => {
                            cfg.on_approval = Some(crate::OnApproval::Resume)
                        }
                        ("on_disagreement", "deny") => {
                            cfg.on_disagreement = Some(crate::SynthesisPolicy::Deny)
                        }
                        ("on_disagreement", "approval") => {
                            cfg.on_disagreement = Some(crate::SynthesisPolicy::Approval)
                        }
                        ("on_transform_conflict", "deny") => {
                            cfg.on_transform_conflict = Some(crate::SynthesisPolicy::Deny)
                        }
                        ("on_transform_conflict", "approval") => {
                            cfg.on_transform_conflict = Some(crate::SynthesisPolicy::Approval)
                        }
                        _ => return None,
                    }
                }
                b.composition(cfg)
            }
            ("identity_provider", Value::Null) => b.identity_provider(None),
            ("identity_provider", Value::String(s)) => b.identity_provider(Some(s)),
            ("approval", Value::Object(a)) => {
                let mut b2 = b;
                for (ak, av) in a {
                    let name = match av {
                        Value::Null => None,
                        Value::String(s) => Some(s.as_str()),
                        _ => return None,
                    };
                    b2 = match ak.as_str() {
                        "resolver" => b2.approval_resolver(name),
                        "redactor" => b2.approval_redactor(name),
                        _ => return None,
                    };
                }
                b2
            }
            ("posture", Value::Object(p)) => {
                if p.len() != 1 {
                    return None;
                }
                match p.get("tool_seam_host_error").and_then(Value::as_str) {
                    Some("continue") => b.tool_seam_host_error(ToolSeamPosture::Continue),
                    Some("terminate") => b.tool_seam_host_error(ToolSeamPosture::Terminate),
                    _ => return None,
                }
            }
            ("failure", Value::Object(fl)) => {
                if fl.len() != 1 {
                    return None;
                }
                let on_error = fl
                    .get("on_error")
                    .and_then(Value::as_str)
                    .and_then(crate::OnError::from_wire)?;
                b.failure_on_error(on_error)
            }
            ("timeouts", Value::Object(t)) => {
                let mut b2 = b;
                for (tk, tv) in t {
                    let ms = match tv {
                        Value::Null => None,
                        n if n.is_u64() => n.as_u64(),
                        _ => return None,
                    };
                    b2 = match tk.as_str() {
                        "interceptor_ms" => b2.interceptor_timeout_ms(ms),
                        "approval_resolver_ms" => b2.approval_resolver_timeout_ms(ms),
                        _ => return None,
                    };
                }
                b2
            }
            ("records", Value::Object(r)) => {
                if r.len() != 1 {
                    return None;
                }
                match r.get("max_buffered") {
                    Some(Value::Null) => b.max_buffered_records(None),
                    Some(n) if n.is_u64() => b.max_buffered_records(n.as_u64()),
                    _ => return None,
                }
            }
            _ => return None,
        };
    }
    Some(b)
}

fn points_of(v: &Value) -> Option<Vec<InterceptionPoint>> {
    v.as_array()?
        .iter()
        .map(|p| p.as_str().and_then(|s| s.parse().ok()))
        .collect()
}

fn strings_of(v: &Value) -> Option<Vec<String>> {
    v.as_array()?
        .iter()
        .map(|s| s.as_str().map(str::to_owned))
        .collect()
}

fn typed_surface(mut b: DeclarationBuilder, sf: &Map<String, Value>) -> Option<DeclarationBuilder> {
    let buffered = match sf.get("buffered_output") {
        None => None,
        Some(Value::Bool(x)) => Some(*x),
        Some(_) => return None,
    };
    let bound = match sf.get("exposure_bound") {
        None => None,
        Some(Value::String(s)) => Some(s.as_str()),
        Some(_) => return None,
    };
    if let Some(buffered) = buffered {
        b = b.buffered_output(buffered, bound);
    } else if bound.is_some() {
        return None;
    }
    for (k, v) in sf {
        b = match k.as_str() {
            "interception_points" => b.surface_points(points_of(v)?),
            "capabilities" => b.surface_capabilities(strings_of(v)?),
            "declaration_versions" => b.surface_declaration_versions(strings_of(v)?),
            "profiles" => {
                let mut b2 = b;
                for (name, knobs) in v.as_object()? {
                    let profile = crate::composition::CompositionProfile::from_wire(name)?;
                    let support: KnobSupport = serde_json::from_value(knobs.clone()).ok()?;
                    b2 = b2.surface_profile(profile, support);
                }
                b2
            }
            "buffered_output" | "exposure_bound" => b,
            _ => return None,
        };
    }
    Some(b)
}

fn typed_bindings(mut b: DeclarationBuilder, items: &[Value]) -> Option<DeclarationBuilder> {
    let known = ["id", "kind", "config", "at", "timeout_ms", "on_error"];
    if items.is_empty() {
        // The written-down empty-deny host (§7.7.5): `bind` is never
        // called, so the member is set explicitly.
        return Some(b.raw("bindings", Value::Array(Vec::new())));
    }
    for item in items {
        let o = item.as_object()?;
        if !o.keys().all(|k| known.contains(&k.as_str())) {
            return None;
        }
        let id = o.get("id")?.as_str()?;
        let kind = o.get("kind")?.as_str()?;
        let config = o
            .get("config")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
        let at = match o.get("at") {
            None => None,
            Some(v) => Some(points_of(v)?),
        };
        let timeout = match o.get("timeout_ms") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(n) if n.is_u64() => Some(n.as_u64()),
            Some(_) => return None,
        };
        let on_error = match o.get("on_error") {
            None => None,
            Some(Value::String(s)) => Some(crate::OnError::from_wire(s)?),
            Some(_) => return None,
        };
        b = b.bind_with(
            id,
            kind,
            config,
            crate::declaration::BindingOptions {
                at,
                timeout_ms: timeout,
                on_error,
            },
        );
    }
    Some(b)
}

/// Resolve `doc` through the four construction paths (§7.7.7) and
/// compare: value, JSON text, a temporary file and the builder. Equal
/// canonical forms, or equal refusal classes, prove the paths
/// equivalent. Returns `(equivalent, detail)`.
pub fn prove_paths(
    doc: &Value,
    surface: &HostSurface,
    names: &RegistryNames,
    tag: &str,
) -> (bool, String) {
    let text = serde_json::to_string(doc).expect("vector document serializes");
    let path = std::env::temp_dir().join(format!(
        "agent-hooks-ctk-{tag}-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let from_file = match std::fs::write(&path, &text) {
        Ok(()) => HostDeclaration::from_path(&path),
        Err(e) => Err(DeclarationError::new(
            DeclarationErrorClass::Unreadable,
            "",
            format!("cannot write temporary file: {e}"),
        )),
    };
    let _ = std::fs::remove_file(&path);
    let outcomes: Vec<(&str, Result<ResolvedDeclaration, DeclarationError>)> = vec![
        (
            "value",
            HostDeclaration::from_value(doc.clone()).and_then(|d| resolve(&d, surface, names)),
        ),
        (
            "json",
            HostDeclaration::from_json(&text).and_then(|d| resolve(&d, surface, names)),
        ),
        ("file", from_file.and_then(|d| resolve(&d, surface, names))),
        (
            "builder",
            builder_from_value(doc)
                .build()
                .and_then(|d| resolve(&d, surface, names)),
        ),
    ];
    let keys: Vec<String> = outcomes
        .iter()
        .map(|(_, r)| match r {
            Ok(res) => format!("ok:{}", res.canonical_json()),
            Err(e) => format!("err:{}", e.code()),
        })
        .collect();
    if keys.iter().all(|k| k == &keys[0]) {
        return (true, String::new());
    }
    let mut detail = String::new();
    for ((name, r), key) in outcomes.iter().zip(&keys) {
        let short = match r {
            Ok(_) => "accepted".to_owned(),
            Err(e) => e.to_string(),
        };
        detail.push_str(&format!("{name}: {short}; "));
        let _ = key;
    }
    if let (Some(a), Some(b)) = (
        keys.iter().find(|k| k.starts_with("ok:")),
        keys.iter().filter(|k| k.starts_with("ok:")).nth(1),
    ) {
        if a != b {
            let pos = a
                .bytes()
                .zip(b.bytes())
                .position(|(x, y)| x != y)
                .unwrap_or(0);
            detail.push_str(&format!("first difference at byte {pos}"));
        }
    }
    (false, detail)
}

/// Run one vector against a harness and assert `expect` (§13.2).
pub async fn run_vector(harness: &mut dyn Harness, vector: &Value) -> VectorResult {
    let id = vector["id"].as_str().unwrap_or("").to_owned();
    let title = vector["title"].as_str().unwrap_or("").to_owned();

    let part = vector
        .get("part")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let fail = |failures: Vec<String>| VectorResult {
        id: id.clone(),
        title: title.clone(),
        part: part.clone(),
        status: "fail",
        detail: String::new(),
        failures,
    };

    // §7.7.9: a harness with its own declaration is assessed against
    // the resolved document, so what ran is what a claim cites.
    let code_surface = harness.host_surface();
    let (mut caps, posture, on_error) = match harness.declaration() {
        Some(doc) => {
            let resolved = HostDeclaration::from_value(doc)
                .and_then(|d| resolve_surface_only(&d, &code_surface));
            match resolved {
                Ok(r) => (
                    r.surface.capabilities.iter().cloned().collect::<Vec<_>>(),
                    r.configuration
                        .posture
                        .tool_seam_host_error
                        .as_str()
                        .to_owned(),
                    r.configuration.failure.on_error.as_str().to_owned(),
                ),
                Err(e) => return fail(vec![format!("harness declaration refused: {e}")]),
            }
        }
        None => (
            harness.capabilities(),
            harness.tool_seam_host_error().to_owned(),
            crate::OnError::Deny.as_str().to_owned(),
        ),
    };
    caps.sort();
    let caps_ref: Vec<&str> = caps.iter().map(String::as_str).collect();
    if let Some(detail) = should_skip(vector, &caps_ref) {
        return VectorResult {
            id,
            title,
            part,
            status: "skip",
            detail,
            failures: Vec::new(),
        };
    }

    let scripts = Scripts::of(vector);
    let recorded = Arc::clone(&scripts.recorded);
    let mode = match vector.get("mode").and_then(Value::as_str) {
        Some("evaluate_only") => EnforcementMode::EvaluateOnly,
        _ => EnforcementMode::Enforce,
    };
    // §13.2: composition vectors carry the profile/knobs they apply to;
    // absent means the pre-P-003 default.
    let composition: CompositionConfig = vector
        .get("composition")
        .and_then(|c| serde_json::from_value(c.clone()).ok())
        .unwrap_or_default();
    // §10.1: absent → the default provider; explicit null → unbound;
    // "ctk-fault" → a custom provider that panics (pins the §10.1
    // provider-failure rule: deny context_invalid before dispatch).
    let identity_provider = match vector.get("identity_provider") {
        Some(Value::Null) => IdentityProvider::Null,
        Some(Value::String(s)) if s == "ctk-fault" => {
            IdentityProvider::custom("ctk-fault", |_| panic!("ctk scripted provider fault"))
                .expect("ctk-fault satisfies the name rules")
        }
        _ => IdentityProvider::JcsSha256,
    };

    let redact_for_approval = scripts.redact.clone();

    // §7.7.9: a declaration vector builds the emitter through the
    // loader. The runner proves the construction paths itself, then
    // hands the document and the CTK registry to the harness.
    let mut rr = if let Some(document) = vector.get("host_declaration") {
        let registry = scripts.registry(code_surface.clone());
        let (paths_equivalent, path_detail) =
            prove_paths(document, registry.surface(), &registry.names(), &id);
        let setup = VectorSetup {
            scenario: vector["scenario"].clone(),
            interceptors: Vec::new(),
            resolver: None,
            mode,
            composition,
            identity_provider,
            redact_for_approval,
        };
        match harness.setup_declared(setup, document.clone(), registry) {
            Err(e) => {
                harness.teardown();
                RunRecord {
                    outcome: "error".into(),
                    error: Some(e.to_string()),
                    load: Some(LoadRecord {
                        outcome: "refused".into(),
                        class: Some(e.code().to_owned()),
                        paths_equivalent: Some(paths_equivalent),
                        detail: Some(if path_detail.is_empty() {
                            e.to_string()
                        } else {
                            format!("{e}; paths: {path_detail}")
                        }),
                    }),
                    ..Default::default()
                }
            }
            Ok(()) => {
                let mut rr = harness.run().await;
                harness.teardown();
                rr.load = Some(LoadRecord {
                    outcome: "accepted".into(),
                    class: None,
                    paths_equivalent: Some(paths_equivalent),
                    detail: (!path_detail.is_empty()).then_some(path_detail),
                });
                rr
            }
        }
    } else {
        harness.setup(VectorSetup {
            scenario: vector["scenario"].clone(),
            interceptors: scripts.interceptors(),
            resolver: scripts.resolver(),
            mode,
            composition,
            identity_provider,
            redact_for_approval,
        });
        let rr = harness.run().await;
        harness.teardown();
        rr
    };

    // Forward the harness's declared postures (§13.1) so the engine can
    // select the expected run_outcome where the spec permits both.
    // `on_error` is the harness document's default failure posture
    // (§6.3), what a claim states; a vector's own document may set
    // its own.
    rr.postures
        .insert("tool_seam_host_error".to_owned(), posture);
    rr.postures.insert("on_error".to_owned(), on_error);

    let recorded = recorded.lock().expect("recorder poisoned").clone();
    assert_vector(vector, &recorded, &rr)
}

// ---- reference harness ------------------------------------------------------

/// Minimal conformant in-memory agent loop; the CTK self-test target.
///
/// Every emitter it builds goes through the host declaration loader
/// (§7.7): for a field-based vector it writes the vector's mode,
/// composition and provider into a copy of its own document
/// (`ctk/reference.declaration.json`) and binds the scripted
/// interceptors through a `ctk.instance` kind, so the 51 field-based
/// vectors exercise the loader too.
#[derive(Default)]
pub struct ReferenceHarness {
    scenario: Value,
    emitter: Option<InterceptionEmitter>,
    builder: Option<AgentContextBuilder>,
    tool_log: Vec<Value>,
    session_counter: u64,
    /// §6.3: what this host told its principal (the agent) during the
    /// session, verbatim and in order. The reference agent has no
    /// user; its host-message channel is this log, reported as
    /// `RunRecord.host_messages`.
    host_messages: Arc<Mutex<Vec<String>>>,
}

/// Interceptor instances handed to the `ctk.instance` kind by index.
type InstanceSlots = Arc<Mutex<Vec<Option<Box<dyn Interceptor>>>>>;

/// The reference harness's own declaration (§7.7.9), with an explicit
/// surface a claim can cite.
pub const REFERENCE_DECLARATION: &str = include_str!("ctk/reference.declaration.json");

impl ReferenceHarness {
    pub fn new() -> Self {
        Self::default()
    }

    fn document() -> Value {
        serde_json::from_str(REFERENCE_DECLARATION).expect("reference declaration parses")
    }

    /// The principal channel this host registers (§6.3): every
    /// control-failure notice is delivered to the agent as a host
    /// message and kept for the run record.
    fn with_principal_channel(&self, registry: HostRegistry) -> HostRegistry {
        let log = Arc::clone(&self.host_messages);
        registry.control_failure_notifier(move |n| {
            log.lock()
                .expect("host messages poisoned")
                .push(n.message.clone());
        })
    }

    fn start_session(&mut self, scenario: Value, emitter: InterceptionEmitter) {
        self.scenario = scenario;
        self.tool_log.clear();
        self.host_messages
            .lock()
            .expect("host messages poisoned")
            .clear();
        self.session_counter += 1;
        self.emitter = Some(emitter);
        self.builder = Some(AgentContextBuilder::new(
            "ref-agent",
            "reference-agent",
            &format!("sess-{}", self.session_counter),
        ));
    }

    fn invoke_tool(&self, name: &str, args: &Value) -> (Value, bool) {
        let tools = self.scenario["tools"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let spec = tools
            .iter()
            .find(|t| t["name"].as_str() == Some(name))
            .unwrap_or_else(|| panic!("tool {name} not in scenario"));
        for behavior in spec["behavior"].as_array().into_iter().flatten() {
            let matched = match behavior.get("when_args") {
                None => true,
                Some(w) => w == args,
            };
            if matched {
                return (
                    behavior["return"].clone(),
                    behavior
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                );
            }
        }
        panic!("tool {name} invoked with {args}: no matching behavior");
    }

    /// The agent loop proper; a block verdict unwinds via `Err`.
    async fn run_inner(&mut self) -> Result<Value, InterceptionBlocked> {
        let scenario = self.scenario.clone();
        let mut final_output = Value::Null;

        let mut tool_names: Vec<String> = scenario["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| t["name"].as_str().map(str::to_owned))
            .collect();
        tool_names.sort();

        let mut ctx = self
            .builder
            .as_mut()
            .expect("setup")
            .agent_startup(tool_names);
        self.emitter.as_mut().expect("setup").emit(&mut ctx).await?;

        let input = &scenario["input"];
        let content = input["content"].clone();
        let role = input["role"].as_str().unwrap_or("user").to_owned();
        let mut ctx = self
            .builder
            .as_mut()
            .expect("setup")
            .input(content.clone(), &role);
        self.emitter.as_mut().expect("setup").emit(&mut ctx).await?;

        let mut messages = vec![json!({ "role": role, "content": content })];

        for step in scenario["model_script"].as_array().into_iter().flatten() {
            let resp = &step["respond"];

            let mut ctx = self
                .builder
                .as_mut()
                .expect("setup")
                .pre_model_call("mock", messages.clone());
            self.emitter.as_mut().expect("setup").emit(&mut ctx).await?;
            // may be transformed (§4.3)
            messages = ctx["messages"].as_array().cloned().unwrap_or(messages);

            let tool_calls = resp["tool_calls"].as_array().cloned().unwrap_or_default();
            let mut ctx = self.builder.as_mut().expect("setup").post_model_call(
                "mock",
                resp["content"].clone(),
                tool_calls.clone(),
                resp["finish_reason"].as_str().unwrap_or(""),
            );
            self.emitter.as_mut().expect("setup").emit(&mut ctx).await?;

            if tool_calls.is_empty() {
                final_output = resp["content"].clone();
                break;
            }
            for tc in &tool_calls {
                match self.do_tool_call(tc).await {
                    Ok(tool_msg) => messages.push(tool_msg),
                    Err(blocked) => messages.push(json!({
                        "role": "tool",
                        "content": format!(
                            "blocked: {}",
                            blocked.record.verdict.reason.as_deref().unwrap_or("")
                        ),
                    })),
                }
            }
            let assistant_content = if resp["content"].is_null() {
                json!("")
            } else {
                resp["content"].clone()
            };
            messages.push(json!({ "role": "assistant", "content": assistant_content }));
        }

        if !final_output.is_null() {
            let mut ctx = self.builder.as_mut().expect("setup").output(final_output);
            self.emitter.as_mut().expect("setup").emit(&mut ctx).await?;
            final_output = ctx["output"]["content"].clone();
        }
        Ok(final_output)
    }

    async fn do_tool_call(&mut self, tc: &Value) -> Result<Value, InterceptionBlocked> {
        let id = tc["id"].as_str().unwrap_or("").to_owned();
        let name = tc["name"].as_str().unwrap_or("").to_owned();
        let mut ctx =
            self.builder
                .as_mut()
                .expect("setup")
                .pre_tool_call(&id, &name, tc["args"].clone());
        self.emitter.as_mut().expect("setup").emit(&mut ctx).await?;
        let args = ctx["tool_call"]["args"].clone(); // post-transform (§4.3)

        let (value, is_error) = self.invoke_tool(&name, &args);
        self.tool_log.push(json!({ "name": name, "args": args }));

        let mut ctx = self.builder.as_mut().expect("setup").post_tool_call(
            &id,
            &name,
            args,
            value.clone(),
            is_error,
        );
        self.emitter.as_mut().expect("setup").emit(&mut ctx).await?;
        Ok(json!({ "role": "tool", "content": value }))
    }
}

#[async_trait]
impl Harness for ReferenceHarness {
    fn name(&self) -> &str {
        "reference-agent"
    }

    fn capabilities(&self) -> Vec<String> {
        // bigint_json is NOT claimed: serde_json coerces beyond-u64
        // vector literals to f64 at load, so this harness cannot even
        // present such a context faithfully (the core's raw-text scan
        // is exercised by unit tests instead).
        // int64_json: Rust holds i64, so vectors carrying >2^53
        // integers load losslessly (§4.4; JS harnesses omit this).
        // host_declaration: every emitter is built through the loader.
        vec![
            "model_calls".into(),
            "tool_calls".into(),
            "int64_json".into(),
            "host_declaration".into(),
        ]
    }

    fn host_surface(&self) -> HostSurface {
        HostSurface::from_capabilities(self.capabilities(), ToolSeamPosture::Continue)
    }

    fn declaration(&self) -> Option<Value> {
        Some(Self::document())
    }

    fn setup(&mut self, setup: VectorSetup) {
        // Field-based vector: write the vector's configuration into a
        // copy of the reference document and bind the interceptors by
        // index through the `ctk.instance` kind.
        let mut doc = Self::document();
        let cfg = doc["configuration"]
            .as_object_mut()
            .expect("configuration object");
        cfg.insert(
            "mode".into(),
            Value::String(
                match setup.mode {
                    EnforcementMode::Enforce => "enforce",
                    EnforcementMode::EvaluateOnly => "evaluate_only",
                }
                .into(),
            ),
        );
        cfg.insert(
            "composition".into(),
            serde_json::to_value(setup.composition).expect("composition serializes"),
        );
        let mut registry = HostRegistry::for_conformance(self.host_surface());
        let provider = match setup.identity_provider {
            IdentityProvider::JcsSha256 => Value::String(crate::JCS_SHA256.into()),
            IdentityProvider::Null => Value::Null,
            IdentityProvider::Custom { name, f } => {
                registry = registry
                    .identity_provider(&name, f)
                    .expect("CTK provider names are valid by construction");
                Value::String(name)
            }
        };
        cfg.insert("identity_provider".into(), provider);
        let mut approval = Map::new();
        approval.insert(
            "resolver".into(),
            match setup.resolver {
                Some(r) => {
                    registry = registry
                        .approval_resolver("ctk-scripted", r)
                        .expect("ctk-scripted satisfies the name rules");
                    Value::String("ctk-scripted".into())
                }
                None => Value::Null,
            },
        );
        approval.insert(
            "redactor".into(),
            if setup.redact_for_approval.is_empty() {
                Value::Null
            } else {
                let paths = setup.redact_for_approval;
                registry = registry
                    .approval_redactor("ctk-redact", move |ctx| redact_paths(ctx, &paths))
                    .expect("ctk-redact satisfies the name rules");
                Value::String("ctk-redact".into())
            },
        );
        cfg.insert("approval".into(), Value::Object(approval));

        let slots: InstanceSlots = Arc::new(Mutex::new(
            setup.interceptors.into_iter().map(Some).collect(),
        ));
        let n = slots.lock().expect("slots").len();
        let instance: KindResolver = Box::new(move |config, ctx| {
            let i = config
                .get("index")
                .and_then(Value::as_u64)
                .ok_or_else(|| "config.index must be an unsigned integer".to_owned())?
                as usize;
            slots
                .lock()
                .expect("slots")
                .get_mut(i)
                .and_then(Option::take)
                .ok_or_else(|| format!("no interceptor instance {i} for binding {}", ctx.id))
        });
        registry = self.with_principal_channel(
            registry
                .kind("ctk.instance", instance)
                .expect("ctk kinds are valid by construction"),
        );
        doc["bindings"] = Value::Array(
            (0..n)
                .map(|i| {
                    json!({
                        "id": format!("interceptor-{i}"),
                        "kind": "ctk.instance",
                        "config": { "index": i }
                    })
                })
                .collect(),
        );
        let emitter = InterceptionEmitter::from_declaration_value(doc, &registry)
            .unwrap_or_else(|e| panic!("reference declaration refused: {e}"));
        self.start_session(setup.scenario, emitter);
    }

    fn setup_declared(
        &mut self,
        setup: VectorSetup,
        document: Value,
        registry: HostRegistry,
    ) -> Result<(), DeclarationError> {
        let registry = self.with_principal_channel(registry);
        let emitter = InterceptionEmitter::from_declaration_value(document, &registry)?;
        self.start_session(setup.scenario, emitter);
        Ok(())
    }

    async fn run(&mut self) -> RunRecord {
        let (outcome, final_output) = match self.run_inner().await {
            Ok(v) => ("completed", v),
            Err(_) => ("blocked", Value::Null),
        };

        let mut ctx =
            self.builder
                .as_mut()
                .expect("setup")
                .agent_shutdown(if outcome == "completed" {
                    "completed"
                } else {
                    "error"
                });
        let emitter = self.emitter.as_mut().expect("setup");
        emitter.emit_unchecked(&mut ctx).await;

        RunRecord {
            outcome: outcome.to_owned(),
            final_output,
            tool_invocations: self.tool_log.clone(),
            error: None,
            identities: emitter
                .records()
                .iter()
                .map(|r| IdentityPair {
                    input_identity: r.input_identity.clone(),
                    enforced_identity: r.enforced_identity.clone(),
                })
                .collect(),
            records: emitter
                .records()
                .iter()
                .map(|r| serde_json::to_value(r).expect("record serializes"))
                .collect(),
            // The runner overwrites this from the Harness declaration.
            postures: Default::default(),
            load: None,
            host_messages: self
                .host_messages
                .lock()
                .expect("host messages poisoned")
                .clone(),
        }
    }

    fn teardown(&mut self) {
        self.emitter = None;
        self.builder = None;
    }
}
