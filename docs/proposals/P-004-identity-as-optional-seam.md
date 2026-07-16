# P-004: Context identity as an optional, pluggable seam

**Status:** **Decided** 2026-07-09 — Option C adopted as recommended:
identity is a pluggable provider seam, default `jcs-sha256`, opt-out
(`null`) permitted but must be stated in the record and any conformance
claim. The three hash-independent survivors (SDK marshalling guards,
SHOULD-level 64-bit string-encoding guidance, tier rename) proceed.
Supersedes most of the P-002 recommendation.
**Raised by:** design review of the P-002 outcome, 2026-07-08.

## The structural observation

P-002 asked "which JSON values may appear in a context that gets
hashed?" and answered with a value-domain constraint (reject
non-I-JSON) imposed on **every context, for every host**. But step
back: why does the core hash contexts at all?

The identity serves exactly two features:

1. **Approval-content binding.** The ApprovalRequest carries the hash
   of the context at escalation time; the resolution echoes it. This
   detects the approve-X-execute-X′ swap (a time-of-check/time-of-use
   attack on the approval channel).
2. **Tamper-evident, payload-free audit.** `input_identity` vs
   `enforced_identity` on the record proves a transform occurred — and
   what bytes were evaluated — without storing the payload. Plus the
   cross-SDK determinism guarantee (golden vectors: same context →
   same hash in all five languages).

Both are valuable. Neither requires the **spec** to mandate *how*
identity is computed. And mandating it means every host inherits the
full I-JSON value-domain problem (64-bit integers, NaN, lone
surrogates — all of P-002) even if it never uses approvals and never
reads the identity fields.

### On the "stateful" framing — a correction that doesn't change the conclusion

The reviewer's instinct was that identity checking "leaks state" into
a library that should be stateless. Precisely: it doesn't. The core is
stateless — `context_identity()` is a pure function, and the
escalation→resolution echo-check happens inside a single `emit()`
activation; no identity is stored across calls. Any cross-time state
(a pending-approvals table for async approval flows) lives in the
host/resolver and would exist under *any* correlation scheme, opaque
IDs included.

The conclusion survives on a different argument: **a mandatory
content-hash makes an optional feature's requirements into everyone's
wire contract.** That is the structural flaw, and it is fixable
without losing the feature.

## Options

### A. Status quo (the P-002 recommendation)

Normative JCS/SHA-256 identity over the closed required+per-point
preimage; core rejects non-I-JSON values fail-closed; hosts
string-encode 64-bit IDs per a normative convention.

Keeps every guarantee; pays for it with deterministic denies on benign
data (snowflake IDs) for **all** hosts — P-002's own recorded
dissent (alarm-fatigue → hosts flip to `evaluate_only`, fail-closed
becomes fail-open in practice).

### B. Remove identity entirely

Approvals bind by a host-supplied opaque `correlation_id`; records
replace the two hashes with a `transformed: bool` flag.

P-002 dissolves — but too much goes with it:

- **Content binding is gone at the contract level.** An opaque ID says
  "this approval answers this request event," not "this approval
  covers these bytes." Every host reinvents content binding — or
  omits it, silently. The consumers of the binding are the human
  approver's UI and the after-the-fact auditor, both *outside* the
  trusted process; they are exactly who a bare correlation ID fails.
- Cross-SDK determinism proof (golden vectors) dies.
- Audit records stop being tamper-evident and lose the ability to
  prove what was evaluated without storing payloads.

### C. Identity as an optional, pluggable seam — **recommended**

The spec treats `context_identity` as an **opaque string** with two
normative rules and nothing else:

1. **Echo rule.** The identity presented in an ApprovalRequest MUST be
   returned unchanged in its resolution, and the emitter MUST treat a
   mismatch as `host_error:approval_identity_mismatch` (deny).
2. **Record rule.** Whatever identity was in effect MUST appear in the
   InterceptionRecord (`input_identity` / `enforced_identity`), or be
   explicitly `null`, in which case the record self-describes as
   carrying **unbound** approvals/audit (`identity_provider: null`).

How the string is computed becomes the host's choice via an
**identity provider** seam:

- **Default provider (shipped, on by default): `jcs-sha256`** — the
  existing RFC 8785 canonicalization + SHA-256 over the closed
  preimage, byte-identical across all five SDKs, pinned by the golden
  vectors. Hosts that do nothing keep every current guarantee.
- **Custom provider:** a host with an exotic value domain (64-bit IDs
  everywhere, binary-in-strings) supplies its own function
  `context → string`. The CTK tests the echo and record rules against
  it; the golden vectors apply only to `jcs-sha256`.
- **Opt-out (`null`):** permitted; the record and any conformance
  claim must say so. Honest absence beats pretend presence.

The record gains one field: `identity_provider: "jcs-sha256" | "<host-id>" | null`.

**What this does to P-002:** the I-JSON question stops being a wire
mandate and becomes the documented contract of the *default provider*:
`jcs-sha256` rejects non-I-JSON input fail-closed (oversized integers,
non-finite floats, lone surrogates) with remediation-detail messages.
Hosts that hit the rejection have three exits, in order of preference:
string-encode 64-bit IDs (still the SHOULD-level guidance), plug a
provider that handles their domain, or opt out visibly. The
deny-storm/alarm-fatigue dissent is answered structurally — nobody is
forced into `evaluate_only` to escape a hasher they never needed.

**Honest cost of C:** "conformant host" no longer implies "identical
identities across SDKs" — that guarantee attaches to the default
provider, not the bar. Conformance-claims language (CLAIMS.md) must
name the provider. Slightly more spec text, one more record field.

## What survives from the P-002 verdict regardless of A/B/C

These stand on grounds independent of hashing — they are
transport-validity and evaluate-what-executes concerns:

1. **SDK marshalling guards.** Contexts must be valid JSON to cross
   the FFI at all. Python `allow_nan=False` (NaN/Infinity produce
   invalid JSON), the TypeScript pre-serialize scan (JS silently turns
   NaN into `null` — a value corruption *before* any provider runs),
   and surrogate handling at the native-binding boundary. Plus
   pinning vectors.
2. **The 64-bit string-encoding guidance (as SHOULD).** In JavaScript,
   `JSON.parse` rounds `9007199254740993` before an interceptor ever
   sees it — the interceptor evaluates a different value than the tool
   executes, hashing or no hashing. The proto3 decimal-string
   convention remains the right guidance for cross-language fidelity;
   under C it is a SHOULD with rationale rather than a MUST enforced
   by core rejection.
3. **The tier rename** (L0–L3 → `required / conditional / optional /
   namespaced`) — orthogonal to this whole question, uncontested,
   should proceed in any case.

## Interaction with P-003

- Under P-003's parallel mode there is a single context snapshot per
  emission — one identity, no escalation-time-binding subtleties (the
  escalation-time identity binding reduces to "hash the snapshot
once").
- Under the three-verdict model an approval resolution is itself a
  verdict; the echo rule stays exactly one line either way.

## Decision needed

- [ ] A (mandatory hash, P-002 verdict) / B (no identity) /
      C (pluggable provider, default `jcs-sha256`)
- [ ] If C: is provider opt-out (`null`) permitted, or is *some*
      provider required?
- [ ] Confirm the independent survivors (marshalling guards, SHOULD
      guidance, tier rename) proceed regardless.
