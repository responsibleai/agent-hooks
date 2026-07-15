// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

package agenthooks

// Host-side emitter: dispatch context → interceptors → composition →
// combined verdict → record (§6–§10).
//
// Per-language orchestrator over the Rust core. Interceptor dispatch
// (§7) and approval-seam resolution (§9) stay here because they call
// back into user Go code. Verdict validation (§5), transform
// fold-through (§7.4), multi-verdict aggregation (§7.3/§7.5 via
// ah_compose_aggregate), identity computation (§10), record assembly
// (§10.3), and target write-back (§4.3) delegate to the core so
// behaviour is byte-identical across SDKs.
//
// Composition is host configuration (§7.1): the profile is set on the
// emitter (default sequential/first_deny, on_approval: stop) and
// recorded on every emission. "Parallel" profiles are implemented with
// serial dispatch over isolated snapshots — §7.2: parallel names
// isolation semantics, not scheduling.
//
// Fail-closed defaults: an enforce-mode emission with zero registered
// interceptors yields deny host_error:no_interceptor (§7), and Emit
// returns InterceptionBlocked on any block — the ignorable-record
// variant is the explicitly named EmitUnchecked.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

// DefaultTimeout is the §7 RECOMMENDED interceptor/resolver timeout.
const DefaultTimeout = 5000 * time.Millisecond

// IdentityProvider is the host-declared identity provider (§10.1). A
// nil *IdentityProvider is the null provider: approvals bind by
// correlation only; records carry null identities and self-describe as
// unbound.
type IdentityProvider struct {
	// Name is the declared provider name (§10.1); ignored (reported as
	// JCSSHA256) when Compute is nil.
	Name string
	// Compute is the host-supplied pure function for a custom
	// provider. nil selects the shipped jcs-sha256 default (§10.2),
	// computed by the Rust core. The echo and record rules (§10.1)
	// apply to custom providers too; the golden vectors do not.
	Compute func(AgentContext) (string, error)
}

// DefaultIdentityProvider returns the shipped §10.2 jcs-sha256 provider.
func DefaultIdentityProvider() *IdentityProvider {
	return &IdentityProvider{Name: JCSSHA256}
}

// name returns the declared provider name; nil for the null provider.
func (p *IdentityProvider) name() *string {
	if p == nil {
		return nil
	}
	n := p.Name
	if p.Compute == nil {
		n = JCSSHA256
	}
	return &n
}

// compute returns the provider's identity for actx; (nil, nil) for the
// null provider. The default provider fails closed
// (host_error:context_invalid) on a non-I-JSON projection (§10.2).
func (p *IdentityProvider) compute(actx AgentContext) (*string, error) {
	if p == nil {
		return nil, nil
	}
	if p.Compute != nil {
		s, err := p.Compute(actx)
		if err != nil {
			return nil, err
		}
		return &s, nil
	}
	b, err := json.Marshal(map[string]any(actx))
	if err != nil {
		return nil, err
	}
	s, err := nativeContextIdentity(string(b))
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// isHostSynthesized reports whether a verdict was synthesized by the
// host (§11) rather than returned by an interceptor or resolver.
func isHostSynthesized(v Verdict) bool {
	return strings.HasPrefix(v.Reason, "host_error:")
}

// dispatchOutcome is the internal result of one profile dispatch.
type dispatchOutcome struct {
	combined      Verdict
	decidedBy     *int
	verdicts      []VerdictSummary
	foldTruncated *bool
	resolvedBy    *string
}

// InterceptionEmitter implements §6–§10 once so adapters do not have to.
// One instance per session.
type InterceptionEmitter struct {
	interceptors []Interceptor
	names        []string
	resolver     ApprovalResolver
	mode         EnforcementMode
	composition  CompositionConfig
	identity     *IdentityProvider

	// Timeout bounds each interceptor OnHook and resolver Resolve call
	// (§7, RECOMMENDED default 5000 ms); breach fails closed with
	// host_error:interceptor_timeout / approval_resolver_failed. The
	// callee receives a cancelled context on breach, but if it ignores
	// cancellation its goroutine keeps running detached until it
	// returns. Set to 0 (or negative) to disable enforcement. Set
	// before the first Emit; not synchronized.
	Timeout time.Duration

	// approvalRedactor, when set, produces the context placed in every
	// ApprovalRequest (§9/§14). Set before the first Emit; not
	// synchronized.
	approvalRedactor func(AgentContext) AgentContext
	// recordSink, when set, is invoked synchronously after every
	// emission before buffering (§10.3); a sink panic is swallowed.
	recordSink func(InterceptionRecord)
	// maxRecords bounds the in-memory record buffer (0 = unbounded):
	// when full, the oldest record is dropped and recordsDropped
	// increments.
	maxRecords int

	mu sync.Mutex
	// records holds every InterceptionRecord emitted so far, in
	// sequence order. Guarded by mu: emissions for different tool
	// calls may run concurrently (§12.2).
	records        []InterceptionRecord
	recordsDropped uint64
}

// callRecovered runs fn, converting a panic into an error (§6.3: a
// raising interceptor/resolver fails closed as a host_error deny, it
// does not kill the host — and a panic in the emitter-spawned goroutine
// below would otherwise crash the entire process). Only the panic
// value's type is reported, never its message: panic payloads routinely
// embed the content under evaluation (NOW-05 data-minimization rule).
func callRecovered[T any](
	ctx context.Context, fn func(context.Context) (T, error),
) (out T, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("callee panicked: %T", r)
		}
	}()
	return fn(ctx)
}

