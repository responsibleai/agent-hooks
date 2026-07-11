// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Package agenthooks implements AGENT-HOOKS-0.1: a framework-neutral agent
// lifecycle hook contract (interception points, context, verdict, host obligations).
package agenthooks

import (
	"context"
	"encoding/json"
	"strings"
)

// SpecVersion is the spec version this module implements (§4.1 `spec` field).
const SpecVersion = "agent-hooks/0.1"

// JCSSHA256 is the name of the default identity provider (§10.1, §10.2).
const JCSSHA256 = "jcs-sha256"

// ResolvedByApproval is the §10.3 `resolved_by` marker recorded when an
// approval resolution substituted for a verdict (§7.6).
const ResolvedByApproval = "approval"

// InterceptionPoint is one of the eight agent lifecycle interception points (§3).
type InterceptionPoint string

const (
	AgentStartup  InterceptionPoint = "agent_startup"
	Input         InterceptionPoint = "input"
	PreModelCall  InterceptionPoint = "pre_model_call"
	PostModelCall InterceptionPoint = "post_model_call"
	PreToolCall   InterceptionPoint = "pre_tool_call"
	PostToolCall  InterceptionPoint = "post_tool_call"
	Output        InterceptionPoint = "output"
	AgentShutdown InterceptionPoint = "agent_shutdown"
)

// TransformPermitted reports whether a transform verdict is permitted at hp
// (§3, §4.3).
func (hp InterceptionPoint) TransformPermitted() bool {
	return hp != AgentStartup && hp != AgentShutdown
}

// Decision is a verdict decision value (§5.1). Three, closed: what
// earlier drafts called `warn` is allow + warnings[]; `escalate` is
// deny + an approval block.
type Decision string

const (
	Allow     Decision = "allow"
	Deny      Decision = "deny"
	Transform Decision = "transform"
)

// Permits reports whether the action proceeds under d (§2 permit class).
func (d Decision) Permits() bool {
	return d == Allow || d == Transform
}

// EnforcementMode controls whether the host acts on verdicts (§8).
type EnforcementMode string

const (
	Enforce      EnforcementMode = "enforce"
	EvaluateOnly EnforcementMode = "evaluate_only"
)

// HostError is a reserved host_error:* reason a host synthesizes (§11).
type HostError string

const (
	ErrContextInvalid           HostError = "host_error:context_invalid"
	ErrInterceptorFailed        HostError = "host_error:interceptor_failed"
	ErrInterceptorTimeout       HostError = "host_error:interceptor_timeout"
	ErrVerdictInvalid           HostError = "host_error:verdict_invalid"
	ErrTransformInvalid         HostError = "host_error:transform_invalid"
	ErrTransformTargetForbidden HostError = "host_error:transform_target_forbidden"
	// ErrTransformConflict: §7.5 — two or more transforms against the
	// same snapshot in a parallel profile.
	ErrTransformConflict HostError = "host_error:transform_conflict"
	// ErrCompositionDisagreement: §7.5 — non-unanimous outcome under
	// parallel/unanimous.
	ErrCompositionDisagreement HostError = "host_error:composition_disagreement"
	ErrApprovalResolverFailed  HostError = "host_error:approval_resolver_failed"
	ErrApprovalUnresolved      HostError = "host_error:approval_unresolved"
	// ErrApprovalIdentityMismatch: §9 echo rule — the resolution's
	// context_identity did not match the request's byte for byte.
	ErrApprovalIdentityMismatch HostError = "host_error:approval_identity_mismatch"
	ErrAdapterUnsupported       HostError = "host_error:adapter_unsupported"
	ErrStreamingUnsupported     HostError = "host_error:streaming_unsupported"
	// ErrNoInterceptor: §7 — an enforce-mode emission with zero registered
	// interceptors fails closed rather than silently allowing everything.
	ErrNoInterceptor HostError = "host_error:no_interceptor"
)

// TransformBody is a single $target-rooted replacement (§5.2).
type TransformBody struct {
	// Path is rooted at $target (or the deprecated $policy_target alias).
	Path  string `json:"path"`
	Value any    `json:"value"`
}

