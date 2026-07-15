// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

package agenthooks

// Exported, typed wrappers over the CTK engine cgo shims in native.go.
// Kept in a separate non-cgo file so native.go stays a minimal cgo unit.

import (
	"encoding/json"
	"errors"
)

// CtkScriptedIntercept evaluates a vector's interceptor_script against
// ctx via the Rust core. First matching rule wins; unmatched → allow.
// rulesJSON is the pre-marshalled interceptor_script array so callers
// pay the marshal cost once per vector, not per interception.
func CtkScriptedIntercept(rulesJSON string, ctx AgentContext) (Verdict, error) {
	cb, err := json.Marshal(map[string]any(ctx))
	if err != nil {
		return Verdict{}, err
	}
	out, err := nativeCtkScriptedIntercept(rulesJSON, string(cb))
	if err != nil {
		return Verdict{}, err
	}
	switch faultKind(out) {
	case "mutate":
		// §7 isolation fault (TM-05): tamper with the received context
		// in-place; the emitter's copy isolation must keep enforcement,
		// identity, and siblings unaffected.
		ctx["target"] = "TAMPERED"
		if tc, ok := ctx["tool_call"].(map[string]any); ok {
			tc["args"] = map[string]any{"tampered": true}
		}
		return Verdict{Decision: Allow, Reason: "ctk:mutated"}, nil
	case "raise":
		// NOW-10 fault injection: exercise §6.3 interceptor_failed.
		return Verdict{}, errors.New("ctk scripted fault: raise")
	}
	var v Verdict
	return v, json.Unmarshal([]byte(out), &v)
}

// CtkScriptedResolve evaluates a vector's approval_script against the
// request context via the Rust core, echoing identity. identity may be
// nil (§10.1 null provider): the scripted engine works in strings, so
// nil round-trips through "" and back to nil on echo.
func CtkScriptedResolve(rulesJSON string, ctx AgentContext, identity *string) (ApprovalResolution, error) {
	cb, err := json.Marshal(map[string]any(ctx))
	if err != nil {
		return ApprovalResolution{}, err
	}
	requestIdentity := ""
	if identity != nil {
		requestIdentity = *identity
	}
	out, err := nativeCtkScriptedResolve(rulesJSON, string(cb), requestIdentity)
	if err != nil {
		return ApprovalResolution{}, err
	}
	if faulted(out) {
		// NOW-10 fault injection: exercise §9 approval_resolver_failed.
		return ApprovalResolution{}, errors.New("ctk scripted fault: raise")
	}
	var r struct {
		Outcome         ApprovalOutcome `json:"outcome"`
		ContextIdentity string          `json:"context_identity"`
		Verdict         *Verdict        `json:"verdict"`
	}
	if err := json.Unmarshal([]byte(out), &r); err != nil {
		return ApprovalResolution{}, err
	}
	var echoed *string
	if !(r.ContextIdentity == "" && identity == nil) {
		echoed = &r.ContextIdentity
	}
	return ApprovalResolution{
		Outcome:         r.Outcome,
		ContextIdentity: echoed,
		Verdict:         r.Verdict,
	}, nil
}

// CtkShouldSkip returns a non-empty reason if the vector's declared
// capabilities are not a subset of caps.
func CtkShouldSkip(vectorJSON string, caps []string) (string, error) {
	cb, err := json.Marshal(caps)
	if err != nil {
		return "", err
	}
	out, err := nativeCtkShouldSkip(vectorJSON, string(cb))
	if err != nil {
		return "", err
	}
	var s *string
	if err := json.Unmarshal([]byte(out), &s); err != nil {
		return "", err
	}
	if s == nil {
		return "", nil
	}
	return *s, nil
}

// CtkVectorResult is the outcome of one vector run, as returned by
// ctk_engine::assert_vector.
type CtkVectorResult struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Part is the vector's declared-surface tag (§13.1): grouping
	// results by Part is the conformance report.
	Part     string   `json:"part"`
	Status   string   `json:"status"` // "pass" | "fail" | "skip"
	Detail   string   `json:"detail"`
	Failures []string `json:"failures"`
}

// CtkAssert runs the assertion pass for one vector via the Rust core.
// runRecordJSON is the wire-shaped RunRecord:
// {outcome, final_output, tool_invocations, error, identities}.
func CtkAssert(vectorJSON string, recorded []AgentContext, runRecordJSON string) (CtkVectorResult, error) {
	// A nil slice marshals to JSON null, which the core rejects
	// (serde expects a sequence). A registered interceptor that never
	// ran (e.g. a provider fault denying at agent_startup, AH-CTK-096)
	// leaves the recording slice nil.
	if recorded == nil {
		recorded = []AgentContext{}
	}
	rb, err := json.Marshal(recorded)
	if err != nil {
		return CtkVectorResult{}, err
	}
	out, err := nativeCtkAssert(vectorJSON, string(rb), runRecordJSON)
	if err != nil {
		return CtkVectorResult{}, err
	}
	var vr CtkVectorResult
	return vr, json.Unmarshal([]byte(out), &vr)
}

// DeepCopyContext returns a deep copy of ctx via a JSON round-trip.
// Used by recording interceptors so later transform write-back does not
// mutate the record of what the interceptor saw.
func DeepCopyContext(ctx AgentContext) (AgentContext, error) {
	b, err := json.Marshal(map[string]any(ctx))
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	return AgentContext(out), nil
}

// faultKind returns the CTK engine's fault sentinel value
// ({"__ctk_fault__": "raise"|"mutate"}), or "" when the output is a
// plain verdict.
func faultKind(out string) string {
	var probe map[string]string
	if err := json.Unmarshal([]byte(out), &probe); err != nil {
		return ""
	}
	return probe["__ctk_fault__"]
}

// faulted reports whether the CTK engine returned a fault sentinel.
func faulted(out string) bool { return faultKind(out) != "" }
