# P-009: The required core of the agent context

- **Status:** Draft
- **Created:** 2026-10-28
- **Author(s):** Mohammad Abuomar `<40180927+MohammadHaroonAbuomar@users.noreply.github.com>` (@MohammadHaroonAbuomar)
- **PR:** https://github.com/responsibleai/agent-hooks/pull/167

See the [proposal process](README.md) for scope, lifecycle, decision
authority, and review window.

## Abstract

Every emission hands each interceptor one JSON object, the agent
context. Today the context requires seven root members at every
interception point: `spec`, `interception_point`, `timestamp`,
`sequence`, `agent` (with `id` and `framework`), `session` (with `id`)
and `target`. Four of them assume a host that runs one agent loop in one
process. Hosts at other layers of the stack (an API gateway that
mediates tool calls for many agents, a hosted agent runtime) cannot fill
them with real values, and the early adapters filled them with
placeholders.

This proposal shrinks the required core to `spec`, `interception_point`
and `timestamp`. It removes `sequence` and `target`. It makes `agent.id`
and `session.id` well-known optional members under one rule (present
when the host knows the value, never a placeholder), and it renames
`agent.framework` to `host.name` and makes it optional. `$target` stays
as the root of a transform path and resolves to the value under
evaluation at that point, so existing verdicts are unchanged. Unknown
members never fail validation. `agent.id` is a correlation label the
host asserts, never an authenticated principal. The context's own `spec`
value selects the validation and identity rules an SDK applies, so a
context tagged `agent-hooks/0.1` keeps its identity on every SDK. This
is a breaking change to the wire contract: the version moves from
`agent-hooks/0.1` to `agent-hooks/0.2` and the packages to 0.2.0, and a
host that keeps tagging 0.1 keeps working for one minor.

## The gap (Motivation)

Every time an agent does something a host mediates, the host builds one
JSON object, the agent context, and hands it to each interceptor bound
at that point: a policy engine, a security scanner, an approval flow.
The interceptor reads it and returns a verdict. The context is the whole
of what an interceptor sees, so what the specification requires in it
decides who can implement the hooks.

Today the context requires, on every hook, a per-session counter
(`sequence`), a session id, an agent id, a framework name and a copy of
the value under evaluation (`target`), next to the point's own payload.
Those members are natural for a harness, an agent framework that runs
one loop in one process, which is where the first adapters came from.
They are not natural anywhere else. An API gateway that mediates tool
calls for many agents knows the caller it authenticated, which may be a
toolbox serving several agents; it holds no session, and it cannot count
emissions when the next request lands on another instance. A hosted
agent runtime knows its session but may have no stable identifier for
the agent definition behind a run. The specification rejects a context
without the members, so the early integrations filled them in.

Three early adapters show the pattern. A hosted agent runtime's adapter
sets one fixed string for both the agent id and the framework name and
uses its run id as the session; a later form takes the agent id and
session id from the request when it names them and falls back to fixed
strings otherwise. An API gateway integration implements the two
tool-call points: it supplies the tool call, knows the authenticated
caller, and has no sequence or session to give, so any value it supplies
for them is a placeholder. The agent-framework middleware falls back to
the literal `"agent"` when an agent has no id. Each of these values
passes validation, enters the identity hash and the audit record, and
tells an interceptor nothing.

The fix is to require only what every layer can fill. A required field
that cannot be filled becomes garbage data, and garbage data in a
security control is worse than no field.

`sequence` promises a total order no host can keep: the specification
itself lets parallel tool calls interleave, a stateless gateway has no
counter, and approvals do not bind by order but by the content identity
of the context. `target` duplicates the point's payload and exists only
because the context was once an open object in which a transform needed
a fixed root; the SDK keeps the two copies in step by hand. `agent.id`
and `session.id` are real where a host has them and placeholders where
it does not, and neither is a credential. The framework name says who
emitted the context, which is a host, not a framework. And the
specification never says whether an unknown member is an error: the
schema files close the per-point payloads and call that strict
validation, while the code checks presence and type only, so an adopter
who reads the files assumes a strictness the conformance kit does not
enforce.

## Goals and non-goals

Goals:

- A required core that every layer of the stack can fill without
  inventing values: harness, runtime and gateway.
- Identity members present when the host knows them and absent
  otherwise, never a placeholder, and never a basis for an authorization
  decision.
- One rule for unknown members, stated in the spec and matched by the
  schemas, the SDKs and the conformance kit.
- One copy of the value under evaluation. Today a second copy (`target`)
  gives a transform a fixed place to write; the goal is that a transform
  writes into the point's own payload.
- The conditional shapes of `input`, `pre_model_call`,
  `post_model_call`, `pre_tool_call`, `post_tool_call`, `output` and
  `agent_shutdown` unchanged.

Non-goals:

