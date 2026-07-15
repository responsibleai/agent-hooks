// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! `$target` JSONPath subset: parse, resolve, apply transforms (§5.2).
//!
//! Grammar per `spec/schema/path-grammar.abnf`: root + dot-member +
//! bracket-index + bracket-member only.

use crate::types::HostError;
use serde_json::Value;

/// A parsed path segment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Member(String),
    Index(usize),
}

/// Parse a §5.2 path into segments.
///
/// Returns `TransformTargetForbidden` if the path is not rooted at `$target`
/// (or the deprecated `$policy_target` alias), and `TransformInvalid` on any
/// other parse failure.
pub fn parse(path: &str) -> Result<Vec<Segment>, HostError> {
    let rest = path
        .strip_prefix("$target")
        .or_else(|| path.strip_prefix("$policy_target"))
        .ok_or(HostError::TransformTargetForbidden)?;

    let mut segs = Vec::new();
    let bytes = rest.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'.' => {
                i += 1;
                let start = i;
                while i < bytes.len() && is_member_char(bytes[i]) {
                    i += 1;
                }
                if i == start {
                    return Err(HostError::TransformInvalid);
                }
                segs.push(Segment::Member(rest[start..i].to_string()));
            }
            b'[' => {
                i += 1;
                if i < bytes.len() && bytes[i] == b'"' {
                    // ["member"]
                    i += 1;
                    let start = i;
                    while i < bytes.len() && bytes[i] != b'"' {
                        if !is_member_char(bytes[i]) {
                            return Err(HostError::TransformInvalid);
                        }
                        i += 1;
                    }
                    if i + 1 >= bytes.len() || bytes[i] != b'"' || bytes[i + 1] != b']' {
                        return Err(HostError::TransformInvalid);
                    }
                    segs.push(Segment::Member(rest[start..i].to_string()));
                    i += 2;
                } else {
                    // [index]
                    let start = i;
                    while i < bytes.len() && bytes[i].is_ascii_digit() {
                        i += 1;
                    }
                    if i == start || i >= bytes.len() || bytes[i] != b']' {
                        return Err(HostError::TransformInvalid);
                    }
                    let idx: usize = rest[start..i]
                        .parse()
                        .map_err(|_| HostError::TransformInvalid)?;
                    segs.push(Segment::Index(idx));
                    i += 1;
                }
            }
            _ => return Err(HostError::TransformInvalid),
        }
    }
    Ok(segs)
}

fn is_member_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// Return the value at `path` within `target`.
pub fn resolve<'a>(target: &'a Value, path: &str) -> Result<&'a Value, HostError> {
    let mut cur = target;
    for seg in parse(path)? {
        cur = step(cur, &seg)?;
    }
    Ok(cur)
}

fn step<'a>(cur: &'a Value, seg: &Segment) -> Result<&'a Value, HostError> {
    match (cur, seg) {
        (Value::Object(m), Segment::Member(k)) => m.get(k).ok_or(HostError::TransformInvalid),
        (Value::Array(a), Segment::Index(i)) => a.get(*i).ok_or(HostError::TransformInvalid),
        _ => Err(HostError::TransformInvalid),
    }
}

/// Return `target` with the value at `path` replaced by `value`.
///
/// Takes ownership of `target` and returns the new target. When `path`
/// is the bare root, `value` is returned directly.
pub fn apply(mut target: Value, path: &str, value: Value) -> Result<Value, HostError> {
    let segs = parse(path)?;
    if segs.is_empty() {
        return Ok(value);
    }
    {
        let mut cur = &mut target;
        for seg in &segs[..segs.len() - 1] {
            cur = step_mut(cur, seg)?;
        }
        match (&mut *cur, &segs[segs.len() - 1]) {
            (Value::Object(m), Segment::Member(k)) => {
                if !m.contains_key(k) {
                    return Err(HostError::TransformInvalid);
                }
                m.insert(k.clone(), value);
            }
            (Value::Array(a), Segment::Index(i)) => {
                let slot = a.get_mut(*i).ok_or(HostError::TransformInvalid)?;
                *slot = value;
            }
            _ => return Err(HostError::TransformInvalid),
        }
    }
    Ok(target)
}

fn step_mut<'a>(cur: &'a mut Value, seg: &Segment) -> Result<&'a mut Value, HostError> {
    match (cur, seg) {
        (Value::Object(m), Segment::Member(k)) => m.get_mut(k).ok_or(HostError::TransformInvalid),
        (Value::Array(a), Segment::Index(i)) => a.get_mut(*i).ok_or(HostError::TransformInvalid),
        _ => Err(HostError::TransformInvalid),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn root_only() {
        assert_eq!(parse("$target").unwrap(), vec![]);
    }

    #[test]
    fn dot_and_index() {
        assert_eq!(
            parse("$target.a.b[0].c").unwrap(),
            vec![
                Segment::Member("a".into()),
                Segment::Member("b".into()),
                Segment::Index(0),
                Segment::Member("c".into()),
            ]
        );
    }

    #[test]
    fn bracket_member() {
        assert_eq!(
            parse(r#"$target["weird-key"]"#).unwrap(),
            vec![Segment::Member("weird-key".into())]
        );
    }

    #[test]
    fn policy_target_alias() {
        assert_eq!(
            parse("$policy_target.x").unwrap(),
            vec![Segment::Member("x".into())]
        );
    }

    #[test]
    fn foreign_root_forbidden() {
        assert_eq!(
            parse("$snapshot.x"),
            Err(HostError::TransformTargetForbidden)
        );
    }

    #[test]
    fn resolve_and_apply() {
        let t = json!({"a": {"b": [10, 20]}});
        assert_eq!(*resolve(&t, "$target.a.b[1]").unwrap(), json!(20));
        let t2 = apply(t, "$target.a.b[1]", json!(99)).unwrap();
        assert_eq!(t2["a"]["b"][1], json!(99));
    }

    #[test]
    fn apply_root() {
        let out = apply(json!({"x": 1}), "$target", json!("new")).unwrap();
        assert_eq!(out, json!("new"));
    }

    #[test]
    fn apply_unresolvable() {
        assert_eq!(
            apply(json!({"a": 1}), "$target.missing.deeper", json!(0)),
            Err(HostError::TransformInvalid)
        );
    }

    #[test]
    fn apply_missing_leaf() {
        assert_eq!(
            apply(json!({"a": 1}), "$target.b", json!(0)),
            Err(HostError::TransformInvalid)
        );
    }
}
