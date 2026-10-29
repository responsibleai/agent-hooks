# P-XXX: {Short title naming the design question or change}

- **Status:** Draft | Accepted | Rejected | Final | Superseded
- **Created:** YYYY-MM-DD
- **Author(s):** Name `<email>` (@github-username)
- **PR:** {URL of this proposal's pull request}

See the [proposal process](README.md) for scope, lifecycle, decision
authority, and review window.

## Abstract

Brief (~200 word) technical summary of the proposal. This should be a
concise overview that allows readers to quickly understand what this
proposal changes.

## The gap (Motivation)

Why is this change needed? State the problem, who encounters it, and why
the current contract is inadequate.

## Goals and non-goals (optional)

{State the intended outcomes and explicit boundaries. Identify what
stays unchanged, especially trust assumptions and host/provider concerns
outside the Agent Hooks contract.}

## Specification

Detailed technical specification of the proposed changes. The
specification should describe the syntax and semantics of any new
protocol feature in sufficient detail to allow competing, interoperable
implementations.

### Recommended normative semantics

{For contract changes, describe the recommended syntax and behavior in
enough detail for interoperable implementations. Distinguish proposed
requirements from examples and rationale. Include defaults, precedence,
validation/rejection rules, error reasons, limits, and observable results
where relevant. Identify affected spec sections and unchanged invariants.
For a non-contract question, replace this section with the proposed
procedure or design.}

{Explain interactions with interception points, verdicts, composition,
approval, identity, records, and declarations only where affected. State
which behavior belongs to the host, interceptor, resolver, or provider.}

### Schema and wire impact (when applicable)

{List changed or new schema files and closed inventories under spec/.
Show illustrative wire examples if useful, clearly labeled as proposed.
Identify constraints requiring SDK validation rather than JSON Schema.
Link authoritative schema files once they exist instead of maintaining
duplicate adopted schemas here.}

## Rationale

Explain why particular design decisions were made. This section should:

- Describe alternate designs that were considered
- Explain why the proposed approach was chosen
- Reference related work or prior art
- Document important objections or concerns raised during discussion
- Provide evidence of consensus within the community

### Options considered

#### A. Keep the current contract

{Describe the status quo and how hosts handle the gap today.}

| Advantages | Costs and risks |
| --- | --- |
| {What this preserves or avoids.} | {What remains unsolved or moves to hosts.} |

#### B. {Alternative}

{Describe a viable alternative with enough detail for a fair comparison.}

| Advantages | Costs and risks |
| --- | --- |
| {Benefit.} | {Trade-off, limitation, or failure mode.} |

<!-- Add further lettered options as needed. Present alternatives
neutrally; do not make a preferred option look inevitable. -->

### Recommendation (for discussion)

{Name the preferred option and explain why its trade-offs are preferable.
Record important objections and remaining risks, including dissent from
discussion. Separate evidence or agreement from assumptions.}

### Related decisions (optional)

{Link related proposals, issues, prior art, and relevant spec sections.
If reopening a decision, name the new evidence that changed it. If
superseding a proposal, identify what is replaced and what survives.}

## Security and privacy

{Describe changes to trust boundaries, enforcement/fail-closed behavior,
approval binding, validation, and payload-free auditing where relevant.
Include abuse cases, disclosure or retention risks, and resource bounds.
State mitigations and residual risks; if unchanged, explain why. Report
actual vulnerabilities privately per [SECURITY.md](../../SECURITY.md),
not in this proposal.}

## Backward compatibility

**Required for proposals that introduce backward incompatibilities.**

{Describe what existing hosts, interceptors, clients, and claims retain
or lose, how old/new producers and consumers interact, and any migration
or rollout path. Explicitly identify unchanged behavior. Classify the
change using [VERSIONING.md](../../VERSIONING.md), distinguishing wire,
declaration-contract, and package versions as applicable; explain the
classification.}

## Performance and operational impact (optional)

{Discuss latency, concurrency, memory, cancellation/cleanup, rollout, or
operator visibility where these affect the design. Include measurements
when available and label unmeasured assumptions.}

## SDK surface and implementation impact

{Describe the Rust core and FFI impact, and the Python, TypeScript, .NET,
and Go surfaces that must agree. Name affected APIs, adapters, bindings,
and documentation; explain unaffected surfaces. Identify feasibility
risks or implementation sequencing without treating a draft as decided.
Link existing experiments if useful; no prototype is required by this
template, and implementation follows the decision.}

## Conformance and tests

{Describe the evidence that will pin the behavior: shared CTK vectors
for cross-SDK semantics, golden/schema fixtures, or per-SDK tests as
appropriate. Cover valid cases, defaults, invalid input, failures, and
interactions with existing behavior. Explain effects on conformance
claims, capabilities, profiles, or disclosures, if any.}

| Case | Expected result |
| --- | --- |
| {Input or scenario.} | {Observable verdict, error, record, or other result.} |
