# .NET quickstart

```sh
dotnet add package ResponsibleAI.AgentHooks --prerelease
```

The NuGet package currently ships managed code only; the native core
library (`libagent_hooks_ffi`) is loaded at run time and must be built
once from the repository:

```sh
git clone https://github.com/responsibleai/agent-hooks
cargo build --release -p agent-hooks-ffi --manifest-path agent-hooks/sdk/rust/Cargo.toml
export LD_LIBRARY_PATH=$PWD/agent-hooks/sdk/rust/target/release   # PATH on Windows
```

Runtime-identifier packaging of the native library is planned; until
then this is the one extra step.

A minimal host with one control interceptor:

```csharp
using System.Text.Json.Nodes;
using AgentHooks;

var emitter = new InterceptionEmitter();
emitter.Register(new EgressGuard(), name: "egress-guard");

var build = new AgentContextBuilder("support-agent", "quickstart", "s-001");

var ok = await emitter.EmitAsync(
    build.PreToolCall("t-1", "web_search", new JsonObject { ["q"] = "docs" }));
Console.WriteLine($"allowed: {ok.Record.Verdict.Decision}");

try
{
    await emitter.EmitAsync(build.PreToolCall(
        "t-2", "send_email", new JsonObject { ["body"] = "account_balance: 991" }));
}
catch (InterceptionBlockedException blocked)
{
    Console.WriteLine($"denied: {blocked.Result.Verdict.Reason}");
}

sealed class EgressGuard : IInterceptor
{
    private static readonly string[] Confidential = ["account_balance", "ssn"];

    public ValueTask<Verdict> InterceptAsync(AgentContext context, CancellationToken ct = default)
    {
        if (context.InterceptionPoint != InterceptionPoint.PreToolCall)
            return ValueTask.FromResult(Verdict.Allow);
        var args = context.Json["tool_call"]?["args"]?.ToJsonString() ?? "";
        foreach (var marker in Confidential)
            if (args.Contains(marker))
                return ValueTask.FromResult(new Verdict(Decision.Deny, Reason: "egress_blocked"));
        return ValueTask.FromResult(Verdict.Allow);
    }
}
```

Output:

```text
allowed: Allow
denied: egress_blocked
```

Things to notice:

- `Verdict.Allow` is a static readonly instance, not a method; denies
  are constructed with the record syntax
  `new Verdict(Decision.Deny, Reason: ...)`, and `Verdict.Warn(...)` /
  `Verdict.Escalate(...)` sugar exists.
- `EmitAsync` throws `InterceptionBlockedException` (record on
  `.Result`) on any block; on success it returns an `EmitOutcome` whose
  `Target` is the effective value your action must consume.
- The emitter enforces the recommended 5000 ms timeout on interceptors
  and resolvers, mapping breaches to the reserved fail-closed reasons.
