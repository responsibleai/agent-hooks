# agent-hooks (.NET SDK)

.NET implementation of
[AGENT-HOOKS-0.1](https://github.com/responsibleai/agent-hooks/blob/main/spec/0.1.0/AGENT-HOOKS-0.1.md)
over the canonical Rust core (`libagent_hooks_ffi` via
`LibraryImport`): interception points, `AgentContextBuilder`,
`Verdict` types, host-side `InterceptionEmitter` with the four
composition profiles, the identity-provider seam, and the CTK runner.

> **Trust model.** agent-hooks is a *cooperative contract*, not a security
> boundary: the host framework is fully trusted, interceptors run in-process
> with full data access, and no complete-mediation claim is made. Read
> [SECURITY.md](https://github.com/responsibleai/agent-hooks/blob/main/SECURITY.md)
> and [spec §1.4](https://github.com/responsibleai/agent-hooks/blob/main/spec/0.1.0/AGENT-HOOKS-0.1.md#14-trust-model-and-non-goals)
> before relying on it.

```bash
# Or build from source on Linux/macOS (needs a Rust toolchain):
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

### Failure posture (`on_error`)

Every registration fails closed by default: a throw, a timeout or a
§5-invalid return value becomes a `host_error:*` deny in that
registration's slot (spec §6.3), and nothing else is ever opened
(context failures, cancellation, transform and approval failures,
`no_interceptor` and an explicit deny never continue). A registration
can be best effort instead, through
`RegisterWithOptions(interceptor, new RegistrationOptions("scanner", OnError: OnError.Continue))`
or `on_error: continue` on a binding in a 1.1 declaration: the host then
substitutes an allow carrying the warning `host_warning:control_failed`,
records the underlying reason on `verdicts[].substituted_for` and tells
the principal through the notifier set with `SetControlFailureNotifier`
(or `HostRegistry.ControlFailureNotifier`), which must exist first or
the registration is refused. An interceptor that runs external work can
own its deadline by implementing `IManagedInterceptor` (registered with
`RegisterManaged` or `HostRegistry.ManagedKind`): it receives the
resolved bound and reports a `ManagedInterceptorOutcome` (`FromVerdict`,
`Timeout` after cleanup, `Cancelled`, `Failed`), where a cancelled
outcome is never a timeout and never continues.

## Host declaration

A host can load its configuration, declared surface and interceptor
bindings from a host declaration document (spec §7.7) instead of
calling the setters. The document is a versioned contract of its own,
`agent-hooks-declaration/1.1` (`Declaration.Version`,
`Declaration.SupportedVersions`, which also lists `1.0`), separate from
the wire version `Spec.Version`. 1.1 adds two optional members,
`configuration.failure.on_error` and `bindings[].on_error`
(`DeclarationBuilder.FailureOnError`, `BindWith(.., new BindOptions(OnError: ..))`);
a 1.0 document loads unchanged and keeps its own version on its records.

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

### Windows x64 source builds and release checks

The bundled Windows x64 DLL must pass both Control Flow Guard (CFG,
BinSkim BA2008) and the per-function stack-protection check (BA2014).
The latter also examines Rust's linked standard-library/runtime code:
protecting just the FFI crate leaves precompiled runtime functions unprotected.
Stable Rust 1.95.0 does not support the required stack-protector option.

From the repository root, in a Windows developer shell with the x64 MSVC
linker available and PowerShell 7.4 or later:

```powershell
rustup toolchain install nightly-2026-10-21 --profile minimal --component rust-src --target x86_64-pc-windows-msvc
$env:RUSTFLAGS = '-C control-flow-guard=checks -Z stack-protector=strong -D partial-stack-protector'
$env:CARGO_ENCODED_RUSTFLAGS = $null
Push-Location sdk\rust
try {
    cargo +nightly-2026-10-21 -Z build-std=std,panic_unwind build --locked --release `
        -p agent-hooks-ffi --target x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) { throw 'Protected Windows FFI build failed.' }
} finally { Pop-Location }
$env:RUSTFLAGS = $null
$env:PATH = "$(Resolve-Path sdk\rust\target\x86_64-pc-windows-msvc\release);$env:PATH"
dotnet test sdk\dotnet\test\AgentHooks.Tests
```

Use a dedicated developer shell: the environment flags above are process-local.
Keep the checkout/output path short enough for MSVC's native library paths.
This nightly pin is limited to the Windows x64 FFI/NuGet artifact; direct Rust,
Python, TypeScript, GNU cgo and non-Windows builds retain their existing toolchains.
The compiler rejects partial stack protection rather than allowing unprotected
runtime dependencies. No public API or wire format changes.

CI and release use the same
[Windows FFI action](../../.github/actions/windows-ffi/action.yml), including
a hash-pinned, signature-verified Microsoft.CodeAnalysis.BinSkim 4.4.9 package.
They retain the DLL, matching PDB and full scan report as
`windows-ffi-hardening` build artifacts. The gate requires a completed analysis,
the exact DLL hash, successful adjacent-PDB loading, unsuppressed BA2014/BA2008
passes and no error findings; warnings remain visible in the full report.
To check an equivalent local scan produced with `--hashes true --trace PdbLoad`:

```powershell
.\scripts\check-windows-stack-protection.ps1 `
    -Dll sdk\rust\target\x86_64-pc-windows-msvc\release\agent_hooks_ffi.dll `
    -Report <full-binskim.sarif>
```

The existing CFG gate additionally checks the PE flag, load-configuration
instrumentation and nonempty function table. The NuGet gate verifies that
the payload is byte-identical to the scanned/staged release DLL:

```powershell
.\scripts\check-windows-cfg.ps1 -Dll sdk\rust\target\x86_64-pc-windows-msvc\release\agent_hooks_ffi.dll
.\scripts\check-windows-cfg.ps1 -Package <package.nupkg> -ExpectedDll <staged-agent_hooks_ffi.dll>
```

Run these commands from the repository root with PowerShell 7.4 or later.
These checks do not establish downstream Guardian acceptance or waive other
BinSkim findings. For example, the existing BA2024/BA2025/BA2026/BA2027/BA6006
warnings are separate from BA2014.

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
