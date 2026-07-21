# Python quickstart

```sh
pip install --pre agent-hooks-sdk
```

The distribution is `agent-hooks-sdk`; the import name is
`agent_hooks`. The wheel bundles the native core, so this is the whole
setup.

A minimal host with one control interceptor:

```python
"""Minimal agent-hooks host with one control interceptor."""
import asyncio

from agent_hooks import (
    AgentContextBuilder,
    Decision,
    InterceptionBlocked,
    InterceptionEmitter,
    Verdict,
)

CONFIDENTIAL = ("account_balance", "ssn")


class EgressGuard:
    """Denies tool calls whose arguments carry confidential markers."""

    def intercept(self, context) -> Verdict:
        if context["interception_point"] != "pre_tool_call":
            return Verdict(decision=Decision.ALLOW)
        args = context["tool_call"]["args"]
        if any(marker in str(args) for marker in CONFIDENTIAL):
            return Verdict(decision=Decision.DENY, reason="egress_blocked")
        return Verdict(decision=Decision.ALLOW)


async def main() -> None:
    emitter = InterceptionEmitter()
    emitter.register(EgressGuard(), name="egress-guard")

    build = AgentContextBuilder(
        agent_id="support-agent", framework="quickstart", session_id="s-001"
    )

    # A harmless tool call proceeds.
    ctx = build.pre_tool_call(name="web_search", args={"q": "docs"}, call_id="t-1")
    outcome = await emitter.emit(ctx)
    print("allowed:", outcome.record.verdict.decision.value)

    # A confidential payload is stopped before the tool runs.
    ctx = build.pre_tool_call(
        name="send_email", args={"body": "account_balance: 991"}, call_id="t-2"
    )
    try:
        await emitter.emit(ctx)
    except InterceptionBlocked as blocked:
        record = blocked.result
        print("denied:", record.verdict.reason)
        print("decided_by:", record.decided_by, "profile:", record.composition.profile.value)


asyncio.run(main())
```

Output:

```text
allowed: allow
denied: egress_blocked
decided_by: 0 profile: sequential/first_deny
```

Things to notice:

- `emit()` raises `InterceptionBlocked` on any block; the record rides
  on the exception as `.result`. The non-raising variant is
  `emit_unchecked()`, and then halting the action is your obligation.
- On a proceeding emission, `emit()` returns an `EmitOutcome`; your
  action must consume `outcome.target`, the effective post-composition
  value, not the original arguments.
- An interceptor may return a `Verdict` or the equivalent wire dict;
  either way the host validates it and fails closed on anything
  malformed.
- Defaults: `enforce` mode, `sequential/first_deny` composition with
  `on_approval: stop`, the `jcs-sha256` identity provider, and a 5000
  ms interceptor timeout.
