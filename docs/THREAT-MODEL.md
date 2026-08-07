# Threat model

> **Status:** Draft, refreshed 2026-07-15 against the P-003/P-004
> contract (three-verdict model, composition profiles, identity
> provider seam) including the approval-redaction and record-sink
> mechanisms. Companion to [`SECURITY.md`](../SECURITY.md) and
> [spec §1.4](../spec/AGENT-HOOKS-0.1.md#14-trust-model-and-non-goals).
> Every threat row names its mitigation (spec clause) and how that
> mitigation is verified today. Rows marked **GAP** are known-untested;
> they are collected in [§4](#4-gaps) with their current status. Honest GAP marking is the point of this document.

## 1. Assets and trust boundaries

| Asset | Description |
| --- | --- |
| Agent actions | Tool invocations, model calls, emitted output — the things a combined verdict permits or halts |
| `AgentContext` payloads | May contain user PII, secrets in tool arguments, model output |
| Interception records | The audit trail: combined verdict + identities + ordering (`session_id`, `sequence`, `decided_by`) + the composition block |
| Context identities | Provider-produced bindings used for approval (§9, §10) — content-derived under the default `jcs-sha256` provider |

Trust boundaries (normative statement: spec §1.4):

- **Host: trusted.** Every guarantee is a MUST on the host; a
  non-cooperative host voids the contract and is out of scope.
- **The identity provider: trusted.** In-process, raw-context access,
  and the sole source of the value approval binding (§9) and audit
  correlation rest on. §10.1 gives it enforced name rules, fail-closed
  failure semantics, and a claim-level content-derived disclosure —
  nothing detects a malicious or non-deterministic provider.
- **Interceptors and the approval resolver: trusted.** In-process,
  full data access, registration grants write authority over every
  action (§1.4).
- **Adversary: untrusted data** flowing through the trusted host —
  external input, model output, tool results — and the supply chain
  around the artefacts themselves.

## 2. Threat catalog

Verification key: `AH-CTK-NNN` = conformance vector
(`conformance/vectors/`); file paths = unit/integration tests;
`golden` = `conformance/golden/identity.json` asserted in all five
SDKs; **GAP** = no automated verification exists.

| ID | Threat | STRIDE | Scope | Mitigation | Verification |
| --- | --- | --- | --- | --- | --- |
| TM-01 | Prompt-injection-driven tool abuse: untrusted content steers the model into a harmful tool call | E | In | Interceptor `deny`/`transform` at `pre_tool_call` (§3, §6); block propagation §6.2 | AH-CTK-010 (deny halts tool), AH-CTK-020 (transform rewrites args), AH-CTK-011/012 (deny at input/output) |
| TM-02 | Verdict forgery / reserved-reason spoofing: an interceptor emits `host_error:*` or a malformed verdict to impersonate host failures or smuggle state | S, T | In | §5 validation gate: `reason` MUST NOT start `host_error:`; `approval` only on deny; transform-body shape rules; every interceptor and resolver return crosses the gate (§7, §9) | `sdk/rust/core/src/verdict.rs` from_wire tests; AH-CTK-071 (malformed verdict fails closed); `sdk/python/tests/test_types.py` |
| TM-03 | Transform escaping `$target`: a transform path rooted elsewhere rewrites the snapshot, envelope, or host state | T, E | In | §5.2: path MUST be `$target`-rooted; foreign roots fail closed `host_error:transform_target_forbidden`; §4.3 forbids transform at startup/shutdown | `sdk/rust/core/src/path.rs` tests (foreign_root_forbidden); `sdk/python/tests/test_path.py`; AH-CTK-021 (alias), AH-CTK-022 (forbidden point) |
| TM-04 | Approval replay / identity tampering: a resolution bound to a different action is accepted, or the approved action drifts before execution | S, T | In | §9 echo rule: resolution `context_identity` MUST equal the request's, else `host_error:approval_identity_mismatch`; request identity computed at consultation time (§9) | AH-CTK-030/031/032 (happy paths), AH-CTK-072 (echo-rule violation). Content binding applies when the declared provider is content-derived (`jcs-sha256` default); `identity_provider: null` claims are identity-unbound by declaration and MUST say so (§10.1, §13.3) |
| TM-05 | TOCTOU via interceptor mutation: an interceptor mutates the context object it received to alter enforcement without returning a transform | T | In | §7: each interceptor receives its own copy; mutation MUST NOT affect enforcement. `input_identity` computed before dispatch; parallel profiles additionally give every interceptor the same untransformed snapshot (§7.5) | Code-level in all five emitters (deep copy per interceptor); AH-CTK-084 (parallel snapshot isolation). Dedicated adversarial *mutate* fault in the vector grammar: **GAP** |
| TM-06 | Fail-open on interceptor crash or hang | D, E | In | §6.3: raise/timeout/non-conformant → `deny` with `host_error:interceptor_failed`/`interceptor_timeout`; §7 RECOMMENDED 5000 ms timeout | Fault vectors AH-CTK-070 (raise), AH-CTK-071 (malformed), AH-CTK-073 (resolver raises), AH-CTK-074 (deny at startup). Timeout enforced in the Python/TS/.NET/Go emitters (`test_timeouts.py` and per-SDK equivalents) and — with the `tokio-timeout` feature — emitter-owned in Rust (`set_timeout`). Panic isolation: interceptor/resolver panics substitute the §6.3/§9 failure deny in the Rust emitter (`call_isolated`), Go `recover()`s, and the C ABI runs under `catch_unwind` |
| TM-07 | Zero-interceptor bypass: an emitter with nothing registered silently allows everything | E | In | §7: `enforce`-mode emission with zero interceptors fails closed `host_error:no_interceptor` | AH-CTK-061 |
| TM-08 | Identity collision via canonicalization divergence: two SDKs (or two values) canonicalize differently, breaking approval binding and audit correlation | S, R | In | §10.2 RFC 8785 via single Rust core; closed required+conditional preimage; all bindings delegate. Non-I-JSON values fail closed: in-memory check + raw-text scan for integer literals serde-class parsers coerce (beyond u64/i64) | `golden` (11 fixtures asserted in Rust/Python/TS/.NET/Go); `sdk/rust/core/src/canonical.rs` JCS + scan tests; AH-CTK-090 (beyond 2⁵³), AH-CTK-091 (beyond u64, `bigint_json` harnesses) |
| TM-09 | Audit-record payload leakage: records or failure messages exfiltrate context data into audit storage | I | In | §10.3 payload-free verdict projection (`transform.value` dropped, messages truncated); failure verdicts carry exception *type* only (including Go panic recovery); host-synthesized remediation details are value-free by rule (§6.3/§14) — the I-JSON and envelope rejections name the path and constraint, never the value | Record shape: `spec/schema/interception-record.schema.json`; projection tests per SDK; `canonical.rs` value-free-detail tests (`envelope_details_are_value_free`, raw-scan not-contains assertions); Go panic tests. Residual: an interceptor can still deliberately place payload in its own bounded `reason` |
| TM-10 | Exfiltration/SSRF via `evidence.verification_pointers`: attacker-supplied URIs dereferenced by host or audit tooling | I | In (host obligation) | §5.3/§14: host MUST NOT dereference; propagate opaque | **GAP** — prose only; no test, no scheme allow-list guidance |
| TM-11 | Streaming egress before interception: partial model output reaches the caller before `output` (or `post_model_call`) is evaluated | E, I | In | §12.1 covers model→host streaming (assemble before `post_model_call`, else fail closed `host_error:streaming_unsupported`; a `buffered_output: false` host MAY instead mediate incrementally under the §12.1 bounded-exposure exception, whose claim states the exposure bound). §12.1a covers host→caller egress: buffer until the `output` combined verdict permits (MUST), or declare `buffered_output: false` — conformant, but the claim MUST state that a deny at `output` cannot retract streamed content (§13.3) | §12.1 negative path: **GAP** (no vector). §12.1a is declaration-only by construction — mocked CTK I/O cannot exercise egress; visibility is via the claim, not a vector |
| TM-12 | Resource exhaustion: unbounded `target`/`messages` canonicalized, hashed, and deep-copied per interceptor per emission — multiplied by parallel profiles' per-interceptor snapshots | D | In | §12.3 RECOMMENDED bounds (5 MiB / depth 128) with a normative failure mode: breach of whatever limit the host or core enforces MUST yield `deny host_error:context_invalid` and MUST NOT crash or truncate; the identity path enforces the depth default fail-closed. The record itself is bounded: §10.3 payload-free projection (transform.value dropped, messages truncated) plus the §5.3 10240-byte evidence cap | Depth: `sdk/rust/core/src/canonical.rs` depth tests. Evidence cap: AH-CTK-092 + per-SDK gate tests. Projection: AH-CTK-093. Serialized-size default: still host-side (RECOMMENDED, not emitter-enforced) |
| TM-13 | Label-flow loss: `result_labels` from non-winning permit verdicts discarded, or §5.4 persistence/resurfacing not honoured | I | In | §7.3 unions: the combined verdict carries the first-seen-ordered label union across every permit verdict in the emission (all profiles, including approval substitutions) | Union half: AH-CTK-086 + per-SDK union tests. §5.4 persistence/`source_labels` resurfacing across emissions: **GAP** — no vector |
| TM-14 | Supply-chain compromise of the artefacts: squatted names, mutable CI actions, unpinned deps | T, S | In | Distribution `agent-hooks-sdk` published on PyPI/crates.io (squatted `agent-hooks` avoided); GitHub Actions pinned by commit SHA; `Cargo.lock` committed; CodeQL enabled | Name claims live (registry state); pins in `.github/workflows/*.yml`. Lockfile enforcement (`--locked` CI builds), dependency automation (Dependabot across all ecosystems), and SBOM + provenance attestation in the release pipeline are in place. Published a1 alphas implement a superseded draft (see SECURITY.md) |
| TM-15 | Host bypass of interception points: framework code paths (direct tool execution, plugins, background tasks) never reach an emitter | E | **Out** | §1.4: no complete-mediation claim; CLAIMS.md requires production-path attestation | Explicitly disclaimed; unverifiable by the CTK by design |
| TM-16 | Malicious or compromised interceptor/resolver: rewrites actions, exfiltrates context | T, I, E | **Out** | §1.4: registration = write authority; interceptors fully trusted; authentication out of scope. An interceptor can also blind its successors via transform in sequential profiles (§14) — parallel profiles remove that vector | Explicitly disclaimed |
| TM-17 | Hostile host: skips points, ignores verdicts, misreports mode | All | **Out** | §1.4: host inside trust boundary; cooperative contract | Explicitly disclaimed |
| TM-18 | Approval scope widening: one permit resolution lifts an *aggregate* deny — every liftable deny in a `run_all` emission, or the unioned conflict/disagreement of a parallel profile — so a single approver decision overrides N controls' concerns at once | E | In | §7.4/§7.5 gates: consultation at most once per emission and only when **every** deny returned is liftable (one plain deny blocks lifting); the record's `verdicts[]` summary preserves each control's individual decision | AH-CTK-082 (single consult), AH-CTK-083 (plain deny blocks consult), AH-CTK-086 (union carried to substitution). Residual: whether approval UIs must display the full deny set is host guidance only — **GAP** (no spec clause) |
| TM-19 | Control skipping after approval: under `sequential/first_deny` + `on_approval: "stop"`, interceptors after the escalating one never run for that emission | E | In | §7.4: the skip is never silent — `fold_truncated: true` + `resolved_by: "approval"` MUST appear on the record; §14 RECOMMENDS registering must-run controls before escalation-capable ones; `run_all`/parallel profiles avoid the skip structurally | AH-CTK-030 (asserts `fold_truncated`/`resolved_by`), AH-CTK-080 (resume variant). Residual (accepted for 0.1, P-003): a must-run control needing *post-transform* context cannot be ordered before an escalating interceptor |
| TM-20 | Synthesized-deny approval routing: with `on_transform_conflict`/`on_disagreement: "approval"`, the host manufactures a liftable deny (`decided_by: null`) and a resolver — possibly automated — can lift a conflict no interceptor chose to permit | E, T | In | §7.5: synthesis policies are host configuration from a closed set; the synthesized deny crosses the same §9 seam (echo rule, §5 gate on the resolution); reason is a reserved `host_error:*` string so the approver sees it is host-synthesized | AH-CTK-085/086 (conflict, both knobs), AH-CTK-087/088 (disagreement, both knobs) |
| TM-21 | Control-plane crash as denial of service: malformed or adversarial content panics the core and kills the host process through the C ABI, or a panicking interceptor kills a Go host | D | In | Every `ah_*` entry point runs under `catch_unwind` (panic → error result, process survives); marshalling failures are explicit errors, never silent coercions; Go emitter `recover()`s interceptor/resolver panics into §6.3 denies | `sdk/rust/ffi/src/lib.rs` tests (invalid UTF-8, null pointer, big-int through the ABI); `sdk/go/agenthooks/emitter_test.go` panic tests |
| TM-22 | Approval-channel payload exposure: the `ApprovalRequest` ships the full context to the resolver (and its UI/transport) by default, and a broken redactor could leak or bind the approval to content the approver never saw | I | In | §9: `request.context` MAY be redacted; the emitter redaction seam computes the request identity over the **redacted** context, so the echo-rule binding covers exactly what the approver saw; a raising/panicking redactor fails closed (`host_error:approval_resolver_failed`) | AH-CTK-099 (redaction + recomputed echo) + per-SDK seam tests. Residual: redaction policy content is host-defined; `extensions.<host>.redacted` disclosure is a SHOULD (§14) |
| TM-23 | Audit-record loss: retention overflow or a failing record sink silently truncates the trail the payload-free design exists to preserve | R | In | Emitter retention is drop-oldest with a monotonic `records_dropped` counter (never silent); sink callback failures are swallowed **by design** — audit transport must not alter control flow (§6) — so sink health is a host monitoring obligation; `sequence` totality (§12.2) makes any loss detectable downstream | Per-SDK sink/retention tests (PR2 suite). Residual: a host that neither drains the sink nor watches `records_dropped` loses records knowingly — alerting guidance in docs/OPERATIONS.md §3 |
| TM-24 | Identity confirmation oracle / hash-of-PII: `jcs-sha256` identities are unsalted deterministic hashes of the full required+conditional projection (target, messages, tool args) — anyone holding a candidate context can confirm it produced a recorded identity, and hashes of personal data generally remain personal data under GDPR-style regimes | I | In (by declaration) | Deliberate design property of the default provider (§10.2): determinism is what makes approval binding and the golden vectors work. Deployments needing non-linkable or non-confirmable records declare a keyed custom provider via the §10.1 seam (HMAC-SHA-256 under a host key; spec RECOMMENDS the `hmac-sha256-<key-id>` naming convention so claims stay comparable) — the echo and record rules still apply | §14 bullet; §10.1 provider-seam text. Residual: key management for a keyed provider is a host concern; the default remains an oracle by design and the choice is visible in every record's `identity_provider` field |

## 3. Out of scope

Mirroring spec §1.4 — this contract does **not** defend against or
provide:

- A hostile or buggy host (TM-17): no mechanism detects skipped
  interception points, ignored verdicts, or misreported enforcement
  mode.
- Malicious interceptors or resolvers (TM-16): they are inside the
  trust boundary.
- Complete mediation (TM-15): coverage of the eight points depends on
  the host adapter.
- Sandboxing, process isolation, interceptor authentication, or
  registration authorization.
- Security certification via conformance: the CTK is cooperative-path
  testing against mocks, not adversarial testing.

## 4. Gaps

Every **GAP** above, with its current status:

| Gap | Threat rows | Status |
| --- | --- | --- |
| No adversarial *mutate* fault in the vector grammar (interceptor mutates its copy in place) | TM-05 | open (fault-grammar extension) |
| No systematic test that every failure path keeps verdict messages payload-free | TM-09 | partially closed (core value-free-detail tests); per-SDK sweep remains |
| `verification_pointers` no-dereference is prose-only; no test or scheme guidance | TM-10 | open (SSRF guidance) |
| §12.1 streaming fail-closed path untested (no vector) | TM-11 | vector backlog — the §12.1a egress rule itself is decided and normative |
| No serialized-size bound enforced by any emitter (depth is enforced on the identity path; failure mode on breach is now normative §12.3) | TM-12 | RECOMMENDED default stays host-tunable by decision (2026-07-11) |
| §5.4 `result_labels` persistence/`source_labels` resurfacing across emissions untested | TM-13 | open (§5.4 vector) |
| Lockfile enforcement, dependency automation, SBOM/signing/provenance | TM-14 | closed (`--locked` CI, Dependabot, SBOM/provenance in the release pipeline) |
| Approval-UI display obligations for aggregate lifts unspecified | TM-18 | open (needs a spec clause or explicit non-goal) |
