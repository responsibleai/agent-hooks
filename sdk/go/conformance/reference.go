// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

package conformance

// Reference in-memory agent + harness.
//
// Simplest possible conformant agent loop; exists so the CTK
// can self-test without depending on any real framework. Port of
// sdk/python/python/agent_hooks/ctk/reference.py.
//
// Every emitter it builds goes through the host declaration loader
// (§7.7): for a field-based vector it writes the vector's mode,
// composition and provider into a copy of its own document
// (reference.declaration.json) and binds the scripted interceptors
// through a ctk.instance kind, so the field-based vectors exercise the
// loader too.

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"

	"github.com/responsibleai/agent-hooks/sdk/go/agenthooks"
)

// ReferenceDeclaration is the reference harness's own declaration
// (§7.7.9), with an explicit surface a claim can cite.
//
//go:embed reference.declaration.json
var ReferenceDeclaration string

func referenceDocument() map[string]any {
	var doc map[string]any
	if err := json.Unmarshal([]byte(ReferenceDeclaration), &doc); err != nil {
		panic("reference declaration does not parse: " + err.Error())
	}
	return doc
}

// ReferenceHarness is a ~120-line conformant host used as the CTK
// self-test target.
type ReferenceHarness struct {
	scenario Scenario
	emitter  *agenthooks.InterceptionEmitter
	builder  *agenthooks.AgentContextBuilder
	toolLog  []ToolInvocation
	sess     int
}

// NewReferenceHarness returns a fresh harness instance.
func NewReferenceHarness() *ReferenceHarness { return &ReferenceHarness{} }

// Name implements Harness.
func (h *ReferenceHarness) Name() string { return "reference-agent" }

// Capabilities implements Harness.
func (h *ReferenceHarness) Capabilities() map[Capability]struct{} {
	// Int64JSON: Go holds int64, so vectors carrying >2^53 integers
	// load losslessly (§4.4). HostDeclaration: every emitter is built
	// through the loader (§7.7.9).
	return map[Capability]struct{}{
		ModelCalls: {}, ToolCalls: {}, Int64JSON: {}, BigintJSON: {}, HostDeclaration: {},
	}
}

// HostSurface implements HostSurfaceDeclarer: the surface derived from
// the capability list and the default posture.
func (h *ReferenceHarness) HostSurface() agenthooks.HostSurface {
	caps := make([]string, 0, len(h.Capabilities()))
	for c := range h.Capabilities() {
		caps = append(caps, string(c))
	}
	sort.Strings(caps)
	return agenthooks.HostSurfaceFromCapabilities(caps, agenthooks.PostureContinue)
}

// Declaration implements DeclarationDeclarer.
func (h *ReferenceHarness) Declaration() map[string]any { return referenceDocument() }

// startSession installs a freshly built emitter and a context builder
// for one scenario.
func (h *ReferenceHarness) startSession(scenario Scenario, em *agenthooks.InterceptionEmitter) {
	h.scenario = scenario
	h.toolLog = nil
	h.emitter = em
	h.sess++
	h.builder = agenthooks.NewAgentContextBuilder(
		"ref-agent", "reference-agent", fmt.Sprintf("sess-%d", h.sess),
	)
}

// SetupDeclared implements DeclaredHarness: the emitter is built from
// the vector's document and the CTK registry through the loader, and
// a refusal is returned as is.
func (h *ReferenceHarness) SetupDeclared(scenario Scenario, document map[string]any, registry *agenthooks.HostRegistry) error {
	em, err := agenthooks.NewInterceptionEmitterFromDeclarationValue(document, registry)
	if err != nil {
		return err
	}
	h.startSession(scenario, em)
	return nil
}

