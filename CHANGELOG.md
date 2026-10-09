# Changelog

User-visible changes to the spec and SDKs. Versioning rules:
[VERSIONING.md](VERSIONING.md).

## Unreleased

- Docs: README rewritten around the contract, the three construction
  paths and the host declaration (`agent-hooks-declaration/1.0`, with
  the version table at `spec/DECLARATION-VERSIONS.md`); every reference
  to other specifications removed from it. New `docs/IMPLEMENTING.md`
  for harness and gateway maintainers: wire contract versus host
  configuration, the declaration document, the surface and the claim,
  host obligations per point, what fails closed, and how to run the
  CTK. `docs/PRODUCTION.md` names the declaration members behind its
  rows. No spec or code change.
- Host declaration document (spec §7.7): a versioned JSON contract,
  `agent-hooks-declaration/1.0`, for host configuration, declared
  surface and interceptor bindings, with one loader behind file, JSON
  and code construction and eleven fail-closed refusal classes
  (`declaration_error:*`, inventoried in `spec/declaration-errors.json`).
  The binding model is open: a kind string plus a kind-specific config,
  resolved by code the host registers. Records gain an optional
  `declaration` member and per-point binding semantics for
  `interceptors_registered`, `verdicts[]` and `decided_by`. New schema
  `spec/schema/host-declaration-1.0.schema.json`, new capability
  `host_declaration`, vectors AH-CTK-120 to AH-CTK-139 and the golden
  file `conformance/golden/declaration.json`. The Rust core implements
  the loader (`HostDeclaration`, `HostRegistry`, `HostSurface`,
  `InterceptionEmitter::from_declaration*`), the FFI gains
  `ah_declaration_versions` and `ah_declaration_resolve`, and the Rust
  reference harness builds every emitter through the loader. The
  contract version is tracked in `spec/DECLARATION-VERSIONS.md`.
  Wire version agent-hooks/0.1 unchanged. Additive.
- Python SDK: the host declaration loader. `HostDeclaration`,
  `HostRegistry`, `HostSurface`, `DeclarationError` and
  `InterceptionEmitter.from_declaration`, `from_declaration_path`,
  `from_declaration_json` and `from_declaration_value`; kind resolvers
  are Python callables; `register` takes `at` for per-point bindings;
  a declaration-built emitter is sealed (`EmitterSealed`). The
  reference harness declares `host_declaration` and builds every
  emitter through the loader, so the Python CTK runs AH-CTK-120 to
  AH-CTK-139. `DECLARATION_VERSION` and
  `SUPPORTED_DECLARATION_VERSIONS` are exported next to
  `SPEC_VERSION`. Additive.
- TypeScript SDK: the host declaration loader (spec §7.7).
  `HostDeclaration` (`fromPath`, `fromJson`, `fromValue`, `builder()`),
  `HostRegistry`, `HostSurface`, `DeclarationError`,
  `InterceptionEmitter.fromDeclaration` and its path, JSON and value
  forms, `emitter.declaration`, `canonicalDeclaration`,
  `DECLARATION_VERSION` and `SUPPORTED_DECLARATION_VERSIONS`.
  `register` takes an `at` set; a declaration-built emitter is sealed
  (`EmitterSealed`); its records carry `declaration`. The napi module
  gains `declarationVersions`, `declarationValidate`,
  `declarationResolve` and `declarationResolveSurface`. The CTK
  `Harness` gains `hostSurface`, `declaration` and `setupDeclared`, the
  `Capability` type is the closed list, and the reference harness
  declares `host_declaration`, builds every emitter through the loader
  and runs AH-CTK-120 to AH-CTK-139 (skip set unchanged). Additive.
- .NET SDK: the host declaration loader (spec §7.7).
  `InterceptionEmitter.FromDeclaration`, `FromDeclarationPath`,
  `FromDeclarationJson` and `FromDeclarationNode` build a sealed emitter
  from a document and a `HostRegistry` of kind resolvers, identity
  providers, approval resolvers and redactors over a `HostSurface`;
  `HostDeclaration.Builder()` is the code path. A refusal is a
  `DeclarationException` with the `declaration_error:*` class, the
  findings and the accepted versions. `Declaration.Version` and
  `Declaration.SupportedVersions` sit next to `Spec.Version`. Records
  carry `Declaration`; `Register` takes an optional point set. The
  binding runs over the two new FFI symbols. The CTK `Capability` enum
  gains `IncrementalOutput` and `HostDeclaration`, `IHarness` gains
  `HostSurface`, `Declaration` and `SetupDeclared`, and the reference
  harness builds every emitter through the loader and runs AH-CTK-120
  to AH-CTK-139. Additive.
