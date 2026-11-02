# P-XXX: Hook-specific type contracts from existing context schemas

- **Status:** Draft
- **Created:** 2026-10-30
- **Author(s):** Caitie McCaffrey `<caitiem20@github.com>` (@CaitieM20)
- **PR:** https://github.com/CaitieM20/agent-hooks/pull/3

See the [proposal process](README.md) for scope, lifecycle, decision
authority, and review window.

## Abstract

The Spec's broad `AgentContext` and interceptor contracts do not clearly
express which fields are available at each hook, leaving developers to
check and interpret payloads themselves. This proposal explores
hook-specific types, grounded in the existing schemas, so builders and
interceptors can expose the fields each hook requires and catch mistakes
at compile time. The goal is clearer, safer contracts with minimal changes
the wire format.

## The gap (Motivation)

### Specification knowledge instead of explicit contracts

The broad context contract leaves hook implementors to read the
specification to determine which fields are required at each interception
point, what `target` represents, and which assumptions are safe. Correctness
depends on translating that prose into checks and conventions rather than
implementing a well-defined hook contract. Hook-specific types would make
those requirements explicit and let tooling catch missing fields and
incorrect assumptions earlier.

### Keeping harness internals private

Harnesses should be able to expose only the data needed by a hook without
revealing their internal state or representation. A broad context with many
optional fields blurs that boundary and leaves interceptor authors unsure
which additional data they can rely on. A well-defined per-hook contract
would give harnesses a clear minimum to supply, without requiring them to
populate or pass unrelated optional data to every interceptor.

## Goals and non-goals (optional)
Goals are to make the current eight-hook interceptors defined as explicit types.

Non-goals are redesigning specific hooks


Non-goals are normative spec edits, schema regeneration or relocation,
production SDK API changes, new hooks, framework-specific payload models,
or tool-name-specific argument schemas. Here "per-hook schema" means
`pre_tool_call` versus `post_tool_call`, not one schema per named tool.
Tool argument/result refinements can be layered by a host later; no such
generic is trusted solely because a caller supplies a TypeScript type.

## Specification

### Recommended normative semantics

