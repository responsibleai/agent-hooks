// Copyright (c) Microsoft. All rights reserved.

// Typed tool hook tests (Hooks.cs, HookRegistration.cs): the
// PreToolCallRequest/PostToolCallRequest views over the context (§4.2),
// registration at exactly one point with name and on_error passed
// through (§6.3.1, §7.7.8), and the $target transform helpers (§5.2)
// against the emitter, under 0.1 and the draft.

using System.Text.Json.Nodes;
using AgentHooks;
using Xunit;

namespace AgentHooks.Tests;

public sealed class HookTests
{
    private sealed class Scripted(Verdict verdict) : IInterceptor
    {
        public ValueTask<Verdict> InterceptAsync(AgentContext ctx, CancellationToken ct = default) =>
            ValueTask.FromResult(verdict);
    }

    private sealed class PreHook(Func<PreToolCallRequest, Verdict> f) : IPreToolCallHook
    {
        public int Calls;

        public ValueTask<Verdict> OnPreToolCallAsync(PreToolCallRequest request, CancellationToken ct)
        {
            Calls++;
            return ValueTask.FromResult(f(request));
        }
    }

    private sealed class PostHook(Func<PostToolCallRequest, Verdict> f) : IPostToolCallHook
    {
        public ValueTask<Verdict> OnPostToolCallAsync(PostToolCallRequest request, CancellationToken ct) =>
            ValueTask.FromResult(f(request));
    }

    private sealed class BothHook : IPreToolCallHook, IPostToolCallHook
    {
        public int PreCalls;
        public int PostCalls;

        public ValueTask<Verdict> OnPreToolCallAsync(PreToolCallRequest request, CancellationToken ct)
        {
            PreCalls++;
            return ValueTask.FromResult(Verdict.Allow);
        }

        public ValueTask<Verdict> OnPostToolCallAsync(PostToolCallRequest request, CancellationToken ct)
        {
            PostCalls++;
            return ValueTask.FromResult(Verdict.Allow);
        }
    }

    private sealed class EgressGuard : IPreToolCallHook
    {
        public ValueTask<Verdict> OnPreToolCallAsync(PreToolCallRequest request, CancellationToken ct) =>
            ValueTask.FromResult(request.ToolCall.Name == "http_get"
                ? Verdict.Deny("egress_blocked")
                : Verdict.Allow);
    }

    private static AgentContextBuilder Builder(string spec) => new(spec, "agent-1", "test", "sess-1");

    private static JsonObject Args() => new() { ["url"] = "https://evil.example" };

    // ---- views ---------------------------------------------------------------

    [Theory]
    [InlineData(Spec.V01)]
    [InlineData(Spec.Draft)]
    public void PreViewReadsTheContextFields(string spec)
    {
        var tenant = new JsonObject { ["id"] = "t-1", ["name"] = "Contoso" };
        var r = PreToolCallRequest.ForTest(
            "http_get", Args(), spec, callId: "c-9", agentId: "a-1", sessionId: "s-1", tenant: tenant);
        Assert.Equal(spec, r.Spec);
        Assert.Equal(0, r.Sequence);
        Assert.Equal("a-1", r.AgentId);
        Assert.Equal("s-1", r.SessionId);
        Assert.Equal("t-1", (string?)r.Tenant!["id"]);
        Assert.Equal("c-9", r.ToolCall.Id);
        Assert.Equal("http_get", r.ToolCall.Name);
        Assert.True(JsonNode.DeepEquals(Args(), r.ToolCall.Args));
        Assert.Null(r.ToolCall.ContentHash);
    }

