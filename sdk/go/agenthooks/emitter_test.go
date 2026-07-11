// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

package agenthooks

// Composition-profile and identity-provider tests mirroring the Rust
// emitter's (sdk/rust/core/src/emitter.rs): the four §7.2 profiles,
// stop/resume, run_all single-consult, parallel transform conflict,
// unanimous disagreement, provider nil/custom, big-int rejection.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

type scripted struct{ v Verdict }

func (s scripted) OnHook(context.Context, AgentContext) (Verdict, error) {
	return s.v, nil
}

// approver echoes the request identity (§9 echo rule) and returns a
// fixed outcome/verdict.
type approver struct {
	outcome ApprovalOutcome
	v       Verdict
}

func (a approver) Resolve(_ context.Context, req ApprovalRequest) (ApprovalResolution, error) {
	v := a.v
	return ApprovalResolution{Outcome: a.outcome, ContextIdentity: req.ContextIdentity, Verdict: &v}, nil
}

// countingResolver counts consultations and delegates.
type countingResolver struct {
	calls *int
	inner ApprovalResolver
}

func (c countingResolver) Resolve(ctx context.Context, req ApprovalRequest) (ApprovalResolution, error) {
	*c.calls++
	return c.inner.Resolve(ctx, req)
}

func testCtx() AgentContext {
	return AgentContext{
		"spec":               SpecVersion,
		"interception_point": "pre_tool_call",
		"timestamp":          "t",
		"sequence":           int64(0),
		"agent":              map[string]any{"id": "a", "framework": "x"},
		"session":            map[string]any{"id": "s"},
		"target":             map[string]any{"url": "evil"},
		"tool_call":          map[string]any{"id": "tc", "name": "t", "args": map[string]any{"url": "evil"}},
	}
}

func transformVerdict(path string, value any) Verdict {
	return Verdict{Decision: Transform, Transform: &TransformBody{Path: path, Value: value}}
}

func denyVerdict(reason string) Verdict {
	return Verdict{Decision: Deny, Reason: reason}
}

func targetURL(t *testing.T, actx AgentContext) string {
	t.Helper()
	target, ok := actx["target"].(map[string]any)
	if !ok {
		t.Fatalf("target is %T, not an object", actx["target"])
	}
	url, _ := target["url"].(string)
	return url
}

func emit(t *testing.T, e *InterceptionEmitter, actx AgentContext) InterceptionRecord {
	t.Helper()
	rec, err := e.EmitUnchecked(context.Background(), actx)
	if err != nil {
		t.Fatalf("EmitUnchecked: %v", err)
	}
	return rec
}

func TestRunAllRunsEverythingAndStrictestWins(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	e.SetComposition(RunAllComposition())
	e.Register(scripted{denyVerdict("")})
	e.Register(scripted{Warn("late", "")})
	c := testCtx()
	rec := emit(t, e, c)
	if rec.Verdict.Decision != Deny {
		t.Errorf("decision = %s, want deny", rec.Verdict.Decision)
	}
	if len(rec.Verdicts) != 2 {
		t.Errorf("run_all: everything runs; verdicts = %d, want 2", len(rec.Verdicts))
	}
	if rec.DecidedBy == nil || *rec.DecidedBy != 0 {
		t.Errorf("decided_by = %v, want 0", rec.DecidedBy)
	}
	// §7.3: warnings union onto the deny combination.
	if len(rec.Verdict.Warnings) != 1 {
		t.Errorf("warnings = %d, want 1", len(rec.Verdict.Warnings))
	}
	if rec.FoldTruncated != nil {
		t.Errorf("fold_truncated defined outside first_deny: %v", *rec.FoldTruncated)
	}
}