This section records **candidate semantics for discussion**, not new
normative requirements. Existing normative obligations remain in
[spec sections 3 and 4](../../spec/AGENT-HOOKS-0.1.md#4-agent-context).
Agreement on these sketches should precede a separate pass over spec
language and an implementation proposal.

#### Current per-hook payload and target inventory

Every row also requires `spec`, `interception_point`, `timestamp`,
`sequence`, `agent`, `session`, and `target`.

| Hook | Required hook fields in generated schema | Target relationship in spec and builder | Transform |
| --- | --- | --- | --- |
| `agent_startup` | `agent_init` | `agent_init` | Forbidden |
| `input` | `input` | `input` (content and role, not content alone) | Permitted |
| `pre_model_call` | `model`, `messages` | `messages` (not the model descriptor) | Permitted |
| `post_model_call` | `model`, `response` | `response` (including tool calls and finish reason) | Permitted |
| `pre_tool_call` | `tool_call` | `tool_call.args` (not the full call) | Permitted |
| `post_tool_call` | `tool_call`, `tool_result` | `tool_result.value` (not error/duration metadata) | Permitted |
| `output` | `output` | `output` (not content alone) | Permitted |
| `agent_shutdown` | `summary` | `summary` | Forbidden |

These target relationships come from spec section 4.2 and builder behavior;
they are **not** JSON Schema equality constraints. At `post_tool_call`,
the host supplies the arguments actually executed, including any permitted
pre-call transform. Post-call transformation changes the exposed result,
not the tool operation that already ran.

The TypeScript builder also has narrower construction choices than the
schemas: for example, it requires IDs on model-requested tool calls,
whereas the schema source makes `ToolCallRequest.id` optional. The sketch
below follows the schema's optional ID rather than treating this builder
signature as a new wire requirement.

#### TypeScript schema/type sketch: envelope and payloads

The single [TypeScript contract sketch](hook-contracts.ts) covers all eight
hooks. Each interface uses
its generated per-hook schema's required payload fields and omits every
optional property, including nested members. The shared
`AgentContext` interface contains only `spec`,
`timestamp`, `sequence`, `agent`, and `session`, plus reusable JSON type
aliases. `HooksRequest` extends `AgentContext`, requires an
`interception_point: HookInterceptionPoint` discriminator, and adds an
`[extension: string]: unknown` index signature. Each hook-specific request
extends `HooksRequest`, so the shared metadata and required hook payload
properties are all at the request root; there are no separate hook-context
interfaces. Each hook further narrows `interception_point` to its exact
literal. This keeps the explicit hook identity even if a transport could infer
it from the paired type; the redundancy is retained for transport-independent
clarity. Shared metadata remains flat, without a nested `agentContext`
property. The file is self-contained and can move without changing imports;
constraint comments do not claim runtime validation.

| Request interface | Required hook payload fields |
| --- | --- | --- |
| `AgentStartupHookRequest` | `agent_init: { tools_registered: string[] }` |
| `InputHookRequest` | `input: { content: unknown, role: "user" \| "system" \| "external" }` |
| `PreModelHookRequest` | `model: { id: string, vendor?: string, params?: object }`, `messages: { role: string, content: unknown }[]` |
| `PostModelHookRequest` | `model: { id: string, vendor?: string, params?: object }`, `response: { content: unknown, tool_calls: { id?: string, name: string, args: object }[], finish_reason: string }` |
| `PreToolHookRequest` | `tool_call: { id: string, name: string, args: object, content_hash?: string }` |
| `PostToolHookRequest` | `tool_call: { id: string, name: string, args: object, content_hash?: string }`, `tool_result: { value: unknown, is_error: boolean, duration_ms?: number }` |
| `OutputHookRequest` | `output: { content: unknown }` |
| `AgentShutdownHookRequest` | `summary: { reason: "completed" \| "error" \| "cancelled", tool_calls?: number, errors?: number, duration_seconds?: number }` |

The schema source deliberately retains `unknown` content/result values and
`object`-typed arguments/parameters where it already used those types; this
draft does not tighten them to `JsonValue` or `JsonObject`. Required members
remain required even when empty (for example `response.tool_calls`), while
nested optional members such as `response.tool_calls[].id` remain optional.
All known optional metadata and payload members from `ContextBase` are also
retained at every hook; only the hook's own required payload is guaranteed by
its request interface.

These are type/interface-only API composition experiments, not runtime
classes. The proposed request is flat like today's wire representation and
retains the explicit `interception_point` discriminator, narrowed to a
per-hook literal. This is intentionally redundant with the hook-specific
request type and can be retained or omitted by a future transport decision.
Each payload already carries the relevant data, so all omit duplicate
`target`. Interfaces are erased at runtime: dispatch/adapters must still
preserve hook identity and derive `target` using the existing inventory above.
`Verdict<TTransform>` centralizes the only three decisions
(`allow`, `deny`, `transform`) together with shared `VerdictFields`.
`HooksResponse<TTransform>` aliases `Verdict<TTransform>`, so the core
response itself is the verdict; its generic specializes only the transform
payload and cannot add decisions. Existing optional verdict metadata
(reason, message, warnings, approval on deny, evidence, and result labels)
remains available. The shared `AllowVerdict`, `DenyVerdict`, and
`TransformVerdict<TTransform>` compose into `Verdict<TTransform>`, while
`NonTransformVerdict` contains only allow/deny.

Each hook response aliases the shared verdict model with its named transform
payload; startup and shutdown responses alias `NonTransformVerdict`. These
definitions describe the core data contract. The bare in-process return shape
matches existing verdict behavior; transport envelopes are a separate hosted
concern. A separate SDK-facing section pairs each request with its matching
response using a synchronous `HookHandler<TRequest, TResponse>` signature.
This illustrates the type pairing only; execution and asynchronous scheduling
remain SDK decisions outside this contract sketch.
Each of the six transformable hooks has a named whole-value replacement
type. The transform object contains the writable request slice, not a
`$target` path or a copy of the complete request. The input, message, response,
tool-result-value, and output types reuse their request property definitions
via indexed access, so required fields stay aligned:

| Hook | Transform type | Replaced request slice |
| --- | --- | --- |
| `input` | `InputHookTransform { input }` | Complete `request.input` |
| `pre_model_call` | `PreModelHookTransform { messages }` | Complete `request.messages` array |
| `post_model_call` | `PostModelHookTransform { response }` | Complete `request.response` |
| `pre_tool_call` | `PreToolHookTransform { args }` | Complete `request.tool_call.args` |
| `post_tool_call` | `PostToolHookTransform { value }` | Only `request.tool_result.value` |
| `output` | `OutputHookTransform { output }` | Complete `request.output` |

These are whole-value replacements: they do not let an interceptor mutate
other request or context fields. They correspond in intent to the existing
wire transform rooted at `$target` (or its deprecated `$policy_target`
alias), where replacing the root replaces that same complete slice. Unlike
the current wire contract, the proposed transform objects do not express
nested path edits. Callers that currently change a nested member must instead
construct and return the updated complete slice. A future adapter could
encode each result as a root-target replacement; it must write the replacement
back only to the mapped request slice. This is a material SDK/API migration
consideration, even though no wire or SDK change is made in this draft.

The current spec forbids transforms for `agent_startup` and `agent_shutdown`;
their response types explicitly use `NonTransformVerdict`. The corresponding
generated startup/shutdown response schemas should expose only allow/deny
alternatives. These TypeScript sketches describe intended shapes only and do
not add runtime JSON validation or change the current wire contract, SDK, or
verdict validation rules.

#### Paired pre-tool examples

[`pre-tool-existing-contract-example.json`](pre-tool-existing-contract-example.json)
and
[`pre-tool-proposed-contract-example.json`](pre-tool-proposed-contract-example.json)
are separate example-instance files for side-by-side comparison. They use the
same tool call and include allow, deny, and whole-args replacement examples.
The existing-side request validates against the generated strict pre-tool
schema, and its bare response verdicts validate against `verdict.schema.json`.
These bare verdicts represent the in-process verdict contract. Proposed
`HooksResponse` examples are also bare verdicts, preserving that return shape;
the alias adds no `{ verdict }` wrapper. Hosted `InterceptorResponse`
transport envelopes for extensions/receipts remain a separate concern: the
current `interceptor-response` gate accepts bare verdicts or an envelope with
optional extensions under §5.5. The proposed-side JSON
illustrates the TypeScript sketch only, not output from or validation against
a new JSON Schema. The current flat request includes
`interception_point: "pre_tool_call"` and `target` matching `tool_call.args`;
the proposed flat request has top-level `spec`, `interception_point`,
`timestamp`, `sequence`, `agent`, `session`, and `tool_call`, but omits
`target`. For transform, the current bare verdict's
`{ path: "$target", value: ... }` whole-target replacement corresponds in
intent to the proposed bare verdict's `{ transform: { args } }` whole-args
replacement.

The broader wire-oriented sketches below remain alternatives for
discussion, not the standalone artifact's API shape.

The following blocks are a separate alternative sketch of the flat wire
`AgentContext`, not the extension-friendly hook request API above. They are
illustrative, not exported SDK types or replacement authoritative schemas.
Import paths are relative to this proposal so reviewers can compare the
existing source directly. Existing scalar validation tags
(formats, patterns, nonnegative integers, bounds) still apply; a
TypeScript `string` or `number` does not enforce them.

```typescript
import type {
  AgentContext as SchemaContext,
  AgentInit,
  Input as SchemaInput,
  Message as SchemaMessage,
  Model as SchemaModel,
  Response as SchemaResponse,
  ToolCallRequest as SchemaToolCallRequest,
  ToolCall as SchemaToolCall,
  ToolResult as SchemaToolResult,
  ToolDecl as SchemaToolDecl,
  Output as SchemaOutput,
  Summary,
} from "../../spec/schema/src/agent-context";

type Envelope = Pick<
  SchemaContext,
  "spec" | "timestamp" | "sequence" | "agent" | "session"
>;
type CommonMetadata = Pick<
  SchemaContext,
  "trace" | "tenant" | "actor" | "budgets" | "extensions"
>;

type InputPayload = SchemaInput;
type Message = SchemaMessage;
type Model = SchemaModel;
type RequestedToolCall = SchemaToolCallRequest;
type ModelResponse = SchemaResponse;
type ToolCall = SchemaToolCall;
type ToolResult = SchemaToolResult;
type ToolDecl = SchemaToolDecl;
type OutputPayload = SchemaOutput;

type KnownPayloads = {
  agent_init: AgentInit;
  input: InputPayload;
  model: Model;
  messages: Message[];
  request_id: string;
  response: ModelResponse;
  usage: NonNullable<SchemaContext["usage"]>;
  tool_call: ToolCall;
  tool_result: ToolResult;
  tools: ToolDecl[];
  output: OutputPayload;
  summary: Summary;
};
```

`Json` expresses the JSON-shaped part of the contract more usefully than
`unknown` or TypeScript's `object` (which also accepts arrays and class
instances). It still cannot guarantee finite numbers, safe integers,
Unicode validity, plain-object serialization, acyclicity, or depth limits.
Validation at a trust boundary remains necessary. The aliases reuse the
current payload inventory; they do not prescribe moving schema source
into the SDK.

