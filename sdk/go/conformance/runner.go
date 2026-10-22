// Copyright (c) Microsoft. All rights reserved.

package conformance

// CTK runner: load vectors, drive a harness, assert expect.
//
// Assertion engine, capability skip check, and scripted
// interceptor/resolver evaluation live in the Rust core via
// agenthooks.Ctk*. This file keeps only vector globbing, the
// orchestration loop that calls Harness.Setup/Run/Teardown, and
// RunRecord → wire-JSON marshalling. See conformance/RUNNER.md.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/responsibleai/agent-hooks/sdk/go/agenthooks"
)

// VectorResult is the outcome of one vector run.
type VectorResult = agenthooks.CtkVectorResult

// LoadVectors globs conformance/vectors/AH-CTK-*.json under dir in
// sorted order.
func LoadVectors(dir string) ([]map[string]any, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "AH-CTK-*.json"))
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		// A runner fed zero vectors reports 100% pass — a false
		// conformance signal (§13.2). Fail loudly instead.
		return nil, fmt.Errorf("no AH-CTK-*.json vectors found in %s", dir)
	}
	sort.Strings(paths)
	var out []map[string]any
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		// UseNumber: default decoding into any is float64, which would
		// silently round int64_json vectors' >2^53 integers at load —
		// the very corruption AH-CTK-090 exists to catch (§4.4).
		// json.Number round-trips the literal losslessly.
		dec := json.NewDecoder(bytes.NewReader(b))
		dec.UseNumber()
		var v map[string]any
		if err := dec.Decode(&v); err != nil {
			return nil, fmt.Errorf("%s: %w", p, err)
		}
		out = append(out, v)
	}
	return out, nil
}

// hangGrace is how long a `hang` fault waits past the bound before
// returning allow, so a host that does not bound execution fails the
// vector on tool_not_invoked instead of hanging the run.
const hangGrace = 10 * time.Second

// scriptedInterceptor wraps agenthooks.CtkScriptedEvaluate; when rec
// is set it also records every context it is handed. It implements
// both the standard Interceptor (the ctk.instance kind of a
// field-based vector and the ctk.scripted kind of a declaration
// vector, which the emitter wraps in its own timer) and
// ManagedInterceptor (the ctk.managed kind of a declaration vector,
// which owns its deadline), so `hang` under ctk.scripted pins the
// emitter-owned timeout while `hang` and `cancel` under ctk.managed
// reach the typed outcomes of §6.3.1.
type scriptedInterceptor struct {
	rulesJSON string
	rec       *recorder
}

func (s *scriptedInterceptor) evaluate(actx agenthooks.AgentContext) (agenthooks.Verdict, agenthooks.CtkScriptedFault, error) {
	if s.rec != nil {
		cp, err := agenthooks.DeepCopyContext(actx)
		if err != nil {
			return agenthooks.Verdict{}, "", err
		}
		s.rec.recorded = append(s.rec.recorded, cp)
	}
	return agenthooks.CtkScriptedEvaluate(s.rulesJSON, actx)
}

// Intercept is the standard path: the emitter's timer bounds a hang
// and cancels ctx. The wrapper waits for that cancellation and, if the
// host has not bounded it once hangGrace has passed, returns allow so
// an unbounded host fails the vector on tool_not_invoked instead of
// hanging the run. A cancel fault is defined only for ctk.managed; it
// has no typed outcome here and fails closed as a raise.
func (s *scriptedInterceptor) Intercept(ctx context.Context, actx agenthooks.AgentContext) (agenthooks.Verdict, error) {
	v, fault, err := s.evaluate(actx)
	if err != nil {
		return agenthooks.Verdict{}, err
	}
	switch fault {
	case agenthooks.CtkFaultHang:
		select {
		case <-ctx.Done():
			return agenthooks.Verdict{}, ctx.Err()
		case <-time.After(hangGrace):
			return agenthooks.AllowVerdict, nil
		}
	case agenthooks.CtkFaultCancel:
		return agenthooks.Verdict{}, errors.New("ctk scripted fault: cancel")
	case "":
		return v, nil
	}
	return actOut(fault, actx)
}

