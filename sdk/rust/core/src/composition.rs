// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! Composition profiles and aggregation (§7).
//!
//! Composition is **host configuration**, never verdict content
//! (§7.1): the host declares — before dispatch — which profile governs
//! execution and aggregation, and the profile in effect is recorded on
//! every interception record. The profile set is closed (§7.2).
//!
//! The primitives here are pure: `severity` and the aggregation
//! functions consume verdict slices and return indices/outcomes. The
//! per-language emitters (and this crate's [`crate::InterceptionEmitter`])
//! own dispatch, transform application, and the approval seam; every
//! aggregation decision funnels through this module so all five SDKs
//! agree byte for byte.

use crate::types::{Decision, Verdict, VerdictSummary, Warning};
use serde::{Deserialize, Serialize};

/// The closed profile set (§7.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompositionProfile {
    #[serde(rename = "sequential/first_deny")]
    SequentialFirstDeny,
    #[serde(rename = "sequential/run_all")]
    SequentialRunAll,
    #[serde(rename = "parallel/strictest")]
    ParallelStrictest,
    #[serde(rename = "parallel/unanimous")]
    ParallelUnanimous,
}

impl CompositionProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SequentialFirstDeny => "sequential/first_deny",
            Self::SequentialRunAll => "sequential/run_all",
            Self::ParallelStrictest => "parallel/strictest",
            Self::ParallelUnanimous => "parallel/unanimous",
        }
    }

    /// Whether interceptors observe predecessors' transforms (§7.4)
    /// vs. isolated snapshots (§7.5).
    pub fn is_sequential(self) -> bool {
        matches!(self, Self::SequentialFirstDeny | Self::SequentialRunAll)
    }
}

/// `sequential/first_deny` knob (§7.4): what a permit resolution does
/// to the rest of the fold.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnApproval {
    /// The resolution becomes the combined verdict; the emission ends
    /// (`fold_truncated: true`).
    Stop,
    /// The resolution substitutes for the denying interceptor's verdict
    /// and the fold continues.
    Resume,
}

/// `"deny" | "approval"` knob value (§7.5): synthesize a plain deny, or
/// a liftable one and consult the seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SynthesisPolicy {
    Deny,
    Approval,
}

/// The composition profile and knobs in effect for one emission
/// (§7.1, §10.3). Serialized verbatim into the record's `composition`
/// block.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompositionConfig {
    pub profile: CompositionProfile,
    /// `sequential/first_deny` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_approval: Option<OnApproval>,
    /// `parallel/unanimous` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_disagreement: Option<SynthesisPolicy>,
    /// Parallel profiles only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_transform_conflict: Option<SynthesisPolicy>,
}

impl CompositionConfig {
    /// Fill the §7.2 normative knob defaults for the knobs this
    /// profile consults (`on_approval: stop`, synthesis knobs: `deny`)
    /// and clear knobs the profile never reads, so every record
    /// carries the resolved configuration (§7.1, §10.3).
    pub fn with_knob_defaults(mut self) -> Self {
        use CompositionProfile as P;
        match self.profile {
            P::SequentialFirstDeny => {
                self.on_approval.get_or_insert(OnApproval::Stop);
                self.on_disagreement = None;
                self.on_transform_conflict = None;
            }
            P::SequentialRunAll => {
                self.on_approval = None;
                self.on_disagreement = None;
                self.on_transform_conflict = None;
            }
            P::ParallelStrictest => {
                self.on_approval = None;
                self.on_disagreement = None;
                self.on_transform_conflict
                    .get_or_insert(SynthesisPolicy::Deny);
            }
            P::ParallelUnanimous => {
                self.on_approval = None;
                self.on_disagreement.get_or_insert(SynthesisPolicy::Deny);
                self.on_transform_conflict = None;
            }
        }
        self
    }
}

impl Default for CompositionConfig {
    /// Today's pre-P-003 behaviour: `sequential/first_deny` with
    /// `on_approval: stop`. A default, not a conformance baseline —
    /// no profile is mandatory (§7.2, §13.1).
    fn default() -> Self {
        Self {
            profile: CompositionProfile::SequentialFirstDeny,
            on_approval: Some(OnApproval::Stop),
            on_disagreement: None,
            on_transform_conflict: None,
        }
    }
}

impl CompositionConfig {
    pub fn first_deny(on_approval: OnApproval) -> Self {
        Self {
            profile: CompositionProfile::SequentialFirstDeny,
            on_approval: Some(on_approval),
            ..Self::default_bare(CompositionProfile::SequentialFirstDeny)
        }
    }

