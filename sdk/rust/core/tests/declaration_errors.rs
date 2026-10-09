// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! §7.7.6 registry consistency: the `declaration_error:*` codes the
//! loader emits MUST be exactly the set enumerated in
//! `spec/declaration-errors.json`, in pipeline order. The tripwire
//! against silent drift in either direction, like
//! `reserved_reasons.rs` for §11.

use agent_hooks::DeclarationErrorClass;

#[test]
fn declaration_error_classes_match_registry() {
    let registry: serde_json::Value =
        serde_json::from_str(include_str!("../../../../spec/declaration-errors.json"))
            .expect("spec/declaration-errors.json parses");
    let registered: Vec<(String, u64)> = registry["classes"]
        .as_array()
        .expect("classes array")
        .iter()
        .map(|c| {
            (
                c["id"].as_str().expect("class id").to_owned(),
                c["step"].as_u64().expect("class step"),
            )
        })
        .collect();
    let emitted: Vec<(String, u64)> = DeclarationErrorClass::ALL
        .iter()
        .enumerate()
        .map(|(i, c)| (c.code().to_owned(), i as u64 + 1))
        .collect();
    assert_eq!(
        emitted, registered,
        "core DeclarationErrorClass codes and spec/declaration-errors.json diverged"
    );
    // `conformance/vectors.schema.json` repeats the codes by hand in
    // `expect.load.class`; a class added to one file must reach the
    // other.
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("../../../../conformance/vectors.schema.json"))
            .expect("conformance/vectors.schema.json parses");
    let schema_classes: Vec<String> = schema["$defs"]["expect"]["properties"]["load"]["properties"]
        ["class"]["enum"]
        .as_array()
        .expect("expect.load.class enum")
        .iter()
        .map(|v| v.as_str().expect("class string").to_owned())
        .collect();
    let codes: Vec<String> = emitted.iter().map(|(c, _)| c.clone()).collect();
    assert_eq!(
        schema_classes, codes,
        "conformance/vectors.schema.json expect.load.class enum and DeclarationErrorClass diverged"
    );
    // Every class is distinct from the §11 reason namespace.
    for c in DeclarationErrorClass::ALL {
        assert!(c.code().starts_with("declaration_error:"));
        assert_eq!(DeclarationErrorClass::from_code(c.code()), Some(c));
    }
}