// callWithTimeout runs fn under the §7 timeout d (d <= 0 disables). On
// breach the eventual result is discarded and timedOut is true. A
// panicking fn is recovered on both paths and surfaces as an error.
func callWithTimeout[T any](
	ctx context.Context, d time.Duration, fn func(context.Context) (T, error),
) (out T, err error, timedOut bool) {
	if d <= 0 {
		out, err = callRecovered(ctx, fn)
		return out, err, false
	}
	tctx, cancel := context.WithTimeout(ctx, d)
	defer cancel()
	type result struct {
		v   T
		err error
	}
	ch := make(chan result, 1)
	go func() {
		v, e := callRecovered(tctx, fn)
		ch <- result{v, e}
	}()
	select {
	case r := <-ch:
		return r.v, r.err, false
	case <-tctx.Done():
		if ctx.Err() != nil {
			// Parent cancellation, not our timeout.
			return out, ctx.Err(), false
		}
		return out, nil, true
	}
}

// Records returns a snapshot of every InterceptionRecord emitted so far.
func (e *InterceptionEmitter) Records() []InterceptionRecord {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]InterceptionRecord, len(e.records))
	copy(out, e.records)
	return out
}

// NewInterceptionEmitter constructs an emitter in the given mode with an
// optional approval resolver, the default composition profile
// (sequential/first_deny, on_approval: stop) and the default jcs-sha256
// identity provider.
func NewInterceptionEmitter(mode EnforcementMode, resolver ApprovalResolver) *InterceptionEmitter {
	return &InterceptionEmitter{
		mode:        mode,
		resolver:    resolver,
		composition: DefaultComposition(),
		identity:    DefaultIdentityProvider(),
		Timeout:     DefaultTimeout,
	}
}

// Mode returns the enforcement mode.
func (e *InterceptionEmitter) Mode() EnforcementMode { return e.mode }

// SetComposition declares the composition profile for subsequent
// emissions (§7.1). An empty profile resets to the default.
//
// The default (sequential/first_deny, on_approval: stop) is the
// configuration §14 warns about: after an approval lifts a liftable
// deny, interceptors registered after the escalating one never run for
// that emission (fold_truncated on the record). Register must-run
// controls first, or use sequential/run_all / a parallel profile.
// See docs/PRODUCTION.md.
func (e *InterceptionEmitter) SetComposition(c CompositionConfig) *InterceptionEmitter {
	if c.Profile == "" {
		c = DefaultComposition()
	}
	e.composition = c
	return e
}

// SetIdentityProvider declares the identity provider (§10.1); nil is
// the null provider (identity-unbound records and approvals). The
// §10.1 name rules are enforced for custom providers: the name must
// match ^[a-z][a-z0-9_-]*$ and must not begin with "jcs" (reserved so
// a custom function can never claim golden-vector semantics); a
// violating provider is rejected with a non-nil error. A custom
// provider with a nil Compute is also rejected — a named provider
// that cannot compute would silently unbind every emission.
func (e *InterceptionEmitter) SetIdentityProvider(p *IdentityProvider) (*InterceptionEmitter, error) {
	if p != nil && p.Name != JCSSHA256 {
		if p.Compute == nil {
			return nil, fmt.Errorf("identity provider %q has no Compute function (see spec 10.1)", p.Name)
		}
		if !providerNameRe.MatchString(p.Name) || strings.HasPrefix(p.Name, "jcs") {
			return nil, fmt.Errorf("identity provider name must match ^[a-z][a-z0-9_-]*$ and must not begin with 'jcs' (see spec 10.1)")
		}
	}
	e.identity = p
	return e, nil
}