// Setup implements Harness.
func (h *ReferenceHarness) Setup(
	scenario Scenario,
	interceptors []agenthooks.Interceptor,
	resolver agenthooks.ApprovalResolver,
	mode agenthooks.EnforcementMode,
	composition agenthooks.CompositionConfig,
	identityProvider *agenthooks.IdentityProvider,
	redactForApproval []string,
) error {
	// Field-based vector: write the vector's configuration into a copy
	// of the reference document and bind the interceptors by index
	// through the ctk.instance kind (§7.7.9).
	if err := composition.Validate(); err != nil {
		return err
	}
	doc := referenceDocument()
	cfg, _ := doc["configuration"].(map[string]any)
	cfg["mode"] = string(mode)
	cfg["composition"] = compositionValue(composition)
	registry := agenthooks.NewConformanceHostRegistry(h.HostSurface())
	switch {
	case identityProvider == nil:
		cfg["identity_provider"] = nil
	case identityProvider.Compute == nil:
		cfg["identity_provider"] = agenthooks.JCSSHA256
	default:
		if err := registry.IdentityProvider(identityProvider.Name, identityProvider.Compute); err != nil {
			return err
		}
		cfg["identity_provider"] = identityProvider.Name
	}
	approval := map[string]any{"resolver": nil, "redactor": nil}
	if resolver != nil {
		if err := registry.ApprovalResolver("ctk-scripted", resolver); err != nil {
			return err
		}
		approval["resolver"] = "ctk-scripted"
	}
	if len(redactForApproval) > 0 {
		paths := append([]string(nil), redactForApproval...)
		if err := registry.ApprovalRedactor("ctk-redact", func(actx agenthooks.AgentContext) agenthooks.AgentContext {
			return redactPaths(actx, paths)
		}); err != nil {
			return err
		}
		approval["redactor"] = "ctk-redact"
	}
	cfg["approval"] = approval

	// Interceptor instances handed to the ctk.instance kind by index;
	// each is taken once.
	slots := append([]agenthooks.Interceptor(nil), interceptors...)
	instance := func(config json.RawMessage, ctx agenthooks.BindingContext) (agenthooks.Interceptor, error) {
		var c struct {
			Index *int `json:"index"`
		}
		if err := json.Unmarshal(config, &c); err != nil || c.Index == nil || *c.Index < 0 {
			return nil, errors.New("config.index must be an unsigned integer")
		}
		if *c.Index >= len(slots) || slots[*c.Index] == nil {
			return nil, fmt.Errorf("no interceptor instance %d for binding %s", *c.Index, ctx.ID)
		}
		i := slots[*c.Index]
		slots[*c.Index] = nil
		return i, nil
	}
	if err := registry.Kind("ctk.instance", instance); err != nil {
		return err
	}
	bindings := make([]any, 0, len(interceptors))
	for i := range interceptors {
		bindings = append(bindings, map[string]any{
			"id":     fmt.Sprintf("interceptor-%d", i),
			"kind":   "ctk.instance",
			"config": map[string]any{"index": i},
		})
	}
	doc["bindings"] = bindings
	em, err := agenthooks.NewInterceptionEmitterFromDeclarationValue(doc, registry)
	if err != nil {
		return fmt.Errorf("reference declaration refused: %w", err)
	}
	h.startSession(scenario, em)
	return nil
}

// compositionValue writes a CompositionConfig as the document's
// composition block: the profile and only the knobs that are set.
func compositionValue(c agenthooks.CompositionConfig) map[string]any {
	out := map[string]any{"profile": string(c.Profile)}
	if c.OnApproval != "" {
		out["on_approval"] = string(c.OnApproval)
	}
	if c.OnDisagreement != "" {
		out["on_disagreement"] = string(c.OnDisagreement)
	}
	if c.OnTransformConflict != "" {
		out["on_transform_conflict"] = string(c.OnTransformConflict)
	}
	return out
}

// Teardown implements Harness.
func (h *ReferenceHarness) Teardown() {
	h.emitter = nil
	h.builder = nil
}

