# AGENTS.md

Guidance for coding agents working in this repository. People can start with [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

Agent Hooks is a control contract for AI agents. At each interception point a host asks its interceptors for a verdict and enforces it. This repository holds the specification, the conformance kit and SDKs in five languages. It's a cooperative contract, not a security boundary ([SECURITY.md](SECURITY.md)).

## Layout

| Path | What it holds |
| --- | --- |
| `spec/0.1/` | The released 0.1 specification. Never edit it. |
| `spec/draft/` | The working draft, `AGENT-HOOKS-DRAFT.md`, and its TypeSpec schema source in `schema/src/` |
| `emitters/` | TypeSpec emitters that generate SDK code, such as the .NET contracts |
| `sdk/rust/` | The Rust core. Python, TypeScript and Go call it. |
| `sdk/python/`, `sdk/typescript/`, `sdk/go/` | SDKs built on the Rust core |
| `sdk/csharp/` | The .NET SDK, managed code only, draft only |
| `conformance/` | Conformance vectors and the runner |
| `docs-site/` | The documentation site |

## Rules

- Make normative changes in `spec/draft/`. CI refuses changes to released folders such as `spec/0.1/` and `conformance/0.1/`.
- Never edit generated output. Change the TypeSpec in `spec/draft/schema/src/` or an emitter, run `pnpm generate`, and commit the source and the output together.
- A contract change isn't done until all five SDKs agree. Pin behavior across languages with conformance vectors.
- Changes in the classes listed in [docs/proposals/README.md](docs/proposals/README.md) need a written proposal first.
- Fail closed. Never normalize a value; reject it with a clear message.
- Start every source file with `Copyright (c) Microsoft. All rights reserved.` in its comment style, then a blank line.
- Sign off every commit with `git commit -s`. Everything lands by pull request, and `main` needs a code owner's approval.
- Report security issues privately, as [SECURITY.md](SECURITY.md) describes.

## Build and test

Install the tools with `mise trust` and `mise install` (versions in `mise.toml`), then run `pnpm install` once.

| Part | Command |
| --- | --- |
| Draft outputs | `pnpm generate`, then `pnpm check-for-changed-files` |
| Rust | `cd sdk/rust && cargo test --workspace --all-features && cargo clippy --workspace -- -D warnings` |
| Python | `cd sdk/python && maturin develop --release && python -m pytest tests/ && ruff check` |
| TypeScript | `pnpm --dir sdk/typescript test` |
| .NET | `cd sdk/csharp && dotnet test` |
| Go | `cd sdk/go && CGO_ENABLED=1 go test ./...` |
| Docs site | `pnpm --filter @agent-hooks/docs test` |
| File headers | `python3 scripts/check-file-headers.py` |

Tests for draft only behavior run in the advisory `draft-tests` job. Mark them the way each suite filters; [CONTRIBUTING.md](CONTRIBUTING.md) lists the markers.

## Using an SDK in an app

Read the SDK's README: [.NET](sdk/csharp/README.md), [Python](sdk/python/README.md), [TypeScript](sdk/typescript/README.md), [Go](sdk/go/README.md) or [Rust](sdk/rust/README.md). For .NET, the [agent-hooks-dotnet skill](.github/skills/agent-hooks-dotnet/SKILL.md) walks through adding the SDK to an app.
