# P-007: Declaration-only construction

**Status:** Draft.
**Raised by:** Mohammad Abuomar, from the design study for item 2 of
issue #138.

## Why a proposal

[README.md](README.md) requires a proposal for a change to the record
shape (§10) and for a change to what a conformance claim asserts
(§13.3). This change does both. Every record from a host configured in
code gains `declaration` and `verdicts[].name`, and §13.3 learns which
documents a claim may cite. Issue #138 sets the direction; this
proposal is its written form.

## The gap

Today every SDK has two ways to build an emitter, and they do not
build the same thing.

The code path. Rust `InterceptionEmitter::new` plus `register` or
`register_at`; Python `InterceptionEmitter()` plus `register`;
TypeScript `new InterceptionEmitter()` plus `register`; .NET
`new InterceptionEmitter()` plus `Register`; Go `NewInterceptionEmitter`
plus `Register`, `RegisterNamed` or `RegisterAt`. This path builds no
`HostDeclaration`, is never sealed, has no `HostSurface` and no
registry, gives bindings no id (an unnamed registration leaves
`verdicts[].name` absent), has no per-binding timeout, and its records
omit `declaration`. It checks nothing a file is checked for: no id
grammar, no uniqueness, no 256-binding bound, no 64-character cap on
provider names, no timeout range.

The declaration path. `from_declaration`, `from_declaration_path`,
`from_declaration_json`, `from_declaration_value`, and the
`DeclarationBuilder`, whose value is serialized and parsed again. It
runs steps 2 to 12 of §7.7.6, names every binding by id, fixes `at`
and `timeout_ms` per binding, seals the emitter and stamps
`declaration` on every record.

The two paths differ in record bytes (`declaration`, `verdicts[].name`)
and in defaults. A declaration defaults `timeouts.interceptor_ms` to
5000 ms. The Rust code path has no timeout at all (`None`, unbounded);
the Python, TypeScript, .NET and Go code paths default to 5000 ms. A
Rust build without `tokio-timeout` refuses any numeric timeout at step
8 on the declaration path and silently ignores `set_timeout` on the
code path.

The spec says in four places that configuration in code carries no
declaration and is not sealed (§7.7.1, §7.7.7, §7.7.8 and the §10.3
record table). The README, `docs/IMPLEMENTING.md` and five SDK READMEs
repeat it, and tests in all five SDKs pin it. Issue #138 item 2 decided
the opposite: the declaration is the only construction path, and the
code API stays as a convenience that builds a declaration internally.
The issue also asked for raw registration to go in the next line; this
proposal keeps it as a second entry to the same pipeline (Options
considered).

Two facts about the tree shape the design. The `HostRegistry` in all
five SDKs refuses a kind whose first segment is `agent_hooks` or `ctk`
and opens `ctk` only through `for_conformance`, so a kind this
specification owns is refusable everywhere today. And all five
reference harnesses already wrap code-supplied interceptors in a
declaration: they route the 51 field-based vectors through the loader
under a `ctk.instance` kind with ids `interceptor-<i>`. The in-tree
precedent exists; it is just not the spec.

Downstream, the two filed claims sit one on each path. The
agent-control-spec row (ACS) is code-path with 22 `host_declaration`
skips. The agent-framework row (MAF) does not declare
`host_declaration`, and its middleware builds a code-path emitter on
every run.

## Goals and non-goals

Goals:

- One construction pipeline. Every emitter passes steps 2 to 12 of
  §7.7.6, whatever the host wrote: a file, JSON text, a value, or code.
- One record shape. Every record carries `declaration`; every verdict
  summary carries the binding id.
- One set of bounds and refusal classes, with the same pointers, for
  every host.
- The builder is the code API. It writes a declaration and a registry;
  the document it writes is the host's configuration written down, and
  a file can name the same kind. The existing constructors, setters
  and `register` calls stay supported and feed the same pipeline.
- Source compatibility and .NET binary compatibility: every beta.2
  call compiles on beta.3 with no diagnostic, and runs unchanged unless
  it hits a refusal listed under Compatibility.
- No declaration contract bump and no wire bump.

Non-goals:

- Changing the record schema. `declaration` stays OPTIONAL in
  `agent-hooks/0.1`; making it REQUIRED is a wire MAJOR and is not
  done.
- Changing the declaration contract. It stays
  `agent-hooks-declaration/1.0`.
- Changing dispatch, composition, verdicts or the record envelope
  beyond the two members above.
- Removing the `host_declaration` capability. Narrowing the enum is a
  declaration MAJOR (§7.7.2).
- A surface or posture setter on the existing API. The builder is
  where a host states what that API cannot (§7.7.4).
