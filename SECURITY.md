# Security

## Trust model

agent-hooks is a **cooperative contract**, not a security boundary.

| Party | Trust |
| --- | --- |
| Host (agent framework) | **Fully trusted.** Every guarantee in the spec (§6 host obligations, §1.3 no-silent-bypass) is a MUST on the host. A non-cooperative or buggy host can skip interception points, ignore verdicts, or run in `evaluate_only`, and nothing in agent-hooks detects it. |
| Interceptors | **Fully trusted by the host.** They run in-process, receive raw `AgentContext` (which may contain user PII, secrets in tool arguments, and model output), and any registered interceptor can `deny` or `transform` any target. Registering an interceptor grants it write access to every action the agent takes. |
| Approval resolver | **Fully trusted by the host.** Same process, same data access. |
| Identity provider | **Fully trusted by the host.** Receives the raw `AgentContext` and produces the sole value approval binding (§9) and audit correlation rest on. A malicious or non-deterministic provider breaks both silently; the spec's only guards are the §10.1 name rules, the fail-closed failure rule, and the claim disclosure (§13.3). |
| Model, tools, external inputs | **Untrusted.** This is the adversary the contract targets: an interceptor makes control decisions about untrusted data flowing through a trusted host. |

## What agent-hooks is not

- **Not a sandbox.** Tool and model calls execute with whatever privilege the host process has. agent-hooks does not isolate them.
- **Not a reference monitor.** The eight interception points cover the paths a conformant host wires. A framework may expose direct tool execution, plugin code, or background tasks that never reach `pre_tool_call`; the spec does not claim complete mediation and the CTK cannot detect bypass paths.
- **Not an authentication or isolation layer for interceptors.** All registered interceptors are one trust class. The spec does not define how a host authenticates them or restricts what they may return.
- **Not a security certification.** A conformance claim (§13) attests that the host adapter honours the verdict contract under CTK conditions with mocked model and tools. It does not test adversarial bypass, does not assure the production code path matches the harness, and says nothing about the interceptors registered in production.

The normative statement is [spec §1.4](spec/AGENT-HOOKS-0.1.md#14-trust-model-and-non-goals); see also [§14 Security considerations](spec/AGENT-HOOKS-0.1.md#14-security-considerations) and the [threat model](docs/THREAT-MODEL.md).

## Reporting a vulnerability

Report privately via [GitHub Security Advisories](https://github.com/responsibleai/agent-hooks/security/advisories/new). Do not open a public issue for undisclosed vulnerabilities. We aim to acknowledge within 3 business days.

## Supported versions

Pre-1.0: only the latest tagged release (spec + SDKs together) receives security fixes.

> **No release is currently supported.** The repo has no tags yet, and the
> artifacts published to registries as `0.1.0a1` / `0.1.0-alpha.1`
> (PyPI `agent-hooks-sdk`, crates.io `agent-hooks-sdk`) implement a
> **superseded draft** of the spec that predates the three-verdict model,
> composition profiles, and the identity-provider seam. Do not build on
> them; install from source (`main`) until `0.1.0a2` is published. Each
> SDK reports the spec revision it implements via its `SPEC_VERSION`
> constant / `ah_spec_version()`.
