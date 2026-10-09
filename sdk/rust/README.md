# agent-hooks (Rust)

Canonical implementation of
[AGENT-HOOKS-0.1](https://github.com/responsibleai/agent-hooks/blob/main/spec/AGENT-HOOKS-0.1.md).
The `core/` crate (`agent-hooks-sdk` on crates.io, lib name
`agent_hooks`) implements every contract primitive — canonical JSON,
context identity, verdict validation, transform application,
composition aggregation — and is also a full Rust host SDK. The
`ffi/` crate exposes the C ABI (`libagent_hooks_ffi`) that the
Python, TypeScript, .NET, and Go wrappers bind.

> **Trust model.** agent-hooks is a *cooperative contract*, not a security
> boundary: the host framework is fully trusted, interceptors run in-process
> with full data access, and no complete-mediation claim is made. Read
> [SECURITY.md](https://github.com/responsibleai/agent-hooks/blob/main/SECURITY.md)
> and [spec §1.4](https://github.com/responsibleai/agent-hooks/blob/main/spec/AGENT-HOOKS-0.1.md#14-trust-model-and-non-goals)
> before relying on it.

```bash
cargo add agent-hooks-sdk
```

## Host usage

```rust
use agent_hooks::{AgentContextBuilder, EnforcementMode, InterceptionEmitter, Verdict};

let mut emitter = InterceptionEmitter::new(EnforcementMode::Enforce, None);
emitter.register(Box::new(my_interceptor));
let mut builder = AgentContextBuilder::new("my-agent", "my-fw", "s-1");

let mut ctx = builder.pre_tool_call("tc-1", "http_get", serde_json::json!({"url": url}));
match emitter.emit(&mut ctx).await {
    Ok(record) => { /* proceed with ctx["tool_call"]["args"] (post-transform) */ }
    Err(blocked) => { /* surface blocked.record.verdict.reason as a tool error */ }
}
```

Interceptors implement `Interceptor::intercept(&AgentContext) -> Verdict`;
`Verdict::warn(..)` / `Verdict::escalate(..)` are the §5 constructor
shortcuts. The CTK runner and reference harness live behind the `ctk`
feature; timeouts are host-owned (see the `emitter` module docs).

Golden identity vectors pin byte-identical canonicalization across all
five SDKs: `cargo test --workspace --all-features`.

## Host declaration

A host can load its configuration, declared surface and interceptor
bindings from a host declaration document (spec section 7.7) instead of
calling the setters. The document is a versioned contract of its own,
`agent-hooks-declaration/1.0`, separate from the wire version. The crate
exports `DECLARATION_VERSION` and `SUPPORTED_DECLARATION_VERSIONS`.

The host registers in code what a document may reference: its surface,
kind resolvers (one closure per binding kind), custom identity
providers, approval resolvers and redactors. A document that names
anything the registry does not hold is refused at load, before any
emission.

```rust
use agent_hooks::{HostRegistry, HostSurface, InterceptionEmitter, InterceptionPoint};

let surface = HostSurface::sdk_default()
    .with_points([InterceptionPoint::PreToolCall, InterceptionPoint::PostToolCall])
    .with_capabilities(["tool_calls".to_owned()]);

let registry = HostRegistry::new(surface)
    .kind("com.example.egress", Box::new(|config, _ctx| {
        // Validates its own config; never echoes it in errors.
        Egress::from_config(config).map(|i| Box::new(i) as Box<dyn agent_hooks::Interceptor>)
    }))?
    .approval_resolver("operator-queue", Box::new(queue))?;

// Three construction paths, one loader, the same records:
let emitter = InterceptionEmitter::from_declaration_path("agent-hooks.declaration.json", &registry)?;
let emitter = InterceptionEmitter::from_declaration_json(&text, &registry)?;
let decl = agent_hooks::HostDeclaration::builder()
    .approval_resolver(Some("operator-queue"))
    .bind("egress", "com.example.egress", serde_json::json!({"allow_hosts": ["internal.example"]}),
        Some(&[InterceptionPoint::PreToolCall, InterceptionPoint::Output]), None)
    .build()?;
let emitter = InterceptionEmitter::from_declaration(decl, &registry)?;
```

A refusal is a `DeclarationError` with `class`, `findings` (JSON pointer
and detail) and, for an unsupported version, `accepted`; `code()` gives
the namespaced class (`declaration_error:unknown_field`). The same
checks run for every SDK, since Python and TypeScript bind this crate
in-process and .NET and Go call it through the C ABI.

An emitter built from a declaration is sealed: `register`,
`register_at` and the setters panic. `declaration()` returns the
resolved form; its `canonical_json()` is the same string for the path,
JSON and code paths. Every record such an emitter writes carries
`declaration: "agent-hooks-declaration/1.0"`; records from an emitter
configured with `new` and the setters carry no such member. Bindings
run per point: `register_at` offers the same per-point binding in code,
and `interceptors_registered`, `verdicts[].index` and `decided_by`
count the interceptors bound at the emitted point. A numeric
`timeouts.interceptor_ms` is refused unless the `tokio-timeout` feature
is on, because the core cannot bound execution without it.

## Native artifact notes

Rust hosts consume the `agent-hooks-sdk` crate directly — no dynamic
library involved. The `ffi/` crate (cdylib `libagent_hooks_ffi`) exists
for the other four SDKs; build it with
`cargo build --release -p agent-hooks-ffi` when developing against
Python/TypeScript/.NET/Go locally (their READMEs cover per-OS
placement).
