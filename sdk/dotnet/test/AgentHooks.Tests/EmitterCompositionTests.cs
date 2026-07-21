// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Emitter composition-profile and identity-provider tests (§7, §9, §10).
// Mirrors the Rust emitter tests (sdk/rust/core/src/emitter.rs) so the
// .NET dispatch loop, the ah_compose_aggregate delegation, and the
// approval seam agree with the reference implementation.

using System.Text.Json.Nodes;
using AgentHooks;
using Xunit;

namespace AgentHooks.Tests;

public sealed class EmitterCompositionTests
{
    private sealed class Scripted(Verdict verdict) : IInterceptor
    {
        public ValueTask<Verdict> InterceptAsync(
            AgentContext ctx, CancellationToken ct = default) =>
            ValueTask.FromResult(verdict);
    }

    private sealed class Approver(ApprovalOutcome outcome, Verdict verdict) : IApprovalResolver
    {
        public int Calls;

        public ValueTask<ApprovalResolution> ResolveAsync(
            ApprovalRequest req, CancellationToken ct = default)
        {
            Calls++;
            return ValueTask.FromResult(
                new ApprovalResolution(outcome, req.ContextIdentity, verdict)); // echo rule
        }
    }

    private sealed class BadEcho : IApprovalResolver
    {
        public ValueTask<ApprovalResolution> ResolveAsync(
            ApprovalRequest req, CancellationToken ct = default) =>
            ValueTask.FromResult(new ApprovalResolution(
                ApprovalOutcome.Approve, "sha256:forged", Verdict.Allow));
    }

    private static AgentContext Ctx() => new((JsonObject)JsonNode.Parse("""
        {
          "spec": "agent-hooks/0.1",
          "interception_point": "pre_tool_call",
          "timestamp": "t", "sequence": 0,
          "agent": {"id": "a", "framework": "x"}, "session": {"id": "s"},
          "target": {"url": "evil"},
          "tool_call": {"id": "tc", "name": "t", "args": {"url": "evil"}}
        }
        """)!);

    private static Verdict TransformV(string path, JsonNode? value) =>
        new(Decision.Transform, Transform: new Transform(path, value));

    private static Verdict Deny() => new(Decision.Deny);

    // ---- sequential/run_all --------------------------------------------------

    [Fact]
    public async Task RunAllRunsEverythingAndStrictestWins()
    {
        var e = new InterceptionEmitter();
        e.SetComposition(CompositionConfig.RunAll());
        e.Register(new Scripted(Deny()));
        e.Register(new Scripted(Verdict.Warn("late")));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(Decision.Deny, r.Verdict.Decision);
        Assert.Equal(2, r.Verdicts.Count); // run_all: everything runs
        Assert.Equal(0, r.DecidedBy);
        // §7.3: warnings union onto the deny combination.
        Assert.Single(r.Verdict.Warnings!);
        Assert.Null(r.FoldTruncated); // not defined outside first_deny
    }

    [Fact]
    public async Task RunAllConsultsAtMostOnceWhenAllDeniesLiftable()
    {
        var approver = new Approver(ApprovalOutcome.Approve, Verdict.Allow);
        var e = new InterceptionEmitter(resolver: approver);
        e.SetComposition(CompositionConfig.RunAll());
        e.Register(new Scripted(Verdict.Escalate("first")));
        e.Register(new Scripted(Verdict.Escalate("second")));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(1, approver.Calls); // §7.4: the seam is consulted at most once
        Assert.Equal(Decision.Allow, r.Verdict.Decision);
        Assert.Equal("approval", r.ResolvedBy);
        Assert.Equal(0, r.DecidedBy); // block tie resolves to the lowest index
    }

    [Fact]
    public async Task RunAllPlainDenyMakesLiftingPointless()
    {
        var approver = new Approver(ApprovalOutcome.Approve, Verdict.Allow);
        var e = new InterceptionEmitter(resolver: approver);
        e.SetComposition(CompositionConfig.RunAll());
        e.Register(new Scripted(Verdict.Escalate("check")));
        e.Register(new Scripted(Deny()));
        var r = await e.EmitUncheckedAsync(Ctx());
        // §7.4 precondition: a single plain deny blocks the consult.
        Assert.Equal(0, approver.Calls);
        Assert.Equal(Decision.Deny, r.Verdict.Decision);
        Assert.False(r.Verdict.IsLiftable);
        Assert.Equal(1, r.DecidedBy); // plain deny dominates liftable
        Assert.Null(r.ResolvedBy);
    }

