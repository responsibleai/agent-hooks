# Versioning

Two release trains share this repository: the specification and the
SDKs. Each has its own version, its own tag and its own procedure in
[RELEASING.md](RELEASING.md).

## The specification

A specification version is `MAJOR.MINOR`, the same number as the wire
string `agent-hooks/MAJOR.MINOR` that every context carries in `spec`.
There is no patch level and no pre-release suffix, and alpha or beta
never appear in a header: a wording fix waits for the next minor. The
released text lives frozen in `spec/<MAJOR.MINOR>/AGENT-HOOKS-<MAJOR.MINOR>.md`;
the working text is `spec/draft/AGENT-HOOKS-DRAFT.md`, whose header says
Status Draft, Version DRAFT and the date of its last change.

The only released version is 0.1, the text the SDKs shipped against at
the `v0.1.0-beta.3` tag (2026-10-22), read into `spec/0.1/` unchanged
except for its header line. What the draft has added since (the
failure posture `on_error`, declaration contract 1.1, the reserved
warnings, the generated schema layout and the examples) becomes 0.2
when it is cut.

### Versioning rules

| Change in the draft | Next version |
| --- | --- |
| Additive: optional or namespaced fields, new vectors, new optional composition profiles, a new optional artefact with its own schema (the host declaration document, §7.7) | MINOR |
| Breaking: a required or conditional field change, an interception point added or removed, a change to the verdict shape, the composition semantics or the fail-closed semantics | MAJOR |

Conformance vectors track the specification and are additive within a
MINOR.

### The wire string in the draft

No context ever carries `DRAFT`. The draft carries the last released
wire string, `agent-hooks/0.1` today, until the first breaking change
lands in it. The pull request that lands that change moves the draft's
wire string to the version the cut will be named, the next MAJOR; the
`change-class` check already requires a `spec:breaking` pull request to
change a version surface, and this is the one. From then until the cut
the draft announces the coming version, and a reader tells 0.1 from
the draft by that string. An additive draft keeps the released wire
string; the cut then takes the next MINOR, and the draft follows it.

### Specification folders

Released bundles live in `spec/<MAJOR.MINOR>/` and the working text in
`spec/draft/`; [spec/README.md](spec/README.md) lists every folder and
what each holds. Released folders are immutable.

A version is cut by a spec-only pull request
([RELEASING.md](RELEASING.md#release-a-specification-version)) and
marked after merge by the tag `spec/<MAJOR.MINOR>` on the merge commit.
The tag starts no workflow.

SDK development tracks `spec/draft/`: the `drift` mirror copy, the
Rust tests and the version script read the draft (named once as
`SPEC_DEV_DIR` in the workflows and in the Rust tests), and the CI
schema checks cover every bundle, so a breaking draft change has
somewhere to be implemented. Prose links cite the released text,
`spec/0.1/`, and the draft for what 0.1 does not define.

## The SDKs

### One tag, one version

All five SDKs release together from one root tag `vX.Y.Z[-pre.N]` on
this repository, for example `v0.1.0-alpha.5`. The release workflow
(`.github/workflows/release.yml`) runs on `v*` tags and publishes
every registry package from that tag.

The four version manifests carry the same version at all times, each
in its own spelling:

| Surface | File | Spelling |
| --- | --- | --- |
| Rust `agent-hooks-sdk` | `sdk/rust/Cargo.toml` | SemVer, `0.1.0-alpha.5` |
| Python `agent-hooks-sdk` | `sdk/python/pyproject.toml` | PEP 440, `0.1.0a5` |
| TypeScript `@responsibleai/agent-hooks` | `sdk/typescript/package.json` | SemVer |
| .NET `ResponsibleAI.AgentHooks` | `sdk/dotnet/Directory.Build.props` | SemVer |

`scripts/check-version-consistency.py` (CI `lint` job) fails when
they disagree. SDK versions are not independent per language. An SDK
bumps its MAJOR only when its own API breaks; it records the
specification versions it supports in `SUPPORTED_SPEC_VERSIONS`, and a
specification MAJOR does not force an SDK MAJOR, because an SDK can
carry a breaking specification change behind an unchanged API.

### The specification versions an SDK supports

Each SDK exports `SPEC_VERSION`, the wire string it writes into every
context, and `SUPPORTED_SPEC_VERSIONS`, the specification versions
whose contexts it accepts; each entry names a `spec/<MAJOR.MINOR>/`
folder. Today both say 0.1. `scripts/check-version-consistency.py`
checks that every supported version has a folder, that `SPEC_VERSION`
is the highest supported, that none says DRAFT, that the five SDKs
agree, and that the row for the current SDK version in the table below
lists the same versions. The first job of the release workflow reruns
the script and validates the conformance vectors, on dry runs too.

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

## Three independent axes

Three versions move independently: the specification version, which
is the wire version (`agent-hooks/X.Y`, above), the host declaration
contract version (`agent-hooks-declaration/X.Y`, spec §7.7.2) and the
package version (the root tag). The Rust core exports
`DECLARATION_VERSION` and `SUPPORTED_DECLARATION_VERSIONS` next to
`SPEC_VERSION` and `SUPPORTED_SPEC_VERSIONS`; each other SDK exports
the same constants.
[spec/draft/DECLARATION-VERSIONS.md](spec/draft/DECLARATION-VERSIONS.md) maps
contract versions to schema files; the table below maps SDK releases
to the specification and contract versions they support.

## SDK releases and the versions they support

| SDK release | Spec versions supported | Declaration versions accepted | Current declaration |
| --- | --- | --- | --- |
| `v0.1.0-beta.2` (2026-10-13) | `0.1` | `agent-hooks-declaration/1.0` | `agent-hooks-declaration/1.0` |
| `v0.1.0-beta.3` (2026-10-22) | `0.1` | `agent-hooks-declaration/1.0` | `agent-hooks-declaration/1.0` |
| `v0.1.0-beta.4` | `0.1` | `agent-hooks-declaration/1.0`, `agent-hooks-declaration/1.1` | `agent-hooks-declaration/1.1` |

`v0.1.0-beta.2` is the first tag that accepts a host declaration;
`v0.1.0-beta.1` and earlier accept none. `v0.1.0-beta.3` is the last
tag that touched the specification text, which is why 0.1 is that
text. Add a row for every tag that changes the supported specification
versions, the accepted declaration set or the current declaration
version ([RELEASING.md](RELEASING.md#release-the-sdks), step 1).
`scripts/check-version-consistency.py` fails when no row here accepts
the current `DECLARATION_VERSION` or when the row for the current SDK
version lists other specification versions than the SDKs do.

This table lives outside the specification bundles: a release row is
written when a tag is cut, which is after the bundle it ships against
was frozen, and released bundles are immutable. The 0.1 bundle carries
the rows known at its release as a historical record; the draft bundle
points here.

A conformance claim is the tuple
`(<framework>, <adapter-version>, agent-hooks/<spec-version>, <capabilities>, <profiles>, <identity-provider>, <sdk-lang>@<sdk-version>)`
plus the attached CTK per-part report (spec §13.3). There are no
conformance levels or tiers.