func TestParallelStrictestTransformConflictFailsClosed(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	e.SetComposition(StrictestComposition(SynthesizeDeny))
	e.Register(scripted{transformVerdict("$target.url", "a")})
	e.Register(scripted{transformVerdict("$target.url", "b")})
	c := testCtx()
	rec := emit(t, e, c)
	if rec.Verdict.Reason != string(ErrTransformConflict) {
		t.Errorf("reason = %q, want %q", rec.Verdict.Reason, ErrTransformConflict)
	}
	// Snapshot isolation: neither transform applied.
	if got := targetURL(t, c); got != "evil" {
		t.Errorf("target.url = %q, want evil (untouched)", got)
	}
	if rec.DecidedBy != nil {
		t.Errorf("decided_by = %v, want nil (host-synthesized)", *rec.DecidedBy)
	}
}

func TestParallelTransformConflictApprovalKnobConsultsSeam(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, approver{Approve, AllowVerdict})
	e.SetComposition(StrictestComposition(SynthesizeApproval))
	e.Register(scripted{transformVerdict("$target.url", "a")})
	e.Register(scripted{transformVerdict("$target.url", "b")})
	c := testCtx()
	rec := emit(t, e, c)
	if rec.Verdict.Decision != Allow {
		t.Errorf("decision = %s, want allow (conflict lifted)", rec.Verdict.Decision)
	}
	if rec.ResolvedBy == nil || *rec.ResolvedBy != ResolvedByApproval {
		t.Errorf("resolved_by = %v, want approval", rec.ResolvedBy)
	}
	if rec.DecidedBy != nil {
		t.Errorf("decided_by = %v, want nil (synthesized trigger)", *rec.DecidedBy)
	}
	if got := targetURL(t, c); got != "evil" {
		t.Errorf("target.url = %q, want evil (allow applies nothing)", got)
	}
}

func TestParallelStrictestSingleTransformApplies(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	e.SetComposition(StrictestComposition(SynthesizeDeny))
	e.Register(scripted{AllowVerdict})
	e.Register(scripted{transformVerdict("$target.url", "safe")})
	c := testCtx()
	rec := emit(t, e, c)
	if rec.Verdict.Decision != Transform {
		t.Errorf("decision = %s, want transform", rec.Verdict.Decision)
	}
	if rec.DecidedBy == nil || *rec.DecidedBy != 1 {
		t.Errorf("decided_by = %v, want 1", rec.DecidedBy)
	}
	if got := targetURL(t, c); got != "safe" {
		t.Errorf("target.url = %q, want safe", got)
	}
	if rec.InputIdentity == nil || rec.EnforcedIdentity == nil {
		t.Fatalf("identities missing: %v %v", rec.InputIdentity, rec.EnforcedIdentity)
	}
	if *rec.InputIdentity == *rec.EnforcedIdentity {
		t.Error("identities equal despite an applied transform")
	}
}

func TestUnanimousDisagreementSynthesizes(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	e.SetComposition(UnanimousComposition(SynthesizeDeny, SynthesizeDeny))
	e.Register(scripted{AllowVerdict})
	e.Register(scripted{transformVerdict("$target.url", "x")})
	c := testCtx()
	rec := emit(t, e, c)
	if rec.Verdict.Reason != string(ErrCompositionDisagreement) {
		t.Errorf("reason = %q, want %q", rec.Verdict.Reason, ErrCompositionDisagreement)
	}
	if got := targetURL(t, c); got != "evil" {
		t.Errorf("target.url = %q, want evil (transform not applied)", got)
	}
	if rec.DecidedBy != nil {
		t.Errorf("decided_by = %v, want nil", *rec.DecidedBy)
	}
}

func TestFirstDenyNoResolverLiftableDenyStandsWithoutError(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	e.Register(scripted{Escalate("check", "")})
	c := testCtx()
	// §9: no resolver → the liftable deny stands, NOT an error.
	rec := emit(t, e, c)
	if rec.Verdict.Decision != Deny {
		t.Errorf("decision = %s, want deny", rec.Verdict.Decision)
	}
	if rec.Verdict.Reason != "check" {
		t.Errorf("reason = %q, want check", rec.Verdict.Reason)
	}
	if !rec.Verdict.IsLiftable() {
		t.Error("verdict not liftable; approval block lost")
	}
	if rec.ResolvedBy != nil {
		t.Errorf("resolved_by = %v, want nil", *rec.ResolvedBy)
	}
}

