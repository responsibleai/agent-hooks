# Controls mapping (informative)

How agent-hooks mechanisms map onto external control frameworks:
OWASP LLM Top 10 (2025) and the NIST AI Risk Management Framework.
Threat rows (`TM-NN`) reference [THREAT-MODEL.md](THREAT-MODEL.md) so
this mapping and the threat model stay in sync.

> **Not a certification.** agent-hooks is a cooperative contract, not
> a security boundary (spec §1.4), and a conformance claim is not a
> security certification (`conformance/CLAIMS.md`). The mechanisms
> below *support* the listed controls when a host wires them and
> registers appropriate interceptors; they do not by themselves
> satisfy any framework requirement.

## OWASP LLM Top 10 (2025)

| OWASP | Supporting mechanism | Threat rows |
| --- | --- | --- |
| LLM01 Prompt Injection | `input` / `pre_model_call` interception: interceptors `deny` or `transform` untrusted content before it reaches the model; `pre_tool_call` gates the resulting actions (§3, §6) | TM-01 |
| LLM02 Sensitive Information Disclosure | `output` / `post_model_call` / `post_tool_call` interception for egress filtering; payload-free records (§10.3); approval-channel redaction seam (§9); `result_labels` flow tracking (§5.4) | TM-09, TM-13, TM-22 |
| LLM03 Supply Chain | Not a runtime mechanism — the project's own posture: pinned actions, committed lockfiles with `--locked` CI, SBOM + provenance attestation in the release pipeline, OIDC trusted publishing | TM-14 |
| LLM04 Data and Model Poisoning | Partial: `post_tool_call` interception can filter retrieved/tool-supplied content before it enters agent state (§6.1); training-time poisoning is out of scope | TM-01 |
| LLM05 Improper Output Handling | `output` interception with transform/deny before the response reaches the caller; §12.1a buffering rule for streamed output | TM-11 |
| LLM06 Excessive Agency | `pre_tool_call` deny/transform per call; liftable denies routing high-impact actions through the human approval seam (§5.1, §9); composition profiles determining which controls evaluate (§7) | TM-01, TM-18, TM-19, TM-20 |
| LLM07 System Prompt Leakage | Partial: `pre_model_call` exposes the full message chain to interceptors for outbound inspection; `output` filtering for leak detection | TM-01 |
| LLM08 Vector and Embedding Weaknesses | Out of scope: agent-hooks does not mediate retrieval internals; a host may surface retrieval as a tool, gaining `pre/post_tool_call` coverage | — |
| LLM09 Misinformation | Partial: `output`/`post_model_call` interceptors may annotate via `warnings`/`result_labels`; content verification itself is an interceptor concern | TM-13 |
| LLM10 Unbounded Consumption | Payload bounds with a normative fail-closed breach rule (§12.3); interceptor timeouts (§7); the optional `budgets.*` context fields give interceptors the data to enforce quota policy | TM-12 |

## NIST AI RMF

Mapping at the function level, with the subcategories the record
mechanism most directly supports. agent-hooks is a *runtime control
and evidence* layer: it contributes primarily to MANAGE and to the
measurement half of MEASURE.

| RMF function | Contribution |
| --- | --- |
| GOVERN | Governance artefacts for the contract itself (GOVERNANCE.md, proposals process, VERSIONING.md); the conformance-claim discipline (§13.3, CLAIMS.md) gives adopters a documented basis for third-party assertions |
| MAP | The eight interception points (§3) enumerate exactly where an agent system's autonomous actions can be observed and controlled — a concrete map of the runtime decision surface |
| MEASURE | InterceptionRecords: payload-free, totally ordered per session, attributable (`decided_by`), tamper-evident under a content-derived identity provider (§10); `evaluate_only` mode measures would-be enforcement before it is enabled (§8) |
| MANAGE | Enforcement itself: fail-closed deny/transform obligations (§6), human-in-the-loop escalation via liftable denies (§9), composition profiles for defense-in-depth (§7), staged rollout path (`evaluate_only` → `enforce`, see OPERATIONS.md) |

**Logging-obligation note.** The record shape (§10.3) — ordered,
attributable, payload-free, identity-bound — is designed to *support*
regulatory logging obligations (e.g. EU AI Act record-keeping for
high-risk systems) without storing payloads; whether a given
deployment satisfies any obligation depends on the host's retention,
protection, and completeness, which this contract does not control.
