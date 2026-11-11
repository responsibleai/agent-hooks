# P-193: Version host declarations with the specification

- **Status:** Accepted
- **Created:** 2026-11-05
- **Author(s):** Caitie McCaffrey (@CaitieM20)
- **PR:** https://github.com/responsibleai/agent-hooks/pull/193

## Abstract & Motivation
A `HostDeclaration` selects deployment configuration for controls already
registered in code. Today it is versioned separately from the specification, 
and a separate HostDeclaration to spec version compatibility matrix is maintained. 
This adds additional complexity and maintenance costs for an optional feature that 
has limited to no adoption, and no clear user scenario for versioning independently.

This proposal removes the independent `HostDeclaration` version, and instead has it's version
coupled to the spec version. 

## Specification

The substantive changes to [the draft specification](../../spec/draft/AGENT-HOOKS-DRAFT.md)
are:

- **Version selection and compatibility (former §7.7.2; §7.7.1, §7.7.3):**
  remove the independent declaration major/minor contract, its accepted-version
  APIs and mandatory per-version migration machinery.
- **Members and surface (§7.7.3, §7.7.4):** remove top-level `declaration`,
  `surface.declaration_versions` and the requirement that the surface's
  accepted set include the document's declaration version. 
- **Resolution and binding context (§7.7.3, §7.7.5):** resolve defaults to
  the selected specification's shape, retaining its `spec`; pass the selected
  specification version to kind resolvers. 
- **Loader refusals (§7.7.6):** remove `declaration_error:version_unsupported`,
  reducing the refusal vocabulary from eleven classes to ten. Check `spec`
  immediately after reading and parsing, before unknown-field and value
  validation; `spec_unsupported` carries the supported specification set.
- **Records and operational logging (§7.7.8, §10.3):** remove the record's
  `declaration` marker, so records no longer identify configuration origin.
  Their existing `spec` identifies the contract; load-time logging uses the
  selected specification version alongside the document label and digest,
  outside the record stream.
- **Remove Declaration-Versions.md** no longer necessary since declaration version and
  spec version are the same. 

## Schema and wire impact

Remove `declaration` and `surface.declaration_versions`.
Publish one `host-declaration.schema.json` per specification bundle. Reject removed
fields rather than silently migrating documents.

Current Format:

```json
{
  "spec": "agent-hooks/draft",
  "declaration": "agent-hooks-declaration/1.1",
  "surface": {
    "buffered_output": true,
    "declaration_versions": ["agent-hooks-declaration/1.0", "agent-hooks-declaration/1.1"]
  },
  "bindings": []
}
```

Proposed Format:

```json
{
  "spec": "agent-hooks/draft",
  "surface": {
    "buffered_output": true
  },
  "bindings": []
}
```

An empty binding list remains a fail-closed configuration, not an allow-all
policy. Remove the optional `declaration` field from interception records
entirely; the existing `spec` still identifies their contract. Records no
longer distinguish file-configured from code-configured emitters.

### Recommended normative semantics

The draft text in §7.7.3, §7.7.6 and §7.7.8 carries these rules; this
section summarizes them.

1. **`spec` is checked first among members.** A loader reads and parses
   the document (§7.7.6 steps 1–2), then checks `spec` (step 3) before
   unknown-member validation (step 4) and value validation (step 5). A
   missing, non-string or unsupported `spec` is refused as
   `declaration_error:spec_unsupported`, and the error carries the set of
   specification versions the loader accepts.
2. **Removed fields are refused, never migrated.** A document carrying
   `declaration` or `surface.declaration_versions` is refused as
   `declaration_error:unknown_field`. A loader does not silently drop or
   translate them.
3. **The selected spec defines the shape.** The accepted declaration
   members, defaults and value domains are exactly those the named
   specification version defines; there is no second selector.

## Rationale

| Option | Benefit | Cost |
| --- | --- | --- |
| Independent declaration version (today) | Configuration formats can evolve separately; a draft host can explicitly accept 1.0 and 1.1 documents. | Two selectors, supported-pair tables, migrations and spec-specific copies of the same declaration version. |
| Spec-versioned declaration (proposed) | One compatibility selector and one schema per spec; configuration and hook semantics cannot select incompatible versions. | A declaration-format change requires a spec revision; legacy documents need migration. |

This proposal recommends the second option. Its status is Draft: the
change lands in `spec/draft/` for review, and acceptance is recorded
through the proposal lifecycle ([README](README.md#lifecycle)). A host can add support for a new spec while retaining a file that
selects the old one. Running the new spec requires changing `spec`, even
when no configuration values change. Rolling upgrades still work through
explicit support for multiple specification versions. The mutable draft
is not an immutable compatibility promise.

## Backward compatibility and operations

This is a breaking document and record change. Released spec 0.1 remains
untouched, including its declaration 1.0 schema. Migration to the new
draft is one edit: delete `declaration` and `surface.declaration_versions`,
and keep `spec` (see the Current and Proposed examples above). Absence of `on_error` preserves deny behavior; it does
not opt into continuation. Old loaders reject the new document; operators
must upgrade the implementation before deploying it.

## Security and privacy

Registry-only resolution, closed fields, fixed resource bounds, refusal
before emitter construction, fail-closed defaults and sealing remain
unchanged. Configuration does not load code or widen the host's surface.
Removing the record marker loses configuration-origin visibility; retain
the existing startup configuration label/digest logging, not wire payloads.
If origin visibility on the record is needed later, an optional
`configuration.source` string would be an additive change; it is not a
reason to keep a separate declaration version.

## SDK surface and implementation impact

This PR changes the normative draft, schema sources, generated schemas and
examples only. Existing SDK loaders, builders, declaration constants,
migration routines, FFI, Python mirrors and CTK fixtures still implement
the previous format. They require coordinated follow-up across all five
SDKs before this draft can be exercised or claimed. Inventory checks and
CTK schema validation against the old draft references can fail meanwhile;
this proposal does not disable those checks.

## Conformance and tests

Schema checks cover a required draft `spec`, rejection of removed fields,
optional `on_error`, and removal of the record field. Released 0.1 schemas
and examples must regenerate unchanged. Follow-up runtime coverage must
pin unsupported spec errors, registry refusal, sealing, equivalent
construction paths and migration rollout. No runtime conformance is
claimed by this proposal's PR.
