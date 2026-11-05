# Schema source and generated output

This is the draft specification's schema folder, and this file is the
one to follow for editing, generating and checking schemas. Edit `src/`
here; `npm run generate:schema` and `npm run check:schema` target this
folder by default. A bundle cut from the draft keeps the copy of this
file that stood at its cut; that copy describes a frozen folder and is
never edited. 0.1 predates the source layout and has no copy. SDK
development and the Python mirror read this folder; an SDK release
names the specification versions it supports in
`SUPPORTED_SPEC_VERSIONS` (VERSIONING.md).

The TypeScript files in `src/` are the editable schema source.
`generated/` contains the committed, normative JSON Schemas consumed by
validators and SDKs. Do not edit generated JSON by hand.

- Root schemas are written to `generated/*.schema.json`.
- Closed per-interception-point schemas are derived from the agent-context
  union and written to `generated/strict-contexts/*.schema.json`.
  This experimental draft format is not yet implemented by SDK loaders or
  CTK fixtures; released 0.1 retains its existing declaration schema.
- `path-grammar.abnf` remains a hand-maintained grammar, not generated output.

## Edit, generate and check

From the repository root:

```bash
cd sdk/typescript
npm ci
npm run generate:schema
npm run check:schema
npm run check:schema:equivalence -- --old <git-ref> --structural-diff
```

Edit the relevant file in `src/`, regenerate, and commit source and output
together. `check:schema` type-checks the source and rejects missing, changed
or unexpected generated schemas. Equivalence checks accept Git revisions
before and after this layout change, a schema output directory, or a
a `schema/` directory containing `generated/`. They compare schemas by
their stable published identities, not checkout paths.

Refresh the Python mirror as in
[`schema-drift.yml`](../../../.github/workflows/schema-drift.yml):

```bash
cp spec/draft/schema/generated/*.schema.json sdk/python/python/agent_hooks/schema/
cp spec/draft/schema/generated/strict-contexts/*.schema.json sdk/python/python/agent_hooks/schema/agent-context/
```

Run these copy commands from the repository root after generation.
Vendoring copies only generated JSON; the Python package keeps its existing
`schema/agent-context/` resource paths. Run the schema-lint CI checks when
changing schema shapes. See [Contributing](../../../CONTRIBUTING.md#schema-source)
for source annotations and the broader SDK test matrix.

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
