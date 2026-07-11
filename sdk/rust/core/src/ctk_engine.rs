// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! CTK engine: scripted interceptor/resolver evaluation and the
//! `expect` assertion pass (§13.2).
//!
//! Language wrappers keep only the `Harness` protocol (native callback
//! into the framework under test) and a thin runner that:
//!
//! 1. Registers an interceptor whose `intercept(ctx)` calls
//!    [`scripted_intercept`] and records the ctx it was given.
//! 2. Registers a resolver whose `resolve(req)` calls
//!    [`scripted_resolve`].
//! 3. Runs the harness.
//! 4. Calls [`assert_vector`] with the recorded contexts and the
//!    harness's `RunRecord`.
//!
//! Everything else — dotted-path lookup, rule matching, sequence
//! checking, per-assertion diffing, required-core context validation — is here so
//! it is identical across bindings.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const IP: &str = "interception_point";
const REQUIRED_FIELDS: &[&str] = &[
    "spec",
    "interception_point",
    "timestamp",
    "sequence",
    "agent",
    "session",
    "target",
];

// ---- dotted-path lookup ----------------------------------------------------

/// Resolve a dotted/bracket path (`a.b[0].c`) against `root`.
fn lookup<'a>(root: &'a Value, dotted: &str) -> Option<&'a Value> {
    let mut cur = root;
    let bytes = dotted.as_bytes();
    let mut i = 0;
    let mut token_start = 0;
    let step = |cur: &'a Value, s: &str| cur.get(s);
    while i <= bytes.len() {
        let ch = if i < bytes.len() { bytes[i] } else { b'.' };
        match ch {
            b'.' => {
                if i > token_start {
                    cur = step(cur, &dotted[token_start..i])?;
                }
                token_start = i + 1;
            }
            b'[' => {
                if i > token_start {
                    cur = step(cur, &dotted[token_start..i])?;
                }
                let j = dotted[i..].find(']')? + i;
                let idx: usize = dotted[i + 1..j].parse().ok()?;
                cur = cur.get(idx)?;
                i = j;
                token_start = j + 1;
            }
            _ => {}
        }
        i += 1;
    }
    Some(cur)
}

fn matches(ctx: &Value, predicates: Option<&Map<String, Value>>) -> bool {
    match predicates {
        None => true,
        Some(m) => m
            .iter()
            .all(|(path, want)| lookup(ctx, path).map(|got| got == want).unwrap_or(false)),
    }
}

// ---- scripted interceptor / resolver --------------------------------------

/// Evaluate a vector's `interceptor_script` against `ctx`. First
/// matching rule wins; unmatched → `{"decision":"allow"}`.
pub fn scripted_intercept(rules: &[Value], ctx: &Value) -> Value {
    let ip = ctx.get(IP).and_then(Value::as_str).unwrap_or("");
    for rule in rules {
        if rule.get("at").and_then(Value::as_str) != Some(ip) {
            continue;
        }
        if matches(ctx, rule.get("match").and_then(Value::as_object)) {
            // NOW-10 fault injection: exercise the §6.3 fail-closed paths.
            match rule.get("fault").and_then(Value::as_str) {
                Some("raise") => return serde_json::json!({"__ctk_fault__": "raise"}),
                // §5-invalid shape: transform decision with no body.
                Some("malformed_verdict") => {
                    return serde_json::json!({"decision": "transform"})
                }
                _ => {}
            }
            return rule
                .get("return")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({"decision": "allow"}));
        }
    }
    serde_json::json!({"decision": "allow"})
}

