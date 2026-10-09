# Host declaration document

A versioned JSON contract that fixes a host's configuration, declared surface
and interceptor bindings, loaded from a file, from JSON text or built in code,
with one loader and one set of fail-closed rules behind all three.

Status: implemented in spec 0.1 as section 7.7 (wire version
`agent-hooks/0.1` unchanged), contract version
`agent-hooks-declaration/1.0`. The spec section, the schema and the
Rust core are normative; this document records the reasoning and is
not kept in step with later changes. Where the two differ, the spec
wins.

## Context

Today a host builds its emitter in code: `new(mode, resolver)`, then setters
for composition, identity provider, timeout, redactor and sink, then
`register(interceptor)` one at a time. The spec says composition is host
configuration (§7.1) and the conformance surface is a declaration (§13.1), but
neither has a file form. Two integration conversations exposed the gap. A
runtime team asked how hooks are specified beyond the wire format and wants
configuration to ride the enterprise managed-settings channel it already has
(a JSON document), not a new deployment mechanism. A gateway team described a
portable hooks configuration that harnesses and gateways load so one control
plane can drive many runtimes.

Agent Hooks must stand on its own and support more than one realization. That
needs a document a host loads, and it needs the document to be a contract
with its own version, since enterprises will keep documents longer than they
keep SDK builds.

## Goals

- One JSON document declares host configuration (composition profile and
  knobs, identity provider, approval resolver and redactor references,
  posture, timeouts), the declared surface (interception points emitted,
  capabilities, profiles and knob values supported) and per-point interceptor
  bindings by reference.
- The binding model is open: a binding is a kind string plus a kind-specific
  config object; the host registers kind resolvers in code; the spec defines
  the envelope and the fail-closed rules, not a catalog of kinds, and names no
  product.
- Three construction paths (file path, JSON content, code) yield the same
  emitter and the same records.
- A declaration that names anything the host code cannot honour is refused at
  load, before any emission. Nothing is narrowed, defaulted past the code's
  capability, or partially applied.
- The resolved declaration is what the record's `composition` and
  `identity_provider` already stamp. The surface part lines up with the CTK
  harness surface so a claim can cite the document.
- The document is a versioned contract separate from the wire version and
  from package versions, with explicit compatibility rules, a refusal class
  for unsupported versions, and a published mapping from SDK releases to
  accepted contract versions.
- Covered by the CTK: valid load, each refusal class a vector can express,
  three-path equivalence, record stamping.
- Hosts on the code path keep working unchanged and their records stay byte
  for byte the same.

Non-goals for 1.0 are listed under "Out of scope".

## The document

### Example

A complete, valid 1.0 document:

```json
{
  "$schema": "https://responsibleai.github.io/agent-hooks/schema/v0.1/host-declaration-1.0.schema.json",
  "declaration": "agent-hooks-declaration/1.0",
  "spec": "agent-hooks/0.1",
  "id": "prod-eu-strict",
  "host": { "name": "example-runtime", "version": "3.2.0" },
  "configuration": {
    "mode": "enforce",
    "composition": { "profile": "parallel/unanimous", "on_disagreement": "approval" },
    "identity_provider": "jcs-sha256",
    "approval": { "resolver": "operator-queue", "redactor": "strip-secrets" },
    "posture": { "tool_seam_host_error": "continue" },
    "timeouts": { "interceptor_ms": 5000, "approval_resolver_ms": 30000 },
    "records": { "max_buffered": 10000 }
  },
  "surface": {
    "interception_points": [
      "agent_startup", "input", "pre_model_call", "post_model_call",
      "pre_tool_call", "post_tool_call", "output", "agent_shutdown"
    ],
    "capabilities": ["model_calls", "tool_calls", "int64_json", "host_declaration"],
    "profiles": {
      "sequential/first_deny": { "on_approval": ["stop", "resume"] },
      "sequential/run_all": {},
      "parallel/strictest": { "on_transform_conflict": ["deny", "approval"] },
      "parallel/unanimous": { "on_disagreement": ["deny", "approval"] }
    },
    "buffered_output": true,
    "declaration_versions": ["agent-hooks-declaration/1.0"]
  },
  "bindings": [
    {
      "id": "egress-guard",
      "kind": "com.example.egress",
      "at": ["pre_tool_call", "output"],
      "config": { "allow_hosts": ["internal.example"] },
      "timeout_ms": 2000
    },
    {
      "id": "audit",
      "kind": "com.example.audit-log",
      "config": { "sink": "stdout" }
    }
  ],
  "extensions": {}
}
```

The smallest valid document is two members:

```json
{
  "declaration": "agent-hooks-declaration/1.0",
  "bindings": [{ "id": "allow", "kind": "com.example.allow-all" }]
}
```

Everything else defaults to the value the spec already names as the default,
and every default fails closed. `bindings` is required so that an empty-deny
host (zero bindings, every emission `deny host_error:no_interceptor` in
enforce mode) is written down rather than arrived at by omission.

### Shape

One JSON object, UTF-8. Every object is closed (`additionalProperties:
false`) except `bindings[].config` and the values under `extensions`. Fields
whose order carries no meaning are sets; `bindings` is an ordered list.

Top level:

| Member | Type | Required | Default |
|---|---|---|---|
| `$schema` | string | no | absent; ignored by the loader, kept for editors |
| `declaration` | closed identifier | yes | none |
| `spec` | `agent-hooks/<major>.<minor>` | no | the loader's `SPEC_VERSION` |
| `id` | `^[a-z0-9][a-z0-9._-]{0,63}$` | no | absent; an operator label for logs |
| `host` | object | no | absent |
| `configuration` | object | no | all defaults |
| `surface` | object | no | the code's own surface (see below) |
| `bindings` | array, 0 to 256 items | yes | none |
| `extensions` | object | no | `{}` |

`host` carries `name` (`^[a-z0-9_-]{1,64}$`, the same grammar as
`agent.framework`, required when `host` is present) and `version` (string, 1
to 64 characters). It is informative and never checked against code.

`configuration`:

| Member | Type | Default | Notes |
|---|---|---|---|
| `mode` | `enforce`, `evaluate_only` | `enforce` | §8 |
| `composition.profile` | the four §7.2 profiles | `sequential/first_deny` | |
| `composition.on_approval` | `stop`, `resume` | `stop` | consulted by `sequential/first_deny` only |
| `composition.on_disagreement` | `deny`, `approval` | `deny` | consulted by `parallel/unanimous` only |
| `composition.on_transform_conflict` | `deny`, `approval` | `deny` | consulted by `parallel/strictest` only |
| `identity_provider` | `"jcs-sha256"`, custom name, `null` | `"jcs-sha256"` | custom name `^[a-z][a-z0-9_-]{0,63}$`, not starting with `jcs` (§10.1); must be registered |
| `approval.resolver` | reference or `null` | `null` | reference `^[a-z][a-z0-9_-]{0,63}$`; must be registered; `null` means liftable denies stay denies (§9) |
| `approval.redactor` | reference or `null` | `null` | same grammar; must be registered |
| `posture.tool_seam_host_error` | `continue`, `terminate` | `continue` | must equal the posture the code implements (§13.1) |
| `timeouts.interceptor_ms` | integer 1 to 3600000, or `null` | `5000` | `null` means unbounded and must be written out |
| `timeouts.approval_resolver_ms` | integer 1 to 3600000, or `null` | the value of `interceptor_ms` | |
| `records.max_buffered` | integer ≥ 1, or `null` | `null` | maps to `set_max_records`; `null` is unbounded, as today |

