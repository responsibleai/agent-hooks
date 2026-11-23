# TypeSpec emitters

Each folder here is a TypeSpec emitter that generates one language's
contracts from the draft specification source. `pnpm generate` builds every
emitter, then builds the `spec/draft` workspace package, which compiles
`spec/draft/main.tsp` once with every emitter listed in
`spec/draft/tspconfig.yaml`.

An emitter in `emitters/<lang>/`:

- is a private workspace package named `@agent-hooks/emitter-<lang>`;
- has a `build` script;
- is a `devDependency` (`workspace:*`) of `spec/draft/package.json`, so
  `pnpm generate` builds it before the spec and the compiler resolves it from
  `spec/draft`;
- is registered in `spec/draft/tspconfig.yaml` under `emit` with an explicit
  `emitter-output-dir`;
- writes final, formatted output with Node.js alone: no language toolchain
  or external formatter runs during generation, so one drift check covers
  every language;
- empties its `emitter-output-dir` at the start of `$onEmit`, so output for a removed
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

The `schema-drift` workflow checks every draft output at once:

```bash
pnpm generate
pnpm check:changes
```

On a checkout, `pnpm check:changes` fails on any changed, new or deleted
file and prints the diff, so it reports output that was not regenerated and
committed with its source.
