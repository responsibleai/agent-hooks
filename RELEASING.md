# Releasing

One root tag `vX.Y.Z[-pre.N]` releases the spec and all five SDKs
together ([VERSIONING.md](VERSIONING.md)). The release workflow
(`.github/workflows/release.yml`) does the publishing. Its header
describes the one-time trusted-publisher setup per registry; all
registries use OIDC, no tokens. Publish jobs run in the `release`
environment.

## Before the tag

1. Bump the version on every surface through one PR, with a
   `CHANGELOG.md` entry that names the tag:
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

   When the release publishes a new specification version, cut the
   version folder first ([Cut a specification
   version](#cut-a-specification-version)).

   Regenerate `sdk/typescript/binding.js` after the bump (`npm run
   build:native` in `sdk/typescript`); the napi version strings it
   embeds come from `package.json`, and the CI `typescript` job fails
   on drift.
   Run `python3 scripts/check-version-consistency.py`; the CI `lint`
   job runs the same check.
   Add a row for the tag to the SDK-release table in
   `VERSIONING.md` when the accepted host declaration versions or the
   current one change (spec §7.7.2); the same script checks that a row
   there accepts the current version. SDK development tracks
   `spec/draft/`; the tag names the specification version it ships
   against ([VERSIONING.md](VERSIONING.md#specification-folders)).
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

### Windows FFI hardening

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

## Cut a specification version

A specification version is a frozen copy of `spec/draft/`. Cut it in
one pull request, merged before the tag that ships it. `<X.Y.Z>` is the
new folder and `<previous>` the folder it supersedes.

1. Copy the draft: `cp -r spec/draft spec/<X.Y.Z>`.
2. In the copy, replace every `spec/draft/` self-reference with
   `spec/<X.Y.Z>/` (`grep -rl 'spec/draft' spec/<X.Y.Z>`), delete the
   draft banner at the top of `AGENT-HOOKS-*.md`, and set its header
   line to

   ```markdown
   > **Status:** Released · **Version:** `X.Y.Z` · **Date:** YYYY-MM-DD
   ```

   Nothing else in the copy changes.
3. In `spec/draft/AGENT-HOOKS-*.md`, point the draft banner's link at
   the new folder and reword it to `The latest released specification
   is [X.Y.Z](../X.Y.Z/AGENT-HOOKS-A.B.md).`
4. In `spec/README.md`, add the row for `<X.Y.Z>` with the status
   "Latest release" and change the `<previous>` row to "Superseded".
   In `README.md`,
   point the "Read next" sentence at the new folder and drop the beta
   snapshot wording.
5. Link sweep: prose links outside `spec/` cite the current version folder
   (`grep -rn 'spec/<previous>/' --exclude-dir=spec --exclude-dir=node_modules --exclude-dir=target .`).
   Move each to `spec/<X.Y.Z>/` unless the document cites the older
   text on purpose. Machine consumers (CI steps, the Python mirror, the
   Rust tests, the version script) read `spec/draft/` and do not move.
6. The `$id` path. Every generated schema carries a `$id` under
   `https://responsibleai.github.io/agent-hooks/schema/vX.Y/`, set by
   `ID_BASE` in `sdk/typescript/scripts/generate-schemas.mts`. A
   published path is immutable: two versions may share one only when
   every file under it is byte-identical, and the site staging fails
   otherwise. So when the draft changed any schema since `<previous>`,
   set `ID_BASE` to the new wire minor and regenerate the draft before
   step 1. The site itself needs no edit: the `pages` workflow publishes
   every version folder, derives each bundle's schema URL path from its
   `$id`, and lists the versions in the navigation. When the path
   changed, confirm the new `schema/vX.Y/` directory is in the built
   site. `conformance/vectors.schema.json` is not part of a bundle; it
   is published from the working tree at its own `$id` path.
7. `CHANGELOG.md`: name the specification version in the entry for
   the tag.
8. Run the checks that read the new folder; the `lint`,
   `schema-lint`, `typescript`, `change-class` and `pages` jobs run
   the same commands (`ajv` is `ajv-cli`, installed as in `ci.yml`):

   ```bash
   python3 scripts/check-spec-versions.py
   python3 scripts/check-released-specs-immutable.py origin/main HEAD
   python3 scripts/check-version-consistency.py
   python3 scripts/check-file-headers.py
   python3 -m unittest discover -s scripts -p "test_*.py"
   python3 scripts/stage-docs-site.py
   for d in spec/*/; do
     ajv validate --spec=draft2020 -c ajv-formats -s conformance/vectors.schema.json \
       -r "${d}schema/generated/*.schema.json" \
       -r "${d}schema/generated/strict-contexts/*.schema.json" \
       -d 'conformance/vectors/*.json'
   done
   cd sdk/typescript && npm ci
   node scripts/check-schema-examples.mjs
   npx tsc -p ../../spec/<X.Y.Z>/schema/src/tsconfig.json
   npx tsx scripts/generate-schemas.mts --check --spec <X.Y.Z>
   ```

   The new folder passes the released-folder guard because it did not
   exist on `main`; after the merge it is frozen, and only new regular
   `.json` files under its `schema/examples/<Type>/` may be added.

## Tag

Tag the merged version-bump commit on `main` and push the tag. Only
repository admins and maintainers can create `v*` tags (ruleset
`release-tags-restricted`). The push starts the release workflow.

```bash
git tag -s v<version> -m "agent-hooks <version>"
git push origin v<version>
```

## What the tag run publishes

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

## Go module tag

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

## After the release

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
