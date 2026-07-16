// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! C-ABI over `agent_hooks::ffi_surface` for Go (cgo) and .NET (P/Invoke).
//!
//! Every function takes NUL-terminated UTF-8 C strings and returns a
//! heap-allocated `AhResult*` that the caller MUST free with
//! `ah_free_result`. `ok=1` means `value` holds the JSON result; `ok=0`
//! means `error_code` holds the error code and `value` holds a detail
//! message. The code is a §11 `host_error:*` string for contract
//! failures, or one of two boundary codes: `marshal_error` (an argument
//! was not valid UTF-8, or a result could not cross the boundary) and
//! `panic` (a defect in the core; the process is NOT aborted — every
//! entry point is wrapped in `catch_unwind`, because since Rust 1.81 a
//! panic unwinding through an `extern "C"` boundary aborts the host
//! process).
//!
//! Marshalling is fail-closed: invalid UTF-8 is an explicit error, not
//! a silent empty string; a null pointer is accepted as the empty
//! string (bindings pass `""` for optional arguments and the two must
//! stay equivalent).

use agent_hooks::ffi_surface as core;
use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, UnwindSafe};

/// `(code, detail)` — mirrors `ffi_surface::FfiError` plus the two
/// boundary codes documented above.
type Out = Result<String, (String, String)>;

#[repr(C)]
pub struct AhResult {
    /// 1 on success, 0 on error.
    pub ok: u8,
    /// On success: the JSON result. On error: the detail message.
    pub value: *mut c_char,
    /// On error: the error code (see crate docs). Null on success.
    pub error_code: *mut c_char,
}

/// Convert with an explicit failure path: a string that cannot become a
/// CString must never be returned as a silent-empty success.
fn c_string_or(s: String, fallback: &'static str) -> *mut c_char {
    CString::new(s)
        .unwrap_or_else(|_| CString::new(fallback).expect("static fallback has no NUL"))
        .into_raw()
}

fn boxed(r: Out) -> *mut AhResult {
    // Serialized JSON from serde never contains a raw NUL (control
    // characters are escaped), so this arm is defensive only — but it
    // must flip to an error rather than truncate the value.
    let r = r.and_then(|v| match CString::new(v) {
        Ok(c) => Ok(c),
        Err(_) => Err((
            "marshal_error".to_owned(),
            "result contains an interior NUL byte".to_owned(),
        )),
    });
    let out = match r {
        Ok(c) => AhResult {
            ok: 1,
            value: c.into_raw(),
            error_code: std::ptr::null_mut(),
        },
        Err((code, detail)) => AhResult {
            ok: 0,
            value: c_string_or(detail, "detail contained an interior NUL byte"),
            error_code: c_string_or(code, "marshal_error"),
        },
    };
    Box::into_raw(Box::new(out))
}

/// Marshal one C string argument. Null is the empty string (see crate
/// docs); invalid UTF-8 is an explicit `marshal_error`.
///
/// # Safety
/// `p` must be null or a valid NUL-terminated C string.
unsafe fn from_c<'a>(p: *const c_char, what: &str) -> Result<&'a str, (String, String)> {
    if p.is_null() {
        return Ok("");
    }
    CStr::from_ptr(p).to_str().map_err(|_| {
        (
            "marshal_error".to_owned(),
            format!("{what}: argument is not valid UTF-8"),
        )
    })
}

/// Run `f` under `catch_unwind` so no panic crosses the C boundary.
fn guarded<F>(f: F) -> *mut AhResult
where
    F: FnOnce() -> Out + UnwindSafe,
{
    match catch_unwind(f) {
        Ok(r) => boxed(r),
        Err(payload) => {
            let mut msg = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_owned())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "non-string panic payload".to_owned());
            msg.truncate(200);
            boxed(Err(("panic".to_owned(), format!("core panicked: {msg}"))))
        }
    }
}

fn core_err(e: core::FfiError) -> (String, String) {
    e
}

/// Free an `AhResult*` returned by any `ah_*` function.
///
/// # Safety
/// `r` must be a pointer previously returned by an `ah_*` function and not
/// yet freed.
#[no_mangle]
pub unsafe extern "C" fn ah_free_result(r: *mut AhResult) {
    if r.is_null() {
        return;
    }
    let b = Box::from_raw(r);
    if !b.value.is_null() {
        drop(CString::from_raw(b.value));
    }
    if !b.error_code.is_null() {
        drop(CString::from_raw(b.error_code));
    }
}

/// Return the spec version string. Caller must NOT free the returned
/// pointer (it is static).
#[no_mangle]
pub extern "C" fn ah_spec_version() -> *const c_char {
    static V: &str = concat!("agent-hooks/0.1", "\0");
    V.as_ptr() as *const c_char
}

