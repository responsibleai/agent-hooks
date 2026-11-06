# Releasing

Two trains release from this repository on their own schedules
([VERSIONING.md](VERSIONING.md)): the specification, as a frozen
`spec/<MAJOR.MINOR>/` folder marked by a `spec/<MAJOR.MINOR>` tag, and
the five SDKs together, from one root tag `vX.Y.Z[-pre.N]` that the
release workflow (`.github/workflows/release.yml`) publishes. The
workflow's header describes the one-time trusted-publisher setup per
registry; all registries use OIDC, no tokens. Publish jobs run in the
`release` environment.

## Release a specification version

A specification version `X.Y` is a frozen copy of the draft. Pick `X.Y`
from the bump table in VERSIONING.md: MINOR for an additive draft,
MAJOR for a breaking one. Cut it in one spec-only pull request.

1. Run the cut script. It copies `spec/draft/` to `spec/X.Y/`, renames
   the text to `AGENT-HOOKS-X.Y.md`, sets the title and the header line
   to Released, `X.Y` and the date, drops the draft banner, rewrites the
   draft wire string `agent-hooks/draft` to `agent-hooks/X.Y` in every
   text file of the copy, and rewrites the copy's `spec/draft/`
   self-references. The draft itself does not change; it keeps
   `agent-hooks/draft`. The script prints what remains.

   ```bash
   python3 scripts/cut-spec-version.py X.Y
   ```

2. Regenerate the copy's schemas under their own id path,
   `https://responsibleai.github.io/agent-hooks/schema/vX.Y/`. The
   generator sets the base from `--spec`; a published path is
   immutable, so the staging of the site fails when two bundles bring
   different bytes to one path.

   ```bash
   cd sdk/typescript && npx tsx scripts/generate-schemas.mts --spec X.Y
   ```

3. In `spec/draft/AGENT-HOOKS-DRAFT.md`, point the banner at the new
   version: `The latest released version is [X.Y](../X.Y/AGENT-HOOKS-X.Y.md).`
   The header keeps Status Draft and Version DRAFT, with the date of
   the change.
4. In `spec/README.md`, add the row for `X.Y` with the status
   "Released" and the date, and set the previous version to
   "Superseded". In `README.md`, point the status line and the "Read
   next" sentence at the new folder. Move prose links from the
   previous version to `X.Y` unless the document cites the older text
   on purpose (`grep -rn 'spec/<previous>/' --exclude-dir=spec .`).
   Machine consumers read `spec/draft/` and do not move.
5. In `CHANGELOG.md`, rename the "Unreleased specification" section to
   "Specification X.Y — YYYY-MM-DD" and start a new empty one. In each
   proposal whose text is in the cut, change `(in draft)` to
   `(released in X.Y)` on its Status line.
6. The site needs no edit: the `pages` workflow publishes every version
   folder at `/spec/X.Y/` with its schemas at the path their `$id`
   names, and lists the versions in the navigation, newest first, then
   the draft.
7. Run the checks that read the new folder; the `lint`,
   `schema-lint`, `typescript`, `change-class` and `pages` jobs run
   the same commands (`ajv` is `ajv-cli`, installed as in `ci.yml`):

   ```bash
   python3 scripts/check-spec-versions.py
   python3 scripts/check-released-specs-immutable.py origin/main HEAD
   python3 scripts/check-version-consistency.py
   python3 scripts/check-file-headers.py
   python3 -m unittest discover -s scripts -p "test_*.py"
   python3 scripts/stage-docs-site.py
   for version in 0.1 draft; do
     root="spec/$version/schema/generated"
     mapfile -t refs < <(find "$root" -name '*.schema.json' | sed 's/^/-r=/')
     ajv validate --spec=draft2020 -c ajv-formats \
       -s "conformance/$version/vectors.schema.json" "${refs[@]}" \
       -d "conformance/$version/vectors/*.json"
   done
   cd sdk/typescript && npm ci
   node scripts/check-schema-examples.mjs
   npx tsc -p ../../spec/X.Y/schema/src/tsconfig.json
   npx tsx scripts/generate-schemas.mts --check --spec X.Y
   ```

   Each suite validates only against its matching schema bundle. SDK
   runners use the released 0.1 suite by default. The advisory
   `draft-tests` job separately runs draft-only IDs absent from that
   released suite, without duplicating shared coverage. The
   new folder passes the released-folder guard because it did not exist
   on `main`; after the merge it is frozen, and only new regular `.json`
   files under its `schema/examples/<Type>/` may be added.
