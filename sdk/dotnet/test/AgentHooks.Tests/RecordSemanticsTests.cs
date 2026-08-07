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

public class HostFailureTests
{
    private sealed class Allow : IInterceptor
    {
        public ValueTask<Verdict> InterceptAsync(AgentContext ctx, CancellationToken ct = default)
            => ValueTask.FromResult(Verdict.Allow);
    }

    [Fact]
    public void RecordHostFailureSynthesizesRejectionShape()
    {
        // §10.3 host projection failure: the host could not construct a
        // context at all; the synthesized record is the rejection shape
        // with the host's envelope facts.
        var em = new InterceptionEmitter();
        em.Register(new Allow());
        var r = em.RecordHostFailure(
            InterceptionPoint.PreToolCall,
            detail: "InvalidOperationException",
            sessionId: "s",
            sequence: 7,
            timestamp: "2026-01-01T00:00:00Z");
        Assert.False(r.Proceeds);
        Assert.Equal(InterceptionPoint.PreToolCall, r.InterceptionPoint);
        Assert.Equal("host_error:context_invalid", r.Verdict.Reason);
        Assert.Equal("InvalidOperationException", r.Verdict.Message);
        // §10.3 rejection shape: null identities under the declared
        // provider, nothing dispatched.
        Assert.Equal("jcs-sha256", r.IdentityProvider);
        Assert.Null(r.InputIdentity);
        Assert.Null(r.EnforcedIdentity);
        Assert.Null(r.DecidedBy);
        Assert.Empty(r.Verdicts);
        Assert.Equal(1, r.InterceptorsRegistered);
        // Envelope facts the host supplied.
        Assert.Equal("s", r.SessionId);
        Assert.Equal(7, r.Sequence);
        Assert.Equal("2026-01-01T00:00:00Z", r.Timestamp);
        // The record entered the emitter's stream like any emission.
        Assert.Single(em.Records);
    }

    [Fact]
    public void RecordHostFailureDefaultsAreTheUnknownValues()
    {
        var em = new InterceptionEmitter();
        var r = em.RecordHostFailure(InterceptionPoint.Output);
        Assert.Equal("", r.SessionId);
        Assert.Equal(-1, r.Sequence);
        Assert.Null(r.Timestamp);
        Assert.Null(r.Verdict.Message);
        Assert.Equal(0, r.InterceptorsRegistered);
    }

    [Fact]
    public void RecordHostFailureRecordsInEvaluateOnlyAndHitsSink()
    {
        // §8: synthesis still records in evaluate_only — records are the
        // point — and the mode member keeps the record from implying a
        // block happened.
        var em = new InterceptionEmitter(EnforcementMode.EvaluateOnly);
        var seen = new List<InterceptionRecord>();
        em.SetRecordSink(seen.Add);
        var r = em.RecordHostFailure(InterceptionPoint.PreToolCall, detail: "TypeError");
        Assert.Equal(EnforcementMode.EvaluateOnly, r.Mode);
        Assert.Equal("host_error:context_invalid", r.Verdict.Reason);
        Assert.Equal([r], seen);
    }

    [Fact]
    public void RecordHostFailureDetailTruncatedByProjection()
    {
        // §10.3: the synthesized verdict crosses the same payload-free
        // projection as every combined verdict.
        var em = new InterceptionEmitter();
        var r = em.RecordHostFailure(
            InterceptionPoint.PreToolCall, detail: new string('x', 300));
        Assert.NotNull(r.Verdict.Message);
        Assert.EndsWith("…", r.Verdict.Message);
        Assert.True(System.Text.Encoding.UTF8.GetByteCount(r.Verdict.Message!) <= 256 + 3);
    }
}
