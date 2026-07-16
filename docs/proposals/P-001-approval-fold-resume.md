# P-001: What happens to the fold after an approved escalation?

**Status:** Superseded by
[P-003](P-003-verdict-algebra-and-composition.md) (decided 2026-07-09).
Its "approval-final" recommendation survives as the
`sequential/first_deny` profile with `on_approval: stop`; fold-resume
survives as `on_approval: resume`; the whole dilemma became a one-bit
host configuration under the three-verdict model. The
`fold_truncated` / `resolved_by` audit fields carry over.
**Raised by:** 2026-07-07 architectural review; flagged as a
design gap in review discussion.

## The gap

§7.1 dispatch is a sequential fold: interceptors run in registration
order; the first block verdict short-circuits. `escalate` is a block
verdict, so when interceptor *k* of *n* escalates, interceptors
*k+1..n* are never invoked. If the resolver then **approves**, the
action proceeds — and the interceptors after *k* never saw the context
at all.

Concretely: with registration order `[policy-engine, egress-guard]`, a
human approving the policy engine's escalation silently disables the
egress guard for that action. Nothing in the record reveals this.

The gap is structural, not an implementation bug: the spec never says
whether approval terminates the fold or suspends it.

## Options

### A. Approval is final (current behaviour)

The resolver's verdict replaces the escalating interceptor's verdict
and the emission completes; interceptors after *k* are skipped.

| Pros | Cons |
| --- | --- |
| Simple: one resolver call, no re-entry state. | Registration order becomes a security decision nobody documents: later interceptors are silently bypassable via any earlier escalate+approve. |
| Human decision is authoritative — no machine can override an explicit approval. | An interceptor can *deliberately* escalate to launder an action past its successors (a malicious/buggy interceptor gains bypass power). |
| Matches "approval binds to the action" (§9 identity binding is coherent). | Defense-in-depth is only as deep as the first escalation. |

### B. Resume the fold after approval

The approved verdict is treated as interceptor *k*'s verdict (its
transform folds); dispatch continues with *k+1..n*, which may still
deny, escalate, or transform.

| Pros | Cons |
| --- | --- |
| Defense-in-depth holds regardless of registration order or approvals. | A later deny overrides a human approval — operationally surprising ("I approved it, why was it blocked?"). |
| No bypass-laundering: escalating gains nothing an allow wouldn't. | Multiple escalations per emission become possible (k escalates, approved, k+2 escalates…) — resolver UX and identity binding per escalation need spec text. |
| Consistent with the fold-through model (an approval is just a resolved permit at position k). | Approval identity binding gets subtle: each escalation binds to the context *as of that point in the fold* (post prior transforms). |

### C. Approval is final, but the spec makes the trade-off explicit and auditable

Keep A's semantics; add normative guardrails:
1. The record's `decided_by` (landing with Q6) marks the escalating
   interceptor, and a new record flag `fold_truncated: true` states
   that k+1..n did not run.
2. §7 RECOMMENDS ordering: place must-always-run controls (egress
   guards) *before* escalation-capable policy interceptors.
3. Hosts MAY offer a per-interceptor `always_runs` registration option
   (out of contract scope, documented pattern).

| Pros | Cons |
| --- | --- |
| No semantic change; approval stays authoritative; simple. | Defense-in-depth is by convention (ordering guidance), not by construction. |
| The bypass becomes visible in audit records instead of silent. | `always_runs` as a host-specific extension fragments behaviour across hosts. |

## Interaction with Q2 (concurrency)

Orthogonal. §12.2 concurrency is *across* emissions; this question is
*within* one emission's fold. No option here changes the concurrency
contract.

## Recommendation (for discussion)

**B**, with two spec constraints to blunt its cons: (1) at most one
escalation per emission — a second `escalate` after an approval is
treated as `deny host_error:escalation_exhausted` (prevents approval
ping-pong and bounds resolver load); (2) the §9 request for a resumed
fold binds to the context identity *at the moment of escalation*
(post-fold-so-far), which Q6's identity fix already computes.

If the operational surprise of "approved yet denied" is unacceptable,
**C** is the honest fallback — it at least makes the bypass visible
and gives integrators an ordering rule. **A as-is is the only option
we should rule out**: it is silent-bypass-by-default.

## Decision needed

- [ ] A / B / C (or variant)
- [ ] If B: max-one-escalation rule? identity binding point?
- [ ] If C: is `fold_truncated` + ordering guidance sufficient?
