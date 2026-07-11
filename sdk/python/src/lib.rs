// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! PyO3 bindings: `agent_hooks._core`.
//!
//! Thin wrapper over `agent_hooks::ffi_surface`. All functions take and
//! return Python `str` (UTF-8 JSON); errors raise `AgentHooksCoreError`
//! with `.code` set to the §11 `host_error:*` string.

use agent_hooks::ffi_surface as core;
use pyo3::create_exception;
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;

create_exception!(_core, AgentHooksCoreError, PyValueError);

fn map_err(py: Python<'_>, e: core::FfiError) -> PyErr {
    let (code, detail) = e;
    let exc = AgentHooksCoreError::new_err(format!("{code}: {detail}"));
    // Attach .code so the Python wrapper can map to HostError enum without
    // parsing the message.
    let _ = exc.value(py).setattr("code", code);
    exc
}

#[pyfunction]
fn spec_version() -> &'static str {
    core::spec_version()
}

#[pyfunction]
fn canonical_json(py: Python<'_>, value_json: &str) -> PyResult<String> {
    core::canonical_json(value_json).map_err(|e| map_err(py, e))
}

#[pyfunction]
fn context_identity(py: Python<'_>, ctx_json: &str) -> PyResult<String> {
    core::context_identity(ctx_json).map_err(|e| map_err(py, e))
}

#[pyfunction]
fn validate_verdict(py: Python<'_>, verdict_json: &str) -> PyResult<String> {
    core::validate_verdict(verdict_json).map_err(|e| map_err(py, e))
}

/// §4/§6.3: envelope validation (fail closed, value-free detail).
#[pyfunction]
fn validate_envelope(py: Python<'_>, ctx_json: &str) -> PyResult<String> {
    core::validate_envelope(ctx_json).map_err(|e| map_err(py, e))
}

#[pyfunction]
fn apply_transform(
    py: Python<'_>,
    target_json: &str,
    path: &str,
    value_json: &str,
) -> PyResult<String> {
    core::apply_transform(target_json, path, value_json).map_err(|e| map_err(py, e))
}

#[pyfunction]
fn apply_transform_ctx(
    py: Python<'_>,
    ctx_json: &str,
    path: &str,
    value_json: &str,
) -> PyResult<String> {
    core::apply_transform_ctx(ctx_json, path, value_json).map_err(|e| map_err(py, e))
}

#[pyfunction]
fn validate_transform_ctx(
    py: Python<'_>,
    ctx_json: &str,
    path: &str,
    value_json: &str,
) -> PyResult<String> {
    core::validate_transform_ctx(ctx_json, path, value_json).map_err(|e| map_err(py, e))
}

#[pyfunction]
fn finalize(
    py: Python<'_>,
    ctx_json: &str,
    verdict_json: &str,
    mode: &str,
    options_json: &str,
) -> PyResult<String> {
    core::finalize(ctx_json, verdict_json, mode, options_json).map_err(|e| map_err(py, e))
}

#[pyfunction]
fn compose_aggregate(
    py: Python<'_>,
    composition_json: &str,
    verdicts_json: &str,
) -> PyResult<String> {
    core::compose_aggregate(composition_json, verdicts_json).map_err(|e| map_err(py, e))
}

// ---- CTK engine (§13.2) ---------------------------------------------------

#[pyfunction]
fn ctk_scripted_intercept(py: Python<'_>, rules_json: &str, ctx_json: &str) -> PyResult<String> {
    core::ctk_scripted_intercept(rules_json, ctx_json).map_err(|e| map_err(py, e))
}

#[pyfunction]
fn ctk_scripted_resolve(
    py: Python<'_>,
    rules_json: &str,
    ctx_json: &str,
    identity: &str,
) -> PyResult<String> {
    core::ctk_scripted_resolve(rules_json, ctx_json, identity).map_err(|e| map_err(py, e))
}

#[pyfunction]
fn ctk_should_skip(
    py: Python<'_>,
    vector_json: &str,
    harness_caps_json: &str,
) -> PyResult<String> {
    core::ctk_should_skip(vector_json, harness_caps_json).map_err(|e| map_err(py, e))
}

#[pyfunction]
fn ctk_assert(
    py: Python<'_>,
    vector_json: &str,
    recorded_json: &str,
    run_record_json: &str,
) -> PyResult<String> {
    core::ctk_assert(vector_json, recorded_json, run_record_json).map_err(|e| map_err(py, e))
}

#[pymodule]
fn _core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("SPEC_VERSION", core::spec_version())?;
    m.add("AgentHooksCoreError", m.py().get_type::<AgentHooksCoreError>())?;
    m.add_function(wrap_pyfunction!(spec_version, m)?)?;
    m.add_function(wrap_pyfunction!(canonical_json, m)?)?;
    m.add_function(wrap_pyfunction!(context_identity, m)?)?;
    m.add_function(wrap_pyfunction!(validate_verdict, m)?)?;
    m.add_function(wrap_pyfunction!(validate_envelope, m)?)?;
    m.add_function(wrap_pyfunction!(apply_transform, m)?)?;
    m.add_function(wrap_pyfunction!(apply_transform_ctx, m)?)?;
    m.add_function(wrap_pyfunction!(validate_transform_ctx, m)?)?;
    m.add_function(wrap_pyfunction!(finalize, m)?)?;
    m.add_function(wrap_pyfunction!(compose_aggregate, m)?)?;
    m.add_function(wrap_pyfunction!(ctk_scripted_intercept, m)?)?;
    m.add_function(wrap_pyfunction!(ctk_scripted_resolve, m)?)?;
    m.add_function(wrap_pyfunction!(ctk_should_skip, m)?)?;
    m.add_function(wrap_pyfunction!(ctk_assert, m)?)?;
    Ok(())
}
