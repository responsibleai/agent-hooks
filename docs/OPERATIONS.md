# Operations runbook

Day-2 guidance for hosts running agent-hooks in production: what each
fail-closed reason means, how to roll out, and what to alert on.
Companion to the [production checklist](PRODUCTION.md). This document
is informative; the reason inventory is normative in
[spec §11](../spec/AGENT-HOOKS-0.1.md#11-reserved-reasons)
(machine-readable: `spec/reserved-reasons.json`).

## 1. Failure reasons: cause → remediation

Every host-synthesized deny carries a reserved `host_error:*` reason.
The contract is fail-closed: these denies halt the guarded action, so
a persistent failure is an agent outage by design, not a bug in the
contract.

| Reason | Likely cause | Remediation |
| --- | --- | --- |
| `context_invalid` | Host adapter built a schema-invalid context; value outside the I-JSON domain (integer beyond ±(2⁵³−1), non-finite float, lone surrogate); depth/size bound breached | Fix the adapter's context construction; string-encode 64-bit identifiers (§4.4); check the deny message — remediation detail names the path and constraint |
| `interceptor_failed` | Interceptor raised/panicked or returned a non-JSON value | Fix the interceptor; the record's `decided_by` names its registration index; message carries the exception type only |
| `interceptor_timeout` | Interceptor exceeded the configured timeout (default 5000 ms) | Check interceptor latency (downstream policy service?); prefer async interceptors; tune the timeout deliberately |
| `verdict_invalid` | Verdict failed §5 validation: unknown decision, `warn`/`escalate` wire values (removed), `approval` on a permit, reserved reason, malformed `warnings`, `evidence` over 10240 bytes | Migrate the interceptor to the three-verdict model (`Verdict.warn`/`Verdict.escalate` SDK sugar emits the correct shapes); shrink evidence to a pointer |
| `transform_invalid` | `transform.path` did not resolve against the target | Fix the interceptor's path or guard on target shape |
| `transform_target_forbidden` | Path not rooted at `$target`, or transform at `agent_startup`/`agent_shutdown` | Fix the interceptor; those points define no mutable target (§4.3) |
| `transform_conflict` | Two-plus transforms against the same snapshot in a parallel profile (§7.5) | Expected under `parallel/strictest` with multiple transformers: pick the `on_transform_conflict` knob (`deny` or `approval`) consciously, or use a sequential profile where transforms fold |
| `composition_disagreement` | Non-unanimous outcome under `parallel/unanimous` (§7.5) | Expected; tune `on_disagreement` or switch profile if too strict |
| `approval_resolver_failed` | Resolver (or the approval redactor) raised or timed out | Check resolver/approval-channel health; a liftable deny with **no registered resolver** is NOT an error — the deny simply stands |
| `approval_unresolved` | Resolver returned `unresolved` | Approval channel could not decide (UI timeout, queue overflow); investigate resolver-side |
| `approval_identity_mismatch` | Resolution's `context_identity` violated the echo rule (§9) | Resolver must echo the request identity byte-for-byte (null echoes as null); indicates a broken or suspicious resolver |
| `adapter_unsupported` | Host adapter cannot emit this interception point | Declare the capability subset honestly (§3.2) instead of synthesizing failures |
| `no_interceptor` | `enforce`-mode emission with zero registered interceptors (§7) | Register controls, or an explicit allow-all interceptor for a deliberate passthrough |
| `streaming_unsupported` | Host could not assemble a streamed model response before `post_model_call` (§12.1) | Buffer the stream or disable streaming on the model client |

## 2. Rollout: `evaluate_only` → `enforce`

1. **Shadow (evaluate_only).** Register production interceptors,
   `evaluate_only` mode: every action proceeds; verdicts and records
   are produced. Never report this state as enforcement (§8).
2. **Analyze.** Measure would-be-deny rate by `reason` and
   `decided_by`; fix adapter-caused `host_error:*` noise (these become
   outages under enforce); validate approval-channel latency.
3. **Enforce, staged.** Switch mode per session or per interception
   point (§8) — e.g. `pre_tool_call` first, `output` last. Keep the
   analysis dashboards; the same signals now measure halted actions.
4. **Rollback is mode, not removal.** Dropping back to
   `evaluate_only` preserves records and labels; unregistering
   interceptors silently narrows the control plane (and zero
   registered fails closed, §7).

## 3. Alerting

| Signal | Source | Why |
| --- | --- | --- |
| Fail-closed rate by `reason` | records: `verdict.reason` prefix `host_error:` | Infrastructure failures masquerade as policy denies; `interceptor_timeout`/`interceptor_failed` spikes are outages |
| `fold_truncated: true` rate | records | Every occurrence means registered controls were skipped after an approval under `first_deny`+`stop` (§7.4) — confirm the skip pattern matches your registration-order design |
| `resolved_by: "approval"` rate | records | Human-approval lift volume; a jump means controls are escalating more (or an automated resolver is lifting more) |
| `records_dropped > 0` | emitter counter | Audit loss: the drop-oldest ring overflowed before the sink drained it — resize retention or fix the sink |
| Record-sink failures | host sink wrapper | Sink exceptions are swallowed by design (audit must not alter control flow) — instrument the sink itself |
| `approval_unresolved` / `approval_identity_mismatch` | records | Broken approval channel; mismatch may indicate a misbehaving resolver |
| Sequence gaps within a session | records: `sequence` | Records are totally ordered per session (§12.2); a gap means record loss between emitter and storage |

## 4. Incident notes

- **A single failing interceptor halts the agent.** That is the
  contract working (§1.3). Identify it via `decided_by` + `reason`,
  fix or roll back *the interceptor*; use `evaluate_only` as a
  last-resort bypass with explicit sign-off — never silently.
- **Approval outage:** liftable denies stand as denies (fail-closed);
  agents keep running but escalation-gated actions halt. No
  contract-side action needed; restore the resolver.
- **Suspected record tampering or drift:** `input_identity` /
  `enforced_identity` under a content-derived provider re-bind each
  record to the exact evaluated context; recompute to verify (§10).