// providerNameRe is the §10.1 host-defined provider-name pattern.
var providerNameRe = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)

// Register appends an interceptor and returns the emitter for chaining.
// SetApprovalRedactor registers the §9/§14 approval redactor: a pure
// function producing the context to place in every ApprovalRequest.
// The §9 identity is computed over the redacted context (binding the
// approval to what the approver saw); the record's identities are
// unaffected. A panicking redactor fails the consultation closed as
// host_error:approval_resolver_failed. Set before the first Emit; not
// synchronized.
func (e *InterceptionEmitter) SetApprovalRedactor(f func(AgentContext) AgentContext) *InterceptionEmitter {
	e.approvalRedactor = f
	return e
}

// SetRecordSink registers a per-emission record callback (§10.3),
// invoked synchronously after every emission before buffering; a sink
// panic is swallowed (audit delivery is the host's liveness concern,
// not the control plane's). Set before the first Emit; not
// synchronized.
func (e *InterceptionEmitter) SetRecordSink(sink func(InterceptionRecord)) *InterceptionEmitter {
	e.recordSink = sink
	return e
}

// SetMaxRecords bounds the in-memory record buffer: when full, the
// OLDEST record is dropped and RecordsDropped increments. Unbounded by
// default. Set before the first Emit; not synchronized.
func (e *InterceptionEmitter) SetMaxRecords(maxRecords int) *InterceptionEmitter {
	e.maxRecords = maxRecords
	return e
}

// RecordsDropped reports records evicted by the SetMaxRecords bound.
func (e *InterceptionEmitter) RecordsDropped() uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.recordsDropped
}

// TakeRecords drains the in-memory record buffer (retention stays
// bounded on long-running sessions).
func (e *InterceptionEmitter) TakeRecords() []InterceptionRecord {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := e.records
	e.records = nil
	return out
}

func (e *InterceptionEmitter) Register(i Interceptor) *InterceptionEmitter {
	return e.RegisterNamed(i, "")
}

// RegisterNamed appends an interceptor with a host-chosen payload-free
// name recorded on verdicts[].name (§10.3). An empty name records
// nothing.
func (e *InterceptionEmitter) RegisterNamed(i Interceptor, name string) *InterceptionEmitter {
	e.interceptors = append(e.interceptors, i)
	e.names = append(e.names, name)
	return e
}

// EmitOutcome is returned by Emit on a proceeding emission: the record
// plus the effective (post-composition) target the guarded action MUST
// consume (§4.3) — a reference captured before Emit may predate a
// transform.
type EmitOutcome struct {
	Record InterceptionRecord
	Target any
}

// Emit runs the emission and returns InterceptionBlocked as the error
// if the guarded action must not proceed (§6). This is the primary
// entry point; the safe path is the default.
func (e *InterceptionEmitter) Emit(ctx context.Context, actx AgentContext) (EmitOutcome, error) {
	rec, err := e.EmitUnchecked(ctx, actx)
	if err != nil {
		return EmitOutcome{Record: rec}, err
	}
	if !rec.Proceeds() {
		return EmitOutcome{Record: rec}, InterceptionBlocked{Result: rec}
	}
	return EmitOutcome{Record: rec, Target: actx["target"]}, nil
}