- Go SDK: host declaration loader (spec §7.7). `LoadDeclarationPath`,
  `ParseDeclaration`, `DeclarationFromValue` and `DeclarationBuilder`
  feed `NewInterceptionEmitterFromDeclaration` and its path, JSON and
  value forms; `HostRegistry` holds the code surface, kind resolvers
  (Go funcs), identity providers, approval resolvers and redactors;
  refusals are `*DeclarationError` with the eleven classes: nine read
  back from the core's `ah_declaration_resolve`, `unreadable` and
  `binding_rejected` from the Go loader (steps 1 and 11). Records carry
  `declaration`, interceptors bind per point (`RegisterAt`), and a
  declaration-built emitter is sealed. The Go reference harness
  declares `host_declaration`, builds every emitter through the loader
  and runs AH-CTK-120 to AH-CTK-139; its skip manifest is back to the
  four streaming vectors. Additive.
- Spec §7.2 and §10.3: `on_transform_conflict` is consulted by
  `parallel/strictest` only, not by both parallel profiles. The text
  said "parallel profiles"; the core's `with_knob_defaults` and the
  record stamp always treated the knob this way, so this is a wording
  fix with no behaviour change. Clarification.

## 0.1.0-beta.1 — 2026-10-02 — tag `v0.1.0-beta.1`

- **Promote the SDKs and specification maturity from alpha to beta.**
  The wire contract remains `agent-hooks/0.1`; this release does not
  change interception points, context shapes, verdict semantics, or
  composition behavior.
- **Rust: `agent_hooks::EVIDENCE_MAX_BYTES` is public.** The §5.3
  evidence cap (10240 bytes of the RFC 8785 canonical serialization of
  `evidence`) was a private constant, so a consumer that wanted to
  measure evidence before `Verdict::validate` rejected it had to
  hard-code the number. The crate root now re-exports it next to
  `canonical_json`, and a test pins the export to the exact bound
  `validate` enforces. The Python, TypeScript, .NET, and Go SDKs do not
  expose the cap yet; that is a follow-up. Additive.
- **SDKs: `record_host_failure` — a host projection failure is no
  longer recordless.** When the host's own to-wire projection fails
  before a valid `AgentContext` exists (e.g. a tool-call argument
  getter throws at the chat seam), the emitter can now synthesize and
  deliver the fail-closed record itself: a `deny
  host_error:context_invalid` in the §10.3 rejection shape (null
  identities under the declared provider, payload-free type-name/path
  detail, envelope facts the host still knows). All five SDKs
  (`record_host_failure` / `recordHostFailure` / `RecordHostFailure`);
  §10.3 gains the "Host projection failure" host obligation and §11
  lists it as a synthesis site. No new reserved reason and no record
  shape change — additive.
