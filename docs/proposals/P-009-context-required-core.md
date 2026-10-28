# P-009: The required core of the agent context

**Status:** Draft.
**Raised by:** Mohammad Abuomar, from the design discussion of 2026-10-27
on adopter feedback (the Copilot SDK review and the AI Gateway
integration).

## Why a proposal

[README.md](README.md) requires a proposal for a change to the required
or conditional context fields, which `VERSIONING.md` classes as spec
MAJOR, and for a change to the identity or record shape (§10). This
change does both. It removes two required members of the context
(`sequence` and `target`), moves three to optional (`agent.id`,
`session.id` and the host identifier), renames one, and so changes the
`jcs-sha256` preimage (§10.2) and the record envelope (§10.3). The claim
tuple of §13.3 is unchanged.

## The gap

§4.1 requires seven root members at every interception point: `spec`,
`interception_point`, `timestamp`, `sequence`, `agent` (with `id` and
`framework`), `session` (with `id`) and `target`. `sequence`, `agent`
and `session` describe a harness that runs one agent loop in one
process, and `target` duplicates a member the harness already sends. A
gateway that mediates tool calls for many agents has none of that state.
It does not run the loop. It knows the caller it authenticated, which
may be a toolbox that fronts several agents, not the agent definition.
It holds no session, and it cannot count emissions, because the next
request may land on another instance. The spec says the member is
required and the SDK denies the emission without it
(`host_error:context_invalid`,
`sdk/rust/core/src/canonical.rs:320-383`), so an adapter fills something
in.

