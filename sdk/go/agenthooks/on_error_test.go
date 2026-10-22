// Copyright (c) Microsoft. All rights reserved.

package agenthooks

// Failure posture tests (spec section 6.3.1, issue #154), mirroring
// the Rust emitter's: on_error deny (default) and continue for the
// three covered failures (raise, timeout, invalid verdict) on the code
// and declaration paths, the substituted allow and its record members,
// the principal notifier, the typed outcomes of a managed interceptor,
// what never continues, and every refusal a Go host can reach.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// notices collects what the emitter told the principal.
type notices struct{ got []ControlFailureNotice }

func (n *notices) notifier() ControlFailureNotifier {
	return func(c ControlFailureNotice) { n.got = append(n.got, c) }
}

// withNotifier returns an emitter with a principal channel installed.
func withNotifier(mode EnforcementMode) (*InterceptionEmitter, *notices) {
	n := &notices{}
	e := NewInterceptionEmitter(mode, nil)
	e.SetControlFailureNotifier(n.notifier())
	return e, n
}

func bestEffort(name string) RegistrationOptions {
	return RegistrationOptions{Name: name, OnError: OnErrorContinue}
}

func mustRegister(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("register: %v", err)
	}
}

// assertSubstituted checks the record members of a slot the host
// substituted under on_error: continue (section 6.3.1, section 10.3).
func assertSubstituted(t *testing.T, rec InterceptionRecord, index int, binding string, reason HostError) {
	t.Helper()
	if index >= len(rec.Verdicts) {
		t.Fatalf("verdicts = %+v, want an entry at %d", rec.Verdicts, index)
	}
	s := rec.Verdicts[index]
	if s.Decision != Allow || s.Reason != "" || s.Name != binding || s.SubstitutedFor != string(reason) {
		t.Errorf("verdicts[%d] = %+v, want allow, no reason, name %q, substituted_for %s", index, s, binding, reason)
	}
	want := Warning{Reason: HostWarningControlFailed, Message: binding + ": " + string(reason) + "; host continued"}
	found := false
	for _, w := range rec.Verdict.Warnings {
		if w == want {
			found = true
		}
	}
	if !found {
		t.Errorf("warning %+v missing from the union: %+v", want, rec.Verdict.Warnings)
	}
}

// assertNotified checks the one notice the principal received.
func assertNotified(t *testing.T, n *notices, index int, binding string, reason HostError, point InterceptionPoint) {
	t.Helper()
	if len(n.got) != 1 {
		t.Fatalf("notices = %+v, want exactly one", n.got)
	}
	got := n.got[0]
	want := ControlFailureNotice{
		InterceptionPoint: point, Index: index, Binding: binding, Reason: reason,
		Message: binding + ": " + string(reason) + "; host continued",
	}
	if got != want {
		t.Errorf("notice = %+v, want %+v", got, want)
	}
}

// ---- the three covered failures under continue (code path) ----------------

func TestContinueSubstitutesAllowForAPanic(t *testing.T) {
	e, n := withNotifier(Enforce)
	mustRegister(t, e.RegisterWithOptions(panicker{}, bestEffort("flaky")))
	e.Register(scripted{Verdict{Decision: Allow, Reason: "second", Warnings: []Warning{{Reason: "late"}}}})
	rec := emit(t, e, testCtx())
	if rec.Verdict.Decision != Allow {
		t.Fatalf("decision = %s, want allow", rec.Verdict.Decision)
	}
	assertSubstituted(t, rec, 0, "flaky", ErrInterceptorFailed)
	assertNotified(t, n, 0, "flaky", ErrInterceptorFailed, PreToolCall)
	if rec.DecidedBy != nil {
		t.Errorf("decided_by = %d, want null (pure allow)", *rec.DecidedBy)
	}
	if rec.FoldTruncated == nil || *rec.FoldTruncated {
		t.Errorf("fold_truncated = %v, want false: the second interceptor ran", rec.FoldTruncated)
	}
	if len(rec.Verdicts) != 2 || rec.Verdicts[1].Reason != "second" {
		t.Errorf("verdicts = %+v, want the second interceptor's entry", rec.Verdicts)
	}
	if len(rec.Verdict.Warnings) != 2 {
		t.Errorf("warnings = %+v, want the substitution's and the second interceptor's", rec.Verdict.Warnings)
	}
	// The panic payload never reaches the record or the principal.
	b, _ := json.Marshal(rec)
	if strings.Contains(string(b), "interceptor bug") || strings.Contains(n.got[0].Message, "interceptor bug") {
		t.Error("panic payload leaked")
	}
}

func TestContinueSubstitutesAllowForAnError(t *testing.T) {
	e, n := withNotifier(Enforce)
	mustRegister(t, e.RegisterWithOptions(failing{}, bestEffort("flaky")))
	rec := emit(t, e, testCtx())
	if rec.Verdict.Decision != Allow {
		t.Fatalf("decision = %s, want allow", rec.Verdict.Decision)
	}
	assertSubstituted(t, rec, 0, "flaky", ErrInterceptorFailed)
	assertNotified(t, n, 0, "flaky", ErrInterceptorFailed, PreToolCall)
}

func TestContinueSubstitutesAllowForATimeout(t *testing.T) {
	e, n := withNotifier(Enforce)
	e.Timeout = 20 * time.Millisecond
	mustRegister(t, e.RegisterWithOptions(slowInterceptor{2 * time.Second}, bestEffort("slow")))
	start := time.Now()
	rec := emit(t, e, testCtx())
	if time.Since(start) > time.Second {
		t.Error("the emitter-wide timeout did not bound the call")
	}
	if rec.Verdict.Decision != Allow {
		t.Fatalf("decision = %s, want allow", rec.Verdict.Decision)
	}
	assertSubstituted(t, rec, 0, "slow", ErrInterceptorTimeout)
	assertNotified(t, n, 0, "slow", ErrInterceptorTimeout, PreToolCall)
}

func TestContinueSubstitutesAllowForAnInvalidVerdict(t *testing.T) {
	cases := map[string]Verdict{
		"forged host_error reason":   {Decision: Deny, Reason: "host_error:interceptor_failed"},
		"reserved host_warning":      Warn(HostWarningControlFailed, "forged"),
		"transform without a body":   {Decision: Transform},
		"approval on an allow":       {Decision: Allow, Approval: map[string]any{}},
		"oversized evidence (5.3)":   {Decision: Allow, Evidence: &Evidence{Artefact: strings.Repeat("x", 10300)}},
		"decision outside the set":   {Decision: "warn"},
		"host_error warning on deny": {Decision: Deny, Reason: "x", Warnings: []Warning{{Reason: "host_error:x"}}},
	}
	for name, v := range cases {
		e, n := withNotifier(Enforce)
		mustRegister(t, e.RegisterWithOptions(scripted{v}, bestEffort("broken")))
		rec := emit(t, e, testCtx())
		if rec.Verdict.Decision != Allow {
			t.Errorf("%s: decision = %s, want allow", name, rec.Verdict.Decision)
			continue
		}
		assertSubstituted(t, rec, 0, "broken", ErrVerdictInvalid)
		assertNotified(t, n, 0, "broken", ErrVerdictInvalid, PreToolCall)
	}
}

