// Copyright (c) Microsoft. All rights reserved.

// Failure posture tests (§6.3.1, §7 timeout ownership): on_error on the
// code registration API and in a 1.1 declaration, the substituted
// allow and its record member, the principal notification hook, the
// typed outcomes of a managed interceptor, and every case that must
// stay fail closed whatever on_error says. Mirrors the Rust emitter
// tests (sdk/rust/core/src/emitter.rs, "on_error").

using System.Reflection;
using System.Text.Json.Nodes;
using AgentHooks;
using Xunit;

namespace AgentHooks.Tests;

public sealed class FailurePostureTests
{
    private sealed class Scripted(Verdict verdict) : IInterceptor
    {
        public int Calls;

        public ValueTask<Verdict> InterceptAsync(AgentContext ctx, CancellationToken ct = default)
        {
            Calls++;
            return ValueTask.FromResult(verdict);
        }
    }

    private sealed class Throws : IInterceptor
    {
        public ValueTask<Verdict> InterceptAsync(AgentContext ctx, CancellationToken ct = default) =>
            throw new InvalidOperationException("SECRET-PAYLOAD must not leak");
    }

    /// <summary>Ignores the cancellation token on purpose: the §7 bound
    /// must hold against a callee that does not cooperate.</summary>
    private sealed class Slow(TimeSpan delay) : IInterceptor
    {
        public async ValueTask<Verdict> InterceptAsync(AgentContext ctx, CancellationToken ct = default)
        {
            await Task.Delay(delay, CancellationToken.None);
            return Verdict.Allow;
        }
    }

    /// <summary>Honours the host's token: a cancelled emission throws.</summary>
    private sealed class Cooperative : IInterceptor
    {
        public async ValueTask<Verdict> InterceptAsync(AgentContext ctx, CancellationToken ct = default)
        {
            await Task.Delay(TimeSpan.FromSeconds(30), ct);
            return Verdict.Allow;
        }
    }

    private sealed class Managed(ManagedInterceptorOutcome outcome) : IManagedInterceptor
    {
        public bool Cleaned;
        public TimeSpan? BoundSeen;
        public bool BoundReceived;

        public ValueTask<ManagedInterceptorOutcome> InterceptManagedAsync(
            AgentContext ctx, TimeSpan? bound, CancellationToken ct = default)
        {
            BoundSeen = bound;
            BoundReceived = true;
            // Cancel and clean up the external work, then report.
            Cleaned = true;
            return ValueTask.FromResult(outcome);
        }
    }

    private sealed class ThrowingManaged : IManagedInterceptor
    {
        public ValueTask<ManagedInterceptorOutcome> InterceptManagedAsync(
            AgentContext ctx, TimeSpan? bound, CancellationToken ct = default) =>
            throw new InvalidOperationException("SECRET");
    }

    private sealed class RaisingResolver : IApprovalResolver
    {
        public ValueTask<ApprovalResolution> ResolveAsync(ApprovalRequest req, CancellationToken ct = default) =>
            throw new InvalidOperationException("resolver down");
    }

    private static AgentContext Ctx(string point = "pre_tool_call", long sequence = 0)
    {
        var o = (JsonObject)JsonNode.Parse($$"""
            {
              "spec": "agent-hooks/0.1",
              "interception_point": "{{point}}",
              "timestamp": "2026-01-01T00:00:00Z",
              "sequence": {{sequence}},
              "agent": {"id": "a", "framework": "test"},
              "session": {"id": "s"},
              "target": {"url": "evil"}
            }
            """)!;
        if (point == "pre_tool_call")
            o["tool_call"] = new JsonObject
            {
                ["id"] = "tc",
                ["name"] = "t",
                ["args"] = new JsonObject { ["url"] = "evil" },
            };
        else if (point == "output")
            o["output"] = new JsonObject { ["content"] = "evil" };
        return new AgentContext(o);
    }

    private static RegistrationOptions BestEffort(string name) =>
        new(name, null, OnError.Continue);

    /// <summary>An emitter whose principal channel collects notices.</summary>
    private static (InterceptionEmitter Emitter, List<ControlFailureNotice> Notices) WithNotifier(
        EnforcementMode mode = EnforcementMode.Enforce, IApprovalResolver? resolver = null)
    {
        var notices = new List<ControlFailureNotice>();
        var e = new InterceptionEmitter(mode, resolver);
        e.SetControlFailureNotifier(notices.Add);
        return (e, notices);
    }

    private static void AssertSubstituted(InterceptionRecord r, int index, string binding, string reason)
    {
        var s = r.Verdicts[index];
        Assert.Equal(Decision.Allow, s.Decision);
        Assert.Null(s.Reason);
        Assert.Equal(binding, s.Name);
        Assert.Equal(reason, s.SubstitutedFor);
        var expected = new Warning(HostWarning.ControlFailed, $"{binding}: {reason}; host continued");
        Assert.Contains(expected, r.Verdict.Warnings ?? []);
        // The wire record carries the member under its §10.3 name.
        var wire = r.ToWire();
        Assert.Equal(reason, (string?)wire["verdicts"]![index]!["substituted_for"]);
        Assert.False(wire["verdicts"]![index]!.AsObject().ContainsKey("reason"));
    }

    // ---- continue: the three covered failures (item 9) --------------------

