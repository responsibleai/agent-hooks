// Copyright (c) Microsoft. All rights reserved.

//! CTK self-test: run all vectors against the Rust ReferenceHarness.
#![cfg(feature = "ctk")]

use agent_hooks::ctk::{
    conformance_report, load_vectors, run_vector, ReferenceHarness, DRAFT_NOT_CLAIMABLE,
};
use agent_hooks::SpecVersion;

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
    let mut results = Vec::new();
    for vector in &vectors {
        let mut harness = ReferenceHarness::new();
        let result = run_vector(&mut harness, vector).await;
        if result.status == "skip" {
            skipped.push(result.id.clone());
        } else if result.status != "pass" {
            unexpected.push(format!("{}: {:?}", result.id, result.failures));
        }
        results.push(result);
    }
    assert!(unexpected.is_empty(), "{unexpected:#?}");
    // The run is development against the working test set; a report
    // names a released version and never the draft.
    assert_eq!(
        conformance_report(SpecVersion::Draft, &results).unwrap_err(),
        DRAFT_NOT_CLAIMABLE
    );
    let report = conformance_report(SpecVersion::V0_1, &results).expect("report under 0.1");
    assert_eq!(report.spec, "agent-hooks/0.1");
    assert_eq!(report.failed, 0);
    assert_eq!(report.skipped, 5);
    assert_eq!(report.passed + report.skipped, vectors.len());
    let names: Vec<&str> = report.parts.iter().map(|p| p.part.as_str()).collect();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    assert_eq!(names, sorted, "parts in name order");
    for part in &report.parts {
        assert_eq!(part.passed + part.failed + part.skipped, part.vectors.len());
    }
    let streaming = report
        .parts
        .iter()
        .find(|p| p.part == "streaming/incremental")
        .expect("streaming/incremental part");
    assert_eq!(streaming.skipped, 4);
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
