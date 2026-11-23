# TypeScript SDK

The TypeScript packages separate generated contracts from native runtime support:

| Package | Source | Purpose |
| --- | --- | --- |
| [`@responsibleai/agent-hooks-contracts`](packages/contracts/README.md) | `packages/contracts/` | Versioned generated contracts, with no native or runtime dependencies |
| [`@responsibleai/agent-hooks`](packages/agent-hooks/README.md) | `packages/agent-hooks/` | Native binding, handwritten SDK, and conformance runner (`./ctk`) |

Native platform packages remain under `npm/<platform>/`. Both SDK packages
are ESM. The runtime does not yet consume the new draft contracts.

The Alloy JSX emitter lives in [`emitters/typescript`](../../emitters/typescript/),
not in the SDK. `spec/draft/tspconfig.yaml` directs its output to
`packages/contracts/src/generated/draft/`. Generated files are committed;
the frozen 0.1 source is not changed or regenerated as a draft contract.

From the repository root:

```bash
pnpm install
pnpm generate
pnpm run check:generated
pnpm --filter @responsibleai/agent-hooks-contracts build
pnpm --filter @responsibleai/agent-hooks test
```

`pnpm generate` regenerates the normative JSON Schemas with the existing schema
tooling, builds the TypeScript emitter, and runs `tsp compile spec/draft`.
After building the emitter, `pnpm exec tsp compile spec/draft` can also be run
directly. The single drift check checks JSON Schemas without rewriting them
(including orphaned schemas), then regenerates TypeScript contracts and rejects
both tracked changes and untracked output files.