    [Theory]
    [InlineData(Spec.V01)]
    [InlineData(Spec.Draft)]
    public void PostViewReadsTheContextFields(string spec)
    {
        var r = PostToolCallRequest.ForTest(
            "http_get", Args(), new JsonObject { ["status"] = 200 }, isError: true, durationMs: 12.5, spec: spec);
        Assert.Equal(spec, r.Spec);
        Assert.Equal("http_get", r.ToolCall.Name);
        Assert.Equal(200, (int)r.ToolResult.Value!["status"]!);
        Assert.True(r.ToolResult.IsError);
        Assert.Equal(12.5, r.ToolResult.DurationMs);
        Assert.Null(r.Tenant);

        var bare = PostToolCallRequest.ForTest("t", [], null, spec: spec);
        Assert.Null(bare.ToolResult.Value);
        Assert.False(bare.ToolResult.IsError);
        Assert.Null(bare.ToolResult.DurationMs);
    }

    [Fact]
    public void TenantIsNullWhenAbsent()
    {
        Assert.Null(PreToolCallRequest.ForTest("t", Args()).Tenant);
    }

    [Fact]
    public void ViewsReadParsedContexts()
    {
        // A parsed context backs every number with a JsonElement.
        var ctx = (JsonObject)JsonNode.Parse("""
            {"spec":"agent-hooks/0.1","interception_point":"post_tool_call","timestamp":"2026-01-01T00:00:00Z",
             "sequence":9007199254740993,"agent":{"id":"a","framework":"x"},"session":{"id":"s"},
             "target":1,"tool_call":{"id":"c","name":"n","args":{},
             "content_hash":"sha256:0000000000000000000000000000000000000000000000000000000000000000"},
             "tool_result":{"value":1,"is_error":false,"duration_ms":3}}
            """)!;
        var r = new PostToolCallRequest(ctx);
        Assert.Equal(9_007_199_254_740_993L, r.Sequence);
        Assert.Equal(3.0, r.ToolResult.DurationMs);
        Assert.StartsWith("sha256:", r.ToolCall.ContentHash);
    }

    [Theory]
    [InlineData(Spec.V01)]
    [InlineData(Spec.Draft)]
    public async Task WrappingLeavesTheContextAndItsIdentityUnchanged(string spec)
    {
        // 2^53 - 1: the largest integer the default identity provider
        // accepts (§10.2); larger ones are covered below.
        var args = new JsonObject { ["id"] = 9_007_199_254_740_991L, ["unknown_field"] = new JsonObject { ["k"] = "v" } };
        var ctx = Builder(spec).PreToolCall("c-1", "lookup", args);
        ctx.Json["extensions"] = new JsonObject { ["com_example"] = new JsonObject { ["trace"] = "x" } };
        var before = ctx.Json.ToJsonString();
        var identity = Canonical.ContextIdentity(ctx);

        // The view wraps the context it is given; it does not copy it.
        Assert.Same(ctx.Json, new PreToolCallRequest(ctx).Json);

        PreToolCallRequest? seen = null;
        var hook = new PreHook(r =>
        {
            seen = r;
            _ = (r.Spec, r.Sequence, r.AgentId, r.SessionId, r.Tenant,
                r.ToolCall.Id, r.ToolCall.Name, r.ToolCall.Args, r.ToolCall.ContentHash);
            return Verdict.Allow;
        });
        var e = new InterceptionEmitter(spec).RegisterHook(hook);
        var outcome = await e.EmitAsync(ctx);

        // The emitter hands each interceptor its own copy (§7); the hook
        // sees that copy, member for member.
        Assert.Equal(before, seen!.Json.ToJsonString());
        Assert.Equal(before, ctx.Json.ToJsonString());
        Assert.Equal(identity, outcome.Record.InputIdentity);
        Assert.Equal(identity, outcome.Record.EnforcedIdentity);
        Assert.Equal("x", (string?)seen.Json["extensions"]!["com_example"]!["trace"]);
        Assert.Equal(9_007_199_254_740_991L, (long)seen.ToolCall.Args["id"]!);
        Assert.Equal("v", (string?)seen.ToolCall.Args["unknown_field"]!["k"]);
    }

