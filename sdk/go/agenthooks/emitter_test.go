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

func (s scripted) Intercept(context.Context, AgentContext) (Verdict, error) {
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

// panicker panics inside Intercept — §6.3: this must become a fail-closed
// host_error:interceptor_failed deny, never kill the host process.
type panicker struct{}

func (panicker) Intercept(context.Context, AgentContext) (Verdict, error) {
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

func (failing) Intercept(context.Context, AgentContext) (Verdict, error) {
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

// ---- record semantics (§4, §10.1, §10.3) -----------------------------------

// tracking wraps a verdict and records whether it ran.
type tracking struct {
	v   Verdict
	ran *bool
}

func (tr tracking) Intercept(context.Context, AgentContext) (Verdict, error) {
	*tr.ran = true
	return tr.v, nil
}

func TestEnvelopeMissingConditionalFailsClosedPreDispatch(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	ran := false
	e.Register(tracking{AllowVerdict, &ran})
	actx := testCtx()
	delete(actx, "tool_call")
	rec := emit(t, e, actx)
	if rec.Verdict.Reason != string(ErrContextInvalid) {
		t.Errorf("reason = %q, want %q", rec.Verdict.Reason, ErrContextInvalid)
	}
	if ran {
		t.Error("interceptor ran on an invalid envelope")
	}
	if rec.InputIdentity != nil {
		t.Errorf("input_identity = %v, want nil", rec.InputIdentity)
	}
	if rec.InterceptorsRegistered != 1 {
		t.Errorf("interceptors_registered = %d, want 1", rec.InterceptorsRegistered)
	}
}

func TestProviderNameRulesEnforced(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	compute := func(AgentContext) (string, error) { return "x", nil }
	if _, err := e.SetIdentityProvider(&IdentityProvider{Name: "jcs-fake", Compute: compute}); err == nil {
		t.Error("jcs-prefixed name accepted")
	}
	if _, err := e.SetIdentityProvider(&IdentityProvider{Name: "Bad Name", Compute: compute}); err == nil {
		t.Error("malformed name accepted")
	}
	if _, err := e.SetIdentityProvider(&IdentityProvider{Name: "named-no-compute"}); err == nil {
		t.Error("custom provider without Compute accepted")
	}
	if _, err := e.SetIdentityProvider(&IdentityProvider{Name: "myco-hash", Compute: compute}); err != nil {
		t.Errorf("valid name rejected: %v", err)
	}
}

func TestRejectedConsultationRecordsResolvedBy(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, approver{Reject, Verdict{Decision: Deny, Reason: "no"}})
	e.Register(scripted{Escalate("check", "")})
	rec := emit(t, e, testCtx())
	if rec.ResolvedBy == nil || *rec.ResolvedBy != ResolvedByRejection {
		t.Errorf("resolved_by = %v, want rejection", rec.ResolvedBy)
	}
	if rec.Verdict.Reason != "no" {
		t.Errorf("reason = %q, want no", rec.Verdict.Reason)
	}
}

func TestNamesAndCountOnRecord(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	e.SetComposition(RunAllComposition())
	e.RegisterNamed(scripted{AllowVerdict}, "pii-scan")
	e.Register(scripted{AllowVerdict})
	rec := emit(t, e, testCtx())
	if rec.InterceptorsRegistered != 2 {
		t.Errorf("interceptors_registered = %d, want 2", rec.InterceptorsRegistered)
	}
	if len(rec.Verdicts) != 2 || rec.Verdicts[0].Name != "pii-scan" || rec.Verdicts[1].Name != "" {
		t.Errorf("verdicts names = %+v", rec.Verdicts)
	}
}

// ---- emitter seams (mirror sdk/python/tests/test_emitter_seams.py)

// capturingApprover approves, capturing what egressed through the seam.
type capturingApprover struct {
	identity  *string
	presented string
}

func (c *capturingApprover) Resolve(_ context.Context, req ApprovalRequest) (ApprovalResolution, error) {
	c.identity = req.ContextIdentity
	b, _ := json.Marshal(map[string]any(req.Context))
	c.presented = string(b)
	v := Verdict{Decision: Allow}
	return ApprovalResolution{Outcome: Approve, ContextIdentity: req.ContextIdentity, Verdict: &v}, nil
}

func TestApprovalRedactorBindsIdentityToPresentedContext(t *testing.T) {
	capr := &capturingApprover{}
	e := NewInterceptionEmitter(Enforce, capr)
	e.Register(scripted{v: Escalate("check", "")})
	e.SetApprovalRedactor(func(actx AgentContext) AgentContext {
		out, err := ApplyTransformToContext(actx, "$target.url", "[redacted]")
		if err != nil {
			t.Fatalf("redact: %v", err)
		}
		return out
	})
	rec, err := e.EmitUnchecked(context.Background(), testCtx())
	if err != nil {
		t.Fatalf("EmitUnchecked: %v", err)
	}
	if !rec.Proceeds() {
		t.Fatalf("approval should lift: %+v", rec.Verdict)
	}
	if rec.ResolvedBy == nil || *rec.ResolvedBy != ResolvedByApproval {
		t.Fatalf("resolved_by = %v, want approval", rec.ResolvedBy)
	}
	if strings.Contains(capr.presented, "evil") {
		t.Fatalf("unredacted content egressed: %s", capr.presented)
	}
	if capr.identity == nil || rec.InputIdentity == nil || *capr.identity == *rec.InputIdentity {
		t.Fatalf("request identity should cover the redacted context, not the record's")
	}
}

func TestPanickingRedactorFailsClosed(t *testing.T) {
	capr := &capturingApprover{}
	e := NewInterceptionEmitter(Enforce, capr)
	e.Register(scripted{v: Escalate("check", "")})
	e.SetApprovalRedactor(func(AgentContext) AgentContext {
		panic("SECRET must not leak")
	})
	rec, err := e.EmitUnchecked(context.Background(), testCtx())
	if err != nil {
		t.Fatalf("EmitUnchecked: %v", err)
	}
	if rec.Proceeds() {
		t.Fatal("panicking redactor must fail closed")
	}
	if rec.Verdict.Reason != string(ErrApprovalResolverFailed) {
		t.Fatalf("reason = %q, want approval_resolver_failed", rec.Verdict.Reason)
	}
	if strings.Contains(rec.Verdict.Message, "SECRET") {
		t.Fatalf("panic payload leaked: %s", rec.Verdict.Message)
	}
}

func TestRecordSinkAndRingBuffer(t *testing.T) {
	seen := 0
	e := NewInterceptionEmitter(Enforce, nil)
	e.Register(scripted{v: Verdict{Decision: Allow}})
	e.SetRecordSink(func(InterceptionRecord) { seen++ })
	e.SetMaxRecords(2)
	for i := 0; i < 5; i++ {
		if _, err := e.EmitUnchecked(context.Background(), testCtx()); err != nil {
			t.Fatalf("EmitUnchecked: %v", err)
		}
	}
	if seen != 5 {
		t.Fatalf("sink saw %d, want 5", seen)
	}
	if n := len(e.Records()); n != 2 {
		t.Fatalf("buffered %d, want 2", n)
	}
	if d := e.RecordsDropped(); d != 3 {
		t.Fatalf("dropped %d, want 3", d)
	}
	if n := len(e.TakeRecords()); n != 2 {
		t.Fatalf("drained %d, want 2", n)
	}
	if n := len(e.Records()); n != 0 {
		t.Fatalf("buffer after drain %d, want 0", n)
	}
}

func TestSinkPanicIsSwallowed(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	e.Register(scripted{v: Verdict{Decision: Allow}})
	e.SetRecordSink(func(InterceptionRecord) { panic("sink down") })
	rec, err := e.EmitUnchecked(context.Background(), testCtx())
	if err != nil {
		t.Fatalf("EmitUnchecked: %v", err)
	}
	if !rec.Proceeds() {
		t.Fatal("sink panic must not affect the emission outcome")
	}
}

func TestEmitReturnsEffectiveTarget(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	tr := TransformBody{Path: "$target.url", Value: "clean"}
	e.Register(scripted{v: Verdict{Decision: Transform, Transform: &tr}})
	out, err := e.Emit(context.Background(), testCtx())
	if err != nil {
		t.Fatalf("Emit: %v", err)
	}
	target, ok := out.Target.(map[string]any)
	if !ok {
		t.Fatalf("target type %T", out.Target)
	}
	if target["url"] != "clean" {
		t.Fatalf("target.url = %v, want clean", target["url"])
	}
}

func TestSetCompositionRejectsUnknownProfile(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	if _, err := e.SetComposition(CompositionConfig{Profile: "sequential/frist_deny"}); err == nil {
		t.Fatal("typo'd profile must be rejected at configuration time (spec 7.2)")
	}
	// The emitter keeps its previous (default) composition after a
	// rejected call: emissions stay under declared semantics.
	e.Register(scripted{v: AllowVerdict})
	rec := emit(t, e, testCtx())
	if rec.Composition.Profile != SequentialFirstDeny {
		t.Fatalf("composition after rejected set = %q, want default", rec.Composition.Profile)
	}
}

func TestSetCompositionRejectsUnknownKnobValues(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	bad := []CompositionConfig{
		{Profile: SequentialFirstDeny, OnApproval: "pause"},
		{Profile: ParallelUnanimous, OnDisagreement: "escalate"},
		{Profile: ParallelStrictest, OnTransformConflict: "merge"},
	}
	for _, c := range bad {
		if _, err := e.SetComposition(c); err == nil {
			t.Fatalf("knob values outside the closed set must be rejected: %+v", c)
		}
	}
}

func TestSetCompositionEmptyProfileResetsToDefault(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	if _, err := e.SetComposition(RunAllComposition()); err != nil {
		t.Fatalf("SetComposition: %v", err)
	}
	if _, err := e.SetComposition(CompositionConfig{}); err != nil {
		t.Fatalf("empty profile must reset to the default, got %v", err)
	}
	e.Register(scripted{v: AllowVerdict})
	rec := emit(t, e, testCtx())
	if rec.Composition.Profile != SequentialFirstDeny || rec.Composition.OnApproval != OnApprovalStop {
		t.Fatalf("composition = %+v, want default", rec.Composition)
	}
}

// ---- §10.3 host projection failure ------------------------------------------

func TestRecordHostFailureSynthesizesRejectionShape(t *testing.T) {
	// §10.3 host projection failure: the host could not construct a
	// context at all; the synthesized record is the rejection shape
	// with the host's envelope facts.
	e := NewInterceptionEmitter(Enforce, nil)
	e.Register(scripted{v: AllowVerdict})
	seq := int64(7)
	r, err := e.RecordHostFailure(PreToolCall, HostFailure{
		Detail:    "json.UnsupportedTypeError",
		SessionID: "s",
		Sequence:  &seq,
		Timestamp: "2026-01-01T00:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	if r.Proceeds() {
		t.Fatal("host failure must not proceed in enforce mode")
	}
	if r.InterceptionPoint != PreToolCall {
		t.Fatalf("point: %v", r.InterceptionPoint)
	}
	if r.Verdict.Reason != "host_error:context_invalid" {
		t.Fatalf("reason: %q", r.Verdict.Reason)
	}
	if r.Verdict.Message != "json.UnsupportedTypeError" {
		t.Fatalf("message: %q", r.Verdict.Message)
	}
	// §10.3 rejection shape: null identities under the declared
	// provider, nothing dispatched.
	if r.IdentityProvider == nil || *r.IdentityProvider != JCSSHA256 {
		t.Fatalf("identity_provider: %v", r.IdentityProvider)
	}
	if r.InputIdentity != nil || r.EnforcedIdentity != nil {
		t.Fatal("identities must be null")
	}
	if r.DecidedBy != nil {
		t.Fatal("decided_by must be null")
	}
	if len(r.Verdicts) != 0 {
		t.Fatal("no interceptor ran")
	}
	if r.InterceptorsRegistered != 1 {
		t.Fatalf("interceptors_registered: %d", r.InterceptorsRegistered)
	}
	// Envelope facts the host supplied.
	if r.SessionID != "s" || r.Sequence != 7 {
		t.Fatalf("envelope: %q/%d", r.SessionID, r.Sequence)
	}
	if r.Timestamp == nil || *r.Timestamp != "2026-01-01T00:00:00Z" {
		t.Fatalf("timestamp: %v", r.Timestamp)
	}
	// The record entered the emitter's stream like any emission.
	if len(e.Records()) != 1 {
		t.Fatalf("records: %d", len(e.Records()))
	}
}

func TestRecordHostFailureDefaultsAreTheUnknownValues(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	r, err := e.RecordHostFailure(Output, HostFailure{})
	if err != nil {
		t.Fatal(err)
	}
	if r.SessionID != "" || r.Sequence != -1 {
		t.Fatalf("envelope: %q/%d", r.SessionID, r.Sequence)
	}
	if r.Timestamp != nil {
		t.Fatalf("timestamp: %v", r.Timestamp)
	}
	if r.Verdict.Message != "" {
		t.Fatalf("message: %q", r.Verdict.Message)
	}
	if r.InterceptorsRegistered != 0 {
		t.Fatalf("interceptors_registered: %d", r.InterceptorsRegistered)
	}
}

func TestRecordHostFailureEvaluateOnlyRecordsAndHitsSink(t *testing.T) {
	// §8: synthesis still records in evaluate_only — records are the
	// point — and the mode member keeps the record from implying a
	// block happened.
	e := NewInterceptionEmitter(EvaluateOnly, nil)
	var seen []InterceptionRecord
	e.SetRecordSink(func(r InterceptionRecord) { seen = append(seen, r) })
	r, err := e.RecordHostFailure(PreToolCall, HostFailure{Detail: "reflect.ValueError"})
	if err != nil {
		t.Fatal(err)
	}
	if r.Mode != EvaluateOnly {
		t.Fatalf("mode: %v", r.Mode)
	}
	if r.Verdict.Reason != "host_error:context_invalid" {
		t.Fatalf("reason: %q", r.Verdict.Reason)
	}
	if len(seen) != 1 {
		t.Fatalf("sink saw %d records", len(seen))
	}
}

func TestRecordHostFailureDetailTruncatedByProjection(t *testing.T) {
	// §10.3: the synthesized verdict crosses the same payload-free
	// projection as every combined verdict.
	e := NewInterceptionEmitter(Enforce, nil)
	r, err := e.RecordHostFailure(PreToolCall, HostFailure{Detail: strings.Repeat("x", 300)})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(r.Verdict.Message, "…") {
		t.Fatalf("message not truncated: %q", r.Verdict.Message)
	}
	if len(r.Verdict.Message) > 256+len("…") {
		t.Fatalf("message too long: %d bytes", len(r.Verdict.Message))
	}
}
