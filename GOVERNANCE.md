# Governance

## Maintainers

| Role | Who |
| --- | --- |
| Maintainer, decision authority | [@MohammadHaroonAbuomar](https://github.com/MohammadHaroonAbuomar) |

The project is currently single-maintainer. A second code owner for
`/spec/` and `/conformance/` is an open goal before external adapters
file conformance claims; until then, single-maintainer decision-making
is a documented limitation, not an implicit norm.

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
  releases are tag-driven through the release workflow (provenance
  attestation, SBOM, OIDC trusted publishing). User-visible changes
  are recorded in [CHANGELOG.md](CHANGELOG.md).
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
