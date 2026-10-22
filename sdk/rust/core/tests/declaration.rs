// Copyright (c) Microsoft. All rights reserved.

//! Host declaration document (§7.7): the file path, construction-path
//! equivalence at the record level, sealing, per-point bindings, the
//! stamp rule and the cross-SDK golden file.

use agent_hooks::declaration::{
    resolve, HostSurface, KnobSupport, TimeoutSupport, ToolSeamPosture,
};
use agent_hooks::{
    AgentContext, AgentContextBuilder, ApprovalOutcome, ApprovalRequest, ApprovalResolution,
    ApprovalResolver, BindingOptions, CompositionConfig, CompositionProfile, ControlFailureNotice,
    DeclarationError, DeclarationErrorClass, EnforcementMode, HostDeclaration, HostRegistry,
    InterceptionEmitter, InterceptionPoint, Interceptor, KindResolver, ManagedInterceptor,
    ManagedInterceptorOutcome, ManagedKindResolver, OnError, SynthesisPolicy, Verdict,
    DECLARATION_VERSION,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

struct Scripted(Verdict);

#[async_trait]
impl Interceptor for Scripted {
    async fn intercept(&self, _ctx: &AgentContext) -> Verdict {
        self.0.clone()
    }
}

struct Approver;

#[async_trait]
impl ApprovalResolver for Approver {
    async fn resolve(&self, req: ApprovalRequest<'_>) -> ApprovalResolution {
        ApprovalResolution {
            outcome: ApprovalOutcome::Approve,
            context_identity: req.context_identity.clone(),
            verdict: Some(Verdict::allow()),
        }
    }
}

fn surface() -> HostSurface {
    // Equivalence tests compare records, never timing; a bounded
    // surface lets the default timeouts resolve on every build.
    HostSurface::from_capabilities(
        [
            "model_calls".to_owned(),
            "tool_calls".to_owned(),
            "host_declaration".to_owned(),
        ],
        ToolSeamPosture::Continue,
    )
    .assume_timeout_support_for_tests(TimeoutSupport::Bounded)
}

fn verdict_from(config: &Value) -> Result<Box<dyn Interceptor>, String> {
    let decision = config
        .get("decision")
        .and_then(Value::as_str)
        .ok_or_else(|| "config.decision is required".to_owned())?;
    let v = match decision {
        "allow" => Verdict::allow(),
        "deny" => Verdict::deny(Some("test:deny".into()), None),
        "escalate" => Verdict::escalate(Some("test:escalate".into()), None),
        other => return Err(format!("unknown decision {other:?}")),
    };
    Ok(Box::new(Scripted(v)))
}

fn registry() -> HostRegistry {
    let scripted: KindResolver = Box::new(|config, _ctx| verdict_from(config));
    let panicking: KindResolver = Box::new(|_, _| panic!("resolver bug"));
    HostRegistry::new(surface())
        .kind("com.example.scripted", scripted)
        .unwrap()
        .kind("com.example.panics", panicking)
        .unwrap()
        .identity_provider("hmac-sha256-k1", |ctx| {
            format!(
                "mac:{}",
                ctx.get("sequence").and_then(Value::as_i64).unwrap_or(-1)
            )
        })
        .unwrap()
        .approval_resolver("operator-queue", Box::new(Approver))
        .unwrap()
        .approval_redactor("strip-secrets", |ctx| ctx.clone())
        .unwrap()
}

fn document() -> Value {
    json!({
        "declaration": DECLARATION_VERSION,
        "id": "test-doc",
        "configuration": {
            "composition": { "profile": "parallel/strictest" },
            "identity_provider": "hmac-sha256-k1",
            "approval": { "resolver": "operator-queue", "redactor": "strip-secrets" },
            "timeouts": { "interceptor_ms": 2500 },
            "records": { "max_buffered": 3 }
        },
        "bindings": [
            { "id": "a", "kind": "com.example.scripted", "config": { "decision": "allow" } },
            { "id": "b", "kind": "com.example.scripted", "config": { "decision": "escalate" }, "at": ["pre_tool_call"] }
        ]
    })
}

async fn run_session(em: &mut InterceptionEmitter) -> Vec<String> {
    let mut b = AgentContextBuilder::new("a1", "test-host", "s1")
        .with_timestamp_provider(|| "2026-10-09T00:00:00.000Z".to_owned());
    let mut out = Vec::new();
    for mut ctx in [
        b.agent_startup(vec!["http_get".into()]),
        b.input(json!("hi"), "user"),
        b.pre_tool_call("tc-1", "http_get", json!({"url": "https://x"})),
        b.output(json!("done")),
        b.agent_shutdown("completed"),
    ] {
        let rec = em.emit_unchecked(&mut ctx).await;
        out.push(serde_json::to_string(&rec).unwrap());
    }
    out
}

fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "agent-hooks-decl-test-{}-{}-{name}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(&p, bytes).unwrap();
    p
}