The adapters in reach show the pattern. The agent-framework Python
middleware sets `agent_id` to the agent's id, else its name, else the
literal `"agent"`, and a fresh UUID per run as the session
(`python/packages/core/agent_framework/_agent_hooks.py:1030-1037`). The
.NET middleware does the same with `Id ?? Name ?? "agent"` and a GUID
(`dotnet/src/Microsoft.Agents.AI.AgentHooks/Core/AgentHooksAgent.cs:205-209`).
The Copilot runtime adapter under review builds every context with
`AgentContextBuilder::new("copilot", "copilot", &run_id)`
(`src/runtime/src/hooks/agent_hooks.rs:981` in
github/copilot-agent-runtime#25730); its rebuilt form falls back to
`"copilot-session"` when the input carries no session id
(`src/runtime/src/hooks/agent_hooks/projection.rs:113-118`). The AI
Gateway, by the account given in the discussion, emits the two tool-call
points, keeps no state between requests and is understood to fill
`sequence` with a placeholder. These values pass validation and enter
the identity preimage and the record. None of them tells an interceptor
anything.

`sequence` promises a total order that no host can keep. §12.2 lets
emissions of different tool calls interleave and asks the host to assign
numbers atomically; a stateless gateway has no counter to share; an
asynchronous host has no single line to count along. The order is not
what approvals bind by: an approval binds to the context identity
through the echo rule (§9, §10.1) inside one emission. A timestamp does
not establish causality off box either, so no replacement order is
promised below. Nothing in the tree reads `sequence` except the record
copy (`sdk/rust/core/src/enforce.rs:202`) and the conformance kit's own
monotonic check (`sdk/rust/core/src/ctk_engine.rs:678-689`).

`target` duplicates the conditional member named in the §3 table. It
exists because the 0.1 context was an open object and a transform needed
a fixed root. The core keeps the two copies in step by hand:
`apply_transform_to_ctx` rewrites `target` and then `write_back_target`
mirrors the value into `tool_call.args`, `tool_result.value`,
`messages`, `response`, `input` or `output`
(`sdk/rust/core/src/enforce.rs:52-65` and `:299-325`). Once the
per-point members are the contract, the duplicate adds a consistency
rule and nothing else.

The spec says nothing explicit about unknown members. The core's
envelope check tests presence and JSON type only. The eight per-point
schemas under `spec/schema/agent-context/` close the conditional payload
objects (`additionalProperties: false` on `tool_call`, `tool_result`,
`model`, `response`, `input`, `output`, `agent_init` and `summary`,
written by `scripts/gen-per-point-schemas.py`) and describe themselves
as "used by the CTK for strict validation". No runner does that: all
five runners delegate assertion to the engine in the Rust core
(`ctk_assert`), which calls `validate_envelope`
(`sdk/rust/core/src/ctk_engine.rs:267`), and the Python package's loader
for those schemas (`sdk/python/python/agent_hooks/ctk/_schemas.py`) has
no importer. An adopter who reads the schema files concludes that an
extra member fails conformance. The contract should say one thing and
the files should match it.

## Goals and non-goals

Goals:

- A required core that a gateway fills truthfully and a harness fills
  the same way.
- Identity members that are present when the host knows them and absent
  when it does not, never filled with a placeholder.
- One rule for unknown members, stated in the spec and matched by the
  schemas, the SDKs and the conformance kit.
- A transform root that needs no duplicate member.
- The conditional shapes of `input`, `pre_model_call`,
  `post_model_call`, `pre_tool_call`, `post_tool_call`, `output` and
  `agent_shutdown` unchanged.
- One version bump, labelled and numbered by the written rules, with as
  much of the break as possible absorbed inside the SDKs.

Non-goals:

- The shape of `messages` at `pre_model_call`. That is P-010.
- A rework of `agent_startup` and `agent_shutdown` as hooks. A later
  proposal may take that up; this one changes only whether
  `tools_registered` is required.
- `tenant.id`. It is an optional well-known field today (§4.5), not part
  of the required core, and stays as it is: the value belongs to the
  authentication context of the request, which is the one source of
  truth, and a copy in the context would need rules for the case where
  the two disagree.
- Remote hooks: how a caller's identity or token reaches an interceptor
  in another process. That belongs with the authentication context, not
  this envelope, and is a separate proposal.
- The verdict shape, composition, the approval seam, the declaration
  contract (`agent-hooks-declaration/1.1` is unchanged) and the claim
  tuple.

## What each member does today

The table lists who writes and who reads each member in the code in
reach. "The builders" are the five per-session context builders:
`sdk/rust/core/src/builder.rs:59-98`,
`sdk/python/python/agent_hooks/context.py:44-76`,
`sdk/typescript/src/builder.ts:19-44`,
`sdk/dotnet/src/AgentHooks/AgentContextBuilder.cs:58-60` and
`sdk/go/agenthooks/builder.go:28-77`.

| Member | 0.1 rule | Written by | Read by |
| --- | --- | --- | --- |
| `sequence` | Integer, strictly increasing within `session.id`, 0 at `agent_startup` (§3.1 rule 6, §4.1, §12.2 rule 3) | The builders; the Copilot adapter keeps an `AtomicU64` to feed it (`agent_hooks.rs:194-239` in the rebuild) | The record copy (`enforce.rs:202`), the CTK monotonic check (`ctk_engine.rs:678-689`, run for every vector at `:738`), vectors AH-CTK-001 and AH-CTK-003, six assertion lines in agent-framework's `tests/core/test_agent_hooks.py`. No interceptor. |
| `session.id` | Non-empty string, stable across all hooks of one session | The builders | The record copy (`enforce.rs:196-201`), the same agent-framework tests. No interceptor. |
| `agent.id` | Non-empty string, stable across sessions of one agent definition | The builders | agent-control-spec: the Cedar principal (`engine/src/cedar.rs:90-98` and `:165-184`) and the remote-policy scope check (`sdk/remote-policy/python/agent_control_spec_remote_policy/integration.py:73-77`). |
| `agent.framework` | Lowercase host identifier, `^[a-z0-9_-]+$` | The builders | No reader beyond the envelope grammar check (`canonical.rs:362-370`). The declaration document names the host as `host.name` under the same grammar (§7.7.3). |
| `target` | The §3 slice, root of `$target` (§4.3, §5.2) | The builders | The core's transform application (`enforce.rs:60-63`) and `EmitOutcome.target` (`sdk/rust/core/src/emitter.rs:943`); agent-framework reads `outcome.target` at six write-back sites. agent-control-spec reads the context by path (`$.tool_call.args`, `engine/src/runtime.rs:313-319`) and never reads `target`. |

The preimage of the default identity provider is an allowlist that
mirrors the required core and the per-point payloads
(`sdk/rust/core/src/canonical.rs:140-148` and `conditional_for`). The
record copies `session.id` and `sequence` and requires both
(`spec/schema/interception-record.schema.json`, `required`, with
`additionalProperties: false` at the root).

## Options

This proposal weighs four designs for the required core, each on
truthfulness (can every host fill it without inventing values), on what
an interceptor can rely on, on the version cost, and on the work it
takes.

### A. Status quo

Keep the seven members required.

For: nothing moves; the 18 golden identities and the record shape stay
as they are; the adopters with adapters in reach need no change.

Against: the placeholders above are the steady state, not an accident,
because the schema rejects an absent member. `sequence` states a
guarantee that §12.2 concurrency and a stateless host cannot keep.
`target` needs a mirror rule in every SDK. Three adopters (the gateway,
the Copilot runtime and agent-framework) invented values to pass
validation.

### B. Make every discussed member optional

Keep `sequence`, `session`, `agent.id`, `agent.framework` and `target`
in the schema, each OPTIONAL. Nothing is removed. The record keeps its
shape and writes its unknown sentinels (`session_id: ""`, `sequence:
-1`, `enforce.rs:196-202`) when a member is absent.

For: every 0.1 context stays valid; the builders need no change; the
record consumers see the same keys.

Against:

- It buys no version relief. Making a required member optional changes
  the required set, which is the spec MAJOR class in `VERSIONING.md` and
  in the proposals README, because an interceptor written to 0.1 may
  read the member unconditionally.
- An optional `sequence` carries no meaning. A counter that may be
  absent on some emissions of a session cannot define an order, so the
  member stays in the schema as a dead field with a tempting default.
  The record would carry `-1` as the normal case for a gateway, which
  writes the placeholder problem into the audit trail.
- An optional `target` means two code paths in every SDK (apply to the
  member, apply to the slice) and keeps the stale-duplicate hazard for
  hosts that supply one and not the other.
- The lesson other protocols learned applies: optional members do not
  get filled. If nothing in the contract may depend on them, the honest
  statement is removal for the members that carry a guarantee
  (`sequence`, `target`) and optional status only for members whose
  absence costs nothing (`agent.id`, `session.id`, the host name).

### C. Remove `sequence` and `target`, make the identity members optional, rename `agent.framework` to `host.name` (recommended)

The required core becomes `spec`, `interception_point` and `timestamp`.
`host.name`, `agent.id` and `session.id` join the well-known optional
members of §4.5 under one rule: present when the host has the value,
absent otherwise, never a placeholder. `target` leaves the context;
`$target` stays as the root of a transform path and denotes the §3 slice
of the context's interception point. The per-point conditional members
are the contract and the identity preimage.

For: every host can fill the core truthfully; an interceptor relies on
the per-point payload, which is what it evaluates; the transform root is
unchanged for every existing verdict and for agent-control-spec's policy
output; the removed members are the ones nothing in the tree reads.

Against: every `jcs-sha256` identity changes once; the record loses
`sequence` and makes `session_id` optional, so a record consumer that
ordered by `sequence` moves to `timestamp`; a third-party interceptor
that read `ctx.target` directly must read the slice instead; two filed
claims are re-run.

### D. Remove all five, `agent.id` included

The gateway-shaped end of the range: the context names no principal at
all, and identity comes from the authentication context only.

For: nothing in the context can be mistaken for a verified identity; the
gateway story is the simplest.

Against: a harness that knows which agent definition is running, and
which sub-agent a harness spawned under it, has no standard place to say
so. agent-control-spec selects remote policy by `agent.id` and builds
its Cedar principal from it; both would move to extensions, which
fragments the one thing security reviewers asked to keep. The member
costs nothing when absent. D is not recommended now; the remote identity
proposal may revisit it with a verifiable caller identity in hand.

### Questions inside C

Five points inside C have more than one defensible answer. The
trade-offs are below; the stance on each is in the Recommendation
section that follows.

`session.id`: delete the member, or keep it as a well-known optional
member. For keeping it: the `session` object already lives in §4.5
(`started_at`, `turn`); the record keeps a correlation key for hosts
that have one; nothing in the contract depends on it. For deletion: one
member fewer, and no temptation to invent a session where the host has
none, which is what the `"copilot-session"` fallback did.

The host identifier's name: `host.name`, `client.name` (the MCP analogy,
`clientInfo.name`) or `caller.id`. For `host.name`, with an optional
`host.version`: "host" is this specification's own word for the party
that emits a context (§2), the declaration document already carries
`host.name` under the same grammar (§7.7.3), and the claim tuple's first
member names the same thing. For `client.name`: readers of MCP know it;
against it, this specification already has a word for that party.
Against `caller.id`: at a gateway the authenticated caller is the party
the gateway serves, not the gateway, which is exactly the confusion that
made `agent.id` hard to fill. Under any name the grammar can stay
`^[a-z0-9_-]+$`, so `agent-framework`, `github-copilot`,
`reference-agent` and `agent-control-spec-reference-host` remain valid
values.

