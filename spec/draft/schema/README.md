# Schema source and generated output

This is the draft specification's schema folder, and this file is the
one to follow for editing, generating and checking schemas. Edit `src/`
here; `pnpm run generate:schema` and `pnpm run check:schema` target this
folder by default. A bundle cut from the draft keeps the copy of this
file that stood at its cut; that copy describes a frozen folder and is
never edited. 0.1 predates the source layout and has no copy. SDK
development and the Python mirror read this folder; an SDK release
names the specification versions it supports in
`SUPPORTED_SPEC_VERSIONS` (VERSIONING.md).

The TypeSpec files in `src/` are the editable schema source, with
`src/main.tsp` importing the bundle's schema sources. The generator compiles
them with `@typespec/json-schema` to JSON Schema Draft 2020-12.
`generated/` contains the committed draft JSON Schemas. Do not edit generated JSON by hand.

- Root schemas are written to `generated/*.schema.json`.
- `generated/strict-contexts/*.schema.json` contains closed per-interception-point
  request schemas derived from the `agent-context` union. Each interception
  point is explicitly defined by its `HookRequest` and `HookResponse` pair below.
- Draft response validation uses the eight hook-specific response schemas;
  there is no generic draft verdict schema because transform payloads depend
  on the interception point. The released `0.1` bundle retains its
  `verdict.schema.json`.
- Every hook response is a closed envelope with required `verdict` and optional
  namespaced `extensions`. Bare verdicts and flat verdict/extension responses
  are not accepted. The nested verdict is closed and validated for its hook;
  startup and shutdown permit only allow or deny. P-006's metadata limits and
  enforcement separation still apply, including rules enforced by parsers
  rather than JSON Schema.
- `src/host-declaration.tsp` generates the draft declaration schema.
- The P-193 draft declaration format is not yet implemented by SDK loaders or
  CTK fixtures; released 0.1 retains its existing declaration schema.
- `path-grammar.abnf` remains a hand-maintained grammar, not generated output.

## Edit, generate and check

Use Node.js 22 or later. From the repository root:

```bash
pnpm install
pnpm run generate:schema
pnpm run check:schema
pnpm run check:schema:equivalence --old <git-ref>
pnpm run check:schema:equivalence --old <git-ref> --structural-diff
```

Edit the relevant file in `src/`, regenerate, and commit source and output
together. `check:schema` compiles the TypeSpec source in memory and rejects
missing, changed or unexpected generated schemas. Equivalence checks accept
Git revisions before and after this layout change, a schema output directory,
or a `schema/` directory containing `generated/`. They compare schemas by
their stable published identities, not checkout paths.

TypeSpec expresses constraints directly rather than in TypeScript JSDoc:

```typespec
model ToolResult {
  value: unknown;
  is_error: boolean;
  @minValue(0)
  duration_ms?: float64;
}
```

Use `integer` for integer-valued fields, `float64` for fractional fields,
`JsonObject` for an open object and `unknown` for arbitrary JSON.
`@extension("additionalProperties", false)` closes only the objects the
contract closes; do not globally seal context metadata or payloads.
`@extension` also carries the record's conditional `allOf` rules and the
extension-key `propertyNames` rule.

The generator loads the installed emitter through
`spec/scripts/schema-emitter.tsp`, then imports this bundle's `src/main.tsp`.
`generate-schemas.mts` selects one public root per compilation and passes
its published ID to the native `@jsonSchema` decorator. The emitter handles
local references and embeds dependencies in `$defs`, keeping every document
self-contained without reference rewriting or custom dependency traversal.
For approval's definitions-only document, `typespec-schemas.mts` uses a
temporary model to collect the public definitions, then keeps only `$defs`
and schema identity. This preserves `#/$defs/request` and
`#/$defs/resolution`. `generate-schemas.mts` continues to derive the strict
per-point context schemas from the master union.
The old TypeScript generator and its dependencies remain only for frozen
released bundles such as 0.1. Cutting a new bundle rewrites `.tsp` wire
strings and schema identities along with the JSON.

The TypeScript SDK also generates its draft contract types from this source
with Alloy and the TypeSpec emitter framework. Run `pnpm run generate:typescript`
to regenerate schemas, `sdk/typescript/src/generated/types.ts` and the
SDK's packaged draft validation schemas together; `pnpm run check:typescript`
checks drift. Draft TypeScript requests have no `target` alias and interceptors
return hook-specific response envelopes. The shared core continues to perform
composition and transform application through its internal path/value representation.
Other SDKs have not migrated to these hook-specific request/response APIs.
The P-193 declaration loader migration remains separate: the generated
TypeScript declaration document type does not imply loader support.

JSON Schema remains the normative artifact. The Python
mirror remains versioned under `schema/0.1/` and `schema/draft/`; update
draft copies only alongside corresponding SDK changes, as described in
[Contributing](../../../CONTRIBUTING.md#schema-source).

## Filesystem paths are not public schema identities

This layout does not change validation semantics. The draft's schemas
carry `$id` values under
`https://responsibleai.github.io/agent-hooks/schema/draft/`, with per-point
schemas at `agent-context/<interception_point>.schema.json`; that path is
mutable and changes with the draft. A released version X.Y publishes under
`schema/vX.Y/`, which never changes once published. The generator sets the
base from the bundle it targets (`--spec`), and the Pages workflow publishes
each file at the path its own `$id` names, generated JSON only, never `src/`
or this README.

References resolve relative to `$id`, not to the renamed checkout directory.
Keep published identities and references unchanged when moving artifacts.