func TestFirstDenyStopTruncatesAndRecordsSubstitution(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, approver{Approve, AllowVerdict})
	e.SetComposition(FirstDenyComposition(OnApprovalStop))
	e.Register(scripted{Escalate("", "")})
	e.Register(scripted{denyVerdict("")}) // must be skipped
	c := testCtx()
	rec := emit(t, e, c)
	if rec.Verdict.Decision != Allow {
		t.Errorf("decision = %s, want allow", rec.Verdict.Decision)
	}
	if rec.FoldTruncated == nil || !*rec.FoldTruncated {
		t.Errorf("fold_truncated = %v, want true", rec.FoldTruncated)
	}
	if rec.ResolvedBy == nil || *rec.ResolvedBy != ResolvedByApproval {
		t.Errorf("resolved_by = %v, want approval", rec.ResolvedBy)
	}
	if rec.DecidedBy == nil || *rec.DecidedBy != 0 {
		t.Errorf("decided_by = %v, want 0", rec.DecidedBy)
	}
}

func TestFirstDenyResumeContinuesTheFold(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, approver{Approve, AllowVerdict})
	e.SetComposition(FirstDenyComposition(OnApprovalResume))
	e.Register(scripted{Escalate("", "")})
	e.Register(scripted{denyVerdict("")}) // now runs — and denies
	c := testCtx()
	rec := emit(t, e, c)
	if rec.Verdict.Decision != Deny {
		t.Errorf("decision = %s, want deny", rec.Verdict.Decision)
	}
	if rec.DecidedBy == nil || *rec.DecidedBy != 1 {
		t.Errorf("decided_by = %v, want 1", rec.DecidedBy)
	}
	if rec.ResolvedBy == nil || *rec.ResolvedBy != ResolvedByApproval {
		t.Errorf("resolved_by = %v, want approval", rec.ResolvedBy)
	}
	if rec.FoldTruncated == nil || *rec.FoldTruncated {
		t.Errorf("fold_truncated = %v, want false", rec.FoldTruncated)
	}
}

func TestRunAllConsultsAtMostOnceOnlyWhenAllDeniesLiftable(t *testing.T) {
	// Every deny liftable → one consult lifts the set.
	calls := 0
	e := NewInterceptionEmitter(Enforce, countingResolver{&calls, approver{Approve, AllowVerdict}})
	e.SetComposition(RunAllComposition())
	e.Register(scripted{Escalate("a", "")})
	e.Register(scripted{Escalate("b", "")})
	rec := emit(t, e, testCtx())
	if rec.Verdict.Decision != Allow {
		t.Errorf("decision = %s, want allow", rec.Verdict.Decision)
	}
	if calls != 1 {
		t.Errorf("resolver consulted %d times, want exactly 1", calls)
	}
	if rec.ResolvedBy == nil || *rec.ResolvedBy != ResolvedByApproval {
		t.Errorf("resolved_by = %v, want approval", rec.ResolvedBy)
	}

	// A single plain deny makes lifting pointless — no consult.
	calls = 0
	e = NewInterceptionEmitter(Enforce, countingResolver{&calls, approver{Approve, AllowVerdict}})
	e.SetComposition(RunAllComposition())
	e.Register(scripted{Escalate("a", "")})
	e.Register(scripted{denyVerdict("hard")})
	rec = emit(t, e, testCtx())
	if rec.Verdict.Decision != Deny || rec.Verdict.Reason != "hard" {
		t.Errorf("verdict = %s/%q, want deny/hard", rec.Verdict.Decision, rec.Verdict.Reason)
	}
	if calls != 0 {
		t.Errorf("resolver consulted %d times, want 0", calls)
	}
	if rec.DecidedBy == nil || *rec.DecidedBy != 1 {
		t.Errorf("decided_by = %v, want 1 (plain deny dominates liftable)", rec.DecidedBy)
	}
}