/// Evaluate a vector's `approval_script` against `ctx` (the
/// `AgentContext` inside the `ApprovalRequest`). Returns
/// `{outcome, context_identity, verdict?}` echoing the supplied identity.
pub fn scripted_resolve(rules: &[Value], ctx: &Value, context_identity: &str) -> Value {
    for rule in rules {
        if matches(ctx, rule.get("match").and_then(Value::as_object)) {
            let r = &rule["resolve"];
            // NOW-10 fault injection.
            if r.get("fault").and_then(Value::as_str) == Some("raise") {
                return serde_json::json!({"__ctk_fault__": "raise"});
            }
            // identity_override exercises §9 approval_identity_mismatch;
            // echo_recomputed pins the §9 redaction rule: the resolver
            // recomputes the jcs-sha256 identity from the request
            // context it actually received, so a host that computed
            // the request identity over a different (unredacted)
            // context fails the echo.
            let recomputed;
            let identity = if r.get("echo_recomputed").and_then(Value::as_bool) == Some(true) {
                recomputed = ctx
                    .as_object()
                    .map(crate::canonical::context_identity)
                    .and_then(Result::ok)
                    .unwrap_or_default();
                recomputed.as_str()
            } else {
                r.get("identity_override")
                    .and_then(Value::as_str)
                    .unwrap_or(context_identity)
            };
            let mut out = serde_json::json!({
                "outcome": r["outcome"],
                "context_identity": identity,
            });
            if let Some(v) = r.get("verdict") {
                out["verdict"] = v.clone();
            }
            return out;
        }
    }
    serde_json::json!({
        "outcome": "unresolved",
        "context_identity": context_identity,
    })
}

// ---- assertion engine ------------------------------------------------------

/// One `(input_identity, enforced_identity)` pair per interception.
#[derive(Debug, Deserialize)]
pub struct IdentityPair {
    pub input_identity: Option<String>,
    pub enforced_identity: Option<String>,
}

/// Wire-shaped `RunRecord` the harness returns.
#[derive(Debug, Deserialize)]
pub struct RunRecord {
    pub outcome: String,
    #[serde(default)]
    pub final_output: Value,
    #[serde(default)]
    pub tool_invocations: Vec<Value>,
    #[serde(default)]
    pub error: Option<String>,
    /// One entry per interception, in order. Populated by the harness
    /// from its emitter's `InterceptionRecord`s so the CTK can assert
    /// `expect.identities_equal` (RM-N15).
    #[serde(default)]
    pub identities: Vec<IdentityPair>,
    /// Wire-shaped `InterceptionRecord`s (§10.3), one per emission, in
    /// order. Enables `expect.records` assertions (composition,
    /// verdicts, fold_truncated, resolved_by, identity_provider,
    /// combined-verdict content).
    #[serde(default)]
    pub records: Vec<Value>,
}

/// Result of one vector run.
#[derive(Debug, Serialize)]
pub struct VectorResult {
    pub id: String,
    pub title: String,
    /// Declared-surface tag (§13.1): grouping results by `part` is the
    /// conformance report.
    pub part: String,
    pub status: &'static str, // "pass" | "fail" | "skip"
    pub detail: String,
    pub failures: Vec<String>,
}

fn validate_required(ctx: &Value, failures: &mut Vec<String>) {
    let ip = ctx.get(IP).and_then(Value::as_str).unwrap_or("<missing>");
    let obj = match ctx.as_object() {
        Some(o) => o,
        None => {
            failures.push(format!("{ip}: context is not an object"));
            return;
        }
    };
    for k in REQUIRED_FIELDS {
        if !obj.contains_key(*k) {
            failures.push(format!("{ip}: missing required field {k:?}"));
        }
    }
}

