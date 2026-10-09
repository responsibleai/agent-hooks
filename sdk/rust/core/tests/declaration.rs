// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! Host declaration document (§7.7): the file path, construction-path
//! equivalence at the record level, sealing, per-point bindings, the
//! stamp rule and the cross-SDK golden file.

use agent_hooks::declaration::{
    resolve, HostSurface, KnobSupport, TimeoutSupport, ToolSeamPosture,
};
use agent_hooks::{
    AgentContext, AgentContextBuilder, ApprovalOutcome, ApprovalRequest, ApprovalResolution,
    ApprovalResolver, CompositionConfig, CompositionProfile, DeclarationError,
    DeclarationErrorClass, EnforcementMode, HostDeclaration, HostRegistry, InterceptionEmitter,
    InterceptionPoint, Interceptor, KindResolver, SynthesisPolicy, Verdict, DECLARATION_VERSION,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::PathBuf;

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