// ---- the same three under deny (the default, unchanged) -------------------

func TestDenyIsTheDefaultForEveryRegistrationForm(t *testing.T) {
	cases := map[string]func(e *InterceptionEmitter, i Interceptor){
		"Register":      func(e *InterceptionEmitter, i Interceptor) { e.Register(i) },
		"RegisterNamed": func(e *InterceptionEmitter, i Interceptor) { e.RegisterNamed(i, "n") },
		"RegisterAt":    func(e *InterceptionEmitter, i Interceptor) { mustRegister(t, e.RegisterAt(i, "n", nil)) },
		"RegisterWithOptions": func(e *InterceptionEmitter, i Interceptor) {
			mustRegister(t, e.RegisterWithOptions(i, RegistrationOptions{}))
		},
		"explicit deny": func(e *InterceptionEmitter, i Interceptor) {
			mustRegister(t, e.RegisterWithOptions(i, RegistrationOptions{OnError: OnErrorDeny}))
		},
	}
	faults := map[string]struct {
		interceptor Interceptor
		reason      HostError
	}{
		"raise":   {panicker{}, ErrInterceptorFailed},
		"timeout": {slowInterceptor{2 * time.Second}, ErrInterceptorTimeout},
		"invalid": {scripted{Verdict{Decision: Transform}}, ErrVerdictInvalid},
	}
	for form, register := range cases {
		for fault, f := range faults {
			e, n := withNotifier(Enforce)
			e.Timeout = 20 * time.Millisecond
			register(e, f.interceptor)
			rec := emit(t, e, testCtx())
			if rec.Verdict.Decision != Deny || rec.Verdict.Reason != string(f.reason) {
				t.Errorf("%s/%s: verdict = %+v, want deny %s", form, fault, rec.Verdict, f.reason)
			}
			if rec.DecidedBy == nil || *rec.DecidedBy != 0 {
				t.Errorf("%s/%s: decided_by = %v, want 0", form, fault, rec.DecidedBy)
			}
			if len(rec.Verdicts) != 1 || rec.Verdicts[0].SubstitutedFor != "" {
				t.Errorf("%s/%s: verdicts = %+v, want one entry without substituted_for", form, fault, rec.Verdicts)
			}
			if len(n.got) != 0 {
				t.Errorf("%s/%s: the principal was notified under deny: %+v", form, fault, n.got)
			}
			for _, w := range rec.Verdict.Warnings {
				if w.Reason == HostWarningControlFailed {
					t.Errorf("%s/%s: control_failed warning under deny", form, fault)
				}
			}
		}
	}
}

// ---- what never continues ----------------------------------------------------

type cancelAware struct{}

func (cancelAware) Intercept(ctx context.Context, _ AgentContext) (Verdict, error) {
	<-ctx.Done()
	return Verdict{}, ctx.Err()
}

func TestCancellationNeverContinues(t *testing.T) {
	e, n := withNotifier(Enforce)
	mustRegister(t, e.RegisterWithOptions(cancelAware{}, bestEffort("flaky")))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rec, err := e.EmitUnchecked(ctx, testCtx())
	if err != nil {
		t.Fatal(err)
	}
	if rec.Verdict.Decision != Deny || rec.Verdict.Reason != string(ErrInterceptorFailed) {
		t.Errorf("verdict = %+v, want deny interceptor_failed", rec.Verdict)
	}
	if rec.Verdicts[0].SubstitutedFor != "" || len(n.got) != 0 {
		t.Errorf("a cancellation was substituted: %+v %+v", rec.Verdicts, n.got)
	}
}

func TestApprovalFailureNeverContinues(t *testing.T) {
	n := &notices{}
	e := NewInterceptionEmitter(Enforce, panickyResolver{})
	e.SetControlFailureNotifier(n.notifier())
	mustRegister(t, e.RegisterWithOptions(scripted{Escalate("check", "")}, bestEffort("gate")))
	rec := emit(t, e, testCtx())
	if rec.Verdict.Decision != Deny || rec.Verdict.Reason != string(ErrApprovalResolverFailed) {
		t.Errorf("verdict = %+v, want deny approval_resolver_failed", rec.Verdict)
	}
	if rec.ResolvedBy == nil || *rec.ResolvedBy != ResolvedByRejection {
		t.Errorf("resolved_by = %v, want rejection", rec.ResolvedBy)
	}
	if rec.Verdicts[0].SubstitutedFor != "" || len(n.got) != 0 {
		t.Errorf("an approval failure was substituted: %+v %+v", rec.Verdicts, n.got)
	}
}

func TestTransformFailureNeverContinues(t *testing.T) {
	e, n := withNotifier(Enforce)
	mustRegister(t, e.RegisterWithOptions(scripted{transformVerdict("$target.nope.deeper", "x")}, bestEffort("rewriter")))
	rec := emit(t, e, testCtx())
	if rec.Verdict.Decision != Deny || !strings.HasPrefix(rec.Verdict.Reason, "host_error:transform_") {
		t.Errorf("verdict = %+v, want a transform deny", rec.Verdict)
	}
	if rec.Verdicts[0].SubstitutedFor != "" || len(n.got) != 0 {
		t.Errorf("a transform failure was substituted: %+v %+v", rec.Verdicts, n.got)
	}
}

func TestExplicitDenyAndNoInterceptorNeverContinue(t *testing.T) {
	e, n := withNotifier(Enforce)
	mustRegister(t, e.RegisterWithOptions(scripted{DenyVerdict("policy:no", "")}, RegistrationOptions{
		Name: "guard", At: []InterceptionPoint{PreToolCall}, OnError: OnErrorContinue,
	}))
	rec := emit(t, e, testCtx())
	if rec.Verdict.Decision != Deny || rec.Verdict.Reason != "policy:no" {
		t.Errorf("verdict = %+v, want the interceptor's deny", rec.Verdict)
	}
	// No binding at input: fails closed, whatever the registrations say.
	c := testCtx()
	c["interception_point"] = "input"
	in := map[string]any{"content": "hi", "role": "user"}
	c["target"], c["input"] = in, in
	delete(c, "tool_call")
	rec = emit(t, e, c)
	if rec.Verdict.Reason != string(ErrNoInterceptor) {
		t.Errorf("verdict = %+v, want no_interceptor", rec.Verdict)
	}
	if len(n.got) != 0 {
		t.Errorf("the principal was notified: %+v", n.got)
	}
}

