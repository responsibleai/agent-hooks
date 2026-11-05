// Copyright (c) Microsoft. All rights reserved.

//! §11 registry consistency: the `host_error:*` strings the core emits
//! MUST be exactly the set enumerated in `reserved-reasons.json` of
//! every specification bundle this build supports. Guards the
//! machine-readable registry against silent drift in either direction
//! (a variant added without registering it, or a registry entry with
//! no emitting code). The released bundles gate; the draft's inventories
//! are checked by the `draft_only_*` tests, which the advisory job runs.

use agent_hooks::{HostError, SpecVersion};
use std::collections::BTreeSet;

mod common;
use common::{spec_file, spec_path};

fn emitted_host_errors() -> BTreeSet<String> {
    // Every variant, in declaration order. A new variant must be added
    // here AND to the draft bundle's reserved-reasons.json; this test is
    // the tripwire. 0.1 is frozen, so a new variant that 0.1 does not
    // list must only be emitted under the draft.
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
    emitted
}

fn host_error_variants_match_registry_of(spec: SpecVersion) {
    let registry: serde_json::Value =
        serde_json::from_str(&spec_file(spec, "reserved-reasons.json"))
            .expect("reserved-reasons.json parses");
    let registered: BTreeSet<String> = registry["reasons"]
        .as_array()
        .expect("reasons array")
        .iter()
        .map(|r| r["id"].as_str().expect("reason id").to_owned())
        .collect();
    assert_eq!(
        emitted_host_errors(),
        registered,
        "core HostError strings and {}/reserved-reasons.json diverged",
        spec.bundle_dir()
    );
}

#[test]
fn host_error_variants_match_reserved_reasons_registry() {
    for spec in SpecVersion::RELEASED {
        host_error_variants_match_registry_of(*spec);
    }
}

#[test]
fn draft_only_host_error_variants_match_reserved_reasons_registry() {
    host_error_variants_match_registry_of(SpecVersion::Draft);
}

/// §6.3: a released version without the failure posture has no
/// warnings inventory, and the core reserves `host_warning:*` under the
/// draft only.
#[test]
fn released_bundles_reserve_no_warnings() {
    for spec in SpecVersion::RELEASED {
        assert!(
            !spec_path(*spec, "reserved-warnings.json").exists(),
            "{}: carries reserved-warnings.json",
            spec.bundle_dir()
        );
        assert!(!spec.reserves_host_warnings(), "{spec}");
    }
}

/// §6.3 registry consistency: the `host_warning:*` strings the core
/// emits MUST be exactly the set in the draft's `reserved-warnings.json`.
#[test]
fn draft_only_host_warning_variants_match_reserved_warnings_registry() {
    assert!(SpecVersion::Draft.reserves_host_warnings());
    let variants = [agent_hooks::HostWarning::ControlFailed];
    let emitted: BTreeSet<String> = variants.iter().map(|v| v.to_string()).collect();
    let registry: serde_json::Value =
        serde_json::from_str(&spec_file(SpecVersion::Draft, "reserved-warnings.json"))
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