    // ---- parallel profiles ---------------------------------------------------

    [Fact]
    public async Task ParallelStrictestTransformConflictFailsClosed()
    {
        var e = new InterceptionEmitter();
        e.SetComposition(CompositionConfig.Strictest(SynthesisPolicy.Deny));
        e.Register(new Scripted(TransformV("$target.url", "a")));
        e.Register(new Scripted(TransformV("$target.url", "b")));
        var c = Ctx();
        var r = await e.EmitUncheckedAsync(c);
        Assert.Equal(HostError.TransformConflict, r.Verdict.Reason);
        // Snapshot isolation: neither transform applied.
        Assert.Equal("evil", (string)c.Json["target"]!["url"]!);
        Assert.Null(r.DecidedBy);
    }

    [Fact]
    public async Task ParallelStrictestTransformConflictApprovalConsultsSeam()
    {
        var approver = new Approver(ApprovalOutcome.Approve, Verdict.Allow);
        var e = new InterceptionEmitter(resolver: approver);
        e.SetComposition(CompositionConfig.Strictest(SynthesisPolicy.Approval));
        e.Register(new Scripted(TransformV("$target.url", "a")));
        e.Register(new Scripted(TransformV("$target.url", "b")));
        var r = await e.EmitUncheckedAsync(Ctx());
        // §7.5 "approval": the synthesized deny is liftable; the seam
        // lifted it.
        Assert.Equal(1, approver.Calls);
        Assert.Equal(Decision.Allow, r.Verdict.Decision);
        Assert.Equal("approval", r.ResolvedBy);
        Assert.Null(r.DecidedBy); // synthesized, not an interceptor's win
    }

    [Fact]
    public async Task ParallelStrictestSingleTransformApplies()
    {
        var e = new InterceptionEmitter();
        e.SetComposition(CompositionConfig.Strictest(SynthesisPolicy.Deny));
        e.Register(new Scripted(Verdict.Allow));
        e.Register(new Scripted(TransformV("$target.url", "safe")));
        var c = Ctx();
        var r = await e.EmitUncheckedAsync(c);
        Assert.Equal(Decision.Transform, r.Verdict.Decision);
        Assert.Equal(1, r.DecidedBy);
        Assert.Equal("safe", (string)c.Json["target"]!["url"]!);
        Assert.NotEqual(r.InputIdentity, r.EnforcedIdentity);
    }

    [Fact]
    public async Task UnanimousDisagreementSynthesizes()
    {
        var e = new InterceptionEmitter();
        e.SetComposition(CompositionConfig.Unanimous(SynthesisPolicy.Deny, SynthesisPolicy.Deny));
        e.Register(new Scripted(Verdict.Allow));
        e.Register(new Scripted(TransformV("$target.url", "x")));
        var c = Ctx();
        var r = await e.EmitUncheckedAsync(c);
        Assert.Equal(HostError.CompositionDisagreement, r.Verdict.Reason);
        Assert.Equal("evil", (string)c.Json["target"]!["url"]!); // transform not applied
        Assert.Null(r.DecidedBy);
    }

    [Fact]
    public async Task UnanimousDisagreementApprovalConsultsSeam()
    {
        var approver = new Approver(ApprovalOutcome.Approve, Verdict.Allow);
        var e = new InterceptionEmitter(resolver: approver);
        e.SetComposition(
            CompositionConfig.Unanimous(SynthesisPolicy.Approval, SynthesisPolicy.Deny));
        e.Register(new Scripted(Verdict.Allow));
        e.Register(new Scripted(Deny()));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(1, approver.Calls);
        Assert.Equal(Decision.Allow, r.Verdict.Decision);
        Assert.Equal("approval", r.ResolvedBy);
    }

    // ---- sequential/first_deny + approval seam --------------------------------

    [Fact]
    public async Task FirstDenyNoResolverDenyStandsWithoutError()
    {
        var e = new InterceptionEmitter();
        e.Register(new Scripted(Verdict.Escalate("check")));
        var r = await e.EmitUncheckedAsync(Ctx());
        // §9: no resolver → the liftable deny stands, NOT an error.
        Assert.Equal(Decision.Deny, r.Verdict.Decision);
        Assert.Equal("check", r.Verdict.Reason);
        Assert.True(r.Verdict.IsLiftable);
        Assert.Null(r.ResolvedBy);
    }

