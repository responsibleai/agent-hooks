# agent-hooks (.NET SDK)

A managed .NET 8 host SDK for the
[agent-hooks draft specification](https://github.com/responsibleai/agent-hooks/blob/main/spec/draft/AGENT-HOOKS-DRAFT.md):
typed interception points, all four composition profiles, failure posture,
approval, context identity, payload-free audit records, host declarations and
the conformance (CTK) runner. No native libraries or platform-specific assets.

> **Trust model.** agent-hooks is a *cooperative contract*, not a security
> boundary: the host framework is fully trusted and interceptors run in-process
> with full data access. Read
> [SECURITY.md](https://github.com/responsibleai/agent-hooks/blob/main/SECURITY.md)
> before relying on it.

The SDK ships as one NuGet package, `ResponsibleAI.AgentHooks`, which carries
two assemblies:

| Assembly | Contents |
| --- | --- |
| `AgentHooks.Contracts` | Types generated from `spec/draft` TypeSpec: per-point requests, responses (with `Allow`/`Deny`/`Transform*` factories) and transforms, verdicts, approval requests/resolutions, `InterceptionRecord`, `HostDeclaration`, the per-point hook interfaces (`IPreToolCallHook`, …) composed by `IInterceptor`, and `IApprovalResolver`. |
| `AgentHooks` | The runtime: `HookEmitter`, its builder, declarations, and RFC 8785 identity (`Jcs`). |

`AgentHooks.Conformance`, the draft CTK runner and reference harness, is not packaged.

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
  enforced transform applied — act on this, not the original), the wire
  `Verdict`, and the generated `InterceptionRecord`. `EmitAsync(JsonObject)`
  is the same at the wire level.
- Typed handlers (`OnAgentStartup` … `OnAgentShutdown`) take a
  `(request, cancellationToken) => Task<response>` lambda over the generated
  request and response types; `BindingOptions` sets the recorded name,
  timeout and error posture. For untyped or multi-point interceptors implement
  `IHookInterceptor` (or pass a delegate to `Use`): it receives a `HookCall`
  (point, isolated request copy, effective timeout) and returns a
  `HookOutcome` — a response body, `TimedOut`, `Cancelled` or `Failed`.
- The emitter always enforces timeouts (default 5000 ms; the approval resolver
  defaults to the interceptor timeout). Failures map to the reserved
  `host_error:*` reasons; `BindingOptions.OnError = Continue` substitutes an
  allow with a `host_warning:control_failed` warning, reported to the
  `OnControlFailure` notifier (without a notifier the deny stands).
- `WithComposition`, `WithMode`, `WithIdentityProvider`,
  `WithApprovalResolver`/`WithApprovalRedactor`, `WithTimeouts` and
  `WithToolSeamPosture` configure the remaining draft knobs. Emitters are
  immutable and thread-safe.

## Authoring hooks

Prefer the delegates above for inline policies. Each generated response type
has static factories, generated from the spec's verdict unions and transform
targets, so no verdict hierarchy or JSON request wrapper is needed:

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
Arguments are the generated target types (`Draft.Input`, `Draft.Message[]`,
`Draft.Response`, `Draft.JsonObject`, `JsonElement`, `Draft.Output`). Mutable
targets are retained by the response; do not mutate them while a handler is
returning it. `TransformValue` clones its `JsonElement`, including JSON null,
so a source `JsonDocument` may be disposed. Runtime schema and semantic gates
still apply. Use the generated initializers for advanced verdict metadata
(warnings, evidence, approval, or result labels).

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

For reusable classes, implement only the per-point interfaces you need.
`AddHook` binds **every implemented interface** in specification order, with
the same `BindingOptions` at each point; it throws for null or unsupported
objects. There are eight generated interfaces, from `Draft.IAgentStartupHook` to
`Draft.IAgentShutdownHook`; all methods return `Task<TResponse>`.

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

Hook implementations can be tested directly with constructible generated
requests, or mocked through these interfaces. No public `ForTest` factories
are required. `Draft.IInterceptor` composes all eight interfaces, so an
all-point interceptor can be passed to `AddHook` as well.

## Host declarations

```csharp
var registry = new HostRegistry()
    .AddKind("example.document_policy", binding => new DocumentPolicy(binding.Config))
    .AddApprovalResolver("operator", new OperatorResolver())
    .WithRecordSink(audit.Write);

var emitter = HookEmitter.FromDeclarationFile("agent-hooks.json", registry);
```

`FromDeclaration` also accepts JSON text or a generated `Draft.HostDeclaration`.
A refused document throws `DeclarationException` with `Code`
(`declaration_error:<class>`) and JSON-pointer `Findings`.

## Development

```bash
dotnet build sdk/csharp
dotnet test sdk/csharp                              # everything
dotnet test sdk/csharp --filter Category=draft      # CTK vectors + contract examples
```

`src/AgentHooks.Contracts/Generated/` and the embedded JSON Schemas are produced
by `pnpm generate` from `spec/draft` (emitter in `emitters/csharp/`); never edit
them by hand. CI checks drift with `git diff --exit-code` after generating.
