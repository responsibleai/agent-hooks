# P-007: Declaration-only construction

- **Status:** Draft
- **Created:** 2026-10-15
- **Author(s):** Mohammad Abuomar `<40180927+MohammadHaroonAbuomar@users.noreply.github.com>` (@MohammadHaroonAbuomar)
- **PR:** https://github.com/responsibleai/agent-hooks/pull/144

See the [proposal process](README.md) for scope, lifecycle, decision
authority, and review window.

## Abstract

An emitter is the object a host builds to run its interceptors and to
write one audit record per emission. Every SDK builds one in two ways
today, and the two ways do not build the same thing. A host that loads
a host declaration document gets an emitter the loader has checked and
sealed, with every binding named, and records that carry the
declaration contract version. A host that calls the constructor and
`register` gets none of that: no checks, no seal, no binding ids, and
records without `declaration`.

This proposal makes the declaration the one way to build an emitter.
The host supplies the document from a file, from JSON text, from a
value, or writes it in code through an emitter builder; all four reach
the same loader. An interceptor the host supplies in code binds under
a kind this specification defines, `agent_hooks.inline`. Every record
carries `declaration`, and every verdict summary carries the binding
id. The existing constructors, setters and `register` calls stay
supported as a second entry to the same pipeline: the loader's checks
run at each call, and the emitter seals at `seal()` or at its first
emission. Nothing is deprecated. The record schema, the declaration
contract and the wire version do not move. The change touches §7.7,
§10.3, §13.1 and §13.3 of the specification, the conformance test kit
(CTK), and the construction code of each SDK.

## The gap (Motivation)

Every SDK has two construction paths, and they differ in what they
check, what they seal and what they record.

The code path, which this proposal calls the register path, is the
constructor plus `register` and its overloads, in every SDK; Backward
compatibility lists them. It builds no `HostDeclaration`, is never
sealed, gives a binding no id (an unnamed registration leaves
`verdicts[].name` absent), has no per-binding timeout, and its records
omit `declaration`. It runs none of the checks a file gets: no id
grammar, no uniqueness, no 256-binding bound, no 64-character cap on
provider names, no timeout range.

The declaration path is `from_declaration`, `from_declaration_path`,
`from_declaration_json` and `from_declaration_value`, plus the
`DeclarationBuilder`, whose value the SDK serializes and parses again.
It runs every loader check, gives each binding an id, fixes its points
and its timeout, seals the emitter and stamps the contract version on
every record.

The two paths differ in record bytes (`declaration`, `verdicts[].name`)
and in defaults. A declaration defaults the interceptor timeout to
5000 ms. The Rust code path has no timeout at all (`None`, unbounded);
the Python, TypeScript, .NET and Go code paths default to 5000 ms. A
Rust build without timeout support refuses a numeric timeout on the
declaration path and silently ignores `set_timeout` on the code path.

Four readers pay for the difference. An operator reading records from
two hosts with the same configuration sees two record shapes, and the
code-path record names no contract, so it says nothing about which
bounds applied. An auditor sees unnamed verdicts from one host and
named ones from the other. A host author gets different bounds and
different refusals depending on which API they picked. A conformance
claim can cite a document only for a host on the declaration path.

The specification says in four places that configuration in code
carries no declaration and is not sealed (§7.7.1, §7.7.7, §7.7.8 and
the §10.3 record table). The README, the implementation guide and
three SDK READMEs repeat it, and tests in all five SDKs pin it.

Two facts about the current code bear on the design. The
`HostRegistry` in all five SDKs refuses a kind whose first segment is
`agent_hooks` or `ctk` and opens `ctk` only through `for_conformance`,
so every SDK already refuses a kind this specification owns. And all
five reference harnesses already wrap code-supplied interceptors in a
declaration: they route the 51 field-based vectors through the loader
under a `ctk.instance` kind with ids `interceptor-<index>`. The
precedent exists in the code, not in the specification.

The two downstream conformance claims sit on different paths. The
claim for a policy decision runtime on the Rust SDK is on the code
path, with 22 `host_declaration` skips. The claim for an agent
framework adapter on the Python SDK does not declare
`host_declaration`, and the adapter's mapping factory builds a
code-path emitter on every run.

The process requires a proposal for a change to the record shape (§10)
and for a change to what a conformance claim asserts (§13.3). This
change does both: every record from a host configured in code gains
`declaration` and `verdicts[].name`, and §13.3 gains a rule on which
documents a claim may cite.

## Goals and non-goals (optional)

Goals:

- One construction pipeline. Every emitter passes steps 2 to 12 of
  §7.7.6, whatever the host wrote: a file, JSON text, a value, or code.
- One record shape. Every record carries `declaration`; every verdict
  summary carries the binding id.
- One set of bounds and refusal classes, with the same pointers, for
  every host.
- A builder as the code API. It writes a declaration and a registry;
  the document it writes is the host's configuration written down, and
  a file can name the same kind. The existing constructors, setters
  and `register` calls stay supported and feed the same pipeline.
- Source compatibility in all five SDKs and binary compatibility in
  .NET: every call that compiles today compiles after this change with
  no new diagnostic, and runs unchanged unless it hits a refusal listed
  under Backward compatibility.
- No declaration contract bump and no wire bump.

Non-goals:

- The record schema. `declaration` stays OPTIONAL in `agent-hooks/0.1`;
  making it REQUIRED is a wire MAJOR.
- The declaration contract. No member, enum value or default changes;
  `agent-hooks-declaration/1.1` stays current and 1.0 stays accepted.
- Dispatch, composition, verdicts, and the record envelope beyond the
  two members above.
- The `host_declaration` capability. Narrowing the enum is a
  declaration MAJOR (§7.7.2).
- A surface or posture setter on the existing API.
- A new FFI function. The Python, TypeScript, .NET and Go SDKs
  serialize the document and call the core's `ah_declaration_resolve`
  as they do today.
