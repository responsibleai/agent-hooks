// Copyright (c) Microsoft. All rights reserved.

package agenthooks

// AgentContext construction (§4).
//
// AgentContextBuilder owns the L0 envelope (agent/session/sequence) and
// exposes one method per interception point that fills L1 and sets
// target. One instance per session. Port of
// sdk/python/python/agent_hooks/context.py.

import (
	"sync/atomic"
	"time"
)

// AgentContextBuilder is the stateful per-session builder for
// AgentContext values.
type AgentContextBuilder struct {
	agent   map[string]any
	session map[string]any
	seq     int64 // assigned via atomic.AddInt64 (§12.2.3)
	l2      map[string]any
}

// NewAgentContextBuilder constructs a builder with the required L0
// agent/session identifiers.
func NewAgentContextBuilder(agentID, framework, sessionID string) *AgentContextBuilder {
	return &AgentContextBuilder{
		agent:   map[string]any{"id": agentID, "framework": framework},
		session: map[string]any{"id": sessionID},
		l2:      map[string]any{},
	}
}

// WithAgent sets optional L2 agent.name/version.
func (b *AgentContextBuilder) WithAgent(name, version string) *AgentContextBuilder {
	if name != "" {
		b.agent["name"] = name
	}
	if version != "" {
		b.agent["version"] = version
	}
	return b
}

// WithL2 attaches L2 fields (trace, tenant, budgets, actor, ...) to
// every subsequent context.
func (b *AgentContextBuilder) WithL2(fields map[string]any) *AgentContextBuilder {
	for k, v := range fields {
		if v != nil {
			b.l2[k] = v
		}
	}
	return b
}

func nowRFC3339() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000000Z")
}

func cloneMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func (b *AgentContextBuilder) envelope(ip InterceptionPoint, target any) AgentContext {
	ctx := AgentContext{
		"spec":               SpecVersion,
		"interception_point": string(ip),
		"timestamp":          nowRFC3339(),
		"sequence":           atomic.AddInt64(&b.seq, 1) - 1,
		"agent":              cloneMap(b.agent),
		"session":            cloneMap(b.session),
		"target":             target,
	}
	for k, v := range b.l2 {
		ctx[k] = v
	}
	return ctx
}

// AgentStartup builds the agent_startup context (§4.2).
func (b *AgentContextBuilder) AgentStartup(toolsRegistered []string) AgentContext {
	agentInit := map[string]any{"tools_registered": anySlice(toolsRegistered)}
	ctx := b.envelope(AgentStartup, agentInit)
	ctx["agent_init"] = agentInit
	return ctx
}

// Input builds the input context (§4.2).
func (b *AgentContextBuilder) Input(content any, role string) AgentContext {
	inp := map[string]any{"content": content, "role": role}
	ctx := b.envelope(Input, inp)
	ctx["input"] = inp
	return ctx
}

// PreModelCall builds the pre_model_call context (§4.2).
func (b *AgentContextBuilder) PreModelCall(modelID string, messages []map[string]any) AgentContext {
	ctx := b.envelope(PreModelCall, anySlice(messages))
	ctx["model"] = map[string]any{"id": modelID}
	ctx["messages"] = anySlice(messages)
	return ctx
}

// PostModelCall builds the post_model_call context (§4.2).
func (b *AgentContextBuilder) PostModelCall(
	modelID string,
	content any,
	toolCalls []map[string]any,
	finishReason string,
) AgentContext {
	response := map[string]any{
		"content":       content,
		"tool_calls":    anySlice(toolCalls),
		"finish_reason": finishReason,
	}
	ctx := b.envelope(PostModelCall, response)
	ctx["model"] = map[string]any{"id": modelID}
	ctx["response"] = response
	return ctx
}

// PreToolCall builds the pre_tool_call context (§4.2).
func (b *AgentContextBuilder) PreToolCall(callID, name string, args map[string]any) AgentContext {
	tc := map[string]any{"id": callID, "name": name, "args": args}
	ctx := b.envelope(PreToolCall, args)
	ctx["tool_call"] = tc
	return ctx
}

// PostToolCall builds the post_tool_call context (§4.2).
func (b *AgentContextBuilder) PostToolCall(
	callID, name string,
	args map[string]any,
	value any,
	isError bool,
) AgentContext {
	tr := map[string]any{"value": value, "is_error": isError}
	ctx := b.envelope(PostToolCall, value)
	ctx["tool_call"] = map[string]any{"id": callID, "name": name, "args": args}
	ctx["tool_result"] = tr
	return ctx
}

// Output builds the output context (§4.2).
func (b *AgentContextBuilder) Output(content any) AgentContext {
	out := map[string]any{"content": content}
	ctx := b.envelope(Output, out)
	ctx["output"] = out
	return ctx
}

// AgentShutdown builds the agent_shutdown context (§4.2).
func (b *AgentContextBuilder) AgentShutdown(reason string) AgentContext {
	summary := map[string]any{"reason": reason}
	ctx := b.envelope(AgentShutdown, summary)
	ctx["summary"] = summary
	return ctx
}

// anySlice converts []T to []any so encoding/json emits a JSON array
// rather than a base64 string (which it would for []byte) and so the
// AgentContext round-trips as the schema expects.
func anySlice[T any](in []T) []any {
	out := make([]any, len(in))
	for i, v := range in {
		out[i] = v
	}
	return out
}
