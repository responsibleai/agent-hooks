# Versioning

## One tag, one version

The spec and all five SDKs release together from one root tag
`vX.Y.Z[-pre.N]` on this repository, for example `v0.1.0-alpha.5`.
The release workflow (`.github/workflows/release.yml`) runs on `v*`
tags and publishes every registry package from that tag. The
procedure is in [RELEASING.md](RELEASING.md).

The four version manifests carry the same version at all times, each
in its own spelling:

| Surface | File | Spelling |
| --- | --- | --- |
| Rust `agent-hooks-sdk` | `sdk/rust/Cargo.toml` | SemVer, `0.1.0-alpha.5` |
| Python `agent-hooks-sdk` | `sdk/python/pyproject.toml` | PEP 440, `0.1.0a5` |
| TypeScript `@responsibleai/agent-hooks` | `sdk/typescript/package.json` | SemVer |
| .NET `ResponsibleAI.AgentHooks` | `sdk/dotnet/Directory.Build.props` | SemVer |

`scripts/check-version-consistency.py` (CI `lint` job) fails when
they disagree. SDK versions are not independent per language.

### Go

The Go module path is `github.com/responsibleai/agent-hooks/sdk/go`.
Go resolves versions for a module in a subdirectory from tags prefixed
with that directory, so this module needs `sdk/go/vX.Y.Z[-pre.N]`
tags. A root `v0.1.0-alpha.5` tag is invisible to it.

No `sdk/go/` tag has been pushed for any release. The module proxy
lists no versions, and `go get` without a version resolves to a
pseudo-version of the latest `main` commit. Until a `sdk/go/` tag
exists, pin a release by its tag commit:

```bash
go get github.com/responsibleai/agent-hooks/sdk/go@61952932e52d5dab091a64677f19272daae619f8  # v0.1.0-alpha.5
```

The `release-tags-restricted` ruleset covers `refs/tags/v*` only; a
`sdk/go/v*` tag is outside it and triggers no workflow. That means any
collaborator with write access can push `sdk/go/v0.1.0` today, Go
consumers will resolve it as a release, and proxy.golang.org caches it
for good; extend the ruleset to `refs/tags/sdk/go/v*` before the first
such tag. Whether to add that tag as a release step is an open
decision, recorded in [RELEASING.md](RELEASING.md).

## Bump rules

| Artefact | Scheme | Bump rule |
| --- | --- | --- |
| Spec | `MAJOR.MINOR` (`agent-hooks/X.Y`) | MINOR = additive optional/namespaced fields, new vectors, new (optional) composition profiles. MAJOR = required/conditional field change, interception-point add/remove, verdict-shape or composition-semantics change. |
| Conformance vectors | track the spec | Additive within a spec MINOR. Shipped in the same tag as the spec. |
| SDKs | semver, one shared version | MAJOR on spec MAJOR or breaking API. |

Each SDK exports `SPEC_VERSION = "agent-hooks/X.Y"` matching the
`AgentContext.spec` value it emits and validates.

A new optional artefact under `spec/` with its own schema and new
vectors (the host declaration document, spec §7.7) is MINOR.

## Three independent axes

Three versions move independently: the wire version (`agent-hooks/X.Y`,
above), the host declaration contract version
(`agent-hooks-declaration/X.Y`, spec §7.7.2) and the package version
(the root tag). Each SDK exports `DECLARATION_VERSION` and
`SUPPORTED_DECLARATION_VERSIONS` next to `SPEC_VERSION`.
[spec/DECLARATION-VERSIONS.md](spec/DECLARATION-VERSIONS.md) maps
contract versions to schema files and SDK releases to the contract
versions they accept.

A conformance claim is the tuple
`(<framework>, <adapter-version>, agent-hooks/<spec-version>, <capabilities>, <profiles>, <identity-provider>, <sdk-lang>@<sdk-version>)`
plus the attached CTK per-part report (spec §13.3). There are no
conformance levels or tiers.