A knob the declared profile does not consult is refused, never cleared. A
consulted knob left unset takes the §7.2 default, and the resolved value is
what §10.3 records. This is stricter than `CompositionConfig` deserialization
in the core, which ignores unknown members and silently drops unconsulted
knobs; the loader has its own strict composition type and the lenient paths
(`set_composition`, `compose_aggregate`, `finalize`) keep today's behaviour.

`surface`:

| Member | Type | Required | Default |
|---|---|---|---|
| `interception_points` | set of the eight point names, 4 to 8 items | no | the code's points |
| `capabilities` | set from the closed capability list | no | the code's capabilities |
| `profiles` | map from profile to supported knob values | no | the code's profiles |
| `buffered_output` | boolean | no | `true` |
| `exposure_bound` | string, 1 to 512 characters | iff `buffered_output` is `false` | absent |
| `declaration_versions` | set of contract identifiers, 1 or more | no | the code's accepted set |

`surface.profiles` values are objects whose only members are the knobs that
profile consults, each a non-empty set of the values supported:
`sequential/first_deny` has `on_approval`, `parallel/strictest` has
`on_transform_conflict`, `parallel/unanimous` has `on_disagreement`,
`sequential/run_all` has none. An absent knob member
means the default value only. This matches §13.1, which asks for "profiles
and knob values supported", and lets the loader check that the configured
composition sits inside the declared surface.

The capability list is the `conformance/vectors.schema.json` enum with one
removal and one addition: `buffered_output` is removed because it is a value,
not a presence, and the boolean member above carries it; `host_declaration`
is added (see "Conformance"). The list is therefore `model_calls`,
`tool_calls`, `parallel_tool_calls`, `streaming`, `multi_turn`, `int64_json`,
`bigint_json`, `incremental_output`, `host_declaration`.

When `surface` is absent, the resolved document carries the code's own
surface verbatim. That default is always honourable and never a guess. When
`surface` is present, every member must be a subset of what the code reports
and the §3.2 floor must hold. A conformance claim that cites a document
requires an explicit `surface` block so the file stands on its own.

Who writes the surface: in a managed-settings deployment the vendor's code
knows its surface and the administrator writes configuration and bindings.
With `surface` optional, the administrator's document omits it, and the
vendor's shipped document (the one a claim cites) states it. 1.0 has no
includes or layering, so a vendor base plus administrator overlay is not
expressible in one document; the host loads one document and the settings
channel decides which. This is stated in the spec text.

`bindings[]`, the open envelope:

| Member | Type | Required | Default |
|---|---|---|---|
| `id` | `^[a-z][a-z0-9_-]{0,63}$`, unique in the array | yes | none |
| `kind` | namespaced key, see "Bindings" | yes | none |
| `config` | any JSON value | no | `{}` |
| `at` | set of point names, 1 or more, each in the surface | no | every surface point |
| `timeout_ms` | integer 1 to 3600000, or `null` | no | `configuration.timeouts.interceptor_ms` |

`extensions` keys match `^[a-z][a-z0-9_]*$`; the reserved namespaces are
those §4.6 already reserves (the spec text points to §4.6 rather than listing
them again). Values are kept verbatim and never read by the loader.

### Resolved form

