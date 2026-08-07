# Production checklist

Deployment decisions a host operator must make consciously before
running agent-hooks in production. Each row names the normative clause;
the [operations runbook](OPERATIONS.md) covers day-2 concerns
(monitoring, rollout, incident response). This document is informative.

## Checklist

| # | Decision | Guidance |
| --- | --- | --- |
| 1 | **Enforcement mode** | Run `enforce` in production. `evaluate_only` invokes interceptors and records verdicts but proceeds with every action; it MUST NOT be presented to any downstream system as enforcement (§8) — misreporting it is a compliance hazard, not a configuration choice. |
| 2 | **Interceptor latency** | Fail-closed semantics turn a hung interceptor into a halted agent. Keep the RECOMMENDED 5000 ms timeout (§7) or tune it deliberately; prefer async interceptors — a synchronous interceptor that blocks the event loop cannot be interrupted by the timeout in Python/TypeScript. In Rust, timeout enforcement is opt-in (`tokio-timeout` feature) or host-owned. |
| 3 | **Composition profile** | The default, `sequential/first_deny` with `on_approval: "stop"`, short-circuits: interceptors registered **after** an approved escalation never run for that emission (§14). The skip is recorded (`fold_truncated: true`), but coverage is your registration order. Choose per the table below; register must-run controls before escalation-capable ones. |
| 4 | **Identity provider** | Keep the default `jcs-sha256` unless you have a concrete reason not to: it is what makes approvals content-bound and records correlatable. A `null` provider is conformant but identity-unbound — your conformance claim MUST say so (§10.1, §13.3). A custom provider must disclose whether it is content-derived. |
| 5 | **Record persistence** | `InterceptionRecord`s are the audit trail and are payload-free by construction (§10.3). Configure a record sink; the in-memory buffer is drop-oldest with a `records_dropped` counter — alert on it (see OPERATIONS). Persist `result_labels` with produced data and resurface them per §5.4. |
| 6 | **Approval-channel redaction** | The `ApprovalRequest` carries the context as presented to the resolver and MAY be redacted (§9). Use the emitter's approval-redactor seam; the request identity is computed over the *redacted* context, so the binding covers exactly what the approver saw. Document redaction in `extensions.<host>.redacted`. |
| 7 | **Payload bounds** | Contexts are canonicalized, hashed, and deep-copied per interceptor per emission. Apply the RECOMMENDED bounds (5 MiB serialized, depth 128, §12.3); whatever limit you enforce, breach MUST yield `deny host_error:context_invalid`, never a crash or truncation. |
| 8 | **Output streaming** | If you stream output to the caller, buffer until the `output` combined verdict permits (§12.1a) — or declare `buffered_output: false` and state in your claim that a deny at `output` cannot retract streamed content. A declaring host may also evaluate `post_model_call` incrementally under the §12.1 bounded-exposure exception; state the exposure bound in the claim and declare `incremental_output` so the `streaming/incremental` CTK vectors run against your accounting discipline. |
| 9 | **Value domain** | String-encode 64-bit identifiers at the adapter boundary (§4.4). JavaScript hosts cannot observe big integers at all (`JSON.parse` rounds first); Go hosts must decode with `json.Number`. |
| 10 | **Zero-interceptor state** | An `enforce`-mode emission with nothing registered fails closed (`host_error:no_interceptor`, §7). A deliberate passthrough is an explicit allow-all interceptor — deploy one consciously or not at all. |

## Profile selection

| Requirement | Profile | Notes |
| --- | --- | --- |
| Lowest latency; first deny ends the emission | `sequential/first_deny`, `on_approval: "stop"` (default) | Interceptors after an approved escalation are skipped (`fold_truncated`); order controls accordingly (§14) |
| Approval lifts a deny but later controls still run | `sequential/first_deny`, `on_approval: "resume"` | Multiple consultations possible, bounded by interceptor count (§7.4) |
| Every control evaluates every emission | `sequential/run_all` | Severity-max aggregate; at most one consultation, and only when **every** deny is liftable (§7.4) |
| Independent verdicts over one snapshot; no transform chaining | `parallel/strictest` | Concurrent transforms conflict (`on_transform_conflict` knob, §7.5) |
| Anything but unanimous allow blocks | `parallel/unanimous` | Disagreement handling per `on_disagreement` knob (§7.5) |

A sequential interceptor can blind its successors via transform;
parallel profiles remove that vector at the cost of transform
composition (§14).

## Related

- [OPERATIONS.md](OPERATIONS.md) — runbook: failure reasons, rollout, alerting
- [THREAT-MODEL.md](THREAT-MODEL.md) — what the contract does and does not defend against
- [spec §14](../spec/AGENT-HOOKS-0.1.md#14-security-considerations) — normative security considerations
