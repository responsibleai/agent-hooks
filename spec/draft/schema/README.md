# Schema source and generated output

Edit the TypeSpec files in `src/` and commit them together with their
generated JSON Schemas in `generated/`. JSON Schema Draft 2020-12 remains
the normative artifact; do not edit generated JSON by hand. Frozen
`spec/0.1/` sources and artifacts are unchanged.

`src/main.tsp` imports the sources, whose public roots use `@jsonSchema`.
`@baseUri` in `common.tsp` defines the draft identity base,
and source summaries supply titles. `tspconfig.yaml` configures the native
`@typespec/json-schema` emitter. One compilation emits all public roots:

- `AgentContext.json` describes the context union.
- Eight `*Request.json` roots validate candidate requests at their hooks.
  Their required object payloads are explicitly closed in TypeSpec with
  `...Record<never>`. Request envelopes, metadata, optional payloads and
  array elements remain open. The context union and response replacement
  payloads remain open as before; candidate validation is a separate step.
- Eight `*HookResponse.json` roots validate closed response envelopes with
  required hook-specific `verdict` and optional namespaced `extensions`.
  Startup and shutdown forbid transforms.
- `ApprovalRequest.json` and `ApprovalResolution.json` are ordinary public
  roots, replacing the former `approval.schema.json` fragments.
- `InterceptionPoint.json`, `InterceptionRecord.json` and
  `HostDeclaration.json` complete the public schema graph.

Public roots reference each other by schema identity; private dependencies
are emitted in `$defs`. Consumers must register the entire generated set
before resolving roots, rather than expecting self-contained documents.
There is no per-root compilation, synthetic approval model, JSON reordering,
reference rewriting or strict-schema derivation.

## Generate and check

Use Node.js 22 or later. From the repository root:

```bash
pnpm install
pnpm run generate:schema
pnpm run check:schema
node spec/scripts/check-schema-examples.mjs
pnpm run check:schema:equivalence --old <git-ref>
pnpm run check:schema:equivalence --old <git-ref> --structural-diff
```

The generation command invokes the native CLI, equivalent to:

```bash
cd spec/scripts
pnpm exec tsp compile schema-emitter.tsp \
  --import ../draft/schema/src/main.tsp \
  --config ../draft/schema/tspconfig.yaml
```

`schema-emitter.tsp` locates the emitter installed in `spec/scripts`.
`check:schema` runs the same native compilation into a temporary directory
and compares bytes, including missing and unexpected JSON files. The wrapper
does not parse or transform emitted JSON. `--spec X.Y` selects another
TypeSpec bundle. Legacy 0.1 artifacts stay committed and are not regenerated;
attempting to generate or drift-check a bundle without TypeSpec source fails.
Equivalence checks map old and native public roots for comparison and include
the draft's actual examples among their mutation seeds.

Use `integer` for integer-valued fields, `float64` for fractional fields,
`JsonObject` (`Record<unknown>`) for open objects and `unknown` for arbitrary
JSON. Close only the objects the contract closes with `...Record<never>`.
Use native optional-property defaults such as `mode?: Mode = Mode.Enforce`;
validators do not insert defaults unless configured to do so. `@extension`
expresses conditional `allOf` and extension-key `propertyNames` rules that
the type system cannot express.

`path-grammar.abnf` remains hand-maintained. SDK implementations and their
experimental draft mirrors do not change automatically with the spec.
Update draft mirrors only alongside matching SDK behavior changes; mirror
drift remains advisory. See [Contributing](../../../CONTRIBUTING.md#schema-source).

## Schema identities and releases

Draft identities use
`https://responsibleai.github.io/agent-hooks/schema/draft/<Type>.json`.
These mutable identities intentionally replace the old kebab-case
`.schema.json` paths and approval fragments. Consumers should select native
root names, not rewrite documents to retain the old pointers.

A version cut rewrites the TypeSpec base URI and wire strings along with
the JSON to `schema/vX.Y/` and `agent-hooks/X.Y`. Published release artifacts
are immutable. Pages publishes each JSON file at its `$id`, independently
of its physical filename.

The identity hash's required+conditional projection remains a separate
normative whitelist (§10.1), implemented explicitly in the runtime. Neither
open metadata nor the request schemas' optional fields widen that projection.