The loader produces a resolved declaration: every default filled, composition
knobs resolved exactly as `CompositionConfig::with_knob_defaults` resolves
them, `surface` filled from code when absent, binding `at` and `timeout_ms`
filled, `$schema` dropped, sets sorted (points in lifecycle order, everything
else lexically), bindings in document order, `host`, `id` and `extensions`
verbatim. Its canonical JSON (RFC 8785, the core's `canonical_json`) is the
equivalence oracle, and `emitter.declaration()` exposes it.

Fixed bounds in 1.0: document 1 MiB (text paths; the value path is measured
after serialization), depth 32, 256 bindings, 64-character ids and
references, 128-character kinds, 512-character exposure bound and refusal
detail. Oversize is a refusal, never a truncation. Making a bound tunable is a
minor change later.

### Schema

`spec/schema/host-declaration-1.0.schema.json`, draft 2020-12, `$id`
`https://responsibleai.github.io/agent-hooks/schema/v0.1/host-declaration-1.0.schema.json`.
The `v0.1` path segment is the spec version, as for every schema today; the
contract major and minor are in the file name, so a breaking change ships
`host-declaration-2.0.schema.json` beside it. The schema is self-contained
(enums mirrored, no `$ref` to sibling files) so a settings validator can use
it alone; a core unit test pins the mirrored enums to the record schema's
enums. The ci.yml schema-lint glob, pages.yml publishing and the schema-drift
vendoring into `sdk/python/python/agent_hooks/schema/` pick it up with no
change to ci.yml, pages.yml or schema-drift.yml.

Rules the schema cannot express (knob consistency, the §3.2 floor, point and
capability agreement, uniqueness, subset-of-code) live in the loader and in
the spec text, and each has a refusal class.

## Versioning of the declaration contract

The declaration is a contract with its own version, independent of the wire
version `agent-hooks/X.Y` and of package versions. The rules below are
normative in the spec section.

### Version field

Every document carries `declaration`, a closed identifier of the form
`agent-hooks-declaration/<major>.<minor>`. This spec revision defines one
version: `agent-hooks-declaration/1.0`. The shape mirrors the envelope's
`"spec": "agent-hooks/0.1"` so a reader sees two contracts side by side and
sees that they differ.

Major 0 is reserved for the conformance kit. No loader ever accepts it, so a
vector can name `agent-hooks-declaration/0.1` and get the same refusal on
every host, the way `ctk-fault` works for providers.

### What is a minor and what is a major change

Minor: adding an optional member, adding an enum value whose absence keeps the
1.0 meaning, adding a refusal class that fires only on new members, making a
fixed bound tunable. A 1.1 document that uses no 1.1 member is still a 1.1
document and is refused by a 1.0 loader (next section).

Major: removing or repurposing a member, narrowing an enum, changing a
default, changing the validation order, changing what a refusal class covers,
changing the binding envelope, changing the equivalence rule, changing the
lifecycle floor.

### Compatibility rules for loaders

- A loader publishes the exact set of versions it accepts. It refuses any
  other value of `declaration` (missing, not a string, unknown major, or a
  minor above the highest it knows) with `declaration_error:version_unsupported`
  and a message naming the accepted set. This check runs before any other
  check except reading and parsing.
- A loader never guesses, downgrades, rewrites or partially applies a
  document. A higher minor is refused even when the document uses no new
  member, because an older loader cannot know which new member changes the
  meaning of an old one.
- Under an accepted version the schema is closed. Any unknown member anywhere
  is `declaration_error:unknown_field`. A newer document therefore can never
  be misread by an older loader: it is refused at the version check, and if
  it somehow carried an old version string with new members it is refused at
  the schema check.
- A loader accepts every version in its set, including older minors of a
  major it supports. Each older minor is brought to the current one by an
  explicit function in the core (`declaration::migrate(from, to)`), one step
  per version, each with its own test. For 1.0 the function is the identity;
  it exists so the shape is in place. The resolved form and the record carry
  the document's own version string, not the migrated one, so an audit sees
  what the host was given.
- A document opts into a newer minor by writing the newer version string.
  Nothing else is implicit.
- Across a major: the spec revision that introduces 2.0 ships
  `declaration::migrate` steps for 1.x to 2.0, exposed through the FFI and
  every SDK, plus written steps in `spec/DECLARATION-VERSIONS.md`. A loader
  may accept more than one major during a deprecation window of at least two
  SDK minor releases; its accepted set says which. A host re-runs the CTK
  after migrating.

### SDK-to-contract mapping

The Rust core publishes, next to `SPEC_VERSION` in
`sdk/rust/core/src/types.rs`:

```rust
pub const DECLARATION_VERSION: &str = "agent-hooks-declaration/1.0";
pub const SUPPORTED_DECLARATION_VERSIONS: &[&str] = &[DECLARATION_VERSION];
```

The FFI exposes both through `ah_declaration_versions`. Every SDK re-exports
them under its own casing. `scripts/check-version-consistency.py` checks that
the five SDK constants equal the Rust ones and that the table below has a row
for the current version.

Records carry the contract version the emitter was constructed from, as one
payload-free string in a new optional `declaration` field (see "Records"), so
an audit can tell which contract a host ran under.

New file `spec/DECLARATION-VERSIONS.md` with two tables. Table 1: contract
version, status, schema file, spec revision that defined it, notes. Table 2:
SDK release tag, accepted contract versions, current version. First rows:
`1.0 | current | host-declaration-1.0.schema.json | 0.1.0-beta | first
version`, and `v0.1.0-beta.2 (next tag) | agent-hooks-declaration/1.0 | 1.0`.
`VERSIONING.md` gains a short paragraph stating the three independent axes
(wire, contract, package) and pointing at the file. `RELEASING.md` gains one
step: update table 2 for the tag being cut. No package version is bumped in
this work.

The harness surface declares the accepted versions too
(`HostSurface.declaration_versions`, see "Conformance"), and a document's
`surface.declaration_versions` must be a subset of it.

### Breaking changes later

A new major ships a new schema file beside the old one, a new constant in
`SUPPORTED_DECLARATION_VERSIONS`, migration steps in the core with vectors
for each, and a row in both tables. Both majors load during the deprecation
window. The CTK adds a vector per migration step that pins the resolved form
of a migrated document against the resolved form of the same content written
natively in the new major.

## Loading and validation

### Order

Loading is a pipeline. Each step runs only if the one before it passed, so a
given document yields one refusal class on every SDK, and vectors can pin it.
Steps 1 and 11 run in the wrapper (they touch the file system and host
callables); steps 2 to 10 run in the Rust core behind one call, so a wrapper
cannot skip a check.

| Step | Check | Class |
|---|---|---|
| 1 | Read (path only): regular file, at most 1 MiB, strict UTF-8, no BOM | `unreadable` |
| 2 | Parse: one JSON object, no duplicate keys, depth at most 32, at most 1 MiB of text | `malformed` |
| 3 | `declaration` present and in the accepted set | `version_unsupported` |
| 4 | `spec`, when present, has the loader's major and a minor no greater than the loader's | `spec_unsupported` |
| 5 | No unknown member at any closed level | `unknown_field` |
| 6 | Types, enums, patterns, ranges, required-iff rules | `invalid_field` |
| 7 | Internal consistency (below) | `inconsistent` |
| 8 | Everything the surface and configuration name is in the code's `HostSurface` | `surface_unsupported` |
| 9 | Custom identity provider, resolver and redactor references are registered | `reference_unresolved` |
| 10 | Every binding kind has a registered resolver (all checked before any runs) | `kind_unknown` |
| 11 | Resolvers run in array order; an error, exception, panic or non-interceptor return | `binding_rejected` |
| 12 | Construct the emitter and seal it | none |

Internal consistency (step 7): the §3.2 floor (`agent_startup`, `input`,
`output`, `agent_shutdown` present); omissions in pairs (`tool_calls` in
capabilities iff both tool points are listed, `model_calls` iff both model
points); a knob only under the profile that consults it; the configured
profile present in `surface.profiles` and each configured knob value in that
profile's supported set; `incremental_output` only with `buffered_output:
false`; `exposure_bound` present iff `buffered_output` is `false`; the
document's own `declaration` in `surface.declaration_versions`; binding `at`
within the surface points; unique binding ids.

Surface against code (step 8): every surface point, capability, profile and
knob value, every `declaration_versions` entry, `buffered_output: false`, the
posture, and a numeric timeout on a build that cannot bound execution. The
check runs on the filled defaults too, so a document that omits `surface` on a
host without tool points resolves to that host's surface rather than past it,
and a document that writes the default `interceptor_ms` on a build without a
timeout mechanism is refused rather than silently unbounded.

Nothing in the pipeline drops, clears or defaults a member the document
stated. Defaults fill absent members only.

### Refusal classes

Refusals are construction errors, not verdicts. The §11 reasons are the
vocabulary of a synthesized deny on an emission that happened; a refused
document happens before any emitter exists, so there is no context, record or
verdict to carry a reason, and a load failure must never look like an
emission result in an audit log. Putting load failures in §11 would also
force `HostError` to grow variants `finalize` can never stamp. So refusal
has its own closed namespace, `declaration_error:<class>`, with eleven
classes, inventoried in `spec/declaration-errors.json` (same shape as
`spec/reserved-reasons.json`, published by pages.yml next to it) and pinned by
a Rust tripwire test like `tests/reserved_reasons.rs`.

| Class | Covers |
|---|---|
| `declaration_error:unreadable` | not a regular file, over 1 MiB, not strict UTF-8, BOM, I/O error |
| `declaration_error:malformed` | not JSON, root not an object, duplicate key, depth over 32, text over 1 MiB, non-finite number from the value path |
| `declaration_error:version_unsupported` | `declaration` missing, not a string, or not in the accepted set |
| `declaration_error:spec_unsupported` | `spec` present with another major or a higher minor than the loader's |
| `declaration_error:unknown_field` | an unknown member at any closed level |
| `declaration_error:invalid_field` | wrong type, enum, pattern, range, or a required-iff rule |
| `declaration_error:inconsistent` | a step 7 rule |
| `declaration_error:surface_unsupported` | a step 8 mismatch |
| `declaration_error:reference_unresolved` | an unregistered provider, resolver or redactor name |
| `declaration_error:kind_unknown` | a binding kind with no resolver |
| `declaration_error:binding_rejected` | a resolver failed |

An error carries the class, a list of findings (`{pointer, detail}`, JSON
pointers such as `/bindings/1/kind`) and, for `version_unsupported`, the
accepted set. A document with several problems at one step reports them all
under that step's class. Messages name pointers, member names, kinds and ids.
They never echo `config` values, because load errors are logged and `config`
may hold secrets; a resolver's message is truncated to 512 characters and
resolvers must not echo their config either.

Duplicate keys: serde_json keeps the last key, a schema validator in a
settings pipeline may keep the first, and the two must not disagree on what
loaded. The text paths refuse duplicates. The value path cannot see them
(the host's parser already collapsed them), and the spec says so: the rule
applies to text input.

Over the FFI the class travels in `AhResult.error_code`, which already carries
codes outside `host_error:*` (`marshal_error`, `panic`), and the detail is
JSON `{"findings": [...], "accepted": [...]}` so wrappers rebuild a typed
error.

### Equivalence of the three paths

The emitter is a function of (resolved declaration, registry). The paths
differ only in how the resolved declaration is obtained:

- `from_path` reads bytes under the step 1 rules and calls `from_json`.
- `from_json` runs steps 2 to 10 and hands the resolved form to construction.
- `from_value` serializes the value with the SDK's own marshal function and
  calls `from_json`, so size, depth and non-finite checks are the same code.
- The code path is a builder with one setter per member and
  `bind(id, kind, config, at, timeout_ms)`. `build()` yields a document value
  and goes through `from_value`. The code path is validated by the same
  function as a file, with the same classes.

Normative rule: equal resolved declarations and equal registries yield
byte-identical records for the same context sequence. Timing is excluded;
records never carry it. The runner proves the rule on every accepted vector
(see "Conformance").

The constructor and setters that exist today stay as they are and remain a
conformant way to configure a host. They do not pass through the loader, carry
no declaration, are not sealed, and their records are unchanged. The spec text
calls this "configuration in code without a declaration". Routing it through
the loader was considered and rejected: the setters cannot express a surface,
names or per-point bindings, so the result would be an invented declaration
the host never wrote.

### Sealing

An emitter built from a declaration refuses later `register`, `register_at`,
`set_composition`, `set_identity_provider`, `set_timeout`,
`set_approval_redactor` and `set_max_records` (panic in Rust, exception or
error in the wrappers). Otherwise the declaration would not be what ran and
`emitter.declaration()` would lie. `set_record_sink` and `take_records` stay
allowed: they change where records go, not what they say.

### Timeouts

`interceptor_ms` and `approval_resolver_ms` are enforced by every wrapper
today for interceptors, and by .NET and Go for the resolver; Python,
TypeScript and Rust gain the resolver bound. The Rust core bounds execution
only with the `tokio-timeout` feature. `HostSurface` therefore carries
`interceptor_timeout: bounded | unbounded`, filled by the SDK (Rust from
`cfg!(feature = "tokio-timeout")`, the wrappers always `bounded`). On an
unbounded build a numeric timeout, including the default, is refused with
`surface_unsupported` and a finding that names the fix: write `null` or
enable the feature. The `ctk` feature gains `tokio-timeout` as a dependency so
the Rust reference harness is bounded. Equivalence tests compare records,
never timing.

## Bindings

### Open kind model

A binding is `{id, kind, config, at, timeout_ms}`. `kind` is a lookup key
into the host's registry and nothing more: never a path, class name, URL or
module the loader interprets. `config` is bytes handed to the resolver
unchanged; the loader never reads inside it.

Kind grammar: `^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$`, at most 128
characters. At least one dot is required so every kind carries a namespace
the host controls (`com.example.egress`). The first segments `agent_hooks`
and `ctk` are reserved: the spec owns the first, the conformance kit the
second. The schema enforces the grammar; the registry refuses registration
under a reserved segment (the CTK runner opens `ctk` through
`HostRegistry::for_conformance()`). The spec defines no kinds in 1.0. SDKs
ship an allow-all interceptor as a helper that a host may register under a
kind it names; that is the explicit passthrough §7 asks for, and it is active
only when the host registered it.

Array order is dispatch order. At point P the interceptors that run are the
bindings whose `at` includes P, in array order. `interceptors_registered` on
the record at P is the count of that list; `verdicts[].index` and
`decided_by` index into it; `verdicts[].name` is the binding `id`. A surface
point with zero bindings behaves per §7: in enforce mode every emission there
is `deny host_error:no_interceptor`. A host without `at` filters sees today's
values exactly, and a parity test proves it in all five SDKs.

### Resolver registration

A kind resolver is host code that turns `(config, BindingContext)` into one
interceptor or an error. `BindingContext` carries `id`, `kind`, the resolved
`at` set, the resolved timeout, the `host` block and the contract version.
Resolvers run at load, with host trust, once per binding, in array order,
after every kind has been checked to exist. A resolver error, exception,
panic or non-interceptor return is `binding_rejected` and discards all work.
A resolver must validate its config and fail on anything it does not
understand, must not execute content from the document, and should do no I/O
before the interceptor's first call. The interceptor it returns is the
trusted in-process callable of §7; if it fronts a remote service, transport
and auth are the resolver's concern, as today.

The same registry holds the three named references (`identity_provider`,
`approval_resolver`, `approval_redactor`) and the code's `HostSurface`. One
object, one load call. The name manifest the wrapper sends to the core for
steps 8 to 10 is derived from what was registered, never hand-written, and at
step 11 the wrapper looks each kind up again in its own map, so bookkeeping
drift fails closed (`kind_unknown`) rather than bypassing the core's answer.
Registering the same kind or name twice is a programming error.

Per SDK, with the same names in local casing:

```rust
// Rust
let reg = HostRegistry::new(surface)
    .kind("com.example.egress", |config, ctx| Ok(Box::new(Egress::from(config)?)))?
    .identity_provider("hmac-sha256-k1", move |ctx| mac(&key, ctx))?
    .approval_resolver("operator-queue", Box::new(queue))?
    .approval_redactor("strip-secrets", strip)?;
```

```python
# Python
reg = (HostRegistry(surface)
       .kind("com.example.egress", lambda config, ctx: Egress(**config))
       .approval_resolver("operator-queue", queue))
```

```ts
// TypeScript
const reg = new HostRegistry(surface)
  .kind("com.example.egress", (config, ctx) => new Egress(config))
  .approvalResolver("operator-queue", queue);
```

```csharp
// .NET
var reg = new HostRegistry(surface)
    .Kind("com.example.egress", (config, ctx) => new Egress(config))
    .ApprovalResolver("operator-queue", queue);
```

```go
// Go
reg := agenthooks.NewHostRegistry(surface)
if err := reg.Kind("com.example.egress", func(config json.RawMessage, ctx agenthooks.BindingContext) (agenthooks.Interceptor, error) {
    return newEgress(config)
}); err != nil { return err }
```

## Records

One field is added to the §10.3 record: `declaration`, the contract version
the emitter was constructed from, for example `agent-hooks-declaration/1.0`.
It is present iff the emitter was built from a declaration through any of the
three paths, and absent for the constructor-and-setters path. It is one
string from a closed grammar with no content, path, id or digest, so it is
payload-free by construction. `finalize` and `ah_finalize` never default it:
a record claims a contract only when one governed the host. The record schema
adds it as optional with pattern `^agent-hooks-declaration/[0-9]+\.[0-9]+$`,
so stored records stay valid.

Two existing fields get exact wording for per-point bindings.
`interceptors_registered` is the number of interceptors bound at the emitted
point; `verdicts[].index` and `decided_by` index into that list in dispatch
order. For hosts without `at` filters the values equal today's.
`verdicts[].name` is the binding `id`; the Rust emitter switches from
`summaries()` to `summaries_named()`, and with every name absent the bytes
are identical to today, which a golden parity test against the four wrappers
pins.

`composition` and `identity_provider` are unchanged. The resolved
declaration's `configuration.composition` is, by construction, the value
`finalize` stamps: the loader hands a resolved `CompositionConfig` to the
emitter and `with_knob_defaults` is a no-op on it.

Not added, on purpose: the document `id`, a digest, the file path, kinds,
config, host name, resolver names. Each is content the record format has kept
out, and §10.3's payload-free rule is the record's main security property. A
host should log the contract version, document `id` and the jcs-sha256 digest
of the document once at load, outside the record stream, so an operator can
match a running host to a pushed document.

`FinalizeMeta`, `FinalizeOptions` and the four wrappers' finalize option
objects gain `declaration: Option<String>`. `record_host_failure` stamps it
too when the emitter was declaration-built.

## Conformance

### Surface mapping

The §13.1 surface (capabilities, profiles and knob values, identity provider,
posture, `buffered_output` and exposure bound) is `surface` plus
`configuration.identity_provider` plus `configuration.posture`. The design
makes one code value the source for production and conformance:

```rust
pub struct HostSurface {
    pub interception_points: BTreeSet<InterceptionPoint>,
    pub capabilities: BTreeSet<String>,            // closed list, validated
    pub profiles: BTreeMap<CompositionProfile, KnobSupport>,
    pub tool_seam_host_error: Posture,             // continue | terminate
    pub streams_unbuffered: bool,                  // may declare buffered_output: false
    pub interceptor_timeout: TimeoutSupport,       // bounded | unbounded, filled by the SDK
    pub declaration_versions: BTreeSet<String>,    // subset of SUPPORTED_DECLARATION_VERSIONS
}
```

`HostSurface::new` fails if `declaration_versions` is not a subset of the
core's supported set or a capability is not in the closed list. There is no
core default that lists capabilities an SDK cannot prove; the SDK default
carries only the floor points, `host_declaration`, all four profiles with
every knob value, posture `continue`, `streams_unbuffered: false`, and the
SDK's timeout support. A host adds what its runtime does.

The Harness contract in all five SDKs gains two methods with defaults:

- `host_surface()` returns the code surface. The default derives it from
  `capabilities()` and `tool_seam_host_error()`: the floor points plus the
  model points iff `model_calls` plus the tool points iff `tool_calls`, all
  four profiles with every knob value, the SDK's timeout support and accepted
  versions.
- `declaration()` returns the host's own document (a value) or nothing.

When `declaration()` is present the runner resolves it against
`host_surface()` once before the first vector; refusal fails the whole run
with the findings. The capabilities, posture and accepted versions used for
skipping and for `postures` forwarding are then read from the resolved
document, so what the CTK ran against is exactly what the claim cites. The
report header prints the resolved surface and the jcs-sha256 digest of the
document. When `declaration()` is absent, today's code-declared surface is
used unchanged.

`setup` gains two optional arguments: `declaration` (the document under test,
as a value) and `registry` (built by the runner). A harness that receives
them must build its emitter with `from_value(document, registry)` and return
the `DeclarationError` from `setup` on refusal; it must not fall back to the
field-based construction. A harness that does not declare `host_declaration`
never receives them.

Capability vocabulary: `host_declaration` is added to
`conformance/vectors.schema.json`, HARNESS.md, the Python enum, the
TypeScript union, the Go constants and the .NET enum (Rust uses strings).
While touching them, the TypeScript, Go and .NET vocabularies gain the names
they lack (`int64_json`, `bigint_json`, `incremental_output` as applicable)
so the five lists match the schema enum. The loader validates capability
names against the closed list; `should_skip` stays a subset check.

All five reference harnesses declare `host_declaration`, ship a
`reference.declaration.json` with an explicit surface (embedded with
`include_str!`, `importlib.resources`, a JSON import, an embedded resource
and `go:embed`), and build every emitter through the loader: for vectors
without a declaration the harness writes the vector's mode, composition and
provider into a copy of its document and binds the scripted interceptors
through a `ctk.instance` kind whose resolver captures them by index. The 51
existing vectors then exercise the loader for free, and the five skip
manifests do not change.

CLAIMS.md gains an optional `Declaration` column (path or URL of the cited
document at the claimed commit) and one filing rule: a claim that cites a
document cites the file whose resolved surface the CTK run used, and the
document carries an explicit `surface`. The §13.3 tuple is unchanged. The
proposals README exempts additive optional fields and new vectors from a
proposal, and that is all this change adds to a record or a claim, so no
proposal is filed; the PR text says so.

### Runner contract for declaration vectors

When a vector carries `host_declaration`:

1. Skip (not fail) if the harness lacks the `host_declaration` capability or
   any other capability the vector lists. Never skip on the document's
   version; the version vectors must reach the loader.
2. Build the registry with `HostRegistry::for_conformance(harness.host_surface())`:
   kind `ctk.scripted` (config `{"script": i}`, the scripted interceptor built
   from `interceptor_scripts[i]`, the first one recording), identity provider
   `ctk-fault`, approval resolver `ctk-scripted` from `approval_script`,
   redactor `ctk-redact` from `redact_for_approval`.
3. Prove the paths: resolve the document through the core from the value, from
   its JSON text, from a temporary file (deleted in teardown) and from a
   builder the runner populates member by member (a CTK helper in each SDK).
   The four canonical resolved forms must be identical; a difference is a
   failure with the first differing pointer. On refusal all four must refuse
   with the same class.
4. Call `setup` with the document and registry. On refusal, record
   `load: {outcome: "refused", class}` and skip `run`. On acceptance, record
   `load: {outcome: "accepted", paths_equivalent: true}` and run as today.
5. `ctk_assert` checks `expect.load` first. When refused it also asserts no
   records and no interceptions.

`RunRecord` gains `load`. `vectors.schema.json` gains top-level
`host_declaration` (object) and `host_declaration_invalid` (boolean); an
`if/then` applies the `$ref` to the published declaration schema only when
the flag is not `true`, so refusal vectors that break the schema stay valid
under schema-lint while valid documents still get checked. `expect` gains
`load` (`outcome`, optional `class` from the eleven, optional
`paths_equivalent`). `expect.records[].assert` paths may name `declaration`.

### Vectors

Part names `declaration/load`, `declaration/bindings` and
`declaration/refusal`; ids 120 to 139, the next free block after 113. Every
vector lists `host_declaration`; those with tools add `model_calls` and
`tool_calls`. Every expected outcome is the same on every conformant host:
refusals use reserved values (major 0, the `ctk` namespace, rules internal to
the document) and never depend on what a particular harness lacks.

| Id | Part | Scenario |
|---|---|---|
| AH-CTK-120 | load | Minimal document: `declaration` and one `ctk.scripted` allow binding. Run completes. Every record asserts `declaration` is `agent-hooks-declaration/1.0`, `composition.profile` `sequential/first_deny`, `composition.on_approval` `stop`, `identity_provider` `jcs-sha256`, `mode` `enforce`, `interceptors_registered` 1, `verdicts[0].name` the binding id. |
| AH-CTK-121 | load | Full document: `parallel/unanimous` with `on_disagreement: approval`, two bindings `a` and `b`, resolver `ctk-scripted`, explicit surface. The pre_tool_call record asserts `on_disagreement` `approval`, `on_transform_conflict` absent, `on_approval` absent, `interceptors_registered` 2, `verdicts[0].name` `a`, `verdicts[1].name` `b`, `resolved_by` present. |
| AH-CTK-122 | load | `mode: evaluate_only` with a transform binding. Record `mode` `evaluate_only`, `verdict.decision` `transform`, tool invoked with the original args, `declaration` stamped. |
| AH-CTK-123 | load | Three-path equivalence: `parallel/strictest` with two bindings and a custom `timeout_ms`; `expect.load.paths_equivalent` true; records pin `on_transform_conflict` `deny` filled in, `declaration`, names and `decided_by`. |
| AH-CTK-124 | bindings | `a` (deny) at `pre_tool_call` only, `b` (allow) at every point, order `[a, b]`. The input record shows `interceptors_registered` 1 and `verdicts[0].name` `b`; the pre_tool_call record shows `interceptors_registered` 2, `decided_by` 0, `verdicts[0].name` `a`; run blocked. |
| AH-CTK-125 | bindings | The only binding is at `pre_tool_call`, enforce mode. The agent_startup record is `deny host_error:no_interceptor` with `declaration` stamped; run blocked. |
| AH-CTK-126 | bindings | `bindings: []`, enforce mode. Twin of AH-CTK-061 through the loader: agent_startup denies `host_error:no_interceptor`; run blocked. |
| AH-CTK-127 | refusal | `declaration: "agent-hooks-declaration/0.1"` (reserved major). `version_unsupported`. |
| AH-CTK-128 | refusal | `declaration` missing. `version_unsupported`. |
| AH-CTK-129 | refusal | `spec: "agent-hooks/9.0"`. `spec_unsupported`. |
| AH-CTK-130 | refusal | Unknown top-level member `policy`. `unknown_field`, pointer `/policy`. |
| AH-CTK-131 | refusal | Unknown nested member `configuration.composition.on_timeout`. `unknown_field`. |
| AH-CTK-132 | refusal | `configuration.mode: "audit"`. `invalid_field`, pointer `/configuration/mode`. |
| AH-CTK-133 | refusal | `sequential/run_all` with `on_approval: resume`. `inconsistent` (knob not consulted, not silently cleared). |
| AH-CTK-134 | refusal | `surface.interception_points` without `agent_shutdown`. `inconsistent` (§3.2 floor). |
| AH-CTK-135 | refusal | `surface.declaration_versions` lists `agent-hooks-declaration/0.1` beside 1.0. `surface_unsupported`. |
| AH-CTK-136 | refusal | `identity_provider: "hmac-sha256-k1"` with no such provider registered. `reference_unresolved`. |
| AH-CTK-137 | refusal | Binding kind `ctk.nonexistent`. `kind_unknown`, pointer `/bindings/0/kind`. |
| AH-CTK-138 | refusal | `ctk.scripted` with `config.script` a string. `binding_rejected`, id and kind named. |
| AH-CTK-139 | refusal | Two bindings with id `a`. `inconsistent`, pointer `/bindings/1/id`. |

Refusal vectors carry `expect.load.outcome: refused`, no `interceptions` and
no `run_outcome`; those that break the JSON schema (127, 128, 130, 131, 132)
carry `host_declaration_invalid: true`.

Not vector-testable, covered by SDK unit tests and listed under "Coverage
boundaries" in HARNESS.md: `unreadable` (missing path, directory, oversize,
bad UTF-8, BOM), `malformed` (non-JSON, duplicate keys, depth, non-finite
value), a higher minor (`1.9`) refused as `version_unsupported`,
`surface_unsupported` for points, capabilities, profiles, knob values,
posture, `buffered_output: false` and timeouts against a narrowed
`HostSurface`, sealing, and the stale-manifest check.

A golden file `conformance/golden/declaration.json` holds five documents
(minimal, full, every default spelled out, surface absent against a fixed
surface, per-point bindings) with their resolved canonical JSON, asserted
byte for byte in all five SDKs the way `conformance/golden/identity.json` is.

The twenty vectors and the new schema are vendored into
`sdk/python/python/agent_hooks/ctk/vectors/` and `.../schema/` in the same
PR. `spec/declaration-errors.json` sits beside `reserved-reasons.json`, which
is not vendored, and gets one copy line in pages.yml.

## SDK API

### Rust core

New module `sdk/rust/core/src/declaration.rs`, re-exported at the root.

```rust
pub const DECLARATION_VERSION: &str;
pub const SUPPORTED_DECLARATION_VERSIONS: &[&str];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostDeclaration { /* every member of the document, Options for the optional ones */ }
impl HostDeclaration {
    pub fn from_path(path: impl AsRef<Path>) -> Result<Self, DeclarationError>;   // steps 1 to 7
    pub fn from_json(text: &str) -> Result<Self, DeclarationError>;              // steps 2 to 7
    pub fn from_value(value: Value) -> Result<Self, DeclarationError>;           // serialize, then from_json
    pub fn builder() -> DeclarationBuilder;
    pub fn version(&self) -> &str;
}
pub struct DeclarationBuilder { /* one setter per member; bind(id, kind, config, at, timeout_ms) */ }
impl DeclarationBuilder { pub fn build(self) -> Result<HostDeclaration, DeclarationError>; }

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ResolvedDeclaration { /* every default filled */ }
impl ResolvedDeclaration {
    pub fn canonical_json(&self) -> String;
    pub fn composition(&self) -> CompositionConfig;
    pub fn identity_provider(&self) -> Option<&str>;
    pub fn bindings(&self) -> &[ResolvedBinding];
}
pub fn resolve(decl: &HostDeclaration, surface: &HostSurface, names: &RegistryNames)
    -> Result<ResolvedDeclaration, DeclarationError>;                             // steps 8 to 10
pub fn migrate(doc: Value, to: &str) -> Result<Value, DeclarationError>;         // identity for 1.0

pub struct HostSurface { /* as in Conformance */ }
pub struct BindingContext<'a> { pub id: &'a str, pub kind: &'a str, pub at: &'a BTreeSet<InterceptionPoint>,
    pub timeout: Option<Duration>, pub host: Option<&'a HostInfo>, pub declaration_version: &'a str }