#[tokio::test]
async fn three_paths_produce_identical_records() {
    let reg = registry();
    let doc = document();
    let text = serde_json::to_string_pretty(&doc).unwrap();
    let path = temp_file("doc.json", text.as_bytes());

    let mut from_value = InterceptionEmitter::from_declaration_value(doc.clone(), &reg).unwrap();
    let mut from_json = InterceptionEmitter::from_declaration_json(&text, &reg).unwrap();
    let mut from_path = InterceptionEmitter::from_declaration_path(&path, &reg).unwrap();
    let built = HostDeclaration::builder()
        .id("test-doc")
        .composition(CompositionConfig::strictest(SynthesisPolicy::Deny))
        .identity_provider(Some("hmac-sha256-k1"))
        .approval_resolver(Some("operator-queue"))
        .approval_redactor(Some("strip-secrets"))
        .interceptor_timeout_ms(Some(2500))
        .max_buffered_records(Some(3))
        .bind(
            "a",
            "com.example.scripted",
            json!({"decision": "allow"}),
            None,
            None,
        )
        .bind(
            "b",
            "com.example.scripted",
            json!({"decision": "escalate"}),
            Some(&[InterceptionPoint::PreToolCall]),
            None,
        )
        .build()
        .unwrap();
    let mut from_code = InterceptionEmitter::from_declaration(built, &reg).unwrap();
    let _ = std::fs::remove_file(&path);

    let canon = from_value.declaration().unwrap().canonical_json();
    assert_eq!(from_json.declaration().unwrap().canonical_json(), canon);
    assert_eq!(from_path.declaration().unwrap().canonical_json(), canon);
    assert_eq!(from_code.declaration().unwrap().canonical_json(), canon);
    assert!(
        canon.contains("\"on_transform_conflict\":\"deny\""),
        "{canon}"
    );
    assert!(!canon.contains("$schema"));

    let a = run_session(&mut from_value).await;
    let b = run_session(&mut from_json).await;
    let c = run_session(&mut from_path).await;
    let d = run_session(&mut from_code).await;
    assert_eq!(a, b);
    assert_eq!(a, c);
    assert_eq!(a, d);

    // Record stamping (§7.7.8).
    let records: Vec<Value> = a.iter().map(|s| serde_json::from_str(s).unwrap()).collect();
    for r in &records {
        assert_eq!(r["declaration"], DECLARATION_VERSION);
        assert_eq!(r["identity_provider"], "hmac-sha256-k1");
        assert_eq!(r["composition"]["profile"], "parallel/strictest");
        assert_eq!(r["composition"]["on_transform_conflict"], "deny");
        assert!(r["composition"].get("on_approval").is_none());
    }
    // Per-point bindings: `b` runs at pre_tool_call only.
    assert_eq!(records[0]["interceptors_registered"], 1);
    assert_eq!(records[0]["verdicts"][0]["name"], "a");
    assert_eq!(records[2]["interceptors_registered"], 2);
    assert_eq!(records[2]["verdicts"][1]["name"], "b");
    assert_eq!(records[2]["verdicts"][1]["decision"], "deny");
    // The liftable deny was consulted through the referenced resolver.
    assert_eq!(records[2]["resolved_by"], "approval");
    assert_eq!(records[2]["verdict"]["decision"], "allow");
    // records.max_buffered: 3 bounded the buffer.
    assert_eq!(from_value.records().len(), 3);
    assert_eq!(from_value.records_dropped(), 2);
}

#[tokio::test]
async fn code_path_records_carry_no_declaration_and_unchanged_bytes() {
    let mut em = InterceptionEmitter::new(EnforcementMode::Enforce, None);
    em.register(Box::new(Scripted(Verdict::allow())));
    let records = run_session(&mut em).await;
    for s in &records {
        let r: Value = serde_json::from_str(s).unwrap();
        assert!(r.get("declaration").is_none(), "{s}");
        assert!(r["verdicts"][0].get("name").is_none(), "{s}");
        assert!(!s.contains("declaration"), "{s}");
    }
    assert!(em.declaration().is_none());
    // Unnamed, every-point registration still behaves as before.
    let r: Value = serde_json::from_str(&records[2]).unwrap();
    assert_eq!(r["interceptors_registered"], 1);
    assert_eq!(r["verdict"]["decision"], "allow");
}

