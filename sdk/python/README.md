# agent-hooks (Python SDK)

Python implementation of
[AGENT-HOOKS-0.1](https://github.com/responsibleai/agent-hooks/blob/main/spec/0.1/AGENT-HOOKS-0.1.md):
interception-point enums, `AgentContext` builder, `Verdict` types, host-side
`InterceptionEmitter` with the four composition profiles, the pluggable
identity-provider seam, and the Conformance Test Kit.

> **Trust model.** agent-hooks is a *cooperative contract*, not a security
> boundary: the host framework is fully trusted, interceptors run in-process
> with full data access, and no complete-mediation claim is made. Read
> [SECURITY.md](https://github.com/responsibleai/agent-hooks/blob/main/SECURITY.md)
> and [spec §1.4](https://github.com/responsibleai/agent-hooks/blob/main/spec/0.1/AGENT-HOOKS-0.1.md#14-trust-model-and-non-goals)
> before relying on it.

```bash
pip install --pre "agent-hooks-sdk[ctk]"
# import name: agent_hooks
```

## Host (framework adapter) usage

For the independently generated draft wire types, see
[Draft contract types](#draft-contract-types). The existing `agent_hooks`
runtime API below is unchanged.

```python
from agent_hooks import (
    SPEC_VERSION_0_1,
    AgentContextBuilder,
    InterceptionBlocked,
    InterceptionEmitter,
)

# The host names the specification version it runs under, here 0.1;
# SPEC_VERSION_DRAFT selects the draft. There is no default.
builder = AgentContextBuilder(
    spec=SPEC_VERSION_0_1, agent_id="my-agent", framework="my-fw", session_id="s-1"
)
emitter = InterceptionEmitter(spec=SPEC_VERSION_0_1).register(MyPolicy())

await emitter.emit(builder.agent_startup(tools_registered=["http_get"]))
ctx = builder.pre_tool_call(call_id="tc-1", name="http_get", args={"url": url})
try:
    await emitter.emit(ctx)
except InterceptionBlocked as e:
    return tool_error(e.result.verdict.reason)
result = invoke_tool(ctx["tool_call"]["args"])  # post-transform args
```

## Draft contract types

`agent_hooks_contract` contains draft-only `TypedDict` models and literal
unions generated directly from `spec/draft/schema/src/main.tsp` with Alloy
Python and the TypeSpec emitter framework. It ships in the SDK distribution
but importing it does not load `agent_hooks` or its Rust extension.

```python
import json

from agent_hooks_contract import PreToolHookResponse

response: PreToolHookResponse = {
    "verdict": {"decision": "transform", "transform": {"args": {"reviewed": True}}}
}
wire = json.dumps(response)
```

These are plain dictionaries: no constructors, runtime enums, serializer,
or validation dependency. Required members remain required; `NotRequired`
means a key may be absent, not that its value is nullable. Enum values and
discriminators are `Literal` types, arbitrary JSON uses the recursive
`JsonValue` alias, and integers use Python's arbitrary-precision `int`.
`typing_extensions` supplies Python 3.10-compatible key qualifiers.
TypeSpec templates and anonymous objects become concrete named TypedDicts.

The types describe the latest draft, not the released 0.1 API or the current
SDK runtime's draft support. Static typing does not enforce JSON Schema
constraints such as numeric bounds, patterns, or conditional rules. TypedDicts
expose declared members; type checkers may reject additional keys on objects
the wire contract leaves open. Use the normative schemas for validation. Adopting
these contracts in the runtime is separate work.

With the Python development dependencies installed and `ruff` on `PATH`,
run from the repository root:

```bash
pnpm install
pnpm run generate:python
pnpm run check:python
mypy --strict sdk/python/python/agent_hooks_contract sdk/python/tests/typing_contract.py
```

The SDK-local equivalents are `pnpm run generate:types` and
`pnpm run check:generated` in `sdk/python`. Ruff sorts imports and formats
the emitted Python; CI checks drift and the static examples. JSON Schema
generation and the existing SDK's packaged schema mirrors are independent.

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
and `from_declaration(HostDeclaration.builder(SPEC_VERSION_0_1).mode("enforce").bind(...).build(),
registry)` build the same emitter from JSON text, a parsed value or code; equal
documents yield byte-identical records. A document that names anything the registry cannot
honour is refused before any emission with `DeclarationError`, which carries
`.code` (`declaration_error:<class>`), `.findings` (JSON pointer and detail)
and, for an unsupported version, `.accepted`. The emitter is then sealed:
`register` and the configuration setters raise `EmitterSealed`; the record
sink and `take_records` stay open. Every record stamps `declaration` with the
contract version, and `emitter.declaration` holds the resolved document whose
`canonical_json()` is the equivalence oracle.

`DECLARATION_VERSION` and `SUPPORTED_DECLARATION_VERSIONS` name the newest
contract version and the set this SDK accepts; `current_declaration_version(spec)`
names what a builder writes for a given specification version (1.0 under 0.1,
1.1 under the draft). They sit next to `SUPPORTED_SPEC_VERSIONS` and the wire
strings `SPEC_VERSION_0_1` and `SPEC_VERSION_DRAFT`, the specification versions
this SDK supports; a document names its version in the required `spec` member.

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
# or the built-in reference harness, under the version it should run
pytest --agent-hooks-spec=agent-hooks/0.1
```

The vectors ship inside the wheel; pass `--agent-hooks-vectors=<dir>` only to
run a different vector set.