- A new FFI function. The wrapper SDKs serialize the document and call
  `ah_declaration_resolve` as they do today.
- The interceptor response envelope (P-006). It touches no record
  member this proposal touches.

## Options considered

Three designs were considered. Each is weighed on purity (one
construction model), host compatibility, SDK consistency and the work
it takes.

### A. The code API as sugar, sealed at the first emission

Every public constructor, setter and `register` stays and nothing is
deprecated. Under the hood each call writes one member, or one binding
of an SDK-private kind `agent_hooks.inline` with config `{"slot": n}`,
into a document. The emitter seals at `seal()` or at the first
emission, whichever comes first, by handing that document to
`from_declaration_value` with an SDK-internal registry.

For: the best host compatibility (no diagnostics, so the downstream
builds that treat warnings as errors keep building), eager checks at
the `register` call, and the least work.

Against: the written document is one no host registry can load (the
kind is SDK-private, so a file naming it gets `kind_unknown`); an
emitter has a permanent open state (`declaration()` is empty until the
first emission, and the refusal rule weakens from "before any emitter
exists" to "before any emission"); the Rust code path writes
`interceptor_ms: null` where the other four write 5000, so the same
calls give different canonical documents; and it drops the deprecation
and removal that issue #138 states.

### B. Builder-first: one constructor, the old API rebuilds on every call

Exactly one constructor, `from_declaration`. The registry gains an
instance table, `HostRegistry::instance(id, interceptor)`, under a
spec-owned kind `agent_hooks.instance` that is always present and takes
an empty config. A new `EmitterBuilder` is the primary code API. The
old API becomes a thin deprecated wrapper that rebuilds the emitter
through the loader on every mutation, so `declaration()` is always
present and a refusal lands at the offending call with the file's class
and pointer. Removed in 0.2.

For: the cleanest model; a file may bind a code instance by id, which
replaces the branch-local kind the MAF declaration branch invented; no
SDK duplicates loader checks.

Against: every public constructor and setter in five SDKs gets a
deprecation marker (ACS runs clippy with `-D warnings`; MAF .NET builds
with `TreatWarningsAsErrors`); Rust `set_timeout` on an unbounded build
turns from a no-op into a refusal; TypeScript error types change; Go's
exported `Timeout` field is deprecated; each MAF run pays N+1 loader
rounds; the claim rule it adds stales both filed rows at the tag; and
it is the most work.

### C. One spec kind and a pending emitter (recommended, amended below)

Every emitter exists only after a document has passed the loader. The
host supplies the document from a file, from JSON text, from a value,
or through the new emitter builder (Rust `EmitterBuilder`, Python and
TypeScript `InterceptionEmitter.builder()`, .NET
`InterceptionEmitterBuilder`, Go `NewEmitterBuilder`), a thin wrapper
over the existing `DeclarationBuilder` plus a `HostRegistry` it owns.
Each setter writes one member. Each `bind` registers the instance under
the one kind this specification defines, `agent_hooks.inline`, by
binding id and writes one envelope. `build()` hands the document to the
value path. `kind()` keeps refusing the `agent_hooks` head for every
caller; `inline(id, instance)` is the only entry, and a file may name
the kind. In its full form the old API stays for one release as a
deprecated pending emitter, collecting calls into a builder and sealing
at the first emission or at `seal()`, behind a Rust cargo feature
`legacy-registration` (default on) and deprecation diagnostics in the
other four SDKs, with removal in 0.2. The reference harnesses move from
`ctk.instance` to the spec kind; two vectors and a golden file pin the
kind in all five SDKs.

For: it honours both sentences of issue #138; compatibility is at most
a deprecation warning, source compatible everywhere and .NET binary
compatible; the deprecated path keeps its beta.2 defaults; the builder
writes document defaults explicitly, so the same calls give identical
canonical documents in all five SDKs on bounded builds; Go collapses to
one error channel.

Against: in its full form the lazy seal moves a refusal to the first
emission (a Rust panic mid-run unless `seal()` is called); the
strict-warning downstreams must migrate when they take the release; a
resolver installed on the first `inline()` call makes `names().kinds`
depend on registry state.

The recommendation is C without the deprecation half: A's host
compatibility with C's spec-owned kind, eager checks and explicit
`seal()`. Both forms of C reach one pipeline and one record shape,
because the existing API writes and loads the same document the
builder does. Removing a public API is a separate decision with its
own cost, and nothing in the goals needs it. Keeping the API spares
the two strict-warning downstream builds a migration. This departs
from the second sentence of issue #138. The proposal folds in these
grafts from A and B:

- From A: run the loader's checks at the call that writes a member on
  the register path (the `id` grammar and length, uniqueness against
  earlier and synthesized ids, a non-empty `at` inside the surface,
  the 256-binding bound, the timeout range, the record-bound range,
  the 64-character cap on registered names) and raise the loader's
  class and pointer there; Rust adds `try_register_at` returning
  `Result`. `seal()` stays as the explicit channel. This removes the
  mid-run panic.
- From A: one ungated record vector that asserts the `declaration`
  stamp on a floor-only scenario, so every harness is checked for it.
- From A: tell hosts with a non-default posture or unbuffered output to
  state their surface on the builder, and name the two MAF adapters,
  which implement `terminate`.
- From A: keep the two claim rows as filed and do not make
  `host_declaration` a MUST for claims in beta.3; raise it at 0.1.0
  final once the ACS and MAF re-runs exist.
- From A: Go seals under its existing mutex with a sealed flag, never
  `sync.Once`, so a refused seal can be fixed and retried; .NET seals
  under a lock with a double-checked flag, since §12.2 allows
  concurrent emissions.
- From B: reserve the registered-name prefix `agent_hooks-` for names
  an SDK registers on the host's behalf
  (`agent_hooks-approval-resolver`, `agent_hooks-approval-redactor`)
  and refuse the prefix from host code, so a host registry cannot
  collide with them at build.
- From B: `HostDeclaration::digest()` (`jcs-sha256` hex over the
  document) and `builder.document()` in all five SDKs, so the §7.7.8
  load log can name version, id and digest for a code-written
  document.
- From B: ACS should add `setup_declared` when it takes the release,
  which removes its 22 `host_declaration` skips.
- From B: a per-SDK test that `kind("agent_hooks.inline")` and
  `kind("agent_hooks.other")` are refused on both plain and conformance
  registries, so `inline()` stays the only entry under the reserved
  segment.
- From B: change the skip detail string in one place
  (`ctk_engine.rs` `should_skip`), not in five runners.

Two grafts are not taken. The register path gets no surface or posture
setter. The builder is the code API and the place a host states what
the register path cannot; setters on both would give five SDKs two
surfaces to keep equal. Both `terminate` hosts should state their
posture on the builder when they take the release. A claim MUST for
`host_declaration` in beta.3 is deferred, as above.

The builder's shape is informative. It has one setter per document
member (`mode`, `composition`, `identity_provider`, `approval_resolver`,
`approval_redactor`, `timeout`, `approval_resolver_timeout`,
`max_buffered_records`, `tool_seam_host_error`, `surface`,
`with_registry`, `host`, `id`, `extension`), `bind`, `bind_named`,
`bind_at` and `bind_kind` for bindings, `document()` and `build()`.
Per-SDK names follow each language's casing and are not normative.

## Normative changes

The edits below are the whole change to `spec/AGENT-HOOKS-0.1.md`. No
member, enum, default, validation order, refusal class coverage or
binding envelope changes, so the contract stays
`agent-hooks-declaration/1.0` (the §7.7.2 reasoning is under Version).
Quoted text is the new text.

### §7.7.1 Purpose and scope

Replace the opening MAY sentence with:

> Every emitter is built from one JSON document, the **host
> declaration**, through the loader of §7.7.6. A host loads the
> document from a file, from JSON text or from a value, or the SDK
> writes it from the configuration and interceptors the host gives in
> code through the emitter builder (§7.7.7).

Extend the widening rule. The document MUST NOT widen the surface
beyond what the host's code reports, "or, for a document the SDK writes
from code, beyond the points the emitter admits (§7.7.4)".

Delete the closing paragraph (configuration in code remains conformant;
such records carry no `declaration`). Replace it with:

> There is no emitter without a declaration. Configuration in code is
> a way of writing a declaration, not a way around it, and such a
> host's records carry `declaration` like every other host's (§7.7.8).

Add, after that paragraph:

> One document per emitter says nothing about where bindings come
> from. `bindings` is an ordered list and may carry bindings from any
> number of sources, written in code or in a file: an audit set and a
> policy set sit side by side, and the composition profile combines
> their verdicts. Assembling one document from several files is a host
> or channel step; this version defines no includes or overlays
> (§7.7.4).
> An emitter a host configures by `register` and setters before its
> first emission is written down the same way (§7.7.7).

### §7.7.3 Members and defaults

The table keeps the `surface` row as it is (default: the host's own
surface). Where the surface of an SDK-written document comes from is
stated once, in §7.7.4. The `posture.tool_seam_host_error` row keeps
"MUST equal the posture the code implements" and gains the pointer
"(§7.7.4; a host on the register path of §7.7.7 cannot state it, and
that section says what follows)".