#### TypeScript sketch: all eight hook contracts

```typescript
type HookPayloads = {
  agent_startup: Pick<KnownPayloads, "agent_init">;
  input: Pick<KnownPayloads, "input">;
  pre_model_call: Pick<KnownPayloads, "model" | "messages">;
  post_model_call: Pick<KnownPayloads, "model" | "response">;
  pre_tool_call: Pick<KnownPayloads, "tool_call">;
  post_tool_call: Pick<KnownPayloads, "tool_call" | "tool_result">;
  output: Pick<KnownPayloads, "output">;
  agent_shutdown: Pick<KnownPayloads, "summary">;
};
type HookTargets = {
  agent_startup: AgentInit;
  input: InputPayload;
  pre_model_call: Message[];
  post_model_call: ModelResponse;
  pre_tool_call: ToolCall["args"];
  post_tool_call: ToolResult["value"];
  output: OutputPayload;
  agent_shutdown: Summary;
};
type Hook = keyof HookPayloads;
type ContextFor<K extends Hook> = Envelope & CommonMetadata &
  Partial<KnownPayloads> & HookPayloads[K] & {
    interception_point: K;
    target: HookTargets[K];
  };
type ContextByHook = { [K in Hook]: ContextFor<K> };
type HookContext = ContextByHook[Hook];

type AgentStartupContext = ContextByHook["agent_startup"];
type InputContext = ContextByHook["input"];
type PreModelContext = ContextByHook["pre_model_call"];
type PostModelContext = ContextByHook["post_model_call"];
type PreToolContext = ContextByHook["pre_tool_call"];
type PostToolContext = ContextByHook["post_tool_call"];
type OutputContext = ContextByHook["output"];
type AgentShutdownContext = ContextByHook["agent_shutdown"];

function inspect(context: HookContext): void {
  if (context.interception_point === "pre_tool_call") {
    const name: string = context.tool_call.name;
    const args: object = context.target;
    void name;
    void args;
  }
}
```