- Includes, overlays or layering. Assembling one document from several
  files stays a host or channel step (§7.7.4); if that need turns out
  to be common, it is a small follow-on proposal, and nothing here
  blocks it.
- The interceptor response envelope
  ([P-006](P-006-interceptor-response-envelope.md)). It touches no
  record member this proposal touches.

Trust assumptions do not move; Security and privacy says why.

## Specification

### Recommended normative semantics

The edits below are the whole change to `spec/AGENT-HOOKS-0.1.md`.
Quoted text is proposed text; the rest says where it goes. The
contract version does not move; Backward compatibility gives the
§7.7.2 reasoning.

#### §7.7.1 Purpose and scope

Replace the opening MAY sentence with:

> Every emitter is built from one JSON document, the **host
> declaration**, through the loader of §7.7.6. A host loads the
> document from a file, from JSON text or from a value, or the SDK
> writes it from the configuration and interceptors the host gives in
> code through the emitter builder (§7.7.7).

Extend the widening rule. The document MUST NOT widen the surface
beyond what the host's code reports, "or, for a document the SDK writes
from code, beyond the points the emitter admits (§7.7.4)".

Replace the closing paragraph (configuration in code remains conformant
and such records carry no `declaration`) with:

> There is no emitter without a declaration. Configuration in code is
> a way of writing a declaration, not a way around it, and such a
> host's records carry `declaration` like every other host's (§7.7.8).
> An emitter a host configures by `register` and setters before its
> first emission is written down the same way (§7.7.7).
>
> One document per emitter says nothing about where bindings come
> from. `bindings` is an ordered list and may carry bindings from any
> number of sources, written in code or in a file: an audit set and a
> policy set sit side by side, each with its own kind and config, and
> the composition profile combines their verdicts. In code, the builder
> collects every `bind` call, from any package, into that one document.
> Assembling one document from several files is a host or channel
> step; this version defines no includes or overlays (§7.7.4).

#### §7.7.3 Members and defaults

The `surface` row keeps its default, the host's own surface; §7.7.4
states once where the surface of an SDK-written document comes from.
The `posture.tool_seam_host_error` row keeps "MUST equal the posture
the code implements" and gains the pointer "(§7.7.4; a host on the
register path of §7.7.7 cannot state it, and that section says what
follows)".

After "Registered names match `^[a-z][a-z0-9_-]{0,63}$`." add:

> Names beginning with `agent_hooks-` are reserved for references an
> SDK registers on the host's behalf, such as the approval resolver and
> redactor a host passes in code on the register path
> (`agent_hooks-approval-resolver`, `agent_hooks-approval-redactor`); a
> registry MUST refuse them when host code registers them. They never
> reach a record (§7.7.8).

After the Bounds paragraph add:

> A document the SDK writes from code is subject to every bound. A
> host that binds more than 256 interceptors is refused like a file
> that lists them, and a name a host gives a binding MUST match the
> `id` grammar of §7.7.5.

#### §7.7.4 Surface

Keep "Every stated member MUST be a subset of what the host's code
reports, and the configured posture MUST equal the one the code
implements." Scope the default sentence to loaded documents: "When a
loaded document omits `surface` the resolved document carries the
host's own surface verbatim, streaming posture included [...]. That
default is always honourable and never a guess, because the host's
code reported it." Then add a new paragraph:

> The emitter builder (§7.7.7) always writes `surface`, so the
> document it writes stands on its own and never relies on the fill
> above. When the host states a surface, or supplies a registry whose
> surface is its own, the builder writes that surface and the registry
> reports it. When the host states none, the builder writes the
> surface of the emitter it builds: every §3 point, `model_calls` and
> `tool_calls`, every profile with every knob value,
> `buffered_output: true`, this build's timeout support and every
> contract version the loader accepts; `posture` is written from the
> builder's posture setter, `continue` unless the host set it. This
> surface states what the emitter admits, not what the host's loop
> emits. It is honourable for dispatch, because the emitter admits
> every point it lists, and the registry the builder owns reports the
> same surface, so step 8 of §7.7.6 holds by construction. It is not
> the host's declared surface of §13.1. A host on the builder whose
> loop omits a point pair, whose posture is `terminate`, or whose
> output is unbuffered MUST state its surface, or its posture, before
> its first binding. The builder checks each binding's `at` against
> the surface at the call, so the surface comes first. A host on the
> register path (§7.7.7) cannot state either and SHOULD move to the
> builder when its loop, posture or output differs from what the
> default states. The builder never writes `host_declaration` on the
> host's behalf (§7.7.9); a host states it. A document carrying the
> builder's default surface MUST NOT be cited by a claim (§13.3).

The capability-list sentence is unchanged, and so is the paragraph on
includes, overlays and layering. `host_declaration` stays in the
vocabulary, with the one meaning §7.7.9 gives it.

#### §7.7.5 Bindings

Replace "This specification defines no kinds." with:

> This specification defines one kind, `agent_hooks.inline`: an
> interceptor instance the host supplies in code. Its resolver ships
> inside each SDK. The registry installs that resolver on the first
> `inline(id, instance)` call, and that call is the only way to put
> anything under this kind: `kind()` keeps refusing the `agent_hooks`
> head for every caller, the conformance registry included. The
> binding `id` is the lookup key; the resolver returns the instance
> registered under it. `config` MUST be absent or the empty object;
> any other value is `declaration_error:binding_rejected` with the
> detail `agent_hooks.inline takes no config`. A document loaded from
> a file MAY name the kind and so bind an instance the host registered
> in code. A registry with no inline instance registered does not know
> the kind, and a document naming it is refused
> `declaration_error:kind_unknown` at step 10. A registry with inline
> instances but none under the binding's `id` refuses that binding at
> step 11, `declaration_error:binding_rejected`, with a finding that
> names the id. Every other kind under `agent_hooks` stays reserved for
> later revisions; `ctk` stays the CTK's.

