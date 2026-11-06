// Copyright (c) Microsoft. All rights reserved.

//! §7.7.6 registry consistency: the `declaration_error:*` codes the
//! loader emits MUST be exactly the set enumerated in
//! `declaration-errors.json` of every specification bundle this build
//! supports, in pipeline order. The tripwire against silent drift in
//! either direction, like `reserved_reasons.rs` for §11. The released
//! bundles gate; the draft's inventory is checked by the `draft_only_*`
//! test, which the advisory job runs.

use agent_hooks::{DeclarationErrorClass, SpecVersion};

mod common;
use common::spec_file;

fn emitted_classes() -> Vec<(String, u64)> {
    DeclarationErrorClass::ALL
        .iter()
        .enumerate()
        .map(|(i, c)| (c.code().to_owned(), i as u64 + 1))
        .collect()
}

fn declaration_error_classes_match_registry_of(spec: SpecVersion) {
    let registry: serde_json::Value =
        serde_json::from_str(&spec_file(spec, "declaration-errors.json"))
            .expect("declaration-errors.json parses");
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
    assert_eq!(
        emitted_classes(),
        registered,
        "core DeclarationErrorClass codes and {}/declaration-errors.json diverged",
        spec.bundle_dir()
    );
}

#[test]
fn declaration_error_classes_match_registry() {
    for spec in SpecVersion::RELEASED {
        declaration_error_classes_match_registry_of(*spec);
    }
    // `conformance/0.1/vectors.schema.json` repeats the codes by hand in
    // `expect.load.class`; a class added to one file must reach the
    // other.
    let schema: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../conformance/0.1/vectors.schema.json"
    ))
    .expect("conformance/0.1/vectors.schema.json parses");
    let schema_classes: Vec<String> = schema["$defs"]["expect"]["properties"]["load"]["properties"]
        ["class"]["enum"]
        .as_array()
        .expect("expect.load.class enum")
        .iter()
        .map(|v| v.as_str().expect("class string").to_owned())
        .collect();
    let codes: Vec<String> = emitted_classes().iter().map(|(c, _)| c.clone()).collect();
    assert_eq!(
        schema_classes, codes,
        "conformance/0.1/vectors.schema.json expect.load.class enum and DeclarationErrorClass diverged"
    );
    // Every class is distinct from the §11 reason namespace.
    for c in DeclarationErrorClass::ALL {
        assert!(c.code().starts_with("declaration_error:"));
        assert_eq!(DeclarationErrorClass::from_code(c.code()), Some(c));
    }
}

#[test]
fn draft_only_declaration_error_classes_match_registry() {
    declaration_error_classes_match_registry_of(SpecVersion::Draft);
}
