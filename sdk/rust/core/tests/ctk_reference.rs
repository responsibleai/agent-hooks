// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! CTK self-test: run all vectors against the Rust ReferenceHarness.
#![cfg(feature = "ctk")]

use agent_hooks::ctk::{load_vectors, run_vector, ReferenceHarness};

#[tokio::test]
async fn ctk_reference_all_vectors() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../conformance/vectors");
    let vectors = load_vectors(dir).expect("load vectors");
    assert!(
        vectors.len() >= 30,
        "expected >=30 vectors, got {}",
        vectors.len()
    );
    let mut unexpected: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for vector in &vectors {
        let mut harness = ReferenceHarness::new();
        let result = run_vector(&mut harness, vector).await;
        if result.status == "skip" {
            skipped.push(result.id.clone());
            continue;
        }
        if result.status != "pass" {
            unexpected.push(format!("{}: {:?}", result.id, result.failures));
        }
    }
    assert!(unexpected.is_empty(), "{unexpected:#?}");
    // Pinned skip manifest: Rust holds i64 (int64_json) but
    // serde_json coerces beyond-u64 vector literals at load (no
    // bigint_json), and the reference harness buffers caller-bound
    // output, so it does not declare incremental_output and skips the
    // streaming/incremental part (§12.1 exception). Exact IDs, not a
    // count: the parity gate must fail when the skip set drifts in
    // either direction.
    skipped.sort();
    assert_eq!(
        skipped,
        vec![
            "AH-CTK-091".to_owned(),
            "AH-CTK-110".to_owned(),
            "AH-CTK-111".to_owned(),
            "AH-CTK-112".to_owned(),
            "AH-CTK-113".to_owned(),
        ],
        "skip set drifted"
    );
}
