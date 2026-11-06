# Original vector coverage by specification

This inventory covers **all 92 original vectors**, not only the vectors initially
excluded from v0.1. The source inventory is `conformance/vectors/` at `918851b^`,
immediately before commit `918851b` split the suite by specification. Current
locations are [v0.1 vectors](0.1/vectors/) and [draft vectors](draft/vectors/).
Each row gives the original filename without its `.json` extension; a present
counterpart has the same filename and embedded ID in the indicated directory.

## Reconciliation

| Coverage | Count |
| --- | ---: |
| Original files / unique embedded IDs | 92 / 92 |
| Present in v0.1 | 78 |
| Present in draft | 92 |
| Present in both | 78 |
| Draft only | 14 |
| v0.1 only | 0 |
| **Absent from both** | **0 (no IDs)** |

The totals reconcile as **92 = 78 in both + 14 draft-only + 0 nowhere**.
There are no duplicate IDs, renamed counterparts, or additional vector files in
either current suite. Presence does not imply byte-identical contents across
versions or with the historical source.

Initially, 31 vectors were excluded from v0.1 and 61 retained. **18 of those
historical exclusions have been restored**. The SDK audit additionally moved
AH-CTK-157 to draft-only coverage because its invalid `on_error` value tests a
draft-only enum, yielding 78 present and 14 excluded. Restored rows are explicitly
marked below. The Python SDK's packaged
v0.1 suite also contains the same 78 files, checked byte-for-byte
against the canonical v0.1 suite.

## Reading the status columns

- **Present (S)**: present and previously passed the released v0.1 JSON Schema
  validation. This is **not** a passing runtime conformance result.
- **Present (U)**: present, but passing validation/execution has not been
  established by this investigation.
- **Absent; adaptable**: not in v0.1; a narrower baseline scenario can be adapted
  from source inspection. The adaptation has not been implemented or tested.
- **Absent; incompatible**: not in v0.1; the original assertions depend on draft
  functionality or a draft-only rule. Removing those assertions would change
  the purpose of the test.

**No row is claimed as verified runtime-passing.** The previous v0.1 schema
check passed all 78 current vectors. Runtime verification was blocked: Rust and
Go toolchains were unavailable, Python could not import `agent_hooks._core`,
TypeScript lacked its native binding, and .NET could not load
`agent_hooks_ffi`. Draft entries are conservatively marked unverified; this
inventory reconciliation did not execute either conformance suite.

## All original vectors