// ---- notifier semantics ------------------------------------------------------

func TestContinueRequiresANotifierAtRegistration(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	err := e.RegisterWithOptions(panicker{}, bestEffort("flaky"))
	if !errors.Is(err, ErrControlFailureNotifierMissing) {
		t.Fatalf("err = %v, want ErrControlFailureNotifierMissing", err)
	}
	if err := e.RegisterManaged(managedScript{outcome: ManagedTimeout()}, bestEffort("slow")); !errors.Is(err, ErrControlFailureNotifierMissing) {
		t.Fatalf("managed: err = %v, want ErrControlFailureNotifierMissing", err)
	}
	if len(e.bound) != 0 {
		t.Fatal("a refused registration must register nothing")
	}
	// Nothing registered: the emission fails closed on no_interceptor.
	if rec := emit(t, e, testCtx()); rec.Verdict.Reason != string(ErrNoInterceptor) {
		t.Errorf("verdict = %+v", rec.Verdict)
	}
	// With the notifier set first, the same registration is accepted.
	e.SetControlFailureNotifier(func(ControlFailureNotice) {})
	mustRegister(t, e.RegisterWithOptions(panicker{}, bestEffort("flaky")))
}

func TestClearingTheNotifierWithContinueRegistrationsPanics(t *testing.T) {
	// The setter refuses to leave a continue registration without its
	// principal channel: nil clears only while none exists, and a
	// replacement channel is still accepted.
	e, _ := withNotifier(Enforce)
	e.SetControlFailureNotifier(nil)
	e.SetControlFailureNotifier(func(ControlFailureNotice) {})
	mustRegister(t, e.RegisterWithOptions(panicker{}, bestEffort("flaky")))
	func() {
		defer func() {
			r := recover()
			msg, _ := r.(string)
			if r == nil || !strings.Contains(msg, "flaky") || !strings.Contains(msg, "on_error: continue") {
				t.Fatalf("recovered %v, want a panic naming the continue registration", r)
			}
		}()
		e.SetControlFailureNotifier(nil)
	}()
	if e.notifier == nil {
		t.Fatal("a refused clear must leave the notifier in place")
	}
	swapped := &notices{}
	e.SetControlFailureNotifier(swapped.notifier())
	rec := emit(t, e, testCtx())
	if rec.Verdict.Decision != Allow || len(swapped.got) != 1 {
		t.Errorf("verdict = %+v, notices = %+v; want the swapped channel to carry the notice", rec.Verdict, swapped.got)
	}
	// Managed registrations hold the channel the same way.
	m := NewInterceptionEmitter(Enforce, nil)
	m.SetControlFailureNotifier(func(ControlFailureNotice) {})
	mustRegister(t, m.RegisterManaged(managedScript{outcome: ManagedTimeout()}, bestEffort("slow")))
	func() {
		defer func() {
			if r := recover(); r == nil {
				t.Fatal("clearing the notifier under a managed continue registration must panic")
			}
		}()
		m.SetControlFailureNotifier(nil)
	}()
}

func TestNotifierClearedAfterRegistrationKeepsTheDeny(t *testing.T) {
	// The emit-time guard behind the setter's refusal: a continue
	// registration whose channel went away anyway (the field is
	// written directly here, as the setter no longer allows it) denies
	// with a message saying so rather than continuing silently.
	e, _ := withNotifier(Enforce)
	mustRegister(t, e.RegisterWithOptions(panicker{}, bestEffort("flaky")))
	e.notifier = nil
	rec := emit(t, e, testCtx())
	if rec.Verdict.Decision != Deny || rec.Verdict.Reason != string(ErrInterceptorFailed) {
		t.Errorf("verdict = %+v, want deny interceptor_failed", rec.Verdict)
	}
	if !strings.Contains(rec.Verdict.Message, "notifier") || rec.Verdicts[0].SubstitutedFor != "" {
		t.Errorf("record = %+v, want a deny naming the missing notifier and no substituted_for", rec)
	}
}

func TestPanickingNotifierKeepsTheDeny(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	e.SetControlFailureNotifier(func(ControlFailureNotice) { panic("channel down") })
	mustRegister(t, e.RegisterWithOptions(failing{}, bestEffort("flaky")))
	rec := emit(t, e, testCtx())
	if rec.Verdict.Decision != Deny || rec.Verdict.Reason != string(ErrInterceptorFailed) {
		t.Errorf("verdict = %+v, want deny interceptor_failed", rec.Verdict)
	}
	if !strings.Contains(rec.Verdict.Message, "notifier panicked") || rec.Verdicts[0].SubstitutedFor != "" {
		t.Errorf("record = %+v, want the deny to say the notifier panicked", rec)
	}
}

func TestNotifierRunsBeforeTheSubstitutionTakesEffect(t *testing.T) {
	var order []string
	e := NewInterceptionEmitter(Enforce, nil)
	e.SetControlFailureNotifier(func(ControlFailureNotice) { order = append(order, "notified") })
	mustRegister(t, e.RegisterWithOptions(failing{}, bestEffort("flaky")))
	e.Register(witness{func() { order = append(order, "second ran") }})
	emit(t, e, testCtx())
	if strings.Join(order, ",") != "notified,second ran" {
		t.Errorf("order = %v", order)
	}
}

// witness runs a callback and allows.
type witness struct{ f func() }

func (w witness) Intercept(context.Context, AgentContext) (Verdict, error) {
	w.f()
	return AllowVerdict, nil
}

func TestUnnamedRegistrationIsLabelledByIndex(t *testing.T) {
	e, n := withNotifier(Enforce)
	e.Register(scripted{AllowVerdict})
	mustRegister(t, e.RegisterWithOptions(failing{}, RegistrationOptions{OnError: OnErrorContinue}))
	rec := emit(t, e, testCtx())
	if rec.Verdict.Decision != Allow {
		t.Fatalf("decision = %s", rec.Verdict.Decision)
	}
	s := rec.Verdicts[1]
	if s.Decision != Allow || s.Name != "" || s.SubstitutedFor != string(ErrInterceptorFailed) {
		t.Errorf("an unnamed registration records no name but the reason: %+v", s)
	}
	want := "interceptor-1: host_error:interceptor_failed; host continued"
	if len(rec.Verdict.Warnings) != 1 || rec.Verdict.Warnings[0].Message != want {
		t.Errorf("warnings = %+v, want %q", rec.Verdict.Warnings, want)
	}
	assertNotified(t, n, 1, "interceptor-1", ErrInterceptorFailed, PreToolCall)
}