- The shape of `messages` at `pre_model_call`. That is P-010 (proposed
  in #168).
- A rework of `agent_startup` and `agent_shutdown` as hooks. A later
  proposal may take that up; this one changes only whether
  `tools_registered` is required.
- `tenant.id`. It is an optional well-known field today (§4.5), not part
  of the required core, and stays as it is: the value belongs to the
  request's authentication context, and a copy in the hook context would
  need rules for when the two disagree.
- Remote hooks: how a caller's identity or token reaches an interceptor
  in another process. That belongs with the authentication context, not
  this envelope, and is a separate proposal.
- The trust model of §1.4. The host stays inside the trust boundary and
  interceptors stay fully trusted by the host; this proposal narrows
  what the host must assert, not whom the contract trusts.
- The verdict shape, composition, the approval seam, the declaration
  contract (`agent-hooks-declaration/1.1` is unchanged) and the
  conformance claim tuple (§13.3).

## Specification

### Recommended normative semantics

The sections below are the proposed text, condensed. Section numbers
refer to `spec/draft/AGENT-HOOKS-0.1.md` as it stands. Quoted text is proposed
normative text; everything else is explanation.

#### 1. The required core (§4.1)

A context carries three members at every interception point:

```jsonc
// proposed
{
  "spec": "agent-hooks/0.2",
  "interception_point": "<one of §3>",
  "timestamp": "2026-06-19T14:03:11.123Z"
}
```

The `interception_point` and `timestamp` rows of the §4.1 table are
unchanged. The `sequence`, `agent.id`, `agent.framework`, `session.id`
and `target` rows are removed. The `spec` row gains:

> The value selects the validation and identity rules the host and the
> SDK apply (§10.2). An SDK that does not implement the rules of the
> given version MUST refuse the emission as
> `host_error:context_invalid`, naming the version, and MUST NOT
> convert a context from one version to another. A host that wants to
> convert does so before it emits.

The proposal reuses `context_invalid` rather than add a reason, because
§11 reserves nothing for an unsupported context version:
`adapter_unsupported` and `streaming_unsupported` do not fit, and
`declaration_error:spec_unsupported` belongs to the declaration loader.

#### 2. Conditional members (§4.2)

The payloads of `input`, `pre_model_call`, `post_model_call`,
`pre_tool_call`, `post_tool_call`, `output` and `agent_shutdown` are
unchanged. The sentence "`target` MUST be set to the indicated value"
and every `"target": <...>` line in the eight examples are deleted. At
`agent_startup`, `agent_init` stays REQUIRED and `tools_registered`
becomes OPTIONAL inside it:

> `tools_registered` lists the tool names the host knows at startup.
> It is not exhaustive: tools discovered later arrive at the tool
> points. A host with no registry at startup omits the member.

#### 3. Well-known optional identity members (§4.5)

The §4.5 table gains four rows. The existing `agent.name`,
`agent.version`, `session.started_at` and `session.turn` rows stand.

| Field | Interception point(s) | Type |
| --- | --- | --- |
| `host.name` | all | string matching `^[a-z0-9_-]+$` |
| `host.version` | all | string |
| `agent.id` | all | non-empty string, stable across sessions |
| `session.id` | all | non-empty string, stable across all hooks of one session |

`host.name` names the software that emits the context (the host of §2),
whether a framework, a runtime or a gateway; it replaces
`agent.framework`. `agent.id` is the host's stable identifier for the
agent definition; the host sets it from its own knowledge, never from
content the agent produced, and it is a correlation label, not an
authenticated principal. One rule governs them:

> A host MUST omit an optional identity member (`host.*`, `agent.*`,
> `session.*`, `actor.*`, `tenant.*`) whose value it does not have,
> and MUST NOT fill a placeholder. An interceptor MUST NOT fail a
> context for an absent optional member, and treats a present one as
> the host's assertion under §1.4, not as a verified claim and never
> as the principal for an authorization decision; that principal is
> the identity the transport authenticated, outside the context.

In §7.7.3 of the declaration contract, "`host.name` follows the
`agent.framework` grammar (§4.1)" becomes "`host.name` follows the
grammar of the context's `host.name` (§4.5)". §4.5 states the grammar
once, so the declaration document and the context cannot drift.

#### 4. Unknown members (§4)

After the tier list in §4:

> A host MAY include members this specification does not define, at
> the root and inside any object this specification defines. Unknown
> members never fail validation. Conformance checks the presence and
> JSON type of the required and conditional members and nothing else;
> a validator MUST NOT reject a context for a member it does not know.
> Namespaced extensions (§4.6) remain the place for structured host
> data; an unknown member outside `extensions` is tolerated, not
> interpreted.

The `host_error:context_invalid` row of §11 reads: "The host could not
construct a context with the required and conditional members present
and of the right JSON type, or the `jcs-sha256` provider rejected its
value domain (§10.2). An unknown member is never this error."

#### 5. The target and transforms (§4.3, §5.2, §11)

§4.3 is replaced:

> The target of an interception point is the slice of the context the
> §3 table names: `agent_init` at `agent_startup`, `input` at `input`,
> `messages` at `pre_model_call`, `response` at `post_model_call`,
> `tool_call.args` at `pre_tool_call`, `tool_result.value` at
> `post_tool_call`, `output` at `output`, `summary` at
> `agent_shutdown`. It is the only value a `transform` verdict may
> rewrite. The context carries no separate `target` member. `$target`
> in a `transform.path` (§5.2) denotes the target of the context's
> interception point and resolves to that slice. A host MUST apply a
> transform to the slice so that the guarded action observes the
> rewritten value. A `transform` verdict at `agent_startup` or
> `agent_shutdown` MUST be rejected with
> `host_error:transform_target_forbidden` (§11).

The §5.2 grammar is unchanged; "`path` MUST be rooted at `$target`"
gains "which denotes the §4.3 target of the context's interception
point". The `host_error:transform_target_forbidden` row of §11 is
unchanged. The `$policy_target` alias of §5.2 keeps its scheduled
removal in 0.3 unless the decision list folds it into this change.

#### 6. Identity (§10.2)

The root members of the `jcs-sha256` projection `ctx_rc` become `spec`,
`interception_point` and `timestamp`; `agent.{id,framework}`,
`session.{id}` and `target` leave the list; the per-point allowlists are
unchanged. Two paragraphs are added:

> A listed member that is absent from the context is absent from the
> projection; `tools_registered` is projected when present.

> The context's `spec` selects the projection. A context tagged
> `agent-hooks/0.1` is projected under the 0.1 list, with `sequence`,
> `agent.{id,framework}`, `session.{id}` and `target`; a context
> tagged `agent-hooks/0.2` under the list above. A provider never
> converts a context from one version to another.

Optional members stay out of the projection, `agent.id` included.

#### 7. The record (§10.3)

The record gains `spec`. The schema marks it OPTIONAL so that older
records stay valid; a host of this revision writes it on every record.
Its text: "The context's `spec`, copied verbatim; names the rules that
produced `input_identity` and `enforced_identity`." `sequence` is
removed from the example and the table. `session_id` becomes OPTIONAL:
"The context's `session.id`, copied verbatim; absent when the context
carried none." The sentence "records are totally ordered within a
session" goes. In the host projection failure paragraph, the two
sentences on consuming the next sequence number go; `session_id` is
present when the host knows it and absent otherwise, and the `""`/`-1`
sentinels (the record's unknown values today) go. `decided_by`,
`verdicts`, `composition` and the identities are unchanged, so
attribution and tamper evidence are as they were.

#### 8. Ordering (§3.1, §12.2)

Rule 6 of §3.1 is deleted; rules 1 to 5 stand. Rule 3 of §12.2 is
replaced:

> This specification defines no order across emissions. A record
> carries the context's `timestamp` and, when the host supplies it,
> `trace` (§4.5); a host that needs an order across concurrent
> emissions keeps it in its own extension namespace.

#### 9. Security considerations (§14)

One bullet is added: `agent.id` and `session.id` are correlation labels
under the §4.5 rule, bound to no token, and a policy that keys on one of
them for correlation fails closed when it is absent rather than binding
to a default.

#### 10. Who does what

The host fills the three required members and the point's payload, adds
`host`, `agent`, `session` and `trace` when it has them, applies a
transform to the slice the §3 table names, and tags each context with
the `spec` whose rules it followed. The interceptor evaluates the
point's payload, addresses a transform at `$target`, reads `agent.id`
when present as a label, and never fails a context for an unknown or an
absent optional member. The identity provider projects under the rules
the context's `spec` names. The SDK validates under those rules, refuses
a version it does not implement, and never converts.

### Schema and wire impact

The JSON Schemas under `spec/draft/schema/generated/` are generated from the TypeScript
source under `spec/draft/schema/src/` by
`sdk/typescript/scripts/generate-schemas.mts` (`npm run
generate:schema`); the `schema-drift` workflow regenerates them and the
vendored copies under `sdk/python/python/agent_hooks/schema/`.

- `spec/draft/schema/src/agent-context.ts`: `ContextBase` loses `sequence` and
  `target`, its `agent` and `session` members become optional with
  optional `id`, and it gains `host` with `name` and `version`;
  `AgentInit.tools_registered` becomes optional. The eight per-point
  variants keep their payloads. The generated
  `spec/draft/schema/generated/agent-context.schema.json` (an `anyOf` over the eight
  variants) and the eight files under `spec/draft/schema/generated/strict-contexts/`
  follow.
- `sdk/typescript/scripts/generate-schemas.mts`: step 5, which derives
  the per-point files, stops setting `additionalProperties: false` on
  the payload objects a point requires (line 183), and the per-point
  description stops claiming strict validation (line 193). The preimage
  allowlist in the Rust core, the list of members the identity hash
  covers, is the only closed inventory, and §10.2 says so.
- `spec/draft/schema/src/interception-record.ts`: `sequence` removed,
  `session_id` optional, `spec` added as an optional string matching
  `^agent-hooks/\d+\.\d+$`; the generated
  `spec/draft/schema/generated/interception-record.schema.json` follows and its
  description drops "ordering".
- `spec/draft/reserved-reasons.json`: the text of the `context_invalid` entry
  only.
- `spec/draft/schema/path-grammar.abnf`: unchanged.
- `conformance/golden/identity.json` and
  `conformance/vectors.schema.json`: see Conformance and tests.
- `docs/THREAT-MODEL.md` (the "Interception records" row),
  `docs/IMPLEMENTING.md:177`, `conformance/HARNESS.md:17` and `:386` and
  `conformance/RUNNER.md` follow the spec text.

Two rules need SDK validation rather than JSON Schema: the selection of
the rules by the context's `spec` with the refusal of an unknown
version, and the omit-never-fill rule, which no schema can test and
which per-SDK tests pin on the builders.

Three wire examples show the same `pre_tool_call` emission: today, from
an agent framework under 0.2, and from a gateway under 0.2.

```jsonc
// today
{
  "spec": "agent-hooks/0.1",
  "interception_point": "pre_tool_call",
  "timestamp": "2026-06-19T14:03:11.123Z",
  "sequence": 7,
  "agent": { "id": "agent", "framework": "agent-framework" },
  "session": { "id": "3f9c…" },
  "tool_call": { "id": "call_1", "name": "issue_refund", "args": { "amount": 75 } },
  "target": { "amount": 75 }
}
```

```jsonc
// proposed, from an agent framework
{
  "spec": "agent-hooks/0.2",
  "interception_point": "pre_tool_call",
  "timestamp": "2026-06-19T14:03:11.123Z",
  "host": { "name": "agent-framework" },
  "agent": { "id": "refund-assistant" },
  "session": { "id": "3f9c…" },
  "tool_call": { "id": "call_1", "name": "issue_refund", "args": { "amount": 75 } }
}
```

```jsonc
// proposed, from a gateway
{
  "spec": "agent-hooks/0.2",
  "interception_point": "pre_tool_call",
  "timestamp": "2026-06-19T14:03:11.123Z",
  "host": { "name": "api-gateway" },
  "tool_call": { "id": "call_1", "name": "issue_refund", "args": { "amount": 75 } }
}
```

## Rationale

### What each member does today

Two public adopters appear in the table. agent-control-spec
(https://github.com/responsibleai/agent-control-spec) is a policy
runtime; its Cedar policies (Cedar is its policy language) take their
principal, the actor a decision is about, from the context.
agent-framework (https://github.com/microsoft/agent-framework) builds
contexts through the Python and .NET SDKs from its middleware. "The
builders" are the five per-session context builders:
`sdk/rust/core/src/builder.rs:59-98`,
`sdk/python/python/agent_hooks/context.py:44-76`,
`sdk/typescript/src/builder.ts:19-44`,
`sdk/dotnet/src/AgentHooks/AgentContextBuilder.cs:58-60` and
`sdk/go/agenthooks/builder.go:28-77`. The core denies an emission that
lacks any required member as `host_error:context_invalid`
(`sdk/rust/core/src/canonical.rs:320-383`).

| Member | 0.1 rule | Written by | Read by |
| --- | --- | --- | --- |
| `sequence` | Integer, strictly increasing within `session.id`, 0 at `agent_startup` (§3.1 rule 6, §4.1, §12.2 rule 3) | The builders; a hosted runtime's adapter keeps an atomic counter to feed it | The record copy (`sdk/rust/core/src/enforce.rs:196-202` and `:276-277`), the conformance kit's (CTK) monotonic check (`sdk/rust/core/src/ctk_engine.rs:678-689`, run for every vector at `:738`), vectors AH-CTK-001 and AH-CTK-003, six assertion lines in agent-framework's `tests/core/test_agent_hooks.py`. No interceptor. |
| `session.id` | Non-empty string, stable across all hooks of one session | The builders | The record copy, the same agent-framework tests. No interceptor. |
| `agent.id` | Non-empty string, stable across sessions of one agent definition | The builders | agent-control-spec: the Cedar principal (`engine/src/cedar.rs:90-98` and `:165-184`) and the remote-policy scope check (`sdk/remote-policy/python/agent_control_spec_remote_policy/integration.py:73-77`). |
| `agent.framework` | Lowercase host identifier, `^[a-z0-9_-]+$` | The builders | No reader beyond the envelope grammar check (`canonical.rs:362-370`). The declaration document names the host as `host.name` under the same grammar (§7.7.3). |
| `target` | The §3 slice, root of `$target` (§4.3, §5.2) | The builders | The core's transform application (`enforce.rs:52-65`), which rewrites `target` and then mirrors the value into the per-point member by hand (`write_back_target`, `:299-325`), and `EmitOutcome.target` (`sdk/rust/core/src/emitter.rs:943`); agent-framework reads `outcome.target` at six write-back sites. agent-control-spec reads the context by path (`$.tool_call.args`, `engine/src/runtime.rs:313-319`) and never reads `target`. |

The preimage of the default identity provider is an allowlist that
mirrors the required core and the per-point payloads
(`sdk/rust/core/src/canonical.rs:140-148` and `conditional_for`). The
record copies `session.id` and `sequence`, with `""` and `-1` as the
unknown values, and requires both
(`spec/draft/schema/src/interception-record.ts:106-108`, generated into
`spec/draft/schema/generated/interception-record.schema.json` with
`additionalProperties: false` at the root).

On unknown members the files and the code disagree. The generator
derives the eight per-point schemas from the variants in
`spec/draft/schema/src/agent-context.ts` and sets `additionalProperties:
false` on the payload objects each point requires: `tool_call`,
`tool_result`, `model`, `response`, `input`, `output`, `agent_init` and
`summary` (`generate-schemas.mts:163-193`). The files describe
themselves as "used by the CTK for strict validation". No runner
validates against them: all five runners delegate assertion to the
engine in the Rust core (`ctk_assert`), which checks presence and JSON
type through `validate_envelope`
(`sdk/rust/core/src/ctk_engine.rs:267`), and the Python package's loader
for those schemas (`sdk/python/python/agent_hooks/ctk/_schemas.py`) has
no importer.

The core also accepts any well-formed `agent-hooks/<major>.<minor>`
string and applies the 0.1 rules to all of them
(`canonical.rs:327-341`); nothing compares the context's `spec` to the
SDK's own version. The declaration loader accepts a document whose
`spec` minor is at most its own
(`sdk/rust/core/src/declaration.rs:1329-1333`).

### Options considered

Four tests apply to each design: can every host fill it without
inventing values, what can an interceptor rely on, what does it cost in
versions, and how much work is it.

#### A. Keep the current contract

Keep the seven members required.

| Advantages | Costs and risks |
| --- | --- |
| Nothing moves. The 18 golden identities (the pinned identity fixtures every SDK must reproduce) and the record shape stay as they are; no adapter changes. | Placeholders stay the steady state, as the early adapters show, because the schema rejects an absent member. `sequence` states a guarantee that §12.2 concurrency and a stateless host cannot keep. `target` needs a mirror rule in every SDK. |

#### B. Make every discussed member optional

Keep `sequence`, `session`, `agent.id`, `agent.framework` and `target`
in the schema, each OPTIONAL. Nothing is removed. The record keeps its
shape and writes its unknown sentinels when a member is absent.

| Advantages | Costs and risks |
| --- | --- |
| Every 0.1 context stays valid. The builders need no change. Record consumers see the same keys. | The change is still spec MAJOR, because the required set changes. `sequence` becomes a dead field with `-1` as a gateway's normal value. `target` keeps two code paths in every SDK. Optional members go unfilled. |

#### C. A three-member core with optional identity members

The required core becomes `spec`, `interception_point` and `timestamp`.
`host.name`, `agent.id` and `session.id` join the well-known optional
members under one rule: present when the host has the value, absent
otherwise, never a placeholder. `target` leaves the context; `$target`
stays as the root of a transform path and denotes the §3 slice. The
per-point conditional members are the contract and the identity
preimage.

| Advantages | Costs and risks |
| --- | --- |
| Every host can fill the core. An interceptor relies on the per-point payload, which is what it evaluates. The transform root is unchanged for every existing verdict. The removed members are the ones nothing in the tree reads. | A host that moves to 0.2 sees its `jcs-sha256` identities change once. The record loses `sequence`. An interceptor that read `ctx.target` directly must read the slice instead. Two filed claims are re-run. |

#### D. Remove all five, `agent.id` included

The context carries no agent identity at all; correlation and
authorization both come from the transport.

| Advantages | Costs and risks |
| --- | --- |
| Nothing in the context can be mistaken for a verified identity. The gateway case is the simplest. | A harness that knows the agent definition, or the sub-agent under it, has no standard place to say so. agent-control-spec selects policy and builds its Cedar principal from `agent.id`; both would move to extensions or the transport. The member costs nothing when absent. |

### Recommendation (for discussion)

Option C. Its one real cost is that a host's identities change once when
it moves to 0.2. B pays the same cost, because optional members leave
the projection by rule. Keeping them in the projection when present
would make two hosts that emit the same tool call hash differently,
depending on which placeholders they filled; the identity would then
measure the adapter, not the content. B also keeps dead members with
defaults a host will reach for: removal is the honest statement for the
members that carry a guarantee (`sequence`, `target`), and optional
status fits only members whose absence costs nothing (`agent.id`,
`session.id`, the host name). D gives up sub-agent correlation for no
gain over C, since C already denies `agent.id` any authorization role;
the remote identity proposal may revisit D once a verifiable caller
identity exists.

Five points inside C have more than one defensible answer:

- `session.id` stays as a well-known optional member; it is not deleted.
  Keeping it costs nothing: the `session` object already lives in §4.5
  with `started_at` and `turn`, the record keeps a correlation key for
  hosts that have one, and nothing in the contract depends on it.
  Deletion is one member fewer and removes the temptation to invent a
  session where the host has none, which one early adapter did. The
  decision list keeps this point open.
- The host identifier is `host.name`, with an optional `host.version`
  and the grammar `^[a-z0-9_-]+$` unchanged, so `agent-framework`,
  `reference-agent` and `agent-control-spec-reference-host` remain valid
  values. "Host" is this specification's own word for the party that
  emits a context (§2), the declaration document already carries
  `host.name` under the same grammar (§7.7.3), and the claim tuple's
  first member names the same thing. `client.name`, the analogy with
  MCP's (the Model Context Protocol's) `clientInfo.name`, is familiar
  but names a party the specification already has a word for.
  `caller.id` is wrong at a gateway, where the authenticated caller is
  the party the gateway serves, not the gateway; that is the confusion
  that made `agent.id` hard to fill.
- `agent.id` is optional. Subsection 3 above and the §14 bullet settle
  its authorization role; one early integration already takes the agent
  identity from the token it verified rather than from the context. What
  remains is correlation: sub-agent tracking, per-agent policy selection
  inside a trusted host, approval context. Required turns the member
  into a placeholder at a gateway. Removal is option D. Optional under
  subsection 3 serves both sides: a harness that knows the agent says
  so, a gateway says nothing, and a policy that keys on the label fails
  closed on absence. The member stays out of the `jcs-sha256` projection
  like every optional member; hashing it when present would add little,
  since approvals bind in-process per emission, and hosts rely on
  optional data never changing the identity.
- `agent_init.tools_registered` is optional and documented as not
  exhaustive. The list a host enforces against at run time is the
  per-call `tools` member at `pre_model_call` (§4.5) and the `tool_call`
  payload at the tool points; tools now arrive at run time through MCP
  servers and plugins, so a static list at startup is advisory. Removing
  it takes away a member policies key on; requiring it makes a startup
  emission fail for a host that has no registry at that moment.
  Extensions carry richer catalogue data.
- `$target` stays as the symbolic root that resolves to the §3 slice.
  Every existing verdict, every vector and agent-control-spec's policy
  output already use it; a context-rooted path (`$.tool_call.args.url`)
  with a per-point allowlist of writable members would widen what a
  transform may touch and change the §5.2 grammar for no gain.

Open decisions:

- [ ] Adopt option C: required core `spec`, `interception_point`,
      `timestamp`; `sequence` and `target` removed; `agent.id` and the
      host identifier optional; the omit-never-fill rule; the
      unknown-member rule with the schema closure removed.
- [ ] `session.id`: keep as a well-known optional member (recommended)
      or delete the member.
- [ ] Host identifier: `host.name` with optional `host.version`, grammar
      `^[a-z0-9_-]+$` unchanged (recommended); alternatives
      `client.name`, `caller.id`.
- [ ] `agent.id`: keep it as an optional correlation label
      (recommended), or drop it and rely on the transport identity
      alone. It stays out of the `jcs-sha256` preimage either way
      (alternative: project it when present).
- [ ] `agent_init.tools_registered`: optional and documented as not
      exhaustive (recommended); alternatives: keep required, remove.
- [ ] `$target` stays as the symbolic root resolved to the §3 slice
      (recommended); alternative: context-rooted paths with an
      allowlist. Separately: fold the scheduled `$policy_target` alias
      removal into 0.2, or keep it for 0.3.
- [ ] Version: wire `agent-hooks/0.2`, label `spec:breaking`, package
      0.2.0, one sentence in `VERSIONING.md` on pre-1.0 numbering
      (recommended); alternative: change the shape under the
      `agent-hooks/0.1` string.
- [ ] Identity rules keyed by the context's `spec`: a 0.1-tagged context
      is hashed under the 0.1 rules by an SDK that accepts it and
      refused as `host_error:context_invalid` by one that does not; no
      silent conversion; the 0.2 SDKs accept 0.1 contexts for one minor;
      the record gains an OPTIONAL `spec` member.
- [ ] SDK compatibility: builder and .NET record constructors kept as
      forwarding overloads without deprecation diagnostics; the SDK
      drops a root `target` member from a 0.2-tagged context on the way
      in for one minor; `EmitOutcome.target` kept; `target_of` accessor
      added.
- [ ] agent-control-spec: fail closed on an absent Cedar principal
      (current behaviour) with or without a configured fallback
      principal, and whether its remote-policy path takes the principal
      from the transport identity rather than from `agent.id`; both
      decisions are theirs and precede their claim re-run.

Remaining risks:

- Optional members go unfilled. We accept that for `host`, `agent` and
  `session`, because nothing in the contract depends on them; a
  per-agent policy fails closed on absence, which is visible. The
  omit-never-fill rule and the removal of the adapter literals keep an
  absent member from turning into a placeholder.
- Records lose an in-session order. Within one host process timestamps
  are monotonic enough for audit, and across hosts no order was ever
  real; the Performance section says what consumers sort by instead.
- A third-party interceptor that read `ctx.target` breaks. The
  `target_of` accessor, the dropped root `target` on the way in, and the
  CHANGELOG entry make the break visible.
- The 0.2 bump lands while 0.1.0 final has not shipped, so the 0.1.0
  pre-release line ends at its last beta. The alternative, shipping
  0.1.0 with the old shape first, would publish a required core this
  proposal argues against.

### Related decisions

This proposal is one step in a larger change. The context stops being
one open object with a `target` slice pointing into it. It becomes a
small common envelope on every hook plus a typed payload per
interception point, so a host projects its native objects into a known
shape. This proposal settles the envelope: which members every context
carries, which are optional, and how unknown members are treated. The
per-point payloads come in their own proposals, the model request shape
first as P-010 (#168); the tool-call, tool-result, input, output and
model-response payloads are already close to the typed shape and are not
changed here.

P-004 made the identity provider a pluggable seam with `jcs-sha256` as
the default and fixed the closed required-plus-conditional preimage,
from which it follows that optional data never changes the identity.
`VERSIONING.md` classes a change to the required or conditional context
fields as spec MAJOR. PR #169 proposes a versioned layout for the
specification text; this proposal follows whatever it settles (see
Backward compatibility).

## Security and privacy

The trust boundary of §1.4 is unchanged: the host stays inside it, and
registered interceptors stay fully trusted by the host. What changes is
what the host asserts. The §4.5 rule and the §14 bullet deny `agent.id`
and `session.id` any authorization role. The evidence that this is
workable is agent-control-spec, which already fails closed on an absent
Cedar principal and rejects an unknown `agent.id` (the member table
above).

The omit-never-fill rule is the control against placeholder principals.
A host that cannot name the agent omits the member; it never writes a
fixed string. Absence is visible to a policy; filler is not. The
conformance kit cannot test what a production host knows, so the rule
lives where a test can reach it: the adapters that fill literals today
drop them, the SDK builders accept an absent agent and session, and
per-SDK tests pin that an absent agent id produces no `agent` member.

Content binding does not weaken. `target` leaves the preimage, but the
slice it duplicated (`tool_call.args`, `tool_result.value`, `messages`,
`response`, `input`, `output`) is on the allowlist already, so an
approval still binds to the bytes the approver saw. `sequence` and
`session.id` leave the preimage, so two emissions with the same payload
and the same `timestamp` in different sessions produce the same
identity; the identity measures content, which is what §9 and §10 ask of
it, and the linkability property of unsalted hashes (§14, P-004) is
unchanged in kind. Approvals bind inside one emission, so no binding
crosses the version change.

Fail-closed behaviour is unchanged. An invalid envelope is still denied
as `host_error:context_invalid` before any interceptor runs. The reason
now never means an unknown member; it does mean a `spec` version the SDK
does not implement, so an unknown version cannot pass under rules meant
for another. Unknown members pass through to interceptors verbatim,
which is what §4.6 already does for extensions; an interceptor that
wants structured host data looks under `extensions`.

The record stays payload-free. The new `spec` member is one string from
a closed grammar, and `session_id` is the identifier the record already
carried. Dropping `sequence` removes an ordering key, not content.

Residual risks: an interceptor that keys authorization on `agent.id`
despite §14 is only as sound as the host that asserted it, and
agent-control-spec's remote-policy path is the known case to move to the
transport identity. A host that tags 0.2 but still writes `target`
leaves a stale copy an interceptor could misread; the one-minor drop
rule under Mixed contexts answers that. Report actual vulnerabilities
privately per [SECURITY.md](../../SECURITY.md), not in this proposal.

## Backward compatibility

### Classification

The change is spec MAJOR under `VERSIONING.md` ("MAJOR =
required/conditional field change") and under the proposals README; so
is option B, because making a required member optional changes the
required set, and a 0.1 interceptor may read the member unconditionally.
The wire version is `MAJOR.MINOR` with no third component and the spec
is at `0.1`, so before 1.0 a MAJOR-class change moves the MINOR digit:
`agent-hooks/0.1` becomes `agent-hooks/0.2`. The deciding PR carries the
label `spec:breaking`, and the package version moves from the 0.1.0
pre-release line to 0.2.0 under the SDK rule, "MAJOR on spec MAJOR",
read the same way. One sentence in `VERSIONING.md` writes the convention
down: while MAJOR is 0, a MAJOR-class change bumps MINOR and 0.x minors
are not compatible with each other. The declaration contract stays
`agent-hooks-declaration/1.1`. The alternative, changing the shape under
the `agent-hooks/0.1` string, fails: the identities and the record shape
change, so a reader of a record or a context must be able to tell which
rules applied, and the `spec` string is the only signal it has.

### Where the 0.2 text lives

The specification now lives in versioned bundles (#169): `spec/0.1.0/`
is the released copy and stays unchanged, and `spec/draft/` is where
normative work happens. The deciding PR therefore writes the 0.2 text
into `spec/draft/AGENT-HOOKS-0.1.md` and its schemas, bumps the header
to 0.2 and adds the `CHANGELOG.md` entry, under `spec:breaking`. That
meets the change-class workflow (`.github/workflows/change-class.yml`),
which requires a `spec:breaking` PR to change a version surface in the
same PR: a path matching `spec/<folder>/AGENT-HOOKS`, an SDK manifest,
or `CHANGELOG.md`. The 0.2 bundle is cut from the draft when it is
published; the released 0.1.0 folder is not edited.

### Hosts

A 0.2 host follows subsection 10 of the Specification. A 0.1 host that
keeps emitting 0.1-tagged contexts loses nothing for one minor: the 0.2
SDKs accept its contexts for that long under the 0.1 rules. After that,
an SDK that has dropped the 0.1 rules refuses them (subsection 1).
Declaration documents at 0.1 keep loading, since the loader already
accepts a lower minor.

### Interceptors

An interceptor evaluates the point's payload, which is the same object
it evaluated before, and addresses a transform at `$target` as before.
It can no longer rely on `sequence`, `session.id`, `agent.id`,
`agent.framework` or `target` being present; under B it would have to
handle their absence anyway. An interceptor that read `ctx.target`
directly reads the slice instead, through the `target_of` accessor each
SDK gains.

### Identities

A context tagged `agent-hooks/0.1` keeps its identity on every SDK that
accepts it; a host sees its identities change once, when it starts
tagging 0.2, and the CHANGELOG headline says so. No existing golden
identity changes (see Conformance and tests).

### Records

The record of a 0.1-tagged emission has the SDK's 0.2 shape. A consumer
that validates against the 0.1 record schema, which requires `sequence`
and `session_id`, rejects 0.2 records until it takes the 0.2 schema; the
new `spec` member tells it which rules produced the identities a record
carries.

### Mixed contexts

For a 0.2-tagged context, the members a half-migrated host still sends
(`sequence`, `target`, `agent.framework`) are unknown members: passed
through to interceptors, kept out of the preimage, not copied to the
record. A `session` object stays a known optional member, and its `id`
is copied to the record. One exception: the SDK drops a root `target`
member from a 0.2-tagged context on the way in for one minor, with a
CHANGELOG note, because it is the member the SDK's own builder used to
write, and a stale copy next to the rewritten slice would mislead a host
that reads it after `emit` instead of `outcome.target`. The SDK does not
synthesize `sequence` or `session.id` so that an old interceptor keeps
seeing them: that is the placeholder problem moved inside the SDK.

### Builders and record types

The five builders keep their `(agent_id, framework, session_id)`
constructors as forwarding overloads without a deprecation diagnostic,
because agent-control-spec builds with clippy `-D warnings` and the
agent-framework .NET package with `TreatWarningsAsErrors`, so a
diagnostic is a break for both. The overloads map `framework` to
`host.name`, write `agent.id` and `session.id` as optional members when
given, and stop writing `sequence` and `target`; a new constructor takes
the host name alone. `EmitOutcome.target` stays and is computed from the
slice, so agent-framework's six write-back sites and any host written to
the documented pattern keep working. The .NET record keeps its previous
positional constructor as a forwarding overload and
`PublicApi.approved.txt` changes on purpose: the 0.1.0-beta.3 entry in
`CHANGELOG.md` records the `MissingMethodException` a published
dependent package hit the last time optional parameters replaced a
record constructor.

### Claims

The two filed claim rows in `conformance/CLAIMS.md`, agent-control-spec
at 46 of 73 on the 0.1.0-beta.2 corpus and agent-framework at 47 of 51
on `python@0.1.0a5`, stay as filed, because they are true for the SDK
versions they cite, and gain 0.2 rows when each adopter re-runs. The
claim tuple is unchanged.

### Rollout

The deciding PR carries the specification text, the schema source and
generated schemas, the golden file, the `VERSIONING.md` sentence, the
`CHANGELOG.md` entry and the Rust core change, so `main` never holds a
published specification its own core does not implement. The four
wrapper SDKs and the conformance runners build on the core and follow in
the same release, with the conformance kit changes, the docs, and the
record and builder compatibility overloads. Until the 0.2 text is
published, the published specification is unchanged. Downstream, in
dependency order: agent-control-spec re-vendors the corpus, decides the
Cedar fallback and re-runs its claim; agent-framework drops the
`"agent"` literal in both middlewares, updates its tests and re-runs its
claim; the hosted runtime adapter targets the 0.2 shape when it lands
its hooks; the gateway integration drops any invented members.

## Performance and operational impact

No emission does more work. The preimage shrinks by four members, the
SDK stops mirroring `target` into the per-point member, and the record
drops one integer. None of this is measured; the identity and emission
benchmarks in `sdk/rust/core/benches/emission.rs` cover it when the
change lands.

Operators lose the in-session `sequence` on records and gain `spec`.
Audit pipelines and security information and event management (SIEM)
tools that sorted records by `sequence` sort by `timestamp` and `trace`
instead (W3C Trace Context identifiers, §4.5; see subsection 8). The
`spec` member tells a pipeline which rules produced the identities on
each record, so it can tell 0.1 records from 0.2 records in a mixed
fleet.

## SDK surface and implementation impact

### Rust core and FFI

The members live in the builder, the envelope check and preimage, the
transform application and record copy, and the conformance engine, all
cited under What each member does today, plus the host-failure basis
(`sdk/rust/core/src/emitter.rs:1057-1061`) and the record struct
(`sdk/rust/core/src/types.rs:551-555`). The core gains the version-keyed
rule selection and keeps the 0.1 rules for one minor. The FFI crate
(`sdk/rust/ffi/src/lib.rs`) carries no member logic; the wrappers
inherit `validate_envelope` through
`sdk/rust/core/src/ffi_surface.rs:514-517`. Sequencing is under Rollout.

### Wrapper SDKs

- Python: the builder (`context.py`, cited above), the record type
  (`sdk/python/python/agent_hooks/_types.py:649-651`, `:705-706` and
  `:735-736`) and the emitter
  (`sdk/python/python/agent_hooks/emitter.py:253-266`, `:809` and
  `:874-915`); the vendored schema copies are regenerated by the
  schema-drift job.
- TypeScript: the builder (`builder.ts`, cited above), the context and
  record types (`sdk/typescript/src/index.ts:332-334` and `:374-377`),
  the emitter (`sdk/typescript/src/emitter.ts:295-300` and `:906-907`)
  and the reference harness
  (`sdk/typescript/src/ctk/reference.ts:89-90`).
- .NET: the builder (`AgentContextBuilder.cs`, cited above), the record
  type (`sdk/dotnet/src/AgentHooks/Types.cs:629-630`, `:699-700` and
  `:728-729`), the emitter
  (`sdk/dotnet/src/AgentHooks/InterceptionEmitter.cs:722-723` and
  `:1386`), the reference harness
  (`sdk/dotnet/src/AgentHooks.Conformance/ReferenceHarness.cs:166`) and
  `PublicApi.approved.txt`.
- Go: the builder (`builder.go`, cited above), the record type
  (`sdk/go/agenthooks/types.go:532-535`), the emitter
  (`sdk/go/agenthooks/emitter.go:754-757`) and the reference harness
  (`sdk/go/conformance/reference.go:106-108`).

Files that name the members, source and tests together: Rust 10, Python
14, TypeScript 4, .NET 10, Go 5. Each SDK makes the builder and record
changes under Builders and record types, refuses a `spec` version it
does not implement, and moves its spec version constant to
`agent-hooks/0.2`. The reference harnesses in all five SDKs build
contexts through the builders and need only the constructor mapping.

### agent-framework

The Python middleware
(`python/packages/core/agent_framework/_agent_hooks.py`) builds
`AgentContextBuilder(agent_id=<id or name or "agent">,
framework="agent-framework", session_id=uuid4().hex)` per run (`:157`,
`:1030-1037`) and reads `outcome.target` at six write-back sites. The
literal `"agent"` goes (omit when the agent has no id), the `framework`
keyword maps to `host.name` inside the SDK, the session id stays as an
optional member, and the write-backs are untouched. Six assertion lines
in `python/packages/core/tests/core/test_agent_hooks.py` assert on
`record.sequence` or `record.session_id` and change; the tests added by
the declaration-loading change in that package are among them. The .NET
middleware (`dotnet/src/Microsoft.Agents.AI.AgentHooks`) sets `agentId =
Id ?? Name ?? "agent"`, `framework: FrameworkName` (`"agent-framework"`,
`Core/AgentHooksAgent.cs:29`) and a GUID session per run (`:205-209`);
the open .NET declaration-loading change there sets no context member.
One .NET test file references `Sequence` or `SessionId`.

### agent-control-spec

The engine reads the context as a snapshot by path and never reads
`target`, `sequence` or `session` (`engine/src/runtime.rs:230-236`; the
`policy_target` resolution is in the member table); its policy output
already rejects the `$policy_target` root and emits `$target`
(`engine/src/policy_output.rs:171-173`). The removals cost it nothing at
the engine. Three things change.

First, its Cedar principal comes from the context's `agent.id`, and the
runtime fails closed with `runtime_error:policy_invocation_failed` when
that is not a string (the member table). With `agent.id` optional, a
host that omits it makes every Cedar-backed binding fail closed, which
is the right default. agent-control-spec decides whether to offer a
configured fallback principal for anonymous hosts, a one-file change in
`cedar.rs` plus its specification row.

Second, its remote-policy evaluator selects and scopes policy by
`agent.id` and rejects a context whose value is not a configured agent
(the member table). That is selection by a host-asserted label; for a
remote caller the identity should come from the verified token. This
proposal leaves that choice to them.

Third, its conformance harness builds contexts with
`AgentContextBuilder::new("acs-agent",
"agent-control-spec-reference-host", "sess-<n>")`
(`engine/tests/agent_hooks_conformance.rs:231-235`, and `:704` in an
end-to-end test). It pins 73 vendored vectors with a provenance digest
and `EXPECTED_PASSED: usize = 46` (`:293`). Its claim row cites the
0.1.0-beta.2 corpus. It re-vendors the 0.2 corpus and re-runs the claim,
one mechanical PR. The example manifest that selects `$.agent` as a
`policy_target` at `agent_startup`
(`examples/bank_agent/manifest.yaml:12-16`) fails closed on a host that
omits `agent`, which is the documented behaviour for an unresolved path.

### Other early adopters

The API gateway described in The gap drops `sequence`, `session` and
`target`, sets `host.name`, and omits `agent.id` unless the caller it
authenticated is the agent; that is a removal of code, not an addition.
The hosted agent runtime described there sets `host.name`, `agent.id`
from the request when present (the sub-agent case is where it matters)
and omits it otherwise, `session.id` from the request when present with
no fallback, `trace` as now, and nothing for `sequence` or `target`. The
early integration that takes the agent identity from the token it
verified needs only the builder keyword mapping plus dropping any
invented members.

## Conformance and tests

The conformance engine in the Rust core, which every runner calls,
changes in three places: `REQUIRED_FIELDS` becomes the three members
(`ctk_engine.rs:25-33`), `validate_required` keeps calling
`validate_envelope` (`:249-270`), and `assert_sequence` and its call for
every vector (cited in the member table) are deleted. The engine change
reaches all 91 vectors under `conformance/vectors/` without touching
most files: two files name `sequence` (`AH-CTK-001-basic-loop.json`,
whose `context.sequence` assertion goes, and
`AH-CTK-003-sequence-monotonic.json`, which exists for the deleted rule
and is removed); three name `tools_registered`; none asserts `agent`,
`session`, `framework` or `target`, and no `expect.records` block
asserts `session_id` or `sequence`. The 73 files that set
`sequence_strict` (11 `true`, 62 `false`) keep it: the key governs how
the expected interception-point list is matched against the recorded one
(`ctk_engine.rs:272-317`), not the member. A rename to `order_strict`
would be cosmetic and is not proposed.

The 18 fixtures in `conformance/golden/identity.json` keep their 0.1
identities, and 18 fixtures tagged `agent-hooks/0.2` are added with new
identities generated by `scripts/gen-golden-identity.py` from the Rust
core. A new vector, `AH-CTK-160`, feeds a 0.1-tagged context through a
0.2 emitter: the scenario grammar in `conformance/vectors.schema.json`
gains a member that asks the conformance harness to tag its contexts
with a given spec version, and the vector expects the 0.1 golden
identity and a 0.2-shaped record carrying `spec: agent-hooks/0.1`. A new
capability, `spec_0_1`, gates it; a conformance harness whose SDK
accepts 0.1 contexts declares it. Per-SDK unit tests pin what the vector
grammar cannot express: the refusal of a version the SDK does not
implement, the absence of conversion, the unknown-member rule on
`validate_envelope`, and the omit-never-fill behaviour of the builders.
The claim tuple is unchanged; `spec_0_1` is the one new capability a
claim may declare.

| Case | Expected result |
| --- | --- |
| A 0.2 context with the three required members and the point's payload | Dispatched; identity over the 0.2 projection; record without `sequence`, with `spec: agent-hooks/0.2` |
| A 0.2 context missing `timestamp` or the point's payload | `deny host_error:context_invalid`, no interceptor runs |
| A 0.2 context with an unknown root member and an unknown member inside `tool_call` | Dispatched; both members passed through, neither hashed |
| A 0.2 context that still carries `sequence`, `session` and `agent.framework` | Dispatched; `sequence` and `agent.framework` are unknown members and not hashed; `session.id` is a known optional member, not hashed, copied to `session_id` |
| A 0.2 context that still carries a root `target` | The member is dropped on the way in for one minor; the slice is the transform root |
| A 0.1-tagged context on an SDK that accepts 0.1 (`spec_0_1`) | Validated and hashed under the 0.1 rules; the 0.1 golden identity; a 0.2-shaped record with `spec: agent-hooks/0.1` |
| A 0.1-tagged context on an SDK that does not accept 0.1 | `deny host_error:context_invalid` with a detail naming the version |
| A context tagged a version the SDK does not implement (`agent-hooks/0.7`) | `deny host_error:context_invalid` with a detail naming the version |
| A builder given no agent id or session id | No `agent` or `session` member written; no placeholder |
| A `transform` at `pre_tool_call` rooted at `$target` | Applied to `tool_call.args`; `EmitOutcome.target` and `target_of` return the rewritten value |
| A `transform` rooted outside `$target`, or at `agent_startup` | `deny host_error:transform_target_forbidden` |
| `agent_startup` without `tools_registered` | Dispatched; `agent_init` projected without the member |
| Parallel tool calls on one emitter | Each call bracketed by its own pair; no ordering assertion |
| The 18 0.1 golden fixtures on a `spec_0_1` SDK | Identities unchanged |
| The 18 0.2 golden fixtures on every SDK | The new identities, byte-identical across the five SDKs |
