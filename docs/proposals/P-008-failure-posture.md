# P-008: A per-binding failure posture, `on_error: deny | continue`

**Status:** **Draft**
**Raised by:** Mohammad Abuomar, for the Copilot CLI integration, whose
runtime maintainers accept fail closed as the default but not as the only
behaviour after a stalled pre-tool control made the CLI unusable.

## The gap

Section 6.3 maps every interceptor failure to a substituted deny. The
only knob a host has is the timeout value. A host cannot say that one
registration is critical, so its failure stops the action, while another
is best effort, so its failure is recorded and the action continues.

In production a Defender pre-tool hook stopped responding and every
developer's agent session stopped with it. The host had two choices:
carry its own fail-open rules outside the contract, or remove the
control. Both lose the audit trail the contract exists to keep. The
runtime maintainers will not accept fail closed as the only behaviour.
Security will accept fail closed as the default with an explicit,
administrator-controlled opening.

A second gap sits next to it. An interceptor that runs external work (a
child process, an HTTP call) is wrapped in the emitter's outer timer.
When that timer fires the emitter substitutes a deny, but the work keeps
running, and the interceptor has no way to say "I cancelled it and
cleaned up" or "the host cancelled me", which are different outcomes
from a timeout.

## Goals

1. One knob with two values, `deny` (the default) and `continue`, set per
   binding, with a document default a binding can override.
2. The knob covers exactly the three interceptor failures of §6.3 and
   nothing else.
3. Fail closed stays the default everywhere, and host code cannot change
   that default.
4. Every continuation is visible: in the combined verdict, in the record
   with its cause, in a message to the principal, and in the host's
   conformance claim.
5. An interceptor that owns its deadline reports a typed outcome, and a
   cancellation is never mistaken for a timeout.
6. The change is a minor revision of the declaration contract: a 1.0
   document means the same under 1.1, and a 1.0 loader refuses a 1.1
   document.

## Non-goals

- Result label policy.
- Composing bindings from several declaration documents.
- Changes to sealing beyond adding the new knob to the sealed set.
- A knob for context, cancellation, transform, approval or
  `no_interceptor` failures, or for an explicit deny.
- A host-wide execution profile that host code sets.

## Options

### A. Keep fail closed as the only behaviour

Hosts that need best-effort controls carry their own rules outside the
contract.

**Advantages**

- No specification change.
- The security property stays simple to state.

**Disadvantages**

- The host that needed the opening already carries private fail-open
  rules on an unreleased branch; the contract does not describe what
  runs.
- The audit trail of a continuation is whatever the host invents; no
  vector pins it and no claim discloses it.
- Each host solves the same problem differently.

### B. A timeout-only continuation with a host-wide execution profile

Host code sets a profile `{timeout_action: deny | continue}`; a
registration may override it. Only the timeout row of §6.3 continues.

**Advantages**

- Targets the incident that happened (a hang).
- Small emitter change: one arm of the timeout path.

**Disadvantages**

- A control that raises on every call is no more available than one
  that hangs. Treating the three failures differently gives a control
  author a way to pick the failure mode that happens to continue.
- A profile host code sets lets the default move in code, out of the
  administrator's sight. The §13.3 claim then has to carry a new tuple
  member, which invalidates every existing claim row.
- The continuation discards the `host_error:*` reason; an auditor sees
  an allow with a warning and no count of continuations by cause.

### C. One knob, `on_error`, per binding with a document default

The binding envelope gains `on_error: deny | continue`;
`configuration.failure.on_error` is the document default. The knob
covers the three §6.3 interceptor failures. Under `continue` the host
substitutes an allow carrying a reserved warning, records the cause as
`substituted_for` on the slot's summary entry, and tells the principal.
The declaration contract moves to 1.1.

**Advantages**

- One rule for the three failures a control can cause; nothing else
  opens.
- The posture lives where the administrator configures the host, and
  host code has no default to move.
- The record keeps the reason, so continuations are countable by cause.
- The claim tuple is unchanged; the posture is a disclosure, like
  `tool_seam_host_error: terminate`.
- A minor declaration change: absent members keep the 1.0 meaning.

**Disadvantages**

- Touches the declaration contract, the record shape, the verdict gate
  and every SDK.
- Needs a reserved warning namespace and a new closed file.

### D. Option C without the record member or the principal notice

Same knob, but the continuation leaves only the warning behind.

**Advantages**

- Smaller record change.

**Disadvantages**

- The underlying reason is lost; the auditor cannot tell a timeout from
  a crash without parsing a message.
- A continuation the user never sees is a silent bypass of a control
  the administrator believed was running.

## Recommended normative semantics

### 1. The knob

`on_error` has the values `deny` (default) and `continue`. A binding
sets it or inherits `configuration.failure.on_error`. A code
registration takes the same setting, default `deny`. Host code does not
change the default.

### 2. Coverage

The knob covers the three failures of §6.3: the interceptor raises or
panics, exceeds its timeout, or returns a value that fails validation.
It covers nothing else. Context construction failure, cancellation,
transform failures, approval resolver failures, `no_interceptor` and an
explicit deny stay fail closed with no knob.

### 3. The substituted allow

Under `continue` the host substitutes, in the failing registration's
slot:

```json
{
  "decision": "allow",
  "warnings": [
    {
      "reason": "host_warning:control_failed",
      "message": "<binding id>: <host_error reason>; host continued"
    }
  ]
}
```

`target` is unchanged. The warning joins the §7.3 union. The
substituted allow is an allow for every profile's purposes and never
wins on its own, so `decided_by` follows the pure-allow rule.
`host_warning:control_failed` is the first entry of the new closed file
`spec/reserved-warnings.json`; interceptors MUST NOT emit
`host_warning:*` reasons, and the §5 gate rejects them as
`host_error:verdict_invalid`.