After "Registered names match `^[a-z][a-z0-9_-]{0,63}$`." add:

> Names beginning with `agent_hooks-` are reserved for references an
> SDK registers on the host's behalf (`agent_hooks-approval-resolver`,
> `agent_hooks-approval-redactor`); a registry MUST refuse them from
> host code. They never reach a record (§7.7.8).

After the Bounds paragraph add:

> A document the SDK writes from code is subject to every bound. A
> host that binds more than 256 interceptors is refused like a file
> that lists them, and a name a host gives a binding must match the
> `id` grammar of §7.7.5.

### §7.7.4 Surface

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
> its first binding: the builder checks each binding's `at` against
> the surface at the call, so the surface comes first. A host on the
> register path (§7.7.7) cannot state either and SHOULD move to the
> builder when its loop, posture or output differs from what the
> default states. The builder never writes `host_declaration` on the
> host's behalf (§7.7.9); a host states it. A document carrying the
> builder's default surface MUST NOT be cited by a claim (§13.3).

The capability-list sentence is unchanged. `host_declaration` stays in
the vocabulary, with the one meaning §7.7.9 gives it.

### §7.7.5 Bindings

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
> later revisions; `ctk` stays the conformance kit's.

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

### §7.7.6 Loading and refusal

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
> MUST return a refusal rather than record anything. The first
> emission seals the object.

