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
  vectors (`conformance/vectors/`) or per-SDK tests — cross-SDK
  semantics belong in vectors so all five implementations are pinned
  at once.
- **Spec and schema together.** Make normative changes in
  `spec/draft/`. Changes to wire shapes update the draft spec text and
  the schema source under `spec/draft/schema/src/`, then regenerate the
  JSON under `spec/draft/schema/generated/` (see [Schema source](#schema-source));
  the `drift` check regenerates the draft schemas and the vendored copies
  and fails on any difference. Released folders such as `spec/0.1.0/`
  are immutable; see [spec/README.md](spec/README.md).
- **SDKs are pinned to `spec/0.1.0/` for now.** SDK code, tests,
  vendored schemas, conformance-vector validation, and version checks
  read `spec/0.1.0/`. How SDK development should track future
  specification versions is still to be decided.
- **All five SDKs.** A contract change is not done until Rust core,
  Python, TypeScript, .NET, and Go agree; the Rust core is the single
  source of truth and the wrappers delegate to it.

## Schema source

Each specification folder's JSON Schemas under `spec/<version>/schema/generated/`
are generated from the TypeScript in `spec/<version>/schema/src/`. Edit
only `spec/draft/schema/src/`; the generator targets `draft` unless
`--spec <version>` names another folder. The JSON stays the normative artifact: it is
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

After a change, regenerate. The Python mirror stays pinned to the
released schemas: refresh it the way the `drift` workflow does (copy
`spec/0.1.0/schema/generated/*.schema.json` into
`sdk/python/python/agent_hooks/schema/` and `generated/strict-contexts/*.schema.json`
into its existing `agent-context/` subdirectory), and commit the
source, the JSON and the mirror together. When a shape changes, also run
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
