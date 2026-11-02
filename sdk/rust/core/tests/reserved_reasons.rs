// Copyright (c) Microsoft. All rights reserved.

//! §11 registry consistency: the `host_error:*` strings the core emits
//! MUST be exactly the set enumerated in `reserved-reasons.json` of the
//! specification bundle the SDKs develop against
//! (`agent_hooks::SPEC_DEV_DIR`). Guards the machine-readable registry
//! against silent drift in either direction (a variant added without
//! registering it, or a registry entry with no emitting code).

use agent_hooks::HostError;
use std::collections::BTreeSet;

/// A file of the development specification bundle, read at test time.
fn spec_file(name: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(agent_hooks::SPEC_DEV_DIR)
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn host_error_variants_match_reserved_reasons_registry() {
    // Every variant, in declaration order. A new variant must be added
    // here AND to the draft bundle's reserved-reasons.json; this test is
    // the tripwire.
    let variants = [
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
        HostError::NoInterceptor,
        HostError::StreamingUnsupported,
    ];
    let emitted: BTreeSet<String> = variants.iter().map(|v| v.to_string()).collect();
    assert_eq!(emitted.len(), variants.len(), "duplicate reason strings");

    let registry: serde_json::Value = serde_json::from_str(&spec_file("reserved-reasons.json"))
        .expect("reserved-reasons.json parses");
    let registered: BTreeSet<String> = registry["reasons"]
        .as_array()
        .expect("reasons array")
        .iter()
        .map(|r| r["id"].as_str().expect("reason id").to_owned())
        .collect();

    assert_eq!(
        emitted, registered,
        "core HostError strings and reserved-reasons.json diverged"
    );
}

/// §6.3 registry consistency: the `host_warning:*` strings the core
/// emits MUST be exactly the set in the bundle's `reserved-warnings.json`.
#[test]
fn host_warning_variants_match_reserved_warnings_registry() {
    let variants = [agent_hooks::HostWarning::ControlFailed];
    let emitted: BTreeSet<String> = variants.iter().map(|v| v.to_string()).collect();
    let registry: serde_json::Value = serde_json::from_str(&spec_file("reserved-warnings.json"))
        .expect("reserved-warnings.json parses");
    let registered: BTreeSet<String> = registry["warnings"]
        .as_array()
        .expect("warnings array")
        .iter()
        .map(|r| r["id"].as_str().expect("warning id").to_owned())
        .collect();
    assert_eq!(
        emitted, registered,
        "core HostWarning strings and reserved-warnings.json diverged"
    );
    // The substituted allow carries exactly one registered warning.
    let v = agent_hooks::Verdict::control_failure_substitute(
        "b",
        agent_hooks::HostError::InterceptorTimeout,
    );
    assert!(registered.contains(v.warnings[0].reason.as_deref().unwrap()));
}