`Partial<KnownPayloads>` deliberately retains the schema's other known
optional fields instead of inventing `never` exclusions. It includes
`messages` at any hook. Spec section 4.5 describes narrower intended
placement for fields such as `tools`, `usage`, and `request_id`; deciding
whether to enforce that placement is a separate decision, not a harmless
type cleanup. There is no arbitrary root index signature in this sketch,
but TypeScript structural typing is not an exact-object validator.
Unknown-root rejection would be a separate runtime/wire decision.

The proposed refinement is `target: HookTargets[K]`. The current generated
schemas do **not** establish it, and two values of the same TypeScript type
need not be equal. A boundary must establish both shape and the existing
target/payload relationship before exposing a validated `ContextFor<K>`.
An unconstrained wire context and a validated hook view therefore should
not be silently interchangeable.

#### TypeScript sketch: construction, dispatch, and effective targets

```typescript
import type { Verdict, InterceptionRecord } from "../../sdk/typescript/src/index";

interface HookInterceptor<K extends Hook> {
  intercept(context: ContextByHook[K]): Verdict | Promise<Verdict>;
}
interface HookRegistration {
  registerAt<K extends Hook>(
    point: K,
    interceptor: HookInterceptor<K>,
  ): void;
}
type BuilderInputs = {
  [K in Hook]: HookPayloads[K] &
    Partial<Omit<KnownPayloads, keyof HookPayloads[K]>> &
    CommonMetadata;
};
interface TypedBuilderSketch {
  build<K extends Hook>(point: K, input: BuilderInputs[K]): ContextByHook[K];
}
type EffectiveEmission = {
  record: InterceptionRecord;
  target: Json;
};
```

