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

| Package | Contents |
| --- | --- |
| `ResponsibleAI.AgentHooks.Contracts` | Types generated from `spec/draft` TypeSpec: per-point requests, responses and transforms, verdicts, approval requests/resolutions, `InterceptionRecord`, `HostDeclaration`, and the `IInterceptor`/`IApprovalResolver` hook interfaces. Usable on its own. |
| `ResponsibleAI.AgentHooks` | The runtime: `HookEmitter`, its builder, declarations, and RFC 8785 identity (`Jcs`). |
| `AgentHooks.Conformance` | The draft CTK runner and reference harness (not packaged). |

## Emitting

```csharp
using System.Text.Json;
using AgentHooks;
using Draft = AgentHooks.Contracts.Draft;

var emitter = HookEmitter.CreateBuilder()
    .OnPreToolCall((call, _) => Task.FromResult(new Draft.PreToolHookResponse
    {
        Verdict = call.ToolCall.Name == "send_email"
            ? new Draft.DenyVerdict { Reason = "egress_blocked" }
            : new Draft.AllowVerdict(),
    }), new BindingOptions { Name = "egress-guard", Timeout = TimeSpan.FromSeconds(2) })
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
  request and response types. For untyped or multi-point interceptors implement
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