    pub fn run_all() -> Self {
        Self::default_bare(CompositionProfile::SequentialRunAll)
    }

    pub fn strictest(on_transform_conflict: SynthesisPolicy) -> Self {
        Self {
            on_transform_conflict: Some(on_transform_conflict),
            ..Self::default_bare(CompositionProfile::ParallelStrictest)
        }
    }

    pub fn unanimous(
        on_disagreement: SynthesisPolicy,
        on_transform_conflict: SynthesisPolicy,
    ) -> Self {
        Self {
            on_disagreement: Some(on_disagreement),
            on_transform_conflict: Some(on_transform_conflict),
            ..Self::default_bare(CompositionProfile::ParallelUnanimous)
        }
    }

    fn default_bare(profile: CompositionProfile) -> Self {
        Self {
            profile,
            on_approval: None,
            on_disagreement: None,
            on_transform_conflict: None,
        }
    }
}

/// The §5.1 severity order, fixed by the spec and not host-configurable:
/// `deny > deny+approval > transform > allow`.
pub fn severity(v: &Verdict) -> u8 {
    match (v.decision, v.is_liftable()) {
        (Decision::Deny, false) => 3,
        (Decision::Deny, true) => 2,
        (Decision::Transform, _) => 1,
        (Decision::Allow, _) => 0,
    }
}

/// Outcome of severity-max aggregation (§7.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Aggregate {
    /// The winning verdict's index in the input slice.
    Winner(usize),
    /// ≥2 transforms tied at the top under a parallel profile (§7.5):
    /// transforms produced against the same snapshot do not compose.
    TransformConflict(Vec<usize>),
}

/// Severity-max winner (§7.3). Ties between block verdicts resolve to
/// the lowest index. `sequential`: ties between transforms resolve to
/// the **highest** index — sequential transforms folded through and
/// composed, so the last one reflects the cumulative state (this is
/// the §7.4 fold; the §7.3/§7.5 transform-conflict rule applies only
/// where transforms cannot compose, i.e. parallel snapshots).
pub fn aggregate_strictest(verdicts: &[Verdict], sequential: bool) -> Aggregate {
    debug_assert!(!verdicts.is_empty());
    let max = verdicts.iter().map(severity).max().unwrap_or(0);
    let top: Vec<usize> = verdicts
        .iter()
        .enumerate()
        .filter(|(_, v)| severity(v) == max)
        .map(|(i, _)| i)
        .collect();
    if max == 1 && top.len() >= 2 {
        if sequential {
            Aggregate::Winner(*top.last().expect("non-empty"))
        } else {
            Aggregate::TransformConflict(top)
        }
    } else {
        Aggregate::Winner(top[0])
    }
}

/// `parallel/unanimous` (§7.5): anything but unanimous `allow` is a
/// disagreement.
pub fn is_unanimous_allow(verdicts: &[Verdict]) -> bool {
    verdicts.iter().all(|v| v.decision == Decision::Allow)
}

/// `run_all`/parallel approval precondition (§7.4–§7.5): the seam is
/// consulted only when **every** deny in the emission is liftable — a
/// single plain deny makes lifting pointless.
pub fn all_denies_liftable(verdicts: &[Verdict]) -> bool {
    verdicts
        .iter()
        .filter(|v| v.decision == Decision::Deny)
        .all(Verdict::is_liftable)
}

/// First-seen-ordered union of `warnings` from every verdict (§7.3).
pub fn union_warnings(verdicts: &[Verdict]) -> Vec<Warning> {
    let mut out: Vec<Warning> = Vec::new();
    for v in verdicts {
        for w in &v.warnings {
            if !out.contains(w) {
                out.push(w.clone());
            }
        }
    }
    out
}

/// First-seen-ordered union of `result_labels` from every **permit**
/// verdict (§7.3; §5.4 drops labels when the emission does not proceed).
pub fn union_labels(verdicts: &[Verdict]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for v in verdicts.iter().filter(|v| v.decision.permits()) {
        for l in &v.result_labels {
            if !out.contains(l) {
                out.push(l.clone());
            }
        }
    }
    out
}

/// Payload-free per-interceptor summaries for the record (§10.3).
pub fn summaries(verdicts: &[Verdict]) -> Vec<VerdictSummary> {
    verdicts
        .iter()
        .enumerate()
        .map(|(i, v)| VerdictSummary {
            index: i as u32,
            decision: v.decision,
            reason: v.reason.clone(),
            name: None,
        })
        .collect()
}

