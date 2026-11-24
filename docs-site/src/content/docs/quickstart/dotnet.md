---
title: .NET quickstart
---

```sh
dotnet add package ResponsibleAI.AgentHooks --prerelease
```

The package is fully managed (.NET 8) and targets the draft specification.
A minimal host with one control interceptor:

```csharp
using System.Text.Json;
using AgentHooks;
using Draft = AgentHooks.Contracts.Draft;

var emitter = HookEmitter.CreateBuilder()
    .OnPreToolCall("egress-guard", (call, _) => Task.FromResult(
        call.ToolCall.Name == "send_email"
            ? PreToolResponses.Deny("egress_blocked")
            : PreToolResponses.Allow()))
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

Output:

```text
PreToolCall: Deny
denied: egress_blocked
```

Things to notice:

- Handlers use the generated request/response types; `EmitAsync` never throws
  for a deny. Check `Proceeds` and act on `result.Request`, which carries any
  enforced transform.
- Every emission produces a payload-free `InterceptionRecord` for the sink.
- The emitter enforces a 5000 ms default timeout on interceptors and
  resolvers, mapping breaches to the reserved fail-closed reasons.

## Returning a transform

Response factories are available at all eight points. Transformable points
also expose whole-target helpers, for example:

```csharp
var emitter = HookEmitter.CreateBuilder()
    .OnPreToolCall("redact-query", (request, ct) => Task.FromResult(
        PreToolResponses.TransformArgs(new Draft.JsonObject
        {
            ["query"] = JsonSerializer.SerializeToElement("redacted"),
        })))
    .OnPostToolCall("redact-result", (request, ct) => Task.FromResult(
        PostToolResponses.TransformValue(JsonSerializer.SerializeToElement("redacted"))))
    .Build();
```

`TransformArgs` replaces the entire arguments object; `TransformValue`
replaces the entire result, including JSON null. Always consume the effective
`result.Request` after checking `Proceeds`.

Reusable policies can implement any of `IAgentStartupHook`, `IInputHook`,
`IPreModelCallHook`, `IPostModelCallHook`, `IPreToolCallHook`, `IPostToolCallHook`,
`IOutputHook`, and `IAgentShutdownHook`. Register an instance with
`builder.AddHook(hook, new BindingOptions { Name = "policy" })`; each implemented
point is bound automatically. These optional interfaces use `Task<TResponse>`
and the same constructible generated requests as delegates, so policies can
be tested or mocked without special request factories.