    [Fact]
    public async Task ContinueSubstitutesAllowForAThrow()
    {
        var (e, notices) = WithNotifier();
        e.RegisterWithOptions(new Throws(), BestEffort("defender"));
        var audit = new Scripted(Verdict.Allow);
        e.Register(audit, "audit");
        var c = Ctx();
        var r = await e.EmitUncheckedAsync(c);
        Assert.True(r.Proceeds);
        Assert.Equal(Decision.Allow, r.Verdict.Decision);
        Assert.Null(r.Verdict.Reason);
        Assert.Single(r.Verdict.Warnings!);
        Assert.Equal(2, r.Verdicts.Count); // the fold continued past the failure
        Assert.Equal(1, audit.Calls);
        AssertSubstituted(r, 0, "defender", HostError.InterceptorFailed);
        Assert.Null(r.Verdicts[1].SubstitutedFor);
        Assert.Null(r.DecidedBy); // a substituted allow decides nothing
        Assert.Equal(false, r.FoldTruncated);
        // Target unchanged.
        Assert.Equal("evil", (string?)c.Json["target"]!["url"]);
        // The principal was told, with the reason, before the action continued.
        var n = Assert.Single(notices);
        Assert.Equal("defender", n.Binding);
        Assert.Equal(0, n.Index);
        Assert.Equal(HostError.InterceptorFailed, n.Reason);
        Assert.Equal("defender: host_error:interceptor_failed; host continued", n.Message);
        Assert.Equal(InterceptionPoint.PreToolCall, n.InterceptionPoint);
        // Host-synthesized text carries nothing from the interceptor or the target.
        var all = r.Verdict.ToWire().ToJsonString() + n;
        Assert.DoesNotContain("SECRET", all);
        Assert.DoesNotContain("evil", all);
    }

    [Fact]
    public async Task ContinueSubstitutesAllowForAnInvalidVerdict()
    {
        var (e, notices) = WithNotifier();
        e.RegisterWithOptions(new Scripted(new Verdict(Decision.Transform)), BestEffort("defender"));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.True(r.Proceeds);
        AssertSubstituted(r, 0, "defender", HostError.VerdictInvalid);
        Assert.Equal(HostError.VerdictInvalid, Assert.Single(notices).Reason);
    }

    [Fact]
    public async Task ContinueSubstitutesAllowForATimeout()
    {
        var notices = new List<ControlFailureNotice>();
        var e = new InterceptionEmitter(timeout: TimeSpan.FromMilliseconds(20));
        e.SetControlFailureNotifier(notices.Add);
        e.RegisterWithOptions(new Slow(TimeSpan.FromSeconds(5)), BestEffort("defender"));
        e.Register(new Scripted(Verdict.Allow));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.True(r.Proceeds);
        Assert.Equal(2, r.Verdicts.Count);
        AssertSubstituted(r, 0, "defender", HostError.InterceptorTimeout);
        Assert.Equal(HostError.InterceptorTimeout, Assert.Single(notices).Reason);
    }

    [Fact]
    public async Task CooperativeInterceptorThatHonoursTheTimerIsATimeoutNotARaise()
    {
        var e = new InterceptionEmitter(timeout: TimeSpan.FromMilliseconds(20));
        e.Register(new Cooperative());
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(HostError.InterceptorTimeout, r.Verdict.Reason);
    }

    [Fact]
    public async Task UnnamedContinueRegistrationUsesItsIndexAsTheLabel()
    {
        var (e, notices) = WithNotifier();
        e.Register(new Scripted(Verdict.Allow));
        e.RegisterWithOptions(new Throws(), new RegistrationOptions(OnError: OnError.Continue));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.True(r.Proceeds);
        Assert.Equal(HostError.InterceptorFailed, r.Verdicts[1].SubstitutedFor);
        Assert.Null(r.Verdicts[1].Name);
        var n = Assert.Single(notices);
        Assert.Equal("interceptor-1", n.Binding);
        Assert.Equal(1, n.Index);
        Assert.Equal("interceptor-1: host_error:interceptor_failed; host continued", n.Message);
    }

    [Fact]
    public async Task EvaluateOnlyRecordsTheSubstitutionToo()
    {
        var (e, notices) = WithNotifier(EnforcementMode.EvaluateOnly);
        e.RegisterWithOptions(new Throws(), BestEffort("defender"));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.True(r.Proceeds);
        AssertSubstituted(r, 0, "defender", HostError.InterceptorFailed);
        Assert.Single(notices);
    }

    // ---- deny: the default, unchanged ---------------------------------------

    [Fact]
    public async Task DenyStaysTheDefaultForEveryRegistrationCall()
    {
        // The pre-1.1 calls and the options default all mean deny: the
        // record is unchanged, substituted_for is absent, nobody is
        // notified, even with a notifier set.
        var (e, notices) = WithNotifier();
        e.Register(new Throws());
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.False(r.Proceeds);
        Assert.Equal(HostError.InterceptorFailed, r.Verdict.Reason);
        Assert.Null(r.Verdicts[0].SubstitutedFor);
        Assert.Equal(0, r.DecidedBy);
        Assert.Empty(notices);
        Assert.False(r.ToWire()["verdicts"]![0]!.AsObject().ContainsKey("substituted_for"));

        Assert.Equal(OnError.Deny, new RegistrationOptions().OnError);
        e = new InterceptionEmitter();
        e.RegisterWithOptions(new Scripted(new Verdict(Decision.Transform)), new RegistrationOptions());
        r = await e.EmitUncheckedAsync(Ctx());
        Assert.False(r.Proceeds);
        Assert.Equal(HostError.VerdictInvalid, r.Verdict.Reason);
        Assert.Null(r.Verdicts[0].SubstitutedFor);

        e = new InterceptionEmitter(timeout: TimeSpan.FromMilliseconds(20));
        e.RegisterWithOptions(new Slow(TimeSpan.FromSeconds(5)), new RegistrationOptions("slow"));
        r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(HostError.InterceptorTimeout, r.Verdict.Reason);
        Assert.Null(r.Verdicts[0].SubstitutedFor);
    }

