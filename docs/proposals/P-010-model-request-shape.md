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

## Formats in the wild

Fourteen message formats were read from their public references, adoption
numbers were collected with their dates, and the same three policy tasks
were written against seven of them as targets (Appendices A to C). Four
findings bear on the choice.

1. The provider wires disagree exactly where a policy looks. Anthropic,
   Gemini and Bedrock carry tool arguments as objects; the OpenAI chat,
   Responses and Azure wires carry a JSON string. Anthropic, Gemini and
   Bedrock put tool results inside a user-role turn; chat completions and
   the library abstractions give them a `tool` role; Responses makes them
   a typed item. The system prompt is a message (chat completions), a
   top-level member (Anthropic `system`, Responses `instructions`, Bedrock
   `system`, Gemini `systemInstruction`), or either. Media is a URL or
   data URL (OpenAI), base64, URL or file (Anthropic), base64 or a file
   URI (Gemini), bytes or an S3 location and nothing else (Bedrock).
2. The library abstractions agree with each other and with the neutral
   shape. The AI SDK `ModelMessage`, LangChain v1 content blocks,
   Microsoft.Extensions.AI `AIContent`, the agent-framework Python
   `Content`, Semantic Kernel `KernelContent` items and the OpenTelemetry
   GenAI message schema all model a message as a role plus an array of
   typed parts: text, media, a tool call with object arguments, a tool
   result keyed by call id, and in all but OpenTelemetry and Semantic
   Kernel a reasoning part with an opaque provider token. Every one of
   them has a provider-metadata slot. The AI SDK shape round-trips the
   nine fixture pairs exactly through `providerOptions`, as the neutral
   shape does through `ext`.
3. Adoption splits by layer. Chat completions is the most emitted wire:
   the OpenAI SDKs lead the provider SDKs on PyPI (295.9M downloads a
   month), Azure AI Inference and LiteLLM take the same parameter set,
   and 81.4% of Stack Overflow's 2025 respondents used an OpenAI GPT model
   in the past year. The production mix is plural all the same: Anthropic
   32%, OpenAI 25% and Google 20% of enterprise API usage in Menlo
   Ventures' mid-2025 survey, Claude Sonnet used by 42.8% of the same
   Stack Overflow respondents, and the Anthropic SDK ahead of the OpenAI
   SDK on npm (175.0M against 160.7M a month). The abstraction layers are
   large: LangChain at 170.5M PyPI downloads a month, the AI SDK at 113.7M
   npm downloads a month, Microsoft.Extensions.AI.Abstractions at 135.0M
   NuGet downloads in total.
4. Policy ergonomics follow the shape, not the vendor. Across the seven
   targets, the neutral shape and the AI SDK shape were the only two with
   one path shape per task, nine of nine exact write-backs for both
   transforms and no round-trip loss. Chat completions needed two
   user-text path shapes and lost reasoning or cache markers on four of
   nine pairs. Anthropic Messages needed the most locator code (52 lines)
   because tool results and the system prompt each live in two places and
   a user turn can be a tool-result carrier. Gemini and Bedrock read
   compactly and lost the most on write-back (five of nine pairs; Bedrock
   has no block for a URL image).

What most harnesses can emit today without new projection code: a host
that calls an OpenAI-compatible endpoint (OpenAI, Azure OpenAI, Azure AI
Inference, a LiteLLM or OpenRouter proxy, Ollama, vLLM, the Copilot CLI
`openai` provider type) already holds chat-completions messages. A host
built on an abstraction (agent-framework, Semantic Kernel, LangChain, the
AI SDK, LiteLLM as a library) holds a parts model from which chat
completions (through its own OpenAI connector) and the neutral shape (a
rename of part types) are each one mapping away. Only a host on the
Anthropic, Responses, Gemini or Bedrock wire holds that shape natively.
The GitHub Copilot API request shape stays unverified from official
documentation; third-party descriptions call it chat-completions
compatible.

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
  rejects an assistant turn sent back without its thinking blocks when
  tool results follow it.
  A transform written against this shape strips them on write-back
  (measured: the `chart` edits on an Anthropic source).
- Tool arguments are a JSON string. A policy parses before it can read
  one field, and a policy language without a JSON parser cannot.
- Tool results carry text only: no error flag, no media.
- Cache markers, item ids and status are lost (measured).
- It is one vendor's format on its own release schedule. Conformance
  would pin a subset of another organization's specification, and the
  discussion did not expect a lab to adopt a competitor's format.


### A2. Another provider wire as the one shape

