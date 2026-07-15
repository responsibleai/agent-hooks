// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! Conformance Test Kit runner for Rust-native hosts (§13.2).
//!
//! The assertion engine, capability skip check, and scripted
//! interceptor/resolver evaluation live in [`crate::ctk_engine`]; this
//! module is the same thin glue the other SDK runners implement over
//! the FFI — vector globbing, the recording wrapper, and the
//! orchestration loop that drives the native [`Harness`]. The in-tree
//! [`ReferenceHarness`] is the CTK self-test target.

use crate::composition::CompositionConfig;
use crate::ctk_engine::{
    assert_vector, scripted_intercept, scripted_resolve, should_skip, IdentityPair, RunRecord,
    VectorResult,
};
use crate::emitter::{IdentityProvider, InterceptionBlocked, InterceptionEmitter};
use crate::types::{
    AgentContext, ApprovalRequest, ApprovalResolution, ApprovalResolver, EnforcementMode,
    Interceptor, Verdict,
};
use crate::AgentContextBuilder;
use async_trait::async_trait;
use serde_json::{json, Value};
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

#[async_trait]
impl Interceptor for ScriptedInterceptor {
    async fn intercept(&self, context: &AgentContext) -> Verdict {
        let ctx_value = Value::Object(context.clone());
        if let Some(rec) = &self.recorded {
            rec.lock()
                .expect("recorder poisoned")
                .push(ctx_value.clone());
        }
        let wire = scripted_intercept(&self.rules, &ctx_value);
        // §7 isolation fault (TM-05): the trait takes &AgentContext, so
        // in-place mutation is statically impossible in Rust — the
        // isolation the vector probes is the type system itself. Return
        // the same allow the mutating wrappers return.
        if wire.get("__ctk_fault__").and_then(Value::as_str) == Some("mutate") {
            return crate::verdict_from_wire(
                &serde_json::json!({"decision": "allow", "reason": "ctk:mutated"}),
            )
            .expect("static allow shape");
        }
        // The Rust Interceptor trait is infallible (§7), so a scripted
        // fault — "raise" or a §5-malformed shape — maps to the nearest
        // analogue: a verdict that fails the emitter's §5 gate and
        // yields host_error:verdict_invalid (fail closed either way).
        if wire.get("__ctk_fault__").is_some() {
            return invalid_verdict();
        }
        crate::verdict_from_wire(&wire).unwrap_or_else(|_| invalid_verdict())
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
    let mut caps = harness.capabilities();
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
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let interceptors: Vec<Box<dyn Interceptor>> = scripts
        .into_iter()
        .enumerate()
        .map(|(i, rules)| {
            Box::new(ScriptedInterceptor {
                rules,
                recorded: (i == 0).then(|| Arc::clone(&recorded)),
            }) as Box<dyn Interceptor>
        })
        .collect();

    let resolver: Option<Box<dyn ApprovalResolver>> = match vector.get("approval_script") {
        Some(Value::Array(rules)) if !rules.is_empty() => Some(Box::new(ScriptedResolver {
            rules: rules.clone(),
        })),
        _ => None,
    };
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

    let redact_for_approval: Vec<String> = vector
        .get("redact_for_approval")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    harness.setup(VectorSetup {
        scenario: vector["scenario"].clone(),
        interceptors,
        resolver,
        mode,
        composition,
        identity_provider,
        redact_for_approval,
    });
    let rr = harness.run().await;
    harness.teardown();

    let recorded = recorded.lock().expect("recorder poisoned").clone();
    assert_vector(vector, &recorded, &rr)
}

// ---- reference harness ------------------------------------------------------

/// Minimal conformant in-memory agent loop; the CTK self-test target.
#[derive(Default)]
pub struct ReferenceHarness {
    scenario: Value,
    emitter: Option<InterceptionEmitter>,
    builder: Option<AgentContextBuilder>,
    tool_log: Vec<Value>,
    session_counter: u64,
}

impl ReferenceHarness {
    pub fn new() -> Self {
        Self::default()
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
        vec![
            "model_calls".into(),
            "tool_calls".into(),
            "int64_json".into(),
        ]
    }

    fn setup(&mut self, setup: VectorSetup) {
        self.scenario = setup.scenario;
        self.tool_log.clear();
        self.session_counter += 1;
        let mut emitter = InterceptionEmitter::new(setup.mode, setup.resolver);
        emitter.set_composition(setup.composition);
        emitter
            .set_identity_provider(setup.identity_provider)
            .expect("CTK provider names are valid by construction");
        let redact_for_approval = setup.redact_for_approval;
        if !redact_for_approval.is_empty() {
            // §9 redaction seam, CTK convention: each listed path is
            // replaced with "[redacted]" via the §5.2/§4.3 transform
            // machinery; a path that does not resolve at the escalating
            // point is left untouched.
            emitter.set_approval_redactor(move |ctx| {
                let mut c = ctx.clone();
                for path in &redact_for_approval {
                    let t = crate::types::Transform {
                        path: path.clone(),
                        value: Value::String("[redacted]".into()),
                    };
                    let _ = crate::enforce::apply_transform_to_ctx(&mut c, &t);
                }
                c
            });
        }
        for interceptor in setup.interceptors {
            emitter.register(interceptor);
        }
        self.emitter = Some(emitter);
        self.builder = Some(AgentContextBuilder::new(
            "ref-agent",
            "reference-agent",
            &format!("sess-{}", self.session_counter),
        ));
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
        }
    }

    fn teardown(&mut self) {
        self.emitter = None;
        self.builder = None;
    }
}
