# P-003: Verdict algebra and host-configurable composition

**Status:** **Decided** 2026-07-09 — adopted as recommended, with one
amendment: **no required baseline profile**. All profiles are
equal-status declared capabilities; the spec has a single level and the
CTK/conformance report simply enumerates which declared parts pass or
fail (see §13 of the spec). Supersedes the P-001 recommendation;
its `fold_truncated` / `resolved_by` record fields carry over.
**Raised by:** design review of the P-001 outcome, 2026-07-08.

## Why reopen this

The P-001 review debated *what happens after an approval* inside a
fixed frame: interceptors run sequentially, first deny short-circuits.
Every option (approval-final, fold-resume, `always_runs`) was a patch
on that frame. The deeper question is that the frame itself is a host
policy choice the spec never surfaced: **how do multiple interceptors
compose at one interception point?** Sequential-with-short-circuit is
one point in a small, enumerable space. Naming the space — and letting
the host declare its point in it — makes the P-001 dilemma a one-bit
configuration instead of an architectural fork.

A second simplification makes the space enumerable at all: collapsing
the five verdicts to three.

## Part 1 — Three verdicts

Today: `allow | deny | warn | escalate | transform`. Proposed:

| New verdict | Absorbs | Wire shape |
| --- | --- | --- |
| **allow** | allow, warn | `{decision: "allow", warnings?: [{reason, message}], result_labels?, evidence?}` |
| **deny** | deny, escalate | `{decision: "deny", reason, message?, approval?: {…}, result_labels?, evidence?}` |
| **transform** | transform | `{decision: "transform", transform: {path, value}, reason?, …}` |

Rationale per collapse:

- **warn → allow + metadata.** A warn proceeds; it is an allow with a
  recorded concern. It never needed its own control semantics — hosts
  and records treat it as allow today. The `warnings` array preserves
  everything (including multiple warnings accumulating across a
  chain, which the single-verdict model handled awkwardly).
- **escalate → deny + `approval` block.** An escalation is "denied
  as-is, unless an approver permits it." Making that literal has three
  wins:
  1. **Fail-closed by type.** Today the spec must *oblige* hosts not
     to proceed on unresolved escalation (§6, §9). Under this model an
     unresolved escalation *is* a deny — there is nothing to oblige.
  2. **Graceful degradation.** A host with no approval resolver simply
     enforces the deny. No `host_error:no_resolver` special case.
  3. **Severity is explicit.** A hard deny and an escalatable deny are
     the same decision at different strictness, which is exactly how
     aggregation (Part 2) needs to treat them.
- **transform stays its own verdict.** It is the only verdict that
  demands a distinct host *action* (substitute the target and proceed
  with modified content). Folding it into allow-with-delta would
  invite "deny with transform," which is meaningless. It proceeds, so
  in the halt/proceed dichotomy it is allow-like; in strictness it
  sits between allow and deny.

**Severity order** (needed for every aggregation policy below):

```
deny  >  deny+approval  >  transform  >  allow
```

A hard deny dominates an escalatable one — if any interceptor
unconditionally denies, consulting an approver is pointless.

**Approval resolutions speak the same vocabulary.** A resolution is a
verdict: *permit* → allow (or transform, if the approver modified the
content); *reject* → the deny stands. One algebra covers interceptors,
resolvers, and host-synthesized errors (`host_error:*` remains a deny
with a reserved reason — unchanged).

**Deliberately excluded in 0.x:** a transform carrying its own
`approval` block ("apply this redaction, or ask"). Keeps the product
space small; revisit on evidence.

**Compatibility.** Wire-breaking, but nothing is announced or adopted
(private repo, alpha packages) — this is the cheapest moment it will
ever be. SDK ergonomics survive via constructors: `Verdict.warn(...)`
emits allow+warning, `Verdict.escalate(...)` emits deny+approval.

## Part 2 — Composition profiles

Two orthogonal axes the host declares: **execution mode** ×
**aggregation policy**.

### Mode P: parallel

All interceptors receive the same immutable context snapshot and run
concurrently. No interceptor sees another's transform. The host
aggregates the verdict set.

| Profile | Aggregate rule | Assessment |
| --- | --- | --- |
| **PAR/STRICTEST** | Highest-severity verdict wins (order above). Warnings and labels union across all results. | The natural fail-closed choice. Recommended for 0.x. |
| **PAR/UNANIMOUS** | All must allow; any disagreement → config `on_disagreement: deny \| escalate` (escalate = synthesize deny+approval for host/human arbitration). | Recommended for 0.x — this is the "they all have to agree, otherwise arbitration" mode. |
| PAR/QUORUM (k-of-n) | Allow if ≥k allow. | Listed for completeness. **Exclude from 0.x**: config surface for a weak security story (n−k controls silently overridden). |
| PAR/MOST-PERMISSIVE | Lowest-severity wins. | Listed for honesty. **Exclude** (or restrict to `evaluate_only`): one permissive interceptor silently bypasses every other control — a direct violation of the no-silent-bypass invariant (§1.3). Advisory interceptors are what warnings/labels are for. |