fn assert_interceptions(expect: &Value, recorded: &[Value], failures: &mut Vec<String>) {
    let expected = expect["interceptions"].as_array().cloned().unwrap_or_default();
    let strict = expect
        .get("sequence_strict")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let rec_ips: Vec<&str> = recorded
        .iter()
        .filter_map(|c| c.get(IP).and_then(Value::as_str))
        .collect();

    let pairs: Vec<(&Value, &Value)> = if strict {
        let exp_ips: Vec<&str> = expected
            .iter()
            .filter_map(|e| e.get(IP).and_then(Value::as_str))
            .collect();
        if rec_ips != exp_ips {
            failures.push(format!(
                "interception sequence mismatch:\n  expected {exp_ips:?}\n  got      {rec_ips:?}"
            ));
            return;
        }
        expected.iter().zip(recorded.iter()).collect()
    } else {
        let mut out = Vec::new();
        let mut ri = 0usize;
        for e in &expected {
            let want = e.get(IP).and_then(Value::as_str).unwrap_or("");
            while ri < recorded.len()
                && recorded[ri].get(IP).and_then(Value::as_str) != Some(want)
            {
                ri += 1;
            }
            if ri >= recorded.len() {
                failures.push(format!(
                    "expected interception point {want:?} not found in sequence"
                ));
                return;
            }
            out.push((e, &recorded[ri]));
            ri += 1;
        }
        out
    };

    for (e, r) in pairs {
        if e.get("context_must_validate")
            .and_then(Value::as_bool)
            .unwrap_or(true)
        {
            validate_required(r, failures);
        }
        let ip = e.get(IP).and_then(Value::as_str).unwrap_or("");
        if let Some(preds) = e.get("context").and_then(Value::as_object) {
            for (path, want) in preds {
                match lookup(r, path) {
                    None => failures.push(format!("{ip}: path {path:?} did not resolve")),
                    Some(got) if got != want => {
                        failures.push(format!("{ip}: {path} == {got}, want {want}"))
                    }
                    _ => {}
                }
            }
        }
    }

    if let Some(absent) = expect.get("interceptions_absent").and_then(Value::as_array) {
        for a in absent {
            if let Some(name) = a.as_str() {
                if rec_ips.contains(&name) {
                    failures.push(format!(
                        "interception point {name:?} was emitted but MUST be absent"
                    ));
                }
            }
        }
    }
}

fn assert_record(expect: &Value, rr: &RunRecord, failures: &mut Vec<String>) {
    let want_outcome = expect["run_outcome"].as_str().unwrap_or("");
    if rr.outcome != want_outcome {
        failures.push(format!(
            "run_outcome == {:?}, want {want_outcome:?}",
            rr.outcome
        ));
    }
    if let Some(want) = expect.get("final_output") {
        if &rr.final_output != want {
            failures.push(format!(
                "final_output == {}, want {}",
                rr.final_output, want
            ));
        }
    }
    if let Some(want) = expect.get("tool_invocations").and_then(Value::as_array) {
        if rr.tool_invocations != *want {
            failures.push(format!(
                "tool_invocations == {:?}, want {:?}",
                rr.tool_invocations, want
            ));
        }
    }
    if let Some(not_invoked) = expect.get("tool_not_invoked").and_then(Value::as_array) {
        for name in not_invoked.iter().filter_map(Value::as_str) {
            if rr
                .tool_invocations
                .iter()
                .any(|inv| inv.get("name").and_then(Value::as_str) == Some(name))
            {
                failures.push(format!("tool {name:?} was invoked but MUST NOT be"));
            }
        }
    }
}

fn assert_identities(expect: &Value, rr: &RunRecord, failures: &mut Vec<String>) {
    let Some(want_equal) = expect.get("identities_equal").and_then(Value::as_bool) else {
        return;
    };
    if rr.identities.is_empty() {
        failures.push(
            "expect.identities_equal is set but harness did not report identities".into(),
        );
        return;
    }
    let all_equal = rr
        .identities
        .iter()
        .all(|p| p.input_identity == p.enforced_identity);
    if want_equal && !all_equal {
        let diffs: Vec<usize> = rr
            .identities
            .iter()
            .enumerate()
            .filter(|(_, p)| p.input_identity != p.enforced_identity)
            .map(|(i, _)| i)
            .collect();
        failures.push(format!(
            "identities_equal: expected input==enforced at every interception, but they differ at indices {diffs:?}"
        ));
    } else if !want_equal && all_equal {
        failures.push(
            "identities_equal: expected input!=enforced at some interception (a transform was applied), but all pairs are equal"
                .into(),
        );
    }
}

