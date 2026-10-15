// Copyright (c) Microsoft. All rights reserved.

use agent_hooks::{ffi_surface, HostError, InterceptorResponse};
use serde_json::{json, Value};

#[test]
fn shared_interceptor_response_fixtures() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../conformance/golden/interceptor-response.json"
    ))
    .unwrap();
    for case in fixture["valid"].as_array().unwrap() {
        let parsed = InterceptorResponse::from_json(case["input"].as_str().unwrap()).unwrap();
        assert_eq!(
            parsed.to_envelope_value(),
            serde_json::from_str::<Value>(case["normalized"].as_str().unwrap()).unwrap(),
            "{}",
            case["name"]
        );
    }
    for case in fixture["invalid"].as_array().unwrap() {
        let error = ffi_surface::normalize_interceptor_response(case["input"].as_str().unwrap())
            .unwrap_err();
        assert_eq!(
            error.0,
            fixture["invalid_error"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
    for case in fixture["metadata_bounds"].as_array().unwrap() {
        let mut input = json!({
            "verdict": {"decision": "allow"},
            "extensions": {"provider": {"receipt": {
                "p": "x".repeat(case["padding"].as_u64().unwrap() as usize)
            }}}
        });
        if case["second_provider"].as_bool().unwrap() {
            input["extensions"]["second"] = json!({});
        }
        let bytes = agent_hooks::canonical_json(&input["extensions"]).len();
        assert_eq!(bytes, case["bytes"].as_u64().unwrap() as usize);
        let result = InterceptorResponse::from_json(&input.to_string());
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        if let Err((error, _)) = result {
            assert_eq!(error, HostError::VerdictInvalid);
        }
    }
}

#[test]
fn strict_and_response_gates_agree_on_invalid_bare_verdicts() {
    for input in [
        r#"{"decision":"allow","foo":1}"#,
        r#"{"decision":"allow","decision":"deny"}"#,
        r#"{"decision":"allow","evidence":{"unexpected":true}}"#,
        r#"{"decision":"allow","warnings":[{"unexpected":true}]}"#,
        r#"{"decision":"transform","transform":{"path":"$target","extra":true}}"#,
        r#"{"decision":"#,
    ] {
        assert_eq!(
            ffi_surface::validate_verdict(input).unwrap_err().0,
            ffi_surface::normalize_interceptor_response(input)
                .unwrap_err()
                .0
        );
    }
}

#[test]
fn parsed_metadata_rejects_unsafe_integers_and_excessive_depth() {
    let value = json!({
        "verdict": {"decision": "allow"},
        "extensions": {"provider": {"receipt": {"n": 9_007_199_254_740_993_u64}}}
    });
    assert_eq!(
        InterceptorResponse::from_wire(&value).unwrap_err().0,
        HostError::VerdictInvalid
    );
    let mut receipt = Value::Null;
    for _ in 0..200 {
        receipt = json!({"nested": receipt});
    }
    let value =
        json!({"verdict": {"decision": "allow"}, "extensions": {"provider": {"receipt": receipt}}});
    assert_eq!(
        InterceptorResponse::from_wire(&value).unwrap_err().0,
        HostError::VerdictInvalid
    );
}

#[test]
fn rejected_member_names_do_not_amplify_error_details() {
    let key = "x".repeat(1_000_000);
    for input in [
        json!({"verdict": {"decision": "allow"}, &key: null}),
        json!({"verdict": {"decision": "allow"}, "extensions": {&key: null}}),
    ] {
        let (_, detail) = InterceptorResponse::from_wire(&input).unwrap_err();
        assert!(detail.len() < 256);
    }
    let input = format!(r#"{{"decision":"allow","{key}":1,"{key}":2}}"#);
    assert!(InterceptorResponse::from_json(&input).unwrap_err().1.len() < 256);
}
