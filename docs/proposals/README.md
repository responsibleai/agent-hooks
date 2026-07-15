# Design proposals

Significant design decisions are made through written proposals in
this directory (P-001 through P-004 to date). This file defines when a
proposal is required, its lifecycle, and who decides.

## When a proposal is required

Any change in these classes MUST go through a proposal before
implementation:

- anything `VERSIONING.md` classes as **spec MAJOR**: changes to
  required/conditional context fields, the interception-point set,
  verdict shape, composition semantics, or failure (fail-closed)
  semantics;
- adding, removing, or changing **composition profiles**, their knobs,
  or their defaults (§7.2);
- changes to the **identity** or **record** shape (§10) or to what a
  conformance claim asserts (§13.3);
- changes to the **trust model or non-goals** (§1.4).

Additive optional/namespaced fields, new vectors, editorial spec
changes, SDK-internal refactors, and CI/tooling changes do not require
a proposal — ordinary PR review applies (see
[CONTRIBUTING.md](../../CONTRIBUTING.md)).

## Lifecycle

`Draft` → `Decided` → (possibly) `Superseded`.

- **Draft.** File `P-NNN-<slug>.md` following the structure of the
  existing proposals: Status, Raised by, the gap, enumerated options
  with trade-offs, a recommendation. Neutral framing of alternatives
  is expected — P-001/P-002 were debated by independent per-option
  advocates before decision, a practice worth keeping for contested
  questions.
- **Decided.** The Status line records the date, the decision, and any
  amendments. Implementation follows the decision, not the other way
  around; the deciding PR links the proposal.
- **Superseded.** A later proposal that replaces a decision marks the
  old one `Superseded by P-NNN` and states what survives (see
  P-001/P-002 for the pattern).

Decisions may be reopened only by a new proposal that names the
evidence that changed (e.g. P-003's fold-resume reservation lists the
specific field-frequency evidence that would reopen it).

## Decision authority and review window

Decision authority rests with the maintainers listed in
[GOVERNANCE.md](../../GOVERNANCE.md). While the repository is private
and pre-1.0 there is no minimum comment window; once public, proposals
in the MUST classes above stay open for review at least **7 days**
before a decision is recorded (security fixes exempt).
