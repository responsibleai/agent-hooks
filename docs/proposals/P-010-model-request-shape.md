# P-010: A prescribed shape for the model request and response

- **Status:** Draft
- **Created:** 2026-10-28
- **Author(s):** Mohammad Abuomar `<40180927+MohammadHaroonAbuomar@users.noreply.github.com>` (@MohammadHaroonAbuomar)
- **PR:** https://github.com/responsibleai/agent-hooks/pull/168

See the [proposal process](README.md) for scope, lifecycle, decision
authority, and review window.

## Abstract

The `pre_model_call` interception point hands an interceptor the
messages an agent is about to send to a model, but the specification
leaves the shape of each message open. Every host fills it differently,
so a policy written for one host does not run on another. A policy edit
(a transform) cannot reach the tool set at all. This proposal prescribes
one shape. A `request` object replaces `messages` at `pre_model_call`.
It names the wire format the host projected from. It carries the
conversation as messages made of typed parts: text, media, tool call
with object arguments, tool result, reasoning, refusal, unknown. It
carries the tool declarations. Anything provider-specific goes in an
`ext` slot that a transform may not address and that stays out of the
request identity, the hash an approval binds to. The specification
registers three formats: OpenAI chat completions, OpenAI Responses and
Anthropic Messages. Each has a reference projection and conformance
vectors. A host on any other wire declares a custom format, fills the
parts it can, and states whether a transform reaches its real request.
`post_model_call` adopts the same part vocabulary for
`response.content`. The shape carries an experimental label and sits
behind a conformance capability. Three kinds of evidence support the
choice and appear in the appendices: prototypes over four conversations,
a survey of thirteen message formats, and the same three policy tasks
written against seven shapes.

## The gap (Motivation)

Agent Hooks lets a policy see and change what an agent does at eight
points in its loop. At `pre_model_call` the policy sees the messages the
agent is about to send to a model. The contract says only that each
message has a `role` and a `content` that is a string or an object.
Everything else is the host's choice.

Hosts choose differently. An agent framework adapter emits its own
content records (`text`, `text_reasoning`, `uri`, `function_call`,
`function_result`), or a bare string when a message is one text part. A
host that forwards its provider request unchanged emits whatever array
it is about to send, so the shape changes when the model changes. The
reference harness that ships with the conformance kit emits strings,
appends tool results as `{"role": "tool", "content": value}` and never
shows the assistant's tool calls.

A policy author pays for this. The path that redacts a user string
differs by host, and under a pass-through host it differs by provider.
A policy author cannot write it once. A host that forwards its provider
request also turns an internal array into a public contract, which its
maintainers may refuse.

Two smaller gaps sit beside it. The tool declarations are optional and
outside the part of the context a policy may edit (the transform root),
so a policy cannot remove a tool from a model call, and the request
identity that approvals bind to never covers the tool set. And the
identity hashes the messages whole, so provider bookkeeping inside a
pass-through array (a cache marker, an item id, a status) changes the
identity of a request the model would read identically.

The response has the same problem. `response.content` is a string, an
object or null, so a reasoning part or a refusal has no place beside the
text.

## Goals and non-goals

Goals:

1. A policy author learns one request shape: roles, text, media, tool
   calls with object arguments, tool results with an error flag,
   reasoning, refusals.
2. The host loses nothing: projection then write-back returns the
   provider request, and a transform on the prescribed fields lands in
   the real request.
3. The identity covers what a policy can read and nothing a provider
   changes between otherwise equal requests.
4. Reference projections for OpenAI chat completions, OpenAI Responses
   and Anthropic Messages ship in the SDKs with vectors that pin them.
5. The shape carries an experimental label, and a host that cannot
   project declares a custom format with stated guarantees.
6. `post_model_call.response` uses the same part vocabulary.

Non-goals:

- A model-call transport, a gateway protocol, or a claim of
  compatibility with any provider API.
- Request options (sampling, reasoning configuration, tool choice,
  response format). They stay in `model.params`, unprescribed.
- Streaming of requests, or any change to the streaming rules in §12.1.
- The shape of `input` and `output`. They may adopt the part vocabulary
  in a later proposal.
- Token accounting and prompt-cache strategy.
- The trust model. The host stays fully trusted, the provider stays
  outside the contract, and the interceptor sees what the host projects.

## Specification

### Recommended normative semantics

The Rationale compares this shape, option F, with five alternatives.
The shape carries an experimental label (section 6 below).

#### 1. The request object

At `pre_model_call` the host populates `model` as today and `request` in
place of `messages`:

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
`ext` exists at four places and nowhere else: `request.ext`, each
message's `ext`, each part's `ext` (the parts inside a `tool_result`
included) and each tool's `ext`. A member named `ext` inside `args`,
inside a `source` or inside text is ordinary data.

