# agent-hooks

> Status: Beta. Spec: [AGENT-HOOKS-0.1](spec/AGENT-HOOKS-0.1.md), wire
> version `agent-hooks/0.1`. Host declaration contract:
> `agent-hooks-declaration/1.0`
> ([version table](spec/DECLARATION-VERSIONS.md)).

Agent Hooks is the interception contract between an agent host and the
controls that govern it. It fixes eight points in the agent loop, the
context the host hands over at each, the verdict a control returns, and
what the host must do with that verdict. Any host (a framework, a
runtime, a gateway) can expose the contract, and any control (a policy
engine, a content filter, a rate limiter, an approval gateway, an egress
guard) can target it. Agent Hooks is not a policy engine: it carries no
rules and makes no decisions of its own. It is not a sandbox: the host
is trusted, interceptors run in-process with full data access, and the
eight points do not promise complete mediation. It is a control plane,
not a telemetry plane: every verdict binds the host, and passive
observation is out of scope. See [SECURITY.md](SECURITY.md) and
[spec §1.4](spec/AGENT-HOOKS-0.1.md#14-trust-model-and-non-goals).

## Points and verdicts

| Interception point | When | Target a `transform` may rewrite |
| --- | --- | --- |
| `agent_startup` | Once, before the first input of a session | none |
| `input` | Each external request entering the session | `input` |
| `pre_model_call` | Before each model request | `messages` |
| `post_model_call` | After each model response | `response` |
| `pre_tool_call` | Before each tool invocation | `tool_call.args` |
| `post_tool_call` | After each tool invocation | `tool_result.value` |
| `output` | Before the final response leaves | `output` |
| `agent_shutdown` | Once, at the end of the session | none |

| Verdict | Host obligation |
| --- | --- |
| `allow` | Proceed. Record any warnings the verdict carries. |
| `transform` | Apply the rewrite to the target, then proceed with the new value. |
| `deny` | Do not proceed. A deny that carries an `approval` block is liftable through the approval seam (§9); until lifted it is a deny. |

Warnings ride on any verdict. A host that cannot build a valid context,
or whose interceptor raises, times out or returns an invalid verdict,
denies with a reserved `host_error:*` reason (§6.3, §11). Zero
registered interceptors in `enforce` mode denies too (§7).

## Adopting it as a host

A host builds one emitter, registers interceptors with it, and emits a
context at each point. There are three ways to build the emitter, and
they produce the same emitter and the same records:

1. From a host declaration file.
2. From the declaration as JSON text or a parsed value.
3. In code, through a declaration builder; its value goes through the
   same loader.

The constructor and setters still work and stay conformant. That path
carries no declaration, is not sealed, and its records are unchanged.

The host declaration (spec §7.7) is one JSON document that states the
host's configuration, its declared surface and its interceptor
bindings. It is a versioned contract of its own,
`agent-hooks-declaration/1.0`, separate from the wire version and from
package versions. Enterprise settings channels can carry it unchanged.

```json
{
  "$schema": "https://responsibleai.github.io/agent-hooks/schema/v0.1/host-declaration-1.0.schema.json",
  "declaration": "agent-hooks-declaration/1.0",
  "spec": "agent-hooks/0.1",
  "id": "prod-eu-strict",
  "host": { "name": "example-runtime", "version": "3.2.0" },
  "configuration": {
    "mode": "enforce",
    "composition": { "profile": "parallel/unanimous", "on_disagreement": "approval" },
    "identity_provider": "jcs-sha256",
    "approval": { "resolver": "operator-queue", "redactor": "strip-secrets" },
    "posture": { "tool_seam_host_error": "continue" },
    "timeouts": { "interceptor_ms": 5000, "approval_resolver_ms": 30000 },
    "records": { "max_buffered": 10000 }
  },
  "surface": {
    "interception_points": [
      "agent_startup", "input", "pre_model_call", "post_model_call",
      "pre_tool_call", "post_tool_call", "output", "agent_shutdown"
    ],
    "capabilities": ["model_calls", "tool_calls", "int64_json", "host_declaration"],
    "profiles": {
      "sequential/first_deny": { "on_approval": ["stop", "resume"] },
      "sequential/run_all": {},
      "parallel/strictest": { "on_transform_conflict": ["deny", "approval"] },
      "parallel/unanimous": { "on_disagreement": ["deny", "approval"] }
    },
    "buffered_output": true,
    "declaration_versions": ["agent-hooks-declaration/1.0"]
  },
  "bindings": [
    {
      "id": "egress-guard",
      "kind": "com.example.egress",
      "at": ["pre_tool_call", "output"],
      "config": { "allow_hosts": ["internal.example"] },
      "timeout_ms": 2000
    },
    { "id": "audit", "kind": "com.example.audit-log", "config": { "sink": "stdout" } }
  ]
}
```

Only `declaration` and `bindings` are required. Every other member
defaults to the value the spec already names, and every default fails
closed. A binding is a `kind` plus a kind-specific `config`. The kind
is a lookup key the host controls; the spec defines no kinds and names
no product. The host registers a resolver per kind in code, along with
any custom identity provider, approval resolver or redactor the
document may name, and the surface its code supports:

```python
from agent_hooks import HostRegistry, HostSurface, InterceptionEmitter

registry = (
    HostRegistry(
        HostSurface.from_capabilities(
            ["model_calls", "tool_calls", "int64_json", "host_declaration"]
        )
    )
    .kind("com.example.egress", lambda config, ctx: EgressGuard(**config))
    .kind("com.example.audit-log", lambda config, ctx: AuditLog(**config))
    .approval_resolver("operator-queue", OperatorQueue())
    .approval_redactor("strip-secrets", strip_secrets)
)
emitter = InterceptionEmitter.from_declaration_path("agent-hooks.declaration.json", registry)
```

A document that names a point, profile, capability, provider or kind
the code cannot honour is refused at load, before any emission, with
one of eleven `declaration_error:*` classes
([`spec/declaration-errors.json`](spec/declaration-errors.json)).
Nothing is narrowed or applied in part. A loader refuses a version it
does not accept and names the versions it does. Once built, the emitter
is sealed, and every record it writes carries the contract version.
The per-SDK READMEs show the same calls in each language.

## Composition and seams

- Composition profile (§7): `sequential/first_deny` (default),
  `sequential/run_all`, `parallel/strictest`, `parallel/unanimous`,
  each with the knobs it consults. The profile in effect is stamped on
  every record.
- Approval seam (§9): a liftable deny consults the host's registered
  resolver; the resolution echoes the context identity, so an approval
  binds to the content the approver saw. No resolver means the deny
  stands.
- Redaction seam (§9): a registered redactor shapes what the approver
  sees; the identity is computed over the redacted context.
- Identity provider (§10.1): `jcs-sha256` by default, a named custom
  provider, or `null` for identity-unbound records.
- Interception record (§10.3): payload-free by construction, one per
  emission, with the verdict projection, identities, composition and
  the declaration version when a declaration built the emitter.
- Enforcement mode (§8): `enforce`, or `evaluate_only` for records
  without effect.

Everything normative runs once, in the Rust core. The Python,
TypeScript, .NET and Go SDKs bind it and own only dispatch into host
code, timeouts and runtime integration. Golden vectors pin
byte-identical records across the five.

## Conformance

The Conformance Test Kit under [`conformance/`](conformance/) is the
test. A host implements the `Harness` interface in one SDK
([`conformance/HARNESS.md`](conformance/HARNESS.md)), declares its
surface (points, capabilities, profiles and knob values, identity
provider, posture), and passes every vector that applies to that
surface. There are no tiers. The report lists what ran, per part. A
host may present its surface as a host declaration document, and a
claim may cite that file. Claims live in
[`conformance/CLAIMS.md`](conformance/CLAIMS.md). A conformance claim
is not a security certification.

## Install

| SDK | Install |
| --- | --- |
| Rust | `cargo add agent-hooks-sdk` |
| Python | `pip install --pre agent-hooks-sdk` |
| TypeScript | `npm install @responsibleai/agent-hooks@alpha` |
| .NET | `dotnet add package ResponsibleAI.AgentHooks --prerelease` |
| Go | `go get github.com/responsibleai/agent-hooks/sdk/go/agenthooks` |

Keep the `@alpha` tag (or pin an exact version) while the npm package
is pre-release. npm's `latest` tag can lag the newest pre-release, so a
plain `npm install` may fetch an older build. Maintainers move the tag
per [RELEASING.md](RELEASING.md).

The spec is versioned `MAJOR.MINOR`, the declaration contract
`MAJOR.MINOR`, and the packages by semver, each on its own axis. Every
SDK exports the spec version, the current declaration version and the
accepted set (`SPEC_VERSION`, `DECLARATION_VERSION` and
`SUPPORTED_DECLARATION_VERSIONS` in Rust, Python and TypeScript; the
same names in .NET and Go casing). See [VERSIONING.md](VERSIONING.md)
and [spec/DECLARATION-VERSIONS.md](spec/DECLARATION-VERSIONS.md).

## Read next

- [`spec/AGENT-HOOKS-0.1.md`](spec/AGENT-HOOKS-0.1.md): the normative
  text; [`spec/schema/`](spec/schema/) holds the JSON Schemas.
- [`docs/IMPLEMENTING.md`](docs/IMPLEMENTING.md): what it means to
  implement Agent Hooks in a harness or gateway.
- [`conformance/HARNESS.md`](conformance/HARNESS.md): how to write a
  harness and run the CTK.
- [`docs/PRODUCTION.md`](docs/PRODUCTION.md) and
  [`docs/OPERATIONS.md`](docs/OPERATIONS.md): the decisions to make
  before production and the runbook after.
- [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md),
  [`docs/CONTROLS-MAPPING.md`](docs/CONTROLS-MAPPING.md),
  [`docs/INTEROP.md`](docs/INTEROP.md): threats and mitigations,
  OWASP and NIST mapping, MCP and A2A interop.
- [`docs/proposals/`](docs/proposals/): design proposals and the
  process in [`docs/proposals/README.md`](docs/proposals/README.md).
- [`GOVERNANCE.md`](GOVERNANCE.md), [`CONTRIBUTING.md`](CONTRIBUTING.md),
  [`CHANGELOG.md`](CHANGELOG.md).

## License

MIT. See [`LICENSE`](LICENSE).