**The hard cell: concurrent transforms.** Two transforms produced
against the same snapshot don't compose — applying both in either
order can differ, and neither transformer saw the other's output.
Options:

- **T1 — at-most-one (recommended for 0.x):** if exactly one result is
  a transform (and severity permits it to win), apply it; two or more
  transforms → conflict, resolved per config
  `on_transform_conflict: deny(host_error:transform_conflict) | escalate`.
- T2 — path-disjoint merge: apply all transforms whose JSON paths
  don't overlap; overlap → conflict. More permissive, more machinery.
  Document as a possible future profile, don't ship.
- T3 — transforms force a sequential sub-round. Rejected: reintroduces
  ordering through the back door.

**Structural consequence — P-001 dissolves in parallel mode.** There
is no ordering, therefore no truncation, therefore no fold-resume
question. Every interceptor has already evaluated the (single, shared)
content by the time an approval is consulted; the approval resolves
the *aggregate*, skipping no one. The entire P-001 question — including
its dissent about must-run guards — is an artifact of the sequential
frame. There is also exactly one input identity per emission (no
fold), which simplifies audit and approval binding.

Parallel's honest cost: no interceptor can build on another's
transform (no redact-then-scan chains), and hosts pay concurrent
dispatch complexity.

### Mode S: sequential

Ordered chain; each interceptor sees the effect of prior transforms
(today's §7.1 fold-through).

| Profile | Rule | Assessment |
| --- | --- | --- |
| **SEQ/FIRST-DENY** | First deny short-circuits (transforms fold through; allows continue). If the deny carries an `approval` block and the host has a resolver, consult it. Config bit `on_approval: stop \| resume` — *stop*: a permit ends the chain (P-001's "approval-final"); *resume*: a permit substitutes the resolution and the chain continues (the P-001 "fold-resume" option). | Baseline. Today's behavior is exactly `SEQ/FIRST-DENY, on_approval: stop`. |
| **SEQ/RUN-ALL** | No short-circuit: every interceptor runs in order (transforms fold through for visibility); the aggregate is the highest-severity verdict; on an aggregate deny, folded transforms are discarded (nothing proceeds). | Recommended for 0.x. This is the principled answer to "must-run controls": *uniform for the whole chain*, so it composes with approval without per-interceptor flags — the fragmentation risk that killed `always_runs` doesn't arise. Cost: denied actions still pay for the full chain, and interceptors after a decisive deny evaluate content that will never execute (the record makes this legible). |
| SEQ/FIRST-NON-ALLOW | Short-circuit on transform too. | Rejected: transform *proceeds* — halting on it conflates control with mutation and forbids transform chains for no benefit. |

Note what the three-verdict model buys here: "first deny wins" and
"first escalation wins" are no longer two policies — an escalation
*is* a deny, so `SEQ/FIRST-DENY` covers both, and the whole P-001
architectural fork compresses into the single `on_approval` bit.

### Keeping conformance coherent (the real risk)

P-001's legitimate fear was semantic fragmentation:
hosts inventing incompatible composition behaviors. The control is:

1. **Closed set of named profiles.** Hosts MUST NOT invent profiles;
   the spec enumerates them. Proposed 0.x set:
   `SEQ/FIRST-DENY` (with `on_approval`), `SEQ/RUN-ALL`,
   `PAR/STRICTEST`, `PAR/UNANIMOUS`. Quorum and most-permissive are
   documented as rejected, with reasons.
2. **Required baseline.** Every conformant host MUST support
   `SEQ/FIRST-DENY, on_approval: stop` (today's behavior). Everything
   else is optional and declared. The single conformance bar stays
   single: "honours the declared profiles' semantics exactly, baseline
   included."
3. **Recorded per emission.** The InterceptionRecord gains a
   `composition` block (`{mode, policy, on_approval?, …}`) so any
   record is interpretable without out-of-band knowledge of host
   config.
4. **CTK coverage per profile.** Vectors parameterized by profile;
   a host is tested against exactly the profiles it declares.

### Record changes

- `composition` block (above).
- For multi-verdict profiles (RUN-ALL, all PAR/*), a payload-free
  `verdicts: [{index, decision, reason}]` summary — `decided_by`
  alone can't represent an aggregate. `decided_by` remains the
  severity-determining index where one exists.
- The P-001 verdict's `fold_truncated` / `resolved_by: "approval"`
  fields remain useful **within** `SEQ/FIRST-DENY, on_approval: stop`
  and carry over unchanged.

## Decision needed

- [ ] Adopt the three-verdict model (Part 1)?
- [ ] Adopt composition profiles (Part 2)? Which in 0.x scope —
      recommended: SEQ/FIRST-DENY(stop|resume), SEQ/RUN-ALL,
      PAR/STRICTEST, PAR/UNANIMOUS?
- [ ] Baseline profile = SEQ/FIRST-DENY + on_approval:stop?
- [ ] Parallel transform conflict rule = T1 (at-most-one)?
