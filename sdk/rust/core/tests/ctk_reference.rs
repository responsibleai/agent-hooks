// Copyright (c) Microsoft. All rights reserved.

//! CTK self-test: the vectors against the Rust ReferenceHarness. The
//! gating run is under 0.1, the newest released version: the released
//! set runs and the draft-only vectors (`introduced_in: draft`) are
//! skipped. The `draft_only_*` test runs those under the draft in the
//! advisory job. Binding tests to a draft revision is #188.
#![cfg(feature = "ctk")]

use agent_hooks::ctk::{
    conformance_report, load_vectors, run_vector, ReferenceHarness, DRAFT_NOT_CLAIMABLE,
    DRAFT_ONLY_SKIP,
};
use agent_hooks::SpecVersion;
use serde_json::Value;

const VECTORS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../conformance/vectors");

/// Pinned capability skips: Rust holds i64 (int64_json) but serde_json
/// coerces beyond-u64 vector literals at load (no bigint_json), and the
/// reference harness buffers caller-bound output, so it does not
/// declare incremental_output and skips the streaming/incremental part
/// (§12.1 exception). Exact ids, not a count: the parity gate must fail
/// when the skip set drifts in either direction.
const CAPABILITY_SKIPS: &[&str] = &[
    "AH-CTK-091",
    "AH-CTK-110",
    "AH-CTK-111",
    "AH-CTK-112",
    "AH-CTK-113",
];

fn draft_only(vector: &Value) -> bool {
    vector.get("introduced_in").and_then(Value::as_str) == Some("draft")
}

#[test]
fn reference_declaration_uses_released_specification() {
    let document: serde_json::Value =
        serde_json::from_str(REFERENCE_DECLARATION).expect("reference declaration");
    assert_eq!(CTK_SPEC, SpecVersion::V0_1);
    assert_eq!(document["spec"], CTK_SPEC.wire());
    assert_eq!(document["declaration"], "agent-hooks-declaration/1.0");
    assert_eq!(
        document["surface"]["declaration_versions"],
        serde_json::json!(["agent-hooks-declaration/1.0"])
    );
}

#[tokio::test]
async fn ctk_reference_released_set_under_0_1() {
    let vectors = load_vectors(VECTORS).expect("load vectors");
    assert!(
        vectors.len() >= 30,
        "expected >=30 vectors, got {}",
        vectors.len()
    );
    let mut unexpected: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut draft_skipped: Vec<String> = Vec::new();
    let mut results = Vec::new();
    for vector in &vectors {
        let mut harness = ReferenceHarness::new(SpecVersion::V0_1);
        let result = run_vector(&mut harness, vector).await;
        if result.status == "skip" && result.detail == DRAFT_ONLY_SKIP {
            draft_skipped.push(result.id.clone());
        } else if result.status == "skip" {
            skipped.push(result.id.clone());
        } else if result.status != "pass" {
            unexpected.push(format!("{}: {:?}", result.id, result.failures));
        }
        results.push(result);
    }
    assert!(unexpected.is_empty(), "{unexpected:#?}");
    skipped.sort();
    let skipped: Vec<&str> = skipped.iter().map(String::as_str).collect();
    assert_eq!(skipped, CAPABILITY_SKIPS, "capability skip set drifted");
    // Every draft-only vector is skipped under 0.1, and nothing else is.
    let mut expected_draft: Vec<String> = vectors
        .iter()
        .filter(|v| draft_only(v))
        .map(|v| v["id"].as_str().unwrap().to_owned())
        .collect();
    expected_draft.sort();
    draft_skipped.sort();
    assert_eq!(draft_skipped, expected_draft, "draft-only skip set drifted");
    assert_eq!(draft_skipped.len(), 17);
    // The run is development against the working test set; a report
    // names a released version and never the draft.
    assert_eq!(
        conformance_report(SpecVersion::Draft, &results).unwrap_err(),
        DRAFT_NOT_CLAIMABLE
    );
    let report = conformance_report(SpecVersion::V0_1, &results).expect("report under 0.1");
    assert_eq!(report.spec, "agent-hooks/0.1");
    assert_eq!(report.failed, 0);
    assert_eq!(report.skipped, CAPABILITY_SKIPS.len() + draft_skipped.len());
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
}

/// Advisory (the draft-tests job): the working test set for the next
/// version passes under the draft.
#[tokio::test]
async fn draft_only_vectors_pass_under_the_draft() {
    let vectors = load_vectors(VECTORS).expect("load vectors");
    let draft: Vec<&Value> = vectors.iter().filter(|v| draft_only(v)).collect();
    assert_eq!(draft.len(), 17);
    let mut failures: Vec<String> = Vec::new();
    for vector in draft {
        let mut harness = ReferenceHarness::new(SpecVersion::Draft);
        let result = run_vector(&mut harness, vector).await;
        if result.status != "pass" {
            failures.push(format!(
                "{}: {} {} {:?}",
                result.id, result.status, result.detail, result.failures
            ));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
