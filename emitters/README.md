# TypeSpec emitters

Each folder is a TypeSpec emitter that generates one language's contracts from
`spec/draft`.

An emitter in `emitters/<lang>/`:

- is a private package named `@agent-hooks/emitter-<lang>` with a `build` script;
- is a `workspace:*` devDependency of `spec/draft/package.json`;
- is listed in `spec/draft/tspconfig.yaml` with its own `emitter-output-dir`;
- clears its output directory before writing;
- writes formatted output using Node.js only.

```yaml
emit:
  - "@agent-hooks/emitter-<lang>"
options:
  "@agent-hooks/emitter-<lang>":
    emitter-output-dir: "{project-root}/../../sdk/<lang>/<generated-dir>"
```

Run `pnpm generate` and commit the output with the source change. CI fails if
they differ.