Gemini `contents` and `parts`, or Bedrock Converse `messages` with content
blocks, prescribed for every host.

**Advantages**

- Both carry tool arguments as objects, reasoning text with a signature,
  and parts arrays, so the three policy tasks need one path shape each
  (Appendix C).
- Converse is built as one interface over many models: AWS documents it
  as "a consistent interface that works with all models that support
  messages", and the Bedrock catalog lists nineteen model providers.

**Disadvantages**

- Each is one vendor's format on that vendor's schedule, with the same
  objection as option A and a smaller share of harnesses already emitting
  it (Appendix B).
- Gemini's `functionResponse` needs the tool name and an object, so a
  projection into it joins results to calls and wraps text; Bedrock has
  no block for a URL image, so a projection into it must fetch bytes.
  Measured: four of nine edits written back exactly for either, five of
  nine pairs lossy.
- Tool results sit inside a user-role turn in both, so a "latest user
  turn" policy must skip carrier turns.

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


### E. Adopt an existing neutral abstraction verbatim

Prescribe the OpenTelemetry GenAI message schema (`gen_ai.input.messages`:
role plus `text`, `tool_call`, `tool_call_response` and generic parts) or
the AI SDK `ModelMessage` as the request shape.

**Advantages**

- Nothing new to design, and a telemetry exporter or an AI SDK host needs
  no mapping.
- The OpenTelemetry schema is vendor-neutral under CNCF governance, has a
  JSON schema with test cases, and allows extra properties everywhere.
- The AI SDK shape round-trips the nine fixture pairs exactly (Appendix
  C).

**Disadvantages**

- The OpenTelemetry conventions are at Development stability, name text
  `content` and results `response`, define no media or reasoning part
  (both fall to the generic part), and are a capture format: nothing
  says how a host writes a transform back.
- The AI SDK shape is a library type under one company's control and
  versioned with the SDK (the current major deprecates `ImagePart` in
  favour of `FilePart`, and its reference page and source disagreed on
  the tool-call argument member when retrieved); it carries SDK concepts
  such as `providerExecuted` and `execution-denied`.
- Neither covers `tools`, so the transform root still needs a request
  object around it.

### Comparison

Measured columns come from Appendix C (nine fixture and source pairs,
three tasks); the last two columns from Appendices A and B.

| shape | lossy pairs | write-back exact | user-text paths | locator lines | tool args | controlled by |
| --- | --- | --- | --- | --- | --- | --- |
| A chat completions | 4/9 | 5/9 | 2 | 33 | string | OpenAI |
| A2 Gemini | 5/9 | 4/9 | 1 | 30 | object | Google |
| A2 Bedrock Converse | 5/9 | 4/9 | 1 | 44 | object | AWS |
| Responses items | 2/9 | 7/9 | 1 (2 allowed) | 38 | string | OpenAI |
| Anthropic Messages | 4/9 | 5/9 | 2 | 52 | object | Anthropic |
| B neutral | 0/9 | 9/9 | 1 | 33 | object | this specification |
| C raw union | 0/9 | 9/9, summary stale | one set per format | per format | per format | each vendor |
| D loose | host defined | not portable | per host | per host | per host | each host |
| E AI SDK ModelMessage | 0/9 | 9/9 | 1 | 47 | object | Vercel |
| E OpenTelemetry GenAI | not run | no write-back rule | 1 | not run | any | CNCF, Development status |

## Recommended normative semantics

Option B, with the `format` discriminator and the escape hatch of
option C folded in as the extension mechanism. Marked experimental.

The survey and the ergonomics run do not change this recommendation.
They change two details of the shape, both below: a tool result may
carry the tool name, because two surveyed formats require it on the
result; and the specification states how the part vocabulary maps onto
the OpenTelemetry GenAI message parts and the AI SDK parts, so one
projection serves control and telemetry. The case per format, in brief:

- Chat completions: the widest-emitted wire and the smallest payload;
  string arguments, no reasoning slot, two content forms, lossy for
  Anthropic and Responses hosts.
- Responses items: typed items and ids; string arguments, the system
  prompt in two possible places, one vendor's newest format.
- Anthropic Messages: object arguments and the richest block set; tool
  results inside user turns, the system prompt in two places, the most
  locator code, one vendor's format.
- Gemini and Bedrock: object arguments and reasoning slots; results
  inside user turns, media carriage limits, one vendor's format each.