// EmitUnchecked runs the emission and returns the record without a
// block error. The caller MUST inspect InterceptionRecord.Proceeds and
// halt the guarded action itself; prefer Emit.
//
// On transform in enforce mode, actx is mutated in place (target and the
// aliased L1 field rewritten) so the caller's action consumes the
// transformed value. A non-nil error is an infrastructure failure only
// (JSON marshalling or core invocation), never a verdict outcome.
func (e *InterceptionEmitter) EmitUnchecked(ctx context.Context, actx AgentContext) (InterceptionRecord, error) {
	// §4/§6.3: an invalid envelope is denied before any interceptor
	// or identity provider sees it. §10.3: input identity binds to the
	// context BEFORE dispatch, so neither interceptor mutation nor
	// fold-through can retroactively alter what the record claims was
	// evaluated.
	var (
		inputID *string
		outcome dispatchOutcome
		decided bool
	)
	if envJSON, envErr := json.Marshal(map[string]any(actx)); envErr != nil {
		outcome = dispatchOutcome{combined: HostErrorVerdict(ErrContextInvalid,
			"context is not marshallable JSON (see spec 4.4)")}
		decided = true
	} else if _, envErr := nativeValidateEnvelope(string(envJSON)); envErr != nil {
		outcome = dispatchOutcome{combined: coreErrVerdict(envErr, ErrContextInvalid)}
		decided = true
	}
	if !decided {
		var idErr error
		inputID, idErr = e.identity.compute(actx)
		if idErr != nil {
			// §10.1/§10.2: the provider rejected the value domain or
			// the custom provider failed. Fail closed before any
			// interceptor runs.
			outcome = dispatchOutcome{combined: coreErrVerdict(idErr, ErrContextInvalid)}
			inputID = nil
		} else {
			outcome = e.dispatch(ctx, actx)
		}
	}

	opts := map[string]any{
		"input_identity":    inputID,
		"identity_provider": e.identity.name(),
		"decided_by":        outcome.decidedBy,
		"composition":       e.composition,
		"verdicts":          outcome.verdicts,
		"fold_truncated":    outcome.foldTruncated,
		"resolved_by":       outcome.resolvedBy,
		"interceptors_registered": len(e.interceptors),
	}
	if e.identity != nil && e.identity.Compute != nil {
		// Custom providers only: finalize cannot invoke the host
		// function, so pass the post-composition identity explicitly
		// (§10.3). The default provider's is computed core-side.
		if enforcedID, err := e.identity.Compute(actx); err == nil {
			opts["enforced_identity"] = enforcedID
		}
	}
	optsJSON, err := json.Marshal(opts)
	if err != nil {
		return InterceptionRecord{}, err
	}
	finalCtxJSON, err := json.Marshal(map[string]any(actx))
	if err != nil {
		return InterceptionRecord{}, err
	}
	verdictJSON, err := json.Marshal(outcome.combined)
	if err != nil {
		return InterceptionRecord{}, err
	}
	recJSON, err := nativeFinalize(string(finalCtxJSON), string(verdictJSON), string(e.mode), string(optsJSON))
	if err != nil {
		return InterceptionRecord{}, err
	}
	var rec InterceptionRecord
	if err := json.Unmarshal([]byte(recJSON), &rec); err != nil {
		return InterceptionRecord{}, err
	}
	if e.recordSink != nil {
		// Audit delivery must not take down the control plane (§10.3).
		func() {
			defer func() { _ = recover() }()
			e.recordSink(rec)
		}()
	}
	e.mu.Lock()
	if e.maxRecords > 0 {
		for len(e.records) >= e.maxRecords {
			e.records = e.records[1:]
			e.recordsDropped++
		}
	}
	e.records = append(e.records, rec)
	e.mu.Unlock()
	return rec, nil
}

// -----------------------------------------------------------------------------

// dispatch runs the declared profile (§7.4–§7.5). Every failure becomes
// a host_error deny verdict (§6.3); dispatch never returns an error.
func (e *InterceptionEmitter) dispatch(ctx context.Context, actx AgentContext) dispatchOutcome {
	if len(e.interceptors) == 0 {
		// §7: zero interceptors fails closed, profile-independent.
		// Register an explicit allow-all interceptor for a deliberate
		// passthrough.
		return dispatchOutcome{combined: HostErrorVerdict(ErrNoInterceptor,
			"register an explicit allow-all interceptor for a deliberate passthrough")}
	}
	switch e.composition.Profile {
	case SequentialRunAll:
		return e.dispatchRunAll(ctx, actx)
	case ParallelStrictest, ParallelUnanimous:
		return e.dispatchParallel(ctx, actx)
	default: // SequentialFirstDeny (and the zero value)
		return e.dispatchFirstDeny(ctx, actx)
	}
}

// invoke runs one interceptor on its own deep copy of actx under the §7
// timeout and the §5 wire gate, returning either its (core-normalized)
// verdict or a host-synthesized deny — never an error.
func (e *InterceptionEmitter) invoke(ctx context.Context, ic Interceptor, actx AgentContext) Verdict {
	// §7/N05: each interceptor gets its own deep copy — an in-place
	// mutation of the copy cannot alter enforcement.
	cp, err := DeepCopyContext(actx)
	if err != nil {
		return HostErrorVerdict(ErrContextInvalid, err.Error())
	}
	v, err, timedOut := callWithTimeout(ctx, e.Timeout,
		func(c context.Context) (Verdict, error) { return ic.OnHook(c, cp) })
	if timedOut {
		return HostErrorVerdict(ErrInterceptorTimeout, "") // §7
	}
	if err != nil {
		return HostErrorVerdict(ErrInterceptorFailed, fmt.Sprintf("%T", err)) // §6.3
	}
	vb, err := json.Marshal(v)
	if err != nil {
		return HostErrorVerdict(ErrInterceptorFailed, fmt.Sprintf("%T", err))
	}
	normalized, err := nativeValidateVerdict(string(vb)) // §5
	if err != nil {
		return coreErrVerdict(err, ErrVerdictInvalid)
	}
	var nv Verdict
	if err := json.Unmarshal([]byte(normalized), &nv); err != nil {
		return HostErrorVerdict(ErrVerdictInvalid, err.Error())
	}
	return nv
}