In the kind-resolver paragraph, after "The host registers **kind
resolvers** in code." add: "It registers interceptor instances by
binding id for `agent_hooks.inline`; the instance table is part of the
registry (§7.7.7)."

After the sentence that makes `bindings` REQUIRED add:

> An SDK writing a document from code writes `bindings` out even when
> the host bound nothing, so an empty-deny host built in code is
> written down too. An inline binding the host did not name gets the
> id `interceptor-<index>`, the binding's zero-based position in the
> array.

#### §7.7.6 Loading and refusal

Keep "Refusal MUST happen before any emitter exists and MUST leave no
record." Add after it:

> The emitter builder returns an emitter only from a complete document,
> so its refusal is a construction error like a file's, raised by
> `build()`. On the register path (§7.7.7) the object a host
> configures has produced no record. Each call that writes a member
> runs the loader's checks for that member (the `id` grammar and
> length, uniqueness against earlier and synthesized ids, a non-empty
> `at` inside the surface, the 256-binding bound, the timeout range,
> the record-bound range, the 64-character cap on registered names)
> and raises the loader's class and pointer at that call. Over the
> SDK's own registry, steps 8 to 11 hold by construction, so the seal
> has nothing left to refuse; `seal()` stays the explicit channel and
> MUST return any refusal that remains rather than record anything.
> The first emission seals the object.

#### §7.7.7 Equivalence and sealing

Replace the section with:

> Every emitter is a function of its resolved declaration and the
> host's registry. Three document paths yield the same emitter:
>
> - from a file path: step 1, then the JSON text path;
> - from JSON text: steps 2 to 11;
> - from a value built in code, through the declaration builder, with
>   one setter per member and one call per binding: the value is
>   serialized and handed to the JSON text path, so the value path is
>   validated by the same function, with the same classes, as a file.
>
> The emitter builder is not a fourth path. It writes a document and a
> registry: each setter writes one member, each `bind` registers the
> instance under `agent_hooks.inline` by binding id and writes one
> binding envelope, and `build()` hands the document to the value
> path.
>
> Equal resolved declarations and equal registries MUST yield
> byte-identical interception records for the same context sequence.
> The instance table is part of the registry: two registries are equal
> only when every name and every binding id resolves to an instance of
> the same behaviour. Equal canonical documents with different
> instances are not equal registries, exactly as two hosts behind one
> host kind need equivalent code. Timing is excluded; records never
> carry it.
>
> Every emitter is sealed from construction, which on the register path
> (below) is its first emission or `seal()`: it MUST refuse later
> registration and reconfiguration (composition, identity provider,
> timeouts, failure posture, approval redactor, record bound).
> Otherwise the declaration would not be what ran. Changing where
> records go (the record sink, draining the buffer) stays allowed; it
> changes delivery, not content.
>
> The register path is the constructor and setters of earlier
> revisions: registration and reconfiguration on an emitter object
> before its first emission. It is a second entry to the same
> pipeline, not a way around it, and it stays supported. Such an
> object is a pending emitter. It has produced no record. The SDK
> collects the calls made on it into a builder, writes and loads the
> document at the first emission or at an explicit `seal()`, and from
> then on the object is sealed and its records are those of the
> equivalent builder-built emitter. On the register path the SDK
> writes the builder's default surface and posture `continue`; the
> host has no way to state another. For a host whose loop implements
> `terminate`, that document misstates the host. Its records are
> unaffected, because records carry no posture and the CTK takes
> posture from the harness (§13.1). But the document is unfit to cite
> (§13.3), and such a host SHOULD state its surface, or its posture,
> on the builder. The register path keeps the defaults of the revision
> before this one (an unbounded timeout where the constructor and
> setters set none), so behaviour under a host does not change; the
> builder takes the document defaults of §7.7.3.

#### §7.7.8 Records

Replace the first paragraph, up to "the host name or resolver names",
with the text below. The sentences on `on_error` and `substituted_for`
that follow it are unchanged.

> Every record carries `declaration`: the contract version of the
> document the emitter was loaded from, the SDK-written document
> included; a document the SDK writes under this revision carries
> `agent-hooks-declaration/1.1`. The member stays OPTIONAL in the
> `agent-hooks/0.1` record schema (§10.3) so that records written
> before this revision stay valid; a host of this revision writes it on
> every record and MUST NOT default it: the value is read from the
> loaded document. It is one string from a closed grammar, so it is
> payload-free by construction. Nothing else from the document reaches
> the record: not the `id`, a digest, the path, kinds, configs, the
> host name or resolver names.

Replace "For a host without `at` filters the values equal what they
are today." with:

> For an inline binding the host did not name, the id is
> `interceptor-<index>`, so a host that named nothing sees names on
> its records from this revision on. `interceptors_registered`,
> `verdicts[].index` and `decided_by` equal what they were for a host
> without `at` filters.

Extend the load-log sentence:

> A host SHOULD log the contract version, the document `id` and the
> `jcs-sha256` digest of the resolved document once at load, outside
> the record stream, so an operator can match a running host to a
> pushed document. The SDK exposes the resolved document and its digest
> (`digest()`), and the builder exposes the document it will load
> (`document()`), so a document the SDK wrote from code is logged the
> same way, with `id` absent unless the host set one.

#### §7.7.9 Conformance

Replace the first paragraph with:

> The CTK capability `host_declaration` declares that the host's
> harness implements the declaration seam: it builds its emitter from
> the document the CTK supplies, together with the CTK's registry, and
> surfaces refusal as a load outcome, never as a run. It no longer
> says that the host builds its emitter from a declaration; every
> emitter of this revision does. In a document's `surface.capabilities`
> (§7.7.4) the member has this one meaning, and the SDK never writes it
> on the host's behalf. The vector parts that carry a document
> (`declaration/*` and `failure_posture/*`,
> `conformance/vectors/AH-CTK-120` onwards) stay gated on it; a
> harness that does not declare it skips them, and the skip detail
> says the declaration seam is not implemented. The runner proves the
> three document paths of §7.7.7 on every such vector and refuses to
> pass a vector whose paths diverge. The equivalence of the emitter
> builder to a document naming `agent_hooks.inline` is pinned by the
> golden fixtures under `conformance/golden/` and by each SDK's tests,
> not by a vector, because the instances live in the registry, not in
> the document.

Add a second paragraph, on posture:

> The loader fills `continue` for a document that states no posture,
> and step 8 refuses a mismatch with the host's code (§7.7.4). A
> vector document that states no posture is posture-silent, not
> posture-`continue`. The runner writes the harness's declared posture
> (§13.1) into `configuration.posture.tool_seam_host_error` before it
> proves the paths and before it hands the document to the harness, so
> a `terminate` host loads what a `continue` host loads and a refusal
> vector refuses at the step the vector names. A vector whose document
> states a posture keeps it, and its expected load outcome is
> posture-conditional (`expect.load_by_posture`, with the shape and
> the default-equality rule of `run_outcome_by_posture`): a `terminate`
> host is expected to refuse a document that states `continue` with
> `declaration_error:surface_unsupported`, which is what a conformant
> loader does.

Add a third:

> One ungated vector asserts `declaration` on a record of a floor-only
> scenario, so every harness is checked for the stamp however it built
> its emitter.

The paragraph on presenting the §13.1 surface as a document is
unchanged.

#### §10.3 The interception record

The `jsonc` comment on `declaration` becomes "the contract version the
emitter was loaded from (§7.7.8); every host of this revision writes
it". Table rows:

- `declaration`: "OPTIONAL in the schema, for records written before
  this revision; a host of this revision writes it on every record.
  The host declaration contract version the emitter was loaded from
  (§7.7.8), e.g. `agent-hooks-declaration/1.1`. Never defaulted."
- `verdicts`: "`name` is the binding `id` (§7.7.5): the id the host
  gave, or `interceptor-<index>` for an inline binding the host did not
  name. It MUST be payload-free." The rest of the row is unchanged.
- `decided_by`: "Registration index" becomes "Dispatch index: the
  position in the list of interceptors bound at the emitted point
  (§7.7.5)". The rest of the row is unchanged.

#### §13.1 and §13.3 Claims

§13.1 gains one sentence after the MAY on presenting the surface: "A
host built in code states its surface to the emitter builder
(§7.7.4)."

In §13.3, replace the sentence on citing a document with:

> A claim that cites a host declaration document (§7.7) MUST cite the
> document whose resolved surface the CTK run used, and that document
> MUST carry an explicit `surface`. A host built in code MAY cite the
> document the SDK wrote, exported from the host at the claimed
> commit, only when the host stated its surface to the builder
> (§7.7.4); a document carrying the builder's default surface describes
> the emitter, not the host, and MUST NOT be cited. A claim SHOULD
> declare `host_declaration` so the `declaration/*` parts appear in
> the report; from 0.1.0 it MUST. The §13.3 tuple is unchanged.

#### Adjacent edits

Editorial edits that keep the meaning and unify the vocabulary:

- §7 and §7.4: "zero registered interceptors" becomes "zero
  interceptors bound at the emitted point (§7.7.5)"; "registration
  order" becomes "binding order (array order, §7.7.5)". The §11
  `host_error:no_interceptor` row follows.
- §9 and the §5 verdict table: "registered resolver" becomes
  "configured resolver", meaning named in the resolved declaration
  (§7.7.3); the emitter never consults a registered resolver the
  document does not name.
- §10.1: the provider-name grammar gains the 64-character cap the only
  construction path now applies: `^[a-z][a-z0-9_-]{0,63}$`.
- §14: one sentence. A document the SDK writes from code is the host's
  own configuration at host trust, produced by code the host loaded,
  and the load log applies to it as to a file.

### Schema and wire impact (when applicable)

The schemas keep their shape. The edits are description text,
generated from the TypeScript sources under `spec/schema/src/`:

- `spec/schema/interception-record.schema.json`: the `declaration` and
  `verdicts[].name` descriptions follow the §10.3 rows above.
- `spec/schema/host-declaration-1.0.schema.json` and
  `spec/schema/host-declaration-1.1.schema.json`:
  `surface.interception_points` reads "Points the host emits, or, for
  a document the SDK writes from code, the points the emitter admits
  (§7.7.4)"; the `bindings[].kind` description names the one defined
  kind.
- `spec/declaration-errors.json`: unchanged; no new class.
  `kind_unknown` still means a kind with no resolver, and
  `binding_rejected` still means a resolver refused.
- `spec/DECLARATION-VERSIONS.md`: the contract rows gain a note that
  this revision defines `agent_hooks.inline` under 1.0 and 1.1, and
  that a loader from an earlier release refuses a document naming it
  with `kind_unknown`. No new SDK-release row: the file requires one
  only for a tag that changes the accepted set or the current version,
  and this change does neither.
- `conformance/vectors.schema.json`: the `host_declaration` capability
  description says the seam; `expect.load_by_posture` is added next to
  `run_outcome_by_posture`; the `host_declaration` member description
  names the inline instances the CTK registry holds.
- `VERSIONING.md`: a note that `declaration` stays OPTIONAL in
  `agent-hooks/0.1`.

The binding envelope the SDK writes for an unnamed instance is, as
proposed:

```json
{ "id": "interceptor-0", "kind": "agent_hooks.inline" }
```