    [Fact]
    public async Task Int64ValuesReachTheHookUntouched()
    {
        // Beyond 2^53 the default provider refuses the context (§10.2), so
        // run identity-unbound: the view must not round the value.
        var ctx = Builder(Spec.V01).PreToolCall("c", "t", new JsonObject { ["id"] = 9_007_199_254_740_993L });
        long? seen = null;
        var e = new InterceptionEmitter(Spec.V01)
            .SetIdentityProvider(IdentityProvider.Null)
            .OnPreToolCall("read", (r, _) =>
            {
                seen = (long)r.ToolCall.Args["id"]!;
                return ValueTask.FromResult(Verdict.Allow);
            });
        await e.EmitAsync(ctx);
        Assert.Equal(9_007_199_254_740_993L, seen);
    }

    [Fact]
    public void WrongPointConstructionThrows()
    {
        var b = Builder(Spec.V01);
        var pre = b.PreToolCall("c", "t", Args());
        var post = b.PostToolCall("c", "t", Args(), 1);

        var ex = Assert.Throws<ArgumentException>(() => new PreToolCallRequest(post));
        Assert.Contains("pre_tool_call", ex.Message);
        Assert.Contains("post_tool_call", ex.Message);
        Assert.Throws<ArgumentException>(() => new PostToolCallRequest(pre));
        Assert.Throws<ArgumentException>(() => new PreToolCallRequest(b.Input("hi")));
        Assert.Throws<ArgumentException>(() => new PostToolCallRequest(b.Output("bye")));
    }

    // ---- registration ----------------------------------------------------------

    [Theory]
    [InlineData(Spec.V01)]
    [InlineData(Spec.Draft)]
    public async Task PreHookRunsOnlyAtPreToolCall(string spec)
    {
        var b = Builder(spec);
        var hook = new PreHook(_ => Verdict.Allow);
        var e = new InterceptionEmitter(spec)
            .Register(new Scripted(Verdict.Allow), "everywhere")
            .RegisterHook(hook, "pre-only");

        var input = await e.EmitAsync(b.Input("hi"));
        var post = await e.EmitAsync(b.PostToolCall("c", "t", Args(), 1));
        var output = await e.EmitAsync(b.Output("bye"));
        Assert.Equal(0, hook.Calls);
        // Not bound there: not counted, no index.
        Assert.All([input, post, output], o =>
        {
            Assert.Equal(1, o.Record.InterceptorsRegistered);
            Assert.Equal("everywhere", Assert.Single(o.Record.Verdicts).Name);
        });

        var pre = await e.EmitAsync(b.PreToolCall("c", "t", Args()));
        Assert.Equal(1, hook.Calls);
        Assert.Equal(2, pre.Record.InterceptorsRegistered);
        Assert.Equal(1, pre.Record.Verdicts[1].Index);
        Assert.Equal("pre-only", pre.Record.Verdicts[1].Name);
    }

    [Theory]
    [InlineData(Spec.V01)]
    [InlineData(Spec.Draft)]
    public async Task AHookImplementingBothInterfacesRegistersOncePerPoint(string spec)
    {
        var b = Builder(spec);
        var both = new BothHook();
        var e = new InterceptionEmitter(spec).RegisterHook<object>(both, "both");

        var pre = await e.EmitAsync(b.PreToolCall("c", "t", Args()));
        var post = await e.EmitAsync(b.PostToolCall("c", "t", Args(), 1));
        Assert.Equal((1, 1), (both.PreCalls, both.PostCalls));
        Assert.Equal(1, pre.Record.InterceptorsRegistered);
        Assert.Equal(1, post.Record.InterceptorsRegistered);
        Assert.Equal(0, Assert.Single(pre.Record.Verdicts).Index);
        Assert.Equal("both", pre.Record.Verdicts[0].Name);
        Assert.Equal(0, Assert.Single(post.Record.Verdicts).Index);
        Assert.Equal("both", Assert.Single(post.Record.Verdicts).Name);

        // Through either interface the runtime type decides, not the static one.
        var viaInterface = new BothHook();
        var e2 = new InterceptionEmitter(spec).RegisterHook((IPreToolCallHook)viaInterface);
        await e2.EmitAsync(b.PreToolCall("c", "t", Args()));
        await e2.EmitAsync(b.PostToolCall("c", "t", Args(), 1));
        Assert.Equal((1, 1), (viaInterface.PreCalls, viaInterface.PostCalls));
    }

