# Design proposals

Significant design decisions are made through written proposals in
this directory (P-001 through P-008 to date; a missing number is a
proposal still in review). This file defines when a proposal is
required, its lifecycle, and who decides.

## Writing a proposal

A proposal takes its number from the pull request that introduces it,
the way MCP SEPs do: the file is `P-<PR>-<slug>.md` and its title is
`# P-<PR>: ...`, where `<PR>` is that pull request's number.

Copy [TEMPLATE.md](TEMPLATE.md) to `P-XXX-<slug>.md` with a
descriptive, unique slug and open the pull request. The one extra step:
once the pull request exists, push a commit that renames the file and
the title to its number (for example `P-212-<slug>.md` and `# P-212`)
before requesting review. The number is fixed from that point through
Accepted, Rejected, Final and Superseded; acceptance renumbers nothing.
Numbers are never reused because pull request numbers are not. P-001
through P-008 keep their numbers. Cross-references use `P-<PR>` and the
pull request link.

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
  and applicable conformance coverage.
- **Rejected.** Declined by the maintainers.
- **Final.** Complete with implementation and applicable conformance
  coverage.
- **Superseded.** Replaced by a newer proposal. The newer proposal marks the
  old one `Superseded by P-<PR>` and states what survives (see
  P-001/P-002 for the pattern).

Each proposal's Status line also says where its text stands, as a
parenthetical after the status: `(in draft)` once the change has
merged into `spec/draft/`, and `(released in X.Y)` once a specification
version containing it has been cut
([RELEASING.md](../../RELEASING.md#release-a-specification-version)).
For example, `**Status:** Accepted (in draft)`.

## Decision authority and review window

Decision authority rests with the maintainers listed in
[GOVERNANCE.md](../../GOVERNANCE.md). While the repository is private
and pre-1.0 there is no minimum comment window; once public, proposals
in the MUST classes above stay open for review at least **7 days**
before a decision is recorded (security fixes exempt).
