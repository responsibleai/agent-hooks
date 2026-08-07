# Agent Hooks Specification — Version 0.1

> **Status:** Draft · **Version:** `0.1.0-alpha` · **Date:** 2026-07-09
> **Editors:** Responsible AI / Agent Governance Toolkit
>
> This document defines a framework-neutral contract for **lifecycle hooks** in
> AI agent systems: a fixed set of interception points, the context payload a host
> framework supplies at each point, the verdict an interceptor returns, and
> the obligations a host MUST honour for each verdict. It is extracted from and
> supersedes §4, §13, §14, §17, and §18 of the Agent Control Specification
> v0.3.1-beta, which becomes one conformant interceptor of this contract.

---

## Table of contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Interception points](#3-interception-points)
4. [Agent context](#4-agent-context)
5. [Verdict](#5-verdict)
6. [Host obligations](#6-host-obligations)
7. [Interceptor contract and composition](#7-interceptor-contract-and-composition)
8. [Enforcement mode](#8-enforcement-mode)
9. [Approval seam](#9-approval-seam)
10. [Context identity and the interception record](#10-context-identity-and-the-interception-record)
11. [Reserved reasons](#11-reserved-reasons)
12. [Streaming and parallel tool calls](#12-streaming-and-parallel-tool-calls)
13. [Conformance](#13-conformance)
14. [Security considerations](#14-security-considerations)
15. [References](#15-references)

---

## 1. Introduction

### 1.1 Scope

[Pure Specification]

This specification defines the bidirectional control contract between a
**host** (an agent framework or runtime that executes an agent loop) and an
**interceptor** (a component that controls the agent at well-defined
lifecycle points by returning a verdict the host MUST act on). It defines:

- the closed set of **interception points** at which a host MUST invoke registered
  interceptors,
- the **`AgentContext`** JSON payload a host MUST construct at each interception point,
- the **`Verdict`** JSON payload an interceptor MUST return,
- the **obligations** a host MUST honour for each verdict decision,
- the closed set of **composition profiles** by which a host combines the
  verdicts of multiple interceptors (§7),
- a capability-scoped **conformance** model and a language-agnostic
  **Conformance Test Kit** (CTK).

This specification does NOT define how an interceptor computes a verdict.
Policy languages, manifests, dispatchers, annotators, and information-flow
lattices are out of scope and are defined by interceptor specifications such
as the Agent Control Specification (ACS).

This specification is a control plane, not a telemetry plane. It does NOT
define a passive observation, tracing, or metrics interface. Every
registered interceptor MUST return a `Verdict`; an interceptor that has no
control decision to make returns `allow`. A host MAY surface `AgentContext`
to its own telemetry, but that is outside this contract.

### 1.2 Key words

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as
described in [RFC 2119] and [RFC 8174] when, and only when, they appear in all
capitals.

### 1.3 Design invariants

[Pure Specification]

- **Determinism.** Given the same `AgentContext` and the same interceptor state, a
  interceptor SHOULD return the same `Verdict`. A host MUST NOT depend on
  non-determinism for correctness.
- **Fail closed.** A host that cannot construct a valid `AgentContext`, cannot
  reach a registered interceptor, or receives an invalid `Verdict` MUST treat the
  outcome as `deny` with a `host_error:*` reason per §11.
- **No silent bypass.** A host MUST NOT execute the action guarded by an
  interception point without first invoking every interceptor its declared
  composition profile (§7.2) requires for that point and honouring the
  combined verdict per §6.
- **Fail closed by construction.** An escalation is not a distinct decision
  waiting on the host to remember not to proceed: it is a `deny` carrying an
  `approval` block (§5.1). Unless the approval seam (§9) lifts it, nothing
  proceeds — there is no unresolved intermediate state.

### 1.4 Trust model and non-goals

[Pure Specification]

This specification constrains a **cooperating host**. It is not a
security boundary against a hostile or buggy host, and conformance is
not a security certification.

- The host is inside the trust boundary. Every obligation in §6 and
  §1.3 is a MUST on the host; a host that does not honour them voids
  the contract. This specification defines no mechanism to detect a
  host that skips interception points, ignores verdicts, or
  misreports enforcement mode.
- Registered interceptors are inside the host process and are fully
  trusted by the host. They receive the raw `target` (which may
  contain user PII, secrets in tool arguments, and model output) and
  any registered interceptor MAY return `deny` or `transform` at any
  interception point. Registering an interceptor is equivalent to
  granting it write access to every action the agent takes.
- The approval resolver (§9) is inside the host process and is fully
  trusted by the host.
- The eight interception points in §3 are the paths a conformant host
  wires. This specification does not claim complete mediation: a
  framework MAY expose code paths (direct tool execution, plugin
  hooks, background tasks) that do not reach any interception point,
  and the CTK cannot detect them.
- This specification does not define sandboxing, process isolation,
  authentication of interceptors, or authorization of who may register
  an interceptor. Those are host concerns.
- Conformance (§13) attests that the host adapter honours the verdict
  contract under CTK conditions with a mocked model and tools. It is
  not adversarial testing and MUST NOT be presented as a security
  certification.

---

## 2. Terminology

| Term | Definition |
| --- | --- |
| **Host** | An agent framework, SDK, or runtime that executes an agent loop and dispatches to interceptors at each interception point. |
| **Interceptor** | A component registered with the host that receives an `AgentContext` and returns a `Verdict`. |
| **Interception point** | One of the eight named lifecycle positions in §3. |
| **Agent context** | The JSON payload the host constructs at an interception point per §4. |
| **Target** | The JSON value within the agent context that the guarded action will consume or has produced. The value a `transform` verdict rewrites. |
| **Verdict** | The JSON payload an interceptor returns per §5. One of `allow`, `deny`, `transform`. |
| **Action** | The host operation immediately following a `pre_*` interception point or immediately preceding a `post_*` interception point (a model call, a tool invocation, emitting output). |
| **Permit verdict** | A verdict whose `decision` is `allow` or `transform`. |
| **Block verdict** | A verdict whose `decision` is `deny` (with or without an `approval` block). |
| **Liftable deny** | A `deny` verdict carrying an `approval` block (§5.1): denied as-is, unless the approval seam resolves to a permit. |
| **Composition profile** | The host-declared rule set (§7.2) for how the verdicts of multiple interceptors combine into one combined verdict at one emission. |
| **Combined verdict** | The single verdict that results from composing all interceptor verdicts (and any approval resolution) at one emission; the verdict §6 obligations apply to. |
| **Severity** | The total order on verdicts used by aggregation (§7.3): `deny` > liftable deny > `transform` > `allow`. |
| **Identity provider** | The host-declared function that maps an agent context to its `context_identity` string (§10.1). |
| **Emission** | One invocation of the interception machinery at one interception point: context construction, interceptor dispatch per the profile, and record production. |
| **CTK** | The Conformance Test Kit defined in §13 and shipped under `conformance/`. |

---

## 3. Interception points

[Pure Specification]

A host MUST emit the following eight interception points. The set is closed; a host
MUST NOT emit an `AgentContext` whose `interception_point` is not one of these values.

| `interception_point` | Position in the agent loop | Target (§4.3) | `transform` permitted |
| --- | --- | --- | --- |
| `agent_startup` | Once, before the first `input` of a session. | `agent_init` | no |
| `input` | On ingress of each external request into the session. | `input` | yes |
| `pre_model_call` | Immediately before each model request is dispatched. | `messages` | yes |
| `post_model_call` | Immediately after each model response is received. | `response` | yes |
| `pre_tool_call` | Immediately before each tool invocation. | `tool_call.args` | yes |
| `post_tool_call` | Immediately after each tool invocation completes (success or error). | `tool_result.value` | yes |
| `output` | Immediately before the final response is returned to the caller. | `output` | yes |
| `agent_shutdown` | Once, after the last `output` of a session or on abnormal termination. | `summary` | no |

### 3.1 Ordering

[Pure Specification]

Within a single session a host MUST emit interception points such that:

1. `agent_startup` precedes every other interception point.
2. `agent_shutdown` follows every other interception point.
3. Each `input` precedes the `pre_model_call`, `pre_tool_call`, and `output`
   hooks that result from it.
4. Each `pre_model_call` is followed by exactly one corresponding
   `post_model_call` unless the model call is blocked per §6.
   `request_id` (§4.5), when present, is the pairing key; a host that
   emits concurrent model calls SHOULD populate it.
5. Each `pre_tool_call` is followed by exactly one `post_tool_call` for the
   same `tool_call.id` unless the tool call is blocked per §6.
6. `sequence` (§4.1) is strictly increasing across all interception points in a
   session.

A host that supports multi-turn sessions MAY emit multiple
`input` → … → `output` cycles between a single `agent_startup` and
`agent_shutdown`.

### 3.2 Capability subsetting

[Default Implementation]

A host that does not perform model calls (e.g., a pure tool router) MAY omit
`pre_model_call` and `post_model_call`. A host that does not invoke tools MAY
omit `pre_tool_call` and `post_tool_call`. Such a host MUST declare its omitted
capabilities to the CTK per §13.2 and MUST still emit `agent_startup`, `input`,
`output`, and `agent_shutdown`.

---

## 4. Agent context

[Pure Specification]

A `AgentContext` is a JSON object. Its schema has four field tiers:

- **required** fields are REQUIRED at every interception point.
- **conditional** fields are REQUIRED at the specific interception point(s) listed.
- **optional** fields are well-known and OPTIONAL.
- **namespaced** fields are extensions under `extensions.<namespace>`.

The machine-readable schema is `spec/schema/agent-context.schema.json` with
per-point closed schemas at `spec/schema/agent-context/<interception_point>.schema.json`.

### 4.1 Required core

```jsonc
{
  "spec": "agent-hooks/0.1",
  "interception_point": "<one of §3>",
  "timestamp": "2026-06-19T14:03:11.123Z",
  "sequence": 0,
  "agent":   { "id": "string", "framework": "string" },
  "session": { "id": "string" },
  "target": <any JSON>
}
```

| Field | Type | Constraint |
| --- | --- | --- |
| `spec` | string | MUST match `^agent-hooks/\d+\.\d+$`. Identifies the spec version the host targets. |
| `interception_point` | string | MUST be one of the eight values in §3. |
| `timestamp` | string | RFC 3339 UTC instant at which the host constructed the context. |
| `sequence` | integer ≥ 0 | MUST be strictly increasing within `session.id`. Starts at 0 on `agent_startup`. |
| `agent.id` | string | Stable identifier for the agent definition. MUST be stable across sessions of the same agent. |
| `agent.framework` | string | Lowercase identifier of the host framework, matching `^[a-z0-9_-]+$` (e.g., `langchain`, `openai-agents`, `semantic-kernel`). |
| `session.id` | string | Stable identifier for the run/conversation. MUST be stable across all hooks in one session. |
| `target` | any | The value-under-evaluation per §4.3. The root that `$target` in a `transform.path` resolves against. |

### 4.2 Conditional — per-interception-point required fields

A host MUST populate the following fields at the indicated interception point in
addition to the required core. `target` MUST be set to the indicated value.

#### `agent_startup`

```jsonc
{
  "agent_init": {
    "tools_registered": ["string", ...]
  },
  "target": <agent_init>
}
```

#### `input`

```jsonc
{
  "input": {
    "content": "string | object",
    "role": "user" | "system" | "external"
  },
  "target": <input>
}
```

#### `pre_model_call`

```jsonc
{
  "model": { "id": "string" },
  "messages": [ { "role": "string", "content": "string | object" }, ... ],
  "target": <messages>
}
```

#### `post_model_call`

```jsonc
{
  "model": { "id": "string" },
  "response": {
    "content": "string | object | null",
    "tool_calls": [ { "id": "string", "name": "string", "args": {} }, ... ],
    "finish_reason": "string"
  },
  "target": <response>
}
```

`response.tool_calls` MUST be present and MUST be an empty array when the model
returned no tool calls.

#### `pre_tool_call`

```jsonc
{
  "tool_call": { "id": "string", "name": "string", "args": {} },
  "target": <tool_call.args>
}
```

#### `post_tool_call`

```jsonc
{
  "tool_call": { "id": "string", "name": "string", "args": {} },
  "tool_result": { "value": <any>, "is_error": false },
  "target": <tool_result.value>
}
```

`tool_call.args` at `post_tool_call` MUST reflect the arguments actually passed
to the tool, i.e., the post-`transform` value when a `transform` verdict was
applied at `pre_tool_call`.

#### `output`

```jsonc
{
  "output": { "content": "string | object" },
  "target": <output>
}
```

#### `agent_shutdown`

```jsonc
{
  "summary": { "reason": "completed" | "error" | "cancelled" },
  "target": <summary>
}
```

### 4.3 Target

[Pure Specification]

`target` is the slice of the context that the guarded action will consume
(`pre_*`, `input`) or has produced (`post_*`, `output`). It is the **only**
value a `transform` verdict may rewrite. A host MUST set `target` to a deep
reference (or deep copy followed by write-back) of the value indicated in the
§3 table such that applying a `transform` to `target` is observable in the
subsequent action.

A `transform` verdict at `agent_startup` or `agent_shutdown` MUST be rejected
by the host with `host_error:transform_target_forbidden` per §11.

### 4.4 Value domain

[Pure Specification]

Contexts cross language boundaries as JSON. Hosts:

- MUST NOT place non-finite floating-point values (NaN, ±Infinity) or
  lone Unicode surrogates in any context field. These are not
  representable in interoperable JSON ([RFC 7493]); SDK marshalling
  layers reject them fail-closed (`host_error:context_invalid`) rather
  than letting per-language encoders corrupt them silently.
- SHOULD encode integer identifiers that may exceed ±(2⁵³−1) — 64-bit
  database keys, snowflake IDs — as decimal **strings** at the adapter
  boundary (the proto3 JSON convention). Rationale: a JavaScript
  interceptor observes such integers already rounded by `JSON.parse`,
  so the value evaluated can differ from the value the tool executes;
  and the default identity provider (§10.1) rejects them.

Neither the core nor any SDK normalizes values. A value is either
accepted as supplied or rejected with an actionable message; nothing is
silently rewritten.

### 4.5 Optional — well-known fields

A host SHOULD populate the following fields when the underlying framework
exposes the data. Absence is conformant.

| Field | Interception point(s) | Type |
| --- | --- | --- |
| `agent.name`, `agent.version` | all | string |
| `session.started_at` | all | RFC 3339 |
| `session.turn` | all | integer ≥ 0 |
| `model.vendor`, `model.params` | `*_model_call` | string, object |
| `request_id` | `*_model_call` | string |
| `tools` | `pre_model_call` | array of `{name, description?, schema?}` |
| `usage.prompt_tokens`, `usage.completion_tokens` | `post_model_call` | integer |
| `tool_result.duration_ms` | `post_tool_call` | number |
| `tool_call.content_hash` | `pre_tool_call` | string `sha256:<hex>`. **Host-opaque**: the preimage is host-defined, so values are comparable only within one host and carry no cross-host meaning. Portable content binding is what `context_identity` (§10) provides. |
| `messages` | any | full message chain |
| `trace.trace_id`, `trace.span_id` | all | W3C Trace Context hex strings |
| `tenant.id`, `tenant.name` | all | string |
| `actor.id`, `actor.kind` | all | string, `human`\|`service`\|`agent` |
| `budgets.tool_call_count`, `.token_count`, `.elapsed_seconds`, `.cost_usd` | all | number |

### 4.6 Namespaced — extensions

```jsonc
{
  "extensions": {
    "<namespace>": <any JSON>
  }
}
```

`<namespace>` MUST match `^[a-z][a-z0-9_]*$`. The namespaces `acs`, `ctk`, and
`agent_hooks` are reserved by this specification. A host MUST pass `extensions`
through to interceptors verbatim and MUST NOT interpret namespaces it does not
own.

---

## 5. Verdict

[Pure Specification]

An interceptor MUST return a JSON object conforming to
`spec/schema/verdict.schema.json`.

```jsonc
{
  "decision": "allow" | "deny" | "transform",
  "reason": "string",
  "message": "string",
  "warnings": [ { "reason": "string", "message": "string" }, ... ],
  "approval": { },
  "transform": { "path": "$target...", "value": <any> },
  "evidence": { "artefact": "string", "verification_pointers": { "<k>": "uri" } },
  "result_labels": ["string", ...]
}
```

| Member | Required | Constraint |
| --- | --- | --- |
| `decision` | yes | One of the three values above. |
| `reason` | no | MUST NOT start with `host_error:`. Free-form machine identifier. |
| `message` | no | Free-form human-readable text. |
| `warnings` | no | Array of `{reason?, message?}` objects. Permitted on any decision. See §5.1. |
| `approval` | no; only valid when `decision == "deny"` | JSON object (MAY be empty). Marks the deny as liftable by the approval seam (§9). MUST be absent for `allow` and `transform`. |
| `transform` | iff `decision == "transform"` | See §5.2. MUST be absent for all other decisions. |
| `evidence` | no | See §5.3. Serialized size MUST NOT exceed 10240 bytes. |
| `result_labels` | no | Array of strings. See §5.4. |

A host that receives a verdict that is not a JSON object, whose `decision` is
absent or invalid, whose `reason` starts with `host_error:`, whose `transform`
or `approval` presence violates the constraints above, whose `warnings` is not
an array of objects, whose `evidence` is not an object, or whose
`result_labels` is not an array of strings MUST treat it as
`{"decision": "deny", "reason": "host_error:verdict_invalid"}`.

### 5.1 Decision semantics

| Decision | Class | Semantics |
| --- | --- | --- |
| `allow` | permit | The action proceeds with `target` unchanged. |
| `transform` | permit | The action proceeds with `target` rewritten per §5.2. |
| `deny` | block | The action MUST NOT proceed. |
| `deny` + `approval` | block (liftable) | The action MUST NOT proceed **unless** the approval seam (§9), consulted per the composition profile (§7), resolves to a permit verdict. A host with no registered resolver enforces the deny as-is; that is conformant behaviour, not an error. |

**Warnings.** A warning is a recorded concern that does not affect
control flow. A host MUST record `warnings` on the interception record
(§10.3) and SHOULD surface them to its own logging. There is no
separate `warn` decision: what earlier drafts expressed as `warn` is
`allow` with a `warnings` entry. SDKs provide `Verdict.warn(...)` as
constructor sugar for exactly that shape.

**Escalation.** There is no separate `escalate` decision: an
escalation is a `deny` with an `approval` block — denied as-is, unless
approved. This makes fail-closed a property of the type: an unconsumed
or unresolved escalation *is* a deny, with no host obligation needed to
keep it from proceeding. SDKs provide `Verdict.escalate(...)` as
constructor sugar for a deny with an empty `approval` block.

**Severity.** Aggregation (§7.3) uses this total order, fixed by this
specification and not host-configurable:

```
deny  >  deny+approval  >  transform  >  allow
```

A plain deny dominates a liftable one: if any interceptor
unconditionally denies, consulting an approver is pointless.

### 5.2 Transform

```jsonc
{ "path": "$target.<jsonpath-segments>", "value": <any> }
```

- `path` MUST be rooted at `$target`. For backward compatibility with ACS
  v0.3.x, a host MUST also accept the deprecated alias `$policy_target` and
  treat it as `$target`. The alias is removed in agent-hooks v0.3.
- `path` segments follow the subset of JSONPath defined in
  `spec/schema/path-grammar.abnf`: dot-member (`.foo`), bracket-index (`[0]`),
  and bracket-member (`["foo"]`) only.
- `value` is any JSON value, including `null`. An absent `value`
  member is equivalent to `null` (the §10.3 record projection and SDK
  marshalling layers omit null values, so the two forms MUST agree).
- A host MUST resolve `path` against the context's `target` value and replace
  the addressed location with `value`. The replacement MUST NOT modify any
  other part of the `AgentContext`.
- A `path` rooted elsewhere than `$target`/`$policy_target` MUST yield
  `host_error:transform_target_forbidden`.
- A `path` that does not resolve, or whose segment types are incompatible with
  `target`'s structure, MUST yield `host_error:transform_invalid`.

### 5.3 Evidence

`evidence` is an opaque pointer to an offline-verifiable artefact supporting
the verdict. A host MUST NOT dereference `verification_pointers`. A host MUST
propagate `evidence` to its audit sink unchanged when present.

The size cap is measured as the UTF-8 byte length of the RFC 8785
canonical JSON serialization (§10.2) of the `evidence` member. A
verdict whose `evidence` exceeds 10240 bytes fails §5 validation: the
host MUST treat the whole verdict as
`{"decision": "deny", "reason": "host_error:verdict_invalid"}`. The
bound keeps the interception record (§10.3), which carries `evidence`
through, itself bounded.

### 5.4 Result labels

`result_labels` is the interceptor's return channel for label-flow tracking. A
host MUST persist `result_labels` alongside the data the interception point's `target`
produced (a tool result, a model output, a final output) and SHOULD resurface
them as `extensions.<interceptor-namespace>.source_labels` on later hooks whose
`target` derives from that data. A host MUST NOT persist `result_labels` for an
action that did not proceed (a `deny` that was not lifted).

---

## 6. Host obligations

[Pure Specification]

For each emission, after obtaining the **combined verdict** (§7) in `enforce`
mode (§8):

| Combined verdict | Host MUST |
| --- | --- |
| `allow` | Proceed with the action using `target` unchanged. Record any warnings. |
| `transform` | Apply the transform to `target` per §5.2 (if not already applied during sequential fold-through, §7.4), then proceed with the action using the transformed value. |
| `deny` | NOT proceed with the action. At `pre_*` hooks the guarded call MUST NOT be dispatched. At `input` the turn MUST NOT begin. At `output` the response MUST NOT be returned to the caller. This applies equally to a liftable deny that the approval seam did not lift (rejected, unresolved, or never consulted). |

### 6.1 Post-action block semantics

At `post_model_call` and `post_tool_call` the action has already executed. A
`deny` (lifted or not, per §7) at these points means the host MUST NOT
incorporate the result into subsequent agent state: the model response or tool
result MUST be discarded as if it had errored, and the host MUST NOT
re-execute the action.

### 6.1a Session boundaries

`agent_startup` and `agent_shutdown` have no bracketed action, so block
verdicts there need their own rules:

- A combined `deny` at `agent_startup` means the session MUST NOT
  process any input: no `input`, model, tool, or `output` interception
  point may be emitted afterwards. The host MUST still emit
  `agent_shutdown` (with `summary.reason` = `error`) so the session's
  record trail is closed.
- At `agent_shutdown` there is nothing left to prevent. A block verdict
  is recorded (the fail-closed audit trail is preserved) but imposes no
  further obligation; the host MUST NOT re-execute anything and MUST
  NOT consult the approval seam (§9) for a liftable deny returned at
  `agent_shutdown` — there is no action to approve.

### 6.2 Block propagation

When a `pre_*` interception point yields a combined block verdict, the host MUST NOT emit the
corresponding `post_*` interception point for that action. The host MUST continue the agent
loop as if the action had failed (e.g., surface a tool error to the model)
unless the host's own semantics terminate the turn.

### 6.3 Failure handling

A host that fails to construct a valid `AgentContext` for an
interception point — including a context that fails the §4 envelope
check — MUST treat the emission as
`{"decision": "deny", "reason": "host_error:context_invalid"}` without
dispatching to any interceptor. Interceptor failures map one-to-one:

| Failure | Substituted verdict |
| --- | --- |
| The interceptor raises (or panics) | `deny` `host_error:interceptor_failed` |
| The interceptor exceeds the host's timeout | `deny` `host_error:interceptor_timeout` |
| The returned value fails §5 validation | `deny` `host_error:verdict_invalid` |

The substituted deny takes the failing interceptor's **slot**: it
occupies that interceptor's position in the profile's composition
(§7.3–§7.5), appears at that index in the record's `verdicts` summary,
and carries that index as `decided_by` when it wins (§10.3). In
`sequential/run_all` and the parallel profiles, other interceptors'
verdicts are unaffected — a single failure does not abort the
emission, it composes as a deny. Host-synthesized messages MUST NOT
include target-derived content (§14): an exception type name is
acceptable, an exception string is not.

---

## 7. Interceptor contract and composition

[Pure Specification]

An interceptor is a callable `intercept(context: AgentContext) -> Verdict`. A host:

- MUST NOT begin the guarded action until composition (per the declared
  profile, §7.2) is complete and the combined verdict permits it.
- MUST pass each interceptor its own copy of the context; an
  interceptor's in-place mutation of the object it received MUST NOT
  affect enforcement, identity computation, or later interceptors.
- MUST, in `enforce` mode with zero registered interceptors, treat every
  emission as `deny` with reason `host_error:no_interceptor` (§11). A
  deliberate passthrough is expressed by registering an explicit
  allow-all interceptor. This rule is profile-independent.
- SHOULD bound interceptor execution with a configurable timeout
  (RECOMMENDED default: 5000 ms) and apply §6.3 on breach.

### 7.1 Composition is host configuration

How multiple interceptors compose at one emission is a **host
configuration choice**, never something a returned verdict can
influence. A verdict carries the interceptor's decision content only;
the host declares — before dispatch — which profile governs execution
and aggregation. The profile in effect MUST be recorded on every
interception record (§10.3) so records are interpretable without
out-of-band knowledge of host configuration.

### 7.2 Composition profiles

The profile set is **closed**: a host MUST NOT invent profiles or
deviate from the semantics below. A host declares which profiles it
supports (per session or per interception point) and MAY expose the
choice to its operator. No profile is mandatory; conformance (§13) is
assessed against exactly the profiles a host declares.

| Profile | Mode | Summary |
| --- | --- | --- |
| `sequential/first_deny` | sequential | Fold-through; first deny short-circuits. Knob: `on_approval: "stop" \| "resume"`. |
| `sequential/run_all` | sequential | Fold-through; nothing short-circuits; severity-max aggregate. |
| `parallel/strictest` | parallel | Snapshot isolation; severity-max aggregate. |
| `parallel/unanimous` | parallel | Snapshot isolation; anything but unanimous `allow` is a disagreement. Knob: `on_disagreement: "deny" \| "approval"`. |

Knobs for parallel-mode transform conflicts:
`on_transform_conflict: "deny" | "approval"` (§7.5).

**Knob defaults are normative.** When the host does not set a knob the
profile consults, its value is: `on_approval: "stop"`,
`on_disagreement: "deny"`, `on_transform_conflict: "deny"` — the
fail-closed choice in each case. The record's `composition` block
carries the **resolved** values (§10.3), so two hosts with identical
records behaved identically regardless of how their configuration
spelled the defaults.

**"Parallel" names isolation semantics, not scheduling.** In a parallel
profile every interceptor receives its own copy of the **same,
untransformed** context snapshot; no interceptor observes another's
transform. A host MAY dispatch the interceptors concurrently or
serially — the observable semantics are identical, and the CTK cannot
and does not distinguish them.

Two rejected policies are documented for the record and MUST NOT be
implemented under this version:

- *Quorum (k-of-n allow)*: configuration surface for a weak security
  story — n−k controls silently overridden.
- *Most-permissive-wins*: one permissive interceptor silently bypasses
  every other control, violating the no-silent-bypass invariant (§1.3).
  Advisory interceptors are what `warnings` and `result_labels` are for.

### 7.3 Aggregation

Aggregation selects **one winning verdict** and unions the metadata:

1. The winner is the highest-severity verdict per the §5.1 order.
   Ties between block verdicts resolve to the lowest registration
   index (that index becomes `decided_by`, §10.3). Transform ties are
   a conflict **only in parallel profiles** (§7.5), where the
   transforms were produced against the same snapshot and cannot
   compose; in sequential profiles transforms composed through the
   fold (§7.4), so the last transform returned is the winner.
2. The combined verdict is the winner (or the approval resolution that
   substitutes for it, §7.6), with:
   - `warnings`: the first-seen-ordered union of `warnings` from
     **every** verdict returned in the emission. Two warnings are
     equal iff both their `reason` and `message` members are equal;
     duplicates by that test appear once, at first position;
   - `result_labels`: the first-seen-ordered union of labels from every
     **permit** verdict returned in the emission (labels are dropped
     entirely when the emission does not proceed, per §5.4).
3. Losing verdicts impose no obligations, but every returned verdict is
   summarized on the record (§10.3) in multi-verdict profiles.

### 7.4 Sequential profiles

Interceptors are invoked in registration order. When an interceptor
returns `transform` in `enforce` mode, the host MUST apply it to
`target` (per §5.2, including the §4.3 write-back) **before** invoking
the next interceptor, so each interceptor observes the context as
already transformed by its predecessors. In `evaluate_only` mode the
transform is validated but not applied (§8), so later interceptors
observe the untransformed context. A transform that fails to apply
(§5.2) becomes a `deny` with the corresponding `host_error:*` reason
and — in both sequential profiles — short-circuits. When that
short-circuit (or any other) leaves registered interceptors uninvoked,
the record sets `fold_truncated: true` (§10.3) in **either** sequential
profile.

**`sequential/first_deny`.** The first `deny` (liftable or not)
short-circuits: remaining interceptors are NOT invoked. If the deny is
liftable and a resolver is registered, the host consults the approval
seam (§9). Then, per the `on_approval` knob:

- `"stop"`: a permit resolution becomes the combined verdict and the
  emission ends — interceptors after the denying one are never
  invoked. The record MUST set `fold_truncated: true` (interceptors
  were skipped) and `resolved_by: "approval"`, so the truncation is
  never silent.
- `"resume"`: a permit resolution substitutes for the denying
  interceptor's verdict (an `allow` continues with the context
  unchanged; a `transform` is applied per §7.4) and the fold continues
  with the next interceptor. Each subsequently encountered liftable
  deny MUST be consulted in turn (consultations are bounded by the
  number of registered interceptors), so two conformant hosts never
  diverge on which denies were offered to the resolver. The record sets
  `resolved_by: "approval"`; `fold_truncated` is `true` only if the
  emission still ended before every interceptor ran (e.g., a later
  plain deny).

A rejected or unresolved resolution leaves the deny standing as the
combined verdict in either knob position.

If no interceptor returned `deny`, the combined verdict is the last
`transform` returned, or `allow` — with metadata unioned per §7.3.

**`sequential/run_all`.** Every interceptor runs, in order, regardless
of intermediate verdicts; transforms fold through for visibility
exactly as above. The combined verdict is the severity-max aggregate
(§7.3). Two consequences the record makes legible:

- Interceptors after a decisive deny still run and evaluate content
  that will never execute; their verdicts appear in the record's
  `verdicts` summary.
- On a combined deny, folded transforms are discarded — nothing
  proceeds, so nothing was transformed for enforcement purposes
  (`enforced_identity` still reflects the folded context, preserving
  the audit trail of what interceptors observed).

Approval in `run_all`: the seam is consulted **at most once per
emission**, and only when the aggregate winner is a liftable deny and
**every** deny returned in the emission carries an `approval` block (a
single plain deny makes lifting pointless — severity already decided).
A permit resolution lifts the entire deny set and becomes the combined
verdict (an `allow` proceeds with the folded context; a `transform` is
applied on top of it). A rejected or unresolved resolution leaves the
aggregate deny standing.

### 7.5 Parallel profiles

Every interceptor receives an isolated copy of the same untransformed
snapshot. No transform is applied during dispatch; there is no fold.

**`parallel/strictest`.** The combined verdict is the severity-max
aggregate (§7.3). If the winner is a `transform`:

- Exactly one interceptor returned `transform` → the host applies it
  (§5.2) and proceeds.
- Two or more returned `transform` → **conflict**: transforms produced
  against the same snapshot do not compose (neither transformer saw
  the other's output, and application order would be arbitrary). Per
  `on_transform_conflict`:
  - `"deny"`: the combined verdict is
    `{"decision": "deny", "reason": "host_error:transform_conflict"}`.
  - `"approval"`: the host synthesizes a liftable deny with reason
    `host_error:transform_conflict` and consults the seam (§9); the
    resolver (typically a human) MAY resolve the conflict by returning
    a `transform` of its own, or an `allow`, or reject.

If the winner is a liftable deny (and no plain deny was returned), the
host consults the seam at most once; a permit resolution becomes the
combined verdict. Lower-severity transforms returned by other
interceptors are NOT applied — they lost the aggregation; they appear
in the record's `verdicts` summary.

**`parallel/unanimous`.** The combined verdict is `allow` (with
metadata unioned per §7.3) iff **every** interceptor returned `allow`.
Any other outcome — any deny or any transform — is a **disagreement**.
Per `on_disagreement`:

- `"deny"`: the combined verdict is
  `{"decision": "deny", "reason": "host_error:composition_disagreement"}`.
- `"approval"`: the host synthesizes a liftable deny with reason
  `host_error:composition_disagreement` and consults the seam; the
  resolution (a verdict) becomes the combined verdict on permit.

A host wanting transforms to participate in aggregation uses
`parallel/strictest`; `unanimous` is deliberately strict.

### 7.6 Approval substitution

Whenever a profile consults the approval seam and receives a permit
resolution, that resolution's verdict — expressed in the same
three-verdict vocabulary (§9) — **substitutes** for the verdict (or
synthesized verdict) that triggered the consultation, at that
verdict's position in the profile's semantics. `decided_by` (§10.3)
remains the index of the interceptor whose liftable deny was consulted
(or `null` for a synthesized one); `resolved_by: "approval"` records
the substitution.

---

## 8. Enforcement mode

[Pure Specification]

A host MUST support two modes, selected per session or per interception point:

| Mode | Behaviour |
| --- | --- |
| `enforce` | The host honours combined verdicts per §6. |
| `evaluate_only` | The host invokes interceptors per the declared profile and records verdicts but proceeds with every action as if the combined verdict were `allow`. The host MUST validate `transform` per §5.2 but MUST NOT apply it. The host MUST NOT consult the approval seam. The host MUST NOT present an `evaluate_only` outcome as enforcement to any downstream system. |

---

## 9. Approval seam

[Pure Specification]

The approval seam is how a **liftable deny** (§5.1) may be lifted. The
host consults a registered **approval resolver** exactly when the
composition profile in effect says to (§7.4–§7.6), and never at
`agent_shutdown` (§6.1a) or in `evaluate_only` mode (§8).

```jsonc
// ApprovalRequest
{
  "context_identity": "<string per §10.1>" | null,
  "interception_point": "<§3>",
  "verdict": <the liftable deny Verdict>,
  "context": <the AgentContext>            // MAY be redacted per host policy
}

// ApprovalResolution
{
  "outcome": "approve" | "reject" | "unresolved",
  "context_identity": "<string>" | null,   // MUST equal the request's (echo rule)
  "verdict": <a permit or deny Verdict>    // present iff outcome != "unresolved"
}
```

- `approve` MUST carry a permit verdict (`allow` or `transform`). It
  substitutes per §7.6.
- `reject` MUST carry `{"decision": "deny", ...}`. The triggering deny
  (or the resolver's deny) stands as the combined verdict.
- `unresolved` means the resolver could not decide. The host MUST treat it as
  `deny` with `host_error:approval_unresolved`.
- **Echo rule.** The resolution's `context_identity` MUST equal the
  request's, byte for byte (`null` echoes as `null`). A mismatch MUST
  be rejected with `host_error:approval_identity_mismatch`. This is
  the only normative constraint on the identity value itself; how it
  is computed is the identity provider's concern (§10.1).
- A host with no registered resolver enforces the liftable deny as a
  plain deny. This is conformant behaviour, not an error; the record
  shows no resolution was obtained.
- A resolver that raises or times out MUST yield
  `deny` with `host_error:approval_resolver_failed`.
- **Resolution validation order.** A host MUST validate a resolution
  in this order, substituting the named deny at the first failure:
  1. echo rule (above) → `host_error:approval_identity_mismatch`;
  2. `outcome` is one of the three values, and `verdict` is present
     exactly when `outcome != "unresolved"` →
     `host_error:approval_resolver_failed`;
  3. the carried `verdict` passes §5 validation →
     `host_error:verdict_invalid`;
  4. outcome/verdict consistency (`approve` carries a permit,
     `reject` carries a deny) → `host_error:verdict_invalid`.

  The order is normative so that independently implemented hosts
  report the same reason for the same malformed resolution.

The `context_identity` presented in the request is computed by the
identity provider from the context **as presented to the resolver** —
at consultation time, after any transforms that folded earlier in a
sequential dispatch, **and after any host redaction applied for the
request**. Binding the approval to the identity of what was actually
shown to the approver prevents an approval obtained for one content
from being replayed against another (when the provider is
content-derived, §10.1).

**Redaction seam.** The approval resolver is the contract's primary
out-of-process egress (ticketing UIs, chat approvals). A host MAY
register an **approval redactor** — a pure function producing the
context to place in the ApprovalRequest — to minimize that egress.
Rules:

- the request's `context_identity` is computed over the **redacted**
  context (above), so the echo rule and replay defence still hold for
  exactly the bytes the approver saw;
- the record's `input_identity`/`enforced_identity` are unaffected —
  they bind the enforcement path, not the approval egress;
- a redactor that raises or panics fails the consultation closed as
  `deny host_error:approval_resolver_failed`;
- hosts SHOULD document removed content under the reserved
  `extensions.<host>.redacted` shape: an array of §5.2 path strings.

---

## 10. Context identity and the interception record

[Pure Specification]

### 10.1 Identity provider

`context_identity` is an **opaque string** produced by the host's
declared **identity provider** — a pure function
`AgentContext -> string`. This specification imposes exactly two rules
on the value, both already stated where they apply:

1. the **echo rule** (§9): the identity presented in an
   ApprovalRequest returns unchanged in its resolution;
2. the **record rule** (§10.3): the identities in effect (or explicit
   `null`) and the provider's name appear on every record.

A host declares one of:

| `identity_provider` | Meaning |
| --- | --- |
| `"jcs-sha256"` | The default provider defined in §10.2. Shipped by every SDK; in effect unless the host configures otherwise. |
| `"<host-defined>"` (matching `^[a-z][a-z0-9_-]*$`, not starting with `jcs`) | A host-supplied function. The CTK verifies the echo and record rules against it; the golden identity vectors do not apply. |

Content-derived identities are unsalted deterministic hashes (see §14);
deployments that need non-linkable records SHOULD declare a keyed
custom provider and are RECOMMENDED to name it `hmac-sha256-<key-id>`
so conformance claims remain comparable.
| `null` | No identity. Approvals bind only by request/response correlation; records carry `null` identities and self-describe as **unbound**. Permitted, but the record and any conformance claim (§13.3) MUST state it — honest absence over pretend presence. |

**Name rules are enforced, not advisory.** A host (and every SDK
constructor) MUST reject a host-defined provider name that does not
match `^[a-z][a-z0-9_-]*$` or that begins with `jcs` — the `jcs`
prefix is reserved so a custom function can never claim golden-vector
semantics on records.

**Failure semantics.** A declared provider that raises, panics, or
returns a non-string MUST fail the emission closed as `deny`
`host_error:context_invalid` before any interceptor runs — a provider
that cannot compute MUST NOT silently unbind the emission (null
identities under a declared provider are reserved for the §10.2/§4
rejection shape, where the combined verdict says so).

**Determinism.** A provider SHOULD be a pure function of the context;
a non-deterministic provider breaks approval binding (§9) and audit
correlation across records. A conformance claim (§13.3) MUST disclose
whether the declared provider is content-derived.

The identity provider is inside the host process and fully trusted
(§1.4): it receives the raw context and produces the sole value the
approval seam binds to.

### 10.2 The `jcs-sha256` provider

`context_identity(ctx)` is `"sha256:" + lowercase_hex(SHA-256(canonical_json(ctx_rc)))`
where:

- `canonical_json` is RFC 8785 (JSON Canonicalization Scheme):
  object members sorted by UTF-16 code units, numbers per ECMA-262
  `Number::toString`, minimal RFC 8259 string escapes, no
  insignificant whitespace. The canonical Rust core delegates to an
  RFC 8785 implementation; every binding inherits it, and the golden
  vectors in `conformance/golden/identity.json` pin the exact bytes.
- `ctx_rc` is the **closed** required+conditional projection of `ctx`
  for its interception point: exactly the fields marked required in
  the per-point schemas under `spec/schema/agent-context/`, including
  the nested subfield whitelists (`agent.{id,framework}`,
  `session.{id}`, `model.{id}`, `tool_call.{id,name,args}`,
  `tool_result.{value,is_error}`,
  `response.{content,tool_calls,finish_reason}`, `input.{content,role}`,
  `agent_init.{tools_registered}`, `output.{content}`,
  `summary.{reason}`). All other members — optional and namespaced
  fields and nested optional subfields such as `tool_result.duration_ms`
  or `tool_call.content_hash` — are excluded, so adding optional data
  never perturbs the identity.

**Input domain (fail closed, never normalize).** RFC 8785 defines
canonical bytes only for I-JSON ([RFC 7493]) data. The provider MUST
reject — as `deny` with `host_error:context_invalid` and a
remediation-detail message (e.g., *"integer exceeds 2^53;
string-encode 64-bit identifiers, see §4.4"*) — any context whose
projection contains:

- an integral number outside ±(2⁵³−1) (canonicalization would silently
  round it, making the identity non-injective);
- a non-finite number or a lone surrogate (not representable; in
  practice these fail at the parse funnel before the provider runs,
  and SDK marshalling guards reject them uniformly per §4.4).

The provider never rewrites a value to make it canonicalizable.

**No identity over a guessed preimage.** The provider MUST reject a
context whose `interception_point` is absent or outside the closed §3
set — a preimage assembled for a guessed point would produce a
real-looking identity for a context the schema forbids. More broadly,
a host MUST validate the §4 envelope (required core and per-point
conditional fields, presence and JSON type) **before** dispatching any
emission; an invalid envelope is the §6.3 `context_invalid` deny — no
interceptor runs, no identity is computed, and the record carries
best-effort envelope fields with `null` identities and the fail-closed
verdict, never a plausible one.

### 10.3 The interception record

A host MUST produce one **InterceptionRecord** per emission. The record
is payload-free: it carries no context or target content. Because the
combined verdict itself can carry target content (a `transform.value`
is by definition a replacement for part of the target), the record
MUST carry the **payload-free projection** of the combined verdict,
not the verdict verbatim:

- `decision`, `reason`, `result_labels`, and warning/message `reason`
  fields are kept as-is;
- `message` and each `warnings[].message` are truncated to at most
  256 UTF-8 bytes (on a character boundary, with a trailing `…` when
  truncated);
- `approval` presence is kept but its members are stripped (an empty
  object);
- `transform.path` is kept; `transform.value` is DROPPED;
- `evidence` is kept — it is an opaque offline pointer by design
  (§5.3) and is bounded by the §5.3 size cap.

The projection guarantees: a record never contains target-derived
content beyond what an interceptor deliberately placed in a bounded
`reason`/truncated `message`, and its size is bounded by the §5.3
evidence cap plus fixed-size members. The full combined verdict
remains available to the host in-process; only the record is
projected. A host MUST NOT persist the unprojected verdict in place
of the record.

```jsonc
{
  "interception_point": "<§3>",
  "mode": "enforce" | "evaluate_only",
  "verdict": <payload-free projection of the combined verdict, §7.3>,
  "input_identity": "<string>" | null,
  "enforced_identity": "<string>" | null,
  "identity_provider": "jcs-sha256" | "<host-defined>" | null,
  "session_id": "string",
  "sequence": 0,
  "timestamp": "2026-06-19T14:03:11.123Z",             // absent when the context lacked it
  "trace": { "trace_id": "<hex>", "span_id": "<hex>" }, // absent when the context carried none
  "decided_by": 0 | null,
  "composition": {
    "profile": "sequential/first_deny" | "sequential/run_all"
             | "parallel/strictest" | "parallel/unanimous",
    "on_approval": "stop" | "resume",              // sequential/first_deny only
    "on_disagreement": "deny" | "approval",        // parallel/unanimous only
    "on_transform_conflict": "deny" | "approval"   // parallel profiles only
  },
  "verdicts": [ { "index": 0, "decision": "allow", "reason": "string", "name": "string" }, ... ],
  "fold_truncated": false,
  "resolved_by": "approval" | "rejection" | null,
  "interceptors_registered": 0
}
```

| Field | Definition |
| --- | --- |
| `input_identity` | Provider output on the context **before** dispatch. `null` iff `identity_provider` is `null` **or the emission was rejected before dispatch** (the envelope failed §4 validation, or the provider rejected/failed per §10.1–§10.2) — in the rejection case the combined verdict is the corresponding `host_error:context_invalid` deny, so a null identity under a declared provider is never ambiguous. |
| `enforced_identity` | Provider output after composition completes (post-fold in sequential profiles). Equal to `input_identity` when no transform was applied, and always equal in `evaluate_only` mode. |
| `identity_provider` | The declared provider (§10.1). |
| `session_id`, `sequence` | Copied from the context; records are totally ordered within a session. |
| `timestamp` | OPTIONAL. The context's RFC 3339 `timestamp`, copied verbatim — the event time audit/SIEM sinks index on. Absent when the context lacked the field. |
| `trace` | OPTIONAL. `{trace_id?, span_id?}` echoed from the context's optional `trace` block (§4.5, W3C Trace Context). Payload-free identifiers only; absent when the context carried neither member. Lets a record join the host's distributed trace without out-of-band stitching. |
| `decided_by` | Registration index of the interceptor whose verdict won the aggregation (§7.3) or whose liftable deny was consulted (§7.6). A §6.3 failure deny (`interceptor_failed`, `interceptor_timeout`, `verdict_invalid`) carries the **failing interceptor's** index, in every profile. `null` is reserved for pure-allow combinations, §5.2 transform-application failures, and profile-synthesized verdicts (`transform_conflict`, `composition_disagreement`, `no_interceptor`, identity-provider rejection). |
| `composition` | The profile and knobs in effect (§7.1). REQUIRED. Knob members the profile consults MUST be present with their **resolved** values (the §7.2 defaults filled in when the host left them unset); knobs the profile never consults MUST be absent. |
| `verdicts` | Payload-free per-interceptor summary `{index, decision, reason?, name?}`. REQUIRED in multi-verdict profiles (`sequential/run_all`, `parallel/*`); OPTIONAL in `sequential/first_deny`. `name` is the host-chosen registration identifier for the interceptor at `index` (§7); it MUST be payload-free. |
| `fold_truncated` | `true` iff one or more registered interceptors were never invoked in this emission — a first-deny short-circuit, an approval-stop, or a failed fold-transform (§7.4). Defined for the sequential profiles. |
| `resolved_by` | Consultation outcome (§7.6): `"approval"` iff a permit resolution substituted for a verdict; `"rejection"` iff the seam was consulted and did **not** lift the deny (reject, unresolved, resolver failure, or echo violation); absent iff the seam was never consulted. A record reader can therefore always answer "was a human consulted, and did they permit?". |
| `interceptors_registered` | Number of interceptors registered at emission time. Together with `verdicts`/`fold_truncated` this makes skipped interceptors detectable from the record alone. |

**Host projection failure.** The reserved reasons of §11 assume an
emission: a context reached the emitter and something about it or its
dispatch failed. A fault in the host's **own projection to the wire**
— the host cannot construct an `AgentContext` for a point at all
(e.g. a tool-call argument's property getter throws during to-wire
conversion at the chat seam) — happens before anything exists to
emit, and a host without further provision can only fail the action
closed **recordless**, leaving the trail silently shorter than the
session. A host MUST still fail the guarded action closed in
`enforce` mode, and SHOULD produce an interception record for the
failed emission: the payload-free projection of a synthesized `deny`
with reason `host_error:context_invalid` (§11 — the host could not
construct a schema-valid context) whose OPTIONAL `message` names the
failure **type or path only**, never the content that failed to
project (§14); `input_identity` and `enforced_identity` `null` under
the declared provider (the rejection shape above); `decided_by:
null`, no `verdicts` entries, and `interceptors_registered` reporting
the registration count — no interceptor ran. The envelope members
carry what the host still knows: `session_id` and `sequence` SHOULD
be the values the failed emission would have carried — the host
SHOULD consume the next sequence number for it, so records stay
totally ordered within the session — and are `""`/`-1` when unknown;
`timestamp` is present when the host has one. The record is produced
in both enforcement modes; in `evaluate_only` it documents the host
fault without implying enforcement (§8) — the action failed on its
own, not on a verdict. SDK emitters expose this as the
`record_host_failure` affordance (per-language naming), delivered
through the same record stream (sink, then buffer) as every emission.

*Informative — OpenTelemetry alignment.* The optional context fields
`usage.prompt_tokens`/`usage.completion_tokens` (§4.5) correspond to
the OTel GenAI semantic-convention attributes `gen_ai.usage.input_tokens`/
`gen_ai.usage.output_tokens`, and the record's `trace` block carries
W3C Trace Context identifiers as used by OTel spans. Hosts emitting
both planes SHOULD map these pairs directly rather than inventing a
divergent naming.

---

## 11. Reserved reasons

[Pure Specification]

A host MUST use the following `reason` values, and only these, when it
synthesizes a `deny` verdict per §6.3, §5.2, §7.5, §9, or §10.3 (host
projection failure). An interceptor MUST NOT emit a
`reason` beginning with `host_error:`.

| Reason | Cause |
| --- | --- |
| `host_error:context_invalid` | The host could not construct a schema-valid `AgentContext`, or the `jcs-sha256` provider rejected its value domain (§10.2). |
| `host_error:interceptor_failed` | An interceptor raised or returned a non-JSON value. |
| `host_error:interceptor_timeout` | An interceptor exceeded the host's timeout. |
| `host_error:verdict_invalid` | An interceptor returned a value that fails §5 validation. |
| `host_error:transform_invalid` | `transform.path` did not resolve or `value` could not be set. |
| `host_error:transform_target_forbidden` | `transform.path` is not rooted at `$target`, or the interception point forbids transform. |
| `host_error:transform_conflict` | Two or more transforms against the same snapshot in a parallel profile (§7.5). |
| `host_error:composition_disagreement` | Non-unanimous outcome under `parallel/unanimous` (§7.5). |
| `host_error:approval_resolver_failed` | The resolver raised or timed out. |
| `host_error:approval_unresolved` | The resolver returned `unresolved`. |
| `host_error:approval_identity_mismatch` | The resolution's `context_identity` violated the echo rule (§9). |
| `host_error:adapter_unsupported` | The host adapter cannot emit this interception point. |
| `host_error:no_interceptor` | An `enforce`-mode emission with zero registered interceptors (§7). |
| `host_error:streaming_unsupported` | The host cannot satisfy §12 for a streaming response. |

Removed relative to earlier drafts: `host_error:approval_resolver_missing`
(a liftable deny with no resolver is simply enforced as a deny, §9) and
`host_error:approval_action_mismatch` (renamed to
`approval_identity_mismatch`).

The machine-readable inventory is `spec/reserved-reasons.json`.

---

## 12. Streaming and parallel tool calls

[Pure Specification]

### 12.1 Streaming model responses

A host that streams model output MUST assemble the complete response before
emitting `post_model_call`. A host that cannot assemble MUST emit
`post_model_call` with `response.finish_reason: "stream_incomplete"` and a
`deny` self-verdict with `host_error:streaming_unsupported`, and MUST NOT
incorporate the partial response.

Assembly that fails because the model call itself errored is an
errored model call, not this shape: there is no complete response to
evaluate, the host handles the failure as it handles any errored
action — nothing partial egresses or persists (§6.1) — and
`post_model_call` is not the vehicle for reporting the provider's
error. The `stream_incomplete` shape above is for a host that cannot
buffer the stream it received.

**Exception — incremental mediation.** A host that declares
`buffered_output: false` (§12.1a, §13.1) MAY instead evaluate the
stream incrementally, emitting `post_model_call` more than once per
response, each emission over an assembled prefix or window of it,
provided it satisfies a bounded-exposure accounting discipline:

1. no part of the response is released to the caller beyond the
   declared exposure bound ahead of a verdict covering it;
2. a `deny` terminates the stream and withholds everything not yet
   released, including content an earlier emission permitted;
3. content that no emission evaluated MUST fail closed at end of
   stream with `host_error:streaming_unsupported` rather than settle
   clean — the same failure mode as the non-assembling host above;
4. durable incorporation (§6.1) is gated by the same discipline as
   release: content withheld at termination — including content an
   earlier emission permitted but the host had not yet released — or
   that no emission evaluated MUST NOT be persisted.

Each such emission is an ordinary `post_model_call` under §4–§7; the
discipline governs what the host does with the verdicts, not the
emission contract. ACS §18.1 ("Incremental stream mediation",
[agent-control-spec](https://github.com/responsibleai/agent-control-spec))
is one implementation of such a discipline. The CTK carries a vector
part for this exception, `streaming/incremental`
(`AH-CTK-110`–`AH-CTK-113`), exercising the four items above against a
chunked mock stream (`conformance/HARNESS.md`, "Incremental
mediation"). The part is gated on the `incremental_output` capability:
a host that mediates incrementally declares it and runs the part; a
buffering host (`buffered_output: true`, the default) does not declare
it and skips, so the vectors are additive to every existing surface.
The declaration and claim remain the visible statement of the posture
(§12.1a, §13.3); the CTK still cannot exercise real streaming egress,
only the accounting discipline over mocked I/O.

### 12.1a Streaming to the caller

A host that streams output to its caller MUST buffer the stream and
MUST NOT release any part of it to the caller until the `output`
emission's combined verdict permits, UNLESS the host declares the
capability `buffered_output: false` in its conformance surface (§13.1).

For this section the *caller* is any consumer outside the host's
enforcement boundary — host-registered observers, callbacks, and
preview channels included — not only the far end of the connection.
The content released once the verdict permits MUST be the verdicted
content (the transformed value when the combined verdict is
`transform`); a host MUST NOT rewrite content between the verdict and
its release.

A host declaring `buffered_output: false` remains conformant, but a
`deny` at `output` then cannot retract content already streamed; the
declaration makes that limitation visible in the conformance claim
(§13.3) rather than leaving it implied. The CTK drives hosts with
mocked I/O and therefore cannot exercise streaming egress; this
capability is declaration-only.

A host that additionally mediates incrementally under the §12.1
exception MUST state its exposure bound in the declaration: which
content can reach the caller ahead of the verdict covering it, and how
much (e.g. "none — release is watermark-gated" or "each chunk egresses
on arrival; evaluation runs behind the stream").

### 12.2 Parallel tool calls

When a model response carries N tool calls, the host MAY invoke the
tools concurrently. The contract is per tool call, not per batch:

1. Each tool call MUST be bracketed by its own
   `pre_tool_call`/`post_tool_call` pair sharing one distinct
   `tool_call.id`; the tool MUST NOT start before its `pre_tool_call`
   composition completes and `post_tool_call` MUST NOT be emitted
   before the tool returns.
2. Emissions belonging to *different* tool calls MAY proceed
   concurrently and MAY interleave. Within a single emission the
   declared composition profile (§7) governs dispatch; a sequential
   profile's fold remains strictly sequential.
3. `sequence` values MUST be unique and totally ordered within the
   session; hosts MUST assign them atomically (they establish the
   audit order of records under concurrency).
4. Interceptors MUST tolerate concurrent invocation across emissions
   within a session. A stateful interceptor (rate limiter, budget
   counter) owns its own synchronization; the host does not serialize
   emissions on its behalf.

### 12.3 Resource bounds

[Default Implementation]

`target`, `messages`, and tool results carry untrusted model/tool
output, and each emission canonicalizes, hashes, and deep-copies them
per interceptor. Hosts SHOULD bound both dimensions before emission and
fail closed (`host_error:context_invalid`) on breach:

- **Serialized context size** — RECOMMENDED default: 5 MiB.
- **Nesting depth** — RECOMMENDED default: 128 levels. The shipped
  SDKs enforce this default on the `jcs-sha256` identity path (a
  deeper in-memory context is denied rather than overflowing the
  canonicalizer's stack; JSON-text funnels inherit the same bound from
  the parser's recursion limit).

These are operational defaults, not conformance-gated limits; a host
that declares different bounds remains conformant (the CTK cannot pin
host-tunable values). What is normative is the failure mode: breach of
whatever size or depth limit the host or the shipped core enforces
MUST yield `deny` with `host_error:context_invalid`, and MUST NOT
crash the process or silently truncate the context.

---

## 13. Conformance

### 13.1 Single level, declared surface, reported results

There are no conformance tiers, levels, or baseline profiles. A host
**declares** its surface:

- its capability subset (§3.2), including value-domain capabilities
  the CTK defines (e.g. `int64_json`: the language can observe a JSON
  integer beyond ±(2⁵³−1) without rounding — JavaScript hosts cannot)
  and the egress capability `buffered_output` (§12.1a; defaults to
  `true`, and `false` MUST be declared explicitly) with its companion
  `incremental_output` (declared by a host that mediates incrementally
  under the §12.1 exception; gates the `streaming/incremental`
  vectors),
- the composition profiles and knob values it supports (§7.2),
- its identity provider (§10.1),
- its posture where this specification permits two behaviors:
  `tool_seam_host_error: continue | terminate` (default `continue`) —
  whether a `host_error:*` deny at `pre_tool_call`/`post_tool_call`
  continues the agent loop per §6.2's continue rule or terminates the
  turn under §6.2's "unless the host's own semantics terminate the
  turn" clause. The CTK resolves posture-conditional expectations
  against this declaration, so each declared surface is tested against
  a single expected outcome.

A host is **conformant** when it passes 100% of the CTK vectors
applicable to its declaration. The CTK emits a **conformance report**
that enumerates, per declared part (each profile, each knob value, the
approval seam, the identity provider, `evaluate_only`, the fail-closed
rules of §6.3 and §7), which vectors ran and whether they passed —
so a claim communicates *what was exercised*, not a tier name.

Partial adapters under development can run vector subsets locally but
MUST NOT claim conformance. Populating optional (§4.5) fields where the
framework has the data is a SHOULD and is not conformance-gated.

### 13.2 CTK

The Conformance Test Kit under `conformance/` is the normative test of §13.1.
A host claims conformance by:

1. Implementing the `Harness` interface in at least one SDK language
   (`conformance/HARNESS.md`).
2. Declaring its surface per §13.1.
3. Passing 100% of non-skipped vectors and attaching the report.

Vectors are language-agnostic JSON under `conformance/vectors/` validated by
`conformance/vectors.schema.json`; vectors that exercise composition
carry the profile/knobs they apply to. The golden identity vectors
apply only when the declared provider is `jcs-sha256`. Per-language CTK
runners are provided under `sdk/<lang>/`.

### 13.3 Claims

A conformance claim is the tuple
`(<framework>, <adapter-version>, agent-hooks/<spec-version>, <capabilities>, <profiles>, <identity-provider>, <sdk-lang>@<sdk-version>)`
plus the CTK report, recorded in `conformance/CLAIMS.md`. A claim with
a non-default posture (§13.1) MUST state it (e.g.
`tool_seam_host_error: terminate`) — the report's passing vectors
attest that posture's outcomes, not the default's. A claim with
`identity_provider: null` MUST state that its approvals and records are
identity-unbound. A claim with `buffered_output: false` MUST state
that a `deny` at `output` cannot retract already-streamed content
(§12.1a), and, when the host mediates incrementally under the §12.1
exception, MUST state the exposure bound its accounting discipline
enforces (§12.1a) and MUST declare `incremental_output` so the
`streaming/incremental` vectors run against that discipline rather
than being skipped.

---

## 14. Security considerations

This section is informative, except that statements using RFC 2119
keywords in all capitals (§1.2) are normative. The trust boundary
itself is normative in §1.4: agent-hooks is not a security boundary,
does not sandbox, does not claim complete mediation, and conformance is
not a certification. The companion threat model with
threat→mitigation→test traceability is `docs/THREAT-MODEL.md`.


- An interceptor receives the full `target`, which may contain user PII, secrets in
  tool arguments, or model output. Hosts SHOULD redact known-sensitive fields
  before constructing `AgentContext` when the interceptor's trust level does not
  warrant raw access, and SHOULD document any redaction in
  `extensions.<host>.redacted: ["<jsonpath>", ...]` — an array of §5.2
  path strings (the same reserved shape the §9 approval redactor
  uses).
- `evidence.verification_pointers` are URIs a host MUST NOT dereference
  automatically; doing so is an SSRF vector.
- A `transform` verdict rewrites data the agent will act on. Hosts SHOULD
  authenticate interceptors and SHOULD log every applied transform with both
  `input_identity` and `enforced_identity`.
- Composition profiles change which controls observe which content. In
  `sequential/first_deny` with `on_approval: "stop"`, interceptors after
  the escalating one never run — mitigate by registering must-run
  controls first, or by choosing `sequential/run_all` or a parallel
  profile. A malicious interceptor can blind its successors via
  transform in any sequential profile; parallel profiles remove that
  vector at the cost of transform chaining.
- With `identity_provider: null`, approvals are bound only by
  request/response correlation, not content: an approval says "this
  request event", not "these bytes". Deployments whose approvers or
  auditors rely on content binding should keep `jcs-sha256` (or a
  content-derived custom provider).
- `jcs-sha256` identities are unsalted deterministic hashes of the
  required+conditional projection: anyone holding a candidate context
  can confirm whether it produced a recorded identity, and hashes of
  personal data generally remain personal data under GDPR-style
  regimes. Deployments needing non-linkable records should use a keyed
  custom provider via the §10.1 seam (see docs/THREAT-MODEL.md TM-24).
- `evaluate_only` mode MUST NOT be presented to downstream systems as
  enforcement; doing so is a compliance hazard.

---

## 15. References

- [RFC 2119] Key words for use in RFCs to Indicate Requirement Levels.
- [RFC 8174] Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words.
- [RFC 8259] The JavaScript Object Notation (JSON) Data Interchange Format.
- [RFC 3339] Date and Time on the Internet: Timestamps.
- [RFC 7493] The I-JSON Message Format.
- [RFC 8785] JSON Canonicalization Scheme (JCS).
- Agent Control Specification v0.3.1-beta.
  <https://github.com/microsoft/agent-governance-toolkit> (`agent-policy-spec/policy-engine/spec/SPECIFICATION.md`).
- AGT-SNAPSHOT-1.0 (informative; private provenance — an internal
  profile document of the Agent Governance Toolkit, cited for
  historical derivation only; no normative statement in this
  specification depends on it).
