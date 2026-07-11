// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! The `jcs-sha256` identity provider (§10.1–§10.2).
//!
//! §10.2's canonical form is RFC 8785 (JSON Canonicalization Scheme),
//! performed by the vendored JCS serializer (`jcs.rs`): object members sorted by UTF-16
//! code units, numbers per ECMA-262 `Number::toString`, minimal string
//! escapes.
//!
//! The identity preimage is the **closed** required+conditional field
//! set for the context's interception point — including nested subfield
//! whitelists — so that adding any optional/namespaced data (top-level
//! or nested, e.g. `tool_result.duration_ms` or `model.params`) never
//! perturbs `context_identity`.
//!
//! Input domain (§10.2): fail closed, never normalize. RFC 8785 defines
//! canonical bytes only for I-JSON; an integral value outside ±(2⁵³−1)
//! in the projection would silently round (non-injective identity), so
//! the provider rejects it with a remediation-detail message.
//! Non-finite numbers and lone surrogates fail at the parse funnel
//! before this module runs.

use crate::types::{AgentContext, HostError};
use crate::jcs;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt::Write;

/// Largest integer magnitude an IEEE-754 double represents exactly
/// (2⁵³−1); the I-JSON interoperability bound (§4.4, §10.2).
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Maximum nesting depth accepted on the identity path (RECOMMENDED
/// default per spec §12.3). Breach fails closed: an unbounded in-memory
/// context would otherwise recurse the canonicalizer into a stack
/// overflow (process abort) instead of a §6.3 deny.
pub const MAX_DEPTH: usize = 128;

/// Fail closed when `v` nests deeper than [`MAX_DEPTH`] (§12.3).
/// Iterative on purpose: this function is the guard that keeps the
/// recursive walks below it (JCS serialization, [`check_i_json`])
/// stack-safe, so it must not recurse itself.
pub fn check_depth(v: &Value) -> Result<(), (HostError, String)> {
    let mut stack: Vec<(&Value, usize)> = vec![(v, 1)];
    while let Some((v, d)) = stack.pop() {
        if d > MAX_DEPTH {
            return Err((
                HostError::ContextInvalid,
                format!("context nests deeper than {MAX_DEPTH} levels, see spec §12.3"),
            ));
        }
        match v {
            Value::Array(a) => stack.extend(a.iter().map(|x| (x, d + 1))),
            Value::Object(m) => stack.extend(m.values().map(|x| (x, d + 1))),
            _ => {}
        }
    }
    Ok(())
}

/// §10.2 input domain, raw-text half: reject integer-syntax number
/// tokens whose magnitude exceeds ±(2⁵³−1) **before** `serde_json` gets
/// to coerce them. `serde_json` (default features) parses integer
/// literals beyond the u64/i64 range as `f64`, so by the time
/// [`check_i_json`] sees the `Value` a literal like `18446744073709551616`
/// is indistinguishable from a genuine double — and two byte-distinct
/// literals canonicalize to identical bytes (non-injective identity).
/// Callers run this on the raw JSON text of every jcs-sha256 funnel;
/// the text MUST already have parsed successfully (the lexer assumes
/// syntactic validity). The in-memory [`Value`] path has no equivalent
/// bypass: `serde_json::Number` cannot represent an integer outside
/// i64/u64 at all, so [`check_i_json`] alone is complete there.
pub fn scan_raw_integer_domain(text: &str) -> Result<(), (HostError, String)> {
    const LIMIT: &[u8] = b"9007199254740991"; // 2^53 - 1, 16 digits
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'"' => {
                // Skip the string body, honouring backslash escapes.
                i += 1;
                while i < b.len() {
                    match b[i] {
                        b'\\' => i += 2,
                        b'"' => break,
                        _ => i += 1,
                    }
                }
                i += 1;
            }
            b'-' | b'0'..=b'9' => {
                let start = i;
                let mut integer_syntax = true;
                while i < b.len() {
                    match b[i] {
                        b'0'..=b'9' | b'-' | b'+' => i += 1,
                        b'.' | b'e' | b'E' => {
                            integer_syntax = false;
                            i += 1;
                        }
                        _ => break,
                    }
                }
                if integer_syntax {
                    let digits = &b[start..i];
                    let digits = if digits.first() == Some(&b'-') { &digits[1..] } else { digits };
                    let over = digits.len() > LIMIT.len()
                        || (digits.len() == LIMIT.len() && digits > LIMIT);
                    if over {
                        let tok = std::str::from_utf8(&b[start..i]).unwrap_or("<number>");
                        return Err((
                            HostError::ContextInvalid,
                            format!(
                                "integer {tok} exceeds 2^53; string-encode 64-bit identifiers, see spec §4.4"
                            ),
                        ));
                    }
                }
            }
            _ => i += 1,
        }
    }
    Ok(())
}

