# P-007: Explicit host execution and declaration-source profiles

**Status:** **Decided** 2026-10-16 — adopt Option C with strict defaults,
compatible execution groups, observable timeout continuation and record-only
result labels.
**Raised by:** Liam Crumm, for hosts that adopt independently supplied standard
controls through an existing native registration pipeline.

## The gap

AGENT-HOOKS-0.1 correctly defaults every interceptor timeout to a fail-closed
deny and requires permit-verdict result labels to flow with derived data. Those
defaults must remain the conformance baseline.

Some hosts already have a documented operational timeout posture that continues
ordinary execution, and some adopt controls only to produce records. Those hosts
cannot truthfully claim the strict defaults. They also need to combine bindings
from independently owned declaration sources without pretending one source's
whole-host declaration describes the combined host.

## Options

### A. Keep the mismatch outside Agent Hooks

This preserves the current API but makes host claims inaccurate and timeout
bypass silent.

### B. Change the defaults

This breaks existing hosts and weakens fail-closed adoption. Rejected.

### C. Add an explicit execution profile and compatible source groups

Adopted.

- Existing hosts default to `timeout_action: deny` and
  `result_label_policy: flow`.
- A registration may explicitly select `timeout_action: continue`. Only a
  timeout is converted to an allow, and the allow carries
  `host_warning:interceptor_timeout`.
- A native adapter may own its deadline and return a typed timeout only after
  cancellation and physical cleanup; cancellation and failure remain distinct
  blocking outcomes.
- `result_label_policy: record_only` keeps labels in interception records but
  ends the host's label-flow obligation there.
- Enforcement mode remains group-level. `evaluate_only` records the real
  verdict and proceeds under §8; it does not rewrite observed denies to allow.
- Independently supplied declarations are resolved whole and may share one
  emitter only when their resolved global configuration is identical.
- The combined emitter is sealed, retains source provenance on registrations,
  and carries no single-declaration record stamp.
- Supported points and enabled registration points are distinct.

## Compatibility

All existing constructors, single-declaration loaders, records and conformance
claims retain their current meaning. The new posture is opt-in and additive.