// Run implements Harness. Executes one session per the scenario and
// returns a RunRecord including identities from the emitter.
func (h *ReferenceHarness) Run(ctx context.Context) (RunRecord, error) {
	s, em, b := h.scenario, h.emitter, h.builder
	outcome := Completed
	var final any

	toolsRegistered := make([]string, 0, len(s.Tools))
	for _, t := range s.Tools {
		if n, _ := t["name"].(string); n != "" {
			toolsRegistered = append(toolsRegistered, n)
		}
	}
	sort.Strings(toolsRegistered)

	err := func() error {
		if _, err := em.Emit(ctx, b.AgentStartup(toolsRegistered)); err != nil {
			return err
		}
		if _, err := em.Emit(ctx, b.Input(s.Input["content"], asString(s.Input["role"]))); err != nil {
			return err
		}
		messages := []map[string]any{
			{"role": s.Input["role"], "content": s.Input["content"]},
		}
		for _, entry := range s.ModelScript {
			resp, _ := entry["respond"].(map[string]any)
			toolCalls := toMapSlice(resp["tool_calls"])

			pre := b.PreModelCall("mock", cloneMsgs(messages))
			if _, err := em.Emit(ctx, pre); err != nil {
				return err
			}
			// messages may have been transformed.
			messages = toMapSlice(pre["messages"])

			if _, err := em.Emit(ctx, b.PostModelCall(
				"mock", resp["content"], toolCalls, asString(resp["finish_reason"]),
			)); err != nil {
				return err
			}
			if len(toolCalls) > 0 {
				for _, tc := range toolCalls {
					if terr := h.doToolCall(ctx, tc, &messages); terr != nil {
						var blk agenthooks.InterceptionBlocked
						if errors.As(terr, &blk) {
							messages = append(messages, map[string]any{
								"role":    "tool",
								"content": "blocked: " + blk.Result.Verdict.Reason,
							})
							continue
						}
						return terr
					}
				}
				content := ""
				if resp["content"] != nil {
					content = fmt.Sprintf("%v", resp["content"])
				}
				messages = append(messages, map[string]any{"role": "assistant", "content": content})
			} else {
				final = resp["content"]
				break
			}
		}
		if final != nil {
			out := b.Output(final)
			if _, err := em.Emit(ctx, out); err != nil {
				return err
			}
			if o, ok := out["output"].(map[string]any); ok {
				final = o["content"]
			}
		}
		return nil
	}()
	if err != nil {
		var blk agenthooks.InterceptionBlocked
		if errors.As(err, &blk) {
			outcome = Blocked
			final = nil
		} else {
			return RunRecord{}, err
		}
	}

	shutdownReason := "completed"
	if outcome != Completed {
		shutdownReason = "error"
	}
	// Shutdown uses the unchecked variant: a deny at agent_shutdown is
	// recorded but must not abort RunRecord assembly.
	if _, err := em.EmitUnchecked(ctx, b.AgentShutdown(shutdownReason)); err != nil {
		return RunRecord{}, err
	}

	recs := em.Records()
	ids := make([]IdentityPair, len(recs))
	for i, r := range recs {
		ids[i] = IdentityPair{InputIdentity: r.InputIdentity, EnforcedIdentity: r.EnforcedIdentity}
	}
	return RunRecord{
		Outcome:         outcome,
		FinalOutput:     final,
		ToolInvocations: append([]ToolInvocation(nil), h.toolLog...),
		Identities:      ids,
		Records:         recs,
	}, nil
}

func (h *ReferenceHarness) doToolCall(ctx context.Context, tc map[string]any, messages *[]map[string]any) error {
	em, b := h.emitter, h.builder
	name := asString(tc["name"])
	callID := asString(tc["id"])
	args, _ := tc["args"].(map[string]any)
	if args == nil {
		args = map[string]any{}
	}

	pre := b.PreToolCall(callID, name, cloneArgs(args))
	if _, err := em.Emit(ctx, pre); err != nil {
		return err
	}
	// args may have been transformed.
	if tcm, ok := pre["tool_call"].(map[string]any); ok {
		if a, ok := tcm["args"].(map[string]any); ok {
			args = a
		}
	}

	value, isErr, err := h.invokeTool(name, args)
	if err != nil {
		return err
	}
	h.toolLog = append(h.toolLog, ToolInvocation{Name: name, Args: cloneArgs(args)})

	if _, err := em.Emit(ctx, b.PostToolCall(callID, name, cloneArgs(args), value, isErr)); err != nil {
		return err
	}
	*messages = append(*messages, map[string]any{"role": "tool", "content": value})
	return nil
}

// invokeTool implements the mock-tool dispatch: first behavior clause
// whose when_args deep-equals args (or has no when_args) wins.
func (h *ReferenceHarness) invokeTool(name string, args map[string]any) (any, bool, error) {
	for _, t := range h.scenario.Tools {
		if asString(t["name"]) != name {
			continue
		}
		behavior, _ := t["behavior"].([]any)
		for _, b := range behavior {
			bm, _ := b.(map[string]any)
			when, hasWhen := bm["when_args"].(map[string]any)
			if !hasWhen || reflect.DeepEqual(when, args) {
				isErr, _ := bm["is_error"].(bool)
				return bm["return"], isErr, nil
			}
		}
		return nil, false, fmt.Errorf("tool %q invoked with %v: no matching behavior clause", name, args)
	}
	return nil, false, fmt.Errorf("tool %q not registered in scenario", name)
}

// ---- helpers --------------------------------------------------------------

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func toMapSlice(v any) []map[string]any {
	a, _ := v.([]any)
	out := make([]map[string]any, 0, len(a))
	for _, e := range a {
		if m, ok := e.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func cloneMsgs(in []map[string]any) []map[string]any {
	out := make([]map[string]any, len(in))
	for i, m := range in {
		out[i] = cloneArgs(m)
	}
	return out
}

func cloneArgs(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
