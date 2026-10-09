# agent-hooks (TypeScript SDK)

TypeScript implementation of
[AGENT-HOOKS-0.1](https://github.com/responsibleai/agent-hooks/blob/main/spec/AGENT-HOOKS-0.1.md)
over the canonical Rust core (napi-rs native module): interception
points, `AgentContextBuilder`, `Verdict` types, host-side
`InterceptionEmitter` with the four composition profiles, the
identity-provider seam, the host declaration loader, and the CTK
runner.

> **Trust model.** agent-hooks is a *cooperative contract*, not a security
> boundary: the host framework is fully trusted, interceptors run in-process
> with full data access, and no complete-mediation claim is made. Read
> [SECURITY.md](https://github.com/responsibleai/agent-hooks/blob/main/SECURITY.md)
> and [spec §1.4](https://github.com/responsibleai/agent-hooks/blob/main/spec/AGENT-HOOKS-0.1.md#14-trust-model-and-non-goals)
> before relying on it.

```bash
npm install @responsibleai/agent-hooks@alpha
```

Keep the `@alpha` tag (or pin an exact published version) while the
package is pre-release: npm's `latest` tag can lag the newest
pre-release, so a plain `npm install` may fetch an older build. Check
what the tags resolve to with
`npm view @responsibleai/agent-hooks dist-tags`.

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

`register(interceptor, name?, at?)` also takes the points an
interceptor runs at. At a point, `interceptors_registered`,
`verdicts[].index` and `decided_by` count and index the interceptors
bound there, in registration order.

## Host declaration

A host can load its configuration, declared surface and interceptor
bindings from one JSON document (spec §7.7) instead of calling the
setters. The document is a versioned contract,
`agent-hooks-declaration/1.0`, separate from the wire version
`agent-hooks/0.1`. The SDK exports the version it writes
(`DECLARATION_VERSION`) and the set it accepts
(`SUPPORTED_DECLARATION_VERSIONS`). A document of any other version is
refused.

```ts
import {
  HostDeclaration,
  HostRegistry,
  HostSurface,
  InterceptionEmitter,
} from "@responsibleai/agent-hooks";

// What the code can honour. A document may select a subset, never more.
const surface = HostSurface.fromCapabilities(["model_calls", "tool_calls", "host_declaration"]);

// Kind resolvers turn a binding's `config` into an interceptor. A kind
// is a lookup key the host names; the spec defines none.
const registry = new HostRegistry(surface)
  .kind("com.example.egress", (config, ctx) => new EgressGuard(config))
  .approvalResolver("operator-queue", queue);

const emitter = await InterceptionEmitter.fromDeclarationPath(
  "agent-hooks.declaration.json",
  registry,
);
```

The three construction paths yield the same emitter and the same
records: `fromDeclarationPath` reads a file, `fromDeclarationJson`
takes the text, `fromDeclarationValue` takes a parsed object, and
`fromDeclaration` takes a `HostDeclaration` (for example from
`HostDeclaration.builder()`, one setter per member and `bind(...)` per
binding). `emitter.declaration` is the resolved form with every default
filled; `canonicalDeclaration(emitter.declaration)` is its RFC 8785
canonical JSON, the equivalence oracle.

A document that names anything the host cannot honour is refused at
load, before any emission, with a `DeclarationError`. The error carries
`code` (one of eleven `declaration_error:*` classes), `findings` (JSON
pointer plus detail, never binding configuration) and, for
`version_unsupported`, `accepted`. The Rust core runs every check, so
the class is the same as in the other SDKs. An emitter built from a
declaration is sealed: `register` and the setters throw
`EmitterSealed`; `setRecordSink` and `takeRecords` stay allowed.
Records from such an emitter carry `declaration:
"agent-hooks-declaration/1.0"`; records from an emitter configured in
code do not and are unchanged.

**JavaScript value-domain caveat (spec §4.4):** `JSON.parse` rounds
integers beyond 2^53 before any guard can run, so this SDK cannot claim
the `int64_json`/`bigint_json` CTK capabilities — string-encode
64-bit identifiers at the adapter boundary. Non-finite numbers are
rejected fail-closed by a pre-serialization scan. The same rounding
applies to `bindings[].config`: the loader hands the core the validated
text, so the load checks see the integers the file had, but the
resolved form and a kind resolver receive JavaScript values.
String-encode 64-bit values in binding configuration too.

## Native module deployment

The napi-rs native module (`*.node`) ships as per-platform
`optionalDependencies` packages (the standard napi-rs multi-platform
layout): `linux-x64-gnu`, `linux-arm64-gnu`, `darwin-x64`,
`darwin-arm64` and `win32-x64-msvc`. On other platforms, install from
source (needs a Rust toolchain): `npm run build` produces the module
for your host platform. A platform mismatch fails at `require` time
with a module-load error naming the missing `.node` binary.