/// `expect.records`: forward-scan match on `interception_point`, then
/// dotted-path assertions against the wire-shaped record (§10.3). A
/// path that does not resolve is a failure — assert only fields the
/// record is expected to carry (absent-when-None fields like
/// `fold_truncated` are simply not asserted when absent).
fn assert_records(expect: &Value, rr: &RunRecord, failures: &mut Vec<String>) {
    let Some(expected) = expect.get("records").and_then(Value::as_array) else {
        return;
    };
    if rr.records.is_empty() {
        failures.push("expect.records is set but harness did not report records".into());
        return;
    }
    let mut ri = 0usize;
    for e in expected {
        let want_ip = e.get(IP).and_then(Value::as_str).unwrap_or("");
        while ri < rr.records.len()
            && rr.records[ri].get(IP).and_then(Value::as_str) != Some(want_ip)
        {
            ri += 1;
        }
        if ri >= rr.records.len() {
            failures.push(format!("expected record for {want_ip:?} not found in order"));
            return;
        }
        let rec = &rr.records[ri];
        if let Some(preds) = e.get("assert").and_then(Value::as_object) {
            for (path, want) in preds {
                match lookup(rec, path) {
                    None => failures.push(format!(
                        "record[{ri}] {want_ip}: path {path:?} did not resolve"
                    )),
                    Some(got) if got != want => failures.push(format!(
                        "record[{ri}] {want_ip}: {path} == {got}, want {want}"
                    )),
                    _ => {}
                }
            }
        }
        if let Some(absent) = e.get("absent").and_then(Value::as_array) {
            for path in absent.iter().filter_map(Value::as_str) {
                if let Some(got) = lookup(rec, path) {
                    failures.push(format!(
                        "record[{ri}] {want_ip}: {path} present ({got}), want absent"
                    ));
                }
            }
        }
        ri += 1;
    }
}

fn assert_sequence(recorded: &[Value], failures: &mut Vec<String>) {
    let seq: Vec<i64> = recorded
        .iter()
        .filter_map(|c| c.get("sequence").and_then(Value::as_i64))
        .collect();
    let mut sorted = seq.clone();
    sorted.sort();
    sorted.dedup();
    if seq != sorted || sorted.len() != recorded.len() {
        failures.push(format!("sequence not strictly increasing: {seq:?}"));
    }
}

/// Determine whether a vector should be skipped for a harness.
pub fn should_skip(vector: &Value, harness_caps: &[&str]) -> Option<String> {
    let needed: Vec<&str> = vector
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let missing: Vec<&str> = needed
        .iter()
        .copied()
        .filter(|c| !harness_caps.contains(c))
        .collect();
    if missing.is_empty() {
        None
    } else {
        Some(format!("missing capabilities: {missing:?}"))
    }
}

