# Contributing

## Ground rules

- **Sign-off (DCO).** Every commit carries `Signed-off-by`
  (`git commit -s`), certifying the
  [Developer Certificate of Origin](https://developercertificate.org/).
- **Proposals first** for contract-level changes: see
  [docs/proposals/README.md](docs/proposals/README.md) for the change
  classes that require a written proposal before implementation.
- **Everything lands by PR.** `main` is protected: required status
  checks across all five SDKs plus schema-drift and CodeQL, linear
  history (rebase merges), no force pushes.

## What a PR must include

- **Tests for behavior.** New or changed normative behavior needs CTK
  vectors (`conformance/<version>/vectors/`) or per-SDK tests — cross-SDK
  semantics belong in vectors so all five implementations are pinned
  at once.
- **Spec and schema together.** Make normative changes in
  `spec/draft/`. Changes to wire shapes update the draft spec text and
  the schema source under `spec/draft/schema/src/`, then regenerate the
  JSON under `spec/draft/schema/generated/` (see [Schema source](#schema-source));
  the `drift` check requires generated spec schemas and released SDK
  copies to match their sources. SDK draft-copy drift is advisory.
  Released folders such as `spec/0.1/`
  are immutable; see [spec/README.md](spec/README.md).
- **The SDKs support 0.1 and the draft side by side.**
  `SUPPORTED_SPEC_VERSIONS` is `["0.1", "draft"]` in every core; the
  Rust tests, the `drift` mirror copy and
  `scripts/check-version-consistency.py` read every supported bundle,
  and CI steps that check schemas and vectors loop over every bundle. A
  breaking draft change leaves 0.1 alone. SDK draft support is experimental
  and may lag the latest specification draft; update its packaged schemas
  together with the matching implementation, not independently. A host
  reaches it by naming `agent-hooks/draft`. Prose links cite the
  released text, `spec/0.1/`, and the draft for what 0.1 does not
  define.
- **The gating tests target the newest released version.** Each
  reference suite runs the released set of vectors under 0.1 and skips
  the 17 draft-only vectors (`introduced_in: draft`) with the reason
  `draft-only vector; see #188`. Those vectors and the SDK tests that
  read draft-only files (the draft's inventories, examples and schemas)
  run in the advisory `draft-tests` job, never in a required one, so a
  draft change cannot turn a required check red. Mark such a test the
  way its suite filters: a `draft_only_` name prefix in Rust
  (`cargo test -- --skip draft_only`), the `draft` pytest marker
  (`-m "not draft"`), a file under `sdk/typescript/test/draft/`,
  `[Trait("Category", "draft")]` in .NET (`--filter "Category!=draft"`),
  a `TestDraftOnly` name prefix in Go (`-skip DraftOnly`). The local
  commands below run both sets. Binding tests to a draft revision is
  #188.
- **All five SDKs.** A contract change is not done until Rust core,
  Python, TypeScript, .NET, and Go agree. Python, TypeScript, and Go
  delegate primitives to Rust; C# implements them natively. Shared
  golden fixtures and conformance vectors pin cross-language behavior.

## Node.js tooling

Use Node.js 22 or later and pnpm at the version pinned in the root
`package.json` (`npm install --global pnpm@12.21.0` if needed). From
the repository root, run `pnpm install` once for the workspace. Commit
dependency updates in the root `pnpm-lock.yaml`. CI uses `.github/actions/setup`
to configure Node.js 26.13.1, the pinned pnpm version, and caching, then
installs with `pnpm install --frozen-lockfile`.
The manifests under `sdk/typescript/npm/` are release-only native-binary
packages, not development workspaces. Publishing still uses npm.

## Documentation site

With a current Node.js 22 release or newer, run
`pnpm --filter @agent-hooks/docs dev` and open `/agent-hooks/` at the
address Astro prints. Edit site pages under `docs-site/src/content/docs/`.
The specification pages and schema URLs come straight from `spec/` and
`conformance/` (`docs-site/src/spec.ts`); run
`pnpm --filter @agent-hooks/docs test` after changing it. To preview the
same build GitHub Pages deploys, run `pnpm --filter @agent-hooks/docs build`
and then `pnpm --filter @agent-hooks/docs preview`. The artifact is `docs-site/dist/`.

## Schema source

Each specification folder's JSON Schemas under `spec/<version>/schema/generated/`
are generated from TypeSpec in `spec/<version>/schema/src/`, except for
the frozen 0.1 bundle, whose committed artifacts and historical TypeScript
source are retained without regeneration. Edit
only `spec/draft/schema/src/`. The `drift` job checks the draft; the `lint`
job runs `tsp compile spec/<version> --emit @typespec/json-schema` for every
released bundle that has a `main.tsp`, so a frozen TypeSpec source keeps
generating its frozen output. The JSON stays the normative artifact: it is
what validators, the conformance kit and the SDK mirrors consume. Do not
edit it by hand; the `lint` and `drift` checks fail on any byte that
differs from the generated text.

- Draft payload sources are TypeSpec models, enums, scalars and unions:
  `agent-context.tsp`, `verdict.tsp`, `hook-responses.tsp`, `approval.tsp`,
  `interception-record.tsp`, `host-declaration.tsp`, plus shared types.
  `operations.tsp` pairs the existing requests and responses in transport-neutral
  interceptor and approval-resolver interfaces; it does not define HTTP routes.
  `schema/src/main.tsp` imports the bundle's sources; public roots use `@jsonSchema`.
  One native compilation emits the whole schema graph:
  public roots reference sibling documents and private dependencies use `$defs`.
  `@typespec/json-schema` emits Draft 2020-12 directly. It is a dependency
  of `spec/draft/package.json` and, for the released bundles, of the
  repository root. Use Node.js 22 or later for this tooling.
- Use `integer` for integer fields and `float64` for fractional values,
  `@minValue`/`@maxValue` for numeric bounds, and `@pattern`, `@format`,
  `@minLength`, `@maxLength`, `@minItems`, `@maxItems` and `@uniqueItems`
  for other constraints. Optional properties use `?`; nullable values
  explicitly include `| null`. Close individual models with
  `...Record<never>`, not global object sealing. Use `Record<unknown>` for
  explicitly open objects.
- A rule one member decides is a discriminated union: verdicts by
  `decision`, agent contexts by `interception_point`, approval
  resolutions by `outcome`, the declared surface by `buffered_output`.
  A rule the type system cannot state is JSON Schema in
  `@extension("allOf", #[...])`; extension namespace keys use
  `@extension("propertyNames", #{...})`. Defaults remain schema annotations
  through native property defaults (`property?: Type = value`), not runtime
  default insertion.
- `spec/draft/main.tsp` and `spec/draft/tspconfig.yaml` are the single
  compilation entry point for every draft output: the native JSON Schema
  emitter and any language emitter under `emitters/`
  ([emitters/README.md](emitters/README.md)). `spec/draft` is a private
  workspace package, `@agent-hooks/spec-draft`, that depends on every
  emitter; `pnpm generate` runs its `build` script after the emitters'.
  Public roots, titles and the schema base URI live in TypeSpec source.
  Output is unmodified native `generated/<Type>.json`, including
  `ApprovalRequest.json` and `ApprovalResolution.json`, not approval fragments.
  Per-hook `*Request.json` models explicitly close required object payloads;
  the `AgentContext` union, request metadata, array elements and response
  replacements retain their open shapes. Identity hashing still uses its
  separate required-field projection, not schema-driven object sealing.
  There is no legacy TypeScript generator; 0.1 schemas remain committed and immutable.

```bash
pnpm install
pnpm build                    # build every workspace package in dependency order (needs Rust for sdk/typescript)
pnpm generate                 # only emitters/* and spec/draft: regenerate every draft output
pnpm check-for-changed-files  # fail if the working tree has changes, as CI does after generating
pnpm run check:schema:equivalence --old origin/main   # differential validation against another revision
```

Every generated folder is rebuilt from scratch, so output for a removed type
disappears: each language emitter empties its own output folder, and the
`spec/draft` build clears `spec/draft/schema/generated/` (the JSON Schema
emitter never deletes) before compiling. The `drift` job runs
`pnpm generate && pnpm check-for-changed-files`, which checks every draft output.

After a change, regenerate. The Python mirror holds one folder per
supported specification version (`sdk/python/python/agent_hooks/schema/0.1/`
and `schema/draft/`). Legacy mirrors keep per-point schemas under
`agent-context/`; native mirrors retain the emitter's filenames. The `schema-drift`
workflow runs `spec-draft-generated-schema-check`,
`python-released-schema-mirror`, and `python-ctk-vector-mirror` as
separate hard checks. `python-draft-schema-mirror` regenerates the draft
and reports mirror differences as warnings; comparison errors still fail.
The mirror checks use focused scripts in `sdk/python/scripts/`; the
aggregate status check is inline in the workflow.
The required `drift` job aggregates all four and fails if any job fails,
is cancelled, or is skipped. Keep `drift` required in branch protection;
the individual checks may additionally be required, but no settings change
is needed for the split. Every check runs on every pull request.
Commit draft source and generated JSON together, but
refresh the SDK draft mirror only when its implementation is updated to
match. When a shape changes, also run
the `schema-lint` steps from `.github/workflows/ci.yml` (ajv compiles
every schema and validates the vectors) and the equivalence script
against `origin/main` to see which instances change verdict.

See [`spec/draft/schema/README.md`](spec/draft/schema/README.md) for the layout and
the mapping to unchanged published URLs.

## Local toolchain setup

With [mise](https://mise.jdx.dev/) installed, run from the repository root:

```bash
mise trust
mise install
```

Activate mise in your shell, or prefix commands with `mise exec --`.
The root `mise.toml` pins Node.js, Python, Go and the .NET SDK to patch
releases within the versions used by CI, plus `uv`. Rust matches
`sdk/rust/rust-toolchain.toml`, including Clippy and rustfmt; update both
pins together. These tools do not replace the per-SDK dependency
installation steps below or a native C/C++ toolchain for FFI and cgo.
The protected Windows FFI build still uses its separate pinned nightly.

## Local test matrix

```bash
# Rust core + FFI
cd sdk/rust && cargo test --workspace --all-features && cargo clippy --workspace -- -D warnings
# Python (rebuild bindings when core changed)
cd sdk/python && maturin develop --release && python -m pytest tests/ && ruff check
# TypeScript (rebuild native when core changed)
pnpm install && pnpm --dir sdk/typescript test
# .NET (managed-only; no Rust build required)
cargo build --release --manifest-path sdk/rust/Cargo.toml -p agent-hooks-ffi
cd sdk/csharp && dotnet test
# Go
cd sdk/go && CGO_ENABLED=1 go test ./...
```

For the protected Windows x64 FFI release, follow the
[Windows build instructions](RELEASING.md#windows-ffi-hardening).
That artifact needs a pinned nightly compiler and a rebuilt, stack-protected
standard library; a plain stable FFI build is not equivalent.

## Style

- Fail closed; never normalize values (§4.4 — reject with an
  actionable message instead).
- Spec-section references in doc comments (`§7.4`, `§10.3`).
- Commit messages and PR bodies: concise, factual, imperative subject.
- Every source file starts with `Copyright (c) Microsoft. All rights
  reserved.` in the language's line-comment style, then a blank line;
  a shebang stays first. `python3 scripts/check-file-headers.py` is
  the CI check (`lint` job).

## Reporting security issues

Privately, per [SECURITY.md](SECURITY.md) — not via public issues.
