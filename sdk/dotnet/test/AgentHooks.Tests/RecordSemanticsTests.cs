// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Record-semantics tests (§4, §10.1, §10.3).

using System.Text.Json.Nodes;
using AgentHooks;
using Xunit;

public class RecordSemanticsTests
{
    private static AgentContext Ctx() => new((JsonObject)JsonNode.Parse("""
        {
          "spec": "agent-hooks/0.1",
          "interception_point": "pre_tool_call",
          "timestamp": "2026-01-01T00:00:00Z",
          "sequence": 0,
          "agent": {"id": "a", "framework": "test"},
          "session": {"id": "s"},
          "target": {"q": "x"},
          "tool_call": {"id": "tc-1", "name": "t", "args": {"q": "x"}}
        }
        """)!);

    private sealed class Allow : IInterceptor
    {
        public bool Ran;
        public ValueTask<Verdict> InterceptAsync(AgentContext ctx, CancellationToken ct = default)
        {
            Ran = true;
            return ValueTask.FromResult(Verdict.Allow);
        }
    }

    [Fact]
    public async Task EnvelopeMissingConditionalFailsClosedPreDispatch()
    {
        var em = new InterceptionEmitter();
        var i = new Allow();
        em.Register(i);
        var ctx = Ctx();
        ctx.Json.Remove("tool_call");
        var r = await em.EmitUncheckedAsync(ctx);
        Assert.False(r.Proceeds);
        Assert.Equal("host_error:context_invalid", r.Verdict.Reason);
        Assert.False(i.Ran);
        Assert.Null(r.InputIdentity);
        Assert.Equal(1, r.InterceptorsRegistered);
    }

    [Fact]
    public void ProviderNameRulesEnforced()
    {
        Assert.Throws<ArgumentException>(() => IdentityProvider.Custom("jcs-fake", _ => "x"));
        Assert.Throws<ArgumentException>(() => IdentityProvider.Custom("Bad Name", _ => "x"));
        _ = IdentityProvider.Custom("myco-hash", _ => "x");
    }

    [Fact]
    public async Task CustomProviderFailureFailsClosedTypeNameOnly()
    {
        var em = new InterceptionEmitter();
        em.SetIdentityProvider(IdentityProvider.Custom(
            "myco-hash", _ => throw new InvalidOperationException("SECRET-PAYLOAD")));
        em.Register(new Allow());
        var r = await em.EmitUncheckedAsync(Ctx());
        Assert.False(r.Proceeds);
        Assert.Equal("host_error:context_invalid", r.Verdict.Reason);
        Assert.DoesNotContain("SECRET-PAYLOAD", r.Verdict.Message ?? "");
        Assert.Equal("myco-hash", r.IdentityProvider);
    }

    [Fact]
    public async Task NamesAndCountOnRecord()
    {
        var em = new InterceptionEmitter();
        em.SetComposition(CompositionConfig.RunAll());
        em.Register(new Allow(), "pii-scan").Register(new Allow());
        var r = await em.EmitUncheckedAsync(Ctx());
        Assert.True(r.Proceeds);
        Assert.Equal(2, r.InterceptorsRegistered);
        Assert.Equal("pii-scan", r.Verdicts[0].Name);
        Assert.Null(r.Verdicts[1].Name);
    }
}