`request` is the transform root for the point. Today that is the value
of `target`; when the companion proposal on the required core of the
agent context (#167) removes `target`, the root takes the name that
proposal gives it. `tools` moves from §4.5 into `request`, so a
transform can rewrite the tool set and the identity covers it. A
transform on `$target.tools` replaces the whole array; the path grammar
has no delete.

#### 2. Messages and parts

```jsonc
{ "role": "system" | "user" | "assistant" | "tool", "content": [ <part>, ... ], "name": "string", "ext": {} }
```

`content` is always an array, so one path shape reaches a text. The part
types form a closed set; each part MAY carry `ext`.

| type | members | notes |
| --- | --- | --- |
| `text` | `text` | |
| `media` | `media_type`?, `source` | `source.type` is `url`, `base64`, `file` or `digest` (`sha256`, `bytes`) |
| `tool_call` | `id`, `name`, `args` | `args` is an object (rule 7) |
| `tool_result` | `call_id`, `name`?, `content` (parts), `is_error` | `name` is the tool's name, carried when the host knows it |
| `reasoning` | `text`?, `opaque`? | `opaque` is a provider token the host returns unchanged: a signature, redacted data, encrypted content |
| `refusal` | `text` | |
| `unknown` | none | the provider object sits under `ext`; a policy that must see everything denies on it |

Rules:

1. The system prompt is the leading `system` message. A host hoists a
   top-level system member (Anthropic `system`, Responses
   `instructions`) into it and restores it on write-back.
2. A provider `developer` role projects to `system` with the original
   role under `ext`.
3. Tool results sit in a `tool` message: one per provider tool message,
   or one per user turn that carries tool-result blocks.
4. The host keeps provider order. The index of a part is not stable
   across providers; a policy finds a part by `type`.
5. A tool call whose argument string does not parse projects as an
   `unknown` part, never as a `tool_call` with empty arguments.
6. Every text the model will read appears in a `text` part. A host
   SHOULD carry media bytes as `url`, `file` or `digest`; a host that
   inlines `base64` says so in its claim.
7. The host parses a provider argument string on projection and
   serializes it again on write-back. When the two differ, it keeps the
   original under `ext` and reuses it only while the parsed arguments
   are unchanged; otherwise it serializes the transformed arguments.

Two informative mappings accompany the shape: part type to the
OpenTelemetry GenAI message parts (`text` to `text` with `content`,
`tool_call` to `tool_call`, `tool_result` to `tool_call_response`, the
rest to a generic part) and to the AI SDK `ModelMessage` parts. A host
that emits this shape can emit either with a rename.

#### 3. The extension slot

`ext` is a map keyed by a registered format name or a §4.6 namespace.
It holds the residue: the provider members the neutral fields have no
slot for. The host passes it through untouched and restores it on
write-back.

- A transform whose path enters `ext` fails with
  `host_error:transform_target_forbidden`.
- A transform that changes a `reasoning.opaque` value fails with
  `host_error:transform_invalid`.
- The §10.2 identity projection omits `ext` at the four slots of
  section 1 and at the two slots on the response (the response and its
  parts), by path, not by member name. An `ext` member inside user data
  stays in the identity.
- A host restores provider residue only for parts a transform did not
  touch. A part the transform changed is written back from its neutral
  fields.

#### 4. Registered and custom formats

`format` names the wire shape the host projected from. The
specification registers three: `openai.chat`, `openai.responses`,
`anthropic.messages`. A registered format has a projection and a
write-back in every SDK and golden vectors in the conformance kit.

`custom.<namespace>` is for a host whose model API is none of the
registered ones. Such a host MUST fill `messages` with every text the
model reads, the roles, and the tool calls and results it can identify;
it MAY carry the rest as `unknown` parts and under `ext`. It declares
`model_request_transform: true | false`. Under `true`, a transform on
the prescribed fields reaches the real request. Under `false`, a
`transform` verdict at `pre_model_call` fails with
`host_error:transform_target_forbidden`, is recorded as such, and the
claim says so. A policy may rely on three things under a custom format:
a deny decided on `messages` text is sound, a transform is applied or
rejected and never dropped, and an `unknown` part is visible as such.

The host declaration gains two OPTIONAL `surface` members:
`model_request_formats`, the set of format names the host emits, and
`model_request_transform`, REQUIRED when the set contains a custom
format. The §13.3 claim states both.

#### 5. The response object

```jsonc
"response": {
  "format": "<same registry>",
  "content": [ <part>, ... ],
  "tool_calls": [ { "id": "string", "name": "string", "args": {} }, ... ],
  "finish_reason": "stop" | "length" | "tool_calls" | "content_filter" | "refusal" | "other",
  "ext": {}
}
```

`content` becomes an array of the same parts. `tool_calls` is unchanged,
and a provider's tool-use block is not repeated in `content`.
`finish_reason` takes the closed vocabulary above with the provider's
own value under `ext`. §12.1 is untouched: the host assembles the
stream, then projects.

#### 6. Experimental marking

The draft specification labels `request` and `response` "Experimental
(P-010)". The shape may change in a minor revision of the draft. The
conformance part `model_request/projection` is gated on the capability
`model_request_shape`; a host that does not declare the capability keeps
the 0.1 `messages` shape for the draft's lifetime, and its claim says so.
The label comes off when two independent hosts with two different
registered formats pass the part in one release. The general definition
of an experimental label belongs with the companion proposal on the
context core; this proposal states what it needs from it.

#### 7. Reference projections

The Rust core owns the three projections and their write-backs; the
other SDKs bind to them. Each projection is a table from provider member
to part member plus a residue rule, so a fourth format is a table, not a
design. The prototype under `p010-prototypes/` fixes the expected
results as fixtures; the SDK code follows the decision, not the
prototype.

### Schema and wire impact

Proposed changes under `spec/`, in the draft revision:

- `agent-context.schema.json`: `$defs.request`, `$defs.message`,
  `$defs.part`, with `ext` declared at the four slots only;
  `pre_model_call` requires `model` and `request`; `response.content`
  becomes an array of parts and `response` gains `format`; `tools`
  leaves §4.5. The per-point closed schemas are regenerated.
- The host declaration contract, next minor: `surface.model_request_formats`
  and `surface.model_request_transform`.
- `conformance/vectors.schema.json`: the capability `model_request_shape`.
- `conformance/vectors/`: the part `model_request/projection`, built
  from the prototype fixtures: nine projection vectors, eighteen edit
  vectors, six response vectors, and the identity and rejection cases in
  Conformance and tests.

The interception record (§10.3) is unchanged. Two constraints need SDK
validation rather than JSON Schema: the reuse-only-if-unchanged rule for
kept argument strings, and the by-path exclusion of `ext` from the
identity. The wire examples above are proposed, not adopted; the schema
files are authoritative once they exist.

## Rationale

Three tests precede the comparison of options: prototypes, a survey and
a policy-ergonomics exercise. The numbers below come from them; the
appendices hold the full tables, and `python3 run.py` in
`p010-prototypes/` reproduces every measured one.

The prototype writes four conversations in four shapes: OpenAI chat
completions, OpenAI Responses, Anthropic Messages, and the emission of
the agent framework adapter in
[microsoft/agent-framework](https://github.com/microsoft/agent-framework/blob/main/python/packages/core/agent_framework/_agent_hooks.py).
Three conversations carry the measurements: `bank` (system, user,
assistant, user; text only), `weather` (a tool-call round trip with two
declared tools) and `chart` (an image in the user turn, reasoning in the
assistant turn, a cache marker on the system prompt). A fourth,
`transfer`, carries a tool call whose provider argument string has
spaces and a member named `ext` inside the arguments. For each candidate
shape the prototype projects every provider request into the candidate
and back. It measures each candidate in RFC 8785 canonical JSON, the
bytes the `jcs-sha256` provider hashes, and cross-checks 58 objects byte
for byte against the Rust core. It then applies four edits, each as
one §5.2 transform: redact a string in a user message, drop a tool
definition, replace the system prompt, set a tool argument. Appendix D
has the tables.

The survey reads thirteen message formats from their public references
(Appendix A) and records adoption numbers with their dates (Appendix B).
The ergonomics exercise writes the same three policy tasks against seven
target shapes: redact a secret in the latest user turn, deny when a tool
result matches a pattern, cap the system prompt (Appendix C).

Five findings carry the decision.

1. A neutral shape with a residue slot is the only candidate that is
   both lossless and portable. It round-trips all nine fixture and
   source pairs exactly. Without residue it loses only provider
   bookkeeping (item ids, an image detail flag, a cache marker), never
   text the model reads. Every edit written against it is one path shape
   and writes back exactly: five distinct paths, eighteen of eighteen
   edits. The chat-completions shape needs six paths and strips
   something on eight of eighteen write-backs: item ids, the Responses
   reasoning item, the Anthropic thinking block and cache marker. The
   raw union writes back exactly but leaves its summary stale after
   every edit and needs twelve provider-specific paths. Anthropic
   Messages needs the most locator code of the seven shapes (52 lines)
   because tool results and the system prompt each live in two places
   and a user turn can be a tool-result carrier.
2. Residue must stay out of the identity, and the exclusion must be by
   slot. When a cache marker moves, the digest of the neutral shape with
   residue changes and the digest without it does not. Dropping every
   member named `ext` makes two `transfer` requests that differ only in
   `args.ext.memo` hash the same; dropping only the protocol's own slots
   keeps them apart (Appendix D).
3. The provider wires disagree exactly where a policy looks. Anthropic,
   Gemini and Bedrock carry tool arguments as objects; the OpenAI chat,
   Responses and Azure wires carry a JSON string. Anthropic, Gemini and
   Bedrock put tool results inside a user-role turn; chat completions
   and the library abstractions give them a `tool` role; Responses makes
   them a typed item. The system prompt is a message, a top-level
   member, or either. Media is a URL or data URL (OpenAI), base64, URL or
   file (Anthropic), base64 or a file URI (Gemini), bytes or an S3
   location and nothing else (Bedrock).
4. The library abstractions agree with each other and with the neutral
   shape. Six of them model a message the same way: the AI SDK
   `ModelMessage`, LangChain v1 content blocks, Microsoft.Extensions.AI
   `AIContent`, the agent-framework Python `Content`, Semantic Kernel
   `KernelContent` items and the OpenTelemetry GenAI message schema.
   Each is a role plus an array of typed parts, with object tool
   arguments and a tool result keyed by call id. All but OpenTelemetry
   and Semantic Kernel have a reasoning part with an opaque provider
   token. Every one has a provider-metadata slot. The AI SDK shape
   round-trips the nine pairs exactly through `providerOptions`, as the
   neutral shape does through `ext`.
5. Adoption splits by layer. Chat completions is the most emitted wire:
   the OpenAI SDKs lead the provider SDKs on PyPI at 295.9M downloads a
   month, and Azure AI Inference and LiteLLM take the same parameter
   set. Production use is split: Anthropic 32%, OpenAI 25% and Google
   20% of enterprise API usage in Menlo Ventures' mid-2025 survey. The
   abstraction layers are large: LangChain at 170.5M PyPI downloads a
   month, the AI SDK at 113.7M npm downloads a month. Appendix B has the
   rest.

Most harnesses can emit the shape today without new projection code. A
host that calls an OpenAI-compatible endpoint (OpenAI, Azure OpenAI,
Azure AI Inference, a LiteLLM or OpenRouter proxy, Ollama, vLLM, the
GitHub Copilot CLI `openai` provider type) already holds
chat-completions messages. A host built on an abstraction
(agent-framework, Semantic Kernel, LangChain, the AI SDK, LiteLLM as a
library) already holds a parts model. Emitting chat completions from it
needs one mapping, through the abstraction's own OpenAI connector;
emitting the neutral shape needs one rename of part types. Only a host
on the Anthropic, Responses, Gemini or Bedrock wire holds that shape
natively.

### Options considered

The appendices keep the prototype's own candidate labels; Appendix D
maps them to the options below.

#### A. Keep the current contract

`messages` stays `[{role, content: string | object}]`, with or without a
`format` label that names the host's shape. Hosts handle the gap as they
do today: a framework adapter emits its own content records, a
pass-through host emits its provider array, and each policy is written
for one host.

| Advantages | Costs and risks |
| --- | --- |
| No host change beyond a label; nothing is lost. | The paths still depend on the host, so a policy cannot be written once; measured, they differ per host and per provider. |
| | A label is a claim no vector checks. |
| | The identity still covers provider residue, and a transform still cannot reach the tool set. |
| | A pass-through host keeps an internal array as its contract. |

#### B. OpenAI chat completions messages as the one shape

`messages` is constrained to the chat completions message schema; every
host projects into it.

| Advantages | Costs and risks |
| --- | --- |
| The most widely implemented request shape; LiteLLM's unified input is this parameter set, translated per provider. | No slot for provider reasoning (an Anthropic thinking block with its signature, a Responses reasoning item). A transform written against this shape strips them on write-back (measured: the `chart` edits on an Anthropic source). |
| Smallest target: a chat host passes its payload through. | Tool arguments are a JSON string. A policy parses before it can read one field; a policy language without a JSON parser cannot. |
| Many policy authors already know it. | Tool results carry text only: no error flag, no media. Cache markers, item ids and status are lost (measured). |
| | One vendor's format on its own release schedule; conformance would pin a subset of another organization's specification. Assumption: a provider does not adopt a competitor's wire format as its own. |

LiteLLM added `reasoning_content` and `thinking_blocks` beside this
shape for the reasoning gap, and documents that the Anthropic API
rejects an assistant turn sent back without its thinking blocks when
tool results follow it.

#### C. Another provider wire as the one shape

Gemini `contents` and `parts`, or Bedrock Converse `messages` with
content blocks, prescribed for every host.

| Advantages | Costs and risks |
| --- | --- |
| Both carry tool arguments as objects, reasoning text with a signature, and parts arrays, so the three policy tasks need one path shape each. | One vendor's format on that vendor's schedule, with the same objection as option B and a smaller share of harnesses already emitting it. |
| Converse is built as one interface over many models: AWS documents it as "a consistent interface that works with all models that support messages", and the Bedrock catalogue lists nineteen model providers. | Gemini's `functionResponse` needs the tool name and an object, so a projection into it joins results to calls and wraps text; Bedrock has no block for a URL image, so a projection into it must fetch bytes. Measured: four of nine edits written back exactly for either, five of nine pairs lossy. |
| | Tool results sit inside a user-role turn in both, so a "latest user turn" policy must skip carrier turns. |

#### D. A tagged union: `format`, the raw provider payload, a neutral summary

The request carries the provider conversation as sent plus a summary in
the neutral shape without residue.

| Advantages | Costs and risks |
| --- | --- |
| Exact by construction, for any provider, with nothing to maintain on the raw side. | The raw member is the internal array a pass-through host would rather not expose. |
| A policy that knows the provider format can see everything. | Two copies of the conversation. A transform on `raw` leaves the summary stale (measured: eighteen of eighteen), and a transform on the summary does nothing unless the host rebuilds `raw`, at which point the host has written option F. |
| | A policy that edits must know each format: twelve distinct paths for the same four edits (measured). |
| | About twice the raw size, with media counted twice, and an identity that moves with provider bookkeeping (measured; Performance and operational impact). |
| | Conformance cannot pin `raw` against vendor schemas it does not own. |

#### E. Adopt an existing neutral abstraction verbatim

Prescribe the OpenTelemetry GenAI message schema (`gen_ai.input.messages`:
role plus `text`, `tool_call`, `tool_call_response` and generic parts) or
the AI SDK `ModelMessage` as the request shape.

| Advantages | Costs and risks |
| --- | --- |
| Nothing new to design; a telemetry exporter or an AI SDK host needs no mapping. | The OpenTelemetry conventions are at Development stability, name text `content` and results `response`, define no media or reasoning part, and are a capture format: nothing says how a host writes a transform back. |
| The OpenTelemetry schema is vendor-neutral under CNCF governance, has a JSON schema with test cases, and allows extra properties everywhere. | The AI SDK shape is a library type under one company's control, versioned with the SDK, and carries SDK concepts such as `providerExecuted` and `execution-denied` (Appendix A). |
| The AI SDK shape round-trips the nine fixture pairs exactly. | Neither covers `tools`, so the transform root still needs a request object around it. |

#### F. A small neutral shape with an extension slot

A request object with `format`, `messages` as role plus an array of
typed parts, `tools`, and `ext` residue on any object; each registered
provider format has a projection and a write-back. This is the shape of
the Specification.

| Advantages | Costs and risks |
| --- | --- |
| One part vocabulary and one path shape per edit (measured: five distinct paths, eighteen of eighteen edits exact). | Every host adopts or writes a projection. The SDKs ship three; a host with its own content model still maps. |
| Lossless with `ext` on all nine fixture and source pairs; without `ext` the loss is provider bookkeeping only, never text the model reads (measured). | More bytes than the provider's own conversation on text-only turns, up to 55%; the increase is the parts array (measured; Performance and operational impact). |
| `ext` stays out of the identity, so provider residue cannot perturb approvals (measured). | The part vocabulary needs maintenance as providers add kinds. |
| Object arguments, an error flag on tool results, reasoning as text plus an opaque token the host returns unchanged. | Provider rules the shape does not state (turn alternation, where tool results may sit) are the write-back's job. |
| The schema is this repository's, so the conformance kit pins the projections with golden vectors, and no provider is asked to adopt another's format. | |
| A new content type lands as an `unknown` part or under `ext` until the specification names it. | |

This proposal rejects three shortcuts. A dual content form, string or
parts, saves bytes and costs a second path shape for every edit
(measured on the chat shape). The format registry replaces a per-host
mapping profile: a host declares the formats it emits. Calling the shape
"OpenAI-compatible" or "LiteLLM-compatible" would misdescribe it:
LiteLLM's answer is two formats (chat completions plus an Anthropic
Messages endpoint) and a reasoning side channel, not one shape (option
B).

Measured columns in the table below come from Appendix C (nine fixture
and source pairs, three tasks); the last column from Appendix A.
Responses items and Anthropic Messages carry no option letter: they were
measured as targets but not proposed as the one shape.

| shape | lossy pairs | write-back exact | user-text paths | locator lines | tool args | controlled by |
| --- | --- | --- | --- | --- | --- | --- |
| B chat completions | 4/9 | 5/9 | 2 | 33 | string | OpenAI |
| C Gemini | 5/9 | 4/9 | 1 | 30 | object | Google |
| C Bedrock Converse | 5/9 | 4/9 | 1 | 44 | object | AWS |
| Responses items | 2/9 | 7/9 | 1 (2 allowed) | 38 | string | OpenAI |
| Anthropic Messages | 4/9 | 5/9 | 2 | 52 | object | Anthropic |
| D raw union | 0/9 | 9/9, summary stale | one set per format | per format | per format | each vendor |
| A loose | host defined | not measurable | per host | per host | per host | each host |
| E AI SDK ModelMessage | 0/9 | 9/9 | 1 | 47 | object | Vercel |
| E OpenTelemetry GenAI | not run | no write-back rule | 1 | not run | any | CNCF (Development status) |
| F neutral | 0/9 | 9/9 | 1 | 33 | object | this specification |

### Recommendation (for discussion)

The recommendation is option F, marked experimental. It keeps the
`format` label that options A and D carry and adds a custom format for a
host whose wire is not registered.

F has two costs: a projection per host and up to 55% more bytes than the
raw wire on text-only turns. The projection cost is bounded. Three
projections ship in the SDKs, and every abstraction-based host already
holds a parts model one rename away. The byte cost buys one path shape
per edit. Every other option fails a goal outright. B, C and the other
provider wires in the table lose content or need provider-specific
paths. D doubles the payload and keeps two copies of the conversation. E
has no write-back rule or follows one company's release schedule. A
leaves the gap open. The comparison table above carries the per-format
case.

Two details of the shape come from the survey, not the prototype. A
tool result may carry the tool name, because Gemini and the AI SDK
require it on the result. The specification states the mapping of the
part vocabulary onto the OpenTelemetry GenAI message parts and the AI
SDK parts, so one projection serves control and telemetry.

Objections and remaining risks:

- A host that cannot project loses nothing under a custom format but
  gives a policy less; open decision 2 settles how much.
- The vocabulary will need additions as providers ship new content
  types; `unknown` and `ext` absorb them until then, and a policy that
  must see everything denies on `unknown`.
- Vendor acceptance of a neutral shape is an assumption, not evidence.
  The survey shows every library abstraction already uses one, which is
  the nearest public signal.
- The byte overhead is measured on short fixtures. On long conversations
  the parts-array cost per message is constant and its share shrinks;
  that is reasoning, not measurement.

The Specification takes the recommended side of each decision below;
each stays open until the review closes.

1. Field placement: `request` wrapping `messages` and `tools`, or
   `messages`, `tools` and `format` as siblings at the top level.
   Recommendation: `request`, because the transform root must cover the
   tool set.
2. Whether a `custom.*` host may omit `model_request_transform`.
   Recommendation: REQUIRED for custom formats. Evidence: every surveyed
   abstraction has a provider-metadata slot, and no provider wire has a
   slot for another provider's members. A custom host can therefore
   always fill text, roles, calls and results and put the rest under
   `ext`. Registered wires also have write-back limits (Bedrock cannot
   carry a URL image; Gemini wraps a text result in an object), so every
   host needs a declared transform posture.
3. The first registry: the three formats above. A fourth format joins
   when its owner confirms the request shape from public documentation.
4. Whether the agent-framework adapter declares the wire format per chat
   client or `custom.agent_framework`. Recommendation: per client when
   the client knows its wire shape.
5. Media policy: references and digests by default, bytes only under a
   declared posture, or bytes allowed up to a size. Recommendation: the
   first. Evidence: the wires disagree on carriage (OpenAI URL or data
   URL or file id; Anthropic base64, URL or file; Gemini base64 or file
   URI; Bedrock bytes or S3 location only). So a write-back may need the
   bytes whatever the context carries, and the host holds them. A 100
   KiB image costs 133 KB in every inlining target and under 600 bytes as
   a digest. The library abstractions all accept a reference form (AI
   SDK `url` and `reference`, LangChain `url` and `id`,
   Microsoft.Extensions.AI `UriContent`), so a digest or reference rule
   costs them nothing.
6. Whether `input` and `output` adopt the part vocabulary now or in a
   later proposal. Recommendation: later.
7. The exit criterion for the experimental label. Recommendation: two
   independent hosts, two registered formats, one release.

### Related decisions

- The companion proposal on the required core of the agent context
  (#167) removes `target` and defines the experimental label; this
  proposal names the transform root through `target` today and asks
  that proposal for the label's definition.
- P-008 moved the host declaration contract to 1.1 with optional
  members; the two `surface` members here follow the same minor
  pattern.
- Spec sections affected: §4.2 (`pre_model_call`, `post_model_call`),
  §4.5 (`tools`), §5.2 (transform root), §7.7.4 (surface), §10.2
  (identity projection), §13.1 and §13.3 (capability and claim). §10.3
  and §12.1 are unchanged.
- Prior art: LiteLLM's two endpoints and reasoning side channel, the AI
  SDK `ModelMessage`, the OpenTelemetry GenAI message schema, the A2A
  `Part` model (Appendix A).

## Security and privacy

The trust boundary does not move: the host projects, the interceptor
reads the projection, and the provider never sees `ext` as anything but
its own members restored. Fail-closed rules apply to the new rejections
(`transform_target_forbidden` under `ext` or under a custom host without
transforms, `transform_invalid` on `opaque`). Records stay payload-free
and their shape is unchanged.

| Risk | Treatment |
| --- | --- |
| A host hides model-visible text under `ext` or in an `unknown` part | text completeness is a MUST; golden vectors check it for registered formats; a custom host states it in the claim; a policy can deny on `unknown` |
| Provider bookkeeping perturbs an approval binding | `ext` is outside the identity, by path |
| A transform strips a signature and the provider rejects the next call | `opaque` is immutable under transform; reasoning parts are carried, not dropped |
| Media bytes in the context (size, retention, exfiltration surface) | `digest` source type; `url` and `file` preferred; §12.3 bounds apply; inlining is a claimed posture |
| Malformed tool arguments bypass an argument policy | unparseable arguments project as `unknown` |
| A host declares one format and emits another | the conformance kit checks the declared formats against the projections it can verify |
| A kept provider string reverts a transformed tool argument on write-back | residue is reused only for parts the transform did not touch; the argument-edit vector pins it |
| User data named `ext` falls out of the identity | the exclusion is by slot, not by member name; the `transfer` vectors pin it |

One residual risk remains. A custom-format host that declares
`model_request_transform: false` gives a policy deny and read only. The
claim discloses it; there is no further mitigation.

## Backward compatibility

Replacing the conditional field `messages` with `request`, changing
`response.content`, and moving `tools` are changes to required and
conditional context fields: spec MAJOR class under VERSIONING.md and a
proposal-required class under the proposals README. This proposal asks
to land the change in the next draft revision under `spec/`, marked
experimental, with the SDK builders accepting both shapes so most hosts
see no break. The break is this: a 0.1 host that emits `messages` is not
conformant to the draft, and a draft host that emits `request` fails 0.1
validation. This proposal takes no position on the wire version string;
the companion proposal (#167) settles it.

What old and new producers and consumers keep:

- A 0.1 host keeps emitting `messages`; a draft SDK builder accepts
  both forms and emits the draft shape only when the host declares
  `model_request_shape`.
- An interceptor written for the draft reads `request`; one written for
  0.1 reads `messages` and sees no `request` from a 0.1 host.
- The declaration contract change is minor: two OPTIONAL members; an
  absent member keeps the 0.1 meaning. A loader refuses the new members
  under a 1.0 version string, and a 1.0 loader refuses a 1.1 document,
  as P-008 set out.
- The identity preimage at `pre_model_call` changes with the shape, so
  identities for the same conversation differ between 0.1 and the
  draft. Approvals bind within a session and do not cross versions.
- Unchanged: the tool points, `input`, `output`, verdict shapes,
  composition, the approval seam, the interception record, and the
  streaming rules.

Package versions: VERSIONING.md bumps the SDK major on a spec MAJOR or a
breaking API. While the draft is experimental and the builders accept
both forms, no SDK API breaks, and the spec MAJOR takes effect only when
the wire version string moves. This proposal reads the rule this way; the reading is not settled. The
SDK release that ships the draft shape behind the capability can be a
minor. The release that removes the `messages` form, or that ships the
revision once the wire version is settled, is a major.

## Performance and operational impact

Measured on the prototype fixtures (Appendix D):

- The neutral shape costs between 11% less and 55% more than the
  provider's own conversation in canonical bytes without residue, and 7%
  to 55% more with residue; the increase is the parts array on
  text-only messages. The raw union costs 1.9 to 2.6 times the raw
  conversation.
- A 100 KiB image inlined as base64 adds about 133 KB to every inlining
  shape and 267 KB to the raw union; as a digest it costs under 600
  bytes.
- The identity is stable across provider-only changes (a cache marker
  moving) and changes on any text or argument change, including an
  `ext` member inside tool arguments.

Two costs are unmeasured assumptions: the CPU cost of a projection per
emission (one pass over the messages, comparable to the deep copy the
emitter already makes per interceptor), and the memory cost of holding
residue (bounded by the provider payload the host already holds).
Operators see the declared formats and the transform posture in the
claim.

## SDK surface and implementation impact

Rust core and FFI:

- The three projections and their write-backs live in the core; the
  bindings expose `project(format, payload)` and `restore(request)`.
- The §5 gate rejects transforms whose path enters `ext` and transforms
  that change `opaque`.
- The identity path omits `ext` at the defined slots, by path.
- The core validates `format` and passes `ext` through.

Python, TypeScript, .NET and Go:

- Builders take `request` (and `content` as parts at
  `post_model_call`) in place of `messages`; the `messages` form stays
  accepted during the draft and emits the 0.1 shape when the host has
  not declared `model_request_shape`.
- Each SDK adds `Request`, `Message` and `Part` types and the two
  declaration members in its loader.

The change touches five kinds of host. The first two come from public
code; the other three describe hosts by role and are assumptions.

- An agent framework adapter, read from
  [microsoft/agent-framework](https://github.com/microsoft/agent-framework/blob/main/python/packages/core/agent_framework/_agent_hooks.py).
  Today it emits its own content records, tools as `{name,
  description}`, and the model id from the chat options. It would map
  its content records to parts (`text` to `text`, `text_reasoning` with
  its protected data to `reasoning` with `opaque`, `data` and `uri` to
  `media`, `function_call` to `tool_call` with parsed arguments,
  `function_result` to `tool_result`), add the inverse to its write-back
  codec, and take `format` from the chat client when it knows its wire
  shape, else `custom.agent_framework`.
- A policy engine host, read from
  [agent-control-spec](https://github.com/responsibleai/agent-control-spec)
  (specification §4 and the bank example). Its model-request target is
  already an object with `messages`, `model` and `tools`, and its
  policies read `content` as a string. It would accept `request` as
  `model_request`, update the example policy and add a helper that
  returns the text of a message.
- A hosted agent runtime that forwards its provider request unchanged.
  It would call the SDK projection for the wire format of each model
  call, restore on write-back, carry `tools` in `request.tools`, and
  declare the formats.
- An API gateway that fronts several model providers. It would project
  from the registered format of each route, write back the same way,
  and declare formats per route.
- A host that builds requests in its own orchestrator. It would project
  from the provider request it builds, or declare a custom format with
  text completeness and a transform posture.

Documentation: `docs/IMPLEMENTING.md` gains the projection step for
`pre_model_call` and `post_model_call`; `conformance/HARNESS.md` gains
the capability. Implementation follows the decision; the prototype
is an experiment, not a commitment to its code.

## Conformance and tests

The conformance kit gains the part `model_request/projection`, gated on
the capability `model_request_shape`. Its vectors come from the
prototype fixtures: nine projection vectors (three conversations, three
registered formats), eighteen edit vectors (six edit and fixture pairs,
three sources), six response vectors, and the identity and rejection
cases below. A claim states the declared formats and, for a custom
format, the transform posture.

| Case | Expected result |
| --- | --- |
| each registered format, each fixture | projection equals the golden request; write-back equals the fixture after normalization |
| the four edits, each format | write-back equals the same edit made natively |
| a transform under `ext` | `host_error:transform_target_forbidden` |
| a transform that changes `opaque` | `host_error:transform_invalid` |
| a cache marker moves between two requests | identical identity |
| one character of user text changes | different identity |
| two requests differ only in a member named `ext` inside tool arguments | different identities |
| a transform sets a tool argument whose provider string was kept as residue | the provider request carries the new value; the kept string is not reused |
| a tool is removed by transform | the provider request carries the remaining tools; identity differs from the untouched request |
| a custom format with `model_request_transform: false` receives a transform | `host_error:transform_target_forbidden`, recorded |
| an `unknown` part is present | conformant; the host enforces a deny on it |
| a tool call with an unparseable argument string | projected as `unknown` |
| provider responses with reasoning, refusal, tool calls | parts as stated; tool calls not repeated; `finish_reason` mapped with the provider value under `ext` |
| a host without `model_request_shape` | the part is skipped; the 0.1 `messages` shape validates |

## Appendix A: message formats surveyed

Each entry gives the kind of thing the format is, its shape in one line,
how it models parts, tool calls, tool results, reasoning, media and
provider metadata, and who controls it. The field names come from the
linked references as read on 2026-10-28.

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

### OpenAI chat completions

`{model, messages: [{role, content}], tools}`. Roles `developer`,
`system`, `user`, `assistant`, `tool`; `content` a string or parts
(`text`, `image_url`, `input_audio`, `file`, `refusal`). Tool call:
`tool_calls[{id, type: "function", function: {name, arguments: <JSON
string>}}]` on the assistant message. Tool result: a `tool` message with
`tool_call_id` and string or text-part content; no error flag.
Reasoning: no member. Media: `image_url.url` (URL or data URL), `file`
(`file_id` or `file_data`). Metadata: `name` per message and
`prompt_cache_breakpoint` on parts; nothing else.

### OpenAI Responses

`{model, instructions, input: [item], tools}`. Items: `message` (roles
`user`, `system`, `developer`, content `input_text`, `input_image`,
`input_file`; assistant output messages with `id`, `status`,
`output_text`, `refusal`), `function_call` (`call_id`, `name`,
`arguments: <JSON string>`, `id`, `status`), `function_call_output`
(`call_id`, `output` string or list, `id`, `status`), `reasoning` (`id`,
`summary`, `content`, `encrypted_content`, `status`), plus server tool
items. Media: `input_image.image_url` or `file_id`. Metadata: item `id`
and `status`.

### Anthropic Messages

`{model, system, messages: [{role, content}], tools, max_tokens}`. Roles
`user`, `assistant` and, per the current reference, `system`; `content`
a string or blocks: `text`, `image`, `document`, `tool_use` (`id`,
`name`, `input: object`), `tool_result` (`tool_use_id`, string or
blocks, `is_error`), `thinking` (`thinking`, `signature`),
`redacted_thinking` (`data`), server tool blocks. Media: `source` of type
`base64`, `url` or `file`. Metadata: `cache_control` on blocks.

### Gemini generateContent

`{contents: [{role: "user" | "model", parts}], systemInstruction:
{parts}, tools: [{functionDeclarations}], cachedContent}`. Parts: `text`,
`inlineData` (`mimeType`, `data`), `fileData` (`fileUri`, `mimeType`),
`functionCall` (`id`?, `name`, `args: object`), `functionResponse`
(`id`?, `name`, `response: object`), `thought` (boolean) with
`thoughtSignature`, `executableCode`, `codeExecutionResult`;
`partMetadata` is a generic struct. Tool results travel in a `user` turn
and need the tool name.

### Bedrock Converse

`{messages: [{role: "user" | "assistant" | "system", content: [block]}],
system: [{text} | {cachePoint}], toolConfig: {tools: [{toolSpec: {name,
description, inputSchema: {json}}}]}}`. Blocks: `text`, `image`
(`format`, `source: {bytes | s3Location}`), `document`, `video`,
`toolUse` (`toolUseId`, `name`, `input: JSON`), `toolResult`
(`toolUseId`, `content: [{text | json | image | document}]`, `status:
success | error`), `reasoningContent` (`reasoningText: {text, signature}`
or `redactedContent`), `cachePoint`, `guardContent`. Media: bytes or S3
only. Metadata: request-level `additionalModelRequestFields`.
`stopReason` includes `end_turn`, `tool_use`, `max_tokens`,
`guardrail_intervened`, `content_filtered`.

### Azure AI Inference and Azure OpenAI

The chat-completions shape. Roles `developer`, `system`, `user`,
`assistant`, `tool`, `function`; content parts `text`, `file`,
`input_audio`, `image_url`, `refusal`; tool calls with string arguments.
Model-specific members pass through under the `extra-parameters:
pass-through` header. Microsoft's own guidance now directs Azure AI
Inference SDK users to the OpenAI SDK.

### LiteLLM

Input: the chat-completions parameter set, translated per provider; any
non-OpenAI parameter is passed through as provider specific. Reasoning:
`reasoning_content` and, for Anthropic, `thinking_blocks[{type,
thinking, signature}]`, which must be sent back or the Anthropic API
rejects the turn. A second endpoint serves the Anthropic Messages format
across providers. Providers: 137 entries on its providers page.

### AI SDK ModelMessage and UIMessage (v7.0.155 on `main`)

`ModelMessage` is `system` (string content), `user` (`text`, `file`,
deprecated `image`), `assistant` (`text`, `reasoning`, `tool-call` with
`toolCallId`, `toolName`, `input: unknown`, `providerExecuted`?, `file`,
`custom`) or `tool`
(`tool-result` with `toolCallId`, `toolName`, `output` of type `text`,
`json`, `error-text`, `error-json`, `execution-denied` or `content`).
Every part takes `providerOptions`. `FilePart.data` is data, a URL or a
provider reference. The reference page retrieved listed the tool-call
argument member as `args`; the source file uses `input`. `UIMessage` is
`{id, role, parts, metadata}` with `text`, `reasoning`, `tool-<name>`
states, `source-url`, `source-document`, `file`, `data-<name>`,
`step-start`.

### LangChain messages (v1)

`SystemMessage`, `HumanMessage`, `AIMessage` (`content`,
`content_blocks`, `tool_calls[{name, args: dict, id}]`, `usage_metadata`,
`response_metadata`), `ToolMessage` (`tool_call_id`, `name`, `content`,
`artifact`). Standard blocks: `text`, `reasoning`, `image`, `audio`,
`video`, `file` (`url`, `base64`, `id`, `mime_type`), `tool_call`,
`tool_call_chunk`, `invalid_tool_call`, `server_tool_call`,
`server_tool_result`, `non_standard` (`value`). 94 chat model
integrations listed.

### Microsoft Agent Framework

.NET: `ChatMessage {Role, Contents: IList<AIContent>}` from
Microsoft.Extensions.AI; `AIContent` subtypes `text`, `reasoning`,
`data`, `uri`, `functionCall` (`CallId`, `Name`, `Arguments:
IDictionary`), `functionResult`, `usage`, `error`, `hostedFile`,
tool-approval and server-tool contents; every content has
`AdditionalProperties` and `RawRepresentation`. Python: `Message(role,
contents: [Content])` with `type` in `text`, `text_reasoning`
(`protected_data`), `data`, `uri`, `function_call` (`arguments: str |
Mapping`), `function_result`, `error`, `usage`, `hosted_file`, plus
`additional_properties` and `raw_representation`. Ten model-provider
packages in the Python repository (Anthropic, Bedrock, Gemini, Mistral,
Ollama, OpenAI among them).

### Semantic Kernel

`ChatMessageContent(role, items, content, inner_content, metadata)`;
items are `KernelContent` subtypes `TextContent`, `ImageContent`,
`AudioContent`, `BinaryContent`, `FunctionCallContent` (`id`, `name`,
`arguments: str | Mapping` in Python, `KernelArguments` in .NET),
`FunctionResultContent`, `FileReferenceContent`, `AnnotationContent`. No
reasoning content type in the v1.45.0 .NET reference. Provider payload
reachable through `InnerContent`.

### A2A Message and Part (1.0.0)

`Message {messageId, role: ROLE_USER | ROLE_AGENT, parts, taskId,
contextId, metadata, extensions, referenceTaskIds}`; a `Part` holds
exactly one of `text`, `raw` (base64 bytes), `url` or `data` (any JSON),
plus `metadata`, `filename`, `mediaType`. No tool call or tool result:
tools are internal to an agent.

### OpenTelemetry GenAI messages

Semantic conventions v1.37.0; the conventions have since moved to their
own repository, which has no release yet. Event
`gen_ai.client.inference.operation.details`, opt-in attributes
`gen_ai.input.messages`, `gen_ai.output.messages`,
`gen_ai.system_instructions`. A message is `{role, parts}`; parts are
`text` (`content`), `tool_call` (`id`, `name`, `arguments: any`),
`tool_call_response` (`id`, `response: any`) or any other `type`
(generic); every object allows additional properties. Output messages
carry `finish_reason`. No media or reasoning part. Stability:
Development.

### Verification notes

Read in this repository: `sdk/rust/core/src/canonical.rs`, the five SDK
builders and the conformance kit's reference harness. The Bedrock entry
draws on the `Converse`, `Message`, `ContentBlock`, `SystemContentBlock`,
`ToolUseBlock`, `ToolResultBlock`, `ToolResultContentBlock`,
`ImageBlock`, `ImageSource`, `ReasoningContentBlock` and
`ToolSpecification` reference pages. The OpenAI entries draw on the
`openai-python` type directories.

Not verified during this work: OpenRouter's weekly ranking percentages
(the page did not render them; the December 2025 report is cited
instead), and whether Semantic Kernel has gained a reasoning content
type after the v1.45.0 reference. The GitHub Copilot SDK appears in
Appendix B for scale but not in this survey: no public documentation of
its request shape was found.

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
| GitHub Copilot SDK (request shape unverified) | github/copilot-sdk, `@github/copilot-sdk`, `github-copilot-sdk` | 10,585 | 5.3M | 1.2M | |

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
| Bedrock Converse | 19 model providers in the catalogue | [models](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-supported-models-features.html) |
| OpenRouter | 67 model authors | [models API](https://openrouter.ai/api/v1/models) |
| agent-framework (Python) | 10 model-provider packages | [repository](https://github.com/microsoft/agent-framework/tree/main/python/packages) |
| GitHub Copilot CLI bring-your-own-key | 3 provider types (OpenAI-compatible, Azure OpenAI, Anthropic) | [GitHub docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models) |

## Appendix C: policy ergonomics

`python3 run.py` in `p010-prototypes/` prints this section. Each target
shape gets three locators, the only format-specific code a policy author
writes (`policies.py`): the text parts of user turns, the text of tool
results, and the system prompt. The three tasks are shared: redact a
secret in the latest user turn, deny when any tool result matches a
pattern, cap the system prompt at twenty characters. Each task runs for
the three fixtures from each of the three provider sources, nine pairs.
The two transforms are written back and compared with the same edit made
natively. The deny task runs on a copy of the tool-call fixture with the
secret leaked into the tool result, and on the clean fixtures. Lines are
counted after `ruff format`.

| target shape | tool args | locator lines | user-text paths | tool-result paths | system paths |
| --- | --- | --- | --- | --- | --- |
| chat completions | JSON string | 11+11+11=33 | 2 | 1 | 1 |
| Responses items | JSON string | 11+11+16=38 | 1 | 1 | 2 |
| Anthropic Messages | object | 13+21+18=52 | 2 | 1 | 2 |
| neutral | object | 8+17+8=33 | 1 | 1 | 1 |
| Gemini | object | 10+15+5=30 | 1 | 1 | 1 |
| Bedrock Converse | object | 10+23+11=44 | 1 | 1 | 1 |
| AI SDK ModelMessage | object | 11+31+5=47 | 1 | 1 | 1 |

| target shape | redact exact | PII deny (leaked, clean) | cap exact | lossy pairs | size, 9 pairs (bytes) |
| --- | --- | --- | --- | --- | --- |
| chat completions | 5/9 | 3/3, 0 false | 5/9 | 4/9 (cache marker, ids, reasoning, thinking) | 4,501 |
| Responses items | 7/9 | 3/3, 0 false | 7/9 | 2/9 (cache marker, image detail) | 6,078 |
| Anthropic Messages | 5/9 | 3/3, 0 false | 5/9 | 4/9 (image detail, ids) | 4,404 |
| neutral | 9/9 | 3/3, 0 false | 9/9 | 0/9 | 6,181 |
| Gemini | 4/9 | 3/3, 0 false | 4/9 | 5/9 (cache marker, image detail, ids) | 4,719 |
| Bedrock Converse | 4/9 | 3/3, 0 false | 4/9 | 5/9 (cache marker, ids, the URL image) | 4,546 |
| AI SDK ModelMessage | 9/9 | 3/3, 0 false | 9/9 | 0/9 | 6,250 |

The neutral row carries `ext`; without it the nine targets sum to 5,480
bytes (the neutral-only column of the size table in Appendix D). The AI
SDK row carries the same residue in `providerOptions`.

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

- Chat completions: content is a string or a parts array, so every text
  read branches; tool arguments are a JSON string to parse; reasoning
  never appears; the system prompt is the first message unless the host
  used `developer` or more than one.
- Responses items: items are typed, not role-based, so user text, tool
  calls, tool results and reasoning are four item types; the system
  prompt may be `instructions` or an item; arguments are a string; item
  ids are provider state to leave alone.
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

## Appendix D: prototype measurements

The prototype labels its candidates A (chat shape), B (neutral with
`ext`), B- (neutral without `ext`), C (raw union) and D (the host's
loose shape with a label). A, B, C and D are options B, F, D and A of
the Rationale; B- is F without residue. Provider field names were
checked against the references in Appendix A.

Round trip, provider to candidate to provider, after normalizing choices
that mean the same thing to the model (a string versus one text part,
default-valued members, the system prompt as `instructions` versus a
leading system message, an argument string versus its parsed value):

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

Size of the candidate in canonical bytes. The "current" column is the
agent framework adapter's emission; it is smaller on `weather` because
that adapter drops tool schemas, not because the shape is cheaper.

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

With a 100 KiB image inlined as base64 in `chart`, the raw payloads run
from 133,651 to 133,898 bytes, A and B- from 133,651 to 133,846, and C
from 267,391 to 267,763 because it carries the conversation twice. B-
with the media part reduced to a digest and a byte count stays between
466 and 591 bytes.

Transform expressiveness, one `{path, value}` per edit, eighteen cases
per candidate (six edit and fixture pairs across three sources):

| candidate | distinct paths | write-back equals the native edit | other outcome |
| --- | --- | --- | --- |
| A | 6 | 10 of 18 | 8 strip something on write-back: item ids, the Responses reasoning item, the Anthropic thinking block and cache marker |
| B | 5 | 18 of 18 | none |
| C | 12 | 18 of 18 | the summary is stale after every edit; paths are provider specific (`raw.messages[0].content`, `raw.instructions`, `raw.system`, `raw.system[0].text`, `raw.input[1].arguments`) |
| D | host defined | not measurable | a policy cannot be written once |

The argument edit is one path into an object under B
(`messages[2].content[0].args.amount`). Under A, and under C for the
chat and Responses raw forms, the author rewrites the whole argument
string. The B write-back carries the new value because the host reuses
the kept provider string only while the parsed arguments are unchanged;
a first version of the prototype reused it unconditionally and sent the
old amount back, which the `transfer` case now catches.

Under every candidate the index of the text part inside a user message
depends on the source (Anthropic puts the image first), so a policy
locates the part by type and computes the index; the grammar has no
filter segment. Under the current specification `tools` is outside
`target`, so no candidate can drop a tool until the transform root is
the request object.

Identity under a provider-only change (the Anthropic cache marker on the
system block moves): the digest of A and of B- is unchanged; the digest
of B and of C changes. By slot against by name: two `transfer` requests
that differ only in `args.ext.memo` hash identically when every member
named `ext` is dropped and differently when only the protocol's own
slots are dropped, while two requests that differ only in a cache marker
held as residue still hash identically. The shipped core confirms the
starting point: `sdk/rust/core/src/canonical.rs` projects
`pre_model_call` as `model.id` plus the whole of `messages`, so changing
`tools` leaves the 0.1 identity unchanged and an extra member on a
message changes it.

Provider responses through the same part vocabulary: text, reasoning
and refusal become parts, tool calls stay in `tool_calls`, and what is
left for an extension slot is ids, status, `stop_sequence` and the
provider envelope (`object`, `created`). The current
`response.content: string | object | null` has no place for a reasoning
part or a refusal next to text.

Two of the three emissions The gap section describes come from code:
the agent framework adapter's content records in `_agent_hooks.py`
(microsoft/agent-framework), and the conformance kit's reference harness
in `sdk/python/python/agent_hooks/ctk/reference.py` in this repository,
which appends role-plus-string messages and
`{"role": "tool", "content": value}` and never appends the assistant's
tool calls. The pass-through case is the provider request as sent.
