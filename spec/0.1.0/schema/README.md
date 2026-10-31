# Schema source and generated output

This is the released 0.1.0 schema folder. It is immutable: change schema
shapes in [`spec/draft/schema/src/`](../../draft/schema/src/) instead. SDKs
and the Python mirror are pinned to this folder for now.

The TypeScript files in `src/` are the editable schema source.
`generated/` contains the committed, normative JSON Schemas consumed by
validators and SDKs. Do not edit generated JSON by hand.

- Root schemas are written to `generated/*.schema.json`.
- Closed per-interception-point schemas are derived from the agent-context
  union and written to `generated/strict-contexts/*.schema.json`.
- `src/host-declaration.ts` generates both supported declaration schemas.
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
cp spec/0.1.0/schema/generated/*.schema.json sdk/python/python/agent_hooks/schema/
cp spec/0.1.0/schema/generated/strict-contexts/*.schema.json sdk/python/python/agent_hooks/schema/agent-context/
```

Run these copy commands from the repository root after generation.
Vendoring copies only generated JSON; the Python package keeps its existing
`schema/agent-context/` resource paths. Run the schema-lint CI checks when
changing schema shapes. See [Contributing](../../../CONTRIBUTING.md#schema-source)
for source annotations and the broader SDK test matrix.

## Filesystem paths are not public schema identities

This layout does not change validation semantics, `$id`, or public URLs.
Published schemas remain under
`https://responsibleai.github.io/agent-hooks/schema/v0.1/`, with per-point
schemas at `agent-context/<interception_point>.schema.json`.
The Pages workflow copies `generated/strict-contexts/` to that existing
`agent-context/` URL path, and publishes only generated JSON, never `src/`
or this README.

References resolve relative to `$id`, not to the renamed checkout directory.
Keep published identities and references unchanged when moving artifacts.