#[tokio::test]
async fn register_at_filters_points_and_names_verdicts() {
    let mut em = InterceptionEmitter::new(EnforcementMode::Enforce, None);
    em.register_at(
        Box::new(Scripted(Verdict::deny(Some("x:deny".into()), None))),
        Some("gate".into()),
        Some(
            [InterceptionPoint::PreToolCall]
                .into_iter()
                .collect::<BTreeSet<_>>(),
        ),
    );
    em.register_at(
        Box::new(Scripted(Verdict::allow())),
        Some("audit".into()),
        None,
    );
    let records = run_session(&mut em).await;
    let startup: Value = serde_json::from_str(&records[0]).unwrap();
    assert_eq!(startup["interceptors_registered"], 1);
    assert_eq!(startup["verdicts"][0]["name"], "audit");
    assert_eq!(startup["verdict"]["decision"], "allow");
    let tool: Value = serde_json::from_str(&records[2]).unwrap();
    assert_eq!(tool["interceptors_registered"], 2);
    assert_eq!(tool["decided_by"], 0);
    assert_eq!(tool["verdicts"][0]["name"], "gate");
    assert_eq!(tool["verdict"]["decision"], "deny");
    assert_eq!(tool["fold_truncated"], true);
}

#[tokio::test]
async fn point_without_binding_denies_no_interceptor() {
    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "bindings": [{ "id": "a", "kind": "com.example.scripted", "config": { "decision": "allow" }, "at": ["pre_tool_call"] }]
    });
    let mut em = InterceptionEmitter::from_declaration_value(doc, &registry()).unwrap();
    let records = run_session(&mut em).await;
    let startup: Value = serde_json::from_str(&records[0]).unwrap();
    assert_eq!(startup["verdict"]["reason"], "host_error:no_interceptor");
    assert_eq!(startup["interceptors_registered"], 0);
    assert_eq!(startup["declaration"], DECLARATION_VERSION);
    let tool: Value = serde_json::from_str(&records[2]).unwrap();
    assert_eq!(tool["verdict"]["decision"], "allow");
    assert_eq!(tool["interceptors_registered"], 1);
}

#[test]
fn sealed_emitter_refuses_reconfiguration() {
    let mut em = InterceptionEmitter::from_declaration_value(document(), &registry()).unwrap();
    // Allowed after sealing: where records go, not what they say.
    em.set_record_sink(|_| {});
    let _ = em.take_records();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        em.register(Box::new(Scripted(Verdict::allow())));
    }));
    assert!(r.is_err(), "register must panic on a sealed emitter");
    let mut em = InterceptionEmitter::from_declaration_value(document(), &registry()).unwrap();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        em.set_composition(CompositionConfig::default());
    }));
    assert!(r.is_err(), "set_composition must panic on a sealed emitter");
    let mut em = InterceptionEmitter::from_declaration_value(document(), &registry()).unwrap();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        em.set_timeout(std::time::Duration::from_secs(1));
    }));
    assert!(r.is_err(), "set_timeout must panic on a sealed emitter");
}

#[test]
fn binding_rejected_by_error_and_by_panic() {
    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "bindings": [
            { "id": "ok", "kind": "com.example.scripted", "config": { "decision": "allow" } },
            { "id": "bad", "kind": "com.example.scripted", "config": { "decision": "maybe", "secret": "hunter2" } }
        ]
    });
    let e = InterceptionEmitter::from_declaration_value(doc, &registry()).unwrap_err();
    assert_eq!(e.class, DeclarationErrorClass::BindingRejected);
    assert_eq!(e.findings[0].pointer, "/bindings/1");
    assert!(e.findings[0].detail.contains("\"bad\""), "{e}");
    assert!(e.findings[0].detail.contains("com.example.scripted"), "{e}");
    assert!(
        !e.findings[0].detail.contains("hunter2"),
        "loader must not echo config: {e}"
    );

    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "bindings": [{ "id": "boom", "kind": "com.example.panics" }]
    });
    let e = InterceptionEmitter::from_declaration_value(doc, &registry()).unwrap_err();
    assert_eq!(e.class, DeclarationErrorClass::BindingRejected);
    assert!(e.findings[0].detail.contains("panicked"), "{e}");
}