The loader fills `config`, `at`, `timeout_ms` and `on_error` as for
any binding. The golden file named under Conformance and tests pins
the canonical resolved documents the builder writes; this section does
not repeat them. Two constraints need SDK validation rather than JSON
Schema: that `config` under `agent_hooks.inline` is absent or empty,
and that a registered name does not start with `agent_hooks-`.

## Rationale

### Options considered

Besides the current contract, three designs compete on four counts:
one construction model, host compatibility, consistency across the
five SDKs, and the work each takes.

#### A. Keep the current contract

Two paths stay. §7.7.7 keeps its last paragraph: the constructor and
setters do not pass through the loader, carry no declaration and are
not sealed. A host that wants the loader's checks, a sealed emitter
and a citable document loads a file; a host on the register path gets
records without `declaration`. The reference harnesses keep wrapping
code instances under the CTK's private `ctk.instance` kind.

| Advantages | Costs and risks |
| --- | --- |
| No specification, SDK or record change. | Two record shapes stay for one configuration, and the register-path record says nothing about which bounds applied. |
| No host sees a new refusal. | Register-path hosts keep no bounds: no id grammar, no uniqueness, no 256-binding cap, no timeout range. |
| | A claim can cite a document only for a host on the declaration path. |
| | Every SDK keeps two construction models that can drift, and the harness precedent stays private to the CTK. |

#### B. The existing API over a private kind

Every public constructor, setter and `register` stays and nothing is
deprecated. Each call writes one member, or one binding of an
SDK-private kind `agent_hooks.inline` with config `{"slot": n}`, into
a document. The emitter seals at `seal()` or at the first emission by
handing that document to `from_declaration_value` with an
SDK-internal registry.

| Advantages | Costs and risks |
| --- | --- |
| The best host compatibility: no diagnostics, so downstream builds that treat warnings as errors keep building. | The written document is one no host registry can load: the kind is SDK-private, so a file naming it gets `kind_unknown`. |
| Eager checks at the `register` call. | An emitter has a permanent open state: `declaration()` is empty until the first emission, and the refusal rule weakens from "before any emitter exists" to "before any emission". |
| The least work. | The Rust register path writes `interceptor_ms: null` where the other four write 5000, so the same calls give different canonical documents. |

#### C. One constructor, the existing API deprecated

Exactly one constructor, `from_declaration`. The registry gains an
instance table, `HostRegistry::instance(id, interceptor)`, under a
specification-owned kind `agent_hooks.instance` that is always present
and takes an empty config. A new `EmitterBuilder` is the primary code
API. The existing API becomes a thin deprecated wrapper that rebuilds
the emitter through the loader on every setter or `register` call, so
`declaration()` is always present and a refusal surfaces at the
offending call with the file's class and pointer. The wrapper is
removed in 0.2.

| Advantages | Costs and risks |
| --- | --- |
| The cleanest model: one constructor, one path. | Every public constructor and setter in five SDKs gets a deprecation marker, and two downstream builds treat warnings as errors. |
| A file may bind a code instance by id, which replaces the host-private kind an adapter must otherwise invent. | Rust `set_timeout` on an unbounded build turns from a no-op into a refusal; TypeScript error types change; Go's exported `Timeout` field is deprecated. |
| No SDK duplicates loader checks. | Every setter or `register` call pays a loader round, so an adapter that builds a fresh emitter per run pays several per run. |
| | The claim rule it adds puts both filed claims out of date at the tag. |
| | The most work. |

#### D. One kind, a builder, the existing API kept

Every emitter exists only after a document has passed the loader. The
host supplies the document from a file, from JSON text, from a value,
or through a new emitter builder: a thin wrapper over the existing
`DeclarationBuilder` plus a `HostRegistry` it owns, with one setter
per member and one `bind` per binding, which registers the instance
under `agent_hooks.inline` by binding id. `build()` hands the document
to the value path. `kind()` keeps refusing the `agent_hooks` head for
every caller; `inline(id, instance)` is the only entry, and a file may
name the kind. The existing constructors, setters and `register` calls
stay, without deprecation, as a pending emitter that collects calls
into a builder, checks each call as the loader would, and seals at
`seal()` or at the first emission. The reference harnesses move from
`ctk.instance` to the specification kind.

One variant of D does not survive: the pending emitter as a deprecated
path for one release, behind a Rust cargo feature
`legacy-registration` (default on) and deprecation diagnostics in the
other four SDKs, with removal in 0.2 and the seal only at the first
emission. It carries C's deprecation costs, and its lazy seal moves a
refusal to the first emission, which in Rust is a panic mid-run unless
the host calls `seal()`.

| Advantages | Costs and risks |
| --- | --- |
| One pipeline and one record shape, because the existing API writes and loads the same document the builder does. | Two supported ways to build an emitter stay in five SDKs, and they can drift. |
| Source compatible everywhere, .NET binary compatible, no diagnostic. | Five SDKs must write byte-identical documents for the same calls, or the §7.7.7 promise fails quietly. |
| The builder writes document defaults explicitly, so the same calls give identical canonical documents in all five SDKs on bounded builds. | A resolver installed on the first `inline()` call makes `names().kinds` depend on registry state. |
| A file may bind a code instance by id. | The builder's default surface over-claims for a host whose loop omits a point pair. |
| Go gets one error channel: `build()` returns a refusal as an error. | A host with a non-default posture or unbuffered output must state it on the builder. |

### Recommendation (for discussion)