### §7.7.7 Equivalence and sealing

Replace the section with:

> Every emitter is a function of its resolved declaration and the
> host's registry. Three document paths yield the same emitter:
>
> - from a file path: step 1, then the JSON text path;
> - from JSON text: steps 2 to 11;
> - from a value built in code, through a builder with one setter per
>   member and one call per binding: the value is serialized and handed
>   to the JSON text path, so the code path is validated by the same
>   function, with the same classes, as a file.
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
> timeouts, approval redactor, record bound). Otherwise the declaration
> would not be what ran. Changing where records go (the record sink,
> draining the buffer) stays allowed; it changes delivery, not
> content.
>
> Registration and reconfiguration on an emitter object before its
> first emission, the constructor and setters of earlier revisions, is
> the register path. It is a second entry to the same pipeline, not a
> way around it, and it stays supported. Such an object is a pending
> emitter. It has produced no record. The SDK collects the calls made
> on it into a builder, writes and loads the document at the first
> emission or at an explicit `seal()`, and from then on the object is
> sealed and its records are those of the equivalent builder-built
> emitter. The register path writes the builder's default surface and
> posture `continue`; it has no way to state another. For a host whose
> loop implements `terminate`, that document misstates the host. Its
> records are unaffected, because records carry no posture and the
> conformance kit takes posture from the harness (§13.1), but the
> document is unfit to cite (§13.3), and such a host SHOULD state its
> surface, or its posture, on the builder. The register path keeps the
> defaults of the revision before this one, an unbounded timeout where
> the code API had none, so behaviour under a host does not change;
> the builder takes the document defaults of §7.7.3.

### §7.7.8 Records

Replace the first paragraph with:

> Every record carries `declaration`: the contract version of the
> document the emitter was loaded from, for example
> `agent-hooks-declaration/1.0`, the SDK-written document included.
> The member stays OPTIONAL in the `agent-hooks/0.1` record schema
> (§10.3) so that records written before this revision stay valid; a
> host of this revision writes it on every record and MUST NOT default
> it: the value is read from the loaded document. It is one string
> from a closed grammar, so it is payload-free by construction.
> Nothing else from the document reaches the record: not the `id`, a
> digest, the path, kinds, configs, the host name or resolver names.

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

### §7.7.9 Conformance

Replace the first paragraph with:

> The CTK capability `host_declaration` declares that the host's
> harness implements the declaration seam: it builds its emitter from
> the document the CTK supplies, together with the CTK's registry, and
> surfaces refusal as a load outcome, never as a run. It no longer
> says that the host builds its emitter from a declaration; every
> emitter of this revision does. In a document's `surface.capabilities`
> (§7.7.4) the member has this one meaning, and the SDK never writes it
> on the host's behalf. The `declaration/*` vector parts
> (`conformance/vectors/AH-CTK-120` onwards) stay gated on it; a
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
> posture-`continue`: the runner writes the harness's declared posture
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

### §10.3 The interception record

The `jsonc` comment on `declaration` becomes "the contract version the
emitter was loaded from (§7.7.8); every host of this revision writes
it". Table rows:

- `declaration`: "OPTIONAL in the schema, for records written before
  0.1.0-beta.3; a host of this revision writes it on every record. The
  host declaration contract version the emitter was loaded from
  (§7.7.8), e.g. `agent-hooks-declaration/1.0`. Never defaulted."