// MarshalJSON emits value only when non-nil, mirroring the core: the
// §10.3 record projection drops transform.value, and at §5.2 apply
// time an absent value is equivalent to JSON null. A plain omitempty
// tag would also drop legitimate zero values (0, "", false), which
// MUST survive the wire — hence the custom marshaller.
func (t TransformBody) MarshalJSON() ([]byte, error) {
	if t.Value == nil {
		return json.Marshal(struct {
			Path string `json:"path"`
		}{t.Path})
	}
	type wire TransformBody // no methods: avoids recursion
	return json.Marshal(wire(t))
}

// Evidence is an opaque pointer to an offline-verifiable artefact (§5.3).
type Evidence struct {
	Artefact             string            `json:"artefact,omitempty"`
	VerificationPointers map[string]string `json:"verification_pointers,omitempty"`
}

// Warning is a recorded concern that does not affect control flow (§5.1).
type Warning struct {
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

// Verdict is the interceptor return value (§5).
type Verdict struct {
	Decision Decision `json:"decision"`
	Reason   string   `json:"reason,omitempty"`
	Message  string   `json:"message,omitempty"`
	// Warnings are recorded concerns; permitted on any decision (§5.1).
	Warnings []Warning `json:"warnings,omitempty"`
	// Approval is present only on deny: it marks the deny as liftable
	// by the approval seam (§9). MAY be empty; reserved for
	// approver-facing parameters. nil means absent.
	Approval     map[string]any `json:"approval,omitempty"`
	Transform    *TransformBody `json:"transform,omitempty"`
	Evidence     *Evidence      `json:"evidence,omitempty"`
	ResultLabels []string       `json:"result_labels,omitempty"`
}

// MarshalJSON preserves an empty-but-present approval block: `omitempty`
// cannot distinguish nil (absent) from an empty map, but a liftable deny
// is exactly a deny with an approval object that MAY be empty (§5.1).
func (v Verdict) MarshalJSON() ([]byte, error) {
	type wire Verdict // no methods: avoids MarshalJSON recursion
	if v.Approval != nil && len(v.Approval) == 0 {
		// The shallower `approval` field (no omitempty) wins over the
		// embedded one per encoding/json conflict rules.
		return json.Marshal(struct {
			wire
			Approval map[string]any `json:"approval"`
		}{wire(v), v.Approval})
	}
	return json.Marshal(wire(v))
}

// AllowVerdict is the trivial permit verdict.
var AllowVerdict = Verdict{Decision: Allow}

// Warn is constructor sugar for what earlier drafts called `warn`: an
// allow carrying one warning (§5.1).
func Warn(reason, message string) Verdict {
	return Verdict{Decision: Allow, Warnings: []Warning{{Reason: reason, Message: message}}}
}

// Escalate is constructor sugar for what earlier drafts called
// `escalate`: a liftable deny — denied as-is unless the approval seam
// lifts it (§5.1, §9).
func Escalate(reason, message string) Verdict {
	return Verdict{Decision: Deny, Reason: reason, Message: message, Approval: map[string]any{}}
}

// HostErrorVerdict returns a host-synthesized deny verdict for a §11 failure.
func HostErrorVerdict(e HostError, msg string) Verdict {
	return Verdict{Decision: Deny, Reason: string(e), Message: msg}
}

// HostErrorLiftableVerdict returns a host-synthesized liftable deny
// (§7.5 "approval" knob value): the failure is consultable rather than
// final.
func HostErrorLiftableVerdict(e HostError, msg string) Verdict {
	v := HostErrorVerdict(e, msg)
	v.Approval = map[string]any{}
	return v
}

// IsLiftable reports whether v is a deny carrying an approval block (§5.1).
func (v Verdict) IsLiftable() bool {
	return v.Decision == Deny && v.Approval != nil
}

// Validate checks v per §5; returns a HostError on violation. The wire
// gate every interceptor return crosses is the Rust core's
// (ValidateVerdict); this is the pure-Go mirror for hosts that want a
// pre-flight check without a core round-trip.
func (v Verdict) Validate() error {
	switch v.Decision {
	case Allow, Deny, Transform:
	default:
		return errVerdictInvalid("decision MUST be allow|deny|transform (§5.1)")
	}
	if strings.HasPrefix(v.Reason, "host_error:") {
		return errVerdictInvalid("verdict.reason MUST NOT start with 'host_error:'")
	}
	if v.Approval != nil && v.Decision != Deny {
		return errVerdictInvalid("approval block permitted only on deny (§5.1)")
	}
	if v.Decision == Transform && v.Transform == nil {
		return errVerdictInvalid("transform body REQUIRED when decision=='transform'")
	}
	if v.Decision != Transform && v.Transform != nil {
		return errVerdictInvalid("transform body FORBIDDEN when decision!='transform'")
	}
	return nil
}

type verdictError struct{ msg string }

func (e verdictError) Error() string   { return string(ErrVerdictInvalid) + ": " + e.msg }
func errVerdictInvalid(m string) error { return verdictError{m} }

// AgentContext is the wire-shaped agent context (§4): a JSON object so it
// round-trips to the schema without translation.
type AgentContext map[string]any

// InterceptionPoint extracts interception_point from ctx.
func (ctx AgentContext) InterceptionPoint() InterceptionPoint {
	hp, _ := ctx["interception_point"].(string)
	return InterceptionPoint(hp)
}

// ---- composition (§7) -------------------------------------------------------

// CompositionProfile is one of the closed set of composition profiles (§7.2).
type CompositionProfile string

const (
	SequentialFirstDeny CompositionProfile = "sequential/first_deny"
	SequentialRunAll    CompositionProfile = "sequential/run_all"
	ParallelStrictest   CompositionProfile = "parallel/strictest"
	ParallelUnanimous   CompositionProfile = "parallel/unanimous"
)

// OnApproval is the sequential/first_deny knob (§7.4): what a permit
// resolution does to the rest of the fold.
type OnApproval string

const (
	// OnApprovalStop: the resolution becomes the combined verdict; the
	// emission ends (fold_truncated: true).
	OnApprovalStop OnApproval = "stop"
	// OnApprovalResume: the resolution substitutes for the denying
	// interceptor's verdict and the fold continues.
	OnApprovalResume OnApproval = "resume"
)

// SynthesisPolicy is the "deny" | "approval" knob value (§7.5):
// synthesize a plain deny, or a liftable one and consult the seam.
type SynthesisPolicy string

const (
	SynthesizeDeny     SynthesisPolicy = "deny"
	SynthesizeApproval SynthesisPolicy = "approval"
)

// CompositionConfig is the composition profile and knobs in effect for
// one emission (§7.1, §10.3). Serialized verbatim into the record's
// `composition` block.
type CompositionConfig struct {
	Profile CompositionProfile `json:"profile"`
	// OnApproval applies to sequential/first_deny only.
	OnApproval OnApproval `json:"on_approval,omitempty"`
	// OnDisagreement applies to parallel/unanimous only.
	OnDisagreement SynthesisPolicy `json:"on_disagreement,omitempty"`
	// OnTransformConflict applies to parallel profiles only.
	OnTransformConflict SynthesisPolicy `json:"on_transform_conflict,omitempty"`
}

// DefaultComposition is the pre-P-003 behaviour: sequential/first_deny
// with on_approval: stop. A default, not a conformance baseline — no
// profile is mandatory (§7.2, §13.1).
func DefaultComposition() CompositionConfig {
	return CompositionConfig{Profile: SequentialFirstDeny, OnApproval: OnApprovalStop}
}

// FirstDenyComposition builds a sequential/first_deny config (§7.4).
func FirstDenyComposition(onApproval OnApproval) CompositionConfig {
	return CompositionConfig{Profile: SequentialFirstDeny, OnApproval: onApproval}
}

// RunAllComposition builds a sequential/run_all config (§7.4).
func RunAllComposition() CompositionConfig {
	return CompositionConfig{Profile: SequentialRunAll}
}

// StrictestComposition builds a parallel/strictest config (§7.5).
func StrictestComposition(onTransformConflict SynthesisPolicy) CompositionConfig {
	return CompositionConfig{Profile: ParallelStrictest, OnTransformConflict: onTransformConflict}
}

// UnanimousComposition builds a parallel/unanimous config (§7.5).
func UnanimousComposition(onDisagreement, onTransformConflict SynthesisPolicy) CompositionConfig {
	return CompositionConfig{
		Profile:             ParallelUnanimous,
		OnDisagreement:      onDisagreement,
		OnTransformConflict: onTransformConflict,
	}
}

// VerdictSummary is the payload-free per-interceptor summary on the
// record (§10.3).
type VerdictSummary struct {
	Index    int      `json:"index"`
	Decision Decision `json:"decision"`
	Reason   string   `json:"reason,omitempty"`
}

// ---- interception record (§10.3) --------------------------------------------

// InterceptionRecord is the host-side record of one emission (§6, §10.3).
//
// Payload-free by design: the identities (when a provider is declared)
// bind the record to the exact pre/post-composition context without
// duplicating the (possibly sensitive) payload into audit storage.
// Composition makes the record interpretable without out-of-band
// knowledge of host configuration.
type InterceptionRecord struct {
	InterceptionPoint InterceptionPoint `json:"interception_point"`
	Mode              EnforcementMode   `json:"mode"`
	// Verdict is the combined verdict (§7.3), possibly host-synthesized
	// or approval-substituted.
	Verdict Verdict `json:"verdict"`
	// InputIdentity is the provider output before dispatch; nil iff
	// IdentityProvider is nil (or the provider rejected the context).
	InputIdentity *string `json:"input_identity"`
	// EnforcedIdentity is the provider output after composition completes.
	EnforcedIdentity *string `json:"enforced_identity"`
	// IdentityProvider is the declared identity provider name (§10.1).
	IdentityProvider *string `json:"identity_provider"`
	// SessionID is ctx.session.id — correlates records across a session.
	SessionID string `json:"session_id"`
	// Sequence is ctx.sequence — total order within the session (§12.2.3).
	Sequence int64 `json:"sequence"`
	// DecidedBy is the registration index of the interceptor whose
	// verdict won the aggregation or whose liftable deny was consulted
	// (§7.6); nil for a pure-allow combination or a host-synthesized
	// verdict.
	DecidedBy *int `json:"decided_by"`
	// Composition is the profile and knobs in effect (§7.1).
	Composition CompositionConfig `json:"composition"`
	// Verdicts is the per-interceptor summary; populated in
	// multi-verdict profiles (sequential/run_all, parallel/*).
	Verdicts []VerdictSummary `json:"verdicts,omitempty"`
	// FoldTruncated is true iff one or more registered interceptors
	// were never invoked in this emission. Defined only for
	// sequential/first_deny (§7.4).
	FoldTruncated *bool `json:"fold_truncated,omitempty"`
	// ResolvedBy is "approval" iff an approval resolution substituted
	// for a verdict in this emission (§7.6).
	ResolvedBy *string `json:"resolved_by,omitempty"`
}

// Proceeds reports whether the guarded action executes (§6, §8).
func (r InterceptionRecord) Proceeds() bool {
	return r.Mode == EvaluateOnly || r.Verdict.Decision.Permits()
}

// Interceptor is the interceptor protocol (§7).
type Interceptor interface {
	OnHook(ctx context.Context, hctx AgentContext) (Verdict, error)
}

// ApprovalOutcome is the resolver's outcome (§9).
type ApprovalOutcome string

const (
	Approve    ApprovalOutcome = "approve"
	Reject     ApprovalOutcome = "reject"
	Unresolved ApprovalOutcome = "unresolved"
)

// ApprovalRequest is what the host hands the resolver when a profile
// consults the seam (§9). ContextIdentity is nil when the identity
// provider is nil (§10.1) — the approval is then identity-unbound.
type ApprovalRequest struct {
	ContextIdentity   *string
	InterceptionPoint InterceptionPoint
	Verdict           Verdict
	Context           AgentContext
}

// ApprovalResolution is what the resolver returns (§9). ContextIdentity
// MUST echo the request's byte for byte (nil echoes as nil).
type ApprovalResolution struct {
	Outcome         ApprovalOutcome
	ContextIdentity *string
	Verdict         *Verdict
}

// ApprovalResolver is the host-registered resolver for liftable denies (§9).
type ApprovalResolver interface {
	Resolve(ctx context.Context, req ApprovalRequest) (ApprovalResolution, error)
}

// InterceptionBlocked is returned by a host when a verdict blocks the guarded action (§6).
type InterceptionBlocked struct {
	Result InterceptionRecord
}

func (e InterceptionBlocked) Error() string {
	b, _ := json.Marshal(e.Result.Verdict)
	return string(e.Result.InterceptionPoint) + " blocked: " + string(b)
}