- The library abstractions (AI SDK, LangChain, Microsoft.Extensions.AI,
  agent-framework, Semantic Kernel): the same role-plus-parts model as
  the neutral shape with a metadata slot; each belongs to one project
  and moves with its releases.
- OpenTelemetry GenAI messages: neutral governance and a schema, but a
  capture format at Development stability without media, reasoning or a
  write-back rule.
- The neutral shape: one path shape per task, exact write-back, loss
  limited to provider bookkeeping, a schema this group can test; its
  cost is a projection per host and up to 55% more bytes than the raw
  wire on text-only turns.

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
| `tool_result` | `call_id`, `name`?, `content` (parts), `is_error` | `name` is the tool's name, carried when the host knows it; Gemini and the AI SDK require it on the result and a projection into them otherwise joins the result to its call |
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
7. The specification carries two informative mappings: part type to the
   OpenTelemetry GenAI message parts (`text` to `text` with `content`,
   `tool_call` to `tool_call`, `tool_result` to `tool_call_response`,
   the rest to a generic part) and to the AI SDK `ModelMessage` parts.
   A host that emits the neutral shape can emit either with a rename.

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
   Recommendation: REQUIRED for custom formats. Evidence: every surveyed
   abstraction has a provider-metadata slot and every provider wire lacks
   one for another provider's members, so a custom host can always fill
   text, roles, calls and results and park the rest in `ext`; and even
   registered wires have write-back limits (Bedrock cannot carry a URL
   image, Gemini wraps a text result in an object), so a declared
   transform posture is a statement every host needs, not a corner case
   (Appendices A and C).
3. The first registry: the three formats above. The Copilot API shape
   named in the discussion was not verifiable from public documentation
   during this work; add it once its owners confirm the request shape.
4. Whether the agent-framework adapter declares the wire format per
   chat client or `custom.agent_framework`. Recommendation: per client
   when the client knows its wire shape.
5. Media policy: references and digests by default, bytes only under a
   declared posture, or bytes allowed up to a size. Recommendation: the
   first. Evidence: the wires disagree on carriage (OpenAI URL or data
   URL or file id; Anthropic base64, URL or file; Gemini base64 or file
   URI; Bedrock bytes or S3 location only), so a write-back may need the
   bytes whatever the context carries, and the host that holds them is
   the host; a 100 KiB image costs 133 KB in every inlining target and
   under 600 bytes as a digest; the library abstractions all accept a
   reference form (AI SDK `url` and `reference`, LangChain `url` and
   `id`, Microsoft.Extensions.AI `UriContent`), so a digest or reference
   rule costs them nothing (Appendices A and C).
6. Whether `input` and `output` adopt the part vocabulary now or in a
   later proposal. Recommendation: later.
7. The exit criterion for the experimental label. Recommendation: two
   independent hosts, two registered formats, one release.

## Decision

Pending. The prototypes and their output are under `p010-prototypes/`;
`python3 run.py` reproduces every table above.

## Appendix A: message formats in the wild

Each entry: what kind of thing the format is, its shape in one line, how
it models parts, tool calls, tool results, reasoning, media and provider
metadata, and who controls it. Field names were read from the linked
references on 2026-10-28. "Not verified" marks what the reference did not
show.

