// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks.Tests;

public sealed class HookEmitterTests
{
    private static readonly BindingOptions Continue = new() { Name = "guard", OnError = Draft.OnError.Continue };

    [Fact]
    public async Task TypedTransformIsEnforcedOnTheReturnedRequestAndProjectedOutOfTheRecord()
    {
        var records = new List<Draft.InterceptionRecord>();
        var emitter = HookEmitter.CreateBuilder()
            .OnPreToolCall((request, _) => Task.FromResult(new Draft.PreToolHookResponse
            {
                Verdict = new Draft.TransformVerdictPreToolHookTransform
                {
                    Transform = new Draft.PreToolHookTransform
                    {
                        Args = new Draft.JsonObject { ["query"] = JsonSerializer.SerializeToElement("redacted") },
                    },
                },
            }))
            .WithRecordSink(records.Add)
            .Build();

        var result = await emitter.EmitAsync(PreToolCall());

        Assert.True(result.Proceeds);
        Assert.Equal("redacted", result.Request.ToolCall.Args["query"].GetString());
        Assert.False(result.Request.ToolCall.Args.ContainsKey("collection"));
        Assert.Same(result.Record, Assert.Single(records));
        Assert.Equal(Draft.Decision.Transform, result.Record.Verdict.Decision);
        Assert.Null(ContractSerializer.Serialize(result.Record)["verdict"]!["transform"]);
        Assert.Equal(0, result.Record.DecidedBy.Value);
        Assert.NotEqual(result.Record.InputIdentity, result.Record.EnforcedIdentity);
        Assert.Equal(Jcs.ContextIdentity(ContractSerializer.Serialize(result.Request)), result.Record.EnforcedIdentity);
    }

    [Fact]
    public async Task UnboundPointsAndInvalidRequestsFailClosedBeforeDispatch()
    {
        var calls = 0;
        var emitter = HookEmitter.CreateBuilder()
            .Use((_, _) => { calls++; return Task.FromResult<HookOutcome>(Allow()); }, null, Draft.InterceptionPoint.Input)
            .Build();

        var unbound = await emitter.EmitAsync(PreToolCall());
        Assert.False(unbound.Proceeds);
        Assert.Equal(HostErrors.NoInterceptor, (string?)unbound.Verdict["reason"]);

        var invalid = ContractSerializer.Serialize(PreToolCall());
        invalid["interception_point"] = "input";
        var refused = await emitter.EmitAsync(invalid);
        Assert.False(refused.Proceeds);
        Assert.Equal(HostErrors.ContextInvalid, (string?)refused.Verdict["reason"]);
        Assert.Null(refused.Record.InputIdentity);
        Assert.Equal(0, calls);
    }

    [Fact]
    public async Task TimeoutUnderContinueSubstitutesAnAllowAndNotifiesTheHost()
    {
        var notices = new List<ControlFailureNotice>();
        var emitter = HookEmitter.CreateBuilder()
            .Use(async (_, ct) => { await Task.Delay(Timeout.Infinite, ct); return Allow(); }, Continue with { Timeout = TimeSpan.FromMilliseconds(20) })
            .OnControlFailure(notices.Add)
            .Build();

        var result = await emitter.EmitAsync(PreToolCall());

        Assert.True(result.Proceeds);
        var notice = Assert.Single(notices);
        Assert.Equal(("guard", HostErrors.InterceptorTimeout), (notice.Binding, notice.Reason));
        Assert.Equal("guard: host_error:interceptor_timeout; host continued", (string?)result.Verdict["warnings"]![0]!["message"]);
        Assert.Equal(HostErrors.ControlFailedWarning, (string?)result.Verdict["warnings"]![0]!["reason"]);
        Assert.Equal(HostErrors.InterceptorTimeout, result.Record.Verdicts![0].SubstitutedFor!.Value.ToWire());
    }

    [Fact]
    public async Task HostCancellationIsNeverContinuedAndMalformedVerdictsAre()
    {
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        var hang = HookEmitter.CreateBuilder()
            .Use(async (_, ct) => { await Task.Delay(Timeout.Infinite, ct); return Allow(); }, Continue)
            .OnControlFailure(_ => { })
            .Build();
        var result = await hang.EmitAsync(PreToolCall(), cancelled.Token);
        Assert.False(result.Proceeds);
        Assert.Equal(HostErrors.InterceptorFailed, (string?)result.Verdict["reason"]);

        var malformed = HookEmitter.CreateBuilder()
            .Use((_, _) => Task.FromResult<HookOutcome>(new JsonObject { ["verdict"] = new JsonObject { ["decision"] = "transform" } }), Continue)
            .OnControlFailure(_ => { })
            .Build();
        var continued = await malformed.EmitAsync(PreToolCall());
        Assert.True(continued.Proceeds);
        Assert.Equal(HostErrors.VerdictInvalid, continued.Record.Verdicts![0].SubstitutedFor!.Value.ToWire());
    }

