# agent-hooks

> **Status:** Draft · **Spec:** [AGENT-HOOKS-0.1](spec/AGENT-HOOKS-0.1.md)

A framework-neutral **control** contract for AI agent systems: a fixed set
of interception points, the agent context a host framework supplies at each,
the verdict an interceptor returns, and the obligations a host MUST honour
for each verdict. Ships with a multi-language Conformance Test Kit.

Extracted from the [Agent Control Specification][acs] (which becomes one
conformant interceptor) so that any agent framework can expose the same
control surface and any control component (policy engine, content filter,
rate limiter, approval gateway, egress guard) can target it.

agent-hooks is a control plane, not a telemetry plane. Every interceptor
returns a `Verdict` the host MUST act on. Passive observation, tracing, and
metrics emission are out of scope; use the framework's native telemetry for
those.

## What agent-hooks is not

agent-hooks is a cooperative contract, **not a security boundary**. The
host is fully trusted; interceptors run in-process with full data
access; the eight interception points do not guarantee complete
mediation; and a conformance claim is not a security certification.
See [`SECURITY.md`](SECURITY.md) and
[spec §1.4](spec/AGENT-HOOKS-0.1.md#14-trust-model-and-non-goals) for
the normative statement.

[acs]: https://github.com/microsoft/agent-governance-toolkit

## What's here

| Path | What |
| --- | --- |
| [`spec/AGENT-HOOKS-0.1.md`](spec/AGENT-HOOKS-0.1.md) | Normative RFC-2119 spec |
| [`spec/schema/`](spec/schema/) | Machine-readable JSON Schemas (interception-point, agent-context, verdict, …) |
| [`conformance/vectors/`](conformance/vectors/) | Language-agnostic CTK test vectors |
| [`conformance/HARNESS.md`](conformance/HARNESS.md) | How to write a harness for your framework |
| [`sdk/python/`](sdk/python/) | Reference SDK: types + emitter + **complete CTK runner** |
| [`sdk/{rust,typescript,dotnet,go}/`](sdk/) | Bindings over the Rust core: types, emitter, CTK runner, ReferenceHarness |
| [`docs/PRODUCTION.md`](docs/PRODUCTION.md) / [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Production checklist and operations runbook for host operators |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) | Threat catalog with mitigation→verification traceability |
| [`docs/CONTROLS-MAPPING.md`](docs/CONTROLS-MAPPING.md) / [`docs/INTEROP.md`](docs/INTEROP.md) | OWASP/NIST mapping; MCP and A2A interop guidance |
| [`docs/proposals/`](docs/proposals/) | Design proposals (process in [`docs/proposals/README.md`](docs/proposals/README.md)) |
| [`GOVERNANCE.md`](GOVERNANCE.md) / [`CONTRIBUTING.md`](CONTRIBUTING.md) / [`CHANGELOG.md`](CHANGELOG.md) | Project governance, contribution rules, change history |

## The contract in one diagram

```
┌──────────────────────── host framework ─────────────────────────┐
│                                                                 │
│  agent_startup ─► input ─► pre_model_call ─► post_model_call ─► │
│                               pre_tool_call ─► post_tool_call ─►│
│                                                output ─► shutdown
│        │              │              │              │           │
│        ▼              ▼              ▼              ▼           │
│   AgentContext    AgentContext    AgentContext    AgentContext      │
│        │              │              │              │           │
└────────┼──────────────┼──────────────┼──────────────┼───────────┘
         ▼              ▼              ▼              ▼
   ┌───────────────── Interceptor.intercept(ctx) ──────────────┐
   │     (ACS, content filter, rate limiter, egress guard…)    │
   └─────────────────────────┬────────────────────────────────┘
                             ▼
                   Verdict { allow | deny | transform }
                     (warnings ride on any verdict;
                      deny + approval block = liftable via the seam)
                             │
         ┌───────────────────┴───────────────────┐
         ▼                                       ▼
   permit → proceed                    block → halt
   (transform rewrites $target)        (liftable deny may be lifted
                                        by the approval seam, per the
                                        host's composition profile)
```

## Quick start

**Host (framework adapter):** see [`sdk/python/README.md`](sdk/python/README.md)
and [`conformance/HARNESS.md`](conformance/HARNESS.md).

**Interceptor:** implement `Interceptor.intercept(AgentContext) -> Verdict`
in any SDK; register with the host.

**Running it in production:** read [`docs/PRODUCTION.md`](docs/PRODUCTION.md)
(the decisions to make consciously) and [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
(failure reasons, rollout, alerting) first.

**Prove conformance:**

```bash
# The 0.1.0a1 artifact on PyPI implements a superseded draft — until
# 0.1.0a2 is published, install from source:
pip install "agent-hooks-sdk[ctk] @ git+https://github.com/responsibleai/agent-hooks.git#subdirectory=sdk/python"
pytest --agent-hooks-harness=your_pkg:YourHarness   # vectors ship in the wheel
```

## Conformance

A host is **conformant** when it passes 100% of the CTK vectors
applicable to its declared surface (interception-point capabilities,
composition profiles, identity provider) — a single bar covering
correct emission and correct enforcement (`deny`, `transform`,
liftable denies through the approval seam, `evaluate_only`,
fail-closed). There are no tiers or baseline profiles; the CTK report
enumerates per-part what was exercised. A conformance claim is not a
security certification.

See [`conformance/CLAIMS.md`](conformance/CLAIMS.md).

## Versioning

The **spec** is versioned `MAJOR.MINOR` independently of the **SDKs**
(semver). Each SDK declares the spec version it implements via
`SPEC_VERSION`. See [`VERSIONING.md`](VERSIONING.md).

## License

MIT — see [`LICENSE`](LICENSE).