| format | kind | controlled by | reference |
| --- | --- | --- | --- |
| OpenAI chat completions | wire request | OpenAI; SDK Apache-2.0 | [types](https://github.com/openai/openai-python/tree/main/src/openai/types/chat), [API](https://platform.openai.com/docs/api-reference/chat/create) |
| OpenAI Responses | wire request | OpenAI; SDK Apache-2.0 | [types](https://github.com/openai/openai-python/tree/main/src/openai/types/responses), [API](https://platform.openai.com/docs/api-reference/responses/create) |
| Anthropic Messages | wire request | Anthropic; SDK Apache-2.0 | [API](https://platform.claude.com/docs/en/api/messages) |
| Gemini generateContent | wire request | Google; SDK Apache-2.0 | [API](https://ai.google.dev/api/generate-content) |
| Bedrock Converse | wire request | AWS; SDK Apache-2.0 | [Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html), [ContentBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ContentBlock.html) |
| Azure AI Inference and Azure OpenAI | wire request | Microsoft; SDK MIT | [Model Inference](https://learn.microsoft.com/rest/api/microsoft-foundry/modelinference/), [Azure OpenAI components](https://learn.microsoft.com/azure/foundry/openai/reference#components) |
| LiteLLM unified input | library over wires | BerriAI; MIT (enterprise directory excepted) | [input](https://docs.litellm.ai/docs/completion/input), [reasoning](https://docs.litellm.ai/docs/reasoning_content), [Anthropic endpoint](https://docs.litellm.ai/docs/anthropic_unified) |
| AI SDK ModelMessage and UIMessage | library abstraction | Vercel; Apache-2.0 | [source](https://github.com/vercel/ai/blob/main/packages/provider-utils/src/types/content-part.ts), [ModelMessage](https://ai-sdk.dev/docs/reference/ai-sdk-core/model-message), [UIMessage](https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message) |
| LangChain messages | library abstraction | LangChain; MIT | [messages](https://docs.langchain.com/oss/python/langchain/messages) |
| Microsoft Agent Framework | library abstraction | Microsoft; MIT | [.NET types](https://learn.microsoft.com/dotnet/api/microsoft.extensions.ai.aicontent), [Python source](https://github.com/microsoft/agent-framework/blob/main/python/packages/core/agent_framework/_types.py) |
| Semantic Kernel ChatMessageContent | library abstraction | Microsoft; MIT | [.NET](https://learn.microsoft.com/dotnet/api/microsoft.semantickernel.kernelcontent), [Python](https://learn.microsoft.com/python/api/semantic-kernel/semantic_kernel.contents.chat_message_content.chatmessagecontent) |
| A2A Message and Part | agent protocol | A2A project (joining the Agentic AI Foundation); Apache-2.0 | [specification 1.0.0](https://a2a-protocol.org/latest/specification/) |
| OpenTelemetry GenAI messages | telemetry schema | CNCF; Apache-2.0; Development status | [events](https://github.com/open-telemetry/semantic-conventions/blob/v1.37.0/docs/gen-ai/gen-ai-events.md), [schema](https://github.com/open-telemetry/semantic-conventions/blob/v1.37.0/docs/gen-ai/gen-ai-input-messages.json), [new repository](https://github.com/open-telemetry/semantic-conventions-genai) |
| GitHub Copilot API | wire request | GitHub | not verified from official documentation |

### OpenAI chat completions

`{model, messages: [{role, content}], tools}`.
Roles `developer`, `system`, `user`, `assistant`, `tool`; `content` a
string or parts (`text`, `image_url`, `input_audio`, `file`, `refusal`).
Tool call: `tool_calls[{id, type: "function", function: {name, arguments:
<JSON string>}}]` on the assistant message. Tool result: a `tool` message
with `tool_call_id` and string or text-part content; no error flag.
Reasoning: no member. Media: `image_url.url` (URL or data URL), `file`
(`file_id` or `file_data`). Metadata: `name` per message and
`prompt_cache_breakpoint` on parts; nothing else.

### OpenAI Responses

`{model, instructions, input: [item], tools}`. Items:
`message` (roles `user`, `system`, `developer`, content `input_text`,
`input_image`, `input_file`; assistant output messages with `id`,
`status`, `output_text`, `refusal`), `function_call` (`call_id`, `name`,
`arguments: <JSON string>`, `id`, `status`), `function_call_output`
(`call_id`, `output` string or list, `id`, `status`), `reasoning` (`id`,
`summary`, `content`, `encrypted_content`, `status`), plus server tool
items. Media: `input_image.image_url` or `file_id`. Metadata: item
`id` and `status`.

### Anthropic Messages

`{model, system, messages: [{role, content}],
tools, max_tokens}`. Roles `user`, `assistant` and, per the current
reference, `system`; `content` a string or blocks: `text`, `image`,
`document`, `tool_use` (`id`, `name`, `input: object`), `tool_result`
(`tool_use_id`, string or blocks, `is_error`), `thinking` (`thinking`,
`signature`), `redacted_thinking` (`data`), server tool blocks. Media:
`source` of type `base64`, `url` or `file`. Metadata: `cache_control` on
blocks.

### Gemini generateContent

`{contents: [{role: "user" | "model", parts}],
systemInstruction: {parts}, tools: [{functionDeclarations}], cachedContent}`.
Parts: `text`, `inlineData` (`mimeType`, `data`), `fileData` (`fileUri`,
`mimeType`), `functionCall` (`id`?, `name`, `args: object`),
`functionResponse` (`id`?, `name`, `response: object`), `thought`
(boolean) with `thoughtSignature`, `executableCode`, `codeExecutionResult`;
`partMetadata` is a generic struct. Tool results travel in a `user` turn
and need the tool name.

### Bedrock Converse

`{messages: [{role: "user" | "assistant" | "system",
content: [block]}], system: [{text} | {cachePoint}], toolConfig: {tools:
[{toolSpec: {name, description, inputSchema: {json}}}]}}`. Blocks: `text`,
`image` (`format`, `source: {bytes | s3Location}`), `document`, `video`,
`toolUse` (`toolUseId`, `name`, `input: JSON`), `toolResult` (`toolUseId`,
`content: [{text | json | image | document}]`, `status: success | error`),
`reasoningContent` (`reasoningText: {text, signature}` or
`redactedContent`), `cachePoint`, `guardContent`. Media: bytes or S3 only.
Metadata: request-level `additionalModelRequestFields`. `stopReason`
includes `end_turn`, `tool_use`, `max_tokens`, `guardrail_intervened`,
`content_filtered`.

### Azure AI Inference and Azure OpenAI

The chat-completions shape:
`messages` with roles `developer`, `system`, `user`, `assistant`, `tool`,
`function`; content parts `text`, `file`, `input_audio`, `image_url`,
`refusal`; tool calls with string arguments. Model-specific members pass
through under the `extra-parameters: pass-through` header. Microsoft's own
guidance now migrates Azure AI Inference SDK users to the OpenAI SDK.

### LiteLLM

Input is the chat-completions parameter set, translated per
provider; any non-OpenAI parameter is passed through as provider
specific. Reasoning comes back as `reasoning_content` and, for Anthropic,
`thinking_blocks[{type, thinking, signature}]`, which must be sent back
or the Anthropic API rejects the turn. A second endpoint serves the
Anthropic Messages format across providers. 137 entries on its providers
page.

### AI SDK ModelMessage and UIMessage (v7.0.155 on `main`)

`ModelMessage` is
`system` (string content), `user` (`text`, `file`, deprecated `image`),
`assistant` (`text`, `reasoning`, `tool-call` with `toolCallId`,
`toolName`, `input: unknown`, `file`, `custom`) or `tool` (`tool-result`
with `toolCallId`, `toolName`, `output` of type `text`, `json`,
`error-text`, `error-json`, `execution-denied` or `content`). Every part
takes `providerOptions`. `FilePart.data` is data, a URL or a provider
reference. The reference page retrieved listed the tool-call argument
member as `args`; the source file uses `input`. `UIMessage` is `{id, role,
parts, metadata}` with `text`, `reasoning`, `tool-<name>` states,
`source-url`, `source-document`, `file`, `data-<name>`, `step-start`.

### LangChain messages (v1)

`SystemMessage`, `HumanMessage`, `AIMessage`
(`content`, `content_blocks`, `tool_calls[{name, args: dict, id}]`,
`usage_metadata`, `response_metadata`), `ToolMessage` (`tool_call_id`,
`name`, `content`, `artifact`). Standard blocks: `text`, `reasoning`,
`image`, `audio`, `video`, `file` (`url`, `base64`, `id`, `mime_type`),
`tool_call`, `tool_call_chunk`, `invalid_tool_call`, `server_tool_call`,
`server_tool_result`, `non_standard` (`value`). 94 chat model integrations
listed.

### Microsoft Agent Framework

.NET: `ChatMessage {Role, Contents:
IList<AIContent>}` from Microsoft.Extensions.AI; `AIContent` subtypes
`text`, `reasoning`, `data`, `uri`, `functionCall` (`CallId`, `Name`,
`Arguments: IDictionary`), `functionResult`, `usage`, `error`,
`hostedFile`, tool-approval and server-tool contents; every content has
`AdditionalProperties` and `RawRepresentation`. Python: `Message(role,
contents: [Content])` with `type` in `text`, `text_reasoning`
(`protected_data`), `data`, `uri`, `function_call` (`arguments: str |
Mapping`), `function_result`, `error`, `usage`, `hosted_file`, plus
`additional_properties` and `raw_representation`. Ten model-provider
packages in the Python repository (Anthropic, Bedrock, Claude, Foundry,
Foundry Local, Gemini, GitHub Copilot, Mistral, Ollama, OpenAI).

### Semantic Kernel

`ChatMessageContent(role, items, content,
inner_content, metadata)`; items are `KernelContent` subtypes
`TextContent`, `ImageContent`, `AudioContent`, `BinaryContent`,
`FunctionCallContent` (`id`, `name`, `arguments: str | Mapping` in Python,
`KernelArguments` in .NET), `FunctionResultContent`, `FileReferenceContent`,
`AnnotationContent`. No reasoning content type in the v1.45.0 .NET
reference. Provider payload reachable through `InnerContent`.

### A2A Message and Part (1.0.0)

`Message {messageId, role: ROLE_USER |
ROLE_AGENT, parts, taskId, contextId, metadata, extensions,
referenceTaskIds}`; a `Part` holds exactly one of `text`, `raw` (base64
bytes), `url` or `data` (any JSON), plus `metadata`, `filename`,
`mediaType`. No tool call or tool result: tools are internal to an agent.

**OpenTelemetry GenAI messages (semantic conventions v1.37.0; moved to
their own repository, no release there yet).** Event
`gen_ai.client.inference.operation.details`, opt-in attributes
`gen_ai.input.messages`, `gen_ai.output.messages`,
`gen_ai.system_instructions`. A message is `{role, parts}`; parts are
`text` (`content`), `tool_call` (`id`, `name`, `arguments: any`),
`tool_call_response` (`id`, `response: any`) or any other `type`
(generic); every object allows additional properties. Output messages
carry `finish_reason`. No media or reasoning part. Stability:
Development.

### GitHub Copilot API

Not verified from official documentation during
this work; the GitHub Models inference API that documented an
OpenAI-compatible chat endpoint was retired on 2026-07-30 per its
documentation page. Third-party descriptions of the Copilot endpoint
call it chat-completions compatible. The public Copilot CLI
documentation lists three bring-your-own-key provider types:
OpenAI-compatible, Azure OpenAI and Anthropic.

## Appendix B: adoption evidence

Numbers as retrieved on 2026-10-28 unless the row says otherwise.
Download counts are a proxy for how many harnesses hold a given shape in
code, not for traffic.

Surveys and traffic:

| signal | value | period and sample | source |
| --- | --- | --- | --- |
| LLMs used for development work in the past year | OpenAI GPT 81.4%, Claude Sonnet 42.8%, Gemini Flash 35.3%, OpenAI Reasoning 34.6%, Gemini Reasoning 25.6%, DeepSeek Reasoning 23.3%, Meta Llama 17.8%, Mistral 10.4% | 2025, 16,474 responses | [Stack Overflow Developer Survey 2025](https://survey.stackoverflow.co/2025/technology) |
| Enterprise LLM API usage share | Anthropic 32%, OpenAI 25%, Google 20%, Meta 9%, DeepSeek 1% | June 30 to July 10, 2025; 150 technical decision-makers | [Menlo Ventures mid-year update](https://menlovc.com/perspective/2025-mid-year-llm-market-update/) |
| Code generation share | Claude 42%, OpenAI 21% | same survey | same |
| Token share on one router | proprietary models about 70% of weekly token volume; Anthropic above 60% of the programming category for most of the period | Nov 2024 to Nov 2025, over 100 trillion tokens | [OpenRouter State of AI](https://openrouter.ai/state-of-ai) (December 2025) |
| Router catalogue | 464 models from 67 model authors | public models endpoint | [OpenRouter API](https://openrouter.ai/api/v1/models) |

Packages that carry each shape (GitHub stars; npm downloads for
2026-09-27 to 2026-10-26; PyPI downloads for the last month per pypistats;
NuGet downloads are all-time totals):

| shape | package or repository | stars | npm per month | PyPI per month | NuGet total |
| --- | --- | --- | --- | --- | --- |
| OpenAI chat and Responses | openai-python, openai-node, `openai` | 31,977; 11,238 | 160.7M | 295.9M | 88.2M (OpenAI) |
| Anthropic Messages | anthropic-sdk-python, anthropic-sdk-typescript | 4,014; 2,156 | 175.0M | 150.2M | 4.2M (Anthropic.SDK) |
| Gemini generateContent | python-genai, js-genai | 4,046; 1,693 | 92.3M | 137.6M | |
| Bedrock Converse | `@aws-sdk/client-bedrock-runtime`, boto3 | | 56.9M | boto3 2,446M (all AWS) | 52.0M (AWSSDK.BedrockRuntime) |
| Azure AI Inference | `@azure-rest/ai-inference`, `azure-ai-inference` | | 0.35M | 3.7M | |
| LiteLLM | BerriAI/litellm | 62,213 | | 92.2M | |
| AI SDK | vercel/ai, `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic` | 27,557 | 113.7M; 57.8M; 56.1M | | |
| LangChain | langchain, langchainjs, `@langchain/core`, `langchain-core` | 148,600; 18,300 | 23.5M | 170.5M; 144.8M | |
| Microsoft Agent Framework | microsoft/agent-framework, `agent-framework-core` | 14,351 | | 1.0M | 11.2M (Microsoft.Agents.AI) |
| Microsoft.Extensions.AI | dotnet/extensions | 3,271 | | | 135.0M (Abstractions) |
| Semantic Kernel | microsoft/semantic-kernel | 28,710 | | 0.30M | 18.3M |
| A2A | a2aproject/A2A, `@a2a-js/sdk`, `a2a-sdk` | 26,318 | 14.5M | 11.4M | |
| OpenTelemetry semantic conventions | open-telemetry/semantic-conventions | 676 | 425.6M (all conventions) | 277.8M (all conventions) | |
| GitHub Copilot SDK | github/copilot-sdk, `@github/copilot-sdk`, `github-copilot-sdk` | 10,585 | 5.3M | 1.2M | |

Sources: [GitHub REST API](https://docs.github.com/rest/repos/repos#get-a-repository),
[npm downloads API](https://api.npmjs.org/downloads/point/last-month/openai),
[pypistats](https://pypistats.org/api/packages/openai/recent),
[NuGet search](https://azuresearch-usnc.nuget.org/query?q=packageid:Microsoft.Extensions.AI.Abstractions).
The OpenTelemetry and boto3 counts cover whole packages that every
tracing or AWS user pulls, so they say nothing about GenAI use.

Providers each layer maps:

| layer | count | source |
| --- | --- | --- |
| LiteLLM | 137 entries on the providers page; "100+ LLMs" in its navigation | [providers](https://docs.litellm.ai/docs/providers) |
| LangChain | 94 chat model integrations | [chat models](https://docs.langchain.com/oss/python/integrations/chat) |
| AI SDK | 17 official providers in the support table | [providers](https://ai-sdk.dev/providers/ai-sdk-providers) |
| Bedrock Converse | 19 model providers in the catalog | [models](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-supported-models-features.html) |
| OpenRouter | 67 model authors | [models API](https://openrouter.ai/api/v1/models) |
| agent-framework (Python) | 10 model-provider packages | repository `python/packages/` |
| Copilot CLI bring-your-own-key | 3 provider types | [GitHub docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models) |

## Appendix C: policy ergonomics

`python3 run.py` in `p010-prototypes/` prints this section. Each target
shape gets three locators, the only format-specific code a policy author
writes (`policies.py`): the text parts of user turns, the text of tool
results, and the system prompt. The three tasks are shared: redact a
secret in the latest user turn, deny when any tool result matches a
pattern, cap the system prompt at twenty characters. Each task runs for
the three fixtures from each of the three provider sources (nine pairs);
the two transforms are written back and compared with the same edit made
natively; the deny task runs on a copy of the tool-call fixture with the
secret leaked into the tool result and on the clean fixtures. Lines are
counted after `ruff format`.

| target shape | tool args | locator lines | user-text paths | tool-result paths | system paths |
| --- | --- | --- | --- | --- | --- |
| chat completions | JSON string | 11+11+11=33 | 2 | 1 | 1 |
| Responses items | JSON string | 11+11+16=38 | 1 | 1 | 2 |
| Anthropic Messages | object | 13+21+18=52 | 2 | 1 | 2 |
| neutral (B) | object | 8+17+8=33 | 1 | 1 | 1 |
| Gemini | object | 10+15+5=30 | 1 | 1 | 1 |
| Bedrock Converse | object | 10+23+11=44 | 1 | 1 | 1 |
| AI SDK ModelMessage | object | 11+31+5=47 | 1 | 1 | 1 |

| target shape | redact exact | PII deny (leaked, clean) | cap exact | lossy pairs | size, 9 pairs (bytes) |
| --- | --- | --- | --- | --- | --- |
| chat completions | 5/9 | 3/3, 0 false | 5/9 | 4/9 (cache marker, ids, reasoning, thinking) | 4,501 |
| Responses items | 7/9 | 3/3, 0 false | 7/9 | 2/9 (cache marker, image detail) | 6,078 |
| Anthropic Messages | 5/9 | 3/3, 0 false | 5/9 | 4/9 (image detail, ids) | 4,404 |
| neutral (B) | 9/9 | 3/3, 0 false | 9/9 | 0/9 | 6,181 |
| Gemini | 4/9 | 3/3, 0 false | 4/9 | 5/9 (cache marker, image detail, ids) | 4,719 |
| Bedrock Converse | 4/9 | 3/3, 0 false | 4/9 | 5/9 (cache marker, ids, the URL image) | 4,546 |
| AI SDK ModelMessage | 9/9 | 3/3, 0 false | 9/9 | 0/9 | 6,250 |

The neutral row carries `ext`; without it the nine targets sum to 5,480
bytes (the `B-` column of the size table above). The AI SDK row carries
the same residue in `providerOptions`.

Path shapes a policy must know, indices as `*`:

- chat completions: user `messages[*].content` and
  `messages[*].content[*].text`; tool `messages[*].content`; system
  `messages[*].content`. The string form and the parts form both occur.
- Responses items: user `input[*].content[*].text`; tool
  `input[*].output`; system `instructions` and `input[*].content[*].text`.
  The reference also allows string content on input messages, which
  would add a shape.
- Anthropic Messages: user `messages[*].content` and
  `messages[*].content[*].text`; tool `messages[*].content[*].content`;
  system `system` and `system[*].text`.
- neutral: user `messages[*].content[*].text`; tool
  `messages[*].content[*].content[*].text`; system
  `messages[*].content[*].text`.
- Gemini: user `contents[*].parts[*].text`; tool
  `contents[*].parts[*].functionResponse.response` (an object a policy
  serializes); system `systemInstruction.parts[*].text`.
- Bedrock Converse: user `messages[*].content[*].text`; tool
  `messages[*].content[*].toolResult.content[*].text` (or `.json`);
  system `system[*].text`.
- AI SDK ModelMessage: user `$target[*].content[*].text`; tool
  `$target[*].content[*].output.value` (five output variants); system
  `$target[*].content`.

What a policy writer must learn, per shape:

- Chat completions: content is a string or a parts array, so every
  text read branches; tool arguments are a JSON string to parse;
  reasoning never appears; the system prompt is the first message unless
  the host used `developer` or more than one.
- Responses items: items are typed, not role-based, so user text,
  tool calls, tool results and reasoning are four item types; the
  system prompt may be `instructions` or an item; arguments are a string;
  item ids are provider state to leave alone.
- Anthropic Messages: a user turn may be the carrier of tool results
  rather than the user speaking, so "latest user turn" needs a filter;
  tool results nest two levels; the system prompt is a string, a block
  list, or now a `system` message; arguments are objects; thinking
  blocks carry signatures a transform must not touch.
- Neutral: one rule for text (`content[*].text`), one role for tool
  results, object arguments, reasoning as a typed part with an opaque
  token, provider extras under `ext` that a transform may not address.
- Gemini: roles are `user` and `model`; tool results are
  `functionResponse` parts inside user turns with an object payload the
  policy serializes to search; reasoning is a `thought` flag on a text
  part; the system prompt lives in `systemInstruction`.
- Bedrock Converse: blocks are keyed by member name, not a `type`
  field; tool results sit in user turns and may be `json` objects;
  images arrive as bytes; the system prompt is a list of blocks.
- AI SDK ModelMessage: the closest to the neutral shape; tool results
  need the tool name and come in five output variants; a system message
  is a string; provider extras sit in `providerOptions`.

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

- Appendix A references, read on 2026-10-28: the Gemini
  `generateContent` reference, the Bedrock Converse API reference pages
  (`Converse`, `Message`, `ContentBlock`, `SystemContentBlock`,
  `ToolUseBlock`, `ToolResultBlock`, `ToolResultContentBlock`,
  `ImageBlock`, `ImageSource`, `ReasoningContentBlock`,
  `ToolSpecification`), the Azure AI Model Inference and Azure OpenAI
  REST references on Microsoft Learn, the AI SDK source and reference
  pages, the LangChain v1 messages page, the Microsoft.Extensions.AI and
  Semantic Kernel class references on Microsoft Learn, the A2A
  specification 1.0.0, the OpenTelemetry semantic conventions v1.37.0
  GenAI pages and JSON schema, the LiteLLM providers page, the LangChain
  chat integrations page, the AI SDK providers page and the Bedrock model
  catalog page.
- Appendix B sources: the Stack Overflow 2025 survey technology page,
  the Menlo Ventures mid-2025 update, the OpenRouter State of AI report
  and public models endpoint, the GitHub, npm, pypistats and NuGet APIs.

Not verified: the GitHub Copilot API request shape; OpenRouter's weekly
ranking percentages (the page did not render them; the December 2025
report is cited instead); whether Semantic Kernel has gained a reasoning
content type after the v1.45.0 reference. Statements about the Copilot
SDK runtime beyond its public documentation and the review are
assumptions and are marked as such above.
