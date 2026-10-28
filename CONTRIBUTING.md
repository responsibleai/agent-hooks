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
- **Spec and schema together.** Changes to wire shapes update the spec
  text and the schema source under `scripts/schemagen/`, then regenerate
  the JSON under `spec/schema/` (see [Schema source](#schema-source));
  the `drift` check regenerates the schemas and the vendored copies and
  fails on any difference.
- **All five SDKs.** A contract change is not done until Rust core,
  Python, TypeScript, .NET, and Go agree; the Rust core is the single
  source of truth and the wrappers delegate to it.

## Schema source

The JSON Schemas under `spec/schema/` are generated. Do not edit them by
hand; the `lint` and `drift` checks fail on any byte that differs from
the generated text.

- The source is `scripts/schemagen/`, one module per root schema
  (`verdict.py`, `agent_context.py`, `host_declaration.py`, ...).
  Each module builds its document with the constructors in
  `vocabulary.py`: `obj`, `string`, `integer`, `array`, `ref`, `const`,
  `schema` for a node without a `type`, and `document` for a root.
  Members come out in the order you write them, so order them as you
  want them read. `nullable=True` widens a type to `["<type>", "null"]`;
  `additionalProperties=False` closes an object; `if_`, `then`, `else_`,
  `not_`, `ref` and `defs` spell the keywords that are not Python names.
- Values that more than one schema states (the interception points, the
  decisions, the composition profiles and knobs) live in `common.py`.
  `host_declaration.py` builds every contract version from one function;
  the per-point `agent-context/*.schema.json` files derive from the
  master in `agent_context.py`.
- An unknown keyword or a value of the wrong type fails generation with
  the JSON pointer of the node.

```bash
python3 scripts/gen-schemas.py          # write spec/schema/**/*.schema.json
python3 scripts/gen-schemas.py --check  # exit 1 and print a diff on any drift
```

Run the generator after every change to the source and commit the
source and the JSON together. When a shape changes, also run the
`schema-lint` steps from `.github/workflows/ci.yml` (ajv compiles every
schema and validates the vectors). The emitter keeps each file's
committed layout; `agent-context.schema.json` has a compact hand layout,
pinned in `agent_context.LAYOUT`.

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