#[test]
fn unreadable_classes_from_path() {
    let reg = registry();
    let class = |p: &std::path::Path| -> DeclarationError {
        InterceptionEmitter::from_declaration_path(p, &reg).unwrap_err()
    };
    let missing = std::env::temp_dir().join("agent-hooks-decl-does-not-exist.json");
    let e = class(&missing);
    assert_eq!(e.class, DeclarationErrorClass::Unreadable);
    assert!(e.findings[0].detail.contains("NotFound"), "{e}");
    let e = class(&std::env::temp_dir());
    assert_eq!(e.class, DeclarationErrorClass::Unreadable);
    assert!(e.findings[0].detail.contains("regular file"), "{e}");
    let big = temp_file("big.json", &vec![b' '; (1 << 20) + 1]);
    let e = class(&big);
    let _ = std::fs::remove_file(&big);
    assert_eq!(e.class, DeclarationErrorClass::Unreadable);
    assert!(e.findings[0].detail.contains("bytes"), "{e}");
    let bad = temp_file("utf8.json", &[b'{', 0xFF, b'}']);
    let e = class(&bad);
    let _ = std::fs::remove_file(&bad);
    assert_eq!(e.class, DeclarationErrorClass::Unreadable);
    assert!(e.findings[0].detail.contains("UTF-8"), "{e}");
    let bom = temp_file("bom.json", b"\xEF\xBB\xBF{}");
    let e = class(&bom);
    let _ = std::fs::remove_file(&bom);
    assert_eq!(e.class, DeclarationErrorClass::Unreadable);
    assert!(e.findings[0].detail.contains("byte-order mark"), "{e}");
    // A readable file with a bad document reaches the later steps.
    let text = temp_file(
        "v.json",
        br#"{"declaration": "agent-hooks-declaration/0.1", "bindings": []}"#,
    );
    let e = class(&text);
    let _ = std::fs::remove_file(&text);
    assert_eq!(e.class, DeclarationErrorClass::VersionUnsupported);
}

#[test]
fn config_integers_stay_inside_the_canonical_domain() {
    // #129: an integer above 2^53 - 1 inside a binding config used to
    // load, and the resolved form then had no RFC 8785 canonical form.
    // Both construction paths refuse it at step 6 with the token's
    // pointer; the bound itself loads and canonicalises.
    let reg = registry();
    let doc = |key: u64| {
        json!({
            "declaration": DECLARATION_VERSION,
            "bindings": [{
                "id": "a",
                "kind": "com.example.scripted",
                "config": { "decision": "allow", "key": key }
            }]
        })
    };
    let at_bound = doc(9_007_199_254_740_991);
    for em in [
        InterceptionEmitter::from_declaration_value(at_bound.clone(), &reg).unwrap(),
        InterceptionEmitter::from_declaration_json(&at_bound.to_string(), &reg).unwrap(),
    ] {
        let canonical = em.declaration().unwrap().canonical_json();
        assert!(
            canonical.contains("\"key\":9007199254740991"),
            "{canonical}"
        );
        // RFC 8785 output: canonicalising it again changes nothing.
        let again: Value = serde_json::from_str(&canonical).unwrap();
        assert_eq!(agent_hooks::canonical_json(&again), canonical);
    }
    let above = doc(9_007_199_254_740_992);
    for e in [
        InterceptionEmitter::from_declaration_value(above.clone(), &reg).unwrap_err(),
        InterceptionEmitter::from_declaration_json(&above.to_string(), &reg).unwrap_err(),
    ] {
        assert_eq!(e.class, DeclarationErrorClass::InvalidField);
        assert_eq!(e.findings.len(), 1);
        assert_eq!(e.findings[0].pointer, "/bindings/0/config/key");
        assert!(!e.findings[0].detail.contains("9007199254740992"));
    }
}