### 4. The record

The slot's `verdicts` entry carries `substituted_for: "<host_error
reason>"`, its `decision` is `allow` and its `reason` is absent.
`verdicts` is required on any record where a substitution happened, in
every profile, so a `first_deny` host cannot continue without a trace.

### 5. The principal

The host MUST tell the principal that a control failed and that the
host continued past it, with the binding and the reason. In an
interactive session that is the user; otherwise the agent, through the
channel the host uses for its own messages. The notice is payload-free.
Silent continuation is not conformant.

### 6. The claim

A host whose declaration or registrations set `on_error: continue` for
any binding states it in the §13.3 claim and names the bindings, or says
"document default". The tuple is unchanged.

### 7. Timeout ownership

A managed interceptor may own its deadline. It receives the resolved
bound, cancels and cleans up on breach, and only then reports a typed
`timeout`. It reports `cancelled` when the host cancelled it. The
emitter gains the outcome type (`verdict`, `timeout`, `cancelled`,
`failed`); `timeout` and `failed` follow `on_error`, `cancelled` is a
deny with no knob, and a `timeout` reported without cleanup is not
conformant.

## Adopted schema

- `spec/schema/host-declaration-1.1.schema.json`: a copy of 1.0 with the
  `declaration` enum set to `agent-hooks-declaration/1.1`,
  `configuration.failure.on_error` and `bindings[].on_error`. The 1.0
  file is unchanged.
- `spec/schema/interception-record.schema.json`:
  `verdicts[].substituted_for`, an enum over the three §6.3 reasons.
- `spec/schema/verdict.schema.json`: `warnings[].reason` rejects the
  `host_warning:` prefix.
- `spec/reserved-warnings.json`: the closed warning inventory.
- `spec/DECLARATION-VERSIONS.md`: the 1.1 row, the release row and the
  1.0 to 1.1 migration step.

## SDK surface

Each SDK gains:

- `on_error` on the registration options and on the resolved binding,
  default `deny`, exposed to kind resolvers through the binding
  context;
- the document default `configuration.failure.on_error` in the loader
  and the resolved form, with `agent-hooks-declaration/1.1` current and
  1.0 accepted through an explicit migration step;
- the substitution path in the emitter, the `substituted_for` member on
  the per-verdict summary, and the `host_warning:` check in the §5 gate;
- a principal notification hook the host implements;
- the managed-interceptor outcome type and a registration path for it.

## Conformance and tests

| Case | Expected result |
| --- | --- |
| timeout, raise, invalid verdict under `continue` | allow; `host_warning:control_failed`; `substituted_for`; principal message; tool runs |
| the same three under `deny` | the §6.3 deny, unchanged |
| cancelled outcome under `continue` | `deny host_error:interceptor_failed`, no `substituted_for` |
| approval resolver raises under `continue` | deny, `resolved_by: rejection` |
| document default `continue` inherited | the binding continues |
| document default overridden per binding, both directions | the binding's value wins |
| `run_all`, one continues and one denies | deny wins, warning still in the union, `substituted_for` on the continuing slot |
| a 1.0 document under a 1.1 loader | loads unchanged, record says 1.0, a raise denies |
| a minor above the highest known | `declaration_error:version_unsupported` |
| a bad `on_error` value | `declaration_error:invalid_field` |
| `on_error` under a 1.0 version string | `declaration_error:unknown_field` |
| an interceptor emits a `host_warning:*` warning | `host_error:verdict_invalid` (per-SDK gate test; the vector grammar cannot express it) |

The vectors are AH-CTK-144 to AH-CTK-159. The vector grammar gains the
faults `hang` and `cancel`, `expect.host_messages_must_contain` and
`RunRecord.host_messages`.

## Security and privacy

| Risk | Treatment |
| --- | --- |
| A control author picks the failure mode that continues | One knob covers all three failures the same way |
| Host code quietly moves the default | The default is in the specification; the posture lives in the declaration or at registration, under administrator control |
| A continuation hides a control outage | `substituted_for` on the record, the reserved warning, the principal notice, the claim disclosure |
| An interceptor fakes a continuation | `host_warning:*` is rejected by the §5 gate |
| A substituted allow leaks target content | The message carries the binding id and a reserved reason only |
| Cancellation is read as a timeout and continued | Typed outcomes; `cancelled` is a deny with no knob |
| External work keeps running after a timeout | A managed interceptor cleans up before it reports `timeout` |

## Compatibility and versioning

The declaration contract moves from 1.0 to 1.1: a minor change, since
both new members are OPTIONAL and their absence keeps the 1.0 meaning.
A 1.1 loader accepts 1.0 documents unchanged and refuses `on_error`
under a 1.0 version string. A 1.0 loader refuses a 1.1 document as
`version_unsupported`. The resolved form always carries the current
minor's shape; the record carries the document's own version. The
record gains one OPTIONAL member and the claim tuple is unchanged, so
existing claims stand. The wire version `agent-hooks/0.1` does not
move.

## Rejected shortcuts

- Continuing on timeout only.
- A host-wide execution profile that host code sets.
- Adding the posture to the claim tuple.
- Dropping the `host_error:*` reason from the record on continuation.
- Letting `verdicts` stay optional under `first_deny` after a
  substitution.
- Reusing `host_error:` for the continuation warning, or leaving the
  `host_warning:` prefix unreserved.
- Treating a cancelled outcome as a timeout.

## Decision

Pending. Issue #154 records the agreement to add the knob with fail
closed as the default; this proposal records the shape. The
specification text, schemas, vectors and SDK changes follow option C
as written above.