func TestEchoRuleViolationFailsClosed(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, badEcho{})
	e.Register(scripted{Escalate("", "")})
	rec := emit(t, e, testCtx())
	if rec.Verdict.Reason != string(ErrApprovalIdentityMismatch) {
		t.Errorf("reason = %q, want %q", rec.Verdict.Reason, ErrApprovalIdentityMismatch)
	}
}

type badEcho struct{}

func (badEcho) Resolve(context.Context, ApprovalRequest) (ApprovalResolution, error) {
	forged := "sha256:forged"
	v := AllowVerdict
	return ApprovalResolution{Outcome: Approve, ContextIdentity: &forged, Verdict: &v}, nil
}

func TestApprovalOutcomeVerdictConsistency(t *testing.T) {
	// approve MUST carry a permit verdict (§9).
	e := NewInterceptionEmitter(Enforce, approver{Approve, denyVerdict("nope")})
	e.Register(scripted{Escalate("", "")})
	rec := emit(t, e, testCtx())
	if rec.Verdict.Reason != string(ErrVerdictInvalid) {
		t.Errorf("approve-with-deny: reason = %q, want %q", rec.Verdict.Reason, ErrVerdictInvalid)
	}

	// reject MUST carry a deny verdict (§9).
	e = NewInterceptionEmitter(Enforce, approver{Reject, AllowVerdict})
	e.Register(scripted{Escalate("", "")})
	rec = emit(t, e, testCtx())
	if rec.Verdict.Reason != string(ErrVerdictInvalid) {
		t.Errorf("reject-with-permit: reason = %q, want %q", rec.Verdict.Reason, ErrVerdictInvalid)
	}
}

func TestNullProviderUnboundRecord(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	e.SetIdentityProvider(nil)
	e.Register(scripted{AllowVerdict})
	rec := emit(t, e, testCtx())
	if rec.InputIdentity != nil {
		t.Errorf("input_identity = %q, want nil", *rec.InputIdentity)
	}
	if rec.EnforcedIdentity != nil {
		t.Errorf("enforced_identity = %q, want nil", *rec.EnforcedIdentity)
	}
	if rec.IdentityProvider != nil {
		t.Errorf("identity_provider = %q, want nil", *rec.IdentityProvider)
	}
}

func TestCustomProviderRecordedVerbatim(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	e.SetIdentityProvider(&IdentityProvider{
		Name:    "host-hash",
		Compute: func(AgentContext) (string, error) { return "host:1", nil },
	})
	e.Register(scripted{AllowVerdict})
	rec := emit(t, e, testCtx())
	if rec.InputIdentity == nil || *rec.InputIdentity != "host:1" {
		t.Errorf("input_identity = %v, want host:1", rec.InputIdentity)
	}
	if rec.EnforcedIdentity == nil || *rec.EnforcedIdentity != "host:1" {
		t.Errorf("enforced_identity = %v, want host:1", rec.EnforcedIdentity)
	}
	if rec.IdentityProvider == nil || *rec.IdentityProvider != "host-hash" {
		t.Errorf("identity_provider = %v, want host-hash", rec.IdentityProvider)
	}
}

func TestCustomProviderFailureFailsClosed(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	e.SetIdentityProvider(&IdentityProvider{
		Name:    "host-hash",
		Compute: func(AgentContext) (string, error) { return "", errors.New("boom") },
	})
	e.Register(scripted{AllowVerdict})
	rec := emit(t, e, testCtx())
	if rec.Verdict.Reason != string(ErrContextInvalid) {
		t.Errorf("reason = %q, want %q", rec.Verdict.Reason, ErrContextInvalid)
	}
	if len(rec.Verdicts) != 0 {
		t.Errorf("verdicts = %d, want 0 (no interceptor ran)", len(rec.Verdicts))
	}
}

