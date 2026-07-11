// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

package agenthooks

// cgo bindings for libagent_hooks_ffi (sdk/rust/ffi).
//
// The cdylib exposes a JSON-string surface over agent_hooks::ffi_surface.
// Every function returns a heap-allocated AhResult* the caller frees with
// ah_free_result. See sdk/rust/ffi/include/agent_hooks.h.
//
// Build requires the cdylib at a path cgo can find. The CI job builds
// sdk/rust with `cargo build -p agent-hooks-ffi --release` and sets
// CGO_LDFLAGS/LD_LIBRARY_PATH to sdk/rust/target/release. For local dev:
//
//	cargo build --manifest-path ../../rust/Cargo.toml -p agent-hooks-ffi --release
//	export CGO_LDFLAGS="-L$(pwd)/../../rust/target/release -lagent_hooks_ffi"
//	export LD_LIBRARY_PATH="$(pwd)/../../rust/target/release"
//	go test ./...

/*
#cgo CFLAGS: -I${SRCDIR}/../../rust/ffi/include
#cgo LDFLAGS: -lagent_hooks_ffi
#include <stdlib.h>
#include "agent_hooks.h"
*/
import "C"

import (
	"errors"
	"unsafe"
)

// CoreError wraps a §11 host_error:* code returned by the Rust core.
type CoreError struct {
	Code   string
	Detail string
}

func (e *CoreError) Error() string { return e.Code + ": " + e.Detail }

// Is allows errors.Is(err, &CoreError{Code: "host_error:..."}) matching.
func (e *CoreError) Is(target error) bool {
	var t *CoreError
	if errors.As(target, &t) {
		return t.Code == "" || t.Code == e.Code
	}
	return false
}

func unwrap(r *C.AhResult) (string, error) {
	if r == nil {
		return "", &CoreError{Code: string(ErrContextInvalid), Detail: "null result"}
	}
	defer C.ah_free_result(r)
	value := C.GoString(r.value)
	if r.ok == 1 {
		return value, nil
	}
	return "", &CoreError{Code: C.GoString(r.error_code), Detail: value}
}

func cstr(s string) (*C.char, func()) {
	c := C.CString(s)
	return c, func() { C.free(unsafe.Pointer(c)) }
}

// nativeSpecVersion returns the spec version compiled into the Rust core.
func nativeSpecVersion() string {
	return C.GoString(C.ah_spec_version())
}

func nativeCanonicalJSON(valueJSON string) (string, error) {
	c, free := cstr(valueJSON)
	defer free()
	return unwrap(C.ah_canonical_json(c))
}

func nativeContextIdentity(ctxJSON string) (string, error) {
	c, free := cstr(ctxJSON)
	defer free()
	return unwrap(C.ah_context_identity(c))
}

func nativeValidateVerdict(verdictJSON string) (string, error) {
	c, free := cstr(verdictJSON)
	defer free()
	return unwrap(C.ah_validate_verdict(c))
}

// nativeValidateEnvelope runs the §4/§6.3 envelope validation (fail
// closed, value-free detail). The Ok value is the empty string.
func nativeValidateEnvelope(ctxJSON string) (string, error) {
	c, free := cstr(ctxJSON)
	defer free()
	return unwrap(C.ah_validate_envelope(c))
}

func nativeApplyTransform(targetJSON, path, valueJSON string) (string, error) {
	ct, ft := cstr(targetJSON)
	defer ft()
	cp, fp := cstr(path)
	defer fp()
	cv, fv := cstr(valueJSON)
	defer fv()
	return unwrap(C.ah_apply_transform(ct, cp, cv))
}

// nativeApplyTransformCtx applies one transform to the context's target
// and its L1 alias (§7.1 fold-through), returning the updated context.
func nativeApplyTransformCtx(ctxJSON, path, valueJSON string) (string, error) {
	cc, fc := cstr(ctxJSON)
	defer fc()
	cp, fp := cstr(path)
	defer fp()
	cv, fv := cstr(valueJSON)
	defer fv()
	return unwrap(C.ah_apply_transform_ctx(cc, cp, cv))
}

// nativeValidateTransformCtx validates a transform against the context's
// current target without applying it (§8 evaluate_only).
func nativeValidateTransformCtx(ctxJSON, path, valueJSON string) (string, error) {
	cc, fc := cstr(ctxJSON)
	defer fc()
	cp, fp := cstr(path)
	defer fp()
	cv, fv := cstr(valueJSON)
	defer fv()
	return unwrap(C.ah_validate_transform_ctx(cc, cp, cv))
}

// nativeFinalize builds the InterceptionRecord for one completed
// emission (§10.3). optionsJSON carries {input_identity?,
// identity_provider?, enforced_identity?, decided_by?, composition,
// verdicts?, fold_truncated?, resolved_by?}; input_identity MUST have
// been computed from the context before interceptor dispatch.
func nativeFinalize(ctxJSON, verdictJSON, mode, optionsJSON string) (string, error) {
	cc, fc := cstr(ctxJSON)
	defer fc()
	cv, fv := cstr(verdictJSON)
	defer fv()
	cm, fm := cstr(mode)
	defer fm()
	co, fo := cstr(optionsJSON)
	defer fo()
	return unwrap(C.ah_finalize(cc, cv, cm, co))
}

// nativeComposeAggregate runs the §7.3/§7.5 severity-max aggregation for
// the multi-verdict composition profiles. Returns {combined, decided_by,
// consult, apply_transform, verdicts}.
func nativeComposeAggregate(compositionJSON, verdictsJSON string) (string, error) {
	cc, fc := cstr(compositionJSON)
	defer fc()
	cv, fv := cstr(verdictsJSON)
	defer fv()
	return unwrap(C.ah_compose_aggregate(cc, cv))
}

// ---- CTK engine (§13.2) ---------------------------------------------------
//
// Unexported string→string cgo shims. Exported, typed wrappers live in
// ctk.go (separate file so this cgo unit stays minimal).

func nativeCtkScriptedIntercept(rulesJSON, ctxJSON string) (string, error) {
	cr, fr := cstr(rulesJSON)
	defer fr()
	cc, fc := cstr(ctxJSON)
	defer fc()
	return unwrap(C.ah_ctk_scripted_intercept(cr, cc))
}

func nativeCtkScriptedResolve(rulesJSON, ctxJSON, identity string) (string, error) {
	cr, fr := cstr(rulesJSON)
	defer fr()
	cc, fc := cstr(ctxJSON)
	defer fc()
	ci, fi := cstr(identity)
	defer fi()
	return unwrap(C.ah_ctk_scripted_resolve(cr, cc, ci))
}

func nativeCtkShouldSkip(vectorJSON, capsJSON string) (string, error) {
	cv, fv := cstr(vectorJSON)
	defer fv()
	cc, fc := cstr(capsJSON)
	defer fc()
	return unwrap(C.ah_ctk_should_skip(cv, cc))
}

func nativeCtkAssert(vectorJSON, recordedJSON, runRecordJSON string) (string, error) {
	cv, fv := cstr(vectorJSON)
	defer fv()
	cr, fr := cstr(recordedJSON)
	defer fr()
	crr, frr := cstr(runRecordJSON)
	defer frr()
	return unwrap(C.ah_ctk_assert(cv, cr, crr))
}