The builder owns sequence/timestamp and the agent/session envelope, derives
`target` from the row above, and does not ask callers to supply the same
value twice. The generic `build` is illustrative; retaining the eight
existing named builder methods with precise return types may be clearer.
`registerAt` would bind runtime dispatch to the same hook as the callback's
type. A cast of a broad callback is not that guarantee. Existing all-hook
interceptors would accept `HookContext` and narrow explicitly.

The effective target stays `Json` in this sketch on purpose. Today's
[transform application](../../sdk/rust/core/src/enforce.rs) permits a
root replacement and writes it back to the hook's associated field for
transformable hooks. It does not establish preservation of the input
payload type. Later sequential interceptors may see that replacement.
Promising `HookTargets[K]` for post-transform snapshots or `emit` results
would be unsound without a further validation rule.

Two candidates remain open: validate shape after each transform before
the next typed callback/action, or expose a distinct post-transform view
whose target and affected payload field are `Json`. The first can reject
previously accepted transforms; the second gives weaker static guarantees.
Existing `emit` returns an effective target and throws on blocking;
`emitUnchecked` requires checking whether execution proceeds. Neither
behavior should be weakened by a typed facade.

### Schema and wire impact (when applicable)

The current schema-only implementation changes draft schema sources,
generated draft schemas, and examples, but **no normative spec prose, SDK
behavior, wire inventories, or published schema URLs**. The common envelope
and hook payloads remain flat in the proposed data contract; the type maps
above do not introduce a nested `agentContext` or `payload` wrapper. The
type artifact retains existing optional known members and an explicit
per-hook `interception_point`, but omits duplicate
`target`; at the existing wire boundary an explicit adapter derives `target`
from the hook's associated payload. Retaining or removing the discriminator
can be decided based on transport needs.

A subsequent agreed design could derive SDK-facing hook variants from
the existing TypeScript schema source and generator pipeline. It would
need to distinguish unrefined wire input from a validated hook view.
Target equality/write-back, sequence monotonicity, I-JSON constraints, and
canonical-byte limits need semantic/runtime checks, not just generated
structural types. No validator should report success by silently copying
an inconsistent target over a payload or vice versa.

Candidate invalid boundary inputs would fail closed before interceptor
dispatch with the existing `host_error:context_invalid` reason and
payload-free diagnostics. Unresolvable transform paths and forbidden
lifecycle transforms retain `host_error:transform_invalid` and
`host_error:transform_target_forbidden`. Whether a newly required
post-transform shape failure uses an existing reason is unresolved.
No new limits, defaults, failure-posture exceptions, or error inventory
entries are selected here.

## Rationale

The existing schema union and eight builder methods provide concrete prior
art. Starting there avoids designing a second hook inventory or importing
one framework's message/tool model into the portable contract. There is
no recorded community consensus on the sketches in this initial draft.

### Options considered

#### A. Keep the current contract

Keep schema variants for validation and broad SDK contexts for dispatch.
Hosts inspect and validate their own indexed conditional fields.