func TestDefaultProviderRejectsBigIntBeforeDispatch(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	e.Register(scripted{AllowVerdict})
	c := testCtx()
	c["target"] = map[string]any{"id": int64(9007199254740993)}
	c["tool_call"] = map[string]any{"id": "tc", "name": "t", "args": map[string]any{"id": int64(9007199254740993)}}
	rec := emit(t, e, c)
	if rec.Verdict.Reason != string(ErrContextInvalid) {
		t.Errorf("reason = %q, want %q", rec.Verdict.Reason, ErrContextInvalid)
	}
	if !strings.Contains(rec.Verdict.Message, "string-encode") {
		t.Errorf("message = %q, want remediation detail mentioning string-encode", rec.Verdict.Message)
	}
	if len(rec.Verdicts) != 0 {
		t.Errorf("verdicts = %d, want 0 (no interceptor ran)", len(rec.Verdicts))
	}
}

func TestShutdownNeverConsults(t *testing.T) {
	calls := 0
	e := NewInterceptionEmitter(Enforce, countingResolver{&calls, approver{Approve, AllowVerdict}})
	e.Register(scripted{Escalate("", "")})
	c := testCtx()
	c["interception_point"] = "agent_shutdown"
	c["summary"] = map[string]any{"reason": "completed"}
	rec := emit(t, e, c)
	// §6.1a: the liftable deny is recorded, the seam untouched.
	if !rec.Verdict.IsLiftable() {
		t.Error("verdict not liftable")
	}
	if rec.ResolvedBy != nil {
		t.Errorf("resolved_by = %v, want nil", *rec.ResolvedBy)
	}
	if calls != 0 {
		t.Errorf("resolver consulted %d times at agent_shutdown, want 0", calls)
	}
}

func TestEvaluateOnlyNeverConsults(t *testing.T) {
	calls := 0
	e := NewInterceptionEmitter(EvaluateOnly, countingResolver{&calls, approver{Approve, AllowVerdict}})
	e.Register(scripted{Escalate("check", "")})
	rec := emit(t, e, testCtx())
	if calls != 0 {
		t.Errorf("resolver consulted %d times in evaluate_only, want 0", calls)
	}
	if !rec.Verdict.IsLiftable() {
		t.Error("verdict not liftable")
	}
	if !rec.Proceeds() {
		t.Error("evaluate_only emission must proceed")
	}
}

// panicker panics inside OnHook — §6.3: this must become a fail-closed
// host_error:interceptor_failed deny, never kill the host process.
type panicker struct{}

func (panicker) OnHook(context.Context, AgentContext) (Verdict, error) {
	panic("interceptor bug: " + strings.Repeat("x", 8))
}

// panickyResolver panics inside Resolve — §9: approval_resolver_failed.
type panickyResolver struct{}

func (panickyResolver) Resolve(context.Context, ApprovalRequest) (ApprovalResolution, error) {
	panic(errors.New("resolver bug"))
}

func TestPanickingInterceptorFailsClosed(t *testing.T) {
	for _, timeout := range []int64{0, 5000} { // inline and goroutine paths
		e := NewInterceptionEmitter(Enforce, nil)
		if timeout > 0 {
			e.Timeout = 5000 * 1e6 // 5000 ms in time.Duration units
		}
		e.Register(panicker{})
		c := testCtx()
		rec := emit(t, e, c)
		if rec.Verdict.Decision != Deny {
			t.Errorf("timeout=%d: decision = %s, want deny", timeout, rec.Verdict.Decision)
		}
		if rec.Verdict.Reason != string(ErrInterceptorFailed) {
			t.Errorf("timeout=%d: reason = %q, want %s", timeout, rec.Verdict.Reason, ErrInterceptorFailed)
		}
		// Type-name-only rule: the panic payload text must not leak.
		if strings.Contains(rec.Verdict.Message, "interceptor bug") {
			t.Errorf("timeout=%d: panic payload leaked into message: %q", timeout, rec.Verdict.Message)
		}
	}
}