| Vector ID / filename stem | v0.1 status | Draft status | Issue / location note |
| --- | --- | --- | --- |
| `AH-CTK-001-basic-loop` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-002-no-tools` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-003-sequence-monotonic` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-010-deny-pre-tool` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-011-deny-input` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-012-deny-output` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-020-transform-tool-args` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-021-transform-policy-target-alias` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-022-transform-forbidden-startup` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-030-escalate-approve` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-031-escalate-reject` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-032-escalate-no-resolver` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-040-evaluate-only` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-050-warn-passthrough` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-060-fold-through` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-061-zero-interceptor` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-070-interceptor-raises` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-071-malformed-verdict` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-072-resolver-identity-mismatch` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-073-resolver-raises` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-074-deny-at-startup` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-080-first-deny-resume` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-081-run-all-aggregate` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-082-run-all-consult-lifts-all` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-083-run-all-plain-deny-blocks-consult` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-084-parallel-strictest-isolation` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-085-parallel-transform-conflict-deny` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-086-parallel-conflict-approval-unions` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-087-unanimous-disagreement-deny` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-088-unanimous-disagreement-approval` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-089-identity-provider-null` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-090-bigint-rejected` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-091-bigint-beyond-u64-rejected` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-092-evidence-cap` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-093-record-projection` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-094-failure-deny-attribution` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-095-postfold-domain-rejection` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-096-provider-fault` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-097-runall-failure-slot` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-098-approve-carrying-deny` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-099-approval-redaction` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-100-deny-post-tool-non-incorporation` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-101-evaluate-only-zero-interceptor` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-102-runall-failed-transform-shortcircuit` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-103-approve-carrying-failing-transform` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-104-interceptor-mutation-isolated` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-105-resume-two-liftable-denies` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-110-incremental-release-within-bound` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-111-incremental-deny-withholds-remainder` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-112-incremental-residue-fails-closed` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-113-incremental-durability-gated` | Present (S) | Present (U) | Both suite directories. |
| `AH-CTK-120-declaration-minimal-load` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-121-declaration-full-document` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-122-declaration-evaluate-only` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-123-declaration-three-path-equivalence` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-124-declaration-per-point-bindings` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-125-declaration-unbound-point-denies` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-126-declaration-zero-bindings` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-127-declaration-refusal-reserved-major` | Present (S) | Present (U) | Both suites; intentionally invalid declaration tests load refusal. |
| `AH-CTK-128-declaration-refusal-version-missing` | Present (S) | Present (U) | Both suites; intentionally invalid declaration tests load refusal. |
| `AH-CTK-129-declaration-refusal-spec-unsupported` | Present (S) | Present (U) | Both suites; intentionally unsupported spec tests load refusal. |
| `AH-CTK-130-declaration-refusal-unknown-top-level-member` | Present (S) | Present (U) | Retained; v0.1/Python declaration spec corrected to isolate intended refusal. |
| `AH-CTK-131-declaration-refusal-unknown-nested-member` | Present (S) | Present (U) | Retained; v0.1/Python declaration spec corrected to isolate intended refusal. |
| `AH-CTK-132-declaration-refusal-invalid-enum` | Present (S) | Present (U) | Retained; v0.1/Python declaration spec corrected to isolate intended refusal. |
| `AH-CTK-133-declaration-refusal-unconsulted-knob` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-134-declaration-refusal-lifecycle-floor` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-135-declaration-refusal-unsupported-version-in-surface` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-136-declaration-refusal-unregistered-provider` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-137-declaration-refusal-unknown-kind` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-138-declaration-refusal-binding-rejected` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-139-declaration-refusal-duplicate-binding-id` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-140-declaration-max-buffered-at-bound` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-141-declaration-refusal-max-buffered-above-bound` | Present (S) | Present (U) | Retained; v0.1/Python declaration spec corrected to isolate intended refusal. |
| `AH-CTK-142-declaration-config-integer-at-bound` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-143-declaration-refusal-config-integer-above-bound` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-144-on-error-deny-timeout` | Absent; adaptable | Present (U) | 1.1 explicit `on_error: deny`; 0.1 can test implicit timeout denial after removing knob and updating versions/record stamp, but loses explicit-posture coverage. |
| `AH-CTK-145-on-error-continue-timeout` | Absent; incompatible | Present (U) | Timeout becomes allow with warning/substitution/notification; 0.1 requires deny. Surface also advertises declaration/1.1. |
| `AH-CTK-146-on-error-continue-raise` | Absent; incompatible | Present (U) | Exception becomes allow with warning/substitution/notification; 0.1 requires `interceptor_failed` denial. |
| `AH-CTK-147-on-error-continue-invalid-verdict` | Absent; incompatible | Present (U) | Malformed verdict becomes allow; 0.1 requires `verdict_invalid` denial. |
| `AH-CTK-148-on-error-deny-raise` | Absent; adaptable | Present (U) | 1.1 explicit deny; implicit exception denial can be adapted to 0.1, losing explicit-posture coverage. Update versions/record stamp too. |
| `AH-CTK-149-on-error-deny-invalid-verdict` | Absent; adaptable | Present (U) | 1.1 explicit deny; implicit malformed-verdict denial can be adapted to 0.1, losing explicit-posture coverage. Update versions/record stamp too. |
| `AH-CTK-150-on-error-continue-cancelled-denies` | Absent; incompatible | Present (U) | Cancellation overrides continue: draft-only contrast. A narrower cancellation-denial rewrite needs harness/semantic validation. |
| `AH-CTK-151-on-error-continue-resolver-failure-denies` | Absent; adaptable | Present (U) | Baseline resolver-failure denial exists in 0.1; remove continue and update versions/stamp. Loses the draft-only exception-to-continue assertion. |
| `AH-CTK-152-on-error-document-default-inherited` | Absent; incompatible | Present (U) | Document failure default and inherited continue are draft-only; 0.1 has neither. |
| `AH-CTK-153-on-error-binding-overrides-default-to-deny` | Absent; incompatible | Present (U) | Default/override precedence is draft-only; deleting both settings leaves a different ordinary failure-denial test. |
| `AH-CTK-154-on-error-binding-overrides-default-to-continue` | Absent; incompatible | Present (U) | Default/override precedence and continued allow are draft-only. |
| `AH-CTK-155-declaration-1-0-loads-unchanged` | Present (S) | Present (U) | **Restored** to v0.1/Python; declaration spec changed to `agent-hooks/0.1`. |
| `AH-CTK-156-declaration-refusal-higher-minor` | Present (S) | Present (U) | Both suites; intentionally unsupported declaration tests load refusal. |
| `AH-CTK-157-declaration-refusal-on-error-invalid-value` | Absent; incompatible | Present (U) | Moved to draft-only during SDK audit: invalid `on_error` enum requires declaration/1.1. A 1.0 rewrite would instead duplicate AH-CTK-158's unknown-field refusal. |
| `AH-CTK-158-declaration-refusal-on-error-under-1-0` | Present (S) | Present (U) | Retained; v0.1/Python spec corrected. Tests refusal of `on_error` under declaration/1.0, not support for it. |
| `AH-CTK-159-on-error-continue-run-all-deny-wins` | Absent; incompatible | Present (U) | First failure becomes allow; second slot's deny wins. In 0.1 the first slot denies, changing attribution and warnings. |
| `AH-CTK-160-declaration-refusal-incremental-output-without-model-calls` | Absent; incompatible | Present (U) | Expected inconsistent-declaration refusal relies on draft-only incremental-output/model-calls dependency; relabeling does not justify that refusal in 0.1. |

## Compatibility evidence

All 14 draft-only files currently declare `agent-hooks-declaration/1.1` and
`agent-hooks/draft`. Released 0.1 supports only declaration/1.0, whose closed
schema has neither `bindings[].on_error` nor `configuration.failure`.
Changing only `spec` therefore cannot restore these files as written.

- [Released declaration schema](../spec/0.1/schema/generated/host-declaration-1.0.schema.json)
  defines the closed 1.0 document, configuration and bindings.
- [Released specification](../spec/0.1/AGENT-HOOKS-0.1.md) section 6.3 requires
  fail-closed denial for interceptor exceptions, timeouts and invalid verdicts;
  section 9 requires denial on resolver failure.
- [Draft specification](../spec/draft/AGENT-HOOKS-DRAFT.md) section 6.3.1
  introduces failure posture, continuation and its audit/notification behavior.
- [Core declaration validation](../sdk/rust/core/src/declaration.rs)
  rejects the new posture members under 1.0 and explicitly gates the additional
  incremental-output/model-calls consistency check to draft. Released section
  7.7.4 does not impose that additional dependency. Consequently, AH-CTK-160
  cannot retain its expected refusal merely by changing versions; its later
  load outcome would also depend on the host surface.

These compatibility explanations are source-based, not new runtime results.
