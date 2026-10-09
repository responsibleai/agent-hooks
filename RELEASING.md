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

   The `Version` line in `spec/AGENT-HOOKS-0.1.md` carries the stage
   (`0.1.0-alpha`, `0.1.0-beta`), not the tag, and changes only when
   the stage changes.

   Regenerate `sdk/typescript/binding.js` after the bump (`npm run
   build:native` in `sdk/typescript`); the napi version strings it
   embeds come from `package.json`, and the CI `typescript` job fails
   on drift.
   Run `python3 scripts/check-version-consistency.py`; the CI `lint`
   job runs the same check.
   Add a row for the tag to the SDK-release table in
   `spec/DECLARATION-VERSIONS.md` when the accepted host declaration
   versions or the current one change (spec §7.7.2); the same script
   checks that the current version has a row.
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
  `@responsibleai/agent-hooks-<platform>`. Any pre-release version
  (one with a `-`, so betas too) publishes under the `alpha` dist-tag;
  stable versions under `latest`.
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

Check the npm dist-tags. The workflow moves only `alpha`; `latest`
stays where it was, so a plain `npm install @responsibleai/agent-hooks`
keeps installing the previous release until `latest` is moved by hand
on the loader and the five platform packages (`npm dist-tag add`, from
an npm login with 2FA; the step above). Both tags sit on
`0.1.0-beta.1` since 2026-10-05.

Then update the supported-versions table in
[SECURITY.md](SECURITY.md) to the new tag.