    [Theory]
    [InlineData(Spec.V01)]
    [InlineData(Spec.Draft)]
    public async Task GenericRegistrationRejectsObjectsWithoutHookInterfaces(string spec)
    {
        var e = new InterceptionEmitter(spec);
        var ex = Assert.Throws<RegistrationException>(() => e.RegisterHook(new object()));
        Assert.Contains("IPreToolCallHook or IPostToolCallHook", ex.Detail);

        var b = Builder(spec);
        foreach (var ctx in new[]
        {
            b.PreToolCall("c", "t", Args()),
            b.PostToolCall("c", "t", Args(), 1),
        })
        {
            var record = await e.EmitUncheckedAsync(ctx);
            Assert.Equal(0, record.InterceptorsRegistered);
            Assert.Empty(record.Verdicts);
            Assert.Equal(HostError.NoInterceptor, record.Verdict.Reason);
        }
    }

    [Theory]
    [InlineData(Spec.V01, true)]
    [InlineData(Spec.V01, false)]
    [InlineData(Spec.Draft, true)]
    [InlineData(Spec.Draft, false)]
    public async Task GenericRegistrationRegistersOnlyTheImplementedInterface(string spec, bool isPre)
    {
        var calls = 0;
        object hook = isPre
            ? new PreHook(_ => { calls++; return Verdict.Allow; })
            : new PostHook(_ => { calls++; return Verdict.Allow; });
        var e = new InterceptionEmitter(spec).RegisterHook(hook, "single");
        var b = Builder(spec);
        var pre = await e.EmitUncheckedAsync(b.PreToolCall("c", "t", Args()));
        var post = await e.EmitUncheckedAsync(b.PostToolCall("c", "t", Args(), 1));

        Assert.Equal(1, calls);
        var active = isPre ? pre : post;
        var inactive = isPre ? post : pre;
        Assert.Equal(1, active.InterceptorsRegistered);
        Assert.Equal(0, Assert.Single(active.Verdicts).Index);
        Assert.Equal("single", active.Verdicts[0].Name);
        Assert.True(active.Proceeds);
        Assert.Equal(0, inactive.InterceptorsRegistered);
        Assert.Empty(inactive.Verdicts);
        Assert.Equal(HostError.NoInterceptor, inactive.Verdict.Reason);
    }

    [Fact]
    public async Task NameAndContinuePassThroughToTheRecord()
    {
        var notices = new List<ControlFailureNotice>();
        var e = new InterceptionEmitter(Spec.Draft);
        e.SetControlFailureNotifier(notices.Add);
        e.OnPreToolCall("best-effort", (_, _) => throw new InvalidOperationException("boom"), OnError.Continue);

        var r = await e.EmitUncheckedAsync(Builder(Spec.Draft).PreToolCall("c", "t", Args()));
        Assert.True(r.Proceeds);
        var s = Assert.Single(r.Verdicts);
        Assert.Equal("best-effort", s.Name);
        Assert.Equal(HostError.InterceptorFailed, s.SubstitutedFor);
        Assert.Equal("best-effort", Assert.Single(notices).Binding);
    }

    [Fact]
    public void ContinueIsRefusedAsForAnyRegistration()
    {
        // No notifier: the existing RegisterWithOptions refusal applies.
        var e = new InterceptionEmitter(Spec.Draft);
        Assert.Throws<RegistrationException>(() =>
            e.RegisterHook(new PreHook(_ => Verdict.Allow), "x", OnError.Continue));
        // 0.1 defines no failure posture.
        var e01 = new InterceptionEmitter(Spec.V01);
        e01.SetControlFailureNotifier(_ => { });
        Assert.Throws<RegistrationException>(() =>
            e01.OnPostToolCall("x", (_, _) => ValueTask.FromResult(Verdict.Allow), OnError.Continue));
    }