- **Microsoft Agent Framework: full §13.1 conformance claim.** The MAF row upgrades from partial cross-validation (33/47) to a conformance claim — 47/47 applicable vectors pass on the declared surface (`tool_seam_host_error: terminate`, `buffered_output: true` → 4 capability-gated skips); report and harness updated in `conformance/claims/maf/`.
- **CTK: declared `tool_seam_host_error` posture (§13.1).** A harness declares `continue` (default) or `terminate`, and `expect.run_outcome_by_posture` resolves the 13 tool-seam `host_error:*` vectors to the single outcome that declared surface must produce — the §6.2 terminate clause is now claimable (#68).
- **CTK: AH-CTK-100 asserts §6.1 substance, not transcript cosmetics.** New `context_must_contain`/`context_must_not_contain` interception assertions pin non-incorporation of the denied tool result and the deny surfacing to the model in some form, leaving message layout and payload shape to the host (#69).
- **The §12.1 incremental exception is CTK-testable.** The vectors
  the alpha.5 entry below left as future work exist: a
  `streaming/incremental` part (`AH-CTK-110`–`AH-CTK-113`) exercises
  the exception's four conditions against a chunked mock stream —
  release under covering verdicts, a terminating deny that withholds
  the unreleased remainder, uncleared residue failing closed with
  `host_error:streaming_unsupported`, and §6.1-gated durability. The
  vector grammar grows `respond.stream`/`respond.stream_truncated` and
  `expect.released_output`/`expect.persisted_must_not_contain`; the
  part is gated on the new `incremental_output` capability, so every
  buffering host (`buffered_output: true`, the default) skips it —
  the vectors are additive and no existing declared surface changes.
  Reference-harness skip manifests across the five SDKs pin the new
  skips. Wire version unchanged (`agent-hooks/0.1`); the specification
  maturity label advances to `0.1.0-beta`.

## 0.1.0-alpha.5 — tag `v0.1.0-alpha.5`

- **Python: `Verdict.allow()` constructor sugar,** completing the
  cross-SDK vocabulary: Rust `Verdict::allow`, TypeScript
  `Verdict.allow()`, .NET `Verdict.Allow` and Go `AllowVerdict`
  already existed; Python exposed only the module-level `ALLOW`
  constant. The Python README interceptor example now uses the sugar
  throughout.
- **npm: prebuilt `linux-arm64-gnu` binary.** The TypeScript loader
  gains a fifth platform package
  (`@responsibleai/agent-hooks-linux-arm64-gnu`,
  `aarch64-unknown-linux-gnu`), built natively on the arm64 hosted
  runner. musl (Alpine) targets remain unshipped — the pipeline
  builds on native runners only, and `linux-x64-musl` does not ship
  either; a musl pair can land together later.
- **§12.1 admits incremental mediation.** Previously a host had to
  assemble the complete response before `post_model_call` with no
  exception, so a host mediating a stream incrementally (e.g. per ACS
  §18.1) could not make a coherent conformance claim. §12.1 now
  carries an exception: a host declaring `buffered_output: false` MAY
  evaluate incrementally under a bounded-exposure accounting
  discipline (verdict-covered release, terminating deny that withholds
  the unreleased remainder, fail-closed residue at end of stream,
  §6.1-gated durability covering withheld-but-permitted content). The
  capability stays declaration-only: the §12.1a declaration and §13.3
  claim MUST state the exposure bound, and conformance vectors for the
  accounting discipline are future work. §12.1 also now distinguishes
  an errored model call (handled per §6.1, no `post_model_call`) from
  the `stream_incomplete` shape, which is for hosts that cannot
  buffer. Additive; no version-surface change.
- **§12.1a defines the caller and pins released-content identity.**
  The caller is any consumer outside the host's enforcement boundary,
  observers, callbacks, and preview channels included, and the content
  released once the verdict permits MUST be the verdicted
  (post-transform) content — a host MUST NOT rewrite content between
  the verdict and its release.

## 0.1.0-alpha.4 — tag `v0.1.0-alpha.4`

- **.NET: the NuGet package ships the native library.** The nupkg now
  bundles the FFI cdylib for four runtime identifiers
  (`runtimes/{linux-x64,osx-x64,osx-arm64,win-x64}/native/`), so
  package consumers no longer build `agent_hooks_ffi` from source. The
  release pipeline cross-builds all four targets and asserts their
  presence in the packed package.
- **`deny` constructor sugar in every SDK.** A plain, final deny
  (reason + optional message, no `approval` block) alongside the
  existing `warn`/`escalate` sugar: Rust `Verdict::deny`, Python
  `Verdict.deny`, TypeScript `Verdict.deny`, .NET `Verdict.Deny`, and
  Go `DenyVerdict` (suffixed like `AllowVerdict` because `Deny` is the
  `Decision` constant). (Merged after the alpha.3 tag; previously
  listed under alpha.3 in error.)
- **Go: `Interceptor.OnHook` renamed to `Intercept`,** aligning the
  interceptor protocol method with Python/TypeScript `intercept` and
  .NET `InterceptAsync`. Clean rename, no alias (pre-release; drafts
  within the 0.1 window are not compatibility-bound). (Merged after
  the alpha.3 tag; previously listed under alpha.3 in error.)
- Registry publishing is trusted-publishing-only on every registry;
  the one-time bootstrap token paths are removed from the release
  workflow.

## 0.1.0-alpha.3

Additive; driven by the first external consumer of the contract (a
policy decision runtime implementing the interceptor side).

- **Rust: out-of-crate CTK harnesses.** `agent_hooks::ctk` re-exports
  every type the `Harness` trait signatures reference (`RunRecord`,
  `VectorResult`, `IdentityPair`) plus `async_trait`, so third-party
  hosts can implement the trait and run the corpus under their own
  adapter name. A compile-and-run test pins the seam.
- **Rust: `InterceptionPoint` derives `Ord`/`PartialOrd`** (declaration
  order = the §3 lifecycle order, documented on the enum) **and
  implements `Display`** (wire name). The other SDKs already expose
  wire-string point types and needed no change.
- **Docs: decision runtimes behind an interceptor.** Crate-level
  rustdoc and the README now state the reason-namespace convention:
  engine-internal failures surface as fail-closed denies under the
  engine's own namespace (`runtime_error:*` by convention), never
  `host_error:*`, which is host-reserved (§11) and rejected by §5
  validation.

## 0.1.0-alpha.2 — tag `v0.1.0-alpha.2`

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
