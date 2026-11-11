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
  the `drift` check regenerates the draft schemas and the vendored copies
  and fails on any difference. Released folders such as `spec/0.1/`
  are immutable; see [spec/README.md](spec/README.md).
- **The SDKs support 0.1 and the draft side by side.**
  `SUPPORTED_SPEC_VERSIONS` is `["0.1", "draft"]` in every core; the
  Rust tests, the `drift` mirror copy and
  `scripts/check-version-consistency.py` read every supported bundle,
  and CI steps that check schemas and vectors loop over every bundle. A
  breaking draft change is implemented under the draft's rules
  (`SpecVersion::Draft` in the Rust core) and leaves 0.1 alone; a host
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
are generated from the TypeScript in `spec/<version>/schema/src/`. Edit
only `spec/draft/schema/src/`; the generator targets `draft` unless
`--spec <version>` names another folder. The `lint` job runs the drift
check for the draft and, with `--spec`, for every released bundle that
has `schema/src/`, so a frozen source keeps generating its frozen
output; 0.1 has no source and is named and skipped. The JSON stays the normative artifact: it is
what validators, the conformance kit and the SDK mirrors consume. Do not
edit it by hand; the `lint` and `drift` checks fail on any byte that
differs from the generated text.

- One source file per root schema (`verdict.ts`, `agent-context.ts`,
  `approval.ts`, and so on; `host-declaration.ts` builds both contract
  versions), written as interfaces, string enums and JSDoc. The
  generator runs typescript-json-schema 0.68.0 with `--required
  --defaultNumberType integer --skipLibCheck --strictNullChecks` and
  reads these tags: `@pattern`, `@minimum`, `@maximum`, `@minLength`,
  `@maxLength`, `@minItems`, `@maxItems`, `@uniqueItems`, `@format`,
  `@default`, `@title`, `@TJS-type number` for a non-integer number,
  and `@additionalProperties false` on an interface to close it. String
  enums keep their declaration order; a union of literals is sorted.
- A rule one member decides is a discriminated union: verdicts by
  `decision`, agent contexts by `interception_point`, approval
  resolutions by `outcome`, the declared surface by `buffered_output`.
  A rule the type system cannot state is JSON Schema in an `@allOf` tag
  on the interface it constrains, copied through by the generator;
  `@propertyNames` passes through the same way.
- `sdk/typescript/scripts/generate-schemas.mts` lists its post-pass at
  the top of the file. The per-point `generated/strict-contexts/*.schema.json`
  files are derived there from the master's union members.

```bash
cd sdk/typescript && npm ci
npm run generate:schema      # write spec/draft/schema/generated/**/*.schema.json
npm run check:schema         # type-check the source, then fail on any drift
npm run check:schema:equivalence -- --old origin/main   # differential validation against another revision
```

After a change, regenerate. The Python mirror holds one folder per
supported specification version (`sdk/python/python/agent_hooks/schema/0.1/`
and `schema/draft/`), each with that bundle's generated schemas and the
per-point context schemas under `agent-context/`: refresh it the way the
`drift` workflow does (the "Refresh the vendored copies" step in
`.github/workflows/schema-drift.yml`), and commit the source, the JSON
and the mirror together. When a shape changes, also run
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
cd sdk/typescript && npm ci && npm test
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
