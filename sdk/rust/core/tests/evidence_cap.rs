// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! §5.3 evidence cap at the public surface. A consumer measures
//! `canonical_json(evidence).len()` against `EVIDENCE_MAX_BYTES` before
//! validation, so the root re-export must be the exact bound
//! `Verdict::validate` enforces: the same measurement at the cap passes
//! and one byte over fails.

use agent_hooks::{canonical_json, Evidence, HostError, Verdict, EVIDENCE_MAX_BYTES};

/// An allow verdict whose evidence is one artefact string of `len` bytes.
fn with_artefact(len: usize) -> Verdict {
    Verdict {
        evidence: Some(Evidence {
            artefact: Some("x".repeat(len)),
            ..Default::default()
        }),
        ..Verdict::allow()
    }
}

/// The measurement a consumer makes: canonical bytes of the evidence member.
fn canonical_len(v: &Verdict) -> usize {
    let e = v.evidence.as_ref().expect("evidence present");
    canonical_json(&serde_json::to_value(e).expect("evidence serializes")).len()
}

#[test]
fn root_export_is_the_spec_value() {
    // spec/AGENT-HOOKS-0.1.md §5.3: "MUST NOT exceed 10240 bytes".
    assert_eq!(EVIDENCE_MAX_BYTES, 10240);
}

#[test]
fn root_export_is_the_bound_validate_enforces() {
    // Framing bytes of the canonical form {"artefact":"..."} with an
    // empty string, so the artefact length that lands exactly on the
    // cap is derived rather than hard-coded.
    let framing = canonical_len(&with_artefact(0));

    let at_cap = with_artefact(EVIDENCE_MAX_BYTES - framing);
    assert_eq!(canonical_len(&at_cap), EVIDENCE_MAX_BYTES);
    assert_eq!(at_cap.validate(), Ok(()));

    let over = with_artefact(EVIDENCE_MAX_BYTES - framing + 1);
    assert_eq!(canonical_len(&over), EVIDENCE_MAX_BYTES + 1);
    assert_eq!(over.validate(), Err(HostError::VerdictInvalid));
}