// dispatchFirstDeny implements sequential/first_deny (§7.4):
// fold-through, first deny short-circuits; a liftable deny consults the
// seam, then stop or resume per the knob.
//
// perInterceptor stays index-aligned with registration order (one entry
// per invoked interceptor, §10.3 summaries); pool additionally holds
// substituted resolutions for the §7.3 unions.
func (e *InterceptionEmitter) dispatchFirstDeny(ctx context.Context, actx AgentContext) dispatchOutcome {
	n := len(e.interceptors)
	onApproval := e.composition.OnApproval
	if onApproval == "" {
		onApproval = OnApprovalStop
	}
	var perInterceptor, pool []Verdict
	var lastTransformIdx *int
	var lastTransform Verdict
	var resolvedBy *string
	truncated := func(i int) *bool { b := i+1 < n; return &b }

	for i, ic := range e.interceptors {
		v := e.invoke(ctx, ic, actx)
		perInterceptor = append(perInterceptor, v)
		pool = append(pool, v)
		if isHostSynthesized(v) {
			// §6.3: a malformed verdict fails closed and — in this
			// profile — short-circuits like any deny. The failure deny
			// is attributed to the failing interceptor (§10.3
			// decided_by), matching the aggregation profiles.
			idx := i
			return dispatchOutcome{
				combined:      withUnions(v, pool),
				decidedBy:     &idx,
				verdicts:      e.named(summaries(perInterceptor)),
				foldTruncated: truncated(i),
				resolvedBy:    resolvedBy,
			}
		}

		switch v.Decision {
		case Deny:
			verdict, consulted, permitted := e.consult(ctx, actx, v)
			if !consulted {
				idx := i
				return dispatchOutcome{
					combined:      withUnions(v, pool),
					decidedBy:     &idx,
					verdicts:      e.named(summaries(perInterceptor)),
					foldTruncated: truncated(i),
					resolvedBy:    resolvedBy,
				}
			}
			if !permitted {
				// Reject / unresolved / echo violation: a deny stands
				// (§9); the consultation is still recorded (§10.3
				// resolved_by).
				var decidedBy *int
				if !isHostSynthesized(verdict) {
					idx := i
					decidedBy = &idx
				}
				rej := ResolvedByRejection
				return dispatchOutcome{
					combined:      withUnions(verdict, pool),
					decidedBy:     decidedBy,
					verdicts:      e.named(summaries(perInterceptor)),
					foldTruncated: truncated(i),
					resolvedBy:    &rej,
				}
			}
			rb := ResolvedByApproval
			resolvedBy = &rb
			// §7.6: the permit resolution substitutes at this position;
			// its transform folds like an interceptor's (§7.4).
			sub := verdict
			if sub.Decision == Transform {
				sub = e.foldTransform(actx, sub)
			}
			if !sub.Decision.Permits() {
				return dispatchOutcome{
					combined:      sub,
					verdicts:      e.named(summaries(perInterceptor)),
					foldTruncated: truncated(i),
					resolvedBy:    resolvedBy,
				}
			}
			pool = append(pool, sub)
			if onApproval == OnApprovalStop {
				// §7.4 stop: the resolution is the combined verdict;
				// the emission ends. fold_truncated makes the skip
				// legible.
				idx := i
				return dispatchOutcome{
					combined:      withUnions(sub, pool),
					decidedBy:     &idx,
					verdicts:      e.named(summaries(perInterceptor)),
					foldTruncated: truncated(i),
					resolvedBy:    resolvedBy,
				}
			}
			// resume: fold continues at i+1.
			if sub.Decision == Transform {
				idx := i
				lastTransformIdx, lastTransform = &idx, sub
			}
		case Transform:
			v = e.foldTransform(actx, v)
			if !v.Decision.Permits() {
				// Transform failed closed (host-synthesized §5.2).
				return dispatchOutcome{
					combined:      v,
					verdicts:      e.named(summaries(perInterceptor)),
					foldTruncated: truncated(i),
					resolvedBy:    resolvedBy,
				}
			}
			idx := i
			lastTransformIdx, lastTransform = &idx, v
		}
	}

	// No standing deny: combined is the last transform, else allow.
	combined, decidedBy := AllowVerdict, (*int)(nil)
	if lastTransformIdx != nil {
		combined, decidedBy = lastTransform, lastTransformIdx
	}
	f := false
	return dispatchOutcome{
		combined:      withUnions(combined, pool),
		decidedBy:     decidedBy,
		verdicts:      e.named(summaries(perInterceptor)),
		foldTruncated: &f,
		resolvedBy:    resolvedBy,
	}
}