`agent.id`: required, optional, or removed. For required: a policy can
always key on it. Against required: the gateway and toolbox case above
turns it into a placeholder. For removal: option D. For optional,
with two normative sentences (the host sets it from its own knowledge of
the agent definition and never copies it from content the agent
produced; a host that cannot name the agent omits the member): the
security case for keeping it (sub-agent tracking, per-agent policy and
approvals) and the gateway case against requiring it (a gateway knows
the caller it authenticated, which may be a toolbox identity, not the
agent) are both served. The harnesses that know the agent say so, the
gateway says nothing rather than something false, and a policy that
needs a principal fails closed on absence instead of binding to filler.
A separate question is the preimage: as an optional member it stays out
of the `jcs-sha256` projection (§10.2); hashing it when present is the
alternative. The approval binding that would add is in-process and per
emission, and "optional data never perturbs the identity" is the rule
hosts rely on when they add data.

`agent_init.tools_registered`: required, optional, or removed. For
optional and documented as not exhaustive: the runtime list a host
enforces against is the per-call `tools` member at `pre_model_call`
(§4.5) and the `tool_call` payload at the tool points; tools now arrive
through MCP and skills after startup, so a static list at startup is
advisory. Against removal: it takes away a member adopters asked for and
that policies key on. Against required: a startup emission fails for a
host that has no registry at that moment. Extensions carry richer
catalogue data.

The transform root: keep `$target` as a symbolic root that resolves to
the §3 slice, or re-root paths at the context (`$.tool_call.args.url`)
with a per-point allowlist of writable members. For keeping `$target`:
every existing verdict, every vector and agent-control-spec's policy
output (`engine/src/policy_output.rs:171-173`) already use it. Against a
context-rooted path: it would widen what a transform may touch and
change the §5.2 grammar for no gain. The `$policy_target` alias of §5.2
is scheduled for removal in 0.3; folding that removal into this break is
a separate line item in the decision list.

## Recommendation

Option C, with these answers to the questions above. Each is a
recommendation: the status is Draft, the group decides, and the list at
the end records the alternatives.

- The required core is `spec`, `interception_point` and `timestamp`.
  `sequence` and `target` leave the context.
- `agent.id` is optional. The host sets it from its own knowledge, never
  from agent-produced content, and omits it when it cannot name the
  agent. It is never part of the `jcs-sha256` preimage.