8. Reproducibility. A reviewer reruns the cut on the pull request's
   merge base and diffs the result against the pull request:

   ```bash
   git worktree add /tmp/cut-check origin/main
   (cd /tmp/cut-check && python3 scripts/cut-spec-version.py X.Y --date YYYY-MM-DD \
     && cd sdk/typescript && npm ci && npx tsx scripts/generate-schemas.mts --spec X.Y)
   diff -r /tmp/cut-check/spec/X.Y spec/X.Y && echo reproducible
   ```

   0.1 was not cut from the draft but built from the last SDK tag that
   touched the text, so its proof has three parts. The text is the
   tag's except its header line:

   ```bash
   git diff --stat v0.1.0-beta.3:spec/AGENT-HOOKS-0.1.md HEAD:spec/0.1/AGENT-HOOKS-0.1.md
   ```

   The schemas are generated from `spec/0.1/schema/src/`, the draft
   source with everything after 0.1 removed, and are instance-equivalent
   to the tag's hand-written schemas: the equivalence tool reports 0
   disagreements for every schema both sides have, and
   host-declaration-1.1 on neither side.

   ```bash
   mkdir -p /tmp/beta3/agent-context
   for f in $(git ls-tree -r --name-only v0.1.0-beta.3 spec/schema | grep '\.schema\.json$'); do
     git show "v0.1.0-beta.3:$f" > "/tmp/beta3/${f#spec/schema/}"
   done
   cd sdk/typescript && npm run check:schema:equivalence -- --old /tmp/beta3 --new ../../spec/0.1/schema/generated
   ```

   The examples are the draft's that validate against those schemas
   (`node scripts/check-schema-examples.mjs 0.1`). From 0.2 on, the
   byte proof above is the only one.

9. After the merge, tag the merge commit. The tag starts no workflow;
   Pages publishes on the push to `main`. Only repository admins and
   maintainers may create it: extend the `release-tags-restricted`
   ruleset to `refs/tags/spec/*` before the first push. `spec/0.1`
   goes on the commit that merges the 0.1 folder.

   ```bash
   git tag -s spec/X.Y <merge-sha> -m "Agent Hooks specification X.Y"
   git push origin spec/X.Y
   ```

## Release the SDKs

### Before the tag

