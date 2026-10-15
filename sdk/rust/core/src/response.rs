// Copyright (c) Microsoft. All rights reserved.

//! Optional hosted/cross-process interceptor response envelope (§5.5).

use crate::types::{HostError, Verdict};
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fmt;

/// Maximum RFC 8785 canonical byte length of `extensions` (§5.5).
pub const RESPONSE_METADATA_MAX_BYTES: usize = 65_536;

/// A normalized transport response. A bare Verdict parses to this shape with
/// no extensions; serialization emits the bare Verdict when extensions are
/// empty (§5.5).
#[derive(Debug, Clone, PartialEq)]
pub struct InterceptorResponse {
    pub verdict: Verdict,
    pub extensions: BTreeMap<String, Value>,
}

impl InterceptorResponse {
    /// Parse a JSON value. Use [`from_json`] when duplicate-member rejection
    /// must be enforced on raw transport text.
    pub fn from_wire(raw: &Value) -> Result<Self, (HostError, String)> {
        crate::verdict::check_json_domain(raw)?;
        let Some(obj) = raw.as_object() else {
            return Err((
                HostError::VerdictInvalid,
                "interceptor response must be a JSON object (§5.5)".into(),
            ));
        };
        if !obj.contains_key("verdict") {
            return Ok(Self {
                verdict: crate::verdict::from_wire(raw)?,
                extensions: BTreeMap::new(),
            });
        }

        for key in obj.keys() {
            if !matches!(key.as_str(), "verdict" | "extensions") {
                return Err((
                    HostError::VerdictInvalid,
                    "interceptor response contains an unknown root member (§5.5)".into(),
                ));
            }
        }
        let verdict = crate::verdict::from_wire(&obj["verdict"])?;
        let extensions = match obj.get("extensions") {
            None => None,
            Some(value @ Value::Object(object)) => {
                for namespace in object.keys() {
                    if !valid_namespace(namespace) {
                        return Err((
                            HostError::VerdictInvalid,
                            "interceptor response contains an invalid extension namespace (§5.5)"
                                .into(),
                        ));
                    }
                }
                Some(value)
            }
            Some(_) => {
                return Err((
                    HostError::VerdictInvalid,
                    "interceptor response extensions must be an object (§5.5)".into(),
                ))
            }
        };

        if let Some(metadata) = extensions {
            crate::canonical::check_i_json(metadata, "$").map_err(|_| {
                (
                    HostError::VerdictInvalid,
                    "response metadata integer exceeds 2^53; encode it as a string (§4.4)".into(),
                )
            })?;
        }
        let metadata_bytes = extensions
            .map(|value| crate::canonical::canonical_json(value).len())
            .unwrap_or_default();
        if metadata_bytes > RESPONSE_METADATA_MAX_BYTES {
            return Err((
                HostError::VerdictInvalid,
                format!(
                    "interceptor response metadata canonical size {metadata_bytes} exceeds {RESPONSE_METADATA_MAX_BYTES} bytes (§5.5)"
                ),
            ));
        }

        Ok(Self {
            verdict,
            extensions: extensions
                .and_then(Value::as_object)
                .map(|object| object.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default(),
        })
    }

    /// Reject duplicates during JSON parsing and unsafe metadata integer tokens
    /// before `from_wire` checks depth, metadata I-JSON, Verdict semantics and size.
    pub fn from_json(text: &str) -> Result<Self, (HostError, String)> {
        let raw = parse_checked(text)?;
        if raw.get("verdict").is_some() {
            let members: BTreeMap<String, &serde_json::value::RawValue> =
                serde_json::from_str(text).map_err(|_| {
                    (
                        HostError::VerdictInvalid,
                        "response must be an object".into(),
                    )
                })?;
            if let Some(metadata) = members.get("extensions") {
                // Verdict transform values retain the existing §5.2/§10.2
                // application checks; only new transport metadata is scanned here.
                crate::canonical::scan_raw_integer_domain(metadata.get())
                    .map_err(|(_, detail)| (HostError::VerdictInvalid, detail))?;
            }
        }
        Self::from_wire(&raw)
    }

    /// Always serialize the normalized envelope shape.
    pub fn to_envelope_value(&self) -> Value {
        let mut out = Map::new();
        out.insert(
            "verdict".into(),
            serde_json::to_value(&self.verdict).expect("verdict serialize"),
        );
        if !self.extensions.is_empty() {
            out.insert(
                "extensions".into(),
                serde_json::to_value(&self.extensions).expect("extensions serialize"),
            );
        }
        Value::Object(out)
    }

    /// Serialize a bare Verdict when no transport metadata is present.
    pub fn to_wire_value(&self) -> Value {
        if self.extensions.is_empty() {
            serde_json::to_value(&self.verdict).expect("verdict serialize")
        } else {
            self.to_envelope_value()
        }
    }
}

impl Serialize for InterceptorResponse {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_wire_value().serialize(serializer)
    }
}

