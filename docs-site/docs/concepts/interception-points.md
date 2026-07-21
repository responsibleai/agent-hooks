# Interception points and the agent context

A host MUST emit eight interception points. The set is closed: a
context whose `interception_point` is anything else is invalid.

| Point | Position | Target (what `transform` may rewrite) |
| --- | --- | --- |
| `agent_startup` | once, before the first input | none (transform forbidden) |
| `input` | on ingress of each external request | `input` |
| `pre_model_call` | before each model request | `messages` |
| `post_model_call` | after each model response | `response` |
| `pre_tool_call` | before each tool invocation | `tool_call.args` |
| `post_tool_call` | after each tool invocation | `tool_result.value` |
| `output` | before the final response returns to the caller | `output` |
| `agent_shutdown` | once, at session end | none (transform forbidden) |

Ordering is normative: startup precedes everything, shutdown follows
everything, each `pre_*` is paired with exactly one `post_*` unless the
action was blocked, and `sequence` is strictly increasing per session.

## Context tiers

The `AgentContext` schema has four field tiers:

- **required**: present at every point. `spec`, `interception_point`,
  `timestamp`, `sequence`, `agent.{id,framework}`, `session.id`, and
  `target`.
- **conditional**: required at specific points, for example
  `tool_call.{id,name,args}` at `pre_tool_call` or
  `response.{content,tool_calls,finish_reason}` at `post_model_call`.
- **optional**: well-known fields a host SHOULD populate when the
  framework has the data (`model.vendor`, `usage.*`, `trace.*`,
  `tenant.*`, `budgets.*`, ...).
- **namespaced**: anything else, under `extensions.<namespace>`. Hosts
  pass extensions through verbatim and never interpret namespaces they
  do not own.

`target` is the slice of the context the guarded action will consume or
has produced, and it is the only value a transform verdict may rewrite.
The host must wire it so that applying a transform is observable in the
subsequent action; the per-point write-back rules are in §4.3 of the
specification.

## Value domain

Contexts cross language boundaries as JSON. Hosts must not place
non-finite floats or lone surrogates in any field, and SHOULD encode
64-bit integer identifiers as decimal strings (the proto3 convention):
JavaScript's `JSON.parse` rounds `9007199254740993` before any
interceptor can see it, and the default
[identity provider](identity.md) rejects integers beyond ±(2^53−1)
rather than hashing a rounded value.