pub type KindResolver = Box<dyn Fn(&Value, &BindingContext) -> Result<Box<dyn Interceptor>, String> + Send + Sync>;
pub struct HostRegistry { /* surface, kinds, identity providers, approval resolvers, redactors */ }
impl HostRegistry {
    pub fn new(surface: HostSurface) -> Self;
    pub fn for_conformance(surface: HostSurface) -> Self;                         // allows the ctk namespace
    pub fn kind(self, kind: &str, f: KindResolver) -> Result<Self, DeclarationError>;
    pub fn identity_provider(self, name: &str, f: impl Fn(&AgentContext) -> String + Send + Sync + 'static) -> Result<Self, DeclarationError>;
    pub fn approval_resolver(self, name: &str, r: Box<dyn ApprovalResolver>) -> Result<Self, DeclarationError>;
    pub fn approval_redactor(self, name: &str, f: ApprovalRedactor) -> Result<Self, DeclarationError>;
    pub fn names(&self) -> RegistryNames;                                         // derived, never hand-written
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeclarationErrorClass { Unreadable, Malformed, VersionUnsupported, SpecUnsupported, UnknownField,
    InvalidField, Inconsistent, SurfaceUnsupported, ReferenceUnresolved, KindUnknown, BindingRejected }
#[derive(Debug, Clone, thiserror::Error)]
pub struct DeclarationError { pub class: DeclarationErrorClass, pub findings: Vec<Finding>, pub accepted: Vec<String> }
pub struct Finding { pub pointer: String, pub detail: String }
impl DeclarationError { pub fn code(&self) -> &'static str; }                     // "declaration_error:<class>"

impl InterceptionEmitter {
    pub fn from_declaration(decl: HostDeclaration, registry: &HostRegistry) -> Result<Self, DeclarationError>;
    pub fn from_declaration_path(path: impl AsRef<Path>, registry: &HostRegistry) -> Result<Self, DeclarationError>;
    pub fn from_declaration_json(text: &str, registry: &HostRegistry) -> Result<Self, DeclarationError>;
    pub fn from_declaration_value(value: Value, registry: &HostRegistry) -> Result<Self, DeclarationError>;
    pub fn declaration(&self) -> Option<&ResolvedDeclaration>;
    pub fn register_at(&mut self, i: Box<dyn Interceptor>, name: Option<String>, at: BTreeSet<InterceptionPoint>) -> &mut Self;
}
```

Emitter internals: registrations become `Vec<Bound { interceptor, name, at,
timeout }>`; `register` is `register_at` with every point and no name;
`dispatch` filters to the current point and runs the existing profile code
over the filtered snapshot; `sealed: bool` guards the setters;
`declaration: Option<ResolvedDeclaration>` feeds `FinalizeMeta.declaration`.
The approval resolver and the `approval_resolver_ms` bound are applied in
`consult` under `tokio-timeout`. `Cargo.toml`: `ctk = ["tokio-timeout"]`.
`tests/declaration_errors.rs` is the tripwire against
`spec/declaration-errors.json`; `tests/declaration.rs` covers the classes,
the order on a document that breaks several steps at once, bounds, duplicate
keys, migration identity and the golden file.

`ffi_surface.rs` gains two string-in, string-out functions:
`declaration_versions()` and `declaration_resolve(document_json, host_json)`
where `host_json` is the surface plus the registry names
(`{surface, identity_providers, approval_resolvers, approval_redactors,
kinds}`), running steps 2 to 10 and returning the resolved declaration JSON.
`finalize` options accept `declaration`. `ctk_assert` learns `expect.load`
and `RunRecord.load`.

### FFI

`sdk/rust/ffi/src/lib.rs` and `include/agent_hooks.h` gain:

```c
AhResult *ah_declaration_versions(void);
AhResult *ah_declaration_resolve(const char *document_json, const char *host_json);
```

Seventeen symbols. Both run under `guarded()`. The header comment lists
`declaration_error:*` beside `host_error:*`, `marshal_error` and `panic`.
Docs that cite fifteen symbols are updated. Wrappers do step 1 (read) and
step 11 (resolvers) themselves, pass the text and the derived names to the
core, and construct their emitter from the resolved JSON. PyO3, napi,
`Native.cs` and `native.go` mirror the two symbols; `binding.js` and
`binding.d.ts` are regenerated with `npm run build:native:debug` and
committed; `_core.pyi` is updated.

### Python

```python
from agent_hooks import (DECLARATION_VERSION, SUPPORTED_DECLARATION_VERSIONS,
                         HostDeclaration, HostRegistry, HostSurface, DeclarationError)

reg = HostRegistry(HostSurface(...)).kind("com.example.egress", make_egress)
em = InterceptionEmitter.from_declaration_path("agent-hooks.declaration.json", reg)
em = InterceptionEmitter.from_declaration_json(text, reg)
em = InterceptionEmitter.from_declaration_value(obj, reg)
em = InterceptionEmitter.from_declaration(HostDeclaration.builder().mode("enforce").bind(...).build(), reg)
em.declaration            # ResolvedDeclaration with to_wire() and canonical_json()
em.register(i, name=None, at=None)   # at: iterable of InterceptionPoint; refused on a sealed emitter
```

`DeclarationError(ValueError)` carries `.code`, `.findings` and `.accepted`.
Timeouts in seconds derive from the millisecond members.

### TypeScript

`HostDeclaration.fromPath(p)` (async; `stat` before read for the size
bound), `fromJson`, `fromValue`, `builder()`; static
`InterceptionEmitter.fromDeclaration(decl, registry)`, `fromDeclarationPath`,
`fromDeclarationJson`, `fromDeclarationValue`; `emitter.declaration`;
`register(interceptor, name?, at?)`; `DeclarationError extends Error { code,
findings, accepted }`; `HostRegistry`, `HostSurface`, `DECLARATION_VERSION`,
`SUPPORTED_DECLARATION_VERSIONS` exported from the root. The CTK `Capability`
union is widened to the closed list.

### .NET

`HostDeclaration.FromPath(string)`, `FromJson(string)`, `FromNode(JsonObject)`,
`Builder()`; static `InterceptionEmitter.FromDeclaration(HostDeclaration,
HostRegistry)` and the three path, JSON and node forms; the declared timeout
is passed to the constructor so no new setter is needed; `Declaration`
property; `Register(IInterceptor, string? name = null,
IReadOnlySet<InterceptionPoint>? at = null)`; `DeclarationException { Code,
Findings, Accepted }`; `HostRegistry`, `HostSurface`,
`Declaration.Version`, `Declaration.SupportedVersions`. System.Text.Json
only, so the locked restore and `packages.lock.json` files stay as they are.

### Go

`agenthooks.LoadDeclarationPath(path)`, `ParseDeclaration([]byte)`,
`DeclarationFromValue(map[string]any)`, `NewDeclarationBuilder()`;
`agenthooks.NewInterceptionEmitterFromDeclaration(decl, reg)
(*InterceptionEmitter, error)` and the path, JSON and value forms;
`(*InterceptionEmitter).Declaration()`; `RegisterAt(i Interceptor, name
string, at []InterceptionPoint) error`; `*DeclarationError{Class, Findings,
Accepted}` with `Error()` and `Code()`, usable with `errors.As`;
`NewHostRegistry(surface)`; `DeclarationVersion`,
`SupportedDeclarationVersions`. The exported `Timeout` field keeps working;
the declaration sets it and sealing refuses later changes through the
setters (the field itself is documented as read-only after a declaration
load).

## Specification changes

New §7.7 "Host declaration document" after §7.6, tagged `[Pure
Specification]`, no renumbering, no new top-level TOC line. Subsections:

- 7.7.1 Purpose and scope. A host MAY load its configuration (§7.1),
  declared surface (§13.1) and bindings from a document validated by
  `spec/schema/host-declaration-1.0.schema.json`. The document selects
  behaviour the host already implements; it MUST NOT add behaviour, load code
  or widen the surface. Configuration in code without a declaration remains
  conformant.
- 7.7.2 Version and compatibility. The rules from "Versioning of the
  declaration contract", including the reserved major 0 and the pointer to
  `spec/DECLARATION-VERSIONS.md`.
- 7.7.3 Members and defaults. The tables above. "Every member except
  `declaration` and `bindings` is OPTIONAL. Defaults are the values this
  specification already names (§7.2, §8, §10.1, §13.1) and fail closed. A
  knob the profile does not consult MUST be refused."
- 7.7.4 Surface. The 13.1 surface in file form; the floor; pairs; the
  subset-of-code rule; absent means the code's surface; a cited document
  carries an explicit surface; no layering in 1.0.
- 7.7.5 Bindings. The envelope, the kind grammar and reserved segments, "this
  specification defines no kinds", the resolver obligations, the dispatch
  order and per-point counting, zero bindings at a point under §7.
- 7.7.6 Loading and refusal. The twelve steps, the eleven classes, the bounds,
  "refusal MUST happen before any emitter exists and leave no record; nothing
  MUST be narrowed, defaulted past the code's capability or partially
  applied; refusal messages MUST NOT echo binding configuration", duplicate
  keys on text input, `spec/declaration-errors.json` cited the way
  `reserved-reasons.json` is.
- 7.7.7 Equivalence and sealing. The three paths, the builder, the
  byte-identical rule, sealing.
- 7.7.8 Records. `declaration` present iff declaration-built; the per-point
  wording for `interceptors_registered`, `verdicts[].index`, `decided_by`,
  `verdicts[].name`; the logging SHOULD.
- 7.7.9 Conformance. `host_declaration` capability, the runner contract, "a
  host that declares `host_declaration` MUST build its emitter from the
  declaration the CTK supplies and MUST surface refusal as a load error", the
  claim rule.

Other touches: §10.3 gains the `declaration` row and the per-point sentence;
§13.1 gains "A host MAY present this surface as a host declaration document
(§7.7)"; §13.3 gains the claim rule; §14 gains one bullet on document trust.
`CHANGELOG.md` under Unreleased, in the house style: "Host declaration
document (§7.7): a versioned JSON contract, agent-hooks-declaration/1.0, for
host configuration, declared surface and interceptor bindings, with one
loader behind file, JSON and code construction. Records gain an optional
`declaration` field. New capability `host_declaration` and vectors AH-CTK-120
to 139. Wire version agent-hooks/0.1 unchanged. Additive." PR label
`spec:additive`.

## Security considerations

- Trust level. The document is host configuration at host trust, equal to
  code. It can only select among behaviours the code already has, and the
  open binding model does not change that: kinds are code the host loaded,
  not code the file brought. The loader does not make an untrusted file safe
  to load; the host decides where it reads from, and a managed-settings
  channel keeps that decision with the administrator.
- No code, no indirection. No `$ref`, includes, file references, environment
  or variable expansion, path templates or remote fetch. `$schema` is
  ignored. `kind` is a key, never a path, class name or URL the loader acts
  on. A resolver that loads code from `config` violates §7.7.5 and the host's
  claim.
- Path handling. The host passes the path; the loader opens exactly that
  path, requires a regular file (a symlink to one is fine), reads it once and
  never re-reads, so a later change on disk cannot alter a running host.
  Nothing in a context or verdict ever influences which file is read. The
  `unreadable` detail carries the OS error class, not file contents.
- Bounds before parse completes. Size, depth and binding count are refusals,
  not truncations.
- Duplicate keys are refused on text input so a validator and the loader
  cannot disagree on which value won.
- Fail closed everywhere. A refused load leaves no emitter, no narrowed
  surface and no record; a point with no bindings denies; an unregistered
  provider or resolver is refused at load rather than failing per emission;
  a numeric timeout on a build that cannot bound execution is refused rather
  than ignored.
- Sealing. A declaration-built emitter cannot be reconfigured, so the
  resolved declaration, the record stamp and the claim describe what ran.
- Resolvers run with host trust, at load, before any emission. A slow or
  faulty resolver delays startup but never an emission. Their output is a
  normal interceptor and gets §6.3 isolation at emission time. Resolvers must
  not log `config` verbatim and the loader never does.
- Secrets. Configs should reference secrets by key id (the §10.1
  `hmac-sha256-<key-id>` pattern already models this). Refusal messages and
  the FFI detail carry pointers, names, kinds and ids, never config values.
- Records stay payload-free. One contract version string; no id, digest,
  path, kind, config, host name or resolver name leaves the host through
  records.
- Reserved namespaces stop a vendor kind from shadowing a future spec or CTK
  kind, in the schema and in the registry.
- Integrity is the channel's job. The host should log the contract version,
  document `id` and jcs-sha256 digest at load so an operator can match a
  running host to a pushed document.

## Compatibility

- Hosts on the code path change nothing. `new`, the setters and `register`
  keep their signatures; records are byte-identical; no existing vector
  changes; the `declaration` field is absent.
- FFI consumers see two added symbols and one added optional member in
  finalize options. Old callers are unaffected.
- CTK harnesses outside the repo: the two Harness methods have defaults, the
  two `setup` arguments are optional, and the new part is gated on
  `host_declaration`, so a harness that changes nothing passes every existing
  vector and skips twenty with a stated reason. Its claim then shows that.
- Spec: additive within 0.1. The wire version stays `agent-hooks/0.1`; the
  record gains one optional field; the vectors are additive within the spec
  minor as VERSIONING.md requires. `VERSIONING.md` gains one sentence
  classing a new optional artefact under `spec/` with new vectors as MINOR.
- Gates crossed by the PR: schema-lint (new schema compiles under ajv
  draft2020, every vector validates), pages.yml (new schema and
  `declaration-errors.json` published under `schema/v0.1/`), schema-drift
  (vendored schema and vectors), change-class (`spec:additive`),
  binding.js/binding.d.ts drift, the five reference skip manifests
  (unchanged), `check-version-consistency.py` (five SDK constants and the
  versions table).
- Landing order. Two stacked PRs keep review tractable: PR 1 carries the
  spec, schema, errors inventory, versions table, vectors, Rust core, FFI and
  header, and widens the four wrappers' skip manifests with 120 to 139 so
  their self-tests stay green while their harnesses lack the capability; PR 2
  carries the four wrappers, their CTK changes and restores the manifests.
  Both land before the next tag so table 2 of `spec/DECLARATION-VERSIONS.md`
  is true. One PR is acceptable if review prefers it.
- Branch `mhabuomar/host-declaration`, worktree
  `/home/mhabuomar/code/agent-hooks/host-declaration`, no package version
  bump.

### Test plan

Rust, one target at a time with `-j 4`: `--lib` (declaration unit tests, one
per class with pointer assertions, defaults table equals spec defaults, knob
matrix for all four profiles, floor and pairs, builder-vs-JSON canonical
equality, `at` filtering counts and indices, sealing, stamp present iff
declaration-built, mirrored enums equal the record schema enums); `--test
declaration` (order on a multi-fault document, bounds with temp files,
duplicate keys, migration identity, golden file); `--test declaration_errors`
(tripwire); `--features ctk --test ctk_reference` (71 vectors, skip set
unchanged); `--test reserved_reasons` (unchanged, proves no new reason);
`--test property` (random unknown members at random pointers refuse with
`unknown_field` naming that pointer); `-p agent-hooks-ffi --lib` (two new
symbols, error family in `error_code`); clippy with `-D warnings` and fmt.

Python: `CARGO_BUILD_JOBS=4 maturin develop` once, then pytest with
`test_declaration.py` (paths, classes, sealing, registry refusals of reserved
segments, `from_declaration_value` with a non-finite float refused as
`malformed`, legacy records carry no `declaration`), CTK self-test over 71
vectors with the same four skips, ruff clean, vendored copies match.

TypeScript: `npm run build:native:debug`, commit the regenerated binding
files, `npx tsc`, `node --test` with `declaration.test.mjs`; the seven skips
unchanged.

.NET: `dotnet format --verify-no-changes`, `dotnet build -warnaserror`,
`dotnet test` with `DeclarationTests.cs`; no new package reference; four skips
unchanged.

Go: gofmt, vet, `go test ./...` with `declaration_test.go`; 71 conformance
subtests, four skips unchanged.

Schema and docs: ajv compiles the new schema and the updated record and
vector schemas with the CI-pinned versions; every vector validates; mkdocs
`--strict` builds; the README example validates against the schema in a
small lint script; `check-version-consistency.py` extended. Before opening
the PR, grep the diff for em dashes in new prose and for product names in
kinds or examples (`com.example.*` only).

## Out of scope

- Resource bounds (`max_context_bytes`, `max_depth`, §12.3). The core has no
  tunable today (depth 128 is a constant), and the rule is "declare nothing
  the code cannot honour". A 1.1 candidate once the plumbing exists.
- Record sink references. A sink is runtime integration, not configuration
  the record stamps; `set_record_sink` stays a code call and is allowed after
  sealing.
- Per-point enforcement mode. §8 allows mode per point; 1.0 declares one mode
  for the host. A 1.1 candidate.
- Includes, overlays, `$ref`, environment expansion, discovery of a default
  file name. The host loads one document the channel chose.
- Spec-defined binding kinds. The spec defines the envelope only. The
  allow-all helper is SDK code the host registers under its own kind.
- Removing or rewording existing references to other specifications in the
  spec, README and conformance material. This design adds none and touches
  none.
- Package version bumps and the release itself. `spec/DECLARATION-VERSIONS.md`
  names the next tag; cutting it is release work.

## Decisions and rejected alternatives

- Placement at §7.7, not a new top-level section or §6.4: the declaration is
  the serialized form of §7.1's host configuration, and a letter-free
  subsection avoids renumbering §14 and §15.
- Refusals in `declaration_error:*`, not `host_error:*`: no emission exists.
- `declaration` on records only for declaration-built emitters, never
  defaulted by `finalize`: a record must not claim a contract that never
  governed the host. The cost is two record shapes; the record schema keeps
  the field optional either way.
- The legacy constructor stays outside the loader rather than being routed
  through an invented declaration.
- `surface` optional and defaulting to the code's surface, never to a guess;
  a cited document carries it explicitly.
- `spec` optional, same major and minor no greater than the loader's when
  present, matching how VERSIONING.md treats wire minors.
- Separate `unknown_field`, `invalid_field` and `inconsistent` classes rather
  than one `schema` class, for diagnostics and for one-class-per-vector.
- Reserved major 0 and the reserved `ctk` kind segment make every refusal
  vector single-valued; harness-dependent expectations were rejected.
- Timeouts refused on unbounded builds, with the `ctk` feature pulling in
  `tokio-timeout`, rather than accepted and ignored.
- Kinds require a namespace segment; no spec-defined kinds; the allow-all
  helper is opt-in.
- One ordered `bindings` array with optional `at`, not a per-point map: it
  keeps one dispatch order rule and maps to today's registration order.
- The runner proves three-path equivalence itself on every accepted vector,
  so one vector (123) makes it visible instead of four kept in sync by a lint.
- No proposal under `docs/proposals`: the §13.3 tuple is unchanged and the
  record change is an additive optional field, which the proposals README
  exempts.
