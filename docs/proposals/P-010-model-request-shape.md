# P-010: A prescribed shape for the model request and response

**Status:** **Draft**
**Raised by:** the review of the Copilot SDK integration, which declined
to expose the runtime's internal message array through the hook and asked
for a prescribed shape the runtime projects into; and the design
discussion of 2026-10-27, which asked for prototypes against an OpenAI
model and an Anthropic model, an experimental marking, and an escape
hatch. Companion to P-009, which reworks the context core fields.

## The gap

Section 4.2 defines `pre_model_call` as `model.id` plus
`messages: [{role, content: string | object}]`, with `target` set to
`messages`. The shape of `content`, and of anything beyond `role` and
`content`, is the host's choice. Three hosts fill it three ways:

- the agent-framework adapter emits its own content records (`text`,
  `text_reasoning`, `uri`, `function_call`, `function_result`), a string
  when a message is one text part;
- the reference harness in the CTK emits strings, appends tool results
  as `{"role": "tool", "content": value}`, and never represents the
  assistant's tool calls;
- a pass-through host emits whatever array it is about to send to its
  provider, so the shape changes when the model changes.

A policy cannot be written once. The path that redacts a user string
differs by host and, under a pass-through host, by provider. The
Copilot SDK review refused the pass-through on principle: the runtime's
internal array is not a contract.

Two smaller gaps sit beside it. `tools` is optional and outside
`target`, so a transform cannot remove a tool from a model call and the
identity never covers the tool set (confirmed against the shipped core:
changing `tools` leaves the identity unchanged). And the identity hashes
`messages` whole, so provider bookkeeping inside a pass-through array (a
cache marker, an item id, a status) changes the identity of a request
the model would read identically.

## Goals

1. One request shape a policy author learns once: roles, text, media,
   tool calls with object arguments, tool results with an error flag,
   reasoning, refusals.
2. Lossless for the host: projection then write-back returns the
   provider request, and a transform on the prescribed fields lands in
   the real request.
3. The identity covers what a policy can read and nothing a provider
   changes between otherwise equal requests.
4. Reference projections for OpenAI chat completions, OpenAI Responses
   and Anthropic Messages ship in the SDKs and are pinned by vectors.
5. The shape is marked experimental, and a host that cannot project
   has a declared escape hatch with stated guarantees.
6. `post_model_call.response` uses the same part vocabulary.

## Non-goals

- A model-call transport, a gateway protocol, or a claim of
  compatibility with any provider API.
- Request options (sampling, reasoning configuration, tool choice,
  response format). They stay in `model.params`, unprescribed.
- Streaming of requests, or any change to §12.1.
- The shape of `input` and `output`. They may adopt the part vocabulary
  in a later proposal.
- Token accounting and prompt-cache strategy.

## What the prototypes show

The prototypes under `p010-prototypes/` (run `python3 run.py` there)
write three conversations in four shapes: OpenAI chat completions,
OpenAI Responses, Anthropic Messages, and the agent-framework style
emission of today. The conversations are `bank` (system, user,
assistant, user; text only), `weather` (a tool-call round trip with two
declared tools) and `chart` (an image in the user turn, reasoning in the
assistant turn, a cache marker on the system prompt). Provider field
names were checked against the published SDK type definitions and API
references listed under Sources. For each candidate the prototypes
project every provider request into the candidate target and back,
measure the target under RFC 8785 canonical JSON (the bytes the
`jcs-sha256` provider hashes; 54 objects cross-checked byte for byte
against the Rust core), and write each of three edits as one §5.2
transform: redact a string in a user message, drop a tool definition,
replace the system prompt.

Round trip, provider to target to provider, after normalizing choices
that mean the same thing to the model (a string versus one text part,
default-valued members, the system prompt as `instructions` versus a
leading system message):

| fixture | source | A: chat shape | B: neutral + ext | B-: neutral only | C: raw + summary |
| --- | --- | --- | --- | --- | --- |
| bank | chat | none | none | none | none |
| bank | responses | item id | none | item id | none |
| bank | anthropic | none | none | none | none |
| weather | chat | none | none | none | none |
| weather | responses | item ids | none | item ids | none |
| weather | anthropic | none | none | none | none |
| chart | chat | none | none | image detail | none |
| chart | responses | item ids, reasoning item | none | item ids | none |
| chart | anthropic | cache marker, thinking block | none | cache marker | none |