- `verdicts`: "`name` is the binding `id` (§7.7.5): the id the host
  gave, or `interceptor-<index>` for an inline binding the host did not
  name. It MUST be payload-free."
- `decided_by`: "Registration index" becomes "Dispatch index: the
  position in the list of interceptors bound at the emitted point
  (§7.7.5)". The rest of the row is unchanged.

The same description change goes to
`spec/schema/interception-record.schema.json`. The shape is unchanged.

### §13.3 Claims

Replace the sentence on citing a document with:

> A claim that cites a host declaration document (§7.7) MUST cite the
> document whose resolved surface the CTK run used, and that document
> MUST carry an explicit `surface`. A host built in code MAY cite the
> document the SDK wrote, exported from the host at the claimed
> commit, only when the host stated its surface to the builder
> (§7.7.4); a document carrying the builder's default surface describes
> the emitter, not the host, and MUST NOT be cited. A claim filed
> against 0.1.0-beta.3 SHOULD declare `host_declaration` so the
> `declaration/*` parts appear in the report; from 0.1.0 final it MUST.
> The §13.3 tuple is unchanged.

§13.1 gains one sentence after the MAY on presenting the surface: "A
host built in code states its surface to the emitter builder (§7.7.4)."

### Adjacent edits

Editorial, same meaning, one vocabulary:

- §7 and §7.4: "zero registered interceptors" becomes "zero
  interceptors bound at the emitted point (§7.7.5)"; "registration
  order" becomes "binding order (array order, §7.7.5)". The §11
  `host_error:no_interceptor` row follows.
- §9: "a registered approval resolver" and "A host with no registered
  resolver" become "configured", meaning named in the resolved
  declaration (§7.7.3); a registered resolver the document does not
  name is never consulted.
- §10.1: the provider-name grammar gains the 64-character cap the only
  construction path now applies: `^[a-z][a-z0-9_-]{0,63}$`.
- §14: one sentence. A document the SDK writes from code is the host's
  own configuration at host trust, produced by code the host loaded,
  and the load log applies to it as to a file.
- `spec/schema/host-declaration-1.0.schema.json`: description text
  only. `interception_points` reads "Points the host emits, or, for a
  document the SDK writes from code, the points the emitter admits
  (§7.7.4)"; the `kind` description names the one defined kind. No
  structural change.
- `conformance/vectors.schema.json`: the `host_declaration` capability
  description says the seam; `expect.load_by_posture` is added next to
  `run_outcome_by_posture`; the `host_declaration` member description
  names the inline instances the CTK registry now holds.
- `spec/declaration-errors.json`: unchanged; no new class.
  `kind_unknown` still means a kind with no resolver, and
  `binding_rejected` still means a resolver refused.
- `spec/DECLARATION-VERSIONS.md`: the file requires a row only for a
  tag that changes the accepted set or the current version, and beta.3
  changes neither. The 1.0 contract row gains a Notes entry:
  "0.1.0-beta.3 defines `agent_hooks.inline` under 1.0; older loaders
  refuse a document naming it with `kind_unknown`."
- `VERSIONING.md`: a note that `declaration` stays OPTIONAL in
  `agent-hooks/0.1`.

### Conformance kit

- Three new vectors take the next free numbers, `AH-CTK-144`,
  `AH-CTK-145` and `AH-CTK-146`.
  `AH-CTK-144` (part `declaration/bindings`): the document binds
  `{"id": "interceptor-0", "kind": "agent_hooks.inline"}`; expects an
  accepted load, `interceptor-0` on `verdicts[0].name` and the scripted
  outcome. `AH-CTK-145` (part `declaration/refusal`): the same kind
  with `config: {"slot": 0}`; expects a refused load, class
  `binding_rejected`, no record. `AH-CTK-146` (part
  `record/declaration`, capabilities `[]`): a floor-only scenario with
  one allow interceptor; `expect.records` asserts
  `declaration == "agent-hooks-declaration/1.0"` and nothing about
  `verdicts[].name`, because `verdicts` is OPTIONAL under
  `sequential/first_deny` and the id scheme is a builder convention the
  golden file pins.
- The CTK registry in all five runners registers inline instances
  `interceptor-<i>` for script `i` next to `ctk.scripted`, which also
  proves that `for_conformance` and `inline` coexist.
- The runner's posture write creates the `configuration` and `posture`
  objects when absent, writes only when
  `configuration.posture.tool_seam_host_error` is absent, and leaves a
  document alone when `configuration` is not an object (such a
  document is refused before step 8 anyway).