fn valid_namespace(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

struct Checked;

impl<'de> DeserializeSeed<'de> for Checked {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Checked {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        Ok(Value::from(v))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        Ok(Value::from(v))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
        serde_json::Number::from_f64(v)
            .map(Value::Number)
            .ok_or_else(|| de::Error::custom("non-finite number"))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.to_owned()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_some<D: de::Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        d.deserialize_any(self)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut out = Vec::new();
        while let Some(value) = seq.next_element_seed(Checked)? {
            out.push(value);
        }
        Ok(Value::Array(out))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut out = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if out.contains_key(&key) {
                return Err(de::Error::custom("duplicate object member"));
            }
            let value = map.next_value_seed(Checked)?;
            out.insert(key, value);
        }
        Ok(Value::Object(out))
    }
}

pub(crate) fn parse_checked(text: &str) -> Result<Value, (HostError, String)> {
    let mut deserializer = serde_json::Deserializer::from_str(text);
    let value = Checked.deserialize(&mut deserializer).map_err(|e| {
        (
            HostError::VerdictInvalid,
            format!("invalid result JSON: {e}"),
        )
    })?;
    deserializer.end().map_err(|e| {
        (
            HostError::VerdictInvalid,
            format!("trailing content after interceptor response: {e}"),
        )
    })?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bare_verdict_normalizes() {
        let response = InterceptorResponse::from_json(r#"{"decision":"allow"}"#).unwrap();
        assert_eq!(response.verdict.decision, crate::Decision::Allow);
        assert_eq!(
            response.to_envelope_value(),
            json!({"verdict": {"decision": "allow"}})
        );
        assert_eq!(response.to_wire_value(), json!({"decision": "allow"}));
    }

    #[test]
    fn envelope_roundtrips_metadata() {
        let raw = json!({
            "verdict": {"decision": "deny", "reason": "policy"},
            "extensions": {"provider_name": {
                "receipt": {"evaluationId": "e1"}, "requestId": "r1"
            }}
        });
        let response = InterceptorResponse::from_wire(&raw).unwrap();
        assert_eq!(response.to_wire_value(), raw);
    }

    #[test]
    fn malformed_envelopes_fail_closed() {
        for raw in [
            r#"{"verdict":{"decision":"allow"},"unknown":{}}"#,
            r#"{"decision":"allow","verdict":{"decision":"allow"}}"#,
            r#"{"receipt":{}}"#,
            r#"{"verdict":{"decision":"allow"},"receipt":"x"}"#,
            r#"{"verdict":{"decision":"allow"},"extensions":{"Bad-Name":{}}}"#,
            r#"{"verdict":{"decision":"allow"},"verdict":{"decision":"deny"}}"#,
        ] {
            assert!(InterceptorResponse::from_json(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn metadata_bound_is_enforced() {
        let raw = json!({
            "verdict": {"decision": "allow"},
            "extensions": {"provider": {"padding": "x".repeat(RESPONSE_METADATA_MAX_BYTES)}}
        });
        assert!(InterceptorResponse::from_wire(&raw).is_err());
    }
}
