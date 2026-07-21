# Example: policy deny with remediation detail

A deny should tell the operator what to do about it. The `reason` is a
low-cardinality machine identifier for dashboards and alerts; the
`message` is for the human reading the log.

```python
from agent_hooks import Decision, Verdict

MAX_ROWS = 10_000


class QueryBudget:
    def intercept(self, context) -> Verdict:
        if context["interception_point"] != "pre_tool_call":
            return Verdict(decision=Decision.ALLOW)
        call = context["tool_call"]
        if call["name"] == "sql_query" and call["args"].get("limit", 0) > MAX_ROWS:
            return Verdict(
                decision=Decision.DENY,
                reason="row_limit_exceeded",
                message=f"limit {call['args']['limit']} > {MAX_ROWS}; "
                        "paginate or request an exemption via #data-access",
            )
        return Verdict(decision=Decision.ALLOW)
```

The record the host emits for the blocked call (abridged):

```json
{
  "interception_point": "pre_tool_call",
  "verdict": {
    "decision": "deny",
    "reason": "row_limit_exceeded",
    "message": "limit 50000 > 10000; paginate or request an exemption via #data-access"
  },
  "decided_by": 0,
  "verdicts": [ { "index": 0, "decision": "deny", "reason": "row_limit_exceeded", "name": "query-budget" } ],
  "composition": { "profile": "sequential/first_deny", "on_approval": "stop" }
}
```

Two conventions worth adopting:

- Reserve the `host_error:` prefix. It belongs to host-synthesized
  failures; the host will reject any interceptor verdict that uses it.
  If your control wraps a decision engine with its own failure modes,
  give them their own namespace (`runtime_error:*` is the convention
  the Agent Control Specification uses).
- Keep `reason` values enumerable. The record's per-interceptor
  summary (`verdicts[]`) carries reasons but never payloads, so
  low-cardinality reasons make records aggregatable without leaking
  content.
