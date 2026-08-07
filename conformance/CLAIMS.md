# Conformance claims

> **A conformance claim is not a security certification.** It attests
> that the host adapter honours the verdict contract under CTK
> conditions — a hermetic run with a mocked model and tools. It does
> not test adversarial bypass, does not assure that the production
> code path matches the harness, and says nothing about the
> interceptors registered in production. See [`SECURITY.md`](../SECURITY.md)
> and [spec §1.4](../spec/AGENT-HOOKS-0.1.md#14-trust-model-and-non-goals).

A host is **conformant** when it passes 100% of the CTK vectors
applicable to its **declared surface** (spec §13.1): its capability
subset (§3.2), the composition profiles and knob values it supports
(§7.2), and its identity provider (§10.1). There are no tiers, levels,
or baseline profiles — the claim attaches the CTK's **per-part report**
(runner results grouped by each vector's `part` tag), which
communicates *what was exercised*, not a tier name.

A claim with `identity_provider: null` MUST state that its records and
approvals are identity-unbound (§10.1). A claim with a host-defined
provider MUST disclose whether the provider is **content-derived**
(a pure function of the projected context, like `jcs-sha256`) or not —
approval binding and record correlation are only as strong as that
property (§10.1). A claim with
`buffered_output: false` MUST state that a `deny` at `output` cannot
retract already-streamed content (§12.1a); one whose host mediates
incrementally under the §12.1 exception MUST also state the exposure
bound its accounting discipline enforces.

| Framework | Adapter version | Spec | Capabilities | Profiles | Identity provider | SDK | Report | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reference-agent | 0.1.0 | agent-hooks/0.1 | model_calls, tool_calls, int64_json (not typescript) | all four (§7.2), all knobs | jcs-sha256 (+ null, vector-scoped) | python, typescript, dotnet, go, rust | (CI: CTK self-test, all parts) | In-tree reference |
| [agent-control-spec](https://github.com/responsibleai/agent-control-spec) | 0.4.0-alpha.1 | agent-hooks/0.1 | model_calls, tool_calls, int64_json | all four (§7.2), all knobs | jcs-sha256 (+ null, vector-scoped) | rust@0.1.0-alpha.3 | [per-part report](https://github.com/responsibleai/agent-control-spec/blob/a075ff9602e9/conformance/agent-hooks/REPORT.md) — 46/47, 1 capability-gated skip (bigint_json undeclared) | Policy decision runtime; engine registered as the interceptor behind a first-party harness over the production emitter loop |
| [agent-framework](https://github.com/microsoft/agent-framework) (Microsoft Agent Framework, Python) | core 1.13.0 (`4b1afd9052`, #7515) | agent-hooks/0.1 | model_calls, tool_calls, int64_json, bigint_json | all four (§7.2), all knobs | jcs-sha256 (+ null, vector-scoped) | python@0.1.0a4 | [per-part report](claims/maf/REPORT.md) — **partial: 33/47, 0 skips; 14 failures from 2 documented host-posture divergences (report F1/F2). Not a §13.1 conformance claim.** | Middleware bundle over the production agent loop; harness + report in [claims/maf/](claims/maf/). F1: tool-seam `host_error:*` denies halt the run (spec-permitted per §6.2's terminate clause; inexpressible in the CTK's `run_outcome`). F2: AH-CTK-100 pins the reference host's blocked-tool transcript shape. |

## Filing and acceptance

A claim is filed as a PR adding one row to the table above. Required
artefacts, in the PR:

1. **The per-part CTK report** (runner output grouped by `part`) from
   a run against the claimed adapter version, linked or attached —
   100% pass on the declared surface, skips only from undeclared
   capabilities.
2. **Harness description**: which SDK runner, and how the harness
   wires the framework — specifically confirming it drives the
   framework's **production dispatch path** with only model/tool I/O
   mocked (a harness that re-implements dispatch attests nothing).
3. **Disclosure flags** where applicable: `identity_provider: null` →
   the claim states records/approvals are identity-unbound;
   custom provider → content-derived or not; `buffered_output: false`
   → the claim states a deny at `output` cannot retract streamed
   content, plus the exposure bound when the host mediates
   incrementally under the §12.1 exception.

Acceptance is by CODEOWNERS review (`conformance/` owner). The
reviewer checks: the report matches the declared surface tuple; the
report's vector inventory matches the spec version claimed; the
production-path confirmation is present; disclosure flags are
consistent. Where the adapter is open source, the reviewer MAY re-run
the CTK before accepting. Acceptance records the claim; it is not an
endorsement, and rows may be removed if a claim is later found not to
reproduce.
