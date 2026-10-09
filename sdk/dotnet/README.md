# agent-hooks (.NET SDK)

.NET implementation of
[AGENT-HOOKS-0.1](https://github.com/responsibleai/agent-hooks/blob/main/spec/AGENT-HOOKS-0.1.md)
over the canonical Rust core (`libagent_hooks_ffi` via
`LibraryImport`): interception points, `AgentContextBuilder`,
`Verdict` types, host-side `InterceptionEmitter` with the four
composition profiles, the identity-provider seam, and the CTK runner.

> **Trust model.** agent-hooks is a *cooperative contract*, not a security
> boundary: the host framework is fully trusted, interceptors run in-process
> with full data access, and no complete-mediation claim is made. Read
> [SECURITY.md](https://github.com/responsibleai/agent-hooks/blob/main/SECURITY.md)
> and [spec §1.4](https://github.com/responsibleai/agent-hooks/blob/main/spec/AGENT-HOOKS-0.1.md#14-trust-model-and-non-goals)
> before relying on it.

```bash
# Or build from source (needs a Rust toolchain):
git clone https://github.com/responsibleai/agent-hooks && cd agent-hooks
cargo build --release --manifest-path sdk/rust/Cargo.toml -p agent-hooks-ffi
dotnet build sdk/dotnet
# at runtime the native library must be resolvable, e.g.:
# LD_LIBRARY_PATH=sdk/rust/target/release dotnet run
```

## Usage

```csharp
using AgentHooks;

var emitter = new InterceptionEmitter(EnforcementMode.Enforce, resolver: null)
    .Register(new MyPolicy());
var builder = new AgentContextBuilder("my-agent", "my-fw", "s-1");

var ctx = builder.PreToolCall("tc-1", "http_get", new JsonObject { ["url"] = url });
var record = await emitter.EmitUncheckedAsync(ctx);
if (!record.Proceeds) return ToolError(record.Verdict.Reason);
// proceed with ctx["tool_call"]["args"] (post-transform)
```

`Verdict.Warn(..)` / `Verdict.Escalate(..)` are the §5 constructor
shortcuts. Run the conformance tests with
`LD_LIBRARY_PATH=../rust/target/release dotnet test`.

## Host declaration

A host can load its configuration, declared surface and interceptor
bindings from a host declaration document (spec §7.7) instead of
calling the setters. The document is a versioned contract of its own,
`agent-hooks-declaration/1.0` (`Declaration.Version`,
`Declaration.SupportedVersions`), separate from the wire version
`Spec.Version`.

The host registers what its code can honour in a `HostRegistry`: its
surface, a resolver per binding kind, and any custom identity provider,
approval resolver or approval redactor the document may name. A kind
is a lookup key the host controls (`com.example.egress`), never a path
or class name the loader interprets.

```csharp
using AgentHooks;

var surface = HostSurface.SdkDefault()
    .WithPoints(InterceptionPoint.PreToolCall, InterceptionPoint.PostToolCall)
    .WithCapabilities("tool_calls");
var registry = new HostRegistry(surface)
    .Kind("com.example.egress", (config, ctx) => new EgressGuard(config))
    .ApprovalResolver("operator-queue", queue);

var emitter = InterceptionEmitter.FromDeclarationPath("agent-hooks.declaration.json", registry);
// or: FromDeclarationJson(text, registry), FromDeclarationNode(jsonObject, registry),
// or the code path:
var declaration = HostDeclaration.Builder()
    .Composition(CompositionConfig.RunAll())
    .ApprovalResolver("operator-queue")
    .Bind("egress", "com.example.egress", new JsonObject { ["allow_hosts"] = new JsonArray("internal.example") },
          at: [InterceptionPoint.PreToolCall])
    .Build();
emitter = InterceptionEmitter.FromDeclaration(declaration, registry);
```

The three paths yield the same emitter and the same records. The Rust
core validates the document and resolves it against the registry; the
host's kind resolvers then run once per binding, in array order. A
document that names anything the code cannot honour is refused before
any emission with a `DeclarationException` carrying the
`declaration_error:*` class (`Class`, `Code`), the findings (JSON
pointer and detail) and, for an unsupported version, the accepted
versions. Nothing is narrowed or applied in part.

An emitter built from a declaration is sealed: `Register`,
`SetComposition`, `SetIdentityProvider`, `SetApprovalRedactor` and
`SetMaxRecords` throw `InvalidOperationException`; `SetRecordSink` and
`TakeRecords` stay allowed. Its records carry `Declaration`, the
contract version, and `emitter.Declaration` exposes the resolved form
and its canonical JSON. Bindings run only at the points their `at`
lists; `Register(interceptor, name, at)` offers the same per-point
registration on the code path.

The CTK reference harness (`AgentHooks.Conformance.ReferenceHarness`)
declares the `host_declaration` capability, ships its own declaration
as an embedded resource and builds every emitter through the loader.
A harness that adopts the declaration seam implements
`IHarness.SetupDeclared` and may return its document from
`IHarness.Declaration`.

## Native library deployment

`ResponsibleAI.AgentHooks` P/Invokes `libagent_hooks_ffi`. The NuGet
package bundles it for linux-x64, osx-x64, osx-arm64, and win-x64 under
`runtimes/<rid>/native/`, so package consumers need no extra step
(versions up to 0.1.0-alpha.3 shipped managed code only). For source
builds or other platforms, build it per target
(`cargo build --release -p agent-hooks-ffi` under `sdk/rust`) and make
it resolvable at process start:

| OS | Artifact | Resolution |
| --- | --- | --- |
| Linux | `libagent_hooks_ffi.so` | `LD_LIBRARY_PATH`, or place next to the app binary |
| macOS | `libagent_hooks_ffi.dylib` | `DYLD_LIBRARY_PATH`, or next to the app binary |
| Windows | `agent_hooks_ffi.dll` | `PATH`, or next to the app binary |

For self-contained deployment, ship the library app-local using the
standard RID layout — add to your **application** csproj:

```xml
<ItemGroup>
  <None Include="path/to/libagent_hooks_ffi.so"
        Link="runtimes/linux-x64/native/libagent_hooks_ffi.so"
        CopyToOutputDirectory="PreserveNewest" />
</ItemGroup>
```

A missing library fails at first native call with `DllNotFoundException`
naming `agent_hooks_ffi` — it is a deployment error, not a package bug.
Per-RID bundling inside the NuGet package (`runtimes/<rid>/native/`) is
planned but not yet shipped.