- `session.id` stays as a well-known optional member; it is not
  deleted. The discussion leaned toward deletion, so this point stays
  open until the group has talked it through.
- `agent.framework` becomes `host.name`, optional, with an optional
  `host.version`. The grammar `^[a-z0-9_-]+$` is unchanged.
- `agent_init.tools_registered` is optional and documented as not
  exhaustive.
- Unknown members never fail validation. The per-point schemas lose
  their `additionalProperties: false` closure, and
  `host_error:context_invalid` never means an unknown member.
- `$target` stays as the root of a transform path and resolves to the §3
  slice.
- The change ships as `agent-hooks/0.2` under `spec:breaking`, with
  package version 0.2.0 and the pre-1.0 numbering convention written
  into `VERSIONING.md`. This proposal is the draft; the deciding PR
  edits the specification in place.

## Analysis

This section weighs B (all optional) against C (removal) on the four
questions that decide the cost.

### Version consequence

Both B and C change the required set, so both are spec MAJOR under
`VERSIONING.md` ("MAJOR = required/conditional field change") and both
need this proposal. The discussion called the change a minor bump. The
two statements agree once the pre-1.0 convention is written down: the
wire version is `MAJOR.MINOR` with no third component, the spec is at
`0.1`, and before 1.0 a MAJOR-class change moves the MINOR digit. The
bump is `agent-hooks/0.1` to `agent-hooks/0.2`, which is what both
readings mean.

The recommendation is to say so in `VERSIONING.md` in one sentence
(while MAJOR is 0, a MAJOR-class change bumps MINOR and 0.x minors are
not compatible with each other), to label the deciding PR
`spec:breaking`, and to bump the package version from the 0.1.0
pre-release line to 0.2.0 (the SDK rule, "MAJOR on spec MAJOR", under
the same convention). The alternative, changing the shape and keeping
the `agent-hooks/0.1` string, is rejected: the identities and the record
shape change, so a reader of a record or a context must be able to tell
which rules applied, and the `spec` string is the only signal it has.

The mechanism is the one the repository already has. This proposal is
the draft: the text is debated and amended here while the published
specification stands. Once decided, one PR edits
`spec/AGENT-HOOKS-0.1.md` in place, bumps its header to 0.2 and adds the
`CHANGELOG.md` entry, under `spec:breaking`. That satisfies the
change-class workflow (`.github/workflows/change-class.yml`), which
requires a `spec:breaking` PR to change a version surface in the same
PR: a path under `spec/AGENT-HOOKS`, an SDK manifest, or `CHANGELOG.md`.
No parallel copy of the specification is kept.

### Identity and the record

The `jcs-sha256` preimage is the closed required-plus-conditional
projection (§10.2, `canonical.rs:140-148`). Under C the root part of the
projection shrinks to `spec`, `interception_point` and `timestamp`; the
per-point allowlists are unchanged, and `tools_registered` stays on the
`agent_init` allowlist when present. `target` leaves the preimage with
no loss of content binding, because the slice it duplicated
(`tool_call.args`, `tool_result.value`, `messages`, `response`, `input`,
`output`) is on the allowlist already. Under B the members leave the
preimage as well, because optional members are excluded by rule. Keeping
them in it when present would make two hosts that emit the same tool
call produce different identities depending on which placeholders they
filled; the identity would measure the adapter, not the content. B
therefore changes every identity as much as C does.

Every existing golden identity changes under either option. All 18
fixtures in `conformance/golden/identity.json` carry `sequence`,
`agent`, `session` and `target`; `scripts/gen-golden-identity.py`
regenerates them from the Rust core. No continuity is promised across
the bump: approvals bind inside one emission, and an identity is
meaningful only against records produced under the same rules.

The record (§10.3) drops `sequence` and makes `session_id` OPTIONAL,
present when the context carried `session.id`. The sentence "records are
totally ordered within a session" goes, and with it the host projection
failure rule that consumes the next sequence number. The record keeps
`timestamp` (the context's event time, which every conformant context
has) and `trace` (W3C Trace Context, when the host supplies it); a SIEM
orders by those. A host that needs its own order across concurrent
emissions keeps a counter in its extension namespace. `decided_by`,
`verdicts`, `composition` and the identities are unchanged, so
attribution and tamper evidence are as they were.

### What a host and an interceptor see

Before, at `pre_tool_call`:

```jsonc
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

After, from a harness and from a gateway:

```jsonc
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
{
  "spec": "agent-hooks/0.2",
  "interception_point": "pre_tool_call",
  "timestamp": "2026-06-19T14:03:11.123Z",
  "host": { "name": "ai-gateway" },
  "tool_call": { "id": "call_1", "name": "issue_refund", "args": { "amount": 75 } }
}
```

A conforming host fills three members and the point's payload. It adds
`host`, `agent`, `session` and `trace` when it has them. It applies a
transform to the slice the §3 table names and proceeds with that value.

A conforming interceptor evaluates the point's payload, which is the
same object it evaluated before. It addresses a transform at `$target`
as before. It reads `agent.id` when present and treats it as the host's
assertion, under the §1.4 trust model, not as a verified claim. It must
not fail a context for an unknown member or for an absent optional one.
Under B an interceptor would have to handle absence of all five members
anyway, so the interceptor-side change is the same; C removes the
temptation to rely on them.

The risk that optional-but-present members invite garbage is real and is
answered by a rule, not by hope: a host MUST omit an optional identity
member it does not have and MUST NOT fill a placeholder. The conformance
kit cannot test what a production host knows, so the rule is enforced
where it can be: the adapters named above drop their literals
(`"agent"`, `"copilot-session"`), the SDK builders accept an absent
agent and session, and a policy that needs a principal fails closed on
absence (agent-control-spec already does, `engine/src/cedar.rs:165-184`
and `integration.py:73-77`). Absence is visible; filler is not.

### Migration and what the SDKs can hide

The read side hides most of it. The core accepts any well-formed
`agent-hooks/<major>.<minor>` string and compares nothing to
`SPEC_VERSION` (`canonical.rs:327-341`), and the declaration loader
accepts a document whose `spec` minor is at most its own
(`sdk/rust/core/src/declaration.rs:1329-1333`). A 0.2 SDK therefore
accepts a 0.1-shaped context and a 0.1 declaration document. The members
a 0.1 host still sends (`sequence`, `session`, `target`,
`agent.framework`) are unknown members under 0.2: passed through to
interceptors, kept out of the preimage, not copied to the record. One
exception is recommended: the SDK drops a root `target` member on the
way in for one minor, with a CHANGELOG note, because it is the member
the SDK's own builder used to write and a stale copy next to the
rewritten slice would mislead a host that reads it after `emit` instead
of `outcome.target`.

The write side is mechanical. The five builders keep their `(agent_id,
framework, session_id)` constructors as forwarding overloads without a
deprecation diagnostic (P-007 found that agent-control-spec builds with
clippy `-D warnings` and the agent-framework .NET package with
`TreatWarningsAsErrors`, so a diagnostic is a break for both), map
`framework` to `host.name`, write `agent.id` and `session.id` as
optional members when given, and stop writing `sequence` and `target`. A
new constructor takes the host name alone. `EmitOutcome.target` stays
and is computed from the slice, so agent-framework's six write-back
sites and any host written to the documented pattern keep working. Each
SDK gains a `target_of(ctx)` accessor for interceptors that read the
slice directly.

Default-fill on read, meaning the SDK synthesizing `sequence` or
`session.id` so that an old interceptor keeps seeing them, is not
recommended. It is the placeholder problem moved inside the SDK.

The record types change in all five SDKs
(`sdk/rust/core/src/types.rs:551-555`,
`sdk/python/python/agent_hooks/_types.py:649-651`,
`sdk/typescript/src/index.ts:374-377`,
`sdk/dotnet/src/AgentHooks/Types.cs:629-630`,
`sdk/go/agenthooks/types.go:532-535`). The .NET record keeps its
previous positional constructor as a forwarding overload and
`PublicApi.approved.txt` changes on purpose; the 0.1.0-beta.3 entry in
`CHANGELOG.md` records what happened the last time a record signature
moved under a published dependent package.

## Normative changes

The edits below are the change to the specification text under option C
with the recommended answers. Quoted text is new text. Section numbers
refer to the current document; the deciding PR applies the edits in
place and bumps the header to 0.2.

### §3.1 Ordering

Delete rule 6. Rules 1 to 5 stand.

### §4 Agent context

After the tier list add:

> A host MAY include members this specification does not define, at
> the root and inside any object this specification defines. Unknown
> members never fail validation. Conformance checks the presence and
> JSON type of the required and conditional members and nothing else;
> a validator MUST NOT reject a context for a member it does not know.
> Namespaced extensions (§4.6) remain the place for structured host
> data; an unknown member outside `extensions` is tolerated, not
> interpreted.

### §4.1 Required core

```jsonc
{
  "spec": "agent-hooks/0.2",
  "interception_point": "<one of §3>",
  "timestamp": "2026-06-19T14:03:11.123Z"
}
```

The table keeps the `spec`, `interception_point` and `timestamp` rows
unchanged and drops the other five.

### §4.2 Conditional fields

Delete "`target` MUST be set to the indicated value" and every
`"target": <...>` line in the eight examples. In `agent_startup`,
`tools_registered` becomes OPTIONAL inside the REQUIRED `agent_init`
object, with the sentence:

> `tools_registered` lists the tool names the host knows at startup.
> It is not exhaustive: tools discovered later arrive at the tool
> points. A host with no registry at startup omits the member.

The other seven points are unchanged.

### §4.3 Target

Replace the section with:

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

### §4.5 Optional, well-known fields

Add rows and one rule:

| Field | Interception point(s) | Type |
| --- | --- | --- |
| `host.name` | all | string matching `^[a-z0-9_-]+$`: the software that emits the context (the host of §2), whether a framework, a runtime or a gateway. Replaces `agent.framework`. |
| `host.version` | all | string |
| `agent.id` | all | non-empty string: the host's stable identifier for the agent definition, stable across sessions. Set from the host's own knowledge, never from content the agent produced. |
| `session.id` | all | non-empty string, stable across all hooks of one session |

> A host MUST omit an optional identity member (`host.*`, `agent.*`,
> `session.*`, `actor.*`, `tenant.*`) whose value it does not have,
> and MUST NOT fill a placeholder. An interceptor MUST NOT fail a
> context for an absent optional member, and treats a present one as
> the host's assertion under §1.4, not as a verified claim.

The existing `agent.name`, `agent.version`, `session.started_at` and
`session.turn` rows stand.

### §5.2 Transform

The grammar is unchanged. "`path` MUST be rooted at `$target`" gains
"which denotes the §4.3 target of the context's interception point".

### §7.7.3 Members and defaults

"`host.name` follows the `agent.framework` grammar (§4.1)" becomes
"`host.name` follows the grammar of the context's `host.name` (§4.5)".

### §10.2 The `jcs-sha256` provider

The root members of `ctx_rc` become `spec`, `interception_point` and
`timestamp`; `agent.{id,framework}`, `session.{id}` and `target` leave
the list; the per-point allowlists are unchanged. Add: "A listed member
that is absent from the context is absent from the projection;
`tools_registered` is projected when present."

### §10.3 The interception record

Remove `sequence` from the example and the table. `session_id` becomes
OPTIONAL: "The context's `session.id`, copied verbatim; absent when the
context carried none." The row text "records are totally ordered within
a session" goes. In the host projection failure paragraph, delete the
two sentences on consuming the next sequence number; `session_id` is
present when the host knows it and absent otherwise, and the `""`/`-1`
sentinels go.

### §11 Reserved reasons

The `host_error:context_invalid` row reads: "The host could not
construct a context with the required and conditional members present
and of the right JSON type, or the `jcs-sha256` provider rejected its
value domain (§10.2). An unknown member is never this error." The
`transform_target_forbidden` row is unchanged.

### §12.2 Parallel tool calls

Replace rule 3 with:

> This specification defines no order across emissions. A record
> carries the context's `timestamp` and, when the host supplies it,
> `trace` (§4.5); a host that needs an order across concurrent
> emissions keeps it in its own extension namespace.

### §14 Security considerations

One bullet: `agent.id` and `session.id` are host assertions, present
only when the host knows them. A policy that keys on `agent.id` fails
closed when it is absent rather than binding to a default, and a host
never derives the member from agent-produced content.

### Schemas and inventories

- `spec/schema/agent-context.schema.json`: root `required` becomes
  `["spec", "interception_point", "timestamp"]`; `target` is removed;
  `host` is added with `name` and `version`; `agent.required` and
  `session.required` become empty; `agent_init.required` becomes empty.
- `scripts/gen-per-point-schemas.py`: `CORE_REQUIRED` shrinks to the
  three members and the `additionalProperties: false` closure of the
  payload objects goes. The eight files under
  `spec/schema/agent-context/` are regenerated and their description no
  longer claims strict validation; the preimage allowlist in
  `canonical.rs` is the only closed thing and §10.2 says so.
- `spec/schema/interception-record.schema.json`: `sequence` removed from
  `properties` and `required`; `session_id` removed from `required`; the
  description drops "ordering".
- `spec/schema/path-grammar.abnf`: unchanged.
- `spec/reserved-reasons.json`: text of the `context_invalid` entry
  only.
- `docs/THREAT-MODEL.md` (the "Interception records" row),
  `docs/IMPLEMENTING.md:177`, `conformance/HARNESS.md:17` and `:386` and
  `conformance/RUNNER.md` follow the spec text.

### Conformance kit

- `ctk_engine.rs`: `REQUIRED_FIELDS` becomes the three members;
  `assert_sequence` is deleted and its call at `:738` with it;
  `validate_required` keeps calling `validate_envelope`.
- `AH-CTK-003-sequence-monotonic.json` is removed; the
  `context.sequence` assertion in `AH-CTK-001-basic-loop.json` is
  removed. The 73 files that set `sequence_strict` keep it: the key
  governs how the expected interception-point list is matched against
  the recorded one (`ctk_engine.rs:272-316`), not the member. A rename
  to `order_strict` would be cosmetic and is not proposed.
- `conformance/golden/identity.json`: all 18 fixtures regenerated.
- Per-SDK unit tests pin the unknown-member rule on `validate_envelope`
  (a root member and a member inside `tool_call` that the schema does
  not define both pass) and the omit-never-fill behaviour of the
  builders (an absent agent id produces no `agent` member).

## Impact

### agent-control-spec

The engine reads the context as a snapshot by path and never reads
`target`, `sequence` or `session` (`engine/src/runtime.rs:230-236` and
`:313-319`); its policy output already rejects the `$policy_target` root
and emits `$target` (`engine/src/policy_output.rs:171-173`). The
removals cost it nothing at the engine. Three things change:

- The Cedar principal is `$pi.snapshot.agent.id`, and the runtime fails
  closed with `runtime_error:policy_invocation_failed` when it is not a
  string (`spec/SPECIFICATION.md`, the Cedar request table;
  `engine/src/cedar.rs:90-98` and `:165-184`). With `agent.id` optional,
  a host that omits it makes every Cedar-backed binding fail closed.
  That is the right default; agent-control-spec decides whether to also
  offer a configured fallback principal for anonymous hosts, a one-file
  change in `cedar.rs` plus its specification row.
- The remote-policy evaluator rejects a context whose `agent.id` is not
  a configured agent (`integration.py:73-77`). Unchanged in code; the
  remote-policy README gains the sentence that it requires a host that
  supplies `agent.id`.
- The harness builds contexts with
  `AgentContextBuilder::new("acs-agent",
  "agent-control-spec-reference-host", "sess-<n>")`
  (`engine/tests/agent_hooks_conformance.rs:231-235`, and `:704` in an
  end-to-end test), pins 73 vendored vectors with a provenance digest
  and `EXPECTED_PASSED: usize = 46` (`:293`), and its claim row cites
  the 0.1.0-beta.2 corpus. It re-vendors the 0.2 corpus and re-runs the
  claim: one PR, mechanical. The example manifest that selects `$.agent`
  as a `policy_target` at `agent_startup`
  (`examples/bank_agent/manifest.yaml:12-16`) fails closed on a host
  that omits `agent`, which is the documented behaviour for an
  unresolved path.

### agent-framework

Python (`python/packages/core/agent_framework/_agent_hooks.py`): the run
state builds `AgentContextBuilder(agent_id=<id or name or "agent">,
framework="agent-framework", session_id=uuid4().hex)` per run (`:157`,
`:1030-1037`), and six write-back sites read `outcome.target`. Under C
the literal `"agent"` goes (omit when the agent has no id), the
`framework` keyword maps to `host.name` inside the SDK, the session id
stays as an optional member, and the write-backs are untouched because
`EmitOutcome.target` stays. Six assertion lines in
`python/packages/core/tests/core/test_agent_hooks.py` assert on
`record.sequence` or `record.session_id` and change. PR
microsoft/agent-framework#9405 (merged) added declaration loading; the
tests it added, now in that file, assert `record.sequence == range(n)`
and one `session_id` per run and are among the six. PR #9406 (open) adds
the .NET declaration loading and an `AgentHooksHostSurface`; it sets no
context member.

.NET (`dotnet/src/Microsoft.Agents.AI.AgentHooks`): `AgentHooksAgent.cs`
sets `agentId = Id ?? Name ?? "agent"`, `framework: FrameworkName`
(`"agent-framework"`, `:29`) and a GUID session per run (`:205-209`).
Same change as Python; one test file references `Sequence` or
`SessionId`. The MAF claim row (47 of 51 on `python@0.1.0a5`) is re-run
on the 0.2 corpus.

### The five SDKs

Source files that construct or validate the required core, or copy it to
the record:

- Rust core: `builder.rs:59-98`, `canonical.rs:140-148` and `:320-383`,
  `enforce.rs:60-63`, `:196-202`, `:276-277` and `:299-325`,
  `emitter.rs:943` and `:1057-1061`, `types.rs:551-555`,
  `ctk_engine.rs:25-33`, `:249-270` and `:678-689`. The FFI crate
  (`sdk/rust/ffi/src/lib.rs`) carries no member logic; the wrappers
  inherit `validate_envelope` through `ffi_surface.rs:514-517`.
- Python: `context.py:44-76`, `_types.py:649-651`, `:705-706` and
  `:735-736`, `emitter.py:253-266`, `:809` and `:874-915`; the vendored
  schema copies are regenerated by the drift job.
- TypeScript: `builder.ts:19-44`, `index.ts:332-334` and `:374-377`,
  `emitter.ts:295-300` and `:906-907`; `ctk/reference.ts:89-90`.
- .NET: `AgentContextBuilder.cs:58-60`, `Types.cs:629-630`, `:699-700`
  and `:728-729`, `InterceptionEmitter.cs:722-723` and `:1386`;
  `AgentHooks.Conformance/ReferenceHarness.cs:166`;
  `PublicApi.approved.txt`.
- Go: `builder.go:28-77`, `types.go:532-535`, `emitter.go:754-757`;
  `conformance/reference.go:106-108`.

Files that name the members, source and tests together: Rust 10, Python
14, TypeScript 4, .NET 10, Go 5. The vectors: 91 under
`conformance/vectors/`; the engine change reaches all 91 through
`validate_required` and `assert_sequence`; two files name `sequence`
(AH-CTK-001, AH-CTK-003); three name `tools_registered`; none asserts
`agent`, `session`, `framework` or `target`, and no `expect.records`
block asserts `session_id` or `sequence`.

### Other adopters

AI Gateway: no checkout is available. By the account in the discussion
it emits `pre_tool_call` and `post_tool_call` only, is stateless across
requests, is understood to fill `sequence` with a placeholder, and knows
the authenticated caller, which may be a toolbox identity. Under C it
drops `sequence`, `session` and `target`, sets `host.name`, and omits
`agent.id` unless the caller it authenticated is the agent. That is a
removal of code, not an addition.

WorkIQ: no checkout is available. The assumption is a tool-call-only
integration through the Python builder with invented agent and session
values, the same shortcut the gateway took. The change is the builder
keyword mapping the SDK performs plus dropping the invented values; the
maintainers of this repository can make it with the owner's agreement.

Copilot SDK (github/copilot-agent-runtime#25730): the first consumer of
the final shape, phased so that the hooks land with the final payload
shape first. The PR as it stands writes
`AgentContextBuilder::new("copilot", "copilot", &run_id)`
(`src/runtime/src/hooks/agent_hooks.rs:981`). The rebuilt adapter writes
the framework string `github-copilot` (`agent_hooks.rs:148`), an agent
id from `agentType` or `agentId` with `copilot` for the root agent
(`:151`, `projection.rs:103-111`), a session id from `sessionId` with
the `"copilot-session"` fallback (`projection.rs:113-118`), a `trace`
block from `traceparent`, and its own `AtomicU64` sequence
(`agent_hooks.rs:194-239`). Under C it would set `host.name:
"github-copilot"`, `agent.id` from `agentType`/`agentId` when present
(the sub-agent case is where it matters) and omit it otherwise,
`session.id` from `sessionId` when present with no fallback, `trace` as
now, and nothing for `sequence` or `target`. Its SDK documentation
example already shows a declaration with `"host": { "name": "copilot" }`
and a `spec` string, which becomes `agent-hooks/0.2`.

## Rollout

The deciding PR edits the specification in place with the 0.2 header and
carries the schemas, the generator, the golden file, the `VERSIONING.md`
sentence, the `CHANGELOG.md` entry and the Rust core change, so `main`
never holds a specification its own core does not implement. The four
wrapper SDKs and the conformance runners build on the core and follow in
the same release, with the conformance kit changes, the docs, and the
record and builder compatibility overloads. Until that PR merges the
published specification is unchanged, and this proposal is the only
place the new shape exists.

Downstream, in dependency order: agent-control-spec re-vendors the
corpus, decides the Cedar fallback and re-runs its claim;
agent-framework drops the `"agent"` literal in both middlewares, updates
its tests and re-runs its claim; the Copilot runtime adapter targets the
0.2 shape in its first phase; the gateway and WorkIQ integrations drop
the invented members. The two filed claim rows stay as filed, because
they are true for the SDK versions they cite, and gain 0.2 rows when
each adopter re-runs.

## Risks

- Every `jcs-sha256` identity changes once. No in-flight binding crosses
  the upgrade (approvals bind inside one emission), and records carry
  the `spec` string, so a reader never compares identities across
  versions by accident. The CHANGELOG headline says so.
- Optional members go unfilled. That is accepted for `host`, `agent` and
  `session`, because nothing in the contract depends on them; a
  per-agent policy fails closed on absence, which is visible. The
  omit-never-fill rule and the removal of the adapter literals keep
  "unfilled" from becoming "filled with filler".
- Records lose an in-session order. Consumers that sorted by `sequence`
  sort by `timestamp` and `trace`; within one host process timestamps
  are monotonic enough for audit, and across hosts no order was ever
  real.
- A third-party interceptor that read `ctx.target` breaks. The
  `target_of` accessor, the dropped root `target` on the way in, and the
  CHANGELOG entry make the break loud rather than silent.
- A consumer that validates against the 0.1 record schema, which
  requires `sequence` and `session_id`, rejects 0.2 records until it
  takes the 0.2 schema. The `spec` version in the context, not the
  record, is the discriminator; a record consumer learns the version
  from its host. Adding `spec` to the record is recorded as a possible
  follow-up and not proposed here, to keep this change to the members it
  is about.
- The 0.2 bump lands while 0.1.0 final has not shipped, so the 0.1.0
  pre-release line ends at its last beta. The alternative, shipping
  0.1.0 with the old shape first, would publish a required core the
  group has already decided against.
- The declaration document and the context both carry `host.name`. The
  grammar is stated once, in §4.5, and §7.7.3 points at it, so the two
  cannot drift.

## Decision needed

- [ ] Adopt option C: required core `spec`, `interception_point`,
      `timestamp`; `sequence` and `target` removed; `agent.id` and the
      host identifier optional; the omit-never-fill rule; the
      unknown-member rule with the schema closure removed.
- [ ] `session.id`: keep as a well-known optional member (recommended)
      or delete the member.
- [ ] Host identifier: `host.name` with optional `host.version`, grammar
      `^[a-z0-9_-]+$` unchanged (recommended); alternatives
      `client.name`, `caller.id`.
- [ ] `agent.id` stays out of the `jcs-sha256` preimage (recommended);
      alternative: project it when present.
- [ ] `agent_init.tools_registered`: optional and documented as not
      exhaustive (recommended); alternatives: keep required, remove.
- [ ] `$target` stays as the symbolic root resolved to the §3 slice
      (recommended); alternative: context-rooted paths with an
      allowlist. Separately: fold the scheduled `$policy_target` alias
      removal into 0.2, or keep it for 0.3.
- [ ] Version: wire `agent-hooks/0.2`, label `spec:breaking`, package
      0.2.0, one sentence in `VERSIONING.md` on pre-1.0 numbering; this
      proposal is the draft and the deciding PR edits the specification
      in place (recommended); alternative: change the shape under the
      `agent-hooks/0.1` string.
- [ ] SDK compatibility: builder and .NET record constructors kept as
      forwarding overloads without deprecation diagnostics; the SDK
      drops a root `target` member on the way in for one minor;
      `EmitOutcome.target` kept; `target_of` accessor added.
- [ ] agent-control-spec: fail closed on an absent Cedar principal
      (current behaviour) with or without a configured fallback
      principal; the decision is theirs and precedes their claim re-run.