// dispatchRunAll implements sequential/run_all (§7.4): everything runs,
// transforms fold through for visibility, severity-max aggregate; the
// seam is consulted at most once, only when the winner is liftable
// (which, by severity, implies every deny in the emission is liftable).
func (e *InterceptionEmitter) dispatchRunAll(ctx context.Context, actx AgentContext) dispatchOutcome {
	var all []Verdict
	for _, ic := range e.interceptors {
		// §6.3 per-interceptor: a malformed verdict becomes that
		// interceptor's synthesized deny; the rest still run.
		v := e.invoke(ctx, ic, actx)
		if v.Decision == Transform {
			folded := e.foldTransform(actx, v)
			if !folded.Decision.Permits() {
				// §7.4: a transform that fails to apply short-circuits
				// in both sequential profiles.
				all = append(all, folded)
				return dispatchOutcome{combined: folded, verdicts: e.named(summaries(all))}
			}
			v = folded
		}
		all = append(all, v)
	}
	return e.aggregateAndConsult(ctx, actx, all)
}

// dispatchParallel implements the parallel profiles (§7.5): isolated
// snapshots, no fold; serial dispatch (isolation semantics, not
// scheduling). actx is not mutated during dispatch, so each invoke deep
// copy IS the identical untransformed snapshot.
func (e *InterceptionEmitter) dispatchParallel(ctx context.Context, actx AgentContext) dispatchOutcome {
	all := make([]Verdict, 0, len(e.interceptors))
	for _, ic := range e.interceptors {
		all = append(all, e.invoke(ctx, ic, actx))
	}
	return e.aggregateAndConsult(ctx, actx, all)
}

// aggregateAndConsult delegates the §7.3/§7.5 aggregation (including
// parallel/unanimous disagreement and transform-conflict synthesis) to
// the core, then handles the environment-dependent follow-ups natively:
// applying a single winning parallel transform and consulting the seam.
func (e *InterceptionEmitter) aggregateAndConsult(ctx context.Context, actx AgentContext, all []Verdict) dispatchOutcome {
	cfgJSON, err := json.Marshal(e.composition)
	if err != nil {
		return dispatchOutcome{combined: HostErrorVerdict(ErrContextInvalid, err.Error()), verdicts: e.named(summaries(all))}
	}
	allJSON, err := json.Marshal(all)
	if err != nil {
		return dispatchOutcome{combined: HostErrorVerdict(ErrVerdictInvalid, err.Error()), verdicts: e.named(summaries(all))}
	}
	out, err := nativeComposeAggregate(string(cfgJSON), string(allJSON))
	if err != nil {
		return dispatchOutcome{combined: coreErrVerdict(err, ErrVerdictInvalid), verdicts: e.named(summaries(all))}
	}
	var agg struct {
		Combined       Verdict          `json:"combined"`
		DecidedBy      *int             `json:"decided_by"`
		Consult        bool             `json:"consult"`
		ApplyTransform bool             `json:"apply_transform"`
		Verdicts       []VerdictSummary `json:"verdicts"`
	}
	if err := json.Unmarshal([]byte(out), &agg); err != nil {
		return dispatchOutcome{combined: HostErrorVerdict(ErrVerdictInvalid, err.Error()), verdicts: e.named(summaries(all))}
	}
	combined, decidedBy := agg.Combined, agg.DecidedBy
	var resolvedBy *string

	if agg.ApplyTransform {
		// §7.5 parallel: apply the single winning transform now
		// (nothing folded during dispatch).
		folded := e.foldTransform(actx, combined)
		if !folded.Decision.Permits() {
			return dispatchOutcome{combined: folded, verdicts: e.named(agg.Verdicts)}
		}
		return dispatchOutcome{combined: folded, decidedBy: decidedBy, verdicts: e.named(agg.Verdicts)}
	}

	if agg.Consult {
		verdict, consulted, permitted := e.consult(ctx, actx, combined)
		if consulted {
			if permitted {
				rb := ResolvedByApproval
				resolvedBy = &rb
				// §7.6: the resolution substitutes for the winner (or
				// the synthesized deny); a transform is applied on top
				// of the dispatched state.
				sub := verdict
				if sub.Decision == Transform {
					sub = e.foldTransform(actx, sub)
				}
				if sub.Decision.Permits() {
					pool := append(append([]Verdict(nil), all...), sub)
					combined = withUnions(sub, pool)
				} else {
					combined = sub // fold failed closed
				}
			} else {
				// §10.3: consultation without a permit substitution.
				rej := ResolvedByRejection
				resolvedBy = &rej
				if isHostSynthesized(verdict) {
					decidedBy = nil
				}
				combined = withUnions(verdict, all)
			}
		}
	}
	return dispatchOutcome{combined: combined, decidedBy: decidedBy, verdicts: e.named(agg.Verdicts), resolvedBy: resolvedBy}
}

