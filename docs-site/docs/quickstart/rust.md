# Rust quickstart

```sh
cargo add agent-hooks-sdk
cargo add tokio --features macros,rt-multi-thread   # or any executor
cargo add async-trait serde_json
```

The crate name is `agent-hooks-sdk`; the library name is
`agent_hooks`. The crate is runtime-agnostic: `emit` is async and runs
under any executor, and the recommended interceptor timeout is the
host's to enforce with its own runtime.

A minimal host with one control interceptor:

```rust
use agent_hooks::{
    AgentContext, AgentContextBuilder, Decision, EnforcementMode, InterceptionEmitter, Verdict,
};
use serde_json::json;

struct EgressGuard;

#[async_trait::async_trait]
impl agent_hooks::Interceptor for EgressGuard {
    async fn intercept(&self, context: &AgentContext) -> Verdict {
        let point = context["interception_point"].as_str().unwrap_or_default();
        if point != "pre_tool_call" {
            return Verdict::allow();
        }
        let args = context["tool_call"]["args"].to_string();
        if args.contains("account_balance") || args.contains("ssn") {
            return Verdict {
                decision: Decision::Deny,
                reason: Some("egress_blocked".into()),
                ..Verdict::allow()
            };
        }
        Verdict::allow()
    }

    fn name(&self) -> Option<String> {
        Some("egress-guard".into())
    }
}

#[tokio::main]
async fn main() {
    let mut emitter = InterceptionEmitter::new(EnforcementMode::Enforce, None);
    emitter.register(Box::new(EgressGuard));

    let mut build = AgentContextBuilder::new("support-agent", "quickstart", "s-001");

    let mut ctx = build.pre_tool_call("t-1", "web_search", json!({ "q": "docs" }));
    let outcome = emitter.emit(&mut ctx).await.expect("proceeds");
    println!("allowed: {}", outcome.record.verdict.decision.as_str());

    let mut ctx = build.pre_tool_call("t-2", "send_email", json!({ "body": "account_balance: 991" }));
    match emitter.emit(&mut ctx).await {
        Ok(_) => unreachable!(),
        Err(blocked) => {
            println!("denied: {}", blocked.record.verdict.reason.as_deref().unwrap_or("-"));
        }
    }
}
```

Output:

```text
allowed: allow
denied: egress_blocked
```

Things to notice:

- `emit` returns `Result<EmitOutcome, InterceptionBlocked>`; the
  blocked branch carries the record, and the success branch carries the
  effective target your action must consume.
- A deny is constructed with struct-update syntax over
  `Verdict::allow()`; the sugar constructors are `warn` and `escalate`.
- Rust is both the reference core and a full host SDK; the same crate
  ships the conformance kit behind the `ctk` feature.
