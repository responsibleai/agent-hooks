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

A new optional artefact under `spec/draft/` with its own schema and new
vectors (the host declaration document, spec §7.7) is MINOR.

## Specification folders

Released specification bundles live in `spec/<MAJOR.MINOR.PATCH>/`;
ongoing work lives in `spec/draft/`. The folder name is the
specification release version and has no pre-release suffix. It is not
the wire version: `spec/0.1.0/` defines `agent-hooks/0.1`, and later
specification releases can keep the same wire version. Released folders
are immutable; the `change-class` CI check fails pull requests that
change a version folder that already exists on the base branch. The one
exception is a new regular `.json` file under
`spec/<version>/schema/examples/<Type>/`, which illustrates a schema
without changing it; modified or deleted files, and any other new file,
still fail. The check is not
yet a required status check, so a red result does not block a merge on
its own. [spec/README.md](spec/README.md) lists every version, and
[RELEASING.md](RELEASING.md#cut-a-specification-version) has the
procedure for cutting one.
SDK development tracks `spec/draft/`: the `drift` mirror copy, the
Rust tests and the version script read the draft (named once as
`SPEC_DEV_DIR` in the workflows and in the Rust tests), and the CI
schema and vector checks cover every bundle, so a breaking draft change
has somewhere to be implemented. A release tag names the specification
version it ships against. Prose links cite the current version folder,
`spec/0.1.0/`.

## Three independent axes

Three versions move independently: the wire version (`agent-hooks/X.Y`,
above), the host declaration contract version
(`agent-hooks-declaration/X.Y`, spec §7.7.2) and the package version
(the root tag). The Rust core exports `DECLARATION_VERSION` and
`SUPPORTED_DECLARATION_VERSIONS` next to `SPEC_VERSION`; each other
SDK exports the same two constants once it gains the loader.
[spec/0.1.0/DECLARATION-VERSIONS.md](spec/0.1.0/DECLARATION-VERSIONS.md) maps
contract versions to schema files; the table below maps SDK releases
to the contract versions they accept.

## SDK releases and the declaration versions they accept

| SDK release | Accepts | Current |
| --- | --- | --- |
| `v0.1.0-beta.2` (2026-10-13) | `agent-hooks-declaration/1.0` | `agent-hooks-declaration/1.0` |
| `v0.1.0-beta.4` | `agent-hooks-declaration/1.0`, `agent-hooks-declaration/1.1` | `agent-hooks-declaration/1.1` |

`v0.1.0-beta.2` is the first tag that accepts a host declaration;
`v0.1.0-beta.1` and earlier accept none. Add a row for every tag that
changes the accepted set or the current version
([RELEASING.md](RELEASING.md), step 1).
`scripts/check-version-consistency.py` fails when no row here accepts
the current `DECLARATION_VERSION`.

This table lives outside the specification bundles: a release row is
written when a tag is cut, which is after the bundle it ships against
was frozen, and released bundles are immutable. The 0.1.0 bundle still
carries the rows up to `v0.1.0-beta.4` as a historical record; the
draft bundle points here.

A conformance claim is the tuple
`(<framework>, <adapter-version>, agent-hooks/<spec-version>, <capabilities>, <profiles>, <identity-provider>, <sdk-lang>@<sdk-version>)`
plus the attached CTK per-part report (spec §13.3). There are no
conformance levels or tiers.
