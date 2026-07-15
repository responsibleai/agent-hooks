# Changelog

User-visible changes to the spec and SDKs. Versioning rules:
[VERSIONING.md](VERSIONING.md).

## 0.1.0-alpha.2 — unreleased (pending tag `v0.1.0-alpha.2`)

Contract redesign relative to alpha.1 (breaking; the spec remains
`agent-hooks/0.1` — pre-release drafts within the 0.1 window are not
compatibility-bound until the first spec tag):

- **Three-verdict model** (P-003): `allow` / `deny` / `transform`.
  `warn` became `allow` + `warnings[]`; `escalate` became a **liftable
  deny** (`deny` + `approval` block) — fail-closed by construction.
- **Composition profiles** (P-003): host-declared, closed set —
  `sequential/first_deny` (`on_approval: stop|resume`),
  `sequential/run_all`, `parallel/strictest`, `parallel/unanimous` —
  recorded on every emission; fixed severity order; §7.3 warning/label
  unions.
- **Identity provider seam** (P-004): `jcs-sha256` default (RFC 8785 +
  SHA-256, fail-closed I-JSON domain), custom or `null` permitted
  under echo + record rules; JCS serializer vendored into the core.
- **InterceptionRecord**: payload-free verdict projection
  (`transform.value` dropped, messages truncated), `composition`
  block, `verdicts[]` summary, `decided_by`, `fold_truncated`,
  `resolved_by`, `identity_provider`; record sink + drop-oldest
  retention with `records_dropped`.
- **Approval seam**: escalation-time identity binding, byte-exact echo
  rule, redaction seam (request identity computed over the redacted
  context), resolver-less liftable denies stand without error.
- **Value domain** (§4.4): reject-never-normalize; big-integer
  rejection beyond ±(2⁵³−1) including raw-literal scan beyond u64;
  NaN/surrogate marshalling guards in every SDK.
- **Enforcement hardening**: `catch_unwind` on the entire C ABI,
  Go panic recovery, Rust panic isolation + opt-in `tokio-timeout`,
  nesting-depth caps, 10240-byte evidence cap, streaming-egress rule
  (§12.1a) with the `buffered_output` capability.
- **Conformance**: 36+ vectors with per-part reporting (tiers
  removed), golden identity fixtures, declared-surface claims.
- **Distribution**: per-SDK READMEs with trust-model statements;
  tag-driven release pipeline with SBOM + provenance; OIDC trusted
  publishing on all four registries; supply-chain pinning
  (`--locked`, lockfiles, pinned actions, Dependabot).

## 0.1.0-alpha.1 — 2026-07-08 (superseded)

Initial extraction from the Agent Control Specification: eight
interception points, five-verdict draft contract, tiered
`AgentContext`, RFC 8785 identity, initial CTK. Published to PyPI
(`agent-hooks-sdk 0.1.0a1`) and crates.io
(`agent-hooks-sdk 0.1.0-alpha.1`); both implement the superseded
draft — do not use (see SECURITY.md supported versions).