#[test]
fn one_class_per_document_in_pipeline_order() {
    // A document breaking steps 3, 5, 6, 7 and 10 at once reports the
    // earliest step only; fixing each in turn walks the pipeline.
    let reg = registry();
    let mut doc = json!({
        "declaration": "agent-hooks-declaration/0.1",
        "policy": {},
        "configuration": { "mode": "audit", "composition": { "profile": "sequential/run_all", "on_approval": "stop" } },
        "bindings": [{ "id": "x", "kind": "com.example.none" }]
    });
    let class = |d: &Value| {
        InterceptionEmitter::from_declaration_value(d.clone(), &reg)
            .unwrap_err()
            .class
    };
    assert_eq!(class(&doc), DeclarationErrorClass::VersionUnsupported);
    doc["declaration"] = json!(DECLARATION_VERSION);
    assert_eq!(class(&doc), DeclarationErrorClass::UnknownField);
    doc.as_object_mut().unwrap().remove("policy");
    assert_eq!(class(&doc), DeclarationErrorClass::InvalidField);
    doc["configuration"]["mode"] = json!("enforce");
    assert_eq!(class(&doc), DeclarationErrorClass::Inconsistent);
    doc["configuration"]["composition"] = json!({ "profile": "sequential/run_all" });
    assert_eq!(class(&doc), DeclarationErrorClass::KindUnknown);
    doc["bindings"][0]["kind"] = json!("com.example.scripted");
    assert_eq!(class(&doc), DeclarationErrorClass::BindingRejected);
    doc["bindings"][0]["config"] = json!({ "decision": "allow" });
    assert!(InterceptionEmitter::from_declaration_value(doc, &reg).is_ok());
}

#[cfg(feature = "tokio-timeout")]
#[tokio::test]
async fn declared_timeouts_bound_interceptor_and_resolver() {
    struct Slow;
    #[async_trait]
    impl Interceptor for Slow {
        async fn intercept(&self, _ctx: &AgentContext) -> Verdict {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            Verdict::allow()
        }
    }
    struct SlowEscalate;
    #[async_trait]
    impl Interceptor for SlowEscalate {
        async fn intercept(&self, _ctx: &AgentContext) -> Verdict {
            Verdict::escalate(None, None)
        }
    }
    struct SlowResolver;
    #[async_trait]
    impl ApprovalResolver for SlowResolver {
        async fn resolve(&self, req: ApprovalRequest<'_>) -> ApprovalResolution {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            ApprovalResolution {
                outcome: ApprovalOutcome::Approve,
                context_identity: req.context_identity.clone(),
                verdict: Some(Verdict::allow()),
            }
        }
    }
    let slow: KindResolver = Box::new(|_, _| Ok(Box::new(Slow)));
    let esc: KindResolver = Box::new(|_, _| Ok(Box::new(SlowEscalate)));
    let reg = HostRegistry::new(surface())
        .kind("com.example.slow", slow)
        .unwrap()
        .kind("com.example.escalate", esc)
        .unwrap()
        .approval_resolver("slow-queue", Box::new(SlowResolver))
        .unwrap();
    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "configuration": { "timeouts": { "interceptor_ms": 20, "approval_resolver_ms": 20 } },
        "bindings": [{ "id": "slow", "kind": "com.example.slow" }]
    });
    let mut em = InterceptionEmitter::from_declaration_value(doc, &reg).unwrap();
    let mut ctx = AgentContextBuilder::new("a", "h", "s").input(json!("hi"), "user");
    let r = em.emit_unchecked(&mut ctx).await;
    assert_eq!(
        r.verdict.reason.as_deref(),
        Some("host_error:interceptor_timeout")
    );

    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "configuration": {
            "approval": { "resolver": "slow-queue" },
            "timeouts": { "interceptor_ms": 1000, "approval_resolver_ms": 20 }
        },
        "bindings": [{ "id": "esc", "kind": "com.example.escalate" }]
    });
    let mut em = InterceptionEmitter::from_declaration_value(doc, &reg).unwrap();
    let mut ctx = AgentContextBuilder::new("a", "h", "s").input(json!("hi"), "user");
    let r = em.emit_unchecked(&mut ctx).await;
    assert_eq!(
        r.verdict.reason.as_deref(),
        Some("host_error:approval_resolver_failed")
    );
    assert_eq!(r.resolved_by, Some("rejection"));
}

