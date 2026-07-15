// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! `AgentContext` construction (§4) for Rust-native hosts.
//!
//! Stateful per-session builder that owns the required-core envelope
//! (agent/session/sequence) and exposes one method per interception
//! point that fills the conditional fields and sets `target`. Optional
//! data is added by inserting into the returned map before emitting, or
//! session-wide via [`AgentContextBuilder::with_optional`].

use crate::types::{AgentContext, InterceptionPoint, SPEC_VERSION};
use serde_json::{json, Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};

/// Days-to-civil conversion (Howard Hinnant's algorithm); avoids a
/// date-crate dependency for one timestamp format.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// RFC 3339 UTC instant with millisecond precision.
fn rfc3339_now() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let millis = dur.subsec_millis();
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let sod = secs.rem_euclid(86_400);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        sod / 3600,
        (sod / 60) % 60,
        sod % 60
    )
}

type TimestampFn = Box<dyn Fn() -> String + Send + Sync>;

/// Stateful per-session builder for [`AgentContext`] values.
pub struct AgentContextBuilder {
    agent: Map<String, Value>,
    session: Map<String, Value>,
    seq: u64,
    optional: Map<String, Value>,
    now: TimestampFn,
}

impl AgentContextBuilder {
    pub fn new(agent_id: &str, framework: &str, session_id: &str) -> Self {
        let mut agent = Map::new();
        agent.insert("id".into(), json!(agent_id));
        agent.insert("framework".into(), json!(framework));
        let mut session = Map::new();
        session.insert("id".into(), json!(session_id));
        Self {
            agent,
            session,
            seq: 0,
            optional: Map::new(),
            now: Box::new(rfc3339_now),
        }
    }

    /// Replace the timestamp provider (e.g. for deterministic tests).
    pub fn with_timestamp_provider(
        mut self,
        f: impl Fn() -> String + Send + Sync + 'static,
    ) -> Self {
        self.now = Box::new(f);
        self
    }

    /// Attach a well-known optional field (`trace`, `tenant`,
    /// `budgets`, …, §4.5) to every subsequent context.
    pub fn with_optional(&mut self, key: &str, value: Value) -> &mut Self {
        self.optional.insert(key.to_owned(), value);
        self
    }

    fn envelope(&mut self, ip: InterceptionPoint, target: Value) -> AgentContext {
        let mut ctx = Map::new();
        ctx.insert("spec".into(), json!(SPEC_VERSION));
        ctx.insert("interception_point".into(), json!(ip.as_str()));
        ctx.insert("timestamp".into(), json!((self.now)()));
        ctx.insert("sequence".into(), json!(self.seq));
        ctx.insert("agent".into(), Value::Object(self.agent.clone()));
        ctx.insert("session".into(), Value::Object(self.session.clone()));
        ctx.insert("target".into(), target);
        for (k, v) in &self.optional {
            ctx.insert(k.clone(), v.clone());
        }
        self.seq += 1;
        ctx
    }

    // ---- per-point conditional-field builders ------------------------------

    pub fn agent_startup(&mut self, tools_registered: Vec<String>) -> AgentContext {
        let init = json!({ "tools_registered": tools_registered });
        let mut ctx = self.envelope(InterceptionPoint::AgentStartup, init.clone());
        ctx.insert("agent_init".into(), init);
        ctx
    }

    pub fn input(&mut self, content: Value, role: &str) -> AgentContext {
        let input = json!({ "content": content, "role": role });
        let mut ctx = self.envelope(InterceptionPoint::Input, input.clone());
        ctx.insert("input".into(), input);
        ctx
    }

    pub fn pre_model_call(&mut self, model_id: &str, messages: Vec<Value>) -> AgentContext {
        let msgs = Value::Array(messages);
        let mut ctx = self.envelope(InterceptionPoint::PreModelCall, msgs.clone());
        ctx.insert("model".into(), json!({ "id": model_id }));
        ctx.insert("messages".into(), msgs);
        ctx
    }

    pub fn post_model_call(
        &mut self,
        model_id: &str,
        content: Value,
        tool_calls: Vec<Value>,
        finish_reason: &str,
    ) -> AgentContext {
        let response = json!({
            "content": content,
            "tool_calls": tool_calls,
            "finish_reason": finish_reason,
        });
        let mut ctx = self.envelope(InterceptionPoint::PostModelCall, response.clone());
        ctx.insert("model".into(), json!({ "id": model_id }));
        ctx.insert("response".into(), response);
        ctx
    }

    pub fn pre_tool_call(&mut self, call_id: &str, name: &str, args: Value) -> AgentContext {
        let mut ctx = self.envelope(InterceptionPoint::PreToolCall, args.clone());
        ctx.insert(
            "tool_call".into(),
            json!({ "id": call_id, "name": name, "args": args }),
        );
        ctx
    }

    pub fn post_tool_call(
        &mut self,
        call_id: &str,
        name: &str,
        args: Value,
        value: Value,
        is_error: bool,
    ) -> AgentContext {
        let mut ctx = self.envelope(InterceptionPoint::PostToolCall, value.clone());
        ctx.insert(
            "tool_call".into(),
            json!({ "id": call_id, "name": name, "args": args }),
        );
        ctx.insert(
            "tool_result".into(),
            json!({ "value": value, "is_error": is_error }),
        );
        ctx
    }

    pub fn output(&mut self, content: Value) -> AgentContext {
        let output = json!({ "content": content });
        let mut ctx = self.envelope(InterceptionPoint::Output, output.clone());
        ctx.insert("output".into(), output);
        ctx
    }

    pub fn agent_shutdown(&mut self, reason: &str) -> AgentContext {
        let summary = json!({ "reason": reason });
        let mut ctx = self.envelope(InterceptionPoint::AgentShutdown, summary.clone());
        ctx.insert("summary".into(), summary);
        ctx
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_epoch_and_leap() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29)); // leap day
    }

    #[test]
    fn sequence_monotonic_and_required_complete() {
        let mut b = AgentContextBuilder::new("a", "test", "s")
            .with_timestamp_provider(|| "2026-01-01T00:00:00.000Z".into());
        let c0 = b.agent_startup(vec!["t".into()]);
        let c1 = b.input(serde_json::json!("hi"), "user");
        assert_eq!(c0["sequence"], 0);
        assert_eq!(c1["sequence"], 1);
        for k in [
            "spec",
            "interception_point",
            "timestamp",
            "sequence",
            "agent",
            "session",
            "target",
        ] {
            assert!(c1.contains_key(k), "missing {k}");
        }
        assert_eq!(c1["input"]["role"], "user");
    }
}
