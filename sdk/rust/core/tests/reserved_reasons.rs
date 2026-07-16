// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! §11 registry consistency: the `host_error:*` strings the core emits
//! MUST be exactly the set enumerated in `spec/reserved-reasons.json`.
//! Guards the machine-readable registry against silent drift in either
//! direction (a variant added without registering it, or a registry
//! entry with no emitting code).

use agent_hooks::HostError;
use std::collections::BTreeSet;

#[test]
fn host_error_variants_match_reserved_reasons_registry() {
    // Every variant, in declaration order. A new variant must be added
    // here AND to spec/reserved-reasons.json — this test is the tripwire.
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

    let registry: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../spec/reserved-reasons.json"
    ))
    .expect("spec/reserved-reasons.json parses");
    let registered: BTreeSet<String> = registry["reasons"]
        .as_array()
        .expect("reasons array")
        .iter()
        .map(|r| r["id"].as_str().expect("reason id").to_owned())
        .collect();

    assert_eq!(
        emitted, registered,
        "core HostError strings and spec/reserved-reasons.json diverged"
    );
}