// foldTransform applies (enforce) or validates (evaluate_only) one
// transform (§7.4, §8). On apply, actx is replaced in place with the
// core's updated context so the next interceptor sees the effect.
func (e *InterceptionEmitter) foldTransform(actx AgentContext, v Verdict) Verdict {
	if v.Transform == nil {
		return HostErrorVerdict(ErrTransformInvalid, "transform body missing")
	}
	valueJSON, err := json.Marshal(v.Transform.Value)
	if err != nil {
		return HostErrorVerdict(ErrTransformInvalid, err.Error())
	}
	ctxJSON, err := json.Marshal(map[string]any(actx))
	if err != nil {
		return HostErrorVerdict(ErrContextInvalid, err.Error())
	}
	if e.mode == Enforce {
		out, err := nativeApplyTransformCtx(string(ctxJSON), v.Transform.Path, string(valueJSON))
		if err != nil {
			return coreErrVerdict(err, ErrTransformInvalid)
		}
		var newCtx map[string]any
		if err := json.Unmarshal([]byte(out), &newCtx); err != nil {
			return HostErrorVerdict(ErrTransformInvalid, err.Error())
		}
		for k := range actx {
			delete(actx, k)
		}
		for k, val := range newCtx {
			actx[k] = val
		}
	} else {
		if _, err := nativeValidateTransformCtx(string(ctxJSON), v.Transform.Path, string(valueJSON)); err != nil {
			return coreErrVerdict(err, ErrTransformInvalid)
		}
	}
	return v
}

// consult consults the approval seam for a liftable deny (§9) when the
// profile conditions allow it: enforce mode, not agent_shutdown, a
// resolver registered, and the verdict actually liftable. Enforces the
// echo rule and the §9 outcome/verdict consistency requirements.
//
// Returns (substituted verdict, consulted, permitted). consulted is
// false when the seam was not touched — the liftable deny then stands
// as-is; conformant, NOT an error (§9). permitted is true only for an
// approve outcome carrying a permit verdict.
func (e *InterceptionEmitter) consult(ctx context.Context, actx AgentContext, verdict Verdict) (Verdict, bool, bool) {
	if !verdict.IsLiftable() || e.mode != Enforce {
		return Verdict{}, false, false
	}
	// §6.1a: nothing to approve at agent_shutdown.
	if actx.InterceptionPoint() == AgentShutdown {
		return Verdict{}, false, false
	}
	// §9: no resolver → the deny stands. Conformant, not an error.
	if e.resolver == nil {
		return Verdict{}, false, false
	}

	// §9/§14: the host's approval redactor minimizes the context
	// egressing through the seam; a panicking redactor fails closed.
	presented := actx
	if e.approvalRedactor != nil {
		redacted, redactErr := func() (out AgentContext, err error) {
			defer func() {
				if r := recover(); r != nil {
					err = fmt.Errorf("approval redactor panicked: %T", r)
				}
			}()
			return e.approvalRedactor(actx), nil
		}()
		if redactErr != nil {
			return HostErrorVerdict(ErrApprovalResolverFailed, redactErr.Error()), true, false
		}
		presented = redacted
	}

	// §9: identity of the context as presented to the resolver —
	// consultation time, after any transforms that folded earlier and
	// after any redaction.
	identity, err := e.identity.compute(presented)
	if err != nil {
		return coreErrVerdict(err, ErrContextInvalid), true, false
	}

	res, err, timedOut := callWithTimeout(ctx, e.Timeout,
		func(c context.Context) (ApprovalResolution, error) {
			return e.resolver.Resolve(c, ApprovalRequest{
				ContextIdentity:   identity,
				InterceptionPoint: actx.InterceptionPoint(),
				Verdict:           verdict,
				Context:           presented,
			})
		})
	if timedOut {
		return HostErrorVerdict(ErrApprovalResolverFailed, "timeout"), true, false // §7
	}
	if err != nil {
		return HostErrorVerdict(ErrApprovalResolverFailed, fmt.Sprintf("%T", err)), true, false
	}
	// §9 echo rule (byte-for-byte; nil echoes as nil).
	if !identityEqual(res.ContextIdentity, identity) {
		return HostErrorVerdict(ErrApprovalIdentityMismatch, ""), true, false
	}
	if res.Verdict == nil || res.Outcome == Unresolved {
		return HostErrorVerdict(ErrApprovalUnresolved, ""), true, false
	}
	// §9: the resolver's verdict crosses the same §5 gate as an
	// interceptor's, and outcome/decision must agree (approve MUST
	// carry a permit, reject MUST carry a deny).
	vb, err := json.Marshal(*res.Verdict)
	if err != nil {
		return HostErrorVerdict(ErrVerdictInvalid, err.Error()), true, false
	}
	normalized, err := nativeValidateVerdict(string(vb))
	if err != nil {
		return coreErrVerdict(err, ErrVerdictInvalid), true, false
	}
	var rv Verdict
	if err := json.Unmarshal([]byte(normalized), &rv); err != nil {
		return HostErrorVerdict(ErrVerdictInvalid, err.Error()), true, false
	}
	switch res.Outcome {
	case Approve:
		if !rv.Decision.Permits() {
			return HostErrorVerdict(ErrVerdictInvalid, "approve MUST carry a permit verdict (§9)"), true, false
		}
		return rv, true, true
	case Reject:
		if rv.Decision != Deny {
			return HostErrorVerdict(ErrVerdictInvalid, "reject MUST carry a deny verdict (§9)"), true, false
		}
		return rv, true, false
	default:
		return HostErrorVerdict(ErrApprovalUnresolved, ""), true, false
	}
}

