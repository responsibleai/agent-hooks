# TypeSpec emitters

Each folder here is a TypeSpec emitter that generates one language's
contracts from the draft specification source. `pnpm generate` builds every
emitter, then compiles `spec/draft/main.tsp` once with every emitter listed in
`spec/draft/tspconfig.yaml`.

An emitter in `emitters/<lang>/`:

- is a private workspace package named `@agent-hooks/emitter-<lang>`;
- has a `build` script that `pnpm build:emitters` runs before generation;
- is a `devDependency` (`workspace:*`) of the root `package.json`, so the
  compiler resolves it from `spec/draft`;
- is registered in `spec/draft/tspconfig.yaml` under `emit` with an explicit
  `emitter-output-dir`;
- empties that directory at the start of `$onEmit`, so output for a removed
  type never lingers:

  ```ts
  export async function $onEmit(context: EmitContext) {
    if (context.program.compilerOptions.noEmit) return;
    // host.rm throws ENOENT when the directory does not exist yet.
    await context.program.host.rm(context.emitterOutputDir, { recursive: true }).catch(() => {});
    // ...write the generated files
  }
  ```

The output directory holds only generated files. Commit them with the source
change that produced them.

```yaml
emit:
  - "@typespec/json-schema"
  - "@agent-hooks/emitter-<lang>"
options:
  "@agent-hooks/emitter-<lang>":
    emitter-output-dir: "{project-root}/../../sdk/<lang>/<generated-dir>"
```

## Drift check

Each language checks its own output in its SDK's CI job, so a broken emitter
or a missing toolchain blocks only that language:

```bash
pnpm --filter @agent-hooks/emitter-<lang> run build
pnpm exec tsp compile spec/draft --emit @agent-hooks/emitter-<lang>
# run the language's formatter on the output, if any
git diff --exit-code && test -z "$(git status --porcelain)"
```

The `schema-drift` workflow checks the JSON Schemas the same way with
`--emit @typespec/json-schema`.