Size of the target in canonical bytes. The agent-framework style column
is smaller on `weather` because that adapter drops tool schemas, not
because the shape is cheaper:

| fixture | source | raw | A | B | B- | C | current |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bank | chat | 291 | 291 | 414 | 414 | 724 | 314 |
| bank | responses | 471 | 291 | 538 | 419 | 909 | 319 |
| bank | anthropic | 272 | 291 | 421 | 421 | 712 | 321 |
| weather | chat | 874 | 874 | 933 | 933 | 1826 | 603 |
| weather | responses | 999 | 874 | 1207 | 938 | 1956 | 608 |
| weather | anthropic | 831 | 887 | 981 | 981 | 1831 | 610 |
| chart | chat | 322 | 322 | 425 | 385 | 726 | 459 |
| chart | responses | 569 | 340 | 715 | 510 | 1098 | 464 |
| chart | anthropic | 473 | 331 | 547 | 479 | 971 | 466 |

With a 100 KiB image inlined as base64 in `chart`, the raw payloads
run from 133,651 to 133,898 bytes, A and B- from 133,651 to 133,846, and
C from 267,391 to 267,763 because it carries the conversation twice.
B- with the media part reduced to a digest and a byte count stays
between 466 and 591 bytes.

Transform expressiveness, one `{path, value}` per edit, fifteen cases
per candidate (five edit and fixture pairs across three sources):

| candidate | distinct paths | write-back equals the native edit | other outcome |
| --- | --- | --- | --- |
| A | 5 | 8 of 15 | 7 strip something on write-back: item ids, the Responses reasoning item, the Anthropic thinking block and cache marker |
| B | 4 | 15 of 15 | none |
| C | 9 | 15 of 15 | the summary is stale after every edit; paths are provider specific (`raw.messages[0].content`, `raw.instructions`, `raw.system`, `raw.system[0].text`) |
| D | host defined | not measurable | a policy cannot be written once |

Under every candidate the index of the text part inside a user message
depends on the source (Anthropic puts the image first), so a policy
locates the part by type and computes the index; the grammar has no
filter segment. Under the current specification `tools` is outside
`target`, so no candidate can drop a tool until the transform root is
the request object.

Identity under a provider-only change (the Anthropic cache marker on
the system block moves): the digest of A and of B without `ext` is
unchanged; the digest of B with `ext` and of C changes. Whatever shape is
chosen, provider residue must stay out of the identity projection.

Provider responses through the same part vocabulary: text, reasoning
and refusal become parts, tool calls stay in `tool_calls`, and what is
left for an extension slot is ids, status, `stop_sequence` and the
provider envelope (`object`, `created`). The current
`response.content: string | object | null` has no place for a reasoning
part or a refusal next to text, so hosts invent one today.

What hosts emit today for the same conversation: the agent-framework
adapter gives a policy `string`, `text`, `text_reasoning`, `uri`,
`function_call` and `function_result`; a pass-through host gives it the
provider's own block types; the CTK reference harness gives it strings
and loses the tool calls.

## Options

### A. OpenAI chat completions messages as the one prescribed shape

`messages` is constrained to the chat completions message schema; every
host projects into it.

**Advantages**

- The most widely implemented request shape. LiteLLM's unified input is
  this parameter set, translated per provider.
- Smallest target: a chat host passes its payload through, and the
  projection from other providers drops what the shape cannot carry.
- Many policy authors already know it.

**Disadvantages**

- No slot for provider reasoning: an Anthropic thinking block with its
  signature, a Responses reasoning item with its encrypted content.
  LiteLLM had to add `reasoning_content` and `thinking_blocks` beside
  the shape for the same reason, and documents that the Anthropic API
  rejects an assistant turn sent back without its thinking blocks.
  A transform written against this shape strips them on write-back
  (measured: the `chart` edits on an Anthropic source).
- Tool arguments are a JSON string. A policy parses before it can read
  one field, and a policy language without a JSON parser cannot.
- Tool results carry text only: no error flag, no media.
- Cache markers, item ids and status are lost (measured).
- It is one vendor's format on its own release schedule. Conformance
  would pin a subset of another organization's specification, and the
  discussion did not expect a lab to adopt a competitor's format.

### B. A small neutral shape with an extension slot

A request object with `format`, `messages` as role plus an array of
typed parts, `tools`, and `ext` residue on any object; each registered
provider format has a projection and a write-back.