// identityEqual is the §9 echo-rule comparison: both nil, or both
// non-nil and byte-for-byte equal.
func identityEqual(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// ---- §7.3 metadata unions (pure mirrors of the Rust core's) -----------------

// summaries builds the payload-free per-interceptor summaries for the
// record (§10.3), index-aligned with registration order.
func summaries(verdicts []Verdict) []VerdictSummary {
	out := make([]VerdictSummary, len(verdicts))
	for i, v := range verdicts {
		out[i] = VerdictSummary{Index: i, Decision: v.Decision, Reason: v.Reason}
	}
	return out
}

// named attaches the hosts' registration names positionally (§10.3).
func (e *InterceptionEmitter) named(sums []VerdictSummary) []VerdictSummary {
	for i := range sums {
		if idx := sums[i].Index; idx < len(e.names) && e.names[idx] != "" {
			sums[i].Name = e.names[idx]
		}
	}
	return sums
}

// unionWarnings is the first-seen-ordered union of warnings from every
// verdict (§7.3).
func unionWarnings(verdicts []Verdict) []Warning {
	var out []Warning
	for _, v := range verdicts {
		for _, w := range v.Warnings {
			seen := false
			for _, have := range out {
				if have == w {
					seen = true
					break
				}
			}
			if !seen {
				out = append(out, w)
			}
		}
	}
	return out
}

// unionLabels is the first-seen-ordered union of result_labels from
// every permit verdict (§7.3; §5.4 drops labels when the emission does
// not proceed).
func unionLabels(verdicts []Verdict) []string {
	var out []string
	for _, v := range verdicts {
		if !v.Decision.Permits() {
			continue
		}
		for _, l := range v.ResultLabels {
			seen := false
			for _, have := range out {
				if have == l {
					seen = true
					break
				}
			}
			if !seen {
				out = append(out, l)
			}
		}
	}
	return out
}

// withUnions applies the §7.3 metadata unions to a combined verdict:
// warnings from every verdict in the pool; labels only onto a permit
// combination.
func withUnions(combined Verdict, pool []Verdict) Verdict {
	if warnings := unionWarnings(pool); len(warnings) > 0 {
		combined.Warnings = warnings
	}
	if combined.Decision.Permits() {
		if labels := unionLabels(pool); len(labels) > 0 {
			combined.ResultLabels = labels
		}
	}
	return combined
}

// coreErrVerdict maps a CoreError to a host_error deny verdict, falling
// back to the given code for non-core errors.
func coreErrVerdict(err error, fallback HostError) Verdict {
	var ce *CoreError
	if errors.As(err, &ce) {
		return HostErrorVerdict(HostError(ce.Code), ce.Detail)
	}
	return HostErrorVerdict(fallback, err.Error())
}