    [Theory]
    [InlineData(true, true, Draft.ResolvedBy.Approval)]
    [InlineData(false, false, Draft.ResolvedBy.Rejection)]
    public async Task ApprovalLiftsALiftableDenyOnlyWithAnEchoedPermit(bool echo, bool proceeds, Draft.ResolvedBy resolvedBy)
    {
        Draft.ApprovalRequest? seen = null;
        var emitter = HookEmitter.CreateBuilder()
            .Use((_, _) => Task.FromResult<HookOutcome>(new JsonObject
            {
                ["verdict"] = new JsonObject { ["decision"] = "deny", ["reason"] = "needs_review", ["approval"] = new JsonObject() },
            }))
            .WithApprovalRedactor(context => { context["tool_call"]!["args"] = new JsonObject(); return context; })
            .WithApprovalResolver((request, _) =>
            {
                seen = request;
                return Task.FromResult<Draft.ApprovalResolution>(new Draft.ApproveResolution
                {
                    ContextIdentity = echo ? request.ContextIdentity : "sha256:other",
                    Verdict = new Draft.AllowVerdict(),
                });
            })
            .Build();

        var result = await emitter.EmitAsync(PreToolCall());

        Assert.Equal(proceeds, result.Proceeds);
        Assert.Equal(resolvedBy, result.Record.ResolvedBy);
        Assert.Empty(ContractSerializer.Serialize(seen!)["context"]!["tool_call"]!["args"]!.AsObject());
        if (!echo) Assert.Equal(HostErrors.ApprovalIdentityMismatch, (string?)result.Verdict["reason"]);
    }

    [Fact]
    public async Task ParallelStrictestRefusesConflictingTransforms()
    {
        static Func<HookCall, CancellationToken, Task<HookOutcome>> Rewrite(string query) => (_, _) =>
            Task.FromResult<HookOutcome>(new JsonObject
            {
                ["verdict"] = new JsonObject { ["decision"] = "transform", ["transform"] = new JsonObject { ["args"] = new JsonObject { ["query"] = query } } },
            });
        var emitter = HookEmitter.CreateBuilder()
            .WithComposition(Draft.CompositionProfile.ParallelStrictest)
            .Use(Rewrite("a"))
            .Use(Rewrite("b"))
            .Build();

        var result = await emitter.EmitAsync(PreToolCall());

        Assert.False(result.Proceeds);
        Assert.Equal(HostErrors.TransformConflict, (string?)result.Verdict["reason"]);
        Assert.Equal(2, result.Record.Verdicts!.Length);
    }

    [Fact]
    public async Task RecordsTruncateMessagesAndSinkFailuresAreSwallowed()
    {
        var emitter = HookEmitter.CreateBuilder()
            .Use((_, _) => Task.FromResult<HookOutcome>(new JsonObject
            {
                ["verdict"] = new JsonObject { ["decision"] = "deny", ["reason"] = "r", ["message"] = new string('é', 200) },
            }))
            .WithRecordSink(_ => throw new InvalidOperationException())
            .Build();

        var result = await emitter.EmitAsync(PreToolCall());

        Assert.EndsWith("\u2026", result.Record.Verdict.Message!);
        Assert.Equal(126 + 1, result.Record.Verdict.Message!.Length);
        Assert.Equal(255, System.Text.Encoding.UTF8.GetByteCount(result.Record.Verdict.Message!));
        Assert.Equal(new string('é', 200), (string?)result.Verdict["message"]);
    }

    [Fact]
    public void HostFailuresAreRecordedWithoutIdentities()
    {
        var record = HookEmitter.CreateBuilder().Build()
            .RecordHostFailure(Draft.InterceptionPoint.Output, "adapter failed", sessionId: "s", sequence: 3);

        Assert.Equal((Draft.Decision.Deny, HostErrors.ContextInvalid), (record.Verdict.Decision, record.Verdict.Reason!));
        Assert.Equal(("s", 3), (record.SessionId, (int)record.Sequence));
        Assert.Null(record.InputIdentity);
    }

    internal static Draft.PreToolCallRequest PreToolCall() =>
        ContractSerializer.Deserialize<Draft.PreToolCallRequest>(JsonNode.Parse(File.ReadAllText(Example("AgentContext/pre-tool-call.json"))));

    internal static string Example(string path, [System.Runtime.CompilerServices.CallerFilePath] string source = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(source)!, "../../../../spec/draft/schema/examples", path));

    private static JsonObject Allow() => new() { ["verdict"] = new JsonObject { ["decision"] = "allow" } };
}