// InterceptManaged is the managed path (§6.3.1 item 8): the scripted
// interceptor owns the bound it was handed. `hang` runs work (a sleep
// standing in for a process or a request), cancels it at the deadline
// and only then reports the typed timeout; `cancel` reports the typed
// cancelled outcome; `raise` reports the typed failure.
func (s *scriptedInterceptor) InterceptManaged(ctx context.Context, actx agenthooks.AgentContext, bound time.Duration) agenthooks.ManagedOutcome {
	v, fault, err := s.evaluate(actx)
	if err != nil {
		return agenthooks.ManagedFailed(fmt.Sprintf("%T", err))
	}
	switch fault {
	case "":
		return agenthooks.ManagedVerdict(v)
	case agenthooks.CtkFaultHang:
		work := time.NewTimer(hangGrace)
		defer work.Stop()
		if bound <= 0 {
			<-work.C
			return agenthooks.ManagedVerdict(agenthooks.AllowVerdict)
		}
		deadline := time.NewTimer(bound)
		defer deadline.Stop()
		select {
		case <-work.C:
			return agenthooks.ManagedVerdict(agenthooks.AllowVerdict)
		case <-deadline.C:
			// The work is stopped (cleaned up) before the outcome is
			// reported.
			work.Stop()
			return agenthooks.ManagedTimeout()
		case <-ctx.Done():
			return agenthooks.ManagedCancelled()
		}
	case agenthooks.CtkFaultCancel:
		return agenthooks.ManagedCancelled()
	}
	v, err = actOut(fault, actx)
	if err != nil {
		return agenthooks.ManagedFailed(fmt.Sprintf("%T", err))
	}
	return agenthooks.ManagedVerdict(v)
}

// actOut performs the faults both paths share: mutate tampers with the
// received context and returns allow; raise is an error.
func actOut(fault agenthooks.CtkScriptedFault, actx agenthooks.AgentContext) (agenthooks.Verdict, error) {
	switch fault {
	case agenthooks.CtkFaultMutate:
		actx["target"] = "TAMPERED"
		if tc, ok := actx["tool_call"].(map[string]any); ok {
			tc["args"] = map[string]any{"tampered": true}
		}
		return agenthooks.Verdict{Decision: agenthooks.Allow, Reason: "ctk:mutated"}, nil
	case agenthooks.CtkFaultRaise:
		return agenthooks.Verdict{}, errors.New("ctk scripted fault: raise")
	}
	return agenthooks.Verdict{}, fmt.Errorf("ctk scripted fault: unknown fault %q", fault)
}

// scriptedResolver wraps agenthooks.CtkScriptedResolve.
type scriptedResolver struct {
	rulesJSON string
}

