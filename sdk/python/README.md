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
pip install --pre "agent-hooks-sdk[ctk]"
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

## Failure handling

Every registration fails closed by default: a raise, a timeout or a
§5-invalid return value becomes a `host_error:*` deny in that
registration's slot (spec §6.3). `register(..., on_error=OnError.CONTINUE)`
makes the registration best effort instead: the host substitutes an
allow carrying the warning `host_warning:control_failed`, records the
underlying reason on `verdicts[].substituted_for`, and tells the
principal through the notifier set with `set_control_failure_notifier`
(required first; without it the registration raises
`RegistrationError`). Nothing else is covered: context failures,
cancellation, transform failures, approval failures, `no_interceptor`
and an explicit deny never continue. An interceptor that runs external
work can own its deadline with `register_managed`: it implements
`intercept_managed(ctx, bound)` and returns a
`ManagedInterceptorOutcome` (`of_verdict`, `timeout` after cleaning up,
`cancelled`, `failed`); a cancelled outcome never continues.

## Host declaration

A host can load its configuration, declared surface and interceptor
bindings from a host declaration document (spec §7.7) instead of
calling the setters. The document is a versioned contract of its own,
`agent-hooks-declaration/1.1`, separate from the wire version; the
loader also accepts `1.0`, whose documents keep their meaning. Version
1.1 adds two optional members, `configuration.failure.on_error` (the
document default) and `bindings[].on_error` (one binding's posture); a
document in which any binding resolves to `continue` is refused
(`binding_rejected`) unless the registry holds a
`control_failure_notifier`. The host
registers in code what the document may reference: kind resolvers,
custom identity providers, approval resolvers and redactors, plus the
surface its code supports.

```python
from agent_hooks import HostRegistry, HostSurface, InterceptionEmitter

registry = (
    HostRegistry(HostSurface.from_capabilities(["model_calls", "tool_calls", "host_declaration"]))
    .kind("com.example.egress", lambda config, ctx: EgressGuard(**config))
    .approval_resolver("operator-queue", OperatorQueue())
)
emitter = InterceptionEmitter.from_declaration_path("agent-hooks.declaration.json", registry)
```

`from_declaration_json(text, registry)`, `from_declaration_value(obj, registry)`
and `from_declaration(HostDeclaration.builder().mode("enforce").bind(...).build(),
registry)` build the same emitter from JSON text, a parsed value or code; equal
documents yield byte-identical records. A document that names anything the registry cannot
honour is refused before any emission with `DeclarationError`, which carries
`.code` (`declaration_error:<class>`), `.findings` (JSON pointer and detail)
and, for an unsupported version, `.accepted`. The emitter is then sealed:
`register` and the configuration setters raise `EmitterSealed`; the record
sink and `take_records` stay open. Every record stamps `declaration` with the
contract version, and `emitter.declaration` holds the resolved document whose
`canonical_json()` is the equivalence oracle.

`DECLARATION_VERSION` and `SUPPORTED_DECLARATION_VERSIONS` name the contract
versions this SDK writes and accepts; they sit next to `SPEC_VERSION`.

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
[conformance/HARNESS.md](https://github.com/responsibleai/agent-hooks/blob/main/conformance/HARNESS.md)).
A harness that declares `Capability.HOST_DECLARATION` also implements
`setup_declared(scenario, document, registry)` and builds its emitter with
`InterceptionEmitter.from_declaration_value(document, registry)`; one that
does not skips the `declaration/*` vectors with a stated reason. Then:

```bash
pytest --agent-hooks-harness=my_pkg:MyHarness
```

The vectors ship inside the wheel; pass `--agent-hooks-vectors=<dir>` only to
run a different vector set.