/// §10.1
///
/// # Safety
/// `value_json` must be null or a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn ah_canonical_json(value_json: *const c_char) -> *mut AhResult {
    let a = from_c(value_json, "value_json");
    guarded(move || core::canonical_json(a?).map_err(core_err))
}

/// §10.2
///
/// # Safety
/// `ctx_json` must be null or a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn ah_context_identity(ctx_json: *const c_char) -> *mut AhResult {
    let a = from_c(ctx_json, "ctx_json");
    guarded(move || core::context_identity(a?).map_err(core_err))
}

/// §5
///
/// # Safety
/// `verdict_json` must be null or a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn ah_validate_verdict(verdict_json: *const c_char) -> *mut AhResult {
    let a = from_c(verdict_json, "verdict_json");
    guarded(move || core::validate_verdict(a?).map_err(core_err))
}

/// §4/§6.3: envelope validation. Ok(empty string) on a valid envelope;
/// the error detail is value-free.
///
/// # Safety
/// `ctx_json` must be null or a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn ah_validate_envelope(ctx_json: *const c_char) -> *mut AhResult {
    let a = from_c(ctx_json, "ctx_json");
    guarded(move || core::validate_envelope(a?).map_err(core_err))
}

/// §5.2
///
/// # Safety
/// All pointers must be null or valid NUL-terminated C strings.
#[no_mangle]
pub unsafe extern "C" fn ah_apply_transform(
    target_json: *const c_char,
    path: *const c_char,
    value_json: *const c_char,
) -> *mut AhResult {
    let a = from_c(target_json, "target_json");
    let b = from_c(path, "path");
    let c = from_c(value_json, "value_json");
    guarded(move || core::apply_transform(a?, b?, c?).map_err(core_err))
}

/// §7.4 fold-through
///
/// # Safety
/// All pointers must be null or valid NUL-terminated C strings.
#[no_mangle]
pub unsafe extern "C" fn ah_apply_transform_ctx(
    ctx_json: *const c_char,
    path: *const c_char,
    value_json: *const c_char,
) -> *mut AhResult {
    let a = from_c(ctx_json, "ctx_json");
    let b = from_c(path, "path");
    let c = from_c(value_json, "value_json");
    guarded(move || core::apply_transform_ctx(a?, b?, c?).map_err(core_err))
}

/// §8 evaluate_only transform validation
///
/// # Safety
/// All pointers must be null or valid NUL-terminated C strings.
#[no_mangle]
pub unsafe extern "C" fn ah_validate_transform_ctx(
    ctx_json: *const c_char,
    path: *const c_char,
    value_json: *const c_char,
) -> *mut AhResult {
    let a = from_c(ctx_json, "ctx_json");
    let b = from_c(path, "path");
    let c = from_c(value_json, "value_json");
    guarded(move || core::validate_transform_ctx(a?, b?, c?).map_err(core_err))
}

/// §10.3 finalize. `options_json` carries identities, provider,
/// decided_by, composition, verdict summaries, fold_truncated, and
/// resolved_by (see `ffi_surface::finalize`).
///
/// # Safety
/// All pointers must be null or valid NUL-terminated C strings.
#[no_mangle]
pub unsafe extern "C" fn ah_finalize(
    ctx_json: *const c_char,
    verdict_json: *const c_char,
    mode: *const c_char,
    options_json: *const c_char,
) -> *mut AhResult {
    let a = from_c(ctx_json, "ctx_json");
    let b = from_c(verdict_json, "verdict_json");
    let c = from_c(mode, "mode");
    let d = from_c(options_json, "options_json");
    guarded(move || core::finalize(a?, b?, c?, d?).map_err(core_err))
}

/// §7.3/§7.5 aggregation for multi-verdict profiles (see
/// `ffi_surface::compose_aggregate`).
///
/// # Safety
/// All pointers must be null or valid NUL-terminated C strings.
#[no_mangle]
pub unsafe extern "C" fn ah_compose_aggregate(
    composition_json: *const c_char,
    verdicts_json: *const c_char,
) -> *mut AhResult {
    let a = from_c(composition_json, "composition_json");
    let b = from_c(verdicts_json, "verdicts_json");
    guarded(move || core::compose_aggregate(a?, b?).map_err(core_err))
}

// ---- CTK engine (§13.2) ----------------------------------------------------

/// # Safety
/// All pointers must be null or valid NUL-terminated C strings.
#[no_mangle]
pub unsafe extern "C" fn ah_ctk_scripted_intercept(
    rules_json: *const c_char,
    ctx_json: *const c_char,
) -> *mut AhResult {
    let a = from_c(rules_json, "rules_json");
    let b = from_c(ctx_json, "ctx_json");
    guarded(move || core::ctk_scripted_intercept(a?, b?).map_err(core_err))
}

