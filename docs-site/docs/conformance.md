# Conformance

Conformance is a checkable claim, not a badge. A host declares its
surface, runs the Conformance Test Kit, and publishes the per-part
report. There are no tiers and no baseline profile: the single bar is
passing 100% of the vectors applicable to what you declared.

## The kit

The CTK is a corpus of language-agnostic JSON vectors under
`conformance/vectors/` in the repository (47 at the time of writing).
Each vector scripts a scenario against a mocked model and tools: deny
at each point, transform fold-through and write-back, approval flows
including echo-rule violations, every composition profile and knob,
fail-closed paths (interceptor crash, malformed verdict, invalid
context), and identity edge cases such as integers JSON cannot
represent faithfully. Golden identity vectors additionally pin the
default provider's exact bytes across languages.

## Implementing a harness

Your adapter implements a small harness interface (about four methods)
that lets the runner register scripted interceptors, drive your host
through a scenario, and hand back what happened: the contexts your
host emitted, the records it produced, and which tools actually ran.
The per-language interface and a reference implementation ship in
every SDK; `conformance/HARNESS.md` in the repository is the
authoritative guide.

## Declaring a surface

A declaration states what you implement:

- interception-point capabilities (a pure tool router may omit the
  model-call points),
- value-domain capabilities (a JavaScript host cannot observe a JSON
  integer beyond 2^53 without rounding, so it cannot claim
  `int64_json`),
- the composition profiles and knob values you support,
- your identity provider.

The runner selects the applicable vectors and produces a report
grouped by part:

```text
| Part                              | Passed | Failed |
| approval_seam                     | 8      | 0      |
| composition/parallel_strictest    | 3      | 0      |
| enforcement/evaluate_only         | 1      | 0      |
| identity_provider                 | 4      | 0      |
| ...                               |        |        |
```

## Claims

A claim is the tuple (framework, adapter version, spec version,
capabilities, profiles, identity provider, SDK) plus the report,
recorded in `conformance/CLAIMS.md`. A claim with a `null` identity
provider must state that its approvals and records are identity-
unbound.

!!! note "Not a certification"
    A conformance claim attests that your adapter honours the verdict
    contract under CTK conditions with mocked model and tools. It is
    not adversarial testing, it does not prove your production code
    path matches the harness, and it says nothing about the
    interceptors you register. The trust model in §1.4 of the
    specification is normative on this point.
