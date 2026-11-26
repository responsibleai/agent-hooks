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
    .OnPreToolCall((call, _) => Task.FromResult(new Draft.PreToolHookResponse
    {
        Verdict = call.ToolCall.Name == "send_email"
            ? new Draft.DenyVerdict { Reason = "egress_blocked" }
            : new Draft.AllowVerdict(),
    }), new BindingOptions { Name = "egress-guard" })
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
