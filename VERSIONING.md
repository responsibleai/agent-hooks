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
Status Draft, Version DRAFT and the date of its last change. The draft
is a version of its own, `draft`, with the wire string `agent-hooks/draft`.

The only released version is 0.1, the text the SDKs shipped against at
the `v0.1.0-beta.3` tag (2026-10-22), read into `spec/0.1/` unchanged
except for its header line. What the draft has added since (the
failure posture `on_error`, declaration contract 1.1, the reserved
warnings, the generated schema layout and the examples) becomes 0.2
when it is cut. One difference by decision: the SDKs require the
`spec` member on a host declaration document under 0.1 as well,
although the 0.1 text made it optional, because they now carry two
versions and a document must say which one it is written for. The 0.1
text stays as released.

### Versioning rules

| Change in the draft | Next version |
| --- | --- |
| Additive: optional or namespaced fields, new vectors, new optional composition profiles, a new optional artefact with its own schema (the host declaration document, §7.7) | MINOR |
| Breaking: a required or conditional field change, an interception point added or removed, a change to the verdict shape, the composition semantics or the fail-closed semantics | MAJOR |

Conformance vectors track the specification and are additive within a
MINOR.

### The draft

The draft is the version `draft`. It changes without notice and is
never claimed. A cut copies it to a numbered version and the numbered
copy gets its own wire string. A context or a document of the draft
carries `agent-hooks/draft`, so a reader tells 0.1 from the draft by
that string, and the SDKs support both side by side (below).

### Specification folders

Released bundles live in `spec/<MAJOR.MINOR>/` and the working text in
`spec/draft/`; [spec/README.md](spec/README.md) lists every folder and
what each holds. Released folders are immutable.

A version is cut by a spec-only pull request
([RELEASING.md](RELEASING.md#release-a-specification-version)) and
marked after merge by the tag `spec/<MAJOR.MINOR>` on the merge commit.
The tag starts no workflow.

The SDKs support the released 0.1 and the draft side by side: the
Rust tests, the `drift` mirror copy and the version script read every
supported bundle (`SUPPORTED_SPEC_VERSIONS`, today `spec/0.1/` and
`spec/draft/`), and the CI schema checks cover every bundle, so a
breaking draft change is implemented under the draft's rules and
leaves 0.1 alone. SDK draft support is experimental and may lag the
latest draft. The `drift` check enforces generated spec schemas and
released SDK mirrors, but preserves SDK draft copies and reports their
drift as advisory until matching SDK implementation changes are ready.
Prose links cite the released text, `spec/0.1/`, and
the draft for what 0.1 does not define.

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

Each SDK supports two specification versions, the released 0.1 and the
draft, and exports `SUPPORTED_SPEC_VERSIONS` (`["0.1", "draft"]`; each
entry names a `spec/<entry>/` folder) and the two wire strings,
`SPEC_VERSION_0_1` and `SPEC_VERSION_DRAFT` (`agent-hooks/0.1`,
`agent-hooks/draft`). There is no default version. A host names the
version when it builds its emitter and its context builder, a required
first argument in every SDK, or in its host declaration's `spec`
member, which is required; building without one is an error that names
the supported set. A host selects the draft by passing
`agent-hooks/draft`. An emitter runs one version: a context that names
another version, supported or not, is refused as
`host_error:context_invalid`, and a document that names an unsupported
version is refused as `declaration_error:spec_unsupported`. The version
named selects the rules: the reserved reasons (`host_warning:*` is
reserved under the draft only), the declaration contracts a loader
accepts (1.0 under 0.1; 1.0 and 1.1 under the draft) and the failure
posture (`on_error: continue` under the draft only). The draft is never
claimed; a claim names a released version. The gating tests target the
newest released version, and the draft-only tests run as an advisory
job; binding tests to a draft revision is #188.

`scripts/check-version-consistency.py` checks that the five SDKs agree,
that every entry is a released version or the draft with a folder, that
at least one entry is released, and that the row for the current SDK
version in the table below lists the same entries; with
`--require-spec-tags` it also requires the `spec/<X.Y>` tag for every
released entry. The first job of the release workflow reruns the
script, validates the conformance vectors against the draft and the
examples of every bundle against their own schemas, on dry runs too.

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
is the wire version (`agent-hooks/X.Y` or `agent-hooks/draft`, above),
the host declaration contract version (`agent-hooks-declaration/X.Y`,
spec §7.7.2) and the package version (the root tag). The Rust core
exports `DECLARATION_VERSION` and `SUPPORTED_DECLARATION_VERSIONS` next
to `SPEC_VERSION_0_1`, `SPEC_VERSION_DRAFT` and
`SUPPORTED_SPEC_VERSIONS`, and `SpecVersion::declaration_versions()`
says which contract versions each specification version accepts; each
other SDK exports the same facts.
[spec/0.1/DECLARATION-VERSIONS.md](spec/0.1/DECLARATION-VERSIONS.md) maps
0.1 contract versions to schema files; the proposed draft has no
separate contract version
([P-193](docs/proposals/P-193-host-declaration-spec-versioning.md)).
The table below maps SDK releases
to the specification and contract versions they support.

## SDK releases and the versions they support

| SDK release | Spec versions supported | Declaration versions accepted | Current declaration |
| --- | --- | --- | --- |
| `v0.1.0-beta.2` (2026-10-13) | `0.1` | `agent-hooks-declaration/1.0` | `agent-hooks-declaration/1.0` |
| `v0.1.0-beta.3` (2026-10-22) | `0.1` | `agent-hooks-declaration/1.0` | `agent-hooks-declaration/1.0` |
| `v0.1.0-beta.4` | `0.1`, `draft` | `agent-hooks-declaration/1.0`, `agent-hooks-declaration/1.1` | `agent-hooks-declaration/1.1` |

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
plus the attached CTK per-part report (spec §13.3), where the
specification version is a released one; the draft is never claimed.
There are no conformance levels or tiers.
