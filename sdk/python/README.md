# agent-hooks (Python SDK)

Python implementation of
[AGENT-HOOKS-0.1](https://github.com/responsibleai/agent-hooks/blob/main/spec/AGENT-HOOKS-0.1.md):
interception-point enums, `AgentContext` builder, `Verdict` types, host-side
`InterceptionEmitter` with the four composition profiles, the pluggable
identity-provider seam, and the Conformance Test Kit.

> **Trust model.** agent-hooks is a *cooperative contract*, not a security
> boundary: the host framework is fully trusted, interceptors run in-process
> with full data access, and no complete-mediation claim is made. Read
> [SECURITY.md](https://github.com/responsibleai/agent-hooks/blob/main/SECURITY.md)
> and [spec §1.4](https://github.com/responsibleai/agent-hooks/blob/main/spec/AGENT-HOOKS-0.1.md#14-trust-model-and-non-goals)
> before relying on it.

```bash
# The 0.1.0a1 artifact on PyPI implements a superseded draft — until
# 0.1.0a2 is published, install from source:
pip install "agent-hooks-sdk[ctk] @ git+https://github.com/responsibleai/agent-hooks.git#subdirectory=sdk/python"
# import name: agent_hooks
```

## Host (framework adapter) usage

```python
from agent_hooks import AgentContextBuilder, InterceptionBlocked, InterceptionEmitter

builder = AgentContextBuilder(agent_id="my-agent", framework="my-fw", session_id="s-1")
emitter = InterceptionEmitter().register(MyPolicy())

await emitter.emit(builder.agent_startup(tools_registered=["http_get"]))
ctx = builder.pre_tool_call(call_id="tc-1", name="http_get", args={"url": url})
try:
    await emitter.emit(ctx)
except InterceptionBlocked as e:
    return tool_error(e.result.verdict.reason)
result = invoke_tool(ctx["tool_call"]["args"])  # post-transform args
```

## Interceptor usage

```python
from agent_hooks import AgentContext, Verdict


class MyPolicy:
    def intercept(self, ctx: AgentContext) -> Verdict:
        if ctx["interception_point"] == "pre_tool_call" and ctx["tool_call"]["name"] == "rm":
            return Verdict.deny(reason="dangerous")
        return Verdict.allow()
```

`Verdict.allow()`, `Verdict.deny(...)`, `Verdict.warn(...)` (allow + recorded
warning) and `Verdict.escalate(...)` (liftable deny for the approval seam, §9)
are the constructor shortcuts for the §5 shapes.

## Running the CTK against your framework

Implement `agent_hooks.ctk.Harness` (see
[conformance/HARNESS.md](https://github.com/responsibleai/agent-hooks/blob/main/conformance/HARNESS.md)),
then:

```bash
pytest --agent-hooks-harness=my_pkg:MyHarness
```

The vectors ship inside the wheel; pass `--agent-hooks-vectors=<dir>` only to
run a different vector set.