- `AH-CTK-121` gains `expect.load_by_posture`: `continue` accepted,
  `terminate` refused with `surface_unsupported`. The other eleven
  vectors a `terminate` host fails today (120, 122 to 126, 136 to 138,
  140 and 142) need no file change; the posture write fixes them.
- The five reference harnesses switch `ctk.instance` to
  `agent_hooks.inline` with the same ids. Ids and records stay
  identical, the kind string in their documents changes, and the
  self-test corpus is unchanged.
- A new golden file, `conformance/golden/declaration-inline.json`, pins
  five canonical resolved documents written by the builder (nothing
  bound; one unnamed bind; a named bind with `at` and `timeout_ms`; a
  stated surface with `terminate`; an inline bind plus a registered
  kind), replayed by every SDK, with timeouts written out so the Rust
  unbounded build has its own expected string.
- The `should_skip` detail for `host_declaration` becomes "declaration
  seam not implemented" in `ctk_engine.rs`; the report groups seam
  skips under their own heading.
- `conformance/HARNESS.md`, `RUNNER.md`, `CLAIMS.md` and
  `docs/IMPLEMENTING.md` are rewritten for one path, the seam meaning,
  the posture write and the citing rule.

## Compatibility

Source compatibility holds in all five SDKs: every beta.2 call compiles
on beta.3 with no diagnostic. Rust `new`, `register`, `register_at`,
`set_composition`, `set_identity_provider`, `set_timeout`,
`set_approval_redactor` and `set_max_records`; the Python, TypeScript
and .NET constructors, `register` overloads and setters; and Go
`NewInterceptionEmitter`, `Register`, `RegisterNamed`, `RegisterAt` and
the exported `Timeout` field all stay as they are. The loader's checks
now run inside these calls, so a refusal surfaces at the call with the
loader's class and pointer. Python `register` raises
`DeclarationError`, a `ValueError` subclass, so `except ValueError`
keeps catching. Rust `register` and `register_at` keep their
signatures, so a refusal there panics at the call, at setup time rather
than mid-run; `try_register_at` returns `Result` for a host that wants
the refusal as a value.

.NET binary compatibility holds. Nothing is removed or re-signed, the
two-argument `Register` overload stays, and `PublicApi.approved.txt`
grows by added lines only. The published MAF .NET package built against
alpha.5 keeps running on beta.3.

Behaviour changes a beta.2 host sees, all one-time and listed in the
CHANGELOG: every record gains `declaration`, and every unnamed
interceptor's verdict summary gains `name: interceptor-<i>`; the first
emission seals the emitter, so registration or reconfiguration after it
is refused where beta.2 allowed it (no in-tree host, ACS or MAF does
this); a registration name must match `^[a-z][a-z0-9_-]{0,63}$` and be
unique or the call is refused; more than 256 registrations is refused;
a custom identity provider name over 64 characters is refused; the
register path's document states posture `continue`. Defaults do not
change under a host. The register path keeps beta.2's: the Rust
timeout stays unbounded on both builds, `set_timeout` on a build
without `tokio-timeout` stays a no-op and the document writes `null`,
which is what runs, and `set_max_records(0)` keeps mapping to 1 as
`deliver()` already does. The builder takes the document rules: 5000 ms
on a bounded Rust build, `null` on an unbounded one with a numeric
timeout refused at the `timeout()` call, `max_buffered_records(0)`
refused as `invalid_field`. `declaration()` stays optional (empty only
on a pending object) and Go's `Sealed()` stays.
`HostSurface::sdk_default()` and the builder's default surface stop
carrying `host_declaration`; a host that implements the seam states
it, as the five reference harnesses already do, and
`from_capabilities` never added it.

Wire and contract: `agent-hooks/0.1` unchanged, `declaration` OPTIONAL
in the record schema, `verdicts[].name` already optional;
`agent-hooks-declaration/1.0` unchanged.

The construction cost is measured. On a release build of the Rust
core, `from_declaration_value` with three bindings takes 16 to 37 µs
per load, `canonical_json` of the resolved form 32 to 118 µs, and `new`
plus three `register` calls under 120 ns. Python on 0.1.0b2:
`InterceptionEmitter.from_declaration_value` with three bindings 144 µs
per call (`HostDeclaration.from_value` 11 µs, `registry.resolve` 62 µs
through the core, the rest in `_from_resolved` and the resolvers)
against 2.8 µs for `InterceptionEmitter()` plus three `register` calls:
fifty times slower and under a millisecond. MAF builds a fresh emitter
per run, so hoisting the document to factory time does not remove the
per-run resolve; only a core-level cache of the resolved form per
document text would. The CHANGELOG and `docs/PRODUCTION.md` record
both numbers; a construction bench row keeps them current.

