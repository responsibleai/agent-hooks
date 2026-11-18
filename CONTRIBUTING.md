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
  Python, TypeScript, .NET, and Go agree; the Rust core is the single
  source of truth and the wrappers delegate to it.

## Schema source

Each specification folder's JSON Schemas under `spec/<version>/schema/generated/`
are generated from the source in `spec/<version>/schema/src/`: TypeSpec
in the draft, and the original TypeScript in the frozen 0.1 bundle. Edit
only `spec/draft/schema/src/`; the generator targets `draft` unless
`--spec <version>` names another folder. The `lint` job runs the drift
check for the draft and, with `--spec`, for every released bundle that
has `schema/src/`, so a frozen source keeps generating its frozen
output. The JSON stays the normative artifact: it is
what validators, the conformance kit and the SDK mirrors consume. Do not
edit it by hand; the `lint` and `drift` checks fail on any byte that
differs from the generated text.

- Draft sources are TypeSpec models, enums, scalars and unions:
  `agent-context.tsp`, `verdict.tsp`, `hook-responses.tsp`, `approval.tsp`,
  `interception-record.tsp`, `host-declaration.tsp`, plus shared types.
  `main.tsp` imports the bundle's sources. The generator selects one public
  root per compilation with `@@jsonSchema`, so the native emitter embeds
  dependencies in each standalone document. The generator loads
  `@typespec/json-schema` from `spec/scripts` and emits Draft 2020-12
  directly. Use Node.js 22 or later for this tooling.
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
- `spec/scripts/typespec-schemas.mts` invokes the native emitter in memory,
  preserving published identities. Approval's definitions-only document
  uses a temporary model to collect its public fragments, then discards
  that model's instance shape. `generate-schemas.mts` derives the per-point
  `generated/strict-contexts/*.schema.json` files from the master union.
  It retains the legacy TypeScript generator for released bundles.

```bash
cd spec/scripts && npm ci
npm run generate:schema      # write spec/draft/schema/generated/**/*.schema.json
npm run check:schema         # compile the source, then fail on any drift
npm run check:schema:equivalence -- --old origin/main   # differential validation against another revision
```

After a change, regenerate. The Python mirror holds one folder per
supported specification version (`sdk/python/python/agent_hooks/schema/0.1/`
and `schema/draft/`), each with that bundle's generated schemas and the
per-point context schemas under `agent-context/`. The `schema-drift`
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

## Local test matrix

```bash
# Rust core + FFI
cd sdk/rust && cargo test --workspace --all-features && cargo clippy --workspace -- -D warnings
# Python (rebuild bindings when core changed)
cd sdk/python && maturin develop --release && python -m pytest tests/ && ruff check
# TypeScript (rebuild native when core changed)
cd spec/scripts && npm ci && cd ../../sdk/typescript && npm ci && npm test
# .NET (needs the FFI cdylib on the library path)
cargo build --release --manifest-path sdk/rust/Cargo.toml -p agent-hooks-ffi
cd sdk/dotnet && LD_LIBRARY_PATH=../rust/target/release dotnet test
# Go
cd sdk/go && CGO_ENABLED=1 go test ./...
```

For the protected Windows x64 FFI used by .NET/NuGet, follow the
[Windows source-build instructions](sdk/dotnet/README.md#windows-x64-source-builds-and-release-checks).
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