/// Serialize `v` per §10.2 (RFC 8785 / JCS).
pub fn canonical_json(v: &Value) -> String {
    jcs::to_string(v).expect("JCS serialization of in-memory Value cannot fail")
}

/// Field whitelist: `(key, allowed_subfields)`. `None` = keep value whole.
type Keep = (&'static str, Option<&'static [&'static str]>);

/// Required-core preimage fields (§4.1, §10.2).
const REQUIRED: &[Keep] = &[
    ("spec", None),
    ("interception_point", None),
    ("timestamp", None),
    ("sequence", None),
    ("agent", Some(&["id", "framework"])),
    ("session", Some(&["id"])),
    ("target", None),
];

/// Closed conditional (per-point) preimage (§4.2, §10.2). Mirrors the
/// per-point closed schemas in `spec/schema/agent-context/`.
fn conditional_for(ip: &str) -> &'static [Keep] {
    match ip {
        "agent_startup" => &[("agent_init", Some(&["tools_registered"]))],
        "input" => &[("input", Some(&["content", "role"]))],
        "pre_model_call" => &[("model", Some(&["id"])), ("messages", None)],
        "post_model_call" => &[
            ("model", Some(&["id"])),
            ("response", Some(&["content", "tool_calls", "finish_reason"])),
        ],
        "pre_tool_call" => &[("tool_call", Some(&["id", "name", "args"]))],
        "post_tool_call" => &[
            ("tool_call", Some(&["id", "name", "args"])),
            ("tool_result", Some(&["value", "is_error"])),
        ],
        "output" => &[("output", Some(&["content"]))],
        "agent_shutdown" => &[("summary", Some(&["reason"]))],
        _ => &[],
    }
}

fn filter_obj(v: &Value, keep: &[&str]) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(k, _)| keep.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The closed required+conditional projection of `ctx` (§10.2).
fn project_preimage(ctx: &AgentContext) -> Value {
    let ip = ctx
        .get("interception_point")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut out = serde_json::Map::new();
    for (key, sub) in REQUIRED.iter().chain(conditional_for(ip)) {
        if let Some(v) = ctx.get(*key) {
            let v = match sub {
                Some(keep) => filter_obj(v, keep),
                None => v.clone(),
            };
            out.insert((*key).to_owned(), v);
        }
    }
    Value::Object(out)
}

/// §10.2 input domain, in-memory half: reject integral values outside
/// ±(2⁵³−1) anywhere in the projection. `serde_json::Number` holds
/// integers only within i64/u64, so these arms are complete for any
/// in-memory `Value`; literals *beyond* u64/i64 exist only in raw JSON
/// text (where serde coerces them to f64) and are caught earlier by
/// [`scan_raw_integer_domain`] at the parse funnels. Recursion here is
/// bounded because [`check_depth`] runs first.
fn check_i_json(v: &Value, path: &str) -> Result<(), (HostError, String)> {
    match v {
        Value::Number(n) => {
            let out_of_range = match (n.as_u64(), n.as_i64()) {
                (Some(u), _) => u > MAX_SAFE_INTEGER,
                (None, Some(i)) => i.unsigned_abs() > MAX_SAFE_INTEGER,
                _ => false, // f64: parse already made it a double
            };
            if out_of_range {
                return Err((
                    HostError::ContextInvalid,
                    format!(
                        "{path}: integer {n} exceeds 2^53; string-encode 64-bit identifiers, see spec §4.4"
                    ),
                ));
            }
            Ok(())
        }
        Value::Array(a) => {
            for (i, item) in a.iter().enumerate() {
                check_i_json(item, &format!("{path}[{i}]"))?;
            }
            Ok(())
        }
        Value::Object(m) => {
            for (k, item) in m {
                check_i_json(item, &format!("{path}.{k}"))?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// [`scan_raw_integer_domain`] scoped to the **closed projection**
/// (§10.2): only the raw text of required+conditional fields (and their
/// nested whitelists) is scanned, so a beyond-2⁵³ integer in an
/// optional or namespaced field never rejects — mirroring
/// [`check_i_json`], which walks the projected `Value`. Zero-copy via
/// `RawValue`; `ctx_json` must already have parsed successfully.
pub fn scan_projection_raw(ctx_json: &str) -> Result<(), (HostError, String)> {
    use serde_json::value::RawValue;
    type RawMap<'a> = std::collections::HashMap<&'a str, &'a RawValue>;
    let top: RawMap = serde_json::from_str(ctx_json)
        .map_err(|e| (HostError::ContextInvalid, format!("ctx: {e}")))?;
    let ip: &str = top
        .get("interception_point")
        .and_then(|rv| serde_json::from_str::<&str>(rv.get()).ok())
        .unwrap_or_default();
    for (key, sub) in REQUIRED.iter().chain(conditional_for(ip)) {
        let Some(rv) = top.get(*key) else { continue };
        match sub {
            None => scan_raw_integer_domain(rv.get())?,
            Some(keep) => match serde_json::from_str::<RawMap>(rv.get()) {
                Ok(m) => {
                    for k in *keep {
                        if let Some(f) = m.get(*k) {
                            scan_raw_integer_domain(f.get())?;
                        }
                    }
                }
                // Non-object where the schema expects one: scan whole —
                // schema validation rejects it elsewhere; never let a
                // malformed shape widen the identity domain.
                Err(_) => scan_raw_integer_domain(rv.get())?,
            },
        }
    }
    Ok(())
}

/// The `jcs-sha256` provider (§10.2):
/// `"sha256:" + hex(SHA-256(canonical_json(projection)))`, failing
/// closed (`host_error:context_invalid`) on a non-I-JSON projection.
pub fn context_identity(ctx: &AgentContext) -> Result<String, (HostError, String)> {
    let preimage = project_preimage(ctx);
    check_depth(&preimage)?;
    check_i_json(&preimage, "$")?;
    let json = canonical_json(&preimage);
    let digest = Sha256::digest(json.as_bytes());
    let mut out = String::with_capacity(7 + 64);
    out.push_str("sha256:");
    for b in digest {
        write!(out, "{b:02x}").expect("write hex");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx(target: Value) -> AgentContext {
        json!({
            "spec": "agent-hooks/0.1",
            "interception_point": "pre_tool_call",
            "timestamp": "t", "sequence": 0,
            "agent": {"id": "a", "framework": "x"},
            "session": {"id": "s"},
            "target": target,
            "tool_call": {"id": "tc", "name": "t", "args": target.clone()}
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn jcs_numbers() {
        // RFC 8785 §3.2.2.3 examples (ECMA-262 ToString).
        assert_eq!(canonical_json(&json!(1.0)), "1");
        assert_eq!(canonical_json(&json!(-0.0)), "0");
        assert_eq!(canonical_json(&json!(1e21)), "1e+21");
        assert_eq!(canonical_json(&json!(1e-7)), "1e-7");
        assert_eq!(canonical_json(&json!(0.000001)), "0.000001");
    }

    #[test]
    fn jcs_key_order_utf16() {
        // U+E000 (3-byte UTF-8) vs U+10000 (4-byte UTF-8, surrogates in
        // UTF-16): UTF-16 order puts the supplementary char FIRST.
        let v = json!({"\u{e000}": 1, "\u{10000}": 2});
        assert_eq!(canonical_json(&v), "{\"\u{10000}\":2,\"\u{e000}\":1}");
    }

    #[test]
    fn nested_optional_fields_stripped() {
        let ctx: AgentContext = json!({
            "spec": "agent-hooks/0.1",
            "interception_point": "post_tool_call",
            "timestamp": "t", "sequence": 5,
            "agent": {"id": "a", "framework": "x", "name": "optional"},
            "session": {"id": "s", "turn": 3},
            "target": "v",
            "tool_call": {"id": "tc", "name": "t", "args": {}, "content_hash": "sha256:00"},
            "tool_result": {"value": "v", "is_error": false, "duration_ms": 12.5}
        })
        .as_object()
        .unwrap()
        .clone();
        let mut bare = ctx.clone();
        // Remove every nested optional field; identity must be unchanged.
        bare.get_mut("tool_result").unwrap().as_object_mut().unwrap().remove("duration_ms");
        bare.get_mut("tool_call").unwrap().as_object_mut().unwrap().remove("content_hash");
        bare.get_mut("agent").unwrap().as_object_mut().unwrap().remove("name");
        bare.get_mut("session").unwrap().as_object_mut().unwrap().remove("turn");
        assert_eq!(
            context_identity(&ctx).unwrap(),
            context_identity(&bare).unwrap()
        );
    }

    #[test]
    fn rejects_integer_beyond_2_53() {
        // 2^53+1: JCS would round this to 2^53 (non-injective).
        let c = ctx(json!({"id": 9_007_199_254_740_993_i64}));
        let (e, detail) = context_identity(&c).unwrap_err();
        assert_eq!(e, HostError::ContextInvalid);
        assert!(detail.contains("string-encode 64-bit identifiers"), "{detail}");

        let c = ctx(json!({"id": -9_007_199_254_740_993_i64}));
        assert!(context_identity(&c).is_err());

        let c = ctx(json!({"id": 18_446_744_073_709_551_615_u64}));
        assert!(context_identity(&c).is_err());
    }

    #[test]
    fn accepts_boundary_and_string_encoded() {
        let c = ctx(json!({"id": 9_007_199_254_740_991_i64}));
        assert!(context_identity(&c).is_ok());
        let c = ctx(json!({"id": "9007199254740993"}));
        assert!(context_identity(&c).is_ok());
        let c = ctx(json!({"id": -9_007_199_254_740_991_i64}));
        assert!(context_identity(&c).is_ok());
    }

    #[test]
    fn optional_fields_not_checked() {
        // The domain check applies to the closed projection only: a
        // big integer in an optional field never reaches JCS, so it
        // must not reject.
        let mut c = ctx(json!({"ok": 1}));
        c.insert("extensions".into(), json!({"host": {"big": 9_007_199_254_740_993_i64}}));
        assert!(context_identity(&c).is_ok());
    }

    #[test]
    fn raw_scan_catches_beyond_u64_literals() {
        // AR-09-001: serde coerces these to f64 before any Value-level
        // check can see them; the raw-text scan must reject.
        let ctx = r#"{"spec":"agent-hooks/0.1","interception_point":"pre_tool_call","timestamp":"t","sequence":0,"agent":{"id":"a","framework":"x"},"session":{"id":"s"},"target":{"id":18446744073709551616},"tool_call":{"id":"tc","name":"t","args":{"id":18446744073709551616}}}"#;
        let (e, d) = scan_projection_raw(ctx).unwrap_err();
        assert_eq!(e, HostError::ContextInvalid);
        assert!(d.contains("18446744073709551616"), "{d}");

        // The two byte-distinct literals that motivated the fix.
        assert!(scan_raw_integer_domain(r#"{"id":18446744073709551616}"#).is_err());
        assert!(scan_raw_integer_domain(r#"{"id":18446744073709551617}"#).is_err());
        assert!(scan_raw_integer_domain(r#"{"id":-18446744073709551616}"#).is_err());
    }

    #[test]
    fn raw_scan_respects_syntax_classes() {
        // Float syntax is a genuine double — legal I-JSON.
        assert!(scan_raw_integer_domain(r#"{"x":1.8446744073709552e19}"#).is_ok());
        assert!(scan_raw_integer_domain(r#"{"x":9007199254740993.0}"#).is_ok());
        // Boundary: 2^53−1 ok, 2^53+1 rejected, 16-digit compare exact.
        assert!(scan_raw_integer_domain(r#"{"x":9007199254740991}"#).is_ok());
        assert!(scan_raw_integer_domain(r#"{"x":9007199254740993}"#).is_err());
        assert!(scan_raw_integer_domain(r#"{"x":-9007199254740991}"#).is_ok());
        // Digits inside strings (including escapes) are not numbers.
        assert!(scan_raw_integer_domain(r#"{"x":"18446744073709551616","y":"a\"18446744073709551616"}"#).is_ok());
    }

    #[test]
    fn raw_scan_scoped_to_projection() {
        // A beyond-2^53 integer in an optional/namespaced field must not
        // reject at the text funnel either (closed-projection parity
        // with check_i_json).
        let ctx = r#"{"spec":"agent-hooks/0.1","interception_point":"pre_tool_call","timestamp":"t","sequence":0,"agent":{"id":"a","framework":"x"},"session":{"id":"s"},"target":{},"tool_call":{"id":"tc","name":"t","args":{},"content_hash":"h"},"extensions":{"host":{"big":18446744073709551616}},"usage":{"prompt_tokens":18446744073709551616}}"#;
        assert!(scan_projection_raw(ctx).is_ok());
        // ...but nested *whitelisted* subfields are scanned.
        let ctx = r#"{"spec":"agent-hooks/0.1","interception_point":"pre_tool_call","timestamp":"t","sequence":0,"agent":{"id":"a","framework":"x"},"session":{"id":"s"},"target":{},"tool_call":{"id":"tc","name":"t","args":{"id":18446744073709551616}}}"#;
        assert!(scan_projection_raw(ctx).is_err());
    }

    #[test]
    fn depth_cap_fails_closed() {
        // Build a Value nested past MAX_DEPTH; identity must deny, not
        // overflow the canonicalizer's stack (§12.3).
        let mut v = json!(1);
        for _ in 0..(MAX_DEPTH + 4) {
            v = json!([v]);
        }
        let c = ctx(v);
        let (e, d) = context_identity(&c).unwrap_err();
        assert_eq!(e, HostError::ContextInvalid);
        assert!(d.contains("nests deeper"), "{d}");
        // At the cap: fine.
        let mut v = json!(1);
        for _ in 0..(MAX_DEPTH - 8) {
            v = json!([v]);
        }
        assert!(context_identity(&ctx(v)).is_ok());
    }

    #[test]
    fn non_json_floats_unrepresentable_at_parse() {
        // §4.4 pinning: NaN/Infinity are not JSON — the parse funnel
        // rejects them before any provider runs.
        assert!(serde_json::from_str::<Value>("{\"x\": NaN}").is_err());
        assert!(serde_json::from_str::<Value>("{\"x\": Infinity}").is_err());
        // Lone surrogate escape: rejected by serde_json's parser.
        assert!(serde_json::from_str::<Value>("{\"x\": \"\\ud800\"}").is_err());
    }
}