func TestNotifierMayBeSetOnASealedEmitter(t *testing.T) {
	reg := testRegistry(t)
	em, err := NewInterceptionEmitterFromDeclarationValue(testDocument(), reg)
	if err != nil {
		t.Fatal(err)
	}
	// A host channel, like SetRecordSink: not declared configuration.
	em.SetControlFailureNotifier(func(ControlFailureNotice) {})
	if em.notifier == nil {
		t.Error("the notifier was not installed")
	}
}

// ---- registration refusals ---------------------------------------------------

func TestRegistrationOptionRefusals(t *testing.T) {
	e, _ := withNotifier(Enforce)
	if err := e.RegisterWithOptions(nil, RegistrationOptions{}); err == nil {
		t.Error("nil interceptor accepted")
	}
	if err := e.RegisterManaged(nil, RegistrationOptions{}); err == nil {
		t.Error("nil managed interceptor accepted")
	}
	if err := e.RegisterWithOptions(scripted{AllowVerdict}, RegistrationOptions{OnError: "ignore"}); err == nil || !strings.Contains(err.Error(), "on_error") {
		t.Errorf("unknown on_error accepted: %v", err)
	}
	if err := e.RegisterWithOptions(scripted{AllowVerdict}, RegistrationOptions{At: []InterceptionPoint{}}); err == nil {
		t.Error("empty point list accepted")
	}
	if err := e.RegisterWithOptions(scripted{AllowVerdict}, RegistrationOptions{At: []InterceptionPoint{"nope"}}); err == nil {
		t.Error("unknown point accepted")
	}
	if len(e.bound) != 0 {
		t.Fatalf("refused registrations left %d bindings", len(e.bound))
	}
	sealed, err := NewInterceptionEmitterFromDeclarationValue(testDocument(), testRegistry(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := sealed.RegisterWithOptions(scripted{AllowVerdict}, RegistrationOptions{}); !errors.Is(err, ErrEmitterSealed) {
		t.Errorf("sealed RegisterWithOptions: %v", err)
	}
	if err := sealed.RegisterManaged(managedScript{}, RegistrationOptions{}); !errors.Is(err, ErrEmitterSealed) {
		t.Errorf("sealed RegisterManaged: %v", err)
	}
	for _, v := range []OnError{"", OnErrorDeny, OnErrorContinue} {
		if err := v.Validate(); err != nil {
			t.Errorf("%q: %v", v, err)
		}
	}
	if OnError("ignore").Validate() == nil {
		t.Error("ignore accepted by Validate")
	}
}

// ---- composition profiles ----------------------------------------------------

func TestRunAllDenyWinsOverASubstitutedAllow(t *testing.T) {
	e, n := withNotifier(Enforce)
	e.SetComposition(RunAllComposition())
	mustRegister(t, e.RegisterWithOptions(failing{}, bestEffort("flaky")))
	e.RegisterNamed(scripted{DenyVerdict("policy:blocked", "")}, "guard")
	e.RegisterNamed(scripted{AllowVerdict}, "second")
	rec := emit(t, e, testCtx())
	if rec.Verdict.Decision != Deny || rec.Verdict.Reason != "policy:blocked" {
		t.Errorf("verdict = %+v, want the guard's deny", rec.Verdict)
	}
	if rec.DecidedBy == nil || *rec.DecidedBy != 1 {
		t.Errorf("decided_by = %v, want 1", rec.DecidedBy)
	}
	assertSubstituted(t, rec, 0, "flaky", ErrInterceptorFailed)
	assertNotified(t, n, 0, "flaky", ErrInterceptorFailed, PreToolCall)
	if len(rec.Verdicts) != 3 || rec.Verdicts[1].SubstitutedFor != "" || rec.Verdicts[2].SubstitutedFor != "" {
		t.Errorf("verdicts = %+v", rec.Verdicts)
	}
}

func TestParallelProfilesCarryTheSubstitutedAllow(t *testing.T) {
	for _, comp := range []CompositionConfig{
		StrictestComposition(SynthesizeDeny),
		UnanimousComposition(SynthesizeDeny, SynthesizeDeny),
	} {
		e, n := withNotifier(Enforce)
		e.SetComposition(comp)
		mustRegister(t, e.RegisterWithOptions(panicker{}, bestEffort("flaky")))
		e.RegisterNamed(scripted{AllowVerdict}, "second")
		rec := emit(t, e, testCtx())
		if rec.Verdict.Decision != Allow {
			t.Errorf("%s: decision = %s, want allow (the core aggregation accepts the substituted shape)", comp.Profile, rec.Verdict.Decision)
			continue
		}
		assertSubstituted(t, rec, 0, "flaky", ErrInterceptorFailed)
		assertNotified(t, n, 0, "flaky", ErrInterceptorFailed, PreToolCall)
		if rec.DecidedBy != nil {
			t.Errorf("%s: decided_by = %d, want null", comp.Profile, *rec.DecidedBy)
		}
	}
}

func TestEvaluateOnlyRecordsTheSubstitutionToo(t *testing.T) {
	e, n := withNotifier(EvaluateOnly)
	mustRegister(t, e.RegisterWithOptions(failing{}, bestEffort("flaky")))
	rec := emit(t, e, testCtx())
	assertSubstituted(t, rec, 0, "flaky", ErrInterceptorFailed)
	assertNotified(t, n, 0, "flaky", ErrInterceptorFailed, PreToolCall)
}

// ---- managed interceptors (typed outcomes) -----------------------------------

// managedScript returns a fixed outcome and records the bound it was
// handed.
type managedScript struct {
	outcome ManagedOutcome
	bound   *time.Duration
}

func (m managedScript) InterceptManaged(_ context.Context, _ AgentContext, bound time.Duration) ManagedOutcome {
	if m.bound != nil {
		*m.bound = bound
	}
	return m.outcome
}

type managedPanics struct{}

func (managedPanics) InterceptManaged(context.Context, AgentContext, time.Duration) ManagedOutcome {
	panic("managed bug")
}

func TestManagedOutcomesUnderDeny(t *testing.T) {
	cases := map[string]struct {
		outcome ManagedOutcome
		reason  HostError
	}{
		"timeout":   {ManagedTimeout(), ErrInterceptorTimeout},
		"cancelled": {ManagedCancelled(), ErrInterceptorFailed},
		"failed":    {ManagedFailed("IOError"), ErrInterceptorFailed},
		"zero":      {ManagedOutcome{}, ErrInterceptorFailed},
		"forged":    {ManagedVerdict(Verdict{Decision: Allow, Reason: "host_error:x"}), ErrVerdictInvalid},
	}
	for name, c := range cases {
		e := NewInterceptionEmitter(Enforce, nil)
		mustRegister(t, e.RegisterManaged(managedScript{outcome: c.outcome}, RegistrationOptions{Name: "m"}))
		rec := emit(t, e, testCtx())
		if rec.Verdict.Decision != Deny || rec.Verdict.Reason != string(c.reason) {
			t.Errorf("%s: verdict = %+v, want deny %s", name, rec.Verdict, c.reason)
		}
		if rec.DecidedBy == nil || *rec.DecidedBy != 0 || rec.Verdicts[0].Name != "m" {
			t.Errorf("%s: attribution %v %+v", name, rec.DecidedBy, rec.Verdicts)
		}
	}
	e := NewInterceptionEmitter(Enforce, nil)
	mustRegister(t, e.RegisterManaged(managedScript{outcome: ManagedFailed("IOError")}, RegistrationOptions{}))
	if rec := emit(t, e, testCtx()); rec.Verdict.Message != "IOError" {
		t.Errorf("failed detail = %q, want the type name", rec.Verdict.Message)
	}
	e = NewInterceptionEmitter(Enforce, nil)
	mustRegister(t, e.RegisterManaged(managedPanics{}, RegistrationOptions{}))
	rec := emit(t, e, testCtx())
	if rec.Verdict.Reason != string(ErrInterceptorFailed) || strings.Contains(rec.Verdict.Message, "managed bug") {
		t.Errorf("panic: %+v", rec.Verdict)
	}
}

func TestManagedOutcomesUnderContinue(t *testing.T) {
	cases := map[string]struct {
		outcome   ManagedOutcome
		continues bool
		reason    HostError
	}{
		"timeout":   {ManagedTimeout(), true, ErrInterceptorTimeout},
		"failed":    {ManagedFailed("IOError"), true, ErrInterceptorFailed},
		"forged":    {ManagedVerdict(Verdict{Decision: Transform}), true, ErrVerdictInvalid},
		"panic":     {ManagedOutcome{}, true, ErrInterceptorFailed},
		"cancelled": {ManagedCancelled(), false, ErrInterceptorFailed},
	}
	for name, c := range cases {
		e, n := withNotifier(Enforce)
		mustRegister(t, e.RegisterManaged(managedScript{outcome: c.outcome}, bestEffort("m")))
		rec := emit(t, e, testCtx())
		if !c.continues {
			if rec.Verdict.Decision != Deny || rec.Verdict.Reason != string(c.reason) {
				t.Errorf("%s: verdict = %+v, want deny %s", name, rec.Verdict, c.reason)
			}
			if rec.Verdicts[0].SubstitutedFor != "" || len(n.got) != 0 {
				t.Errorf("%s: a cancelled outcome was substituted: %+v %+v", name, rec.Verdicts, n.got)
			}
			continue
		}
		if rec.Verdict.Decision != Allow {
			t.Errorf("%s: decision = %s, want allow", name, rec.Verdict.Decision)
			continue
		}
		assertSubstituted(t, rec, 0, "m", c.reason)
		assertNotified(t, n, 0, "m", c.reason, PreToolCall)
	}
}

func TestManagedInterceptorReceivesTheResolvedBoundAndNoSecondTimer(t *testing.T) {
	// Code registration: the emitter-wide Timeout, including 0 for
	// unbounded.
	for _, want := range []time.Duration{DefaultTimeout, 250 * time.Millisecond, 0} {
		var got time.Duration
		e := NewInterceptionEmitter(Enforce, nil)
		e.Timeout = want
		mustRegister(t, e.RegisterManaged(managedScript{outcome: ManagedVerdict(AllowVerdict), bound: &got}, RegistrationOptions{}))
		if rec := emit(t, e, testCtx()); rec.Verdict.Decision != Allow {
			t.Errorf("verdict = %+v", rec.Verdict)
		}
		if got != want {
			t.Errorf("bound = %v, want %v", got, want)
		}
	}
	// The emitter does not wrap a managed interceptor in its own timer:
	// a managed call that outlives Timeout still returns its verdict.
	e := NewInterceptionEmitter(Enforce, nil)
	e.Timeout = 10 * time.Millisecond
	mustRegister(t, e.RegisterManaged(slowManaged{60 * time.Millisecond}, RegistrationOptions{}))
	if rec := emit(t, e, testCtx()); rec.Verdict.Decision != Allow {
		t.Errorf("a second timer ended the managed call: %+v", rec.Verdict)
	}
	// Declaration binding: the binding's own timeout_ms.
	var got time.Duration
	reg := NewHostRegistry(testSurface())
	mustRegister(t, reg.ManagedKind("com.example.managed", func(_ json.RawMessage, bctx BindingContext) (ManagedInterceptor, error) {
		if bctx.OnError != OnErrorDeny {
			t.Errorf("BindingContext.OnError = %q, want deny", bctx.OnError)
		}
		return managedScript{outcome: ManagedVerdict(AllowVerdict), bound: &got}, nil
	}))
	em, err := NewInterceptionEmitterFromDeclarationValue(map[string]any{
		"declaration":   DeclarationVersion,
		"configuration": map[string]any{"timeouts": map[string]any{"interceptor_ms": 60000}},
		"bindings":      []any{map[string]any{"id": "m", "kind": "com.example.managed", "timeout_ms": 1500}},
	}, reg)
	if err != nil {
		t.Fatal(err)
	}
	emit(t, em, fixedCtx(PreToolCall, 0))
	if got != 1500*time.Millisecond {
		t.Errorf("declared bound = %v, want 1.5s", got)
	}
}

// slowManaged sleeps past the emitter's Timeout and then allows.
type slowManaged struct{ d time.Duration }

func (s slowManaged) InterceptManaged(context.Context, AgentContext, time.Duration) ManagedOutcome {
	time.Sleep(s.d)
	return ManagedVerdict(AllowVerdict)
}

// ---- the section 5 gate on reserved warnings ---------------------------------

func TestInterceptorsMayNotEmitHostWarnings(t *testing.T) {
	e := NewInterceptionEmitter(Enforce, nil)
	e.Register(scripted{Warn(HostWarningControlFailed, "forged")})
	rec := emit(t, e, testCtx())
	if rec.Verdict.Reason != string(ErrVerdictInvalid) {
		t.Errorf("verdict = %+v, want verdict_invalid", rec.Verdict)
	}
	// The pure-Go mirror agrees.
	if Warn("host_warning:other", "").Validate() == nil || Warn("host_error:x", "").Validate() == nil {
		t.Error("Validate accepts a reserved warning reason")
	}
	if Warn("policy:slow", "").Validate() != nil {
		t.Error("Validate refuses an ordinary warning")
	}
	for _, e := range []HostError{ErrInterceptorFailed, ErrInterceptorTimeout, ErrVerdictInvalid} {
		if !e.IsControlFailure() {
			t.Errorf("%s must be a control failure", e)
		}
	}
	for _, e := range []HostError{ErrContextInvalid, ErrTransformInvalid, ErrApprovalResolverFailed, ErrNoInterceptor} {
		if e.IsControlFailure() {
			t.Errorf("%s must not be a control failure", e)
		}
	}
}

// ---- declaration path --------------------------------------------------------

// onErrorRegistry is a registry with a raising kind, a slow kind and
// an allow kind, with or without the principal channel.
func onErrorRegistry(t *testing.T, n *notices) *HostRegistry {
	t.Helper()
	reg := NewHostRegistry(testSurface())
	mustRegister(t, reg.Kind("com.example.raise", func(json.RawMessage, BindingContext) (Interceptor, error) {
		return failing{}, nil
	}))
	mustRegister(t, reg.Kind("com.example.slow", func(json.RawMessage, BindingContext) (Interceptor, error) {
		return slowInterceptor{2 * time.Second}, nil
	}))
	mustRegister(t, reg.Kind("com.example.allow", func(json.RawMessage, BindingContext) (Interceptor, error) {
		return scripted{Verdict{Decision: Allow, Reason: "second-ran"}}, nil
	}))
	if n != nil {
		mustRegister(t, reg.ControlFailureNotifier(n.notifier()))
	}
	return reg
}

func TestDeclaredOnErrorContinueAndDeny(t *testing.T) {
	type tc struct {
		configuration map[string]any
		binding       map[string]any
		continues     bool
		reason        HostError
	}
	cases := map[string]tc{
		"binding continue, raise": {nil,
			map[string]any{"id": "flaky", "kind": "com.example.raise", "on_error": "continue"}, true, ErrInterceptorFailed},
		"binding continue, timeout": {nil,
			map[string]any{"id": "flaky", "kind": "com.example.slow", "timeout_ms": 20, "on_error": "continue"}, true, ErrInterceptorTimeout},
		"binding deny, raise": {nil,
			map[string]any{"id": "flaky", "kind": "com.example.raise", "on_error": "deny"}, false, ErrInterceptorFailed},
		"absent on_error is deny": {nil,
			map[string]any{"id": "flaky", "kind": "com.example.raise"}, false, ErrInterceptorFailed},
		"document default inherited": {map[string]any{"failure": map[string]any{"on_error": "continue"}},
			map[string]any{"id": "flaky", "kind": "com.example.raise"}, true, ErrInterceptorFailed},
		"binding overrides default to deny": {map[string]any{"failure": map[string]any{"on_error": "continue"}},
			map[string]any{"id": "flaky", "kind": "com.example.raise", "on_error": "deny"}, false, ErrInterceptorFailed},
		"binding overrides default to continue": {map[string]any{"failure": map[string]any{"on_error": "deny"}},
			map[string]any{"id": "flaky", "kind": "com.example.raise", "on_error": "continue"}, true, ErrInterceptorFailed},
	}
	for name, c := range cases {
		n := &notices{}
		reg := onErrorRegistry(t, n)
		doc := map[string]any{
			"declaration": DeclarationVersion,
			"bindings":    []any{c.binding, map[string]any{"id": "second", "kind": "com.example.allow"}},
		}
		if c.configuration != nil {
			doc["configuration"] = c.configuration
		}
		em, err := NewInterceptionEmitterFromDeclarationValue(doc, reg)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		wantBinding := OnErrorDeny
		if c.continues {
			wantBinding = OnErrorContinue
		}
		if got := em.Declaration().Bindings[0].OnError; got != wantBinding {
			t.Errorf("%s: resolved binding on_error = %q, want %q", name, got, wantBinding)
		}
		rec := emit(t, em, fixedCtx(PreToolCall, 0))
		if rec.Declaration == nil || *rec.Declaration != DeclarationVersion {
			t.Errorf("%s: declaration stamp %v", name, rec.Declaration)
		}
		if !c.continues {
			if rec.Verdict.Decision != Deny || rec.Verdict.Reason != string(c.reason) {
				t.Errorf("%s: verdict = %+v, want deny %s", name, rec.Verdict, c.reason)
			}
			if len(rec.Verdicts) != 1 || rec.Verdicts[0].SubstitutedFor != "" || len(n.got) != 0 {
				t.Errorf("%s: substituted under deny: %+v %+v", name, rec.Verdicts, n.got)
			}
			continue
		}
		if rec.Verdict.Decision != Allow {
			t.Errorf("%s: decision = %s, want allow", name, rec.Verdict.Decision)
			continue
		}
		assertSubstituted(t, rec, 0, "flaky", c.reason)
		assertNotified(t, n, 0, "flaky", c.reason, PreToolCall)
		if len(rec.Verdicts) != 2 || rec.Verdicts[1].Name != "second" || rec.Verdicts[1].Reason != "second-ran" {
			t.Errorf("%s: the second binding did not run: %+v", name, rec.Verdicts)
		}
		if rec.FoldTruncated == nil || *rec.FoldTruncated || rec.DecidedBy != nil {
			t.Errorf("%s: fold_truncated %v decided_by %v", name, rec.FoldTruncated, rec.DecidedBy)
		}
	}
}

func TestResolvedFormCarriesTheFailurePostureForEveryVersion(t *testing.T) {
	reg := onErrorRegistry(t, nil)
	for _, version := range SupportedDeclarationVersions {
		em, err := NewInterceptionEmitterFromDeclarationValue(map[string]any{
			"declaration": version,
			"bindings":    []any{map[string]any{"id": "a", "kind": "com.example.allow"}},
		}, reg)
		if err != nil {
			t.Fatalf("%s: %v", version, err)
		}
		d := em.Declaration()
		if d.Configuration.Failure.OnError != OnErrorDeny || d.Bindings[0].OnError != OnErrorDeny {
			t.Errorf("%s: resolved failure posture %+v %+v, want deny", version, d.Configuration.Failure, d.Bindings[0])
		}
		canon, err := d.CanonicalJSON()
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(canon, `"failure":{"on_error":"deny"}`) || !strings.Contains(canon, `"on_error":"deny"`) {
			t.Errorf("%s: canonical form lacks the posture: %s", version, canon)
		}
	}
}

func TestADeclaration10LoadsUnchanged(t *testing.T) {
	n := &notices{}
	reg := onErrorRegistry(t, n)
	em, err := NewInterceptionEmitterFromDeclarationValue(map[string]any{
		"declaration":   DeclarationVersion10,
		"configuration": map[string]any{"composition": map[string]any{"profile": "sequential/run_all"}},
		"bindings": []any{
			map[string]any{"id": "flaky", "kind": "com.example.raise"},
			map[string]any{"id": "second", "kind": "com.example.allow"},
		},
	}, reg)
	if err != nil {
		t.Fatal(err)
	}
	rec := emit(t, em, fixedCtx(PreToolCall, 0))
	if rec.Declaration == nil || *rec.Declaration != DeclarationVersion10 {
		t.Errorf("the record keeps the document's own version: %v", rec.Declaration)
	}
	if rec.Verdict.Decision != Deny || rec.Verdict.Reason != string(ErrInterceptorFailed) {
		t.Errorf("verdict = %+v, want deny interceptor_failed", rec.Verdict)
	}
	if rec.DecidedBy == nil || *rec.DecidedBy != 0 || len(rec.Verdicts) != 2 || rec.Verdicts[0].SubstitutedFor != "" {
		t.Errorf("record = %+v", rec)
	}
	if len(n.got) != 0 {
		t.Errorf("the principal was notified: %+v", n.got)
	}
}

func TestOnErrorDeclarationRefusals(t *testing.T) {
	reg := onErrorRegistry(t, &notices{})
	binding := func(extra map[string]any) []any {
		b := map[string]any{"id": "a", "kind": "com.example.allow"}
		for k, v := range extra {
			b[k] = v
		}
		return []any{b}
	}
	cases := map[string]struct {
		doc     map[string]any
		class   DeclarationErrorClass
		pointer string
	}{
		"higher minor": {map[string]any{"declaration": "agent-hooks-declaration/1.2", "bindings": binding(nil)},
			DeclarationVersionUnsupported, "/declaration"},
		"on_error outside the set": {map[string]any{"declaration": DeclarationVersion, "bindings": binding(map[string]any{"on_error": "ignore"})},
			DeclarationInvalidField, "/bindings/0/on_error"},
		"on_error not a string": {map[string]any{"declaration": DeclarationVersion, "bindings": binding(map[string]any{"on_error": true})},
			DeclarationInvalidField, "/bindings/0/on_error"},
		"failure.on_error outside the set": {map[string]any{"declaration": DeclarationVersion,
			"configuration": map[string]any{"failure": map[string]any{"on_error": "retry"}}, "bindings": binding(nil)},
			DeclarationInvalidField, "/configuration/failure/on_error"},
		"unknown member under failure": {map[string]any{"declaration": DeclarationVersion,
			"configuration": map[string]any{"failure": map[string]any{"on_error": "deny", "retries": 3}}, "bindings": binding(nil)},
			DeclarationUnknownField, "/configuration/failure/retries"},
		"on_error under 1.0": {map[string]any{"declaration": DeclarationVersion10, "bindings": binding(map[string]any{"on_error": "continue"})},
			DeclarationUnknownField, "/bindings/0/on_error"},
		"failure under 1.0": {map[string]any{"declaration": DeclarationVersion10,
			"configuration": map[string]any{"failure": map[string]any{"on_error": "deny"}}, "bindings": binding(nil)},
			DeclarationUnknownField, "/configuration/failure"},
	}
	for name, c := range cases {
		_, err := NewInterceptionEmitterFromDeclarationValue(c.doc, reg)
		de := declErr(t, err)
		if de.Class != c.class {
			t.Errorf("%s: class %s, want %s (%v)", name, de.Class, c.class, err)
			continue
		}
		if de.Findings[0].Pointer != c.pointer {
			t.Errorf("%s: pointer %q, want %q", name, de.Findings[0].Pointer, c.pointer)
		}
		if c.class == DeclarationVersionUnsupported && !equalStrings(de.Accepted, SupportedDeclarationVersions) {
			t.Errorf("%s: accepted = %v", name, de.Accepted)
		}
	}
}

func TestAOneZeroLoaderRefusesAOneOneDocument(t *testing.T) {
	// A host surface that accepts only 1.0 refuses a 1.1 document with
	// version_unsupported and names its own set (section 7.7.2).
	surface := testSurface()
	surface.DeclarationVersions = []string{DeclarationVersion10}
	reg := NewHostRegistry(surface)
	mustRegister(t, reg.Kind("com.example.allow", func(json.RawMessage, BindingContext) (Interceptor, error) {
		return scripted{AllowVerdict}, nil
	}))
	_, err := NewInterceptionEmitterFromDeclarationValue(map[string]any{
		"declaration": DeclarationVersion,
		"bindings":    []any{map[string]any{"id": "a", "kind": "com.example.allow", "on_error": "deny"}},
	}, reg)
	de := declErr(t, err)
	if de.Class != DeclarationVersionUnsupported || !equalStrings(de.Accepted, []string{DeclarationVersion10}) {
		t.Errorf("class %s accepted %v", de.Class, de.Accepted)
	}
	// The same surface still loads a 1.0 document.
	if _, err := NewInterceptionEmitterFromDeclarationValue(map[string]any{
		"declaration": DeclarationVersion10,
		"bindings":    []any{map[string]any{"id": "a", "kind": "com.example.allow"}},
	}, reg); err != nil {
		t.Errorf("1.0 under a 1.0-only surface: %v", err)
	}
}

func TestContinueWithoutARegistryNotifierIsRefusedAtConstruction(t *testing.T) {
	reg := onErrorRegistry(t, nil)
	cases := map[string]struct {
		doc     map[string]any
		pointer string
	}{
		"binding": {map[string]any{"declaration": DeclarationVersion,
			"bindings": []any{map[string]any{"id": "flaky", "kind": "com.example.raise", "on_error": "continue"}}},
			"/bindings/0/on_error"},
		"inherited": {map[string]any{"declaration": DeclarationVersion,
			"configuration": map[string]any{"failure": map[string]any{"on_error": "continue"}},
			"bindings":      []any{map[string]any{"id": "flaky", "kind": "com.example.raise"}}},
			"/configuration/failure/on_error"},
	}
	for name, c := range cases {
		_, err := NewInterceptionEmitterFromDeclarationValue(c.doc, reg)
		de := declErr(t, err)
		if de.Class != DeclarationBindingRejected || de.Findings[0].Pointer != c.pointer {
			t.Errorf("%s: %v", name, err)
		}
		if !strings.Contains(de.Error(), "notifier") || !strings.Contains(de.Error(), `"flaky"`) {
			t.Errorf("%s: the detail must name the binding and the missing channel: %v", name, err)
		}
		// Resolve alone (no emitter) still accepts the document: the
		// refusal is about this host, not the document.
		decl, err := DeclarationFromValue(c.doc)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := reg.Resolve(decl); err != nil {
			t.Errorf("%s: Resolve refused a conformant document: %v", name, err)
		}
	}
	// A deny-only document loads without a notifier.
	if _, err := NewInterceptionEmitterFromDeclarationValue(map[string]any{
		"declaration":   DeclarationVersion,
		"configuration": map[string]any{"failure": map[string]any{"on_error": "deny"}},
		"bindings":      []any{map[string]any{"id": "a", "kind": "com.example.allow", "on_error": "deny"}},
	}, reg); err != nil {
		t.Errorf("deny without a notifier: %v", err)
	}
	if err := reg.ControlFailureNotifier(nil); err == nil {
		t.Error("a nil notifier was accepted")
	}
}

func TestManagedKindRegistryRules(t *testing.T) {
	reg := NewHostRegistry(testSurface())
	managed := func(json.RawMessage, BindingContext) (ManagedInterceptor, error) {
		return managedScript{outcome: ManagedVerdict(AllowVerdict)}, nil
	}
	standard := func(json.RawMessage, BindingContext) (Interceptor, error) { return scripted{AllowVerdict}, nil }
	mustRegister(t, reg.ManagedKind("com.example.managed", managed))
	mustRegister(t, reg.Kind("com.example.standard", standard))
	if err := reg.ManagedKind("com.example.standard", managed); err == nil {
		t.Error("a standard kind name was re-registered as managed")
	}
	if err := reg.Kind("com.example.managed", standard); err == nil {
		t.Error("a managed kind name was re-registered as standard")
	}
	if err := reg.ManagedKind("com.example.managed", managed); err == nil {
		t.Error("a managed kind was registered twice")
	}
	if err := reg.ManagedKind("nodot", managed); err == nil {
		t.Error("the kind grammar was not applied")
	}
	if err := reg.ManagedKind("com.example.nil", nil); err == nil {
		t.Error("a nil managed resolver was accepted")
	}
	if !equalStrings(reg.Names().Kinds, []string{"com.example.managed", "com.example.standard"}) {
		t.Errorf("names = %v", reg.Names().Kinds)
	}
	// A managed kind that returns nothing, errors or panics is
	// binding_rejected like a standard one.
	mustRegister(t, reg.ManagedKind("com.example.nothing", func(json.RawMessage, BindingContext) (ManagedInterceptor, error) {
		return nil, nil
	}))
	mustRegister(t, reg.ManagedKind("com.example.panics", func(json.RawMessage, BindingContext) (ManagedInterceptor, error) {
		panic("resolver bug")
	}))
	for _, kind := range []string{"com.example.nothing", "com.example.panics"} {
		_, err := NewInterceptionEmitterFromDeclarationValue(map[string]any{
			"declaration": DeclarationVersion,
			"bindings":    []any{map[string]any{"id": "x", "kind": kind}},
		}, reg)
		if de := declErr(t, err); de.Class != DeclarationBindingRejected || de.Findings[0].Pointer != "/bindings/0" {
			t.Errorf("%s: %v", kind, err)
		}
	}
	// A managed binding under continue follows the typed outcome.
	n := &notices{}
	mustRegister(t, reg.ControlFailureNotifier(n.notifier()))
	mustRegister(t, reg.ManagedKind("com.example.timesout", func(json.RawMessage, BindingContext) (ManagedInterceptor, error) {
		return managedScript{outcome: ManagedTimeout()}, nil
	}))
	mustRegister(t, reg.ManagedKind("com.example.cancelled", func(json.RawMessage, BindingContext) (ManagedInterceptor, error) {
		return managedScript{outcome: ManagedCancelled()}, nil
	}))
	em, err := NewInterceptionEmitterFromDeclarationValue(map[string]any{
		"declaration": DeclarationVersion,
		"bindings":    []any{map[string]any{"id": "slow", "kind": "com.example.timesout", "on_error": "continue"}},
	}, reg)
	if err != nil {
		t.Fatal(err)
	}
	rec := emit(t, em, fixedCtx(PreToolCall, 0))
	if rec.Verdict.Decision != Allow {
		t.Fatalf("verdict = %+v", rec.Verdict)
	}
	assertSubstituted(t, rec, 0, "slow", ErrInterceptorTimeout)
	assertNotified(t, n, 0, "slow", ErrInterceptorTimeout, PreToolCall)
	em, err = NewInterceptionEmitterFromDeclarationValue(map[string]any{
		"declaration": DeclarationVersion,
		"bindings":    []any{map[string]any{"id": "managed", "kind": "com.example.cancelled", "on_error": "continue"}},
	}, reg)
	if err != nil {
		t.Fatal(err)
	}
	rec = emit(t, em, fixedCtx(PreToolCall, 0))
	if rec.Verdict.Decision != Deny || rec.Verdict.Reason != string(ErrInterceptorFailed) || rec.Verdicts[0].SubstitutedFor != "" {
		t.Errorf("cancelled under continue: %+v", rec)
	}
}

func TestBuilderWritesTheFailurePosture(t *testing.T) {
	reg := onErrorRegistry(t, &notices{})
	built, err := NewDeclarationBuilder().
		FailureOnError(OnErrorContinue).
		Bind("flaky", "com.example.raise", nil, BindOnError(OnErrorDeny)).
		Bind("second", "com.example.allow", nil).
		Build()
	if err != nil {
		t.Fatal(err)
	}
	fromValue, err := DeclarationFromValue(map[string]any{
		"declaration":   DeclarationVersion,
		"configuration": map[string]any{"failure": map[string]any{"on_error": "continue"}},
		"bindings": []any{
			map[string]any{"id": "flaky", "kind": "com.example.raise", "on_error": "deny"},
			map[string]any{"id": "second", "kind": "com.example.allow"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	a, err := reg.Resolve(built)
	if err != nil {
		t.Fatal(err)
	}
	b, err := reg.Resolve(fromValue)
	if err != nil {
		t.Fatal(err)
	}
	ca, _ := a.CanonicalJSON()
	cb, _ := b.CanonicalJSON()
	if ca != cb {
		t.Errorf("builder and value paths differ:\n%s\n%s", ca, cb)
	}
	if a.Configuration.Failure.OnError != OnErrorContinue || a.Bindings[0].OnError != OnErrorDeny || a.Bindings[1].OnError != OnErrorContinue {
		t.Errorf("resolved postures: %+v %+v", a.Configuration.Failure, a.Bindings)
	}
	if NewDeclarationBuilder().Value()["declaration"] != DeclarationVersion {
		t.Error("the builder must write the current version")
	}
}

func TestDefaultSurfaceAcceptsBothVersions(t *testing.T) {
	if !equalStrings(DefaultHostSurface().DeclarationVersions, SupportedDeclarationVersions) {
		t.Errorf("surface versions = %v", DefaultHostSurface().DeclarationVersions)
	}
	if !equalStrings(SupportedDeclarationVersions, []string{DeclarationVersion10, DeclarationVersion}) {
		t.Errorf("supported = %v", SupportedDeclarationVersions)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