/// `conformance/golden/declaration.json`: documents with their resolved
/// canonical JSON against a fixed surface, asserted byte for byte in
/// every SDK. Set `AH_WRITE_GOLDEN=1` to regenerate from this crate.
#[test]
fn golden_declarations_resolve_byte_for_byte() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../conformance/golden/declaration.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let surface: HostSurface = serde_json::from_value(doc["surface"].clone()).unwrap();
    assert_eq!(surface.interceptor_timeout(), TimeoutSupport::Bounded);
    let names = serde_json::from_value(doc["names"].clone()).unwrap();
    let mut regenerated = doc.clone();
    let mut mismatches = Vec::new();
    for (i, f) in doc["fixtures"].as_array().unwrap().iter().enumerate() {
        let d = HostDeclaration::from_value(f["document"].clone())
            .unwrap_or_else(|e| panic!("{}: {e}", f["id"]));
        let resolved = resolve(&d, &surface, &names).unwrap_or_else(|e| panic!("{}: {e}", f["id"]));
        let canon = resolved.canonical_json();
        regenerated["fixtures"][i]["expect"]["canonical_json"] = Value::String(canon.clone());
        if f["expect"]["canonical_json"] != canon {
            mismatches.push(f["id"].to_string());
        }
    }
    if std::env::var("AH_WRITE_GOLDEN").is_ok() {
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&regenerated).unwrap() + "\n",
        )
        .unwrap();
        return;
    }
    assert!(
        mismatches.is_empty(),
        "canonical_json mismatch for {mismatches:?}"
    );
    // Every profile's knob support appears in the fixed surface.
    for p in CompositionProfile::ALL {
        assert_eq!(surface.profiles[&p], KnobSupport::full(p));
    }
}

// ---- on_error (§6.3, §7.7.5) --------------------------------------------------

struct Panics;

#[async_trait]
impl Interceptor for Panics {
    async fn intercept(&self, _ctx: &AgentContext) -> Verdict {
        panic!("control down");
    }
}

type Notices = Arc<Mutex<Vec<ControlFailureNotice>>>;

/// The test registry plus a `com.example.panics-at-runtime` kind and
/// the principal channel; `None` leaves the channel out.
fn registry_with_notifier(notices: Option<Notices>) -> HostRegistry {
    let failing: KindResolver = Box::new(|_, _| Ok(Box::new(Panics)));
    let reg = registry().kind("com.example.failing", failing).unwrap();
    match notices {
        Some(n) => {
            reg.control_failure_notifier(move |notice| n.lock().unwrap().push(notice.clone()))
        }
        None => reg,
    }
}

fn pre_tool_ctx() -> AgentContext {
    AgentContextBuilder::new("a", "h", "s").pre_tool_call("tc", "t", json!({"url": "x"}))
}

#[tokio::test]
async fn declared_on_error_inherited_and_overridden_per_binding() {
    let notices: Notices = Arc::new(Mutex::new(Vec::new()));
    let reg = registry_with_notifier(Some(notices.clone()));
    // Document default continue; "strict" overrides to deny.
    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "configuration": {
            "composition": { "profile": "sequential/run_all" },
            "failure": { "on_error": "continue" }
        },
        "bindings": [
            { "id": "best-effort", "kind": "com.example.failing" },
            { "id": "allow", "kind": "com.example.scripted", "config": { "decision": "allow" } }
        ]
    });
    let mut em = InterceptionEmitter::from_declaration_value(doc, &reg).unwrap();
    let mut ctx = pre_tool_ctx();
    let r = em.emit_unchecked(&mut ctx).await;
    assert!(r.proceeds());
    assert_eq!(r.declaration.as_deref(), Some(DECLARATION_VERSION));
    assert_eq!(r.verdicts[0].name.as_deref(), Some("best-effort"));
    assert_eq!(
        r.verdicts[0].substituted_for.as_deref(),
        Some("host_error:interceptor_failed")
    );
    assert_eq!(r.verdicts[1].substituted_for, None);
    assert_eq!(
        r.verdict.warnings[0].message.as_deref(),
        Some("best-effort: host_error:interceptor_failed; host continued")
    );
    assert_eq!(notices.lock().unwrap().len(), 1);
    assert_eq!(notices.lock().unwrap()[0].binding, "best-effort");

    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "configuration": { "failure": { "on_error": "continue" } },
        "bindings": [
            { "id": "strict", "kind": "com.example.failing", "on_error": "deny" }
        ]
    });
    let mut em = InterceptionEmitter::from_declaration_value(doc, &reg).unwrap();
    let r = em.emit_unchecked(&mut pre_tool_ctx()).await;
    assert!(!r.proceeds());
    assert_eq!(
        r.verdict.reason.as_deref(),
        Some("host_error:interceptor_failed")
    );
    assert_eq!(r.verdicts[0].substituted_for, None);
    assert_eq!(notices.lock().unwrap().len(), 1, "no new notice");

    // Default absent, binding opts in.
    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "bindings": [
            { "id": "soft", "kind": "com.example.failing", "on_error": "continue" }
        ]
    });
    let mut em = InterceptionEmitter::from_declaration_value(doc, &reg).unwrap();
    let r = em.emit_unchecked(&mut pre_tool_ctx()).await;
    assert!(r.proceeds());
    assert_eq!(
        r.verdicts[0].substituted_for.as_deref(),
        Some("host_error:interceptor_failed")
    );
}

