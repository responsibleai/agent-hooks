# Example: human approval end-to-end

A policy escalates a wire transfer; a resolver (standing in for your
approval UI) lifts it; the record attributes both halves. Runnable as
written.

```python
"""Human approval end-to-end: liftable deny, resolution, record fields."""
import asyncio
import json

from agent_hooks import (
    AgentContextBuilder,
    ApprovalOutcome,
    ApprovalResolution,
    Decision,
    InterceptionEmitter,
    Verdict,
)


class WireTransferPolicy:
    def intercept(self, context) -> Verdict:
        if context["interception_point"] != "pre_tool_call":
            return Verdict(decision=Decision.ALLOW)
        if context["tool_call"]["name"] == "wire_transfer":
            # Denied as-is, unless the approval seam lifts it.
            return Verdict.escalate(reason="transfer_requires_approval")
        return Verdict(decision=Decision.ALLOW)


class ConsoleApprover:
    """Stands in for a human approval UI; approves this one request."""

    def resolve(self, request) -> ApprovalResolution:
        # request.context_identity is the hash of exactly what the
        # approver saw; the resolution must echo it byte for byte.
        return ApprovalResolution(
            outcome=ApprovalOutcome.APPROVE,
            context_identity=request.context_identity,
            verdict=Verdict(decision=Decision.ALLOW, reason="approved_by_oncall"),
        )


async def main() -> None:
    emitter = InterceptionEmitter(resolver=ConsoleApprover())
    emitter.register(WireTransferPolicy(), name="transfer-policy")

    build = AgentContextBuilder(
        agent_id="finance-agent", framework="quickstart", session_id="s-002"
    )
    ctx = build.pre_tool_call(
        name="wire_transfer", args={"amount": 250, "to": "ACME"}, call_id="t-9"
    )
    outcome = await emitter.emit(ctx)

    r = outcome.record
    print(json.dumps({
        "decision": r.verdict.decision.value,
        "reason": r.verdict.reason,
        "resolved_by": r.resolved_by,
        "fold_truncated": r.fold_truncated,
        "decided_by": r.decided_by,
        "input_identity": (r.input_identity or "")[:23] + "...",
    }, indent=2))


asyncio.run(main())
```

Output:

```json
{
  "decision": "allow",
  "reason": "approved_by_oncall",
  "resolved_by": "approval",
  "fold_truncated": false,
  "decided_by": 0,
  "input_identity": "sha256:3be2d78fc373a71b..."
}
```

Reading the record:

- The combined verdict is the resolution, expressed in the same
  three-verdict vocabulary the interceptor used.
- `resolved_by: "approval"` says a resolution substituted for the
  escalating interceptor's deny; a resolver that declined would leave
  the deny standing with `resolved_by: "rejection"`.
- `decided_by: 0` still points at the escalating interceptor, so the
  approval is attributable to the control that asked for it.
- Had later interceptors been registered under `on_approval: stop`,
  `fold_truncated: true` would record that they never ran. That
  visibility is the point: an approval that skips controls is legal,
  but never silent.

Change `ApprovalOutcome.APPROVE` to `REJECT` (with a deny verdict) and
the emission blocks with the resolver's reason. Return the wrong
`context_identity` and the host fails closed with
`host_error:approval_identity_mismatch`: the echo rule means an
approval cannot be replayed against content the approver never saw.
