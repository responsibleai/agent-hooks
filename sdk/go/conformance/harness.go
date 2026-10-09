// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Package conformance provides the CTK harness contract, runner, and
// reference harness (§13.2).
//
// The runner (RunVector) and scripted interceptor/resolver evaluation
// delegate to the Rust core via agenthooks.Ctk*; this package keeps
// only the Harness protocol (native callback into the framework under
// test), a recording wrapper, and Scenario helpers. See
// conformance/RUNNER.md for the shape every language SDK follows.
package conformance

import (
	"context"

	"github.com/responsibleai/agent-hooks/sdk/go/agenthooks"
)

// Capability is a host-declared capability (§3.2).
type Capability string

const (
	ModelCalls        Capability = "model_calls"
	ToolCalls         Capability = "tool_calls"
	ParallelToolCalls Capability = "parallel_tool_calls"
	Streaming         Capability = "streaming"
	MultiTurn         Capability = "multi_turn"
	// Int64JSON marks a harness language that can hold >2^53 integers
	// from vector JSON losslessly (§4.4). JavaScript harnesses omit it.
	Int64JSON Capability = "int64_json"
	// BigintJSON: the harness JSON layer preserves integer tokens
	// beyond u64/i64 (Go: json.Number vector decoding).
	BigintJSON Capability = "bigint_json"
	// IncrementalOutput gates the streaming/incremental part (§12.1
	// exception): the host declares buffered_output: false and states
	// its exposure bound. A buffering host never declares it.
	IncrementalOutput Capability = "incremental_output"
	// HostDeclaration gates the declaration/* parts (§7.7.9): the host
	// builds its emitter from the host declaration document a vector
	// carries, through the loader, and surfaces refusal as a load
	// outcome. A harness declaring it implements DeclaredHarness.
	HostDeclaration Capability = "host_declaration"
)

// RunOutcome describes how a harness run ended.
type RunOutcome string

const (
	Completed RunOutcome = "completed"
	Blocked   RunOutcome = "blocked"
	Suspended RunOutcome = "suspended"
	Errored   RunOutcome = "error"
)

// Scenario is a hermetic scripted run loaded from a CTK vector (wire-shaped).
type Scenario struct {
	Input       map[string]any   `json:"input"`
	Tools       []map[string]any `json:"tools"`
	ModelScript []map[string]any `json:"model_script"`
}

// ToolInvocation is one entry in the harness's mock-tool log.
type ToolInvocation struct {
	Name string         `json:"name"`
	Args map[string]any `json:"args"`
}

// IdentityPair is one (input_identity, enforced_identity) pair per
// interception, taken from the emitter's InterceptionRecords so the
// CTK can assert expect.identities_equal. Identities are nil when the
// identity provider is nil (§10.1).
type IdentityPair struct {
	InputIdentity    *string `json:"input_identity"`
	EnforcedIdentity *string `json:"enforced_identity"`
}

// RunRecord is what Harness.Run returns to the CTK runner.
type RunRecord struct {
	Outcome         RunOutcome
	FinalOutput     any
	ToolInvocations []ToolInvocation
	Err             string
	// Identities is one entry per interception, in order, from the
	// harness's emitter.
	Identities []IdentityPair
	// Records is the wire-shaped InterceptionRecords (§10.3), one per
	// emission, in order. Enables expect.records assertions.
	Records []agenthooks.InterceptionRecord
	// Load is set by the runner for a vector carrying host_declaration
	// (§7.7.9); nil otherwise.
	Load *LoadRecord
}

// LoadRecord is what loading a vector's host declaration produced
// (§7.7.9), as the runner records it.
type LoadRecord struct {
	// Outcome is "accepted" or "refused".
	Outcome string `json:"outcome"`
	// Class is the declaration_error:* code on refusal.
	Class string `json:"class,omitempty"`
	// PathsEquivalent: the value, JSON, file and builder paths resolved
	// the document to one canonical form, or refused with one class.
	PathsEquivalent *bool  `json:"paths_equivalent,omitempty"`
	Detail          string `json:"detail,omitempty"`
}

// Harness is the single interface a framework adapter implements for the CTK.
type Harness interface {
	Name() string
	Capabilities() map[Capability]struct{}

	// Setup wires the scenario's mock model + tools into the framework,
	// registers the interceptors and resolver, and sets the enforcement
	// mode, the vector's composition profile (§7.1), and its identity
	// provider (§10.1; nil = identity-unbound — vectors declare
	// "jcs-sha256" or null, custom providers are not vector-expressible).
	// When redactForApproval is non-empty the harness MUST register a §9
	// approval redactor that replaces each listed §5.2 path in the
	// request context's target with the string "[redacted]" (write-back
	// mirrored per §4.3), leaving unresolvable paths untouched.
	Setup(
		scenario Scenario,
		interceptors []agenthooks.Interceptor,
		resolver agenthooks.ApprovalResolver,
		mode agenthooks.EnforcementMode,
		composition agenthooks.CompositionConfig,
		identityProvider *agenthooks.IdentityProvider,
		redactForApproval []string,
	) error

	Run(ctx context.Context) (RunRecord, error)

	Teardown()
}

// ToolSeamHostErrorDeclarer is an optional Harness extension declaring
// the host's §6.2 posture at the tool seam (§13.1): what the host does
// with the run after a host_error:* deny at pre_tool_call /
// post_tool_call. "continue" (the default — surface a tool error to
// the model and keep the loop going) or "terminate" (the host's own
// semantics terminate the turn, which §6.2 explicitly permits). A
// Harness that does not implement it declares the default. The runner
// forwards this declaration so expect.run_outcome_by_posture vectors
// resolve to the single outcome this surface must produce.
type ToolSeamHostErrorDeclarer interface {
	ToolSeamHostError() string
}

// HostSurfaceDeclarer is an optional Harness extension returning the
// host's code surface (§7.7.4), the value a declaration is resolved
// against. A Harness that does not implement it gets the surface
// derived from Capabilities and the posture: the §3.2 floor plus the
// model points iff model_calls plus the tool points iff tool_calls,
// every profile with every knob value. A host declaring
// incremental_output must implement it to add its exposure bound.
type HostSurfaceDeclarer interface {
	HostSurface() agenthooks.HostSurface
}

// DeclarationDeclarer is an optional Harness extension returning the
// host's own declaration document (§7.7.9). The runner resolves it
// against the code surface and reads the capabilities and posture a
// run is assessed against from the resolved form, so what the CTK ran
// against is what a claim cites. A nil document keeps the
// code-declared surface.
type DeclarationDeclarer interface {
	Declaration() map[string]any
}

// DeclaredHarness is the extension a Harness declaring the
// host_declaration capability MUST implement (§7.7.9). SetupDeclared
// wires one declaration vector: the harness MUST build its emitter
// from document and registry through the loader
// (agenthooks.NewInterceptionEmitterFromDeclarationValue) and return
// the refusal, never fall back to the field-based Setup. The document
// and the registry carry the interceptors, resolver, composition and
// identity provider.
type DeclaredHarness interface {
	SetupDeclared(scenario Scenario, document map[string]any, registry *agenthooks.HostRegistry) error
}