    // ---- the notifier is required and must succeed --------------------------

    [Fact]
    public async Task ContinueWithoutANotifierIsRefusedAtRegistration()
    {
        var e = new InterceptionEmitter();
        var err = Assert.Throws<RegistrationException>(
            () => e.RegisterWithOptions(new Scripted(Verdict.Allow), BestEffort("x")));
        Assert.Contains("control failure notifier", err.Detail);
        Assert.StartsWith("registration refused:", err.Message);
        Assert.Throws<RegistrationException>(
            () => e.RegisterManaged(new Managed(ManagedInterceptorOutcome.Timeout), BestEffort("m")));
        // Nothing was registered: the emission is the §7 empty deny.
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(HostError.NoInterceptor, r.Verdict.Reason);
        Assert.Equal(0, r.InterceptorsRegistered);

        // Deny needs no channel; after the channel exists, continue is accepted.
        e.RegisterWithOptions(new Scripted(Verdict.Allow), new RegistrationOptions());
        e.SetControlFailureNotifier(_ => { });
        e.RegisterWithOptions(new Scripted(Verdict.Allow), BestEffort("x"));
        e.RegisterManaged(new Managed(ManagedInterceptorOutcome.Timeout), BestEffort("m"));
        r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(3, r.InterceptorsRegistered);
    }

    [Fact]
    public async Task NotifierFailureWithdrawsTheContinuation()
    {
        // A principal that could not be told means the deny stands:
        // silent continuation is not reachable through a broken channel.
        var e = new InterceptionEmitter();
        e.SetControlFailureNotifier(_ => throw new IOException("channel down"));
        e.RegisterWithOptions(new Throws(), BestEffort("defender"));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.False(r.Proceeds);
        Assert.Equal(HostError.InterceptorFailed, r.Verdict.Reason);
        Assert.Contains("notifier", r.Verdict.Message);
        Assert.Contains("IOException", r.Verdict.Message);
        Assert.Null(r.Verdicts[0].SubstitutedFor);
        Assert.Null(r.Verdict.Warnings);
    }