**Advantages**

- One part vocabulary and one path shape per edit (measured: four
  distinct paths, fifteen of fifteen edits exact).
- Lossless with `ext` on all nine fixture and source pairs; without
  `ext` the loss is provider bookkeeping only, never text the model
  reads (measured).
- `ext` stays out of the identity, so provider residue cannot perturb
  approvals (measured).
- Object arguments, an error flag on tool results, reasoning as text
  plus an opaque token the host returns unchanged.
- The schema is ours, so the CTK pins the projections with golden
  vectors. A new content type from a lab lands as an `unknown` part or
  under `ext` until the specification names it, and no lab is asked to
  adopt another lab's format.

**Disadvantages**

- Every host adopts or writes a projection. The SDKs can ship three, and
  the prototype is one; hosts with their own content model still map.
- The neutral fields alone run from 11% smaller to 55% larger than the
  provider's own conversation, and 7% to 55% larger with `ext`; the
  increase is the parts array on text-only messages (measured).
- The part vocabulary needs maintenance as providers add kinds.
- Provider rules the shape does not state (turn alternation, where tool
  results may sit) are the write-back's job.

### C. A tagged union: `format`, the raw provider payload, a neutral summary

The request carries the provider conversation as sent plus a summary in
the shape of B without `ext`.

**Advantages**

- Exact by construction, for any provider, with nothing to maintain on
  the raw side.
- A policy that knows the provider format can see everything.

**Disadvantages**

- The raw member is the internal array the Copilot SDK review refused
  to expose.
- Two sources of truth. A transform on `raw` leaves the summary stale
  (measured: fifteen of fifteen), and a transform on the summary does
  nothing unless the host rebuilds `raw`, at which point the host has
  written B.
- A policy that edits must know each format: nine distinct paths for
  the same three edits (measured).
- 1.9 to 2.6 times the raw size, and media counted twice (measured).
- The identity moves with provider bookkeeping (measured).
- Conformance cannot pin `raw` against vendor schemas it does not own.

### D. Keep the loose shape and add a `format` label

**Advantages**

- No host change beyond a label; nothing is lost.

**Disadvantages**

- Does not close the gap: the paths still depend on the host, and the
  label is a claim no vector checks.
- The identity still covers provider residue.
- The Copilot SDK review objection stands.

### Comparison

| criterion | A | B | C | D |
| --- | --- | --- | --- | --- |
| fidelity | loses reasoning, markers, ids | exact with `ext`; bookkeeping lost without | exact | host defined |
| size | smallest | raw minus 11% to plus 55% without `ext` | 1.9 to 2.6 times raw | host defined |
| transform | 5 paths, 7 edits with loss | 4 paths, none with loss | 9 paths, summary stale | not portable |
| policy burden | parse argument strings; two content forms | one vocabulary | one per format plus summary | one per host |
| conformance | pin a vendor subset | golden projections | summary only | label only |
| new lab content type | unknown `type` part | `unknown` part or `ext` | raw | anything |
| lab acceptance | one lab's format | neutral | neutral | neutral |

## Recommended normative semantics

Option B, with the `format` discriminator and the escape hatch of
option C folded in as the extension mechanism. Marked experimental.

### 1. The request object

At `pre_model_call` the host populates `model` as today and `request`
in place of `messages`:

```jsonc
{
  "model": { "id": "string", "vendor": "string", "params": {} },
  "request": {
    "format": "openai.chat" | "openai.responses" | "anthropic.messages" | "custom.<namespace>",
    "messages": [ <message>, ... ],
    "tools": [ { "name": "string", "description": "string", "schema": {} }, ... ],
    "ext": { "<format or namespace>": {} }
  }
}
```

`format` and `messages` are REQUIRED; `tools` and `ext` are OPTIONAL.
`request` is the transform root for the point: today the value of
`target`, and whatever P-009 names the root once `target` goes.
`tools` moves from §4.5 into `request`, so a transform can rewrite the
tool set and the identity covers it. A transform on `$target.tools`
replaces the whole array; the grammar has no delete.

### 2. Messages and parts

```jsonc
{ "role": "system" | "user" | "assistant" | "tool", "content": [ <part>, ... ], "name": "string", "ext": {} }
```

`content` is always an array, so one path shape reaches a text. The
part types form a closed set; each part MAY carry `ext`:

| type | members | notes |
| --- | --- | --- |
| `text` | `text` | |
| `media` | `media_type`?, `source` | `source.type` is `url`, `base64`, `file` or `digest` (`sha256`, `bytes`) |
| `tool_call` | `id`, `name`, `args` | `args` is an object; a provider's JSON string is parsed on projection and re-serialized on write-back, with the original string kept in `ext` when the two differ |
| `tool_result` | `call_id`, `content` (parts), `is_error` | |
| `reasoning` | `text`?, `opaque`? | `opaque` is a provider token the host returns unchanged: a signature, redacted data, encrypted content |
| `refusal` | `text` | |
| `unknown` | none | the provider object sits under `ext`; a policy that must see everything denies on it |

Rules:

1. The system prompt is the leading `system` message. A host hoists an
   Anthropic `system` member or Responses `instructions` into it and
   restores it on write-back.
2. A provider `developer` role projects to `system` with the original
   role under `ext`.
3. Tool results sit in a `tool` message: one per provider tool message,
   or one per Anthropic user turn that carries `tool_result` blocks.
4. The host keeps provider order. The index of a part is not stable
   across providers; a policy finds a part by `type`.
5. A tool call whose argument string does not parse projects as an
   `unknown` part, never as a `tool_call` with empty arguments.
6. Every text the model will read appears in a `text` part. Media bytes
   SHOULD be carried as `url`, `file` or `digest`; a host that inlines
   `base64` says so in its claim.

### 3. The extension slot

`ext` is a map keyed by a registered format name or a §4.6 namespace.
The host passes it through untouched and restores it on write-back. A
transform whose path enters `ext` is `host_error:transform_target_forbidden`.
A transform that changes a `reasoning.opaque` value is
`host_error:transform_invalid`. `ext` is excluded from the §10.2
identity projection, as optional members are today.

### 4. Formats and the escape hatch

`format` names the wire shape the host projected from. The
specification registers three: `openai.chat`, `openai.responses`,
`anthropic.messages`. A registered format has a projection and a
write-back in every SDK and golden vectors in the CTK.

`custom.<namespace>` is the escape hatch for a host whose model API is
none of the registered ones. Such a host MUST still fill `messages` with
every text the model reads, the roles, and the tool calls and results
it can identify; it MAY carry the rest as `unknown` parts and under
`ext`. It declares `model_request_transform: true | false`. Under
`true`, a transform on the prescribed fields reaches the real request.
Under `false`, a `transform` verdict at `pre_model_call` is
`host_error:transform_target_forbidden`, recorded as such, and the claim
says so. What a policy may rely on under a custom format: a deny decided
on `messages` text is sound, a transform is applied or rejected and
never dropped, and an `unknown` part is visible as such.

The host declaration gains two OPTIONAL `surface` members,
`model_request_formats` (the set of format names the host emits) and
`model_request_transform` (REQUIRED when the set contains a custom
format). The §13.3 claim states both.

### 5. post_model_call in step

```jsonc
"response": {
  "format": "<same registry>",
  "content": [ <part>, ... ],
  "tool_calls": [ { "id": "string", "name": "string", "args": {} }, ... ],
  "finish_reason": "stop" | "length" | "tool_calls" | "content_filter" | "refusal" | "other",
  "ext": {}
}
```

`content` becomes an array of the same parts; `tool_calls` is unchanged
and a provider's tool-use block is not repeated in `content`;
`finish_reason` takes the closed vocabulary above with the provider's
own value under `ext`. §12.1 is untouched: the host assembles the stream,
then projects.

### 6. Experimental marking

The draft specification labels `request` and `response` "Experimental
(P-010)": the shape may change in a minor revision of the draft, the
CTK part `model_request/projection` is gated on the capability
`model_request_shape`, and a host that does not declare the capability
keeps the 0.1 `messages` shape for the draft's lifetime with its claim
saying so. The label comes off when two independent hosts with two
different registered formats pass the part in one release. The
general definition of "experimental" belongs with P-009; this proposal
states what it needs from it.

### 7. Reference projections

The Rust core owns the three projections and their write-backs; the
other SDKs bind to them. The prototype's Python is the specification of
behaviour, not the implementation. Each projection is a table from
provider member to part member plus a residue rule, so a fourth format
is a table, not a design.

## Adopted schema

