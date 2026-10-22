// Copyright (c) Microsoft. All rights reserved.

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
// variant is the explicitly named EmitUnchecked. Every registration
// fails closed (on_error: deny) unless the host says otherwise per
// registration (§6.3.1): under on_error: continue a raise, a timeout
// or an invalid verdict becomes an allow carrying
// host_warning:control_failed in that slot, the record keeps the
// reason as verdicts[].substituted_for, and the control failure
// notifier tells the principal. Nothing else ever continues.
//
// An emitter can also be built from a host declaration document
// (NewInterceptionEmitterFromDeclaration and the path, JSON and value
// forms, spec §7.7). Such an emitter binds interceptors per point,
// stamps the contract version on every record and is sealed against
// later reconfiguration.

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

// bound is one registered interceptor with its binding facts (§7.7.5):
// the payload-free name stamped on verdicts[].name, the points it runs
// at (nil = every point, the pre-declaration behaviour), its bound and
// its failure posture (§6.3.1).
type bound struct {
	// interceptor is the standard registration; managed is set
	// instead for an interceptor that owns its own deadline (§6.3.1
	// item 8). Exactly one is non-nil.
	interceptor Interceptor
	managed     ManagedInterceptor
	name        string
	at          []InterceptionPoint
	// inherit selects the emitter-wide Timeout; otherwise timeout is
	// the per-binding bound from a declaration (0 = unbounded).
	inherit bool
	timeout time.Duration
	// onError is the registration's failure posture; deny by default.
	onError OnError
}

// runsAt reports whether the binding dispatches at point. An
// unparseable point never reaches dispatch (§4 validation denies
// first); every binding counts then, so the record is conservative.
func (b *bound) runsAt(point InterceptionPoint) bool {
	if b.at == nil || !containsPoint(allPoints, point) {
		return true
	}
	return containsPoint(b.at, point)
}

// InterceptionEmitter implements §6–§10 once so adapters do not have to.
// One instance per session.
type InterceptionEmitter struct {
	bound       []*bound
	resolver    ApprovalResolver
	mode        EnforcementMode
	composition CompositionConfig
	identity    *IdentityProvider

	// Timeout bounds each interceptor Intercept and resolver Resolve call
	// (§7, RECOMMENDED default 5000 ms); breach fails closed with
	// host_error:interceptor_timeout / approval_resolver_failed. The
	// callee receives a cancelled context on breach, but if it ignores
	// cancellation its goroutine keeps running detached until it
	// returns. Set to 0 (or negative) to disable enforcement. Set
	// before the first Emit; not synchronized. An emitter built from a
	// host declaration sets it from configuration.timeouts and treats
	// it as read-only (§7.7.7): a per-binding timeout_ms overrides it
	// for that binding.
	Timeout time.Duration
	// resolverTimeout, when non-nil, bounds the resolver instead of
	// Timeout (configuration.timeouts.approval_resolver_ms, §7.7.3);
	// 0 is unbounded.
	resolverTimeout *time.Duration

	// approvalRedactor, when set, produces the context placed in every
	// ApprovalRequest (§9/§14). Set before the first Emit; not
	// synchronized.
	approvalRedactor func(AgentContext) AgentContext
	// recordSink, when set, is invoked synchronously after every
	// emission before buffering (§10.3); a sink panic is swallowed.
	recordSink func(InterceptionRecord)
	// notifier, when set, tells the principal that a control failed
	// and the action continued (§6.3.1). Required before any
	// registration with on_error: continue; a declaration-built
	// emitter takes it from the registry.
	notifier ControlFailureNotifier
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

	// sealed: a declaration-built emitter refuses reconfiguration
	// (§7.7.7); otherwise the declaration would not be what ran.
	sealed bool
	// declaration is the resolved document this emitter was built
	// from, when it was built from one; it feeds the record's
	// `declaration` member (§7.7.8).
	declaration *ResolvedDeclaration
}

// Declaration returns the resolved declaration this emitter runs under,
// or nil when it was configured in code (§7.7.7).
func (e *InterceptionEmitter) Declaration() *ResolvedDeclaration { return e.declaration }

// Sealed reports whether the emitter was built from a host declaration
// and refuses reconfiguration (§7.7.7).
func (e *InterceptionEmitter) Sealed() bool { return e.sealed }

// unsealed panics when a setter whose signature has no error channel
// is called on a sealed emitter.
func (e *InterceptionEmitter) unsealed(what string) {
	if e.sealed {
		panic("agenthooks: " + what + ": " + ErrEmitterSealed.Error())
	}
}

