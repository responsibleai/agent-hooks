# Design proposals

Significant design decisions are made through written proposals in
this directory (P-001 through P-008 to date). This file defines when a
proposal is required, its lifecycle, and who decides.

## Writing a proposal

Copy [TEMPLATE.md](TEMPLATE.md) to `P-XXX-<slug>.md`, keeping `XXX`
as a placeholder and choosing a descriptive, unique slug. Keep `P-XXX`
in the title while the proposal is a draft.

When maintainers approve the proposal, they assign the next unused
proposal number and replace `XXX` in both the filename and title
(for example, `P-009-<slug>.md` and `P-009`). Update links to the
renamed file as part of acceptance. Rejected proposals retain `P-XXX`;
existing numbered proposals keep their numbers, and numbers are never
reused.

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

**Status:** Draft | Accepted | Rejected | Final | Superseded

`Draft` → `Accepted` → `Final`, or `Draft` → `Rejected`.
An accepted or final proposal may later become `Superseded`.

These statuses follow the corresponding meanings in the
[MCP SEP guidelines](https://modelcontextprotocol.io/community/sep-guidelines#sep-statuses),
using the five statuses above and this repository's decision authority
and review window.

- **Draft.** The proposal is undergoing informal review.
- **Accepted.** Approved by the maintainers, awaiting implementation
  and applicable conformance coverage. Maintainers assign the proposal's
  permanent number when recording acceptance.
- **Rejected.** Declined by the maintainers.
- **Final.** Complete with implementation and applicable conformance
  coverage.
- **Superseded.** Replaced by a newer proposal. The newer proposal marks the
  old one `Superseded by P-NNN` and states what survives (see
  P-001/P-002 for the pattern).

## Decision authority and review window

Decision authority rests with the maintainers listed in
[GOVERNANCE.md](../../GOVERNANCE.md). While the repository is private
and pre-1.0 there is no minimum comment window; once public, proposals
in the MUST classes above stay open for review at least **7 days**
before a decision is recorded (security fixes exempt).