func (s *scriptedResolver) Resolve(_ context.Context, req agenthooks.ApprovalRequest) (agenthooks.ApprovalResolution, error) {
	return agenthooks.CtkScriptedResolve(s.rulesJSON, req.Context, req.ContextIdentity)
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func runRecordToWire(rr RunRecord, postures map[string]string) string {
	invs := make([]map[string]any, len(rr.ToolInvocations))
	for i, t := range rr.ToolInvocations {
		invs[i] = map[string]any{"name": t.Name, "args": t.Args}
	}
	ids := make([]map[string]any, len(rr.Identities))
	for i, p := range rr.Identities {
		ids[i] = map[string]any{
			"input_identity":    p.InputIdentity,
			"enforced_identity": p.EnforcedIdentity,
		}
	}
	// A nil slice marshals to JSON null, which the core's RunRecord
	// deserializer rejects (serde default covers absent, not null).
	records := rr.Records
	if records == nil {
		records = []agenthooks.InterceptionRecord{}
	}
	messages := rr.HostMessages
	if messages == nil {
		messages = []string{}
	}
	wire := map[string]any{
		"outcome":          string(rr.Outcome),
		"final_output":     rr.FinalOutput,
		"tool_invocations": invs,
		"error":            rr.Err,
		"identities":       ids,
		"records":          records,
		// §6.3.1: what the host told the principal during the run.
		"host_messages": messages,
		// Harness *declarations* (§13.1), not observed behavior: the
		// engine selects expect.run_outcome_by_posture entries by them.
		"postures": postures,
	}
	if rr.Load != nil {
		// §7.7.9: the load outcome of a declaration vector.
		wire["load"] = rr.Load
	}
	return mustJSON(wire)
}

// RunVector drives one vector against a fresh harness instance.
func RunVector(ctx context.Context, h Harness, vector map[string]any) (VectorResult, error) {
	vectorJSON := mustJSON(vector)
	id, _ := vector["id"].(string)
	title, _ := vector["title"].(string)

	// §13.1 posture declaration; a Harness that does not implement the
	// optional declarer interface declares the spec default.
	posture := "continue"
	if d, ok := h.(ToolSeamHostErrorDeclarer); ok {
		posture = d.ToolSeamHostError()
	}
	// §7.7.9: a harness with its own declaration is assessed against
	// the resolved document, so what ran is what a claim cites.
	surface := codeSurface(h, posture)
	// §6.3.1: the harness document's default failure posture, what a
	// claim states; a vector's own document may set its own.
	onError := string(agenthooks.OnErrorDeny)
	var caps []string
	if d, ok := h.(DeclarationDeclarer); ok && d.Declaration() != nil {
		resolved, err := cachedResolvedSurface(d.Declaration(), surface)
		if err != nil {
			return VectorResult{ID: id, Title: title, Status: "fail",
				Failures: []string{fmt.Sprintf("harness declaration refused: %v", err)}}, nil
		}
		caps, posture, onError = resolved.caps, resolved.posture, resolved.onError
	} else {
		for c := range h.Capabilities() {
			caps = append(caps, string(c))
		}
	}
	sort.Strings(caps)
	if reason, err := agenthooks.CtkShouldSkip(vectorJSON, caps); err != nil {
		return VectorResult{}, err
	} else if reason != "" {
		return VectorResult{ID: id, Title: title, Status: "skip", Detail: reason}, nil
	}

	scenRaw, _ := vector["scenario"].(map[string]any)
	scenario := scenarioFromWire(scenRaw)

	// Multi-interceptor vectors (§7.1 fold-through) use
	// interceptor_scripts; single-interceptor vectors use
	// interceptor_script. Only the FIRST interceptor records:
	// expect.interceptions describes each emission as the first-registered
	// interceptor saw it. An empty interceptor_scripts registers zero
	// interceptors (§7 fail-closed vector).
	sc := scriptsOf(vector)
	postures := map[string]string{"tool_seam_host_error": posture, "on_error": onError}

	// §7.7.9: a declaration vector builds the emitter through the
	// loader. The runner proves the construction paths itself, then
	// hands the document and the CTK registry to the harness.
	if document, ok := vector["host_declaration"].(map[string]any); ok {
		rr, err := runDeclared(ctx, h, scenario, document, sc, surface, id)
		if err != nil {
			return VectorResult{ID: id, Title: title, Status: "fail",
				Failures: []string{fmt.Sprintf("harness (declaration): %v", err)}}, nil
		}
		return agenthooks.CtkAssert(vectorJSON, sc.rec.recorded, runRecordToWire(rr, postures))
	}

	interceptors := sc.interceptors()
	resolver := sc.resolver()
	mode := agenthooks.Enforce
	if m, _ := vector["mode"].(string); m != "" {
		mode = agenthooks.EnforcementMode(m)
	}
	// §13.2: composition vectors carry the profile/knobs they apply to;
	// absent means the pre-P-003 default (sequential/first_deny, stop).
	composition := agenthooks.DefaultComposition()
	if c, ok := vector["composition"].(map[string]any); ok {
		var cc agenthooks.CompositionConfig
		if err := json.Unmarshal([]byte(mustJSON(c)), &cc); err == nil && cc.Profile != "" {
			composition = cc
		}
	}

	// §10.1: absent → the default provider; explicit null → unbound.
	identityProvider := agenthooks.DefaultIdentityProvider()
	if raw, present := vector["identity_provider"]; present {
		switch {
		case raw == nil:
			identityProvider = nil
		case raw == "ctk-fault":
			// §13.2: a custom provider that fails, pinning the §10.1
			// provider-failure rule (deny context_invalid pre-dispatch).
			identityProvider = &agenthooks.IdentityProvider{
				Name: "ctk-fault",
				Compute: func(agenthooks.AgentContext) (string, error) {
					return "", errors.New("ctk scripted provider fault")
				},
			}
		}
	}

	if err := h.Setup(scenario, interceptors, resolver, mode, composition, identityProvider,
		sc.redact); err != nil {
		return VectorResult{ID: id, Title: title, Status: "fail",
			Failures: []string{fmt.Sprintf("harness.Setup: %v", err)}}, nil
	}
	rr, runErr := h.Run(ctx)
	h.Teardown()
	if runErr != nil {
		return VectorResult{ID: id, Title: title, Status: "fail",
			Failures: []string{fmt.Sprintf("harness.Run: %v", runErr)}}, nil
	}

	return agenthooks.CtkAssert(vectorJSON, sc.rec.recorded, runRecordToWire(rr, postures))
}

func scenarioFromWire(s map[string]any) Scenario {
	var sc Scenario
	if in, ok := s["input"].(map[string]any); ok {
		sc.Input = in
	}
	if tools, ok := s["tools"].([]any); ok {
		for _, t := range tools {
			if m, ok := t.(map[string]any); ok {
				sc.Tools = append(sc.Tools, m)
			}
		}
	}
	if ms, ok := s["model_script"].([]any); ok {
		for _, m := range ms {
			if mm, ok := m.(map[string]any); ok {
				sc.ModelScript = append(sc.ModelScript, mm)
			}
		}
	}
	return sc
}