/// Run the assertion pass for one vector. `recorded` is the list of
/// `AgentContext` values the harness passed to the interceptor, in
/// order. Returns a [`VectorResult`] with `status` = `"pass"` or
/// `"fail"`.
pub fn assert_vector(vector: &Value, recorded: &[Value], rr: &RunRecord) -> VectorResult {
    let id = vector["id"].as_str().unwrap_or("").to_owned();
    let title = vector["title"].as_str().unwrap_or("").to_owned();
    let part = vector
        .get("part")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();

    let mut failures = Vec::new();
    assert_interceptions(&vector["expect"], recorded, &mut failures);
    assert_record(&vector["expect"], rr, &mut failures);
    assert_records(&vector["expect"], rr, &mut failures);
    assert_sequence(recorded, &mut failures);
    assert_identities(&vector["expect"], rr, &mut failures);

    VectorResult {
        id,
        title,
        part,
        status: if failures.is_empty() { "pass" } else { "fail" },
        detail: String::new(),
        failures,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lookup_dotted() {
        let v = json!({"a": {"b": [10, {"c": "x"}]}});
        assert_eq!(lookup(&v, "a.b[1].c"), Some(&json!("x")));
        assert_eq!(lookup(&v, "a.b[0]"), Some(&json!(10)));
        assert_eq!(lookup(&v, "a.missing"), None);
    }

    #[test]
    fn scripted_intercept_first_match() {
        let rules = vec![
            json!({"at": "pre_tool_call", "match": {"tool_call.name": "x"},
                   "return": {"decision": "deny"}}),
            json!({"at": "pre_tool_call",
                   "return": {"decision": "allow", "warnings": [{"reason": "ctk:advisory"}]}}),
        ];
        let ctx = json!({"interception_point": "pre_tool_call",
                         "tool_call": {"name": "x"}});
        assert_eq!(scripted_intercept(&rules, &ctx)["decision"], "deny");
        let ctx2 = json!({"interception_point": "pre_tool_call",
                          "tool_call": {"name": "y"}});
        let v2 = scripted_intercept(&rules, &ctx2);
        assert_eq!(v2["decision"], "allow");
        assert_eq!(v2["warnings"][0]["reason"], "ctk:advisory");
        let ctx3 = json!({"interception_point": "input"});
        assert_eq!(scripted_intercept(&rules, &ctx3)["decision"], "allow");
    }

    #[test]
    fn scripted_resolve_echoes_identity() {
        let rules = vec![json!({"resolve": {"outcome": "approve",
                                            "verdict": {"decision": "allow"}}})];
        let out = scripted_resolve(&rules, &json!({}), "sha256:abc");
        assert_eq!(out["context_identity"], "sha256:abc");
        assert_eq!(out["outcome"], "approve");
    }

    #[test]
    fn scripted_intercept_fault_sentinels() {
        let rules = vec![
            json!({"at": "input", "fault": "raise"}),
            json!({"at": "output", "fault": "malformed_verdict"}),
        ];
        let raised = scripted_intercept(&rules, &json!({"interception_point": "input"}));
        assert_eq!(raised["__ctk_fault__"], "raise");
        let malformed = scripted_intercept(&rules, &json!({"interception_point": "output"}));
        assert_eq!(malformed["decision"], "transform");
        assert!(malformed.get("transform").is_none());
    }

    #[test]
    fn scripted_resolve_fault_and_identity_override() {
        let raise_rules = vec![json!({"resolve": {"fault": "raise"}})];
        let out = scripted_resolve(&raise_rules, &json!({}), "sha256:abc");
        assert_eq!(out["__ctk_fault__"], "raise");

        let override_rules = vec![json!({"resolve": {
            "outcome": "approve",
            "verdict": {"decision": "allow"},
            "identity_override": "sha256:0000"
        }})];
        let out = scripted_resolve(&override_rules, &json!({}), "sha256:abc");
        assert_eq!(out["context_identity"], "sha256:0000");
        assert_eq!(out["outcome"], "approve");
    }

    #[test]
    fn should_skip_subset() {
        let v = json!({"capabilities": ["tool_calls"]});
        assert!(should_skip(&v, &["model_calls"]).is_some());
        assert!(should_skip(&v, &["model_calls", "tool_calls"]).is_none());
    }

    #[test]
    fn assert_vector_pass() {
        let vector = json!({
            "id": "T", "title": "t",
            "expect": {
                "interceptions": [{"interception_point": "input"}],
                "sequence_strict": true,
                "run_outcome": "completed"
            }
        });
        let recorded = vec![json!({
            "spec": "agent-hooks/0.1", "interception_point": "input",
            "timestamp": "t", "sequence": 0,
            "agent": {"id":"a","framework":"x"}, "session": {"id":"s"},
            "target": {}
        })];
        let rr = RunRecord {
            outcome: "completed".into(),
            final_output: Value::Null,
            tool_invocations: vec![],
            error: None,
            identities: vec![],
            records: vec![],
        };
        let r = assert_vector(&vector, &recorded, &rr);
        assert_eq!(r.status, "pass", "{:?}", r.failures);
    }
}