- `spec/schema/agent-context.schema.json` (draft copy): `$defs.request`,
  `$defs.message`, `$defs.part`; `pre_model_call` requires `model` and
  `request`; `response.content` becomes an array of parts and `response`
  gains `format`; `tools` leaves §4.5.
- Per-point closed schemas regenerated.
- The host declaration contract, next minor: `surface.model_request_formats`,
  `surface.model_request_transform`.
- `conformance/vectors.schema.json`: capability `model_request_shape`.
- `conformance/vectors/`: the part `model_request/projection`, built
  from the prototype fixtures: nine projection vectors, fifteen edit
  vectors, six response vectors, plus the identity and rejection cases
  below.

## SDK surface

- Builders take `request` (and `content` as parts at `post_model_call`)
  in place of `messages`; the `messages` form stays accepted during the
  draft and emits the 0.1 shape when the host has not declared
  `model_request_shape`.
- `project(format, payload)` and `restore(request)` for the three
  registered formats; `format` validation; `ext` pass-through.
- The identity path excludes `ext`.
- The §5 gate rejects transforms under `ext` and transforms that change
  `opaque`.

## Per-host changes

| host | today | change | basis |
| --- | --- | --- | --- |
| Copilot SDK | the integration under review passes the runtime's request messages through unchanged | call the SDK projection for the wire format of each model call (chat completions and Responses style requests; Anthropic when the user brings their own model, per the public Copilot CLI documentation), restore on write-back, carry `tools` in `request.tools`, declare the formats | review and public docs; the runtime's internals are an assumption |
| agent-framework | emits its own content records; tools as `{name, description}`; model id from the chat options | map content records to parts (`text` to `text`, `text_reasoning` with its protected data to `reasoning` with `opaque`, `data` and `uri` to `media`, `function_call` to `tool_call` with parsed arguments, `function_result` to `tool_result`); the inverse in the write-back codec; `format` from the chat client when it knows its wire shape, else `custom.agent_framework` | adapter source |
| ACS | its model-request target is already an object with `messages`, `model` and `tools`; policies read `content` as a string | accept `request` as `model_request`; update the example policy and add a helper that returns the text of a message | ACS specification §4 and example |
| AI Gateway | sits on the provider wire | project from the registered format of each route and write back the same way; declare formats per route | assumption |
| WorkIQ | builds requests in its own orchestrator | project from the provider request it builds, or declare `custom.workiq` with text completeness and a transform posture | assumption |

## Conformance and tests

| Case | Expected result |
| --- | --- |
| each registered format, each fixture | projection equals the golden request; write-back equals the fixture after normalization |
| the three edits, each format | write-back equals the same edit made natively |
| a transform under `ext` | `host_error:transform_target_forbidden` |
| a transform that changes `opaque` | `host_error:transform_invalid` |
| a cache marker moves between two requests | identical identity |
| one character of user text changes | different identity |
| a tool is removed by transform | the provider request carries the remaining tools; identity differs from the untouched request |
| a custom format with `model_request_transform: false` receives a transform | `host_error:transform_target_forbidden`, recorded |
| an `unknown` part is present | conformant; a deny on it enforces |
| a tool call with an unparseable argument string | projected as `unknown` |
| provider responses with reasoning, refusal, tool calls | parts as stated; tool calls not repeated; `finish_reason` mapped with the provider value under `ext` |
| a host without `model_request_shape` | the part is skipped; the 0.1 `messages` shape validates |

## Security and privacy

| Risk | Treatment |
| --- | --- |
| A host hides model-visible text under `ext` or in an `unknown` part | text completeness is a MUST; golden vectors check it for registered formats; a custom host states it in the claim; a policy can deny on `unknown` |
| Provider bookkeeping perturbs an approval binding | `ext` is outside the identity |
| A transform strips a signature and the provider rejects the next call | `opaque` is immutable under transform; reasoning parts are carried, not dropped |
| Media bytes in the context (size, retention, exfiltration surface) | `digest` source type; `url` and `file` preferred; §12.3 bounds apply; inlining is a claimed posture |
| Malformed tool arguments bypass an argument policy | unparseable arguments project as `unknown` |
| A host declares one format and emits another | the CTK checks the declared formats against the projections it can verify |

## Compatibility and versioning