// callRecovered runs fn, converting a panic into an error (§6.3: a
// raising interceptor/resolver fails closed as a host_error deny, it
// does not kill the host — and a panic in the emitter-spawned goroutine
// below would otherwise crash the entire process). Only the panic
// value's type is reported, never its message: panic payloads routinely
// embed the content under evaluation (data-minimization rule, §14).
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
// emissions (§7.1). An empty profile resets to the default. The
// profile and knob values are validated against the closed §7.2 sets
// (CompositionConfig.Validate); an undeclared value is rejected with a
// non-nil error so no emission can start under semantics the operator
// did not declare.
//
// The default (sequential/first_deny, on_approval: stop) is the
// configuration §14 warns about: after an approval lifts a liftable
// deny, interceptors registered after the escalating one never run for
// that emission (fold_truncated on the record). Register must-run
// controls first, or use sequential/run_all / a parallel profile.
// See docs/PRODUCTION.md.
func (e *InterceptionEmitter) SetComposition(c CompositionConfig) (*InterceptionEmitter, error) {
	if e.sealed {
		return nil, fmt.Errorf("SetComposition: %w", ErrEmitterSealed)
	}
	if c.Profile == "" {
		c = DefaultComposition()
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	e.composition = c
	return e, nil
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
	if e.sealed {
		return nil, fmt.Errorf("SetIdentityProvider: %w", ErrEmitterSealed)
	}
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

// SetApprovalRedactor registers the §9/§14 approval redactor: a pure
// function producing the context to place in every ApprovalRequest.
// The §9 identity is computed over the redacted context (binding the
// approval to what the approver saw); the record's identities are
// unaffected. A panicking redactor fails the consultation closed as
// host_error:approval_resolver_failed. Set before the first Emit; not
// synchronized. Panics on a sealed emitter (§7.7.7).
func (e *InterceptionEmitter) SetApprovalRedactor(f func(AgentContext) AgentContext) *InterceptionEmitter {
	e.unsealed("SetApprovalRedactor")
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

// SetControlFailureNotifier registers the host's principal channel for
// §6.3.1: the callback that tells the user (interactive session) or
// the agent (through the host's own message channel) that a control
// failed and the action continued, with the reason. It MUST be set
// before any registration with on_error: continue; RegisterWithOptions
// and RegisterManaged refuse such a registration without it, so
// silent continuation cannot be configured. The emitter calls it
// before the substitution takes effect; if it panics the host_error
// deny stands. Set before the first Emit; not synchronized. Allowed on
// a sealed emitter: it is a host channel, not declared configuration,
// like SetRecordSink. A replacement channel may be swapped in at any
// time. nil clears it, but only while no registration with on_error:
// continue exists; once one does, the channel is load-bearing and
// clearing it panics, so a continue registration can never be left
// without a principal channel by a later call.
func (e *InterceptionEmitter) SetControlFailureNotifier(f ControlFailureNotifier) *InterceptionEmitter {
	if f == nil {
		for _, b := range e.bound {
			if b.onError == OnErrorContinue {
				panic(fmt.Sprintf("SetControlFailureNotifier(nil): registration %q has on_error: continue and needs the control failure notifier (see spec 6.3.1)", b.name))
			}
		}
	}
	e.notifier = f
	return e
}

// SetMaxRecords bounds the in-memory record buffer: when full, the
// OLDEST record is dropped and RecordsDropped increments. Unbounded by
// default. Set before the first Emit; not synchronized. Panics on a
// sealed emitter (§7.7.7).
func (e *InterceptionEmitter) SetMaxRecords(maxRecords int) *InterceptionEmitter {
	e.unsealed("SetMaxRecords")
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

// Register appends an interceptor at every interception point, unnamed,
// and returns the emitter for chaining. Registration order is dispatch
// order (§7). Panics on a sealed emitter (§7.7.7).
func (e *InterceptionEmitter) Register(i Interceptor) *InterceptionEmitter {
	return e.RegisterNamed(i, "")
}

// RegisterNamed appends an interceptor with a host-chosen payload-free
// name recorded on verdicts[].name (§10.3). An empty name records
// nothing. Panics on a sealed emitter (§7.7.7).
func (e *InterceptionEmitter) RegisterNamed(i Interceptor, name string) *InterceptionEmitter {
	e.unsealed("Register")
	e.bound = append(e.bound, &bound{interceptor: i, name: name, inherit: true, onError: OnErrorDeny})
	return e
}

// RegisterAt appends an interceptor with a payload-free name at the
// given points only; a nil slice means every point. An empty non-nil
// slice is refused rather than read as "everywhere" or "nowhere" (the
// Rust core binds an empty set nowhere), so the caller states what it
// meant. At point P the interceptors that run are those bound there,
// in registration order; interceptors_registered, verdicts[].index and
// decided_by count and index that list (§7.7.8). Returns
// ErrEmitterSealed on a sealed emitter and an error for a point name
// outside §3.
func (e *InterceptionEmitter) RegisterAt(i Interceptor, name string, at []InterceptionPoint) error {
	if e.sealed {
		return fmt.Errorf("RegisterAt: %w", ErrEmitterSealed)
	}
	points, err := checkPoints("RegisterAt", at)
	if err != nil {
		return err
	}
	e.bound = append(e.bound, &bound{interceptor: i, name: name, at: points, inherit: true, onError: OnErrorDeny})
	return nil
}

// checkPoints validates and deduplicates a registration's point set:
// nil is every point; an empty non-nil slice and an unknown point are
// refused.
func checkPoints(what string, at []InterceptionPoint) ([]InterceptionPoint, error) {
	if at != nil && len(at) == 0 {
		return nil, errors.New(what + ": at is empty; pass nil for every point or name at least one point")
	}
	var points []InterceptionPoint
	for _, p := range at {
		if !containsPoint(allPoints, p) {
			return nil, fmt.Errorf("%s: unknown interception point %q (see spec 3)", what, p)
		}
		if !containsPoint(points, p) {
			points = append(points, p)
		}
	}
	return points, nil
}

// ErrControlFailureNotifierMissing is returned by RegisterWithOptions
// and RegisterManaged for a registration with on_error: continue on an
// emitter that has no control failure notifier (§6.3.1).
var ErrControlFailureNotifierMissing = errors.New("on_error is continue but the emitter has no control failure notifier; call SetControlFailureNotifier first (see spec 6.3.1)")

// RegistrationOptions are the binding facts of one code registration
// (§7.7.5, §6.3.1). The zero value is an unnamed registration at every
// point with on_error: deny, what Register does.
type RegistrationOptions struct {
	// Name is the payload-free name recorded on verdicts[].name
	// (§10.3) and used as the binding label in a control failure
	// notice; empty records nothing and labels the registration
	// interceptor-<index>.
	Name string
	// At restricts the registration to these points; nil is every
	// point. An empty non-nil slice is refused.
	At []InterceptionPoint
	// OnError is the failure posture; empty is deny.
	OnError OnError
}

// RegisterWithOptions appends an interceptor with the given options.
// Returns ErrEmitterSealed on a sealed emitter, an error for a point
// outside §3 or an on_error value outside the closed set, and
// ErrControlFailureNotifierMissing for on_error: continue when
// SetControlFailureNotifier has not been called; nothing is registered
// on an error.
func (e *InterceptionEmitter) RegisterWithOptions(i Interceptor, opts RegistrationOptions) error {
	if i == nil {
		return errors.New("RegisterWithOptions: nil interceptor")
	}
	return e.push("RegisterWithOptions", &bound{interceptor: i}, opts)
}

// RegisterManaged appends an interceptor that owns its own deadline
// (§6.3.1 item 8). It receives the registration's resolved bound on
// every call and reports a typed outcome; the emitter does not wrap it
// in a second timer. Same refusals as RegisterWithOptions.
func (e *InterceptionEmitter) RegisterManaged(i ManagedInterceptor, opts RegistrationOptions) error {
	if i == nil {
		return errors.New("RegisterManaged: nil interceptor")
	}
	return e.push("RegisterManaged", &bound{managed: i}, opts)
}

func (e *InterceptionEmitter) push(what string, b *bound, opts RegistrationOptions) error {
	if e.sealed {
		return fmt.Errorf("%s: %w", what, ErrEmitterSealed)
	}
	points, err := checkPoints(what, opts.At)
	if err != nil {
		return err
	}
	if err := opts.OnError.Validate(); err != nil {
		return fmt.Errorf("%s: %w", what, err)
	}
	if opts.OnError == OnErrorContinue && e.notifier == nil {
		return fmt.Errorf("%s: %w", what, ErrControlFailureNotifierMissing)
	}
	b.name, b.at, b.inherit, b.onError = opts.Name, points, true, opts.OnError.orDefault()
	e.bound = append(e.bound, b)
	return nil
}

// active returns the interceptors bound at the context's point, in
// dispatch order (§7.7.8).
func (e *InterceptionEmitter) active(point InterceptionPoint) []*bound {
	out := make([]*bound, 0, len(e.bound))
	for _, b := range e.bound {
		if b.runsAt(point) {
			out = append(out, b)
		}
	}
	return out
}

// limit is the §7 bound for one binding: the emitter-wide Timeout
// unless a declaration bound it on its own.
func (e *InterceptionEmitter) limit(b *bound) time.Duration {
	if b.inherit {
		return e.Timeout
	}
	return b.timeout
}

// resolverLimit is the §9 bound for the approval resolver.
func (e *InterceptionEmitter) resolverLimit() time.Duration {
	if e.resolverTimeout != nil {
		return *e.resolverTimeout
	}
	return e.Timeout
}

// declarationVersion is the §7.7.8 record stamp, or nil.
func (e *InterceptionEmitter) declarationVersion() *string {
	if e.declaration == nil {
		return nil
	}
	v := e.declaration.Declaration
	return &v
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
		"input_identity":          inputID,
		"identity_provider":       e.identity.name(),
		"decided_by":              outcome.decidedBy,
		"composition":             e.composition,
		"verdicts":                outcome.verdicts,
		"fold_truncated":          outcome.foldTruncated,
		"resolved_by":             outcome.resolvedBy,
		"interceptors_registered": len(e.active(actx.InterceptionPoint())),
	}
	if d := e.declarationVersion(); d != nil {
		// §7.7.8: present iff the emitter was built from a declaration;
		// never defaulted.
		opts["declaration"] = *d
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
	return e.deliver(rec), nil
}

// HostFailure carries the envelope facts for RecordHostFailure: what
// the host still knows about an emission whose context it could not
// construct (§10.3 "Host projection failure"). Everything is optional —
// an absent member records the §10.3 unknown value (session_id: "",
// sequence: -1, timestamp absent).
type HostFailure struct {
	// Detail is the payload-free failure detail — an error TYPE NAME
	// or a path, never the content that failed to project (§14 data
	// minimization). Recorded as the verdict message (truncated by the
	// §10.3 projection). Empty records nothing.
	Detail string
	// SessionID is session.id of the failed emission, when the host
	// knows it. Empty records the unknown value.
	SessionID string
	// Sequence is the number the failed emission would have carried.
	// The host SHOULD consume the next number from its context source
	// so records stay totally ordered within the session (§10.3). nil
	// records -1.
	Sequence *int64
	// Timestamp is the RFC 3339 event time, when the host has one.
	Timestamp string
}

// RecordHostFailure synthesizes and delivers the §10.3/§11 fail-closed
// record for an emission whose AgentContext the host could not
// construct at all — its own projection to the wire failed before
// anything existed to Emit (e.g. a tool-call argument failed to-wire
// conversion at the chat seam). Without this the host can only fail
// the action closed recordless; with it the trail stays complete under
// host-side faults.
//
// The record is the §10.3 rejection shape: the payload-free projection
// of a deny host_error:context_invalid carrying failure.Detail as its
// message; null identities under the declared provider; decided_by
// null; no per-interceptor summaries (no interceptor ran); envelope
// members from HostFailure, with the §10.3 unknown values (""/-1)
// where absent. It takes the next slot in the record stream (sink,
// then buffer) like any emission. In enforce mode the host MUST still
// fail the action closed; in evaluate_only the record documents the
// host fault without implying enforcement (§8). A non-nil error is an
// infrastructure failure only (JSON marshalling or core invocation).
func (e *InterceptionEmitter) RecordHostFailure(point InterceptionPoint, failure HostFailure) (InterceptionRecord, error) {
	// Deliberately partial basis: only the envelope facts the host
	// still knows. It never passes §4 validation (spec is absent), so
	// the core's finalize always yields the §10.3 rejection shape —
	// null identities under the declared provider — and keeps the
	// synthesized context_invalid deny (with the host's detail)
	// instead of substituting its own.
	basis := map[string]any{"interception_point": string(point)}
	if failure.SessionID != "" {
		basis["session"] = map[string]any{"id": failure.SessionID}
	}
	if failure.Sequence != nil {
		basis["sequence"] = *failure.Sequence
	}
	if failure.Timestamp != "" {
		basis["timestamp"] = failure.Timestamp
	}
	opts := map[string]any{
		"input_identity":          nil,
		"identity_provider":       e.identity.name(),
		"enforced_identity":       nil,
		"decided_by":              nil,
		"composition":             e.composition,
		"verdicts":                []VerdictSummary{},
		"fold_truncated":          nil,
		"resolved_by":             nil,
		"interceptors_registered": len(e.active(point)),
	}
	if d := e.declarationVersion(); d != nil {
		opts["declaration"] = *d
	}
	basisJSON, err := json.Marshal(basis)
	if err != nil {
		return InterceptionRecord{}, err
	}
	verdictJSON, err := json.Marshal(HostErrorVerdict(ErrContextInvalid, failure.Detail))
	if err != nil {
		return InterceptionRecord{}, err
	}
	optsJSON, err := json.Marshal(opts)
	if err != nil {
		return InterceptionRecord{}, err
	}
	recJSON, err := nativeFinalize(string(basisJSON), string(verdictJSON), string(e.mode), string(optsJSON))
	if err != nil {
		return InterceptionRecord{}, err
	}
	var rec InterceptionRecord
	if err := json.Unmarshal([]byte(recJSON), &rec); err != nil {
		return InterceptionRecord{}, err
	}
	return e.deliver(rec), nil
}

// deliver hands a record to the sink and the bounded buffer (§10.3).
func (e *InterceptionEmitter) deliver(rec InterceptionRecord) InterceptionRecord {
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
	return rec
}

// -----------------------------------------------------------------------------

// dispatch runs the declared profile (§7.4–§7.5). Every failure becomes
// a host_error deny verdict (§6.3); dispatch never returns an error.
func (e *InterceptionEmitter) dispatch(ctx context.Context, actx AgentContext) dispatchOutcome {
	active := e.active(actx.InterceptionPoint())
	if len(active) == 0 {
		// §7: zero interceptors fails closed, profile-independent.
		// Register an explicit allow-all interceptor for a deliberate
		// passthrough. With per-point bindings (§7.7.5) this is per
		// point: a surface point with no binding denies.
		return dispatchOutcome{combined: HostErrorVerdict(ErrNoInterceptor,
			"register an explicit allow-all interceptor for a deliberate passthrough")}
	}
	switch e.composition.Profile {
	case SequentialRunAll:
		return e.dispatchRunAll(ctx, actx, active)
	case ParallelStrictest, ParallelUnanimous:
		return e.dispatchParallel(ctx, actx, active)
	case SequentialFirstDeny:
		return e.dispatchFirstDeny(ctx, actx, active)
	default:
		// Unreachable through the public API: the constructor sets
		// DefaultComposition and SetComposition validates against the
		// closed §7.2 set. Fail closed rather than silently dispatch
		// under undeclared semantics.
		return dispatchOutcome{combined: HostErrorVerdict(ErrContextInvalid,
			"undeclared composition profile (see spec 7.2)")}
	}
}

// callFailure is one interceptor failure before the registration's
// on_error is applied (§6.3.1): the host_error reason, the
// payload-free detail and whether on_error: continue may substitute an
// allow for it. continuable is false for a cancellation and for every
// reason outside the three covered failures.
type callFailure struct {
	reason      HostError
	detail      string
	continuable bool
}

// covered builds a failure whose continuability follows from its
// reason (HostError.IsControlFailure).
func covered(reason HostError, detail string) callFailure {
	return callFailure{reason: reason, detail: detail, continuable: reason.IsControlFailure()}
}

// settled is the verdict that takes one registration's composition
// slot and, when the host substituted it under on_error: continue, the
// host_error reason it stands in for (§10.3 substituted_for).
type settled struct {
	verdict        Verdict
	substitutedFor string
}

// invoke runs one interceptor and settles its slot: its (core-
// normalized) verdict, or the §6.3 outcome of its failure under the
// registration's on_error. Never an error.
func (e *InterceptionEmitter) invoke(ctx context.Context, idx int, b *bound, actx AgentContext) settled {
	v, failure := e.call(ctx, b, actx)
	if failure == nil {
		return settled{verdict: v}
	}
	return e.settle(actx, idx, b, *failure)
}

// call runs one interceptor on its own deep copy of actx under the §7
// bound and the §5 wire gate, returning either its core-normalized
// verdict or the failure its slot settles under.
func (e *InterceptionEmitter) call(ctx context.Context, b *bound, actx AgentContext) (Verdict, *callFailure) {
	// §7/N05: each interceptor gets its own deep copy — an in-place
	// mutation of the copy cannot alter enforcement.
	cp, err := DeepCopyContext(actx)
	if err != nil {
		// A context failure, not an interceptor failure: never continues.
		return Verdict{}, &callFailure{reason: ErrContextInvalid, detail: err.Error()}
	}
	var v Verdict
	if b.managed != nil {
		var f *callFailure
		if v, f = e.callManaged(ctx, b, cp); f != nil {
			return Verdict{}, f
		}
	} else {
		ic := b.interceptor
		var timedOut bool
		v, err, timedOut = callWithTimeout(ctx, e.limit(b),
			func(c context.Context) (Verdict, error) { return ic.Intercept(c, cp) })
		if timedOut {
			f := covered(ErrInterceptorTimeout, "") // §7
			return Verdict{}, &f
		}
		if err != nil {
			f := covered(ErrInterceptorFailed, fmt.Sprintf("%T", err)) // §6.3
			if ctx.Err() != nil {
				// The emission's caller cancelled: a cancellation is
				// never a timeout and never continues (§6.3.1).
				f.continuable = false
			}
			return Verdict{}, &f
		}
	}
	return e.gate(v)
}

// callManaged runs a managed interceptor with the registration's
// resolved bound and maps its typed outcome through the core
// (ah_managed_outcome), so timeout, cancelled and failed mean the same
// in every SDK. A verdict outcome crosses the §5 gate like any other.
func (e *InterceptionEmitter) callManaged(ctx context.Context, b *bound, cp AgentContext) (Verdict, *callFailure) {
	m, bound := b.managed, e.limit(b)
	out, err := callRecovered(ctx, func(c context.Context) (ManagedOutcome, error) {
		return m.InterceptManaged(c, cp, bound), nil
	})
	if err != nil {
		f := covered(ErrInterceptorFailed, fmt.Sprintf("%T", err))
		return Verdict{}, &f
	}
	if out.Kind == ManagedOutcomeVerdict && out.Verdict != nil {
		return *out.Verdict, nil
	}
	wire, err := json.Marshal(out)
	if err != nil {
		f := covered(ErrInterceptorFailed, fmt.Sprintf("%T", err))
		return Verdict{}, &f
	}
	res, err := nativeManagedOutcome(string(wire))
	if err != nil {
		// The zero value or an unknown kind: the interceptor's fault.
		f := covered(ErrInterceptorFailed, "malformed managed outcome")
		return Verdict{}, &f
	}
	var mapped struct {
		Verdict Verdict `json:"verdict"`
		Failure *struct {
			Reason      HostError `json:"reason"`
			Detail      *string   `json:"detail"`
			Continuable bool      `json:"continuable"`
		} `json:"failure"`
	}
	if err := json.Unmarshal([]byte(res), &mapped); err != nil || mapped.Failure == nil {
		f := covered(ErrInterceptorFailed, "malformed managed outcome")
		return Verdict{}, &f
	}
	f := callFailure{reason: mapped.Failure.Reason, continuable: mapped.Failure.Continuable}
	if mapped.Failure.Detail != nil {
		f.detail = *mapped.Failure.Detail
	}
	return Verdict{}, &f
}

// gate runs one returned verdict through the core's §5 wire gate and
// returns the normalized verdict, or the verdict_invalid failure.
func (e *InterceptionEmitter) gate(v Verdict) (Verdict, *callFailure) {
	vb, err := json.Marshal(v)
	if err != nil {
		f := covered(ErrInterceptorFailed, fmt.Sprintf("%T", err))
		return Verdict{}, &f
	}
	normalized, err := nativeValidateVerdict(string(vb)) // §5
	if err != nil {
		var ce *CoreError
		if errors.As(err, &ce) {
			f := covered(HostError(ce.Code), ce.Detail)
			return Verdict{}, &f
		}
		f := covered(ErrVerdictInvalid, err.Error())
		return Verdict{}, &f
	}
	var nv Verdict
	if err := json.Unmarshal([]byte(normalized), &nv); err != nil {
		f := covered(ErrVerdictInvalid, err.Error())
		return Verdict{}, &f
	}
	return nv, nil
}

// settle applies the registration's on_error to one failure (§6.3.1).
// Under deny, or for a failure on_error does not cover, the slot holds
// the host_error deny. Under continue the core builds the substituted
// allow (host_warning:control_failed), the substituted_for value and
// the principal notice; the notifier runs first, and if it is missing
// or panics the deny stands with a message saying so, since a
// continuation the principal did not hear about is not conformant.
func (e *InterceptionEmitter) settle(actx AgentContext, idx int, b *bound, f callFailure) settled {
	deny := func(detail string) settled {
		return settled{verdict: HostErrorVerdict(f.reason, detail)}
	}
	if b.onError.orDefault() != OnErrorContinue || !f.continuable {
		return deny(f.detail)
	}
	binding := b.name
	if binding == "" {
		binding = fmt.Sprintf("interceptor-%d", idx)
	}
	req := map[string]any{"binding": binding, "reason": string(f.reason), "index": idx}
	if p := actx.InterceptionPoint(); containsPoint(allPoints, p) {
		req["interception_point"] = string(p)
	}
	reqJSON, err := json.Marshal(req)
	if err != nil {
		return deny(f.detail)
	}
	out, err := nativeControlFailureSubstitute(string(reqJSON))
	if err != nil {
		return deny("on_error: continue refused by the core; the deny stands: " + err.Error())
	}
	var sub struct {
		Verdict        Verdict              `json:"verdict"`
		SubstitutedFor string               `json:"substituted_for"`
		Notice         ControlFailureNotice `json:"notice"`
	}
	if err := json.Unmarshal([]byte(out), &sub); err != nil {
		return deny(f.detail)
	}
	notifier := e.notifier
	if notifier == nil {
		return deny("on_error: continue without a control failure notifier; the deny stands (see spec 6.3.1)")
	}
	if !notify(notifier, sub.Notice) {
		return deny("control failure notifier panicked; the deny stands (see spec 6.3.1)")
	}
	return settled{verdict: sub.Verdict, substitutedFor: sub.SubstitutedFor}
}

// notify runs the notifier, reporting whether it returned normally.
func notify(f ControlFailureNotifier, n ControlFailureNotice) (ok bool) {
	defer func() {
		if r := recover(); r != nil {
			ok = false
		}
	}()
	f(n)
	return true
}

// dispatchFirstDeny implements sequential/first_deny (§7.4):
// fold-through, first deny short-circuits; a liftable deny consults the
// seam, then stop or resume per the knob.
//
// perInterceptor stays index-aligned with registration order (one entry
// per invoked interceptor, §10.3 summaries); pool additionally holds
// substituted resolutions for the §7.3 unions.
func (e *InterceptionEmitter) dispatchFirstDeny(ctx context.Context, actx AgentContext, active []*bound) dispatchOutcome {
	n := len(active)
	onApproval := e.composition.OnApproval
	if onApproval == "" {
		onApproval = OnApprovalStop
	}
	var perInterceptor, pool []Verdict
	var substituted []string
	var lastTransformIdx *int
	var lastTransform Verdict
	var resolvedBy *string
	truncated := func(i int) *bool { b := i+1 < n; return &b }

	for i, b := range active {
		st := e.invoke(ctx, i, b, actx)
		v := st.verdict
		perInterceptor = append(perInterceptor, v)
		substituted = append(substituted, st.substitutedFor)
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
				verdicts:      named(summaries(perInterceptor), active, substituted),
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
					verdicts:      named(summaries(perInterceptor), active, substituted),
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
					verdicts:      named(summaries(perInterceptor), active, substituted),
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
					verdicts:      named(summaries(perInterceptor), active, substituted),
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
					verdicts:      named(summaries(perInterceptor), active, substituted),
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
					verdicts:      named(summaries(perInterceptor), active, substituted),
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
		verdicts:      named(summaries(perInterceptor), active, substituted),
		foldTruncated: &f,
		resolvedBy:    resolvedBy,
	}
}

// dispatchRunAll implements sequential/run_all (§7.4): everything runs,
// transforms fold through for visibility, severity-max aggregate; the
// seam is consulted at most once, only when the winner is liftable
// (which, by severity, implies every deny in the emission is liftable).
func (e *InterceptionEmitter) dispatchRunAll(ctx context.Context, actx AgentContext, active []*bound) dispatchOutcome {
	var all []Verdict
	var substituted []string
	for i, b := range active {
		// §6.3 per-interceptor: a malformed verdict becomes that
		// interceptor's synthesized deny (or, under on_error: continue,
		// the substituted allow); the rest still run.
		st := e.invoke(ctx, i, b, actx)
		v := st.verdict
		substituted = append(substituted, st.substitutedFor)
		if v.Decision == Transform {
			folded := e.foldTransform(actx, v)
			if !folded.Decision.Permits() {
				// §7.4: a transform that fails to apply short-circuits
				// in both sequential profiles.
				all = append(all, folded)
				return dispatchOutcome{combined: folded, verdicts: named(summaries(all), active, substituted)}
			}
			v = folded
		}
		all = append(all, v)
	}
	return e.aggregateAndConsult(ctx, actx, all, active, substituted)
}

// dispatchParallel implements the parallel profiles (§7.5): isolated
// snapshots, no fold; serial dispatch (isolation semantics, not
// scheduling). actx is not mutated during dispatch, so each invoke deep
// copy IS the identical untransformed snapshot.
func (e *InterceptionEmitter) dispatchParallel(ctx context.Context, actx AgentContext, active []*bound) dispatchOutcome {
	all := make([]Verdict, 0, len(active))
	substituted := make([]string, 0, len(active))
	for i, b := range active {
		st := e.invoke(ctx, i, b, actx)
		all = append(all, st.verdict)
		substituted = append(substituted, st.substitutedFor)
	}
	return e.aggregateAndConsult(ctx, actx, all, active, substituted)
}

// aggregateAndConsult delegates the §7.3/§7.5 aggregation (including
// parallel/unanimous disagreement and transform-conflict synthesis) to
// the core, then handles the environment-dependent follow-ups natively:
// applying a single winning parallel transform and consulting the seam.
func (e *InterceptionEmitter) aggregateAndConsult(ctx context.Context, actx AgentContext, all []Verdict, active []*bound, substituted []string) dispatchOutcome {
	cfgJSON, err := json.Marshal(e.composition)
	if err != nil {
		return dispatchOutcome{combined: HostErrorVerdict(ErrContextInvalid, err.Error()), verdicts: named(summaries(all), active, substituted)}
	}
	allJSON, err := json.Marshal(all)
	if err != nil {
		return dispatchOutcome{combined: HostErrorVerdict(ErrVerdictInvalid, err.Error()), verdicts: named(summaries(all), active, substituted)}
	}
	out, err := nativeComposeAggregate(string(cfgJSON), string(allJSON))
	if err != nil {
		return dispatchOutcome{combined: coreErrVerdict(err, ErrVerdictInvalid), verdicts: named(summaries(all), active, substituted)}
	}
	var agg struct {
		Combined       Verdict          `json:"combined"`
		DecidedBy      *int             `json:"decided_by"`
		Consult        bool             `json:"consult"`
		ApplyTransform bool             `json:"apply_transform"`
		Verdicts       []VerdictSummary `json:"verdicts"`
	}
	if err := json.Unmarshal([]byte(out), &agg); err != nil {
		return dispatchOutcome{combined: HostErrorVerdict(ErrVerdictInvalid, err.Error()), verdicts: named(summaries(all), active, substituted)}
	}
	combined, decidedBy := agg.Combined, agg.DecidedBy
	var resolvedBy *string

	if agg.ApplyTransform {
		// §7.5 parallel: apply the single winning transform now
		// (nothing folded during dispatch).
		folded := e.foldTransform(actx, combined)
		if !folded.Decision.Permits() {
			return dispatchOutcome{combined: folded, verdicts: named(agg.Verdicts, active, substituted)}
		}
		return dispatchOutcome{combined: folded, decidedBy: decidedBy, verdicts: named(agg.Verdicts, active, substituted)}
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
	return dispatchOutcome{combined: combined, decidedBy: decidedBy, verdicts: named(agg.Verdicts, active, substituted), resolvedBy: resolvedBy}
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

	res, err, timedOut := callWithTimeout(ctx, e.resolverLimit(),
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

// named attaches the bound names positionally (§10.3): the
// registration name, or the binding id under a declaration (§7.7.8),
// and the substituted_for reason of a slot the host substituted under
// on_error: continue (§6.3.1).
func named(sums []VerdictSummary, active []*bound, substituted []string) []VerdictSummary {
	for i := range sums {
		idx := sums[i].Index
		if idx < len(active) && active[idx].name != "" {
			sums[i].Name = active[idx].name
		}
		if idx < len(substituted) && substituted[idx] != "" {
			sums[i].SubstitutedFor = substituted[idx]
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
