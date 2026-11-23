# Python contract emitter

`@agent-hooks/python-emitter` is a TypeSpec emitter package using Alloy Python
and the TypeSpec emitter framework. SDKs receive committed output, not emitter
code or Node.js dependencies.

`spec/draft/tspconfig.yaml` selects this emitter and directs its output to the
standalone Python contracts distribution's `generated/draft/` module. The
emitter uses the compiler's checked program and configured output directory;
it does not compile another copy of the specification or choose a spec version.

From the repository root, install workspace dependencies with `pnpm install`,
then run (no Python tooling is needed for generation):

```bash
pnpm generate
pnpm check:generated
```

For direct compiler use after building the emitter:

```bash
pnpm --filter @agent-hooks/python-emitter build
pnpm exec tsp compile spec/draft
```

This emits Python 3.10-compatible TypedDicts and literal unions, preserving
source documentation and concrete template/anonymous-model names. Declarations
are ordered by dependency so references are real runtime types. Only the
self-recursive `JsonValue` alias needs quoted forward references. Runtime
validation and existing SDK behavior are outside the emitter's scope.

Run `pnpm --filter @agent-hooks/python-emitter test` for the inline TypeSpec
regressions. The generated Python is checked against Ruff 0.15.21 in Python CI;
the emitter itself neither shells out nor rewrites compiler-host output.
