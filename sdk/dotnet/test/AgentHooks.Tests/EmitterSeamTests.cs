// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Emitter seam tests (NEXT-08/13/14/20), mirroring the Rust emitter's:
// approval redaction (§9), record sink + retention bound (§10.3), and
// the effective-target return from EmitAsync (§4.3).

using System.Text.Json.Nodes;
using AgentHooks;
using Xunit;

namespace AgentHooks.Tests;

public sealed class EmitterSeamTests
{
    private sealed class Scripted(Verdict verdict) : IInterceptor
    {
        public ValueTask<Verdict> InterceptAsync(
            AgentContext ctx, CancellationToken ct = default) =>
            ValueTask.FromResult(verdict);
    }

    private sealed class CapturingApprover : IApprovalResolver
    {
        public string? Identity;
        public string? Presented;

        public ValueTask<ApprovalResolution> ResolveAsync(
            ApprovalRequest req, CancellationToken ct = default)
        {
            Identity = req.ContextIdentity;
            Presented = req.Context.Json.ToJsonString();
            return ValueTask.FromResult(new ApprovalResolution(
                ApprovalOutcome.Approve, req.ContextIdentity, Verdict.Allow));
        }
    }

    private static AgentContext Ctx() => new((JsonObject)JsonNode.Parse("""
        {
          "spec": "agent-hooks/0.1",
          "interception_point": "pre_tool_call",
          "timestamp": "2026-01-01T00:00:00Z",
          "sequence": 0,
          "agent": {"id": "a", "framework": "x"},
          "session": {"id": "s"},
          "target": {"secret": "evil", "n": 1},
          "tool_call": {"id": "tc", "name": "t", "args": {"secret": "evil", "n": 1}}
        }
        """)!);

    [Fact]
    public async Task RedactorBindsIdentityToPresentedContext()
    {
        var approver = new CapturingApprover();
        var e = new InterceptionEmitter(EnforcementMode.Enforce, approver);
        e.Register(new Scripted(Verdict.Escalate("check")));
        e.SetApprovalRedactor(ctx =>
            new AgentContext(Canonical.ApplyTransformCtx(ctx, "$target.secret", "[redacted]")));

        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.True(r.Proceeds);
        Assert.Equal("approval", r.ResolvedBy);
        Assert.NotNull(approver.Presented);
        Assert.DoesNotContain("evil", approver.Presented);
        Assert.NotEqual(approver.Identity, r.InputIdentity);
    }

    [Fact]
    public async Task ThrowingRedactorFailsClosed()
    {
        var e = new InterceptionEmitter(EnforcementMode.Enforce, new CapturingApprover());
        e.Register(new Scripted(Verdict.Escalate("check")));
        e.SetApprovalRedactor(_ => throw new InvalidOperationException("SECRET must not leak"));

        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.False(r.Proceeds);
        Assert.Equal(HostError.ApprovalResolverFailed, r.Verdict.Reason);
        Assert.DoesNotContain("SECRET", r.Verdict.Message ?? "");
    }

    [Fact]
    public async Task RecordSinkAndRingBuffer()
    {
        var seen = 0;
        var e = new InterceptionEmitter(EnforcementMode.Enforce, null);
        e.Register(new Scripted(Verdict.Allow));
        e.SetRecordSink(_ => seen++);
        e.SetMaxRecords(2);
        for (var i = 0; i < 5; i++) await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(5, seen);
        Assert.Equal(2, e.Records.Count);
        Assert.Equal(3, e.RecordsDropped);
        Assert.Equal(2, e.TakeRecords().Count);
        Assert.Empty(e.Records);
    }

    [Fact]
    public async Task SinkExceptionIsSwallowed()
    {
        var e = new InterceptionEmitter(EnforcementMode.Enforce, null);
        e.Register(new Scripted(Verdict.Allow));
        e.SetRecordSink(_ => throw new InvalidOperationException("sink down"));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.True(r.Proceeds);
    }

    [Fact]
    public async Task EmitReturnsEffectiveTarget()
    {
        var e = new InterceptionEmitter(EnforcementMode.Enforce, null);
        e.Register(new Scripted(Verdict.FromWire((JsonObject)JsonNode.Parse("""
            {"decision": "transform",
             "transform": {"path": "$target.secret", "value": "clean"}}
            """)!)));
        var outcome = await e.EmitAsync(Ctx());
        Assert.Equal("clean", (string?)outcome.Target?["secret"]);
        Assert.True(outcome.Record.Proceeds);
    }
}