    [Theory]
    [InlineData(Spec.V01)]
    [InlineData(Spec.Draft)]
    public async Task DenyFromAHookBlocks(string spec)
    {
        var b = Builder(spec);
        var e = new InterceptionEmitter(spec).RegisterHook(new EgressGuard(), "egress-guard");

        var ex = await Assert.ThrowsAsync<InterceptionBlockedException>(
            async () => await e.EmitAsync(b.PreToolCall("c", "http_get", Args())));
        Assert.Equal("egress_blocked", ex.Result.Verdict.Reason);
        Assert.Equal(0, ex.Result.DecidedBy);
        Assert.Equal("egress-guard", ex.Result.Verdicts[0].Name);

        var ok = await e.EmitAsync(b.PreToolCall("c", "read_file", Args()));
        Assert.True(ok.Record.Proceeds);
    }

    // ---- transforms ------------------------------------------------------------

    [Theory]
    [InlineData(Spec.V01)]
    [InlineData(Spec.Draft)]
    public async Task TransformArgsReplacesToolCallArgs(string spec)
    {
        var safe = new JsonObject { ["url"] = "https://safe.example" };
        var v = PreToolCallRequest.TransformArgs(safe);
        Assert.Equal(Decision.Transform, v.Decision);
        Assert.Equal("$target", v.Transform!.Path);
        v.Validate(spec);

        var e = new InterceptionEmitter(spec)
            .OnPreToolCall("rewrite", (_, _) => ValueTask.FromResult(PreToolCallRequest.TransformArgs(safe)));
        var ctx = Builder(spec).PreToolCall("c", "http_get", Args());
        var outcome = await e.EmitAsync(ctx);

        Assert.Equal(Decision.Transform, outcome.Record.Verdict.Decision);
        Assert.True(JsonNode.DeepEquals(safe, outcome.Target));
        Assert.True(JsonNode.DeepEquals(safe, new PreToolCallRequest(ctx).ToolCall.Args));
        Assert.NotEqual(outcome.Record.InputIdentity, outcome.Record.EnforcedIdentity);
    }

    [Theory]
    [InlineData(Spec.V01)]
    [InlineData(Spec.Draft)]
    public async Task TransformValueReplacesToolResultValue(string spec)
    {
        var redacted = new JsonObject { ["text"] = "[redacted]" };
        var v = PostToolCallRequest.TransformValue(redacted);
        Assert.Equal(Decision.Transform, v.Decision);
        Assert.Equal("$target", v.Transform!.Path);
        var e = new InterceptionEmitter(spec)
            .RegisterHook(new PostHook(_ => PostToolCallRequest.TransformValue(redacted)), "redact");
        var ctx = Builder(spec).PostToolCall("c", "t", Args(), new JsonObject { ["text"] = "secret" });
        var outcome = await e.EmitAsync(ctx);

        Assert.True(JsonNode.DeepEquals(redacted, outcome.Target));
        Assert.True(JsonNode.DeepEquals(redacted, new PostToolCallRequest(ctx).ToolResult.Value));
        // tool_call is not replaced.
        Assert.True(JsonNode.DeepEquals(Args(), new PostToolCallRequest(ctx).ToolCall.Args));
    }

    [Theory]
    [InlineData(Spec.V01)]
    [InlineData(Spec.Draft)]
    public async Task TransformValueToNullClearsTheResult(string spec)
    {
        var verdict = PostToolCallRequest.TransformValue(null);
        Assert.False(verdict.ToWire()["transform"]!.AsObject().ContainsKey("value"));
        var e = new InterceptionEmitter(spec)
            .OnPostToolCall("clear", (_, _) => ValueTask.FromResult(verdict));
        var ctx = Builder(spec).PostToolCall("c", "t", Args(), "secret");
        var outcome = await e.EmitAsync(ctx);

        Assert.Equal(Decision.Transform, outcome.Record.Verdict.Decision);
        Assert.Null(outcome.Target);
        Assert.True(ctx.Json.ContainsKey("target"));
        Assert.True(ctx.Json["tool_result"]!.AsObject().ContainsKey("value"));
        Assert.Null(new PostToolCallRequest(ctx).ToolResult.Value);
    }
}
