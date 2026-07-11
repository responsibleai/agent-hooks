// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! napi-rs bindings: `@responsibleai/agent-hooks` native module.
//!
//! Thin wrapper over `agent_hooks::ffi_surface`. All functions take and
//! return JS strings (UTF-8 JSON); errors throw a JS `Error` with
//! `.code` set to the §11 `host_error:*` string.

#![deny(clippy::all)]

use agent_hooks::ffi_surface as core;
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
pub fn apply_transform_ctx(
    ctx_json: String,
    path: String,
    value_json: String,
) -> Result<String> {
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
