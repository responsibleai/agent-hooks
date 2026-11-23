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
- marks that directory `linguist-generated` in the root `.gitattributes`
  (`sdk/<lang>/<generated-dir>/** linguist-generated`).

The output directory holds only generated files. The `drift` check deletes
every `linguist-generated` file, runs `pnpm generate`, then fails on any
changed, new or deleted file, so output a removed type no longer produces is
caught. Commit the generated output with the source change that produced it.

```yaml
emit:
  - "@typespec/json-schema"
  - "@agent-hooks/emitter-<lang>"
options:
  "@agent-hooks/emitter-<lang>":
    emitter-output-dir: "{project-root}/../../sdk/<lang>/<generated-dir>"
```