    [Fact]
    public async Task FirstDenyStopTruncatesAndRecordsSubstitution()
    {
        var e = new InterceptionEmitter(
            resolver: new Approver(ApprovalOutcome.Approve, Verdict.Allow));
        e.SetComposition(CompositionConfig.FirstDeny(OnApproval.Stop));
        e.Register(new Scripted(Verdict.Escalate()));
        e.Register(new Scripted(Deny())); // must be skipped
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(Decision.Allow, r.Verdict.Decision);
        Assert.Equal(true, r.FoldTruncated);
        Assert.Equal("approval", r.ResolvedBy);
        Assert.Equal(0, r.DecidedBy);
    }

    [Fact]
    public async Task FirstDenyResumeContinuesTheFold()
    {
        var e = new InterceptionEmitter(
            resolver: new Approver(ApprovalOutcome.Approve, Verdict.Allow));
        e.SetComposition(CompositionConfig.FirstDeny(OnApproval.Resume));
        e.Register(new Scripted(Verdict.Escalate()));
        e.Register(new Scripted(Deny())); // now runs — and denies
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(Decision.Deny, r.Verdict.Decision);
        Assert.Equal(1, r.DecidedBy);
        Assert.Equal("approval", r.ResolvedBy);
        Assert.Equal(false, r.FoldTruncated);
    }

    [Fact]
    public async Task EchoRuleViolationFailsClosed()
    {
        var e = new InterceptionEmitter(resolver: new BadEcho());
        e.Register(new Scripted(Verdict.Escalate()));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(HostError.ApprovalIdentityMismatch, r.Verdict.Reason);
    }

    [Fact]
    public async Task ApproveWithDenyAndRejectWithPermitAreVerdictInvalid()
    {
        // §9: approve MUST carry a permit, reject MUST carry a deny.
        var e = new InterceptionEmitter(
            resolver: new Approver(ApprovalOutcome.Approve, Deny()));
        e.Register(new Scripted(Verdict.Escalate()));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(HostError.VerdictInvalid, r.Verdict.Reason);

        e = new InterceptionEmitter(
            resolver: new Approver(ApprovalOutcome.Reject, Verdict.Allow));
        e.Register(new Scripted(Verdict.Escalate()));
        r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(HostError.VerdictInvalid, r.Verdict.Reason);
    }

    [Fact]
    public async Task ShutdownNeverConsults()
    {
        var approver = new Approver(ApprovalOutcome.Approve, Verdict.Allow);
        var e = new InterceptionEmitter(resolver: approver);
        e.Register(new Scripted(Verdict.Escalate()));
        var c = Ctx();
        c.Json["interception_point"] = "agent_shutdown";
        c.Json["summary"] = new JsonObject { ["reason"] = "completed" };
        var r = await e.EmitUncheckedAsync(c);
        // §6.1a: the liftable deny is recorded, the seam untouched.
        Assert.Equal(0, approver.Calls);
        Assert.True(r.Verdict.IsLiftable);
        Assert.Null(r.ResolvedBy);
    }

    [Fact]
    public async Task EvaluateOnlyNeverConsults()
    {
        var approver = new Approver(ApprovalOutcome.Approve, Verdict.Allow);
        var e = new InterceptionEmitter(EnforcementMode.EvaluateOnly, approver);
        e.Register(new Scripted(Verdict.Escalate()));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(0, approver.Calls);
        Assert.True(r.Verdict.IsLiftable);
        Assert.True(r.Proceeds); // §8: evaluate_only always proceeds
    }

    // ---- identity provider seam (§10.1) ---------------------------------------

    [Fact]
    public async Task NullProviderUnboundRecord()
    {
        var e = new InterceptionEmitter();
        e.SetIdentityProvider(IdentityProvider.Null);
        e.Register(new Scripted(Verdict.Allow));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.Null(r.InputIdentity);
        Assert.Null(r.EnforcedIdentity);
        Assert.Null(r.IdentityProvider);
    }

