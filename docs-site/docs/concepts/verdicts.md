# Verdicts

An interceptor returns exactly one of three decisions.

| Decision | Class | Host obligation |
| --- | --- | --- |
| `allow` | permit | proceed with `target` unchanged; record any warnings |
| `transform` | permit | apply the transform to `target`, then proceed with the rewritten value |
| `deny` | block | do not proceed; at `post_*` points, discard the already-produced result |

```json
{
  "decision": "deny",
  "reason": "egress_blocked",
  "message": "confidential marker in tool arguments"
}
```

## Warnings are metadata, not decisions

There is no `warn` decision. A warning is an `allow` carrying a
`warnings` array; it is recorded on the audit record and unioned across
all interceptors in an emission, but it never affects control flow.
SDKs ship `Verdict.warn(...)` sugar that produces exactly that shape.

```json
{ "decision": "allow", "warnings": [{ "reason": "quota_80_percent" }] }
```

## Escalation is a liftable deny

There is no `escalate` decision either. An escalation is a `deny`
carrying an `approval` block: denied as-is, unless the
[approval seam](approval.md) lifts it. This makes fail-closed a
property of the type. An unresolved escalation is not a state the host
must remember to handle; it is simply a deny. A host with no approval
resolver enforces it as a plain deny, and that is conformant behaviour,
not an error.

```json
{ "decision": "deny", "reason": "requires_human_approval", "approval": {} }
```

## Severity

Aggregation across multiple interceptors uses a total order fixed by
the specification:

```text
deny  >  deny+approval  >  transform  >  allow
```

A plain deny dominates a liftable one: if any interceptor
unconditionally denies, consulting an approver is pointless. The order
is not host-configurable; two hosts running the same profile must agree
on every outcome.

## Validation and fail-closed handling

The host validates every returned verdict against the §5 rules before
acting on it: a `transform` body is required exactly when the decision
is `transform`, an `approval` block is permitted only on `deny`, a
`reason` must never use the reserved `host_error:` prefix, and
`evidence` is capped at 10,240 canonical bytes. Anything malformed, and
any interceptor that throws or times out, becomes a synthesized deny
with a reserved reason such as `host_error:verdict_invalid` or
`host_error:interceptor_failed`. A crashing control fails closed, never
open.