Downstream, neither strict-warning build needs a code change to build
on beta.3, because beta.3 adds no diagnostic to any call they make.
What remains for each when it takes the release:

agent-control-spec (ACS). Its CI runs clippy with `-D warnings`, so a
new warning would fail it. Its Cargo requirement `0.1.0-beta.2`
resolves to beta.3 under Cargo's pre-release rule once beta.3 is
published, and Dependabot groups every cargo update into one weekly
PR. Beta.3 adds no warning, so the first grouped update builds and the
11 call sites in its tests stay as they are. ACS then re-vendors the
beta.3 corpus (it pins 73 vectors, a provenance digest and
`EXPECTED_PASSED`, which change together) and should add
`setup_declared`, with the reference harness as the template, which
removes its 22 `host_declaration` skips. ACS passes `AH-CTK-146` on
beta.3 with or without `setup_declared`.

agent-framework (MAF), .NET. The build treats warnings as errors and
pins `ResponsibleAI.AgentHooks` at `0.1.0-alpha.5`, so nothing changes
until the package bump. The bump to beta.3 adds no warning, so the
adapter and its tests build as they are. The adapter implements
`terminate`, so with the bump it should state the posture on the
builder, or adopt the declaration-loading branch's
`AgentHooksOptions.FromDeclaration`, whose surface object already
states all eight points and `terminate` and is a valid `surface()`
argument. Until it does, the document the SDK writes for it says
`continue` and is not citable (§13.3); its records are unaffected.

agent-framework (MAF), Python. The middleware builds
`InterceptionEmitter(**kwargs)`, `register(interceptor, name)` and
`set_record_sink` per run. Under beta.3 these keep working, the first
emission seals, and records gain the two members; no MAF test pins
their absence. MAF passes mapping keys as names with no grammar check,
so a key outside the id grammar, or a duplicate, is refused where
beta.2 accepted it, and MAF's tests use only the name `allow`, so MAF
CI will not catch it. That is a MAF-side breaking change: MAF validates
names at factory time, documents the grammar, and gives its own notice.
Both MAF adapters implement `terminate`, so with the bump they should
state the posture on the builder (`tool_seam_host_error(terminate)` or
`surface(...)`) or adopt the declaration-loading branches; the bump
needs neither. MAF's lock pins 0.1.0a5 and its specifier admits beta.3,
so MAF sees the change on a lock refresh.

## Rollout

The change ships in 0.1.0-beta.3. The spec, the Rust core and the CTK
core land first, because the four wrapper SDKs and the CTK runners
build on them; the wrappers follow, then docs, the golden file and the
vectors. Constructor call sites in tests stay as they are; the tests
that pin the absence of `declaration` on the code path flip, and each
SDK gains builder, equivalence, refusal and parity tests.

Downstream, ACS and MAF take the release as described under
Compatibility; neither needs a code change to build. The two claim
rows stay as filed, because they are true for the SDK versions they
cite, and are re-run when each downstream takes the release: ACS
against the beta.3 corpus, with `setup_declared` if it adds it (78
vectors; its remaining skips are then 4 `incremental_output` and 1
`bigint_json`), MAF with `host_declaration` declared once its
declaration-loading branch is on its `main`. The claim rule for
`host_declaration` is SHOULD in beta.3 and MUST from 0.1.0 final.

## Version

The change needs no declaration contract bump. Under §7.7.2 a minor adds a member or an
enum value; a major removes or repurposes a member, narrows an enum,
changes a default, the validation order, a refusal class's coverage,
the binding envelope, the equivalence rule or the floor. Defining
`agent_hooks.inline` does none of these. The kind grammar already
admits it, the envelope is unchanged, `kind_unknown` and
`binding_rejected` keep their coverage, and the rule of §7.7.7 widens
who it covers without changing what it says. A beta.2 loader already
refuses a document naming the kind with `kind_unknown`, because
`HostRegistry::kind` refuses the `agent_hooks` head in all five SDKs,
so an older loader refuses rather than misreads, which is the property
a minor bump exists to protect. The contract stays
`agent-hooks-declaration/1.0`, the wire stays `agent-hooks/0.1`, and
the package version is 0.1.0-beta.3.

## Risks

- Record bytes change once for every code host: `declaration` appears,
  and `verdicts[].name` appears for unnamed interceptors. The five
  in-tree pins flip by design; MAF and ACS tests assert nothing on the
  absence; an external fixture that compared whole records
  will see the two members. The CHANGELOG headline names both, and the
  wire schema stays permissive.
