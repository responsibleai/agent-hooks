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

## C# contract generation

`spec/draft/main.tsp` imports this source and drives the experimental,
Rust-independent `sdk/csharp/src/AgentHooks.Contracts/` assembly. From the repository root, run
`pnpm generate` and commit the generated `Generated/Draft/Models.g.cs` and `Generated/Draft/Hooks.g.cs`
alongside source changes. CI cleans both output directories, runs `pnpm generate`,
and requires a clean `git status --porcelain`, catching missing, stale and
untracked generated files. Do not edit the generated C# by hand.
This targets the draft only, not the frozen 0.1 bundle or the existing Rust-backed .NET SDK.

`spec/draft/tspconfig.yaml` loads the `@agent-hooks/emitter-csharp` workspace
package. Its `emitters/csharp/src/emitter.tsx` uses `@typespec/emitter-framework` for
TypeSpec context, model/enum declarations, properties, documentation and type
references. Only declarations reachable from `@jsonSchema` roots or hook
operations are emitted; spread-only helpers do not become standalone contracts.
Optional properties map to C# nullable types and are omitted when
null. Optional nullable unions use `Optional<T?>`, and optional `unknown` uses
`Optional<JsonElement>`, so an absent member stays distinct from explicit JSON
null where the wire contract permits it. Optional literal properties validate
their value when present while remaining omittable. Component overrides also
preserve literal wire values, arbitrary JSON, and unbounded integers. Raw
`@alloy-js/csharp` components supply discriminated-union interfaces/converters,
dictionary models and extension-data members not covered by the framework.
`json-components.tsx` shares converter declarations, converter attributes and
dictionary initializers between enum and union emission.
`operation-handler.tsx` maps the logical operations below to independent async
C# delegates: one hook handler per request/response pair and an
`ApprovalResolverHandler`. Each accepts its typed request and an optional
cancellation token and returns a `Task` of the declared response. The
pairings come from TypeSpec operations, not a second hand-maintained hook table;
no aggregate interceptor interface or runtime dispatcher is generated.
These types preserve wire shapes; they do not replace JSON Schema validation
of specification constraints.

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