| Advantages | Costs and risks |
| --- | --- |
| No API or runtime compatibility cost; maximum host flexibility. | Repeated adapter checks; no required-payload narrowing; builder knowledge remains erased. |

#### B. Add hook-specific types over the existing wire shape

Expose named types, a discriminated union, and hook-bound entry points,
with explicit validation/refinement boundaries as sketched above.

| Advantages | Costs and risks |
| --- | --- |
| Reuses schema inventory and existing JSON layout; can begin additively. | Must distinguish shape from equality and post-transform state; code generation and SDK parity need design. |

#### C. Introduce a new nested wire envelope

Use `{ envelope, hook, payload }` and derive the target through a typed
accessor rather than duplicating it on the wire.

| Advantages | Costs and risks |
| --- | --- |
| Clear structural separation; may eliminate target/payload duplication. | Wire migration affects every SDK, adapter, identity preimage, approval binding, and schema consumer; not necessary just to expose hook types. |

### Recommendation (for discussion)

Explore B first, preserving the current wire layout and exposing its
required payloads accurately. Do not equate this recommendation with
agreement to tighten accepted JSON, restrict optional members, or validate
every transform against the original shape.

Open decisions for reviewers:

1. Should the first API expose only schema-shaped hook variants, or also
   a validated target refinement? Which boundary establishes the latter?
2. How should typed callbacks after a transform represent potentially
   shape-changing root replacements: revalidation or a distinct view?
3. **Decision for this schema pass:** preserve all existing known optional
   fields at every hook, including shared metadata and nested payload fields.
   Any later restriction to section 4.5 placement requires a separate
   compatibility decision.
4. Should builders and wire parsers reject unequal target/payload pairs
   using deep JSON equality, or should only builders derive targets while
   parsers expose an unrefined wire type? No silent repair is proposed.
5. Generate public types from the existing schema source, generate from
   JSON Schema, or maintain thin adapters with equivalence tests? How do
   generator closure rules and runtime validation stay aligned?
6. Preserve current named builder methods and add `registerAt`, or prefer
   a generic mapped API? Should hook-bound registration support several
   hooks as a discriminated union?

### Related decisions (optional)

[P-006](P-006-interceptor-response-envelope.md) keeps transport metadata
outside canonical Verdict. This proposal likewise keeps `Verdict`
unchanged. [P-004](P-004-identity-as-optional-seam.md) and
[P-008](P-008-failure-posture.md) remain in force: hook types do not
require an identity provider or make context failures continuable.

## Security and privacy

Static types do not turn untrusted model/tool data into trusted content.
Runtime validation remains necessary before a refined callback sees
external data. Rejecting invalid shapes should preserve fail-closed
behavior and produce field-path/type diagnostics without logging payloads.
No new sensitive fields, receipts, or payload retention are introduced;
records remain payload-free.

Target/payload mismatch is especially important: evaluating one value and
executing another would defeat the contract. Builders should derive the
pair, and any validated facade must define how it establishes consistency.
The host still consumes the effective post-composition target, not a
captured pre-emission value. Approval echo/binding, canonical identity
projection, reserved extension namespaces, and trust in host/interceptors
are unchanged. New checks would need bounded traversal; TypeScript alone
cannot enforce resource bounds. Actual vulnerabilities belong in the
private process described in [SECURITY.md](../../SECURITY.md).

## Backward compatibility

This documentation-only draft changes no accepted inputs or released APIs.
For a future rollout, start with additive named types and opt-in
hook-bound APIs, leaving legacy builders, broad interceptors, JSON
marshalling, declarations, and existing wire producers/consumers working.
Old consumers can read the same JSON; new consumers must validate old
producers' data rather than assert it has the stronger type.

Do not replace the broad SDK context in place until source compatibility
has been assessed. Callers may construct contexts incrementally, read
indexed fields, carry additional members, or rely on shape-changing
transforms. A legacy adapter cannot discard unknown data, silently repair
targets, or claim full schema validity based on today's envelope gate.

