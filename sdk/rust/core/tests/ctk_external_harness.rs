// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! An out-of-crate `ctk::Harness` implementor compiles and runs a
//! vector: every type the trait's signatures reference is importable
//! from `agent_hooks::ctk` (§13.2), so third-party hosts can run the
//! corpus under their own adapter name.
#![cfg(feature = "ctk")]

use agent_hooks::ctk::{async_trait, run_vector, Harness, RunRecord, VectorSetup};
use serde_json::json;

/// Deliberately NOT the in-tree ReferenceHarness: a minimal external
/// adapter that emits nothing and reports an empty session.
struct ExternalHarness;

#[async_trait]
impl Harness for ExternalHarness {
    fn name(&self) -> &str {
        "external-compile-proof"
    }

    fn capabilities(&self) -> Vec<String> {
        Vec::new()
    }

    fn setup(&mut self, _setup: VectorSetup) {}

    async fn run(&mut self) -> RunRecord {
        RunRecord {
            outcome: "completed".into(),
            final_output: json!(null),
            tool_invocations: Vec::new(),
            error: None,
            identities: Vec::new(),
            records: Vec::new(),
        }
    }

    fn teardown(&mut self) {}
}

#[tokio::test]
async fn external_harness_runs_a_vector() {
    // A capability-gated vector: the empty capability set skips it,
    // which proves setup/run/teardown wire through without needing a
    // full mock agent here.
    let vector = json!({
        "id": "EXTERNAL-SMOKE",
        "title": "external implementor smoke",
        "part": "harness_seam",
        "capabilities": ["model_calls"],
        "scenario": {},
        "interceptor_scripts": [],
        "expect": {}
    });
    let mut h = ExternalHarness;
    let result = run_vector(&mut h, &vector).await;
    assert_eq!(result.status, "skip");
    assert_eq!(result.id, "EXTERNAL-SMOKE");
}
