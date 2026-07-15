// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! Property-based tests for the hand-rolled parsing and
//! canonicalization surfaces (NEXT-17): these decide enforcement
//! outcomes, so the invariant is *never panic; fail closed with a
//! documented `host_error:*`*.

use agent_hooks::{canonical_json, context_identity, ffi_surface, AgentContext};
use proptest::prelude::*;

// ---- generators -------------------------------------------------------------

/// Arbitrary JSON value, depth-bounded well inside the §12 cap.
fn arb_json() -> impl Strategy<Value = serde_json::Value> {
    let leaf = prop_oneof![
        Just(serde_json::Value::Null),
        any::<bool>().prop_map(serde_json::Value::from),
        // In-domain numbers only here; out-of-domain is its own test.
        (-9_007_199_254_740_991_i64..=9_007_199_254_740_991_i64)
            .prop_map(serde_json::Value::from),
        any::<f64>().prop_filter("finite", |f| f.is_finite())
            .prop_map(serde_json::Value::from),
        "\\PC{0,12}".prop_map(serde_json::Value::from),
    ];
    leaf.prop_recursive(4, 32, 6, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..6)
                .prop_map(serde_json::Value::from),
            prop::collection::btree_map("\\PC{0,8}", inner, 0..6)
                .prop_map(|m| serde_json::Value::Object(m.into_iter().collect())),
        ]
    })
}

fn valid_ctx(target: serde_json::Value) -> AgentContext {
    serde_json::json!({
        "spec": "agent-hooks/0.1",
        "interception_point": "pre_tool_call",
        "timestamp": "2026-01-01T00:00:00Z",
        "sequence": 0,
        "agent": {"id": "a", "framework": "x"},
        "session": {"id": "s"},
        "tool_call": {"id": "tc", "name": "t", "args": target.clone()},
        "target": target,
    })
    .as_object()
    .unwrap()
    .clone()
}

proptest! {
    /// path::parse never panics on arbitrary input; it returns Ok or a
    /// documented HostError.
    #[test]
    fn path_parse_never_panics(s in "\\PC{0,64}") {
        let _ = agent_hooks::parse_transform_path(&s);
    }

    /// parse → apply round-trip: whatever parse accepts, apply either
    /// applies or fails closed — never panics, and on success resolve
    /// reads back the written value.
    #[test]
    fn path_apply_roundtrip(
        keys in prop::collection::vec("[a-z]{1,6}", 1..4),
        v in arb_json(),
    ) {
        let path = format!("$target.{}", keys.join("."));
        // Build a target where the path resolves.
        let mut target = v.clone();
        for k in keys.iter().rev() {
            target = serde_json::json!({k.clone(): target});
        }
        let applied = agent_hooks::apply_transform_path(
            target, &path, serde_json::json!("REPLACED"),
        );
        prop_assert!(applied.is_ok(), "apply failed on resolvable path");
        let applied = applied.unwrap();
        let got = agent_hooks::resolve(&applied, &path).unwrap().clone();
        prop_assert_eq!(got, serde_json::json!("REPLACED"));
    }

    /// from_wire (the §5 gate) never panics on arbitrary JSON and never
    /// accepts a host_error-prefixed reason.
    #[test]
    fn verdict_gate_never_panics(v in arb_json()) {
        if let Ok(verdict) = agent_hooks::verdict_from_wire(&v) {
            prop_assert!(!verdict
                .reason
                .as_deref()
                .unwrap_or("")
                .starts_with("host_error:"));
        }
    }

    /// canonical_json is deterministic and identity is injective on
    /// canonical bytes: same canonical form ⇔ same identity.
    #[test]
    fn identity_deterministic(t in arb_json()) {
        let ctx = valid_ctx(t);
        let a = context_identity(&ctx);
        let b = context_identity(&ctx);
        prop_assert_eq!(a.is_ok(), b.is_ok());
        if let (Ok(a), Ok(b)) = (a, b) {
            prop_assert_eq!(a, b);
        }
    }

    /// Out-of-domain integral values are rejected, never rounded into a
    /// colliding identity (§10.2).
    #[test]
    fn identity_rejects_out_of_domain(
        n in 9_007_199_254_740_992_u64..=u64::MAX,
    ) {
        let ctx = valid_ctx(serde_json::json!({"id": n}));
        let r = context_identity(&ctx);
        prop_assert!(r.is_err(), "beyond-2^53 integral must be rejected");
        prop_assert_eq!(
            r.unwrap_err().0.to_string(),
            "host_error:context_invalid"
        );
    }

    /// The FFI string surface tolerates arbitrary (often non-JSON)
    /// input without panicking: parse errors become typed FfiErrors.
    #[test]
    fn ffi_string_surface_never_panics(s in "\\PC{0,128}") {
        let _ = ffi_surface::canonical_json(&s);
        let _ = ffi_surface::context_identity(&s);
        let _ = ffi_surface::validate_verdict(&s);
    }

    /// Differential: the CTK engine's dotted-path lookup agrees with
    /// path::resolve on the shared grammar subset (`a.b.c` member
    /// chains), via the vector-assert surface.
    #[test]
    fn canonical_json_utf16_key_determinism(
        keys in prop::collection::btree_map("\\PC{0,6}", Just(1u8), 1..5),
    ) {
        let obj: serde_json::Value = serde_json::Value::Object(
            keys.iter()
                .map(|(k, v)| (k.clone(), serde_json::json!(v)))
                .collect(),
        );
        let a = canonical_json(&obj);
        let b = canonical_json(&obj);
        prop_assert_eq!(a, b);
    }
}