Under [VERSIONING.md](../../VERSIONING.md), an additive SDK facade with
unchanged behavior is a candidate package-minor addition. Breaking public
API changes require a shared SDK major release; changes to required or
conditional fields require spec MAJOR. New rejection rules that narrow
previously valid behavior need explicit compatibility classification
before adoption, not an assumed "typing-only" label. Wire version,
declaration-contract version, and package version are separate axes.
This draft changes none of them; hook-bound APIs alone do not require a
new declaration-contract version.

## Performance and operational impact (optional)

Type aliases have no runtime cost. Target consistency checks, full schema
validation, copies, and post-transform revalidation would have runtime
cost proportional to inspected data; no measurements are available.
Prefer existing snapshot/write-back machinery rather than new copies
solely to satisfy TypeScript. Latency, traversal bounds, and operator
diagnostics need measurement if stronger gates are selected.

## SDK surface and implementation impact

Implementation follows contract agreement, not this draft. A possible
sequence is schema-equivalent named SDK types, precise builder returns,
then opt-in hook-bound registration with explicit boundary validation.
Resolve post-transform callback types before connecting the facade to
sequential composition.

The Rust core currently uses a JSON map; typed wrappers could preserve
that implementation but cannot pretend its envelope validator establishes
all refined properties. Any shared semantic checks belong in the core
and flow through the JSON-based FFI rather than diverging per wrapper.
FFI entry points need not change for purely static additions.

TypeScript's `AgentContext`, `AgentContextBuilder`, `Interceptor`,
managed interceptor inputs, emitter outcomes, declaration kind resolvers,
and approval context views need consistent treatment where they expose
contexts. Python, .NET, and Go need idiomatic hook variants/builders and
runtime parity if checks change; Rust needs an equivalent safe view, not
necessarily identical generic syntax. These are implementation surfaces
to assess, not claims that each language currently has the same typing gap.
Verdict parsing, hosted response envelopes, composition profiles, failure posture,
approval resolution, identity providers, and record shape stay unchanged
unless a later explicit decision says otherwise.

## Conformance and tests

This PR adds no normative behavior or conformance claims. After agreement,
use generated-schema fixtures for wire structure, TypeScript compile-time
tests for narrowing and construction, and shared CTK vectors for any new
runtime semantics. Existing conformance claims/capabilities/profiles are
unchanged; static typing is not a new conformance tier.

| Case | Expected result |
| --- | --- |
| Valid fixture for each of the eight hooks | Corresponding variant accepts it; required fields match the existing per-hook schema. |
| Missing hook payload, wrong discriminator, missing nested required member | Compile-time failure for typed construction; runtime rejection according to the chosen validated boundary, before dispatch. |
| Narrow `HookContext` to `pre_tool_call` | `tool_call` and object-valued input target are available without assertions. |
| Treat `post_tool_call.target` as the full result wrapper | Compile-time rejection without narrowing; target is the JSON result value. |
| Model response has no tool calls | Required `tool_calls: []` remains valid; omitted `tool_calls` is invalid. |
| Model-requested tool call lacks optional `id` | Remains schema-valid; no new wire requirement inherited from the current builder signature. |
| Default input role and default tool-result error flag | Existing named builder defaults (`user`, `false`) remain unless explicitly redesigned. |
| Known optional fields and namespaced extensions | Preserved as in the existing schema; any later restriction is a separate compatibility decision. |
| Same-shaped but unequal target/payload values | Not proven equal by types or existing schemas; selected validated refinement must reject, not repair. |
| Root transform changes payload shape before another callback | Exercise both design candidates; do not expose the original refined type without validation. |
| Sequential target transform | Next callback/action sees the effective target and corresponding write-back; post-tool arguments reflect execution. |
| `evaluate_only` and lifecycle transforms | Existing validate-without-apply behavior and forbidden-transform errors remain. |
| Invalid JSON-domain values and excessive depth/size | Existing applicable gates remain fail-closed; candidate validation must not bypass resource bounds. |
| Approval, identity, failure posture, and payload-free records | Existing vectors continue unchanged; add vectors only for newly agreed observable behavior. |