Replacing the conditional field `messages` with `request`, changing
`response.content`, and moving `tools` are changes to required and
conditional context fields: spec MAJOR class under VERSIONING.md and a
proposal-required class under the proposals README. The group chose to
iterate the next revision in a draft folder under `spec/`, to call the
round a minor bump, and to hide as much of the break as possible inside
the SDKs. The tension is real: a 0.1 host that emits `messages` is not
conformant to the draft, and a draft host that emits `request` fails
0.1 validation. This proposal takes no position on the version string.
It asks P-009, which settles the core fields in parallel, for two
things: the definition of an experimental label, and the rule for a
host that straddles the two shapes while the draft lives. The SDK
builders can accept both forms during that time and emit the draft
shape only when the host declares `model_request_shape`.

The declaration contract change is minor: two OPTIONAL members, absent
means the 0.1 meaning. The identity preimage at `pre_model_call` changes
with the shape, so identities for the same conversation differ between
0.1 and the draft; approvals bind within a session and do not cross
versions.

## Rejected shortcuts

- `content: string | parts` as a dual form. It saves bytes and costs a
  second path shape for every edit (measured on A).
- Tool arguments as a JSON string.
- The raw provider payload beside the neutral one (option C).
- Hashing `ext`.
- Inlining media bytes by default.
- Calling the shape "OpenAI-compatible" or "LiteLLM-compatible".
  LiteLLM's unified input is the chat completions parameter set plus
  provider pass-through, and it also serves the Anthropic Messages
  format on a second endpoint; its answer to this problem is two formats
  and a side channel for reasoning, not one shape.
- A per-host mapping profile. A host declares the formats it emits;
  the registry of formats replaces per-host profiles.

## Open questions

1. Field placement: `request` wrapping `messages` and `tools`, or
   `messages`, `tools` and `format` as siblings at the top level.
   Recommendation: `request`, because the transform root must cover the
   tool set.
2. Whether a `custom.*` host may omit `model_request_transform`.
   Recommendation: REQUIRED for custom formats.
3. The first registry: the three formats above. The Copilot API shape
   named in the discussion was not verifiable from public documentation
   during this work; add it once its owners confirm the request shape.
4. Whether the agent-framework adapter declares the wire format per
   chat client or `custom.agent_framework`. Recommendation: per client
   when the client knows its wire shape.
5. Media policy: references and digests by default, bytes only under a
   declared posture, or bytes allowed up to a size. Recommendation: the
   first.
6. Whether `input` and `output` adopt the part vocabulary now or in a
   later proposal. Recommendation: later.
7. The exit criterion for the experimental label. Recommendation: two
   independent hosts, two registered formats, one release.

## Decision

Pending. The prototypes and their output are under `p010-prototypes/`;
`python3 run.py` reproduces every table above.

## Sources

Verified during this work:

- OpenAI chat completions and Responses request and response types:
  the `openai-python` repository, `src/openai/types/chat/` and
  `src/openai/types/responses/` on the `main` branch (message, content
  part, tool call, tool message, reasoning item, function call and
  output, input image, output text, finish reason).
- Anthropic Messages API: the Claude platform documentation for the
  Messages API (system blocks with `cache_control`, `tool_use` and
  `tool_result` blocks, `thinking` blocks with `signature`,
  `redacted_thinking`, image sources, `stop_reason` values).
- LiteLLM documentation: "Input Params" (the chat completions
  parameter set as the unified input; non-OpenAI parameters passed
  through), "Reasoning Content" (`reasoning_content`, `thinking_blocks`,
  the Anthropic rejection of an assistant turn without its thinking
  blocks), and the `/v1/messages` endpoint page (the Anthropic Messages
  format served across providers).
- GitHub documentation, Copilot CLI "bring your own key": OpenAI
  chat-completions-compatible, Azure OpenAI and Anthropic provider
  types.
- agent-framework: `python/packages/core/agent_framework/_agent_hooks.py`
  and `_types.py`.
- ACS: `spec/SPECIFICATION.md` §4 and `examples/bank_agent/`.
- This repository: spec §4.2 to §4.6, §5.2, §10.2, §12, §13;
  `sdk/rust/core/src/canonical.rs` (the `pre_model_call` projection);
  the five builders; `sdk/python/python/agent_hooks/ctk/reference.py`.

Not verified: the GitHub Copilot API request shape. Statements about
the Copilot SDK runtime beyond its public documentation and the review
are assumptions and are marked as such above.
