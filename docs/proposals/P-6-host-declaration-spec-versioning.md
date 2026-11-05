# P-6: Version host declarations with the specification

- **Status:** Draft
- **Created:** 2026-11-05
- **Author(s):** @CaitieM20
- **PR:** https://github.com/CaitieM20/agent-hooks/pull/6

## Abstract and motivation

A host declaration selects deployment configuration for controls already
registered in code. Today it selects both a specification version and an
independent declaration version, while the specification determines which
declaration versions are supported. Each spec bundle also publishes its own
declaration schemas. The extra selector therefore adds a compatibility
matrix without independently identifying a validator.

This experiment makes the declaration format part of the specification.
`spec` selects its syntax, defaults and behavior, just as it selects the
hook contracts. SDK package versions remain independent.

## Proposed contract

Remove `declaration` and `surface.declaration_versions`. Publish one
`host-declaration.schema.json` per specification bundle. Reject removed
fields rather than silently migrating documents. The draft permits
`on_error`, with `deny` when omitted.

Before (existing draft format):

```json
{
  "spec": "agent-hooks/draft",
  "declaration": "agent-hooks-declaration/1.1",
  "surface": {
    "declaration_versions": ["agent-hooks-declaration/1.0", "agent-hooks-declaration/1.1"]
  },
  "bindings": []
}
```

After (proposed draft format):

```json
{
  "spec": "agent-hooks/draft",
  "configuration": {"failure": {"on_error": "deny"}},
  "bindings": []
}
```

An empty binding list remains a fail-closed configuration, not an allow-all
policy. Remove the optional `declaration` field from interception records
entirely; the existing `spec` still identifies their contract. Records no
longer distinguish file-configured from code-configured emitters.

## Options and rationale

| Option | Benefit | Cost |
| --- | --- | --- |
| Independent declaration version (today) | Configuration formats can evolve separately; a draft host can explicitly accept 1.0 and 1.1 documents. | Two selectors, supported-pair tables, migrations and spec-specific copies of the same declaration version. |
| Spec-versioned declaration (experiment) | One compatibility selector and one schema per spec; configuration and hook semantics cannot select incompatible versions. | A declaration-format change requires a spec revision; legacy documents need migration. |

The experiment favors the second option for review, not as an accepted
decision. A host can add support for a new spec while retaining a file that
selects the old one. Running the new spec requires changing `spec`, even
when no configuration values change. Rolling upgrades still work through
explicit support for multiple specification versions. The mutable draft
is not an immutable compatibility promise.

## Backward compatibility and operations

This is a breaking document and record change. Released spec 0.1 remains
untouched, including its declaration 1.0 schema. For migration to the new
draft, remove the two declaration-version fields and select the intended
spec explicitly. Absence of `on_error` preserves deny behavior; it does
not opt into continuation. Old loaders reject the new document; operators
must upgrade the implementation before deploying it.

## Security and privacy

Registry-only resolution, closed fields, fixed resource bounds, refusal
before emitter construction, fail-closed defaults and sealing remain
unchanged. Configuration does not load code or widen the host's surface.
Removing the record marker loses configuration-origin visibility; retain
the existing startup configuration label/digest logging, not wire payloads.

## SDK surface and implementation impact

This PR changes the normative draft, schema sources, generated schemas and
examples only. Existing SDK loaders, builders, declaration constants,
migration routines, FFI, Python mirrors and CTK fixtures still implement
the previous format. They require coordinated follow-up across all five
SDKs before this draft can be exercised or claimed. Inventory checks and
CTK schema validation against the old draft references can fail meanwhile;
this experiment does not disable those checks.

## Conformance and tests

Schema checks cover a required draft `spec`, rejection of removed fields,
optional `on_error`, and removal of the record field. Released 0.1 schemas
and examples must regenerate unchanged. Follow-up runtime coverage must
pin unsupported spec errors, registry refusal, sealing, equivalent
construction paths and migration rollout. No runtime conformance is
claimed by this experimental PR.
