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
  text, the JSON schemas under `spec/schema/`, and the vendored copies
  (regenerate via `python3 scripts/gen-per-point-schemas.py`; the
  `drift` check enforces this).
- **All five SDKs.** A contract change is not done until Rust core,
  Python, TypeScript, .NET, and Go agree; the Rust core is the single
  source of truth and the wrappers delegate to it.

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

## Reporting security issues

Privately, per [SECURITY.md](SECURITY.md) — not via public issues.
