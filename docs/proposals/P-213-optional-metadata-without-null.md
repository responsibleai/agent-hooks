# P-213: Omit absent metadata instead of sending null

- **Status:** Draft
- **Created:** 2026-11-18
- **Author(s):** Timothee Guerin (@timotheeguerin)
- **PR:** https://github.com/responsibleai/agent-hooks/pull/213

## Abstract and motivation

The draft schemas accept both omission and explicit `null` for verdict
metadata, although `null` has no specified meaning for those members.
For example, `warnings: null` is accepted by the schema even though
§5 requires an array when `warnings` is present. This predates the
TypeSpec conversion; the old TypeScript sources explicitly allowed it.

Use omission for absent metadata and require the documented type when
present. Retain `null` wherever the specification gives it a meaning.

## Specification

In §5, remove explicit nullability, without making members required, from:

- Verdict `reason`, `message`, `warnings`, and `result_labels`.
- Warning `reason` and `message`.
- Evidence `artefact`.

Apply the same constraints to the payload-free verdict and warning
projections and per-interceptor `reason` in §10.3. Make `resolved_by`
optional-only as well: §10.3 already says to omit it when approval was
never consulted; otherwise it is `"approval"` or `"rejection"`.

An interceptor-supplied verdict with explicit `null` in these members is
invalid under §5 and follows the existing `host_error:verdict_invalid`
failure path and configured §6.3.1 posture. Do not silently normalize
invalid nulls into omission. A host must omit absent metadata from records.

The normative schema changes are in
[`verdict.tsp`](../../spec/draft/schema/src/verdict.tsp) and
[`interception-record.tsp`](../../spec/draft/schema/src/interception-record.tsp).
Regenerated hook responses, approval definitions and interception records
inherit the narrower types.

Proposed wire examples:

```jsonc
{"verdict": {"decision": "allow"}}                    // valid: omitted
{"verdict": {"decision": "allow", "warnings": []}}    // valid: declared type
{"verdict": {"decision": "allow", "warnings": null}}  // invalid
```

Identity and approval `context_identity` nulls remain valid, as do
`decided_by: null`, unbounded configuration values, nullable registry
references and arbitrary JSON payload values. Requiredness does not change.

## Rationale

Keeping both representations preserves compatibility but leaves consumers
handling an extra state with no defined purpose. Removing all `null`
unions would instead erase meaningful states, such as an explicitly
unbounded timeout versus an omitted timeout that inherits a default.
This proposal removes only redundant nullability.

## Backward compatibility

This narrows accepted verdict and record shapes, a specification MAJOR
change under [VERSIONING.md](../../VERSIONING.md). It is not a
conversion-only correction. Released 0.1 sources, schemas, conformance
vectors and SDK behavior remain unchanged.

When upgrading to this draft, producers must omit absent metadata rather
than serialize it as `null`. Old consumers already accept omission.
Consumers implementing the new draft reject explicit null metadata.

## SDK surface and implementation impact

This review PR changes the specification, schema sources, generated draft
schemas and schema regression coverage only. It does not update SDK
runtime behavior or packaged draft schemas. Draft support is experimental
and already lags the normative draft; follow-up implementation must apply
the new validation and omission rules in the Rust core and all five SDKs
without changing released 0.1 behavior.

## Conformance and tests

Schema regression cases cover omitted metadata, correctly typed metadata,
explicit nulls on verdicts and their record projections, and `resolved_by`.
Records with meaningful null identities and `decided_by` remain valid.
Existing declaration examples retain meaningful null configuration values.
Shared CTK runtime coverage must accompany the SDK implementation follow-up;
this PR does not claim that existing SDKs enforce the new draft.

## Security and privacy

Trust boundaries, approval binding, payload-free projection and resource
bounds are unchanged. Invalid verdicts retain the existing failure path;
the change does not add a permissive fallback or allow null metadata to
bypass type validation.
