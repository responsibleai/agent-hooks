# Interception records

Every emission produces one record. It is the audit trail's unit: what
was evaluated, by whom, under which composition, with what outcome.

```json
{
  "interception_point": "pre_tool_call",
  "mode": "enforce",
  "verdict": { "decision": "transform", "reason": "pii_redacted",
               "transform": { "path": "$target.ssn" } },
  "input_identity": "sha256:9f0c...",
  "enforced_identity": "sha256:41aa...",
  "identity_provider": "jcs-sha256",
  "session_id": "s-003",
  "sequence": 7,
  "timestamp": "2026-07-21T09:14:03.120Z",
  "decided_by": 0,
  "composition": { "profile": "sequential/first_deny", "on_approval": "stop" },
  "verdicts": [ { "index": 0, "decision": "transform", "name": "redactor" } ],
  "interceptors_registered": 1
}
```

## Payload-free by construction

The record's verdict is a projection of the combined verdict:
`transform.value` is dropped (the path stays), approval-block members
are stripped, and free-form messages are truncated. Notice the example
above: the record proves an `$target.ssn` rewrite happened without
containing the social security number, and the differing
`input_identity` / `enforced_identity` pair proves the content changed
without storing either version. Records can therefore flow to
lower-sensitivity sinks than the contexts they describe.

## Attribution and ordering

`decided_by` is the registration index of the interceptor whose verdict
won the aggregation (or whose liftable deny was consulted); host-chosen
names in `verdicts[].name` make that human-readable. `sequence` totally
orders records within a session, including under concurrent tool calls,
and the optional `timestamp` and `trace` fields carry the context's
RFC 3339 instant and W3C trace identifiers for SIEM correlation.

Approval outcomes are first-class: `resolved_by` records whether the
seam substituted a resolution (`approval`) or declined to lift
(`rejection`), and `fold_truncated` records when a short-circuit or an
approval-stop meant registered interceptors never ran.

## Sinks and retention

Emitters ship a per-emission record sink callback (sink failures are
swallowed, never control flow) and a bounded drop-oldest buffer with a
`records_dropped` counter, so a long-running session cannot grow
memory without bound and a crashed sink cannot block enforcement.