#[tokio::test]
async fn previous_minor_document_keeps_its_meaning() {
    let reg = registry_with_notifier(None);
    let doc = json!({
        "declaration": "agent-hooks-declaration/1.0",
        "bindings": [{ "id": "f", "kind": "com.example.failing" }]
    });
    let mut em = InterceptionEmitter::from_declaration_value(doc, &reg).unwrap();
    assert_eq!(
        em.declaration().unwrap().bindings()[0].on_error,
        OnError::Deny
    );
    let r = em.emit_unchecked(&mut pre_tool_ctx()).await;
    assert!(!r.proceeds());
    assert_eq!(
        r.verdict.reason.as_deref(),
        Some("host_error:interceptor_failed")
    );
    // The record carries the document's own version.
    assert_eq!(
        r.declaration.as_deref(),
        Some("agent-hooks-declaration/1.0")
    );
}

#[test]
fn continue_without_a_notifier_refuses_the_document() {
    // §7.7.6 step 8: the host's code cannot honour the posture, so the
    // class is surface_unsupported and the pointer names the member
    // the document wrote.
    let reg = registry_with_notifier(None);
    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "bindings": [{ "id": "soft", "kind": "com.example.failing", "on_error": "continue" }]
    });
    let e = InterceptionEmitter::from_declaration_value(doc, &reg).unwrap_err();
    assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
    assert_eq!(e.findings[0].pointer, "/bindings/0/on_error");
    assert!(
        e.findings[0].detail.contains("control failure notifier"),
        "{e}"
    );
    // Inherited from the document default: the finding points there.
    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "configuration": { "failure": { "on_error": "continue" } },
        "bindings": [{ "id": "soft", "kind": "com.example.failing" }]
    });
    let e = InterceptionEmitter::from_declaration_value(doc, &reg).unwrap_err();
    assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
    assert_eq!(e.findings[0].pointer, "/configuration/failure/on_error");
    // The binding wrote `continue` itself while the default is also
    // `continue`: the pointer follows the document, not the value.
    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "configuration": { "failure": { "on_error": "continue" } },
        "bindings": [
            { "id": "strict", "kind": "com.example.failing", "on_error": "deny" },
            { "id": "soft", "kind": "com.example.failing", "on_error": "continue" }
        ]
    });
    let e = InterceptionEmitter::from_declaration_value(doc, &reg).unwrap_err();
    assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
    assert_eq!(e.findings.len(), 1);
    assert_eq!(e.findings[0].pointer, "/bindings/1/on_error");
    // Every offending binding is reported, in array order.
    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "configuration": { "failure": { "on_error": "continue" } },
        "bindings": [
            { "id": "a", "kind": "com.example.failing" },
            { "id": "b", "kind": "com.example.failing", "on_error": "continue" }
        ]
    });
    let e = InterceptionEmitter::from_declaration_value(doc, &reg).unwrap_err();
    let pointers: Vec<&str> = e.findings.iter().map(|f| f.pointer.as_str()).collect();
    assert_eq!(
        pointers,
        ["/configuration/failure/on_error", "/bindings/1/on_error"]
    );
    // The check runs before any kind resolver (step 8 before step 11):
    // a resolver that panics in an earlier binding never runs.
    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "bindings": [
            { "id": "first", "kind": "com.example.panics" },
            { "id": "soft", "kind": "com.example.failing", "on_error": "continue" }
        ]
    });
    let e = InterceptionEmitter::from_declaration_value(doc, &reg).unwrap_err();
    assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
    assert_eq!(e.findings[0].pointer, "/bindings/1/on_error");
    // And before the names of steps 9 and 10: an unknown kind in the
    // same document is not what the refusal reports.
    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "bindings": [
            { "id": "soft", "kind": "com.example.failing", "on_error": "continue" },
            { "id": "nobody", "kind": "com.example.unknown" }
        ]
    });
    let e = InterceptionEmitter::from_declaration_value(doc, &reg).unwrap_err();
    assert_eq!(e.class, DeclarationErrorClass::SurfaceUnsupported);
    // Deny needs no channel.
    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "configuration": { "failure": { "on_error": "deny" } },
        "bindings": [{ "id": "f", "kind": "com.example.failing" }]
    });
    assert!(InterceptionEmitter::from_declaration_value(doc, &reg).is_ok());
    // With the channel registered the same documents load.
    let reg = registry_with_notifier(Some(Arc::new(Mutex::new(Vec::new()))));
    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "configuration": { "failure": { "on_error": "continue" } },
        "bindings": [{ "id": "soft", "kind": "com.example.failing" }]
    });
    assert!(InterceptionEmitter::from_declaration_value(doc, &reg).is_ok());
}