Option D. It reaches one pipeline and one record shape without
removing a public API. Removal is a separate decision with its own
cost, and no goal needs it. Keeping the API also spares a migration
for the two downstream builds that treat warnings as errors. Issue
[#138](https://github.com/responsibleai/agent-hooks/issues/138)
records the same direction.

From B, D takes the eager check at each register call, the explicit
`seal()` (so no refusal waits for the first emission), the ungated
record vector, and the rule that a host with a non-default posture or
unbuffered output states it on the builder. From C it takes the
reserved `agent_hooks-` name prefix, `digest()` and `document()`, and
the per-SDK test that `kind()` refuses the `agent_hooks` head.

D leaves two parts out. The register path gets no surface or posture
setter: the builder is the code API and the place a host states what
the register path cannot, and setters on both would give five SDKs two
surfaces to keep equal. A claim MUST for `host_declaration` waits for
0.1.0, so that both filed claims can re-run first.

Three choices inside D have a recorded alternative:

- The inline kind is `agent_hooks.inline`, with its resolver installed
  on the first `inline(id, instance)` call. The alternative is
  `agent_hooks.instance`, always present, so the class is always
  `binding_rejected`.
- The builder always writes `surface`, the emitter's own when the host
  states none, and that default is not citable. The alternative, a
  builder that fills `surface` from the host like a loaded document,
  has nothing to fill from on the register path.
- The register path keeps today's defaults while the builder takes the
  document's, so the parity test must pin the two differences
  Backward compatibility lists. The alternative, one set of defaults,
  changes behaviour under a running host.

One objection stands against the whole design. §7.7.7 today records
the opposite decision: the constructor and setters stay outside the
loader rather than pass through an invented declaration. The answer is
that the document the SDK writes is not invented. It is the host's
configuration plus a surface the host states or the emitter admits,
and one construction path is worth the one-time record change.

### Related decisions (optional)

- Issue [#138](https://github.com/responsibleai/agent-hooks/issues/138)
  sets the direction this proposal writes down.
- The failure posture of [P-008](P-008-failure-posture.md) is
  untouched: `on_error` stays in the binding envelope the inline kind
  uses, and the sealed set already includes it.
- [P-006](P-006-interceptor-response-envelope.md), the interceptor
  response envelope, shares no record member with this proposal.
- Specification sections touched: §7.7.1 and §7.7.3 to §7.7.9, §10.3,
  §13.1 and §13.3, with editorial edits to §5, §7, §7.4, §9, §10.1,
  §11 and §14.

## Security and privacy

The trust boundary does not move. A document the SDK writes from code
is the host's own configuration at host trust, produced by code the
host loaded; it carries nothing a file does not carry, and the §14
load-log guidance applies to it as to a file.

Fail-closed behaviour gets stronger for register-path hosts, not
weaker. Today nothing checks them. After this change the loader's
bounds (256 bindings, 64-character ids and names, the timeout and
record-bound ranges, a 1 MiB document) apply to every host. A refusal
on the register path surfaces at the offending call before any record
exists, and `seal()` returns a refusal rather than recording anything.
A refusal stays a construction error, never a verdict.

Records stay payload-free. `declaration` is one string from a closed
grammar. `verdicts[].name` is the binding `id`, which the id grammar
confines to 64 characters of `[a-z0-9_-]`. Nothing else from the
document reaches a record, and refusal findings still never echo
`config`.

Two abuse cases follow from opening the reserved `agent_hooks` segment
inside the SDK. A bug in `inline()` or a later change to `kind()`
could let host code register under `agent_hooks.*`. Three guards
prevent it: `kind()` keeps the head check for every caller, `inline()`
is the only entry, and a test in each SDK pins that
`kind("agent_hooks.inline")` and `kind("agent_hooks.other")` are
refused on plain and conformance registries. And a host registry
could collide with the names an SDK registers on the host's behalf;
the `agent_hooks-` prefix is reserved and refused when host code
registers it.

The builder's default surface is a disclosure risk, not an enforcement
one. For a host whose loop omits a point pair it over-claims. Records
and vectors are unaffected, but a claim could cite an inaccurate
document; §7.7.4 requires such a host to state its surface, and §13.3
forbids citing the default either way.

Sharing and sealing raise two concurrency points. One registry now
shares interceptor objects across every emitter it builds, and an
adapter that builds per run builds many. Rust already requires
`Send + Sync`, Python and TypeScript interceptors are single-threaded,
and .NET and Go hosts with stateful interceptors must be thread-safe,
which §12.2 already demands for parallel tool calls. §12.2 allows
concurrent emissions, so the seal at the first emission runs under a
lock in .NET and under the existing mutex in Go.

Vulnerabilities go to [SECURITY.md](../../SECURITY.md), not to this
proposal.

## Backward compatibility

Source compatibility holds in all five SDKs: every call that compiles
today compiles after this change with no new diagnostic. Rust `new`,
`register`, `register_at`, `register_with_options`,
`register_managed`, `set_composition`, `set_identity_provider`,
`set_timeout`, `set_approval_redactor` and `set_max_records`; the
Python, TypeScript and .NET constructors, `register` overloads and
setters; and Go `NewInterceptionEmitter`, `Register`, `RegisterNamed`,
`RegisterAt`, `RegisterWithOptions`, `RegisterManaged` and the
exported `Timeout` field all stay as they are. The loader's checks now
run inside these calls, so a refusal surfaces at the call with the
loader's class and pointer. Python `register` raises
`DeclarationError`, a `ValueError` subclass, so `except ValueError`
keeps catching. Rust `register` and `register_at` keep their
signatures, so a refusal there panics at the call, at setup time
rather than mid-run; `try_register_at` returns `Result` for a host
that wants the refusal as a value.

.NET binary compatibility holds. Nothing is removed or re-signed, the
two-argument `Register` overload stays, and `PublicApi.approved.txt`
grows by added lines only. The published agent framework .NET adapter,
built against 0.1.0-alpha.5, keeps running.

A host configured in code sees these one-time changes, all listed in
the changelog:

- every record gains `declaration`, and every unnamed interceptor's
  verdict summary gains `name: interceptor-<index>`; neither
  downstream test suite asserts their absence, but an external fixture
  that compares whole records will see the two members;
- the first emission seals the emitter, so registration or
  reconfiguration after it is refused where it was allowed; no host in
  this repository and neither downstream claim does this;
- a registration name must match `^[a-z][a-z0-9_-]{0,63}$` and be
  unique, or the call is refused;
- a 257th registration is refused;
- a custom identity provider name over 64 characters is refused;
- the register path's document states posture `continue`.

The register path keeps today's defaults: the Rust timeout stays
unbounded on both builds; `set_timeout` on a build without
`tokio-timeout` stays a no-op (the document writes `null`, which is
what runs); and `set_max_records(0)` keeps mapping to 1 as `deliver()`
already does. The builder takes the document rules: 5000 ms on a
bounded Rust build, `null` on an unbounded one with a numeric timeout
refused at the `timeout()` call, and `max_buffered_records(0)` refused
as `invalid_field`. `declaration()` stays optional, empty only on a
pending object, and Go's `Sealed()` stays. `HostSurface::sdk_default()`
and the builder's default surface stop carrying `host_declaration`; a
host that implements the seam states it, as the five reference
harnesses already do, and `from_capabilities` never added it.

Classification under [VERSIONING.md](../../VERSIONING.md), by axis:

- Wire, `agent-hooks/0.1`: unchanged. `declaration` stays OPTIONAL in
  the record schema and `verdicts[].name` is already optional, so no
  required or conditional field changes. Not a spec MAJOR.
- Declaration contract: no bump. Under §7.7.2 a minor adds a member or
  an enum value; a major removes or repurposes a member, narrows an
  enum, changes a default, the validation order, a refusal class's
  coverage, the binding envelope, the equivalence rule or the floor.
  Defining `agent_hooks.inline` does none of these. The kind grammar
  already admits it, the envelope is unchanged, `kind_unknown` and
  `binding_rejected` keep their coverage, and the rule of §7.7.7
  widens who it covers without changing what it says. A loader from an
  earlier release already refuses a document naming the kind with
  `kind_unknown`, because `HostRegistry::kind` refuses the
  `agent_hooks` head in all five SDKs; an older loader refuses rather
  than misreads, which is the property a minor bump exists to protect.
  1.1 stays current and 1.0 stays accepted.
- Package: additive public API in every SDK and no breaking API, so no
  SDK MAJOR. The one-time record change for register-path hosts is
  the behaviour change the changelog names.

Both downstream builds that treat warnings as errors build the next
release without a code change, because it adds no diagnostic to any
call they make. What remains for each when it takes the release:

- The policy decision runtime
  ([responsibleai/agent-control-spec](https://github.com/responsibleai/agent-control-spec))
  runs clippy with `-D warnings`. It should add the seam
  (`setup_declared`), with the reference harness as the template,
  which removes its `host_declaration` skips (22 against the corpus it
  filed); it passes the ungated record vector either way.
- The agent framework
  ([microsoft/agent-framework](https://github.com/microsoft/agent-framework))
  has two adapters. The .NET build treats warnings as errors and pins
  the package at 0.1.0-alpha.5, so nothing changes until the package
  bump. The Python adapter's mapping factory builds
  `InterceptionEmitter(**kwargs)`, registers each interceptor by name
  and sets the record sink on every run, and the package's dependency
  specifier admits the next release. That factory passes mapping keys as
  names with no grammar check. A key outside the id grammar, or a
  duplicate, is refused where it was accepted, with the pointer
  `/bindings/<index>/id` naming the position, and tests that use
  conforming names will not catch it. The adapter should validate names
  at factory time. Its declaration factory binds code instances under a
  host-private kind, `agent_framework.interceptor`, which
  `agent_hooks.inline` replaces. Both adapters implement `terminate`, so
  with the bump they should state the posture on the builder
  (`tool_seam_host_error(terminate)` or `surface(...)`) or load a
  declaration that states it. Until then the document the SDK writes for
  them says `continue` and is not citable; their records are unaffected.

## Performance and operational impact (optional)

The construction numbers below come from a release build of the Rust
core and from the Python package at 0.1.0b2. They are the author's
measurements on one machine; the construction row this proposal adds to
the bench makes them reproducible. Rust: `from_declaration_value` with
three bindings takes 16 to 37 µs per load, `canonical_json` of the
resolved form 32 to 118 µs, and `new` plus three `register` calls under
120 ns. Python: `InterceptionEmitter.from_declaration_value` with three
bindings takes 144 µs per call (`HostDeclaration.from_value` 11 µs,
`registry.resolve` 62 µs through the core, the rest in `_from_resolved`
and the resolvers) against 2.8 µs for `InterceptionEmitter()` plus three
`register` calls. That is fifty times slower and under a millisecond. An
adapter that builds a fresh emitter per run pays that on every run.
Building the document once at factory time does not remove the per-run
resolve; only a core-level cache of the resolved form per document text
would, and that cache is not part of this proposal. The changelog and
`docs/PRODUCTION.md` record both numbers.

After the seal, dispatch, composition and record writing are
untouched; the first emission on the register path pays one load.

Operator visibility improves. The load log of §7.7.8 now covers
code-written documents too, through `digest()` and `document()`, so an
operator can match a running host to a pushed document whichever way
the host was built. The conformance report groups declaration-seam
skips under their own heading.

## SDK surface and implementation impact

Rust core: `EmitterBuilder` over `DeclarationBuilder` plus an owned
`HostRegistry`; `HostRegistry::inline(id, instance)` and the inline
resolver; `HostDeclaration::digest()`; `try_register_at`; the pending
state behind `new` and the setters, with the loader's checks at each
call and `seal()`; `HostSurface::sdk_default()` without
`host_declaration`. The FFI gains no function. The Python, TypeScript,
.NET and Go SDKs serialize the document and call
`ah_declaration_resolve` as today.

Per language, the builder is Rust `EmitterBuilder`, Python and
TypeScript `InterceptionEmitter.builder()`, .NET
`InterceptionEmitterBuilder` and Go `NewEmitterBuilder`. Its shape is
informative: one setter per document member (`mode`, `composition`,
`identity_provider`, `approval_resolver`, `approval_redactor`,
`timeout`, `approval_resolver_timeout`, `max_buffered_records`,
`tool_seam_host_error`, `surface`, `with_registry`, `host`, `id`,
`extension`), `bind`, `bind_named`, `bind_at` and `bind_kind` for
bindings, and `document()` and `build()`. Per-SDK names follow each
language's casing. Python `register` raises `DeclarationError`; Go
`RegisterAt` already returns `error`, and `build()` returns a refusal
as an error; .NET seals under a lock with a double-checked flag, since
§12.2 allows concurrent emissions; Go seals under its existing mutex
with a flag, never `sync.Once`, so the host can fix and retry a
refused seal.

CTK: the registry in all five runners registers inline instances
`interceptor-<index>` for each script index next to
`ctk.scripted`, which also proves that `for_conformance` and `inline`
coexist. The runner's posture write creates the `configuration` and
`posture` objects when absent, writes only when
`configuration.posture.tool_seam_host_error` is absent, and leaves a
document alone when `configuration` is not an object, since such a
document is refused before step 8. The five reference harnesses switch
`ctk.instance` to `agent_hooks.inline` with the same ids; ids and
records stay identical, the kind string in their documents changes,
and the self-test corpus is unchanged. The `should_skip` detail for
`host_declaration` becomes "declaration seam not implemented" in
`ctk_engine.rs`, in one place rather than five runners.

Documentation: `conformance/HARNESS.md`, `conformance/RUNNER.md`,
`conformance/CLAIMS.md`, `docs/IMPLEMENTING.md`, the README and the
SDK READMEs change to describe one path, the seam meaning, the posture
write and the citing rule.

Tests: constructor call sites in tests stay as they are. The tests that
pin the absence of `declaration` on the register path now assert its
presence. Each SDK gains builder, equivalence, refusal and parity
tests. The parity test builds one configuration through the builder
and through the register path and asserts equal canonical documents
and byte-identical records, with the two differences Backward
compatibility lists pinned as such; it is the check against the drift
risk of keeping two entries.

Sequencing, if the proposal is accepted: the specification, the Rust
core and the CTK core first, because the four wrapper SDKs and the CTK
runners build on them; then the wrappers; then docs, the golden file
and the vectors.

## Conformance and tests

Three new vectors take the next three free numbers (`AH-CTK-160` to
`AH-CTK-162` today). One golden file,
`conformance/golden/declaration-inline.json`, pins five canonical
resolved documents written by the builder: nothing bound; one unnamed
bind; a named bind with `at` and `timeout_ms`; a stated surface with
`terminate`; an inline bind plus a registered kind. Rust generates the
file once and every SDK replays it before merge, with timeouts written
out so the Rust unbounded build has its own expected string. The
golden file, not a vector, owns the builder's equivalence to a
document naming `agent_hooks.inline`, because the instances live in
the registry. The ungated vector asserts nothing on `verdicts[].name`:
the member is OPTIONAL under `sequential/first_deny`, and the id
scheme is a builder convention the golden file pins.

`AH-CTK-121` gains `expect.load_by_posture`. The other twenty-four
vectors a `terminate` host fails today (120, 122 to 126, 136 to 138,
140, 142, 144 to 155 and 159: accepted documents that state no
posture, and three refusals expected after step 8) need no file
change; the posture write fixes them.

The two downstream claims in `conformance/CLAIMS.md` stand as filed;
they are true for the SDK versions they cite. Each downstream re-runs
its claim when it takes the release: the policy-runtime claim against
the new corpus, with `setup_declared` if it adds the seam; the agent
framework claim with `host_declaration` declared once its harness drives
a declaration path. The claim rule for `host_declaration` is SHOULD now
and MUST from 0.1.0. A third-party harness that returns an SDK-written
document from `declaration()` enters the declaration parts only when
that document states `host_declaration`. Under the one meaning, that is
exactly when it implemented the seam. The reference harnesses state it
already.

| Case | Expected result |
| --- | --- |
| Vector, part `declaration/bindings`: the document binds `{"id": "interceptor-0", "kind": "agent_hooks.inline"}` and the CTK registry holds an instance under that id | Accepted load; `verdicts[0].name` is `interceptor-0`; the scripted outcome |
| Vector, part `declaration/refusal`: the same binding with `config: {"slot": 0}` | Refused load, class `binding_rejected`; no record |
| Vector, part `record/declaration`, capabilities `[]`: a floor-only scenario with one allow interceptor | `expect.records` asserts `declaration` equals the current contract version (`agent-hooks-declaration/1.1` at this revision) and asserts nothing on `verdicts[].name` |
| A document names `agent_hooks.inline` on a registry with no inline instance | `kind_unknown` at step 10 |
| Inline instances registered, none under the binding's `id` | `binding_rejected` at step 11, with a finding naming the id |
| `kind("agent_hooks.inline")` or `kind("agent_hooks.other")`, on a plain or a conformance registry | Refused |
| A registered name starting with `agent_hooks-` from host code | Refused by the registry |
| The five builder documents of the golden file, in each SDK | Canonical JSON equal to the golden string |
| One configuration through the builder and through the register path | Equal canonical documents and byte-identical records, except the two pinned differences |
| `register` or a setter after the first emission or after `seal()` | Refused as sealed |
| A name outside the id grammar, a duplicate name, a 257th registration, a provider name over 64 characters, a timeout out of range | Refused at the call with the loader's class and pointer |
| `seal()` on a pending emitter | The object is sealed, or a refusal is returned; nothing is recorded either way |
| `AH-CTK-121` under a `terminate` harness | Refused `surface_unsupported`; accepted under `continue` |
| A posture-silent vector document under a `terminate` harness | The runner writes `terminate`; the document loads |