    [Fact]
    public void NotifierMayBeSetOnASealedEmitter()
    {
        var em = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.1",
             "bindings": [{"id": "allow", "kind": "com.example.allow"}]}
            """, Registry());
        // A host channel, not declared configuration (like the record sink).
        em.SetControlFailureNotifier(_ => { });
        Assert.Throws<InvalidOperationException>(
            () => em.RegisterWithOptions(new Scripted(Verdict.Allow), new RegistrationOptions()));
        Assert.Throws<InvalidOperationException>(
            () => em.RegisterManaged(new Managed(ManagedInterceptorOutcome.Timeout)));
    }

    // ---- never continues (item 3) -------------------------------------------

    [Fact]
    public async Task ContinueNeverCoversCancellation()
    {
        // A typed cancelled outcome.
        var (e, notices) = WithNotifier();
        e.RegisterManaged(new Managed(ManagedInterceptorOutcome.Cancelled), BestEffort("defender"));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.False(r.Proceeds);
        Assert.Equal(HostError.InterceptorFailed, r.Verdict.Reason);
        Assert.Contains("cancelled", r.Verdict.Message);
        Assert.Null(r.Verdicts[0].SubstitutedFor);
        Assert.Equal(0, r.DecidedBy);
        Assert.Empty(notices);

        // The host's token cancelling a standard interceptor.
        (e, notices) = WithNotifier();
        e.RegisterWithOptions(new Cooperative(), BestEffort("defender"));
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(20));
        r = await e.EmitUncheckedAsync(Ctx(), cts.Token);
        Assert.False(r.Proceeds);
        Assert.Equal(HostError.InterceptorFailed, r.Verdict.Reason);
        Assert.Null(r.Verdicts[0].SubstitutedFor);
        Assert.Empty(notices);
    }

    [Fact]
    public async Task ContinueNeverCoversApprovalFailures()
    {
        var (e, notices) = WithNotifier(resolver: new RaisingResolver());
        e.RegisterWithOptions(new Scripted(Verdict.Escalate("check")), BestEffort("gate"));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.False(r.Proceeds);
        Assert.Equal(HostError.ApprovalResolverFailed, r.Verdict.Reason);
        Assert.Equal("rejection", r.ResolvedBy);
        Assert.Null(r.Verdicts[0].SubstitutedFor);
        Assert.Empty(notices);
    }

    [Fact]
    public async Task ContinueNeverCoversContextFailureExplicitDenyOrNoInterceptor()
    {
        // Context failure: the provider rejects the value domain before
        // any interceptor runs.
        var (e, notices) = WithNotifier();
        e.RegisterWithOptions(new Throws(), BestEffort("defender"));
        var c = Ctx();
        c.Json["target"] = new JsonObject { ["id"] = 9_007_199_254_740_993L };
        var r = await e.EmitUncheckedAsync(c);
        Assert.Equal(HostError.ContextInvalid, r.Verdict.Reason);
        Assert.Empty(r.Verdicts);
        // Invalid envelope: the same.
        c = Ctx();
        c.Json.Remove("spec");
        r = await e.EmitUncheckedAsync(c);
        Assert.Equal(HostError.ContextInvalid, r.Verdict.Reason);
        // An explicit deny is a decision, not a failure.
        (e, _) = WithNotifier();
        e.RegisterWithOptions(new Scripted(Verdict.Deny("policy")), BestEffort("policy"));
        r = await e.EmitUncheckedAsync(Ctx());
        Assert.False(r.Proceeds);
        Assert.Equal("policy", r.Verdict.Reason);
        Assert.Null(r.Verdicts[0].SubstitutedFor);
        // No interceptor at the point: the §7 deny, continue or not.
        (e, _) = WithNotifier();
        e.RegisterWithOptions(
            new Scripted(Verdict.Allow),
            new RegistrationOptions("output-only", new HashSet<InterceptionPoint> { InterceptionPoint.Output }, OnError.Continue));
        r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(HostError.NoInterceptor, r.Verdict.Reason);
        Assert.Empty(notices);
    }

    [Fact]
    public async Task ContinueNeverCoversTransformFailure()
    {
        var (e, notices) = WithNotifier();
        // A transform rooted outside $target fails §5.2, not §6.3.
        e.RegisterWithOptions(
            new Scripted(new Verdict(Decision.Transform, Transform: new Transform("$other.url", "x"))),
            BestEffort("rewrite"));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.False(r.Proceeds);
        Assert.StartsWith("host_error:transform_", r.Verdict.Reason);
        Assert.Null(r.Verdicts[0].SubstitutedFor);
        Assert.Empty(notices);
    }

    // ---- every profile --------------------------------------------------------

    [Fact]
    public async Task SubstitutedAllowTakesTheSlotInEveryProfile()
    {
        foreach (var composition in new[]
        {
            CompositionConfig.RunAll(),
            CompositionConfig.Strictest(SynthesisPolicy.Deny),
            CompositionConfig.Unanimous(SynthesisPolicy.Deny, SynthesisPolicy.Deny),
        })
        {
            var (e, notices) = WithNotifier();
            e.SetComposition(composition);
            e.Register(new Scripted(Verdict.Warn("pii")));
            e.RegisterWithOptions(new Throws(), BestEffort("defender"));
            var r = await e.EmitUncheckedAsync(Ctx());
            Assert.True(r.Proceeds, composition.Profile.ToWireName());
            Assert.Equal(Decision.Allow, r.Verdict.Decision);
            // §7.3: both warnings, first seen first.
            Assert.Equal(2, r.Verdict.Warnings!.Count);
            Assert.Equal("pii", r.Verdict.Warnings[0].Reason);
            AssertSubstituted(r, 1, "defender", HostError.InterceptorFailed);
            Assert.Null(r.Verdicts[0].SubstitutedFor);
            Assert.Null(r.DecidedBy);
            Assert.Single(notices);
        }
        // A plain deny elsewhere still wins; the substituted slot keeps
        // its warning in the union and its substituted_for.
        var (em, _) = WithNotifier();
        em.SetComposition(CompositionConfig.RunAll());
        em.RegisterWithOptions(new Throws(), BestEffort("defender"));
        em.Register(new Scripted(Verdict.Deny("ctk:blocked")));
        var rec = await em.EmitUncheckedAsync(Ctx());
        Assert.False(rec.Proceeds);
        Assert.Equal("ctk:blocked", rec.Verdict.Reason);
        Assert.Equal(1, rec.DecidedBy);
        Assert.Equal(HostError.InterceptorFailed, rec.Verdicts[0].SubstitutedFor);
        Assert.Equal(HostWarning.ControlFailed, rec.Verdict.Warnings![0].Reason);
    }

    // ---- the reserved warning ----------------------------------------------

    [Fact]
    public async Task AnInterceptorCannotEmitTheReservedWarning()
    {
        var spoof = Verdict.Warn(HostWarning.ControlFailed, "looks substituted");
        Assert.Throws<ArgumentException>(spoof.Validate);
        Assert.Throws<ArgumentException>(() => Verdict.Warn("host_error:x").Validate());
        Verdict.Warn("host_warnings").Validate();

        var e = new InterceptionEmitter();
        e.Register(new Scripted(spoof));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.False(r.Proceeds);
        Assert.Equal(HostError.VerdictInvalid, r.Verdict.Reason);
        Assert.Null(r.Verdict.Warnings); // the spoofed warning is dropped

        // Under continue the spoof is still an invalid verdict; what the
        // record shows is the host's own substitution, with the real reason.
        var (em, _) = WithNotifier();
        em.RegisterWithOptions(new Scripted(spoof), BestEffort("spoofer"));
        r = await em.EmitUncheckedAsync(Ctx());
        Assert.True(r.Proceeds);
        AssertSubstituted(r, 0, "spoofer", HostError.VerdictInvalid);
    }

    [Fact]
    public void SubstituteShapeAndHelpers()
    {
        var v = Verdict.ControlFailureSubstitute("egress", HostError.InterceptorTimeout);
        Assert.Equal(Decision.Allow, v.Decision);
        var w = Assert.Single(v.Warnings!);
        Assert.Equal(HostWarning.ControlFailed, w.Reason);
        Assert.Equal("egress: host_error:interceptor_timeout; host continued", w.Message);
        Assert.True(v.IsControlFailureSubstitute);
        Assert.False(Verdict.Allow.IsControlFailureSubstitute);
        Assert.False((v with { ResultLabels = ["l"] }).IsControlFailureSubstitute);
        // The host shape is reserved: an interceptor returning it fails the gate.
        Assert.Throws<ArgumentException>(v.Validate);
        Assert.Throws<ArgumentException>(
            () => Verdict.ControlFailureSubstitute("egress", HostError.ApprovalResolverFailed));
        Assert.True(HostError.IsControlFailure(HostError.InterceptorFailed));
        Assert.True(HostError.IsControlFailure(HostError.InterceptorTimeout));
        Assert.True(HostError.IsControlFailure(HostError.VerdictInvalid));
        Assert.False(HostError.IsControlFailure(HostError.ContextInvalid));
        Assert.False(HostError.IsControlFailure(HostError.NoInterceptor));
        Assert.Equal(OnError.Continue, OnErrorExtensions.FromWireName("continue"));
        Assert.Equal("deny", OnError.Deny.ToWireName());
        Assert.Throws<ArgumentOutOfRangeException>(() => OnErrorExtensions.FromWireName("allow"));
    }

    [Fact]
    public void VerdictSummaryKeepsTheFourComponentShape()
    {
        // Binary compatibility: the four-parameter constructor and
        // deconstruction shipped before SubstitutedFor existed.
        var ctor = typeof(VerdictSummary).GetConstructor(
            [typeof(int), typeof(Decision), typeof(string), typeof(string)]);
        Assert.NotNull(ctor);
        var s = (VerdictSummary)ctor.Invoke([1, Decision.Allow, null, "n"]);
        Assert.Null(s.SubstitutedFor);
        Assert.False(s.ToWire().ContainsKey("substituted_for"));
        var deconstruct = typeof(VerdictSummary).GetMethod(
            "Deconstruct", BindingFlags.Public | BindingFlags.Instance,
            [typeof(int).MakeByRefType(), typeof(Decision).MakeByRefType(),
             typeof(string).MakeByRefType(), typeof(string).MakeByRefType()]);
        Assert.NotNull(deconstruct);
        var full = new VerdictSummary(0, Decision.Allow, null, "slow", HostError.InterceptorTimeout);
        var wire = full.ToWire();
        Assert.Equal(HostError.InterceptorTimeout, (string?)wire["substituted_for"]);
        Assert.Equal(full, VerdictSummary.FromWire(wire));

        // The same for BindingContext and ResolvedBinding.
        Assert.NotNull(typeof(BindingContext).GetConstructor(
            [typeof(string), typeof(string), typeof(IReadOnlySet<InterceptionPoint>), typeof(TimeSpan?),
             typeof(HostInfo), typeof(string)]));
        Assert.Equal(OnError.Deny, new BindingContext("a", "k.x", new HashSet<InterceptionPoint>(), null, null, "v").OnError);
        Assert.NotNull(typeof(ResolvedBinding).GetConstructor(
            [typeof(string), typeof(string), typeof(JsonNode), typeof(IReadOnlySet<InterceptionPoint>), typeof(long?)]));
        Assert.Equal(OnError.Deny, new ResolvedBinding("a", "k.x", null, new HashSet<InterceptionPoint>(), null).OnError);
    }

    // ---- managed interceptors (item 8) ---------------------------------------

    [Fact]
    public async Task ManagedInterceptorReceivesTheBoundAndReportsTypedOutcomes()
    {
        // Deny: a typed timeout is the §6.3 timeout deny; the interceptor
        // saw the emitter-wide bound.
        var m = new Managed(ManagedInterceptorOutcome.Timeout);
        var e = new InterceptionEmitter(timeout: TimeSpan.FromMilliseconds(1234));
        e.RegisterManaged(m, new RegistrationOptions("scanner"));
        var r = await e.EmitUncheckedAsync(Ctx());
        Assert.True(m.Cleaned, "cleanup ran before the outcome");
        Assert.Equal(TimeSpan.FromMilliseconds(1234), m.BoundSeen);
        Assert.False(r.Proceeds);
        Assert.Equal(HostError.InterceptorTimeout, r.Verdict.Reason);
        Assert.Equal("scanner", r.Verdicts[0].Name);
        Assert.Null(r.Verdicts[0].SubstitutedFor);

        // Unbounded emitter: the managed interceptor sees null.
        m = new Managed(ManagedInterceptorOutcome.Timeout);
        e = new InterceptionEmitter(timeout: Timeout.InfiniteTimeSpan);
        e.RegisterManaged(m);
        await e.EmitUncheckedAsync(Ctx());
        Assert.True(m.BoundReceived);
        Assert.Null(m.BoundSeen);

        // Continue: the typed timeout is substituted like the emitter's.
        m = new Managed(ManagedInterceptorOutcome.Timeout);
        var (em, notices) = WithNotifier();
        em.RegisterManaged(m, BestEffort("scanner"));
        r = await em.EmitUncheckedAsync(Ctx());
        Assert.True(m.Cleaned);
        Assert.True(r.Proceeds);
        AssertSubstituted(r, 0, "scanner", HostError.InterceptorTimeout);
        Assert.Single(notices);

        // Failed carries its payload-free detail.
        e = new InterceptionEmitter();
        e.RegisterManaged(new Managed(ManagedInterceptorOutcome.Failed("IOException")));
        r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(HostError.InterceptorFailed, r.Verdict.Reason);
        Assert.Equal("IOException", r.Verdict.Message);
        (em, _) = WithNotifier();
        em.RegisterManaged(new Managed(ManagedInterceptorOutcome.Failed()), BestEffort("scanner"));
        r = await em.EmitUncheckedAsync(Ctx());
        AssertSubstituted(r, 0, "scanner", HostError.InterceptorFailed);

        // A managed verdict crosses the §5 gate like any other.
        e = new InterceptionEmitter();
        e.RegisterManaged(new Managed(ManagedInterceptorOutcome.FromVerdict(
            Verdict.Allow with { Reason = "host_error:forged" })));
        r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(HostError.VerdictInvalid, r.Verdict.Reason);
        e = new InterceptionEmitter();
        e.RegisterManaged(new Managed(ManagedInterceptorOutcome.FromVerdict(Verdict.Warn("scanned"))));
        r = await e.EmitUncheckedAsync(Ctx());
        Assert.True(r.Proceeds);
        Assert.Equal("scanned", r.Verdict.Warnings![0].Reason);

        // A managed interceptor that throws is a failure, not a crash,
        // and leaks nothing.
        e = new InterceptionEmitter();
        e.RegisterManaged(new ThrowingManaged());
        r = await e.EmitUncheckedAsync(Ctx());
        Assert.Equal(HostError.InterceptorFailed, r.Verdict.Reason);
        Assert.DoesNotContain("SECRET", r.Verdict.Message);
        Assert.Equal("InvalidOperationException", r.Verdict.Message);
    }

    [Fact]
    public void ManagedOutcomeWireShapes()
    {
        Assert.Equal("""{"outcome":"timeout"}""", ManagedInterceptorOutcome.Timeout.ToWire().ToJsonString());
        Assert.Equal("""{"outcome":"cancelled"}""", ManagedInterceptorOutcome.Cancelled.ToWire().ToJsonString());
        Assert.Equal("""{"outcome":"failed","detail":"IOException"}""",
            ManagedInterceptorOutcome.Failed("IOException").ToWire().ToJsonString());
        Assert.Equal("""{"outcome":"failed"}""", ManagedInterceptorOutcome.Failed().ToWire().ToJsonString());
        Assert.Equal("""{"outcome":"verdict","verdict":{"decision":"allow"}}""",
            ManagedInterceptorOutcome.FromVerdict(Verdict.Allow).ToWire().ToJsonString());
        Assert.Equal(ManagedOutcomeKind.Verdict, ManagedInterceptorOutcome.FromVerdict(Verdict.Allow).Kind);
    }

    // ---- declaration 1.1 ----------------------------------------------------

    private static readonly InterceptionPoint[] AllPoints = Enum.GetValues<InterceptionPoint>();

    private static HostSurface FullSurface() =>
        HostSurface.SdkDefault().WithPoints(AllPoints).WithCapabilities("model_calls", "tool_calls");

    private static HostRegistry Registry(List<ControlFailureNotice>? notices = null, Managed? managed = null)
    {
        var reg = new HostRegistry(FullSurface())
            .Kind("com.example.allow", (_, _) => new Scripted(Verdict.Allow))
            .Kind("com.example.throws", (_, _) => new Throws())
            .Kind("com.example.deny", (_, _) => new Scripted(Verdict.Deny("ctk:blocked")))
            .Kind("com.example.slow", (_, _) => new Slow(TimeSpan.FromSeconds(5)));
        if (managed is not null) reg.ManagedKind("com.example.managed", (_, _) => managed);
        if (notices is not null) reg.ControlFailureNotifier(notices.Add);
        return reg;
    }

    [Fact]
    public async Task OneOneDocumentWithContinueLoadsAndSubstitutes()
    {
        var notices = new List<ControlFailureNotice>();
        var em = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.1",
             "bindings": [{"id": "flaky", "kind": "com.example.throws", "on_error": "continue"},
                          {"id": "slow", "kind": "com.example.slow", "timeout_ms": 50, "on_error": "continue"},
                          {"id": "second", "kind": "com.example.allow"}]}
            """, Registry(notices));
        Assert.Equal("agent-hooks-declaration/1.1", em.Declaration!.Version);
        Assert.Equal(OnError.Deny, em.Declaration.FailureOnError);
        Assert.Equal(OnError.Continue, em.Declaration.Bindings[0].OnError);
        Assert.Equal(OnError.Continue, em.Declaration.Bindings[1].OnError);
        Assert.Equal(OnError.Deny, em.Declaration.Bindings[2].OnError);
        Assert.Contains("\"on_error\":\"continue\"", em.Declaration.CanonicalJson());
        Assert.Contains("\"failure\":{\"on_error\":\"deny\"}", em.Declaration.CanonicalJson());

        var r = await em.EmitUncheckedAsync(Ctx());
        Assert.True(r.Proceeds);
        Assert.Equal("agent-hooks-declaration/1.1", r.Declaration);
        Assert.Equal(3, r.Verdicts.Count);
        AssertSubstituted(r, 0, "flaky", HostError.InterceptorFailed);
        AssertSubstituted(r, 1, "slow", HostError.InterceptorTimeout);
        Assert.Null(r.Verdicts[2].SubstitutedFor);
        Assert.Equal(2, r.Verdict.Warnings!.Count);
        Assert.Null(r.DecidedBy);
        Assert.Equal(["flaky", "slow"], notices.Select(n => n.Binding));
        Assert.Equal([0, 1], notices.Select(n => n.Index));
    }

    [Fact]
    public async Task DocumentDefaultIsInheritedAndOverriddenPerBinding()
    {
        var notices = new List<ControlFailureNotice>();
        var inherited = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.1",
             "configuration": {"failure": {"on_error": "continue"}},
             "bindings": [{"id": "flaky", "kind": "com.example.throws"}]}
            """, Registry(notices));
        Assert.Equal(OnError.Continue, inherited.Declaration!.FailureOnError);
        Assert.Equal(OnError.Continue, inherited.Declaration.Bindings[0].OnError);
        var r = await inherited.EmitUncheckedAsync(Ctx());
        Assert.True(r.Proceeds);
        AssertSubstituted(r, 0, "flaky", HostError.InterceptorFailed);

        var toDeny = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.1",
             "configuration": {"failure": {"on_error": "continue"}},
             "bindings": [{"id": "flaky", "kind": "com.example.throws", "on_error": "deny"}]}
            """, Registry(notices));
        Assert.Equal(OnError.Deny, toDeny.Declaration!.Bindings[0].OnError);
        r = await toDeny.EmitUncheckedAsync(Ctx());
        Assert.False(r.Proceeds);
        Assert.Equal(HostError.InterceptorFailed, r.Verdict.Reason);
        Assert.Null(r.Verdicts[0].SubstitutedFor);

        var toContinue = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.1",
             "configuration": {"failure": {"on_error": "deny"}},
             "bindings": [{"id": "flaky", "kind": "com.example.throws", "on_error": "continue"}]}
            """, Registry(notices));
        r = await toContinue.EmitUncheckedAsync(Ctx());
        Assert.True(r.Proceeds);
        AssertSubstituted(r, 0, "flaky", HostError.InterceptorFailed);
        Assert.Equal(2, notices.Count);
    }

    [Fact]
    public async Task OneZeroDocumentLoadsUnchanged()
    {
        var em = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.0",
             "configuration": {"composition": {"profile": "sequential/run_all"}},
             "bindings": [{"id": "flaky", "kind": "com.example.throws"},
                          {"id": "second", "kind": "com.example.allow"}]}
            """, Registry());
        Assert.Equal("agent-hooks-declaration/1.0", em.Declaration!.Version);
        Assert.Equal(OnError.Deny, em.Declaration.FailureOnError);
        Assert.All(em.Declaration.Bindings, b => Assert.Equal(OnError.Deny, b.OnError));
        // The resolved form is the current minor's shape; the version is the document's.
        Assert.Contains("\"declaration\":\"agent-hooks-declaration/1.0\"", em.Declaration.CanonicalJson());
        Assert.Contains("\"failure\":{\"on_error\":\"deny\"}", em.Declaration.CanonicalJson());
        var r = await em.EmitUncheckedAsync(Ctx());
        Assert.False(r.Proceeds);
        Assert.Equal(HostError.InterceptorFailed, r.Verdict.Reason);
        Assert.Equal(0, r.DecidedBy);
        Assert.Equal("agent-hooks-declaration/1.0", r.Declaration);
        Assert.Null(r.Verdicts[0].SubstitutedFor);
        Assert.Equal(Decision.Allow, r.Verdicts[1].Decision);
    }

    public static IEnumerable<object[]> Refusals() =>
    [
        // A 1.0 loader's answer to a 1.1 document, seen here as the next minor.
        [
            """{"declaration": "agent-hooks-declaration/1.2", "bindings": []}""",
            DeclarationErrorClass.VersionUnsupported, "/declaration",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.1", "bindings": [{"id": "a", "kind": "com.example.allow", "on_error": "ignore"}]}""",
            DeclarationErrorClass.InvalidField, "/bindings/0/on_error",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.1", "configuration": {"failure": {"on_error": "allow"}}, "bindings": []}""",
            DeclarationErrorClass.InvalidField, "/configuration/failure/on_error",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.1", "configuration": {"failure": {"on_timeout": "deny"}}, "bindings": []}""",
            DeclarationErrorClass.UnknownField, "/configuration/failure/on_timeout",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "bindings": [{"id": "a", "kind": "com.example.allow", "on_error": "continue"}]}""",
            DeclarationErrorClass.UnknownField, "/bindings/0/on_error",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "configuration": {"failure": {"on_error": "deny"}}, "bindings": []}""",
            DeclarationErrorClass.UnknownField, "/configuration/failure",
        ],
        // continue without a principal channel: refused at the member that set it.
        [
            """{"declaration": "agent-hooks-declaration/1.1", "bindings": [{"id": "a", "kind": "com.example.allow", "on_error": "continue"}]}""",
            DeclarationErrorClass.BindingRejected, "/bindings/0/on_error",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.1", "configuration": {"failure": {"on_error": "continue"}}, "bindings": [{"id": "a", "kind": "com.example.allow"}]}""",
            DeclarationErrorClass.BindingRejected, "/configuration/failure/on_error",
        ],
    ];

    [Theory]
    [MemberData(nameof(Refusals))]
    public void RefusedDocumentsReportOneClassAndPointer(
        string json, DeclarationErrorClass expected, string pointer)
    {
        var e = Assert.Throws<DeclarationException>(
            () => InterceptionEmitter.FromDeclarationJson(json, Registry()));
        Assert.Equal(expected, e.Class);
        Assert.Contains(e.Findings, f => f.Pointer == pointer);
        if (expected == DeclarationErrorClass.VersionUnsupported)
        {
            Assert.Equal(Declaration.SupportedVersions, e.Accepted);
            Assert.Contains("agent-hooks-declaration/1.1", e.Findings[0].Detail);
        }
        if (expected == DeclarationErrorClass.BindingRejected)
            Assert.Contains("control failure notifier", e.Findings[0].Detail);
        // The same document refuses with the same class on every path.
        var viaNode = Assert.Throws<DeclarationException>(
            () => InterceptionEmitter.FromDeclarationNode(JsonNode.Parse(json), Registry()));
        Assert.Equal(expected, viaNode.Class);
    }

    [Fact]
    public void VersionConstantsAndSurfaceDefaults()
    {
        Assert.Equal("agent-hooks-declaration/1.1", Declaration.Version);
        Assert.Equal(["agent-hooks-declaration/1.0", "agent-hooks-declaration/1.1"], Declaration.SupportedVersions);
        Assert.True(HostSurface.SdkDefault().DeclarationVersions.SetEquals(Declaration.SupportedVersions));
        // A surface that accepts 1.0 only still validates (the probe
        // writes a version the surface accepts).
        var legacy = HostSurface.SdkDefault() with
        {
            DeclarationVersions = new HashSet<string> { "agent-hooks-declaration/1.0" },
        };
        var reg = new HostRegistry(legacy).Kind("com.example.allow", (_, _) => new Scripted(Verdict.Allow));
        var refused = Assert.Throws<DeclarationException>(() => InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.1", "bindings": [{"id": "a", "kind": "com.example.allow"}]}
            """, reg));
        Assert.Equal(DeclarationErrorClass.VersionUnsupported, refused.Class);
        Assert.Equal(["agent-hooks-declaration/1.0"], refused.Accepted);
    }

    [Fact]
    public async Task ManagedKindReceivesTheBindingBoundAndPosture()
    {
        var managed = new Managed(ManagedInterceptorOutcome.Timeout);
        BindingContext? seen = null;
        var reg = Registry(managed: managed);
        reg.ManagedKind("com.example.watch", (_, ctx) =>
        {
            seen = ctx;
            return managed;
        });
        var em = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.1",
             "bindings": [{"id": "scanner", "kind": "com.example.watch", "timeout_ms": 250}]}
            """, reg);
        Assert.Equal(TimeSpan.FromMilliseconds(250), seen!.Timeout);
        Assert.Equal(OnError.Deny, seen.OnError);
        var r = await em.EmitUncheckedAsync(Ctx());
        Assert.Equal(TimeSpan.FromMilliseconds(250), managed.BoundSeen);
        Assert.Equal(HostError.InterceptorTimeout, r.Verdict.Reason);
        Assert.Equal("scanner", r.Verdicts[0].Name);

        // Unbounded binding: the managed interceptor sees null.
        managed = new Managed(ManagedInterceptorOutcome.FromVerdict(Verdict.Allow));
        em = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.1",
             "bindings": [{"id": "scanner", "kind": "com.example.managed", "timeout_ms": null}]}
            """, Registry(managed: managed));
        r = await em.EmitUncheckedAsync(Ctx());
        Assert.True(r.Proceeds);
        Assert.True(managed.BoundReceived);
        Assert.Null(managed.BoundSeen);

        // Cancelled through a declared continue binding still denies.
        var notices = new List<ControlFailureNotice>();
        em = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.1",
             "bindings": [{"id": "scanner", "kind": "com.example.managed", "on_error": "continue"}]}
            """, Registry(notices, new Managed(ManagedInterceptorOutcome.Cancelled)));
        r = await em.EmitUncheckedAsync(Ctx());
        Assert.False(r.Proceeds);
        Assert.Equal(HostError.InterceptorFailed, r.Verdict.Reason);
        Assert.Null(r.Verdicts[0].SubstitutedFor);
        Assert.Empty(notices);
    }

    [Fact]
    public void RegistryKeepsOneKindNameManagedOrStandard()
    {
        var reg = new HostRegistry(FullSurface());
        reg.ManagedKind("com.example.m", (_, _) => new Managed(ManagedInterceptorOutcome.Timeout));
        Assert.Throws<ArgumentException>(() => reg.Kind("com.example.m", (_, _) => new Scripted(Verdict.Allow)));
        Assert.Throws<ArgumentException>(
            () => reg.ManagedKind("com.example.m", (_, _) => new Managed(ManagedInterceptorOutcome.Timeout)));
        reg.Kind("com.example.s", (_, _) => new Scripted(Verdict.Allow));
        Assert.Throws<ArgumentException>(
            () => reg.ManagedKind("com.example.s", (_, _) => new Managed(ManagedInterceptorOutcome.Timeout)));
        Assert.Throws<ArgumentException>(
            () => reg.ManagedKind("ctk.x", (_, _) => new Managed(ManagedInterceptorOutcome.Timeout)));
        Assert.Equal(["com.example.m", "com.example.s"], ((JsonArray)reg.Names()["kinds"]!).Select(n => (string)n!));
        Assert.Equal(["com.example.m", "com.example.s"], ((JsonArray)reg.ToHostWire()["kinds"]!).Select(n => (string)n!));
    }

    [Fact]
    public void BuilderWritesTheOnErrorMembersAndMatchesTheTextPath()
    {
        var doc = (JsonObject)JsonNode.Parse("""
            {"declaration": "agent-hooks-declaration/1.1",
             "configuration": {"failure": {"on_error": "continue"}},
             "bindings": [
               {"id": "flaky", "kind": "com.example.throws", "on_error": "deny"},
               {"id": "slow", "kind": "com.example.slow", "config": null, "timeout_ms": 50, "on_error": "continue"},
               {"id": "second", "kind": "com.example.allow", "at": ["pre_tool_call"]}
             ]}
            """)!;
        var built = HostDeclaration.Builder()
            .FailureOnError(OnError.Continue)
            .BindWith("flaky", "com.example.throws", new BindOptions(OnError: OnError.Deny))
            .BindWith("slow", "com.example.slow", config: null, new BindOptions(TimeoutMs: 50, OnError: OnError.Continue))
            .BindWith("second", "com.example.allow", new BindOptions(At: [InterceptionPoint.PreToolCall]));
        Assert.True(JsonNode.DeepEquals(doc, built.ToNode()), built.ToNode().ToJsonString());
        var reg = Registry(new List<ControlFailureNotice>());
        Assert.Equal(
            HostDeclaration.FromNode(doc).Resolve(reg).CanonicalJson(),
            built.Build().Resolve(reg).CanonicalJson());
        // The old Bind overloads write no on_error member at all.
        var plain = HostDeclaration.Builder().Bind("a", "com.example.allow").ToNode();
        Assert.False(plain["bindings"]![0]!.AsObject().ContainsKey("on_error"));
    }
}
