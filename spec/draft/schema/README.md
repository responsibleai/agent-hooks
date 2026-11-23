# Schema source and generated output

Edit the TypeSpec files in `src/` and commit them together with their
generated JSON Schemas in `generated/`. JSON Schema Draft 2020-12 remains
the normative artifact; do not edit generated JSON by hand. Frozen
`spec/0.1/` sources and artifacts are unchanged.

`src/main.tsp` imports the sources, whose public roots use `@jsonSchema`.
`@baseUri` in `common.tsp` defines the draft identity base,
and source summaries supply titles. `spec/draft/main.tsp` and
`spec/draft/tspconfig.yaml` compile this source once for every draft output,
including the native `@typespec/json-schema` emitter that writes
`generated/`. One compilation emits all public roots:

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
pnpm generate
node spec/scripts/check-schema-examples.mjs
pnpm run check:schema:equivalence --old <git-ref>
pnpm run check:schema:equivalence --old <git-ref> --structural-diff
```

`pnpm generate` builds every package under `emitters/`, then runs the native
CLI, `tsp compile spec/draft`; nothing parses or transforms emitted JSON.
`tsp compile spec/X.Y` regenerates a released TypeSpec bundle. `generated/`
is marked `linguist-generated` in `.gitattributes`: the `drift` check deletes
every such file before regenerating, then fails on any changed, new or
deleted file and prints the diff. Legacy 0.1 artifacts stay committed and are
not regenerated; that bundle has no `main.tsp` to compile.
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

## Logical operations

`src/operations.tsp` describes the request/response pairings from the
[interceptor contract (§7) and approval seam (§9)](../AGENT-HOOKS-DRAFT.md)
as transport-neutral TypeSpec interfaces:

- `Interceptor` has one operation per interception point: `agentStartup`,
  `input`, `preModelCall`, `postModelCall`, `preToolCall`, `postToolCall`,
  `output`, and `agentShutdown`. Each takes its hook-specific request and
  returns the matching hook response envelope.
- `ApprovalResolver.resolve` takes `ApprovalRequest` and returns
  `ApprovalResolution`, including approve, reject, and unresolved outcomes.

These are logical calls from the host, not HTTP endpoints or a new SDK
interface requirement. An interceptor remains the callable described in
§7; the operation names do not change the wire `interception_point` values.
Transport, authentication, and remote service bindings remain implementation
concerns. The operations add no streaming protocol and do not change the
generated JSON Schemas. Timing, composition, enforcement, approval echo
validation, and failure handling remain governed by the specification.

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