    [Fact]
    public async Task CustomProviderRecordsNameAndIdentities()
    {
        var e = new InterceptionEmitter();
        e.SetIdentityProvider(IdentityProvider.Custom(
            "test-hash", ctx => $"test:{(string)ctx["session"]!["id"]!}"));
        e.Register(new Scripted(Verdict.Allow));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal("test-hash", r.IdentityProvider);
        Assert.Equal("test:s", r.InputIdentity);
        Assert.Equal("test:s", r.EnforcedIdentity);
    }

    [Fact]
    public async Task DefaultProviderRejectsBigIntBeforeDispatch()
    {
        var e = new InterceptionEmitter();
        e.Register(new Scripted(Verdict.Allow));
        var c = Ctx();
        c.Json["target"] = new JsonObject { ["id"] = 9_007_199_254_740_993L };
        var r = await e.EmitUncheckedAsync(c);
        Assert.Equal(HostError.ContextInvalid, r.Verdict.Reason);
        Assert.Contains("string-encode", r.Verdict.Message);
        Assert.Empty(r.Verdicts); // no interceptor ran
        Assert.Null(r.InputIdentity);
    }

    // ---- §5.1 verdict sugar ----------------------------------------------------

    [Fact]
    public void WarnSugarIsAllowWithWarning()
    {
        var v = Verdict.Warn("pii");
        Assert.Equal(Decision.Allow, v.Decision);
        Assert.Single(v.Warnings!);
        v.Validate();
    }

    [Fact]
    public void DenySugarIsFinalDeny()
    {
        var v = Verdict.Deny("policy", "blocked");
        Assert.Equal(Decision.Deny, v.Decision);
        Assert.Equal("policy", v.Reason);
        Assert.Equal("blocked", v.Message);
        Assert.Null(v.Approval);
        Assert.False(v.IsLiftable);
        v.Validate();
    }

    [Fact]
    public void EscalateSugarIsLiftableDeny()
    {
        var v = Verdict.Escalate("check");
        Assert.Equal(Decision.Deny, v.Decision);
        Assert.True(v.IsLiftable);
        v.Validate();
        // §5.1: approval block permitted only on deny.
        Assert.Throws<ArgumentException>(
            () => (Verdict.Allow with { Approval = [] }).Validate());
        // §5.1: warn/escalate are not wire decisions anymore.
        Assert.Throws<ArgumentOutOfRangeException>(
            () => Verdict.FromWire(new JsonObject { ["decision"] = "escalate" }));
    }

    private sealed class Throwing : IInterceptor
    {
        public ValueTask<Verdict> InterceptAsync(AgentContext ctx, CancellationToken ct = default)
            => throw new InvalidOperationException("boom");
    }

    [Fact]
    public async Task FailureDenyAttributedToFailingInterceptor()
    {
        // §10.3 (D3): a §6.3 failure deny carries the FAILING
        // interceptor's index, in every profile.
        var e = new InterceptionEmitter();
        e.Register(new Scripted(Verdict.Allow));
        e.Register(new Throwing());
        e.Register(new Scripted(Verdict.Allow));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(HostError.InterceptorFailed, r.Verdict.Reason);
        Assert.Equal(1, r.DecidedBy);
        Assert.True(r.FoldTruncated);
    }

    [Fact]
    public async Task RecordCarriesPayloadFreeProjection()
    {
        // §10.3 (D2): transform.path kept, transform.value dropped.
        var e = new InterceptionEmitter();
        e.Register(new Scripted(TransformV("$target.url", "safe")));
        var c = Ctx();
        var r = await e.EmitUncheckedAsync(c);
        Assert.Equal(Decision.Transform, r.Verdict.Decision);
        Assert.Equal("$target.url", r.Verdict.Transform!.Path);
        Assert.Null(r.Verdict.Transform.Value);
        Assert.Equal("safe", (string)c.Json["target"]!["url"]!);
    }

    [Fact]
    public async Task OversizedEvidenceFailsVerdictGate()
    {
        // §5.3 (D5): evidence beyond 10240 canonical bytes -> verdict_invalid.
        var big = Verdict.Allow with
        {
            Evidence = new Evidence(Artefact: new string('x', 10300)),
        };
        var e = new InterceptionEmitter();
        e.Register(new Scripted(big));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(Decision.Deny, r.Verdict.Decision);
        Assert.Equal(HostError.VerdictInvalid, r.Verdict.Reason);
    }
}
