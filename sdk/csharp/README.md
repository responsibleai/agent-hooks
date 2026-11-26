# agent-hooks (.NET SDK)

A managed .NET 8 host SDK for the
[agent-hooks draft specification](https://github.com/responsibleai/agent-hooks/blob/main/spec/draft/AGENT-HOOKS-DRAFT.md):
typed interception points, all four composition profiles, evaluation mode,
timeouts and failure posture, the approval seam, RFC 8785 context identity,
payload-free audit records, and host declarations. No native libraries or
platform-specific assets.

> **Trust model.** agent-hooks is a *cooperative contract*, not a security
> boundary: the host framework is fully trusted and interceptors run in-process
> with full data access. Read
> [SECURITY.md](https://github.com/responsibleai/agent-hooks/blob/main/SECURITY.md)
> before relying on it.

**Documentation:**
[.NET quickstart](https://responsibleai.github.io/agent-hooks/quickstart/dotnet/) ·
[.NET SDK guide](https://responsibleai.github.io/agent-hooks/sdk/dotnet/)

## Package contents

The SDK ships as one NuGet package, `ResponsibleAI.AgentHooks`, carrying two
managed assemblies:

| Assembly | Contents |
| --- | --- |
| `AgentHooks.Contracts` | Types generated from `spec/draft` TypeSpec: per-point requests, responses (with `Allow`/`Deny`/`Transform*` factories) and transforms, verdicts, approval requests/resolutions, `InterceptionRecord`, `HostDeclaration`, per-point hook interfaces (`IAgentStartupHook` … `IAgentShutdownHook`), `IInterceptor`, `IApprovalResolver`, and `InterceptionPoints` metadata. |
| `AgentHooks` | The runtime: `HookEmitter`, `HookEmitterBuilder`, `IHookInterceptor`, `IApprovalResolver`, `BindingOptions`, `IdentityProvider`, `Jcs`, `HostErrors`, `ContractSerializer`, `HostSurface`, `HostRegistry`, and `DeclarationException`. |

`AgentHooks.Conformance`, the draft CTK runner and reference harness, lives in
the repository and is not packaged.

## Install

```bash
dotnet add package ResponsibleAI.AgentHooks --prerelease
```

Check that `obj/project.assets.json` lists `ResponsibleAI.AgentHooks/0.1.0-beta.4`
or later. `0.1.0-beta.3` and earlier are the retired 0.1 SDK, a different API
under the same package ID.

Preview builds from pull requests ship as `.nupkg` files on
[GitHub releases](https://github.com/responsibleai/agent-hooks/releases). To use
one, save it in a folder, add the folder as a NuGet source, and add the package
with its exact `--version`. Keep nuget.org as a source too, because the package
depends on `JsonSchema.Net`.

The contracts are in `AgentHooks.Contracts.Draft`. Alias the namespace as the
samples do, `using Draft = AgentHooks.Contracts.Draft;`, because it has its own
`JsonObject`, which clashes with `System.Text.Json.Nodes.JsonObject`.

## Emitting

```csharp
using System.Text.Json;
using AgentHooks;
using Draft = AgentHooks.Contracts.Draft;

var emitter = HookEmitter.CreateBuilder()
    .OnPreToolCall((call, _) => Task.FromResult(
        call.ToolCall.Name == "send_email"
            ? Draft.PreToolHookResponse.Deny("egress_blocked")
            : Draft.PreToolHookResponse.Allow()),
        new BindingOptions { Name = "egress-guard", Timeout = TimeSpan.FromSeconds(2) })
    .WithRecordSink(record => Console.WriteLine($"{record.InterceptionPoint}: {record.Verdict.Decision}"))
    .Build();

var result = await emitter.EmitAsync(new Draft.PreToolCallRequest
{
    Timestamp = DateTimeOffset.UtcNow.ToString("O"),
    Sequence = 0,
    Agent = new() { Id = "support-agent", Framework = "quickstart" },
    Session = new() { Id = "s-001" },
    ToolCall = new() { Id = "t-1", Name = "send_email", Args = new() { ["body"] = JsonSerializer.SerializeToElement("hi") } },
});
if (!result.Proceeds) Console.WriteLine($"denied: {result.Verdict["reason"]}");
```

- `EmitAsync<TRequest>` returns `Proceeds`, the effective `Request` (with any
  enforced whole-target transform applied — act on this, not the original), the
  wire `Verdict`, and the projected `InterceptionRecord`. `EmitAsync(JsonObject)`
  provides the same flow at the wire JSON level.
- `RecordHostFailure` emits a fail-closed `HostErrors.ContextInvalid` record
  (with `null` identities) to the sink when a host cannot construct a request.
- Emitters are immutable and thread-safe; sink exceptions are swallowed so
  audit delivery never disrupts enforcement.

### The request at each point

Every request needs `Timestamp` (ISO 8601), `Sequence` (increasing within a
session), `Agent` (`Id` and `Framework`) and `Session` (`Id`). Each point adds
its own payload:

| Point | Request | Payload | Response |
| --- | --- | --- | --- |
| `input` | `Draft.InputRequest` | `Input.Content` (`JsonElement`) and `Input.Role` | `Draft.InputHookResponse` |
| `pre_tool_call` | `Draft.PreToolCallRequest` | `ToolCall.Id`, `ToolCall.Name` and `ToolCall.Args` (`Draft.JsonObject` of `JsonElement` values) | `Draft.PreToolHookResponse` |
| `post_tool_call` | `Draft.PostToolCallRequest` | `ToolCall`, `ToolResult.Value` (`JsonElement`) and `ToolResult.IsError` | `Draft.PostToolHookResponse` |
| `output` | `Draft.OutputRequest` | `Output.Content` (`JsonElement`) | `Draft.OutputHookResponse` |

The other four points follow the same pattern.

### Reading the result

- `Proceeds`: whether the step may run.
- `Request`: the effective request. Run the step on it, not on your original.
- `Verdict`: wire JSON. Read `result.Verdict["decision"]`, `["reason"]` and
  `["message"]`.
- `Record.Verdicts`: one slot per interceptor that ran, each with the
  `BindingOptions.Name` it was bound with. Under the default profile a deny is
  the last slot.
- `Draft.InterceptionPoints.Get(point).WireName` gives a point's wire name, such
  as `pre_tool_call`, for logs.

## Authoring hooks

Prefer inline typed delegates (`OnAgentStartup` … `OnAgentShutdown`) for simple
policies. Each generated response type has static factories:

| Point | Factories |
| --- | --- |
| Agent startup | `Draft.AgentStartupHookResponse.Allow()`, `.Deny(reason, message?)` |
| Input | `Draft.InputHookResponse.Allow()`, `.Deny(reason, message?)`, `.TransformInput(input)` |
| Pre-model call | `Draft.PreModelHookResponse.Allow()`, `.Deny(reason, message?)`, `.TransformMessages(messages)` |
| Post-model call | `Draft.PostModelHookResponse.Allow()`, `.Deny(reason, message?)`, `.TransformResponse(response)` |
| Pre-tool call | `Draft.PreToolHookResponse.Allow()`, `.Deny(reason, message?)`, `.TransformArgs(args)` |
| Post-tool call | `Draft.PostToolHookResponse.Allow()`, `.Deny(reason, message?)`, `.TransformValue(value)` |
| Output | `Draft.OutputHookResponse.Allow()`, `.Deny(reason, message?)`, `.TransformOutput(output)` |
| Agent shutdown | `Draft.AgentShutdownHookResponse.Allow()`, `.Deny(reason, message?)` |

Transforms replace the **whole target member**, not individual keys or paths.
`TransformValue` clones its `JsonElement` (including JSON `null`), so a source
`JsonDocument` may be disposed. Use generated verdict initializers
(`Draft.AllowVerdict`, `Draft.DenyVerdict`) when attaching `Warnings`,
`Evidence`, `Approval`, or `ResultLabels`.

```csharp
var emitter = HookEmitter.CreateBuilder()
    .OnPreToolCall((request, ct) => Task.FromResult(
        Draft.PreToolHookResponse.TransformArgs(new Draft.JsonObject
        {
            ["query"] = JsonSerializer.SerializeToElement("redacted"),
        })))
    .OnPostToolCall((request, ct) => Task.FromResult(
        Draft.PostToolHookResponse.TransformValue(JsonSerializer.SerializeToElement("redacted"))))
    .Build();
```

For reusable classes, implement only the per-point interfaces you need
(`Draft.IAgentStartupHook` through `Draft.IAgentShutdownHook`, or
`Draft.IInterceptor` for all eight). `AddHook` binds every implemented
interface in specification order with the same `BindingOptions`:

```csharp
var emitter = HookEmitter.CreateBuilder()
    .AddHook(new EgressGuard(), new BindingOptions { Name = "egress-guard" })
    .Build();

sealed class EgressGuard : Draft.IPreToolCallHook, Draft.IPostToolCallHook
{
    public Task<Draft.PreToolHookResponse> OnPreToolCallAsync(
        Draft.PreToolCallRequest request, CancellationToken ct) =>
        Task.FromResult(request.ToolCall.Name == "send_email"
            ? Draft.PreToolHookResponse.Deny("egress_blocked")
            : Draft.PreToolHookResponse.Allow());

    public Task<Draft.PostToolHookResponse> OnPostToolCallAsync(
        Draft.PostToolCallRequest request, CancellationToken ct) =>
        Task.FromResult(Draft.PostToolHookResponse.Allow());
}
```

For untyped or multi-point interceptors, implement `IHookInterceptor` (or pass
a delegate to `Use`): it receives a `HookCall` (point, isolated `JsonObject`
copy, timeout) and returns a `HookOutcome` (a wire response `JsonObject`,
`HookOutcome.Timeout`, `HookOutcome.Cancellation`, or `HookOutcome.Failed`).
Hook classes can be unit-tested directly with constructible generated requests
without special test factories.

## Composition, approval, identity, and failure posture

With no `WithComposition` call, interceptors run in registration order and the
first deny wins (`SequentialFirstDeny`). Exceptions and timeouts deny.

- **Composition & mode:** `WithComposition` configures all four profiles
  (`SequentialFirstDeny`, `SequentialRunAll`, `ParallelStrictest`,
  `ParallelUnanimous`) and their knobs (`onApproval`, `onTransformConflict`,
  `onDisagreement`). `WithMode(Draft.Mode.EvaluateOnly)` evaluates and records
  verdicts without blocking or applying transforms.
- **Timeouts & failure posture:** The emitter enforces a 5000 ms default
  timeout (`WithTimeouts`, `BindingOptions.Timeout`). Failures map to reserved
  `HostErrors.*` reasons; `OnError = Draft.OnError.Continue` (via
  `WithDefaultOnError` or `BindingOptions.OnError`) substitutes an allow with
  `HostErrors.ControlFailedWarning` only when `OnControlFailure` is registered
  and succeeds (caller cancellation is never continuable). `WithToolSeamPosture`
  sets `Draft.ToolSeamHostError.Continue` or `Terminate`.
- **Approval & identity:** `WithApprovalResolver` (typed delegate or wire
  `IApprovalResolver`) and `WithApprovalRedactor` handle liftable denies under
  the echo rule. `WithIdentityProvider` selects `IdentityProvider.JcsSha256`
  (default, backed by `Jcs`), a custom provider, or `null` (identity-unbound).

## Host declarations

```csharp
var registry = new HostRegistry()
    .AddKind("example.document_policy", binding => new DocumentPolicy(binding.Config))
    .AddApprovalResolver("operator", new OperatorResolver())
    .WithRecordSink(audit.Write);

var emitter = HookEmitter.FromDeclarationFile("agent-hooks.json", registry);
```

`HookEmitter.FromDeclaration` also accepts JSON text or a generated
`Draft.HostDeclaration`, and `HostRegistry` also accepts a custom `HostSurface`,
`AddIdentityProvider`, `AddApprovalRedactor`, and `OnControlFailure`. A refused
document throws `DeclarationException` with `Code` (`declaration_error:<class>`)
and RFC 6901 JSON-pointer `Findings`.

## Development

```bash
dotnet build sdk/csharp
dotnet test sdk/csharp                              # everything
dotnet test sdk/csharp --filter Category=draft      # CTK vectors + contract examples
```

`src/AgentHooks.Contracts/Generated/` and the embedded JSON Schemas are produced
by `pnpm generate` from `spec/draft` (emitter in `emitters/csharp/`); never edit
them by hand. CI checks drift with `git diff --exit-code` after generating.