func TestPanickingResolverFailsClosed(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, panickyResolver{})
	e.Register(scripted{Escalate("check", "")})
	c := testCtx()
	rec := emit(t, e, c)
	if rec.Verdict.Decision != Deny {
		t.Errorf("decision = %s, want deny", rec.Verdict.Decision)
	}
	if rec.Verdict.Reason != string(ErrApprovalResolverFailed) {
		t.Errorf("reason = %q, want %s", rec.Verdict.Reason, ErrApprovalResolverFailed)
	}
}

type failing struct{}

func (failing) OnHook(context.Context, AgentContext) (Verdict, error) {
	return Verdict{}, errors.New("boom")
}

func TestFailureDenyAttributedToFailingInterceptor(t *testing.T) {
	// §10.3 (D3): a §6.3 failure deny carries the FAILING
	// interceptor's index, in every profile.
	e := NewInterceptionEmitter(Enforce, nil)
	e.Register(scripted{AllowVerdict})
	e.Register(failing{})
	e.Register(scripted{AllowVerdict})
	rec := emit(t, e, testCtx())
	if rec.Verdict.Reason != string(ErrInterceptorFailed) {
		t.Errorf("reason = %q, want %s", rec.Verdict.Reason, ErrInterceptorFailed)
	}
	if rec.DecidedBy == nil || *rec.DecidedBy != 1 {
		t.Errorf("decided_by = %v, want 1 (failing interceptor)", rec.DecidedBy)
	}
	if rec.FoldTruncated == nil || !*rec.FoldTruncated {
		t.Errorf("fold_truncated = %v, want true", rec.FoldTruncated)
	}
}

func TestRecordCarriesPayloadFreeProjection(t *testing.T) {
	// §10.3 (D2): transform.path kept, transform.value dropped.
	e := NewInterceptionEmitter(Enforce, nil)
	e.Register(scripted{transformVerdict("$target.url", "safe")})
	c := testCtx()
	rec := emit(t, e, c)
	if rec.Verdict.Decision != Transform {
		t.Fatalf("decision = %s, want transform", rec.Verdict.Decision)
	}
	if rec.Verdict.Transform == nil || rec.Verdict.Transform.Path != "$target.url" {
		t.Errorf("transform.path = %v, want $target.url", rec.Verdict.Transform)
	}
	if rec.Verdict.Transform.Value != nil {
		t.Errorf("transform.value = %v, want dropped (projection)", rec.Verdict.Transform.Value)
	}
	wire, err := json.Marshal(rec.Verdict)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(wire), `"value"`) {
		t.Errorf("record verdict wire carries value member: %s", wire)
	}
	if got := targetURL(t, c); got != "safe" {
		t.Errorf("target.url = %q, want safe (in-process enforcement unaffected)", got)
	}
}

func TestOversizedEvidenceFailsVerdictGate(t *testing.T) {
	// §5.3 (D5): evidence beyond 10240 canonical bytes -> verdict_invalid.
	big := Verdict{
		Decision: Allow,
		Evidence: &Evidence{Artefact: strings.Repeat("x", 10300)},
	}
	e := NewInterceptionEmitter(Enforce, nil)
	e.Register(scripted{big})
	rec := emit(t, e, testCtx())
	if rec.Verdict.Decision != Deny {
		t.Errorf("decision = %s, want deny", rec.Verdict.Decision)
	}
	if rec.Verdict.Reason != string(ErrVerdictInvalid) {
		t.Errorf("reason = %q, want %s", rec.Verdict.Reason, ErrVerdictInvalid)
	}
}
