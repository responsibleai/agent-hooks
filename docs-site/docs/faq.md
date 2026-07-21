# FAQ

## Is this a sandbox?

No. Agent Hooks is a cooperative contract between a trusted host and
the controls it registers. Tool and model calls execute with whatever
privilege the host process has. The contract does not isolate them,
does not claim complete mediation (a framework can always expose paths
that reach no interception point), and does not detect a host that
ignores verdicts. If you need containment of untrusted code, you need
a sandbox underneath this, not instead of it.

## What happens when an interceptor crashes?

The emission fails closed. An interceptor that throws, times out, or
returns something malformed becomes a synthesized deny with a reserved
reason (`host_error:interceptor_failed`,
`host_error:interceptor_timeout`, `host_error:verdict_invalid`), and
the failure text is reduced to the exception type name so payload
cannot leak into audit records through error messages. The same
applies to the approval resolver. A dead control never fails open.

## Why only three verdicts?

Because the other two were disguises. A warn is an allow with metadata;
making it a decision invited hosts to disagree about whether it blocks.
An escalation is a deny that an approver may lift; making it a distinct
state forced every host to remember not to proceed on "unresolved". As
a deny-with-approval-block, unresolved is not a state at all. Three
decisions also make the severity order total, which is what makes
multi-interceptor aggregation deterministic across hosts.

## Why was my 64-bit ID rejected?

The default identity provider canonicalizes with RFC 8785, whose
number model is IEEE-754. An integral value beyond ±(2^53−1) would be
silently rounded, and two distinct IDs could then hash to one identity,
which is exactly what an approval must not bind to. The provider
rejects instead of rounding, with a remediation message. Encode 64-bit
identifiers as decimal strings at your adapter boundary (the proto3
JSON convention), plug a custom identity provider, or opt out of
identity visibly.

## Can interceptors run in parallel?

Across emissions, yes: concurrent tool calls each get their own
bracketed emission, and stateful interceptors own their own
synchronization. Within one emission, choose a `parallel/*`
composition profile: every interceptor gets an isolated snapshot and
the results aggregate by strictest verdict or unanimity. What you give
up in parallel profiles is transform chaining, since nobody sees
anyone else's rewrite; a conflict between two transforms fails closed
or goes to the approval seam.

## Does a conformance claim mean the framework is safe?

No, and the spec says so normatively. It means the adapter honoured
the verdict contract under test conditions. It is a statement about
plumbing, not about the quality of the policies you register or the
paths the framework exposes outside the contract.

## Who is behind the reserved `host_error:` reasons?

The host, exclusively. Interceptor verdicts using that prefix are
rejected as invalid. Decision runtimes that sit behind an interceptor
and have their own failure modes should use their own namespace
(`runtime_error:*` is the convention the Agent Control Specification
uses), so host failures and engine failures stay distinguishable in
records.
