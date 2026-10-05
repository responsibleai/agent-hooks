# Governance

## Maintainers

| Role | Who |
| --- | --- |
| Maintainer, decision authority | [@MohammadHaroonAbuomar](https://github.com/MohammadHaroonAbuomar) |
| Code owner | [@CaitieM20](https://github.com/CaitieM20) |

`.github/CODEOWNERS` names both as owners of every path, including
`/spec/` and `/conformance/`. `main` requires one approving review
from a code owner. The maintainer holds a review bypass on `main`,
and PRs opened by the maintainer currently merge under that bypass
with no review, whatever they change (spec, SDK code, releases,
housekeeping). The required status checks still apply. A second
reviewer for maintainer PRs is an open item. Other repository
collaborators hold access roles only and are not listed here.

## How decisions are made

- **Design decisions** in the classes listed in
  [docs/proposals/README.md](docs/proposals/README.md) require a
  written proposal (P-NNN) decided by the maintainers. Everything else
  is decided by ordinary PR review.
- **Change gating:** `main` is protected — every change lands by PR
  with all required status checks (build/test across the five SDKs,
  schema drift, CodeQL) passing; linear history; no force pushes.
  Review requirements follow `.github/CODEOWNERS`.
- **Versioning and release:** rules in [VERSIONING.md](VERSIONING.md);
  procedure in [RELEASING.md](RELEASING.md). Releases are tag-driven
  through the release workflow (provenance attestation, SBOM, OIDC
  trusted publishing). User-visible changes are recorded in
  [CHANGELOG.md](CHANGELOG.md).
- **Conformance claims** from third parties are accepted per the
  process in [conformance/CLAIMS.md](conformance/CLAIMS.md).

## Security response

Vulnerabilities are reported privately per [SECURITY.md](SECURITY.md)
(GitHub security advisories; acknowledgment target three business
days). Security fixes may bypass the proposal review window but not
the required status checks.

## Succession

If the maintainer becomes unavailable, ownership transfers within the
`responsibleai` GitHub organization; the organization owners hold
administrative access to the repository and the registry publishing
configurations (all registries use OIDC trusted publishing bound to
this repository, so no personal tokens need transferring).