- A host that registers between emissions worked on beta.2 and now
  gets a sealed refusal. No in-tree host, ACS or MAF does this; the
  CHANGELOG says so.
- MAF mapping keys as binding ids: a key outside the grammar, or a
  duplicate, is refused at `register`, inside the run on today's
  per-run construction. The refusal pointer `/bindings/<i>/id` names
  the position; MAF validates at factory time when it takes the
  release.
- The builder's default surface over-claims for a host whose loop
  omits a point pair. Records and vectors are unaffected; a claim could
  cite an inaccurate document. §7.7.4 requires a builder host to state
  its surface and tells a register-path host to move to the builder,
  and §13.3 forbids citing the default either way.
- Opening the `agent_hooks` segment inside the SDK could leak: a bug in
  `inline()` or a later `kind()` change could let a host register
  under `agent_hooks.*`. `kind()` keeps the head check for every
  caller, `inline()` is the only entry, and a test in each SDK pins
  that `kind("agent_hooks.inline")` and `kind("agent_hooks.other")` are
  refused on plain and conformance registries.
- Five SDKs must write byte-identical documents for the same calls, or
  the §7.7.7 promise fails quietly. The golden file pins five documents
  per SDK, generated once from Rust and replayed in every port before
  merge.
- Two supported ways to build an emitter stay in five SDKs, and they
  can drift: a check one runs and the other skips, a default one
  writes and the other omits. A parity test per SDK builds one
  configuration through the builder and through the register path and
  asserts equal canonical documents and byte-identical records, with
  the two stated differences (the Rust unbounded timeout,
  `set_max_records(0)`) pinned as such.
- Shared instances. One registry now shares interceptor objects across
  every emitter it builds, and MAF builds per run. Rust already
  requires `Send + Sync`; Python and TypeScript interceptors are
  single-threaded; .NET and Go hosts with stateful interceptors must be
  thread-safe, which the parallel-tool-call note already demands.
- Concurrency at the first emission. §12.2 allows concurrent emissions,
  and MAF's .NET middleware runs parallel tool calls on one per-run
  emitter. .NET seals under a lock with a double-checked flag; Go seals
  under its mutex with a flag, not `sync.Once`, so a refused seal can be
  fixed and retried.
- A third-party harness that returns an SDK-written document from
  `declaration()` is gated into the declaration parts only when that
  document states `host_declaration`, which under the one meaning is
  exactly when it implemented the seam. The reference harnesses state
  it explicitly already.
- This reverses a recorded beta.2 decision: that the legacy constructor
  stays outside the loader rather than being routed through an
  invented declaration. The answer: the document the SDK writes is not
  invented. It is the host's configuration plus a surface the host
  states or the emitter admits, and one construction path is worth the
  one-time record change (issue #138).

## Decision needed

- [ ] Adopt option C with the existing API kept, plus the grafts
      above? The pending state, `seal()`, the optional `declaration()`
      and Go's `Sealed()` stay as public API with no removal line.
- [ ] Inline kind: `agent_hooks.inline`, the one kind the specification
      defines; the registry installs its resolver on the first
      `inline(id, instance)` call; a document naming it with no inline
      instance registered is refused `kind_unknown`, with instances but
      none under the id `binding_rejected`; non-empty `config` is
      `binding_rejected`. Alternative recorded: `agent_hooks.instance`,
      always present, so the class is always `binding_rejected`.
- [ ] All-points default rule: the builder always writes `surface`;
      with none stated it writes the points the emitter admits, with
      posture from the builder's setter; a host with a non-default
      posture or unbuffered output states its surface or posture before
      its first binding; a document carrying the default surface is not
      citable.
- [ ] `host_declaration` meaning: the harness implements the
      declaration seam, and nothing else; the SDK never writes it on
      the host's behalf (it leaves `sdk_default()` and the builder's
      default surface); the enum and the §7.7.4 capability list are
      unchanged.
- [ ] CTK posture change: the runner writes the harness posture into a
      posture-silent vector document; `AH-CTK-121` gets
      `expect.load_by_posture`; the claim rule for `host_declaration`
      is SHOULD in beta.3 and MUST from 0.1.0 final.
- [ ] No surface or posture setter on the register path; `terminate`
      hosts should state their posture on the builder.
- [ ] The register path keeps beta.2 behaviour: an unbounded Rust
      build writes `interceptor_ms: null` and `set_timeout` stays a
      no-op there; `set_max_records(0)` maps to 1. The builder refuses
      both.
- [ ] `AH-CTK-146` asserts `declaration` only; no `verdicts[].name`
      pin.
- [ ] `spec/DECLARATION-VERSIONS.md`: a Notes entry on the 1.0 row, no
      new SDK-release row.