/// [`summaries`] with the hosts' payload-free interceptor names
/// attached positionally (§10.3).
pub fn summaries_named(verdicts: &[Verdict], names: &[Option<String>]) -> Vec<VerdictSummary> {
    let mut out = summaries(verdicts);
    for s in &mut out {
        if let Some(n) = names.get(s.index as usize) {
            s.name = n.clone();
        }
    }
    out
}

/// Apply the §7.3 metadata unions to a combined verdict: warnings from
/// every verdict in the pool; labels only onto a permit combination
/// (§5.4 drops labels when the emission does not proceed).
pub fn with_unions(mut combined: Verdict, pool: &[Verdict]) -> Verdict {
    let warnings = union_warnings(pool);
    if !warnings.is_empty() {
        combined.warnings = warnings;
    }
    if combined.decision.permits() {
        let labels = union_labels(pool);
        if !labels.is_empty() {
            combined.result_labels = labels;
        }
    }
    combined
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Transform;
    use serde_json::json;

    fn t() -> Verdict {
        Verdict {
            decision: Decision::Transform,
            transform: Some(Transform {
                path: "$target.x".into(),
                value: json!(1),
            }),
            ..Verdict::allow()
        }
    }

    fn deny() -> Verdict {
        Verdict {
            decision: Decision::Deny,
            ..Verdict::allow()
        }
    }

    #[test]
    fn severity_order() {
        assert_eq!(severity(&deny()), 3);
        assert_eq!(severity(&Verdict::escalate(None, None)), 2);
        assert_eq!(severity(&t()), 1);
        assert_eq!(severity(&Verdict::allow()), 0);
    }

    #[test]
    fn strictest_plain_deny_dominates_liftable() {
        let vs = vec![Verdict::escalate(None, None), deny()];
        assert_eq!(aggregate_strictest(&vs, false), Aggregate::Winner(1));
    }

    #[test]
    fn strictest_block_tie_lowest_index() {
        let vs = vec![deny(), deny()];
        assert_eq!(aggregate_strictest(&vs, false), Aggregate::Winner(0));
    }

    #[test]
    fn parallel_transform_tie_is_conflict() {
        let vs = vec![t(), Verdict::allow(), t()];
        assert_eq!(
            aggregate_strictest(&vs, false),
            Aggregate::TransformConflict(vec![0, 2])
        );
    }

    #[test]
    fn sequential_transform_tie_last_wins() {
        let vs = vec![t(), t()];
        assert_eq!(aggregate_strictest(&vs, true), Aggregate::Winner(1));
    }

    #[test]
    fn unanimous_and_liftable_checks() {
        assert!(is_unanimous_allow(&[Verdict::allow(), Verdict::allow()]));
        assert!(!is_unanimous_allow(&[Verdict::allow(), t()]));
        assert!(all_denies_liftable(&[
            Verdict::escalate(None, None),
            Verdict::allow()
        ]));
        assert!(!all_denies_liftable(&[
            Verdict::escalate(None, None),
            deny()
        ]));
    }

    #[test]
    fn unions_first_seen_order() {
        let mut a = Verdict::warn(Some("w1".into()), None);
        a.result_labels = vec!["l1".into(), "l2".into()];
        let mut b = Verdict::warn(Some("w1".into()), None); // dup warning
        b.result_labels = vec!["l2".into(), "l3".into()];
        let d = Verdict {
            result_labels: vec!["dropped".into()],
            ..deny()
        };
        let all = vec![a, b, d];
        assert_eq!(union_warnings(&all).len(), 1);
        assert_eq!(union_labels(&all), vec!["l1", "l2", "l3"]); // deny's labels dropped
    }

    #[test]
    fn config_wire_names() {
        let c = CompositionConfig::default();
        let j = serde_json::to_value(&c).unwrap();
        assert_eq!(j["profile"], "sequential/first_deny");
        assert_eq!(j["on_approval"], "stop");
        let c: CompositionConfig = serde_json::from_value(json!({
            "profile": "parallel/unanimous",
            "on_disagreement": "approval",
            "on_transform_conflict": "deny"
        }))
        .unwrap();
        assert_eq!(c.profile, CompositionProfile::ParallelUnanimous);
        assert_eq!(c.on_disagreement, Some(SynthesisPolicy::Approval));
    }
}
