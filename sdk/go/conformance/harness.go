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
