# agent-hooks (TypeScript SDK)

TypeScript implementation of
[AGENT-HOOKS-0.1](https://github.com/responsibleai/agent-hooks/blob/main/spec/AGENT-HOOKS-0.1.md)
over the canonical Rust core (napi-rs native module): interception
points, `AgentContextBuilder`, `Verdict` types, host-side
`InterceptionEmitter` with the four composition profiles, the
identity-provider seam, and the CTK runner.

> **Trust model.** agent-hooks is a *cooperative contract*, not a security
> boundary: the host framework is fully trusted, interceptors run in-process
> with full data access, and no complete-mediation claim is made. Read
> [SECURITY.md](https://github.com/responsibleai/agent-hooks/blob/main/SECURITY.md)
> and [spec §1.4](https://github.com/responsibleai/agent-hooks/blob/main/spec/AGENT-HOOKS-0.1.md#14-trust-model-and-non-goals)
> before relying on it.

```bash
# Not yet published to npm — install from source:
git clone https://github.com/responsibleai/agent-hooks && cd agent-hooks/sdk/typescript
npm install && npm run build   # builds the native module (needs a Rust toolchain)
```

## Usage

```ts
import { AgentContextBuilder, InterceptionEmitter, Verdict } from "@responsibleai/agent-hooks";

const emitter = new InterceptionEmitter();
emitter.register({
  intercept(ctx) {
    if (ctx.interception_point === "pre_tool_call" && ctx.tool_call.name === "rm") {
      return { decision: "deny", reason: "dangerous" };
    }
    return { decision: "allow" };
  },
});

const builder = new AgentContextBuilder({ agentId: "my-agent", framework: "my-fw", sessionId: "s-1" });
const ctx = builder.preToolCall("tc-1", "http_get", { url });
await emitter.emit(ctx); // throws InterceptionBlocked on a combined deny
```

**JavaScript value-domain caveat (spec §4.4):** `JSON.parse` rounds
integers beyond 2^53 before any guard can run, so this SDK cannot claim
the `int64_json`/`bigint_json` CTK capabilities — string-encode
64-bit identifiers at the adapter boundary. Non-finite numbers are
rejected fail-closed by a pre-serialization scan.

## Native module deployment

The napi-rs native module (`*.node`) ships as per-platform
`optionalDependencies` packages (the standard napi-rs multi-platform
layout): `linux-x64-gnu`, `linux-arm64-gnu`, `darwin-x64`,
`darwin-arm64` and `win32-x64-msvc`. On other platforms, install from
source (needs a Rust toolchain): `npm run build` produces the module
for your host platform. A platform mismatch fails at `require` time
with a module-load error naming the missing `.node` binary.
