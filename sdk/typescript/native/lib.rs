// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! napi-rs bindings: `@responsibleai/agent-hooks` native module.
//!
//! Thin wrapper over `agent_hooks::ffi_surface`. All functions take and
//! return JS strings (UTF-8 JSON); errors throw a JS `Error` with
//! `.code` set to the §11 `host_error:*` string, or to a §7.7.6
//! `declaration_error:*` string for the host declaration functions
//! (the detail is then JSON findings).
//!
//! Two of the declaration functions (`declaration_validate`,
//! `declaration_resolve_surface`) have no C ABI twin: they call the
//! core's `HostDeclaration::from_json` and `resolve_surface_only`
//! directly so the TypeScript loader can run steps 2 to 7 on their own
//! and the CTK runner can resolve a harness's own document without a
//! registry, exactly as the Rust runner does.

#![deny(clippy::all)]

use agent_hooks::declaration::{resolve_surface_only, DeclarationError, HostSurface};
use agent_hooks::ffi_surface as core;
use agent_hooks::HostDeclaration;
use napi::{Error, Result, Status};
use napi_derive::napi;

fn map_err(e: core::FfiError) -> Error {
    let (code, detail) = e;
    let mut err = Error::new(Status::GenericFailure, format!("{code}: {detail}"));
    // napi::Error doesn't have a public code setter that maps to JS
    // `.code`, so encode it in the reason and let the JS wrapper split.
    err.reason = format!("{code}\u{001f}{detail}");
    err
}

#[napi]
pub fn spec_version() -> &'static str {
    core::spec_version()
}

#[napi]
pub fn canonical_json(value_json: String) -> Result<String> {
    core::canonical_json(&value_json).map_err(map_err)
}

#[napi]
pub fn context_identity(ctx_json: String) -> Result<String> {
    core::context_identity(&ctx_json).map_err(map_err)
}

#[napi]
pub fn validate_verdict(verdict_json: String) -> Result<String> {
    core::validate_verdict(&verdict_json).map_err(map_err)
}

/// §4/§6.3: envelope validation (fail closed, value-free detail).
#[napi]
pub fn validate_envelope(ctx_json: String) -> Result<String> {
    core::validate_envelope(&ctx_json).map_err(map_err)
}

#[napi]
pub fn apply_transform(target_json: String, path: String, value_json: String) -> Result<String> {
    core::apply_transform(&target_json, &path, &value_json).map_err(map_err)
}

#[napi]
pub fn apply_transform_ctx(ctx_json: String, path: String, value_json: String) -> Result<String> {
    core::apply_transform_ctx(&ctx_json, &path, &value_json).map_err(map_err)
}

#[napi]
pub fn validate_transform_ctx(
    ctx_json: String,
    path: String,
    value_json: String,
) -> Result<String> {
    core::validate_transform_ctx(&ctx_json, &path, &value_json).map_err(map_err)
}

#[napi]
pub fn finalize(
    ctx_json: String,
    verdict_json: String,
    mode: String,
    options_json: String,
) -> Result<String> {
    core::finalize(&ctx_json, &verdict_json, &mode, &options_json).map_err(map_err)
}

#[napi]
pub fn compose_aggregate(composition_json: String, verdicts_json: String) -> Result<String> {
    core::compose_aggregate(&composition_json, &verdicts_json).map_err(map_err)
}

// ---- host declaration (§7.7) ----------------------------------------------

fn decl_err(e: DeclarationError) -> Error {
    map_err((e.code().to_owned(), e.detail_json()))
}

/// `{"current": "...", "supported": [...]}` (§7.7.2).
#[napi]
pub fn declaration_versions() -> String {
    core::declaration_versions()
}

/// Steps 2 to 7 of §7.7.6 over JSON text. Returns the validated
/// document as JSON (verbatim, `$schema` included).
#[napi]
pub fn declaration_validate(document_json: String) -> Result<String> {
    HostDeclaration::from_json(&document_json)
        .map(|d| d.as_value().to_string())
        .map_err(decl_err)
}

/// Steps 2 to 10 of §7.7.6 against the wrapper's host description
/// (`{surface, identity_providers, approval_resolvers,
/// approval_redactors, kinds}`). Returns the resolved declaration JSON.
#[napi]
pub fn declaration_resolve(document_json: String, host_json: String) -> Result<String> {
    core::declaration_resolve(&document_json, &host_json).map_err(map_err)
}

/// Steps 2 to 8 of §7.7.6 against a code surface alone, no registry:
/// what the CTK runner needs to read a harness's own document
/// (§7.7.9). A surface that does not parse or that the core rejects is
/// a wrapper defect and comes back as `marshal_error`, never as a
/// refusal of the document.
#[napi]
pub fn declaration_resolve_surface(document_json: String, surface_json: String) -> Result<String> {
    let surface: HostSurface = serde_json::from_str(&surface_json).map_err(|e| {
        map_err((
            "marshal_error".to_owned(),
            format!("host surface does not parse: {e}"),
        ))
    })?;
    surface.validate().map_err(|e| {
        let detail: Vec<String> = e
            .findings
            .iter()
            .map(|f| format!("{} {}", f.pointer, f.detail))
            .collect();
        map_err((
            "marshal_error".to_owned(),
            format!("host surface is invalid: {}", detail.join("; ")),
        ))
    })?;
    let document = HostDeclaration::from_json(&document_json).map_err(decl_err)?;
    let resolved = resolve_surface_only(&document, &surface).map_err(decl_err)?;
    serde_json::to_string(&resolved)
        .map_err(|e| map_err(("marshal_error".to_owned(), e.to_string())))
}

// ---- CTK engine (§13.2) ---------------------------------------------------

#[napi]
pub fn ctk_scripted_intercept(rules_json: String, ctx_json: String) -> Result<String> {
    core::ctk_scripted_intercept(&rules_json, &ctx_json).map_err(map_err)
}

#[napi]
pub fn ctk_scripted_resolve(
    rules_json: String,
    ctx_json: String,
    identity: String,
) -> Result<String> {
    core::ctk_scripted_resolve(&rules_json, &ctx_json, &identity).map_err(map_err)
}

#[napi]
pub fn ctk_should_skip(vector_json: String, harness_caps_json: String) -> Result<String> {
    core::ctk_should_skip(&vector_json, &harness_caps_json).map_err(map_err)
}

#[napi]
pub fn ctk_assert(
    vector_json: String,
    recorded_json: String,
    run_record_json: String,
) -> Result<String> {
    core::ctk_assert(&vector_json, &recorded_json, &run_record_json).map_err(map_err)
}