/// # Safety
/// All pointers must be null or valid NUL-terminated C strings.
#[no_mangle]
pub unsafe extern "C" fn ah_ctk_scripted_resolve(
    rules_json: *const c_char,
    ctx_json: *const c_char,
    identity: *const c_char,
) -> *mut AhResult {
    let a = from_c(rules_json, "rules_json");
    let b = from_c(ctx_json, "ctx_json");
    let c = from_c(identity, "identity");
    guarded(move || core::ctk_scripted_resolve(a?, b?, c?).map_err(core_err))
}

/// # Safety
/// All pointers must be null or valid NUL-terminated C strings.
#[no_mangle]
pub unsafe extern "C" fn ah_ctk_should_skip(
    vector_json: *const c_char,
    harness_caps_json: *const c_char,
) -> *mut AhResult {
    let a = from_c(vector_json, "vector_json");
    let b = from_c(harness_caps_json, "harness_caps_json");
    guarded(move || core::ctk_should_skip(a?, b?).map_err(core_err))
}

/// # Safety
/// All pointers must be null or valid NUL-terminated C strings.
#[no_mangle]
pub unsafe extern "C" fn ah_ctk_assert(
    vector_json: *const c_char,
    recorded_json: *const c_char,
    run_record_json: *const c_char,
) -> *mut AhResult {
    let a = from_c(vector_json, "vector_json");
    let b = from_c(recorded_json, "recorded_json");
    let c = from_c(run_record_json, "run_record_json");
    guarded(move || core::ctk_assert(a?, b?, c?).map_err(core_err))
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe fn call1(
        f: unsafe extern "C" fn(*const c_char) -> *mut AhResult,
        arg: &[u8],
    ) -> (u8, String, String) {
        let c = CString::new(arg).unwrap();
        let r = f(c.as_ptr());
        let ok = (*r).ok;
        let value = if (*r).value.is_null() {
            String::new()
        } else {
            CStr::from_ptr((*r).value).to_string_lossy().into_owned()
        };
        let code = if (*r).error_code.is_null() {
            String::new()
        } else {
            CStr::from_ptr((*r).error_code)
                .to_string_lossy()
                .into_owned()
        };
        ah_free_result(r);
        (ok, value, code)
    }

    #[test]
    fn invalid_utf8_is_explicit_marshal_error() {
        // A lone 0xFF byte is not valid UTF-8; previously this was
        // laundered into "" and reported as a JSON parse error.
        let bytes = CString::new(vec![0xFFu8]).unwrap();
        unsafe {
            let r = ah_canonical_json(bytes.as_ptr());
            assert_eq!((*r).ok, 0);
            let code = CStr::from_ptr((*r).error_code).to_str().unwrap();
            assert_eq!(code, "marshal_error");
            let detail = CStr::from_ptr((*r).value).to_str().unwrap();
            assert!(detail.contains("not valid UTF-8"), "{detail}");
            ah_free_result(r);
        }
    }

    #[test]
    fn null_pointer_is_empty_string_not_abort() {
        unsafe {
            let r = ah_canonical_json(std::ptr::null());
            assert_eq!((*r).ok, 0); // "" is not valid JSON -> context_invalid
            let code = CStr::from_ptr((*r).error_code).to_str().unwrap();
            assert_eq!(code, "host_error:context_invalid");
            ah_free_result(r);
        }
    }

    #[test]
    fn bigint_rejected_through_c_abi() {
        // 2^64: serde coerces the literal to f64; the raw-text scan in
        // the core must reject it (regression: serde coerces
        // beyond-u64 literals to f64 before any Value-level check).
        let ctx = br#"{"spec":"agent-hooks/0.1","interception_point":"pre_tool_call","timestamp":"t","sequence":0,"agent":{"id":"a","framework":"x"},"session":{"id":"s"},"target":{"id":18446744073709551616},"tool_call":{"id":"tc","name":"t","args":{"id":18446744073709551616}}}"#;
        unsafe {
            let (ok, detail, code) = call1(ah_context_identity, ctx);
            assert_eq!(ok, 0);
            assert_eq!(code, "host_error:context_invalid");
            assert!(
                detail.contains("string-encode 64-bit identifiers"),
                "{detail}"
            );
        }
    }

    #[test]
    fn happy_path_still_works() {
        unsafe {
            let (ok, value, _) = call1(ah_canonical_json, br#"{"b":1,"a":2}"#);
            assert_eq!(ok, 1);
            assert_eq!(value, r#"{"a":2,"b":1}"#);
        }
    }
}