1. Bump the version on every surface through one PR, with a
   `CHANGELOG.md` entry that names the tag (the `Unreleased SDK`
   section becomes the tag's dated section):
   - `sdk/rust/Cargo.toml` and `sdk/rust/Cargo.lock`
   - `sdk/python/Cargo.toml`, `sdk/python/Cargo.lock`,
     `sdk/python/pyproject.toml`
   - `sdk/typescript/Cargo.toml`, `sdk/typescript/Cargo.lock`,
     `sdk/typescript/package.json`, `sdk/typescript/package-lock.json`,
     `sdk/typescript/npm/*/package.json`
   - `sdk/dotnet/Directory.Build.props` and
     `sdk/dotnet/test/AgentHooks.Tests/packages.lock.json`
   - install pins in `README.md` and the per-SDK READMEs

   The draft's header says Status Draft and Version DRAFT with the date
   of its last change; no SDK tag edits it.

   An SDK release does not cut a specification version.
   `SUPPORTED_SPEC_VERSIONS` in the five cores names the `spec/<entry>/`
   folders whose contexts the SDK accepts, released versions and the
   draft (`["0.1", "draft"]` today). The draft entry is how an SDK
   carries text no released version holds; a host that wants it names
   `agent-hooks/draft`. Add or drop an entry in all five cores together,
   with its rules in the Rust core's `SpecVersion`.

   Regenerate `sdk/typescript/binding.js` after the bump (`npm run
   build:native` in `sdk/typescript`); the napi version strings it
   embeds come from `package.json`, and the CI `typescript` job fails
   on drift.
   Add the tag's row to the table in
   [VERSIONING.md](VERSIONING.md#sdk-releases-and-the-versions-they-support)
   when the supported specification versions, the accepted host
   declaration versions or the current one change.
   Run `python3 scripts/check-version-consistency.py`; the CI `lint`
   job runs the same check, and the first job of the release workflow
   reruns it on the tag and on every dry run. It fails when the five
   SDKs disagree, when a supported entry is neither a `spec/<X.Y>/`
   folder nor the draft, when no entry is released, when no table row
   accepts the current declaration version, or when the row for the
   current SDK version lists other entries than the cores do, and, with
   `--require-spec-tags`, when a released entry has no `spec/<X.Y>` tag
   on an ancestor of the tagged commit. So `spec/0.1` must be pushed
   before the next SDK tag; it goes on the commit that merges the 0.1
   folder. That job validates each versioned conformance suite against
   its matching schema bundle, plus the examples of every bundle
   against that bundle's own schemas, because a release ships against
   0.1 and the draft.
2. Run the bench suite and compare against the latency budget in
   [ARCHITECTURE.md](ARCHITECTURE.md#latency-budget). CI does not gate
   on it; this step is the regression check.

   ```bash
   cd sdk/rust && cargo bench -p agent-hooks-sdk
   ```

3. Dry run: Actions, `release`, Run workflow with `dry_run: true` on
   `main`. This builds every artifact (five Python wheels and the
   sdist, the crate package, five napi bindings, four FFI libraries and
   the nupkg, and the Go build and tests). It uploads the build
   artifacts to the run, publishes nothing and attests nothing.

#### Windows FFI hardening

The Windows x64 FFI leg uses
[the shared Windows build action](.github/actions/windows-ffi/action.yml):
pinned nightly Rust `nightly-2026-10-21`, rebuilt `std`/`panic_unwind`,
strong stack protection and CFG. Other release legs keep their existing
toolchains. Do not replace this leg with a plain stable Cargo build.

Before native upload, the full matching-PDB BinSkim scan must complete,
match the DLL hash, pass BA2014 and BA2008 without suppression, and have
no error findings. The `windows-ffi-hardening` artifact retains the DLL,
PDB, SARIF and scanner log for 14 days. Existing warnings remain reported,
not waived. The NuGet job then verifies exact identity between the scanned
Windows DLL and the bundled payload. These checks do not establish a
downstream consumer's security-policy acceptance.

For local builds and checks, see the
[Windows source-build instructions](sdk/dotnet/README.md#windows-x64-source-builds-and-release-checks).
Changing the nightly pin requires rerunning the native scan, gate regressions,
Rust tests, .NET tests, package-consumer smoke and latency comparison.

### Tag

Tag the merged version-bump commit on `main` and push the tag. Only
repository admins and maintainers can create `v*` tags (ruleset
`release-tags-restricted`). The push starts the release workflow.

```bash
git tag -s v<version> -m "agent-hooks <version>"
git push origin v<version>
```

### What the tag run publishes

- crates.io `agent-hooks-sdk`
- PyPI `agent-hooks-sdk` (five platform wheels and the sdist)
- npm `@responsibleai/agent-hooks` plus five platform packages
  `@responsibleai/agent-hooks-<platform>`. Every version publishes
  under the `latest` dist-tag, pre-releases included, so a plain
  `npm install` gets the newest release. A pre-release also gets a
  channel tag from its label: `alpha` for `-alpha.N`, `beta` for
  `-beta.N`, `rc` for `-rc.N`, `next` for any other label. Stable
  versions carry only `latest`.
- NuGet `ResponsibleAI.AgentHooks`, bundling four native runtimes
- Go: nothing. The `go` job builds and tests `sdk/go` as a consumer
  would see it. See the next section.

Each package gets a provenance attestation and an SBOM. Every leg
skips versions and files that already exist, so a rerun after a
partial failure is safe, and a non-dry dispatch on the tag ref appends
missing artifacts. The workflow creates no GitHub Release object.

### Go module tag

Go resolves a subdirectory module's versions from tags prefixed with
that directory. The module `github.com/responsibleai/agent-hooks/sdk/go`
therefore needs a `sdk/go/v<version>` tag per release; the root tag
does not reach it. No such tag has been pushed for any release, so the
module proxy lists no versions and consumers pin by commit hash.

Whether to add this tag as a release step is still open. If adopted,
push it after the root tag, pointing at the same commit:

```bash
git tag -s sdk/go/v<version> v<version>^{} -m "agent-hooks Go SDK <version>"
git push origin sdk/go/v<version>
```

This tag is outside the `release-tags-restricted` ruleset
(`refs/tags/v*` only) and starts no workflow. It only makes the version
visible to `go get` and the module proxy. Today any collaborator with
write access can push `sdk/go/v0.1.0`, Go consumers will resolve it as
a release, and proxy.golang.org caches it for good; so before the first
push, extend the ruleset (or add one) to `refs/tags/sdk/go/v*`, and
keep the rule that the Go tag points at the root tag's commit.

### After the release

Check each registry shows the version:

```bash
curl -sf https://index.crates.io/ag/en/agent-hooks-sdk | grep -c '"vers":"<version>"'
curl -sf https://pypi.org/pypi/agent-hooks-sdk/json | python3 -c 'import json,sys; print(sorted(json.load(sys.stdin)["releases"]))'
npm view @responsibleai/agent-hooks versions
npm dist-tag ls @responsibleai/agent-hooks
curl -sf https://api.nuget.org/v3-flatcontainer/responsibleai.agenthooks/index.json
go list -m -versions github.com/responsibleai/agent-hooks/sdk/go
```

Check the npm dist-tags. The workflow publishes under `latest` and,
for a pre-release, adds the channel tag on the loader and the five
platform packages. The channel tag relies on "Allow npm dist-tag" being enabled on the trusted publisher configuration (npmjs.com > package > Settings > Trusted Publisher) of every package, which it is today for

- `@responsibleai/agent-hooks`
- `@responsibleai/agent-hooks-linux-x64-gnu`
- `@responsibleai/agent-hooks-linux-arm64-gnu`
- `@responsibleai/agent-hooks-darwin-x64`
- `@responsibleai/agent-hooks-darwin-arm64`
- `@responsibleai/agent-hooks-win32-x64-msvc`

If that setting is ever lost, the dist-tag step fails the release; re-enable it and re-run the tag workflow, or add the tag by hand. Run this from an npm login
with 2FA, not a stored automation token:

```bash
V=<version>
TAG=<alpha|beta|rc|next>
for p in agent-hooks agent-hooks-linux-x64-gnu agent-hooks-linux-arm64-gnu \
         agent-hooks-darwin-x64 agent-hooks-darwin-arm64 \
         agent-hooks-win32-x64-msvc; do
  npm dist-tag add "@responsibleai/$p@$V" "$TAG"
done
```

The same loop with `latest` moves `latest` back when a withdrawn
version held it (`npm deprecate` marks the version; it does not move
the tag). Check with `npm dist-tag ls @responsibleai/agent-hooks`.

Then update the supported-versions table in
[SECURITY.md](SECURITY.md) to the new tag.