#[test]
fn builder_writes_on_error_like_a_file() {
    let built = HostDeclaration::builder()
        .failure_on_error(OnError::Continue)
        .bind_with(
            "strict",
            "com.example.scripted",
            json!({"decision": "allow"}),
            BindingOptions {
                on_error: Some(OnError::Deny),
                ..BindingOptions::default()
            },
        )
        .bind(
            "soft",
            "com.example.scripted",
            json!({"decision": "allow"}),
            None,
            None,
        )
        .build()
        .unwrap();
    assert_eq!(built.version(), DECLARATION_VERSION);
    let parsed = HostDeclaration::from_value(json!({
        "declaration": DECLARATION_VERSION,
        "configuration": { "failure": { "on_error": "continue" } },
        "bindings": [
            { "id": "strict", "kind": "com.example.scripted", "config": {"decision": "allow"}, "on_error": "deny" },
            { "id": "soft", "kind": "com.example.scripted", "config": {"decision": "allow"} }
        ]
    }))
    .unwrap();
    let names = registry().names();
    let a = resolve(&built, &surface(), &names).unwrap();
    let b = resolve(&parsed, &surface(), &names).unwrap();
    assert_eq!(a.canonical_json(), b.canonical_json());
    assert_eq!(a.bindings()[0].on_error, OnError::Deny);
    assert_eq!(a.bindings()[1].on_error, OnError::Continue);
}

#[tokio::test]
async fn managed_kind_receives_the_declared_bound() {
    struct Scanner {
        seen: Arc<Mutex<Option<Option<std::time::Duration>>>>,
    }
    #[async_trait]
    impl ManagedInterceptor for Scanner {
        async fn intercept_managed(
            &self,
            _ctx: &AgentContext,
            bound: Option<std::time::Duration>,
        ) -> ManagedInterceptorOutcome {
            *self.seen.lock().unwrap() = Some(bound);
            ManagedInterceptorOutcome::Timeout
        }
    }
    let seen = Arc::new(Mutex::new(None));
    let seen2 = seen.clone();
    let scanner: ManagedKindResolver = Box::new(move |_, bctx| {
        // The resolver sees the same bound and posture the emitter
        // will apply.
        assert_eq!(bctx.timeout, Some(std::time::Duration::from_millis(250)));
        assert_eq!(bctx.on_error, OnError::Continue);
        Ok(Box::new(Scanner {
            seen: seen2.clone(),
        }))
    });
    let reg = registry()
        .managed_kind("com.example.scanner", scanner)
        .unwrap()
        .control_failure_notifier(|_| {});
    assert!(reg.names().kinds.contains("com.example.scanner"));
    let doc = json!({
        "declaration": DECLARATION_VERSION,
        "bindings": [{
            "id": "scanner", "kind": "com.example.scanner",
            "timeout_ms": 250, "on_error": "continue"
        }]
    });
    let mut em = InterceptionEmitter::from_declaration_value(doc, &reg).unwrap();
    let r = em.emit_unchecked(&mut pre_tool_ctx()).await;
    assert_eq!(
        *seen.lock().unwrap(),
        Some(Some(std::time::Duration::from_millis(250)))
    );
    assert!(r.proceeds());
    assert_eq!(
        r.verdicts[0].substituted_for.as_deref(),
        Some("host_error:interceptor_timeout")
    );
    // One kind name is either managed or standard.
    let dup: KindResolver = Box::new(|_, _| Err("never".into()));
    assert!(reg.kind("com.example.scanner", dup).is_err());
}
