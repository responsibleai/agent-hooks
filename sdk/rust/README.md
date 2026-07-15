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
# The 0.1.0-alpha.1 crate on crates.io implements a superseded draft —
# until 0.1.0-alpha.2 is published, use a git dependency:
cargo add agent-hooks-sdk --git https://github.com/responsibleai/agent-hooks
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

## Native artifact notes

Rust hosts consume the `agent-hooks-sdk` crate directly — no dynamic
library involved. The `ffi/` crate (cdylib `libagent_hooks_ffi`) exists
for the other four SDKs; build it with
`cargo build --release -p agent-hooks-ffi` when developing against
Python/TypeScript/.NET/Go locally (their READMEs cover per-OS
placement).
