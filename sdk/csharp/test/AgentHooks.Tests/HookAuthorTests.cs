// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks.Tests;

[Trait("Category", "draft")]
public sealed class HookAuthorTests
{
    [Theory]
    [InlineData("agent-startup", Draft.InterceptionPoint.AgentStartup)]
    [InlineData("input", Draft.InterceptionPoint.Input)]
    [InlineData("pre-model-call", Draft.InterceptionPoint.PreModelCall)]
    [InlineData("post-model-call", Draft.InterceptionPoint.PostModelCall)]
    [InlineData("pre-tool-call", Draft.InterceptionPoint.PreToolCall)]
    [InlineData("post-tool-call", Draft.InterceptionPoint.PostToolCall)]
    [InlineData("output", Draft.InterceptionPoint.Output)]
    [InlineData("agent-shutdown", Draft.InterceptionPoint.AgentShutdown)]
    public async Task AddHookDispatchesOnlyTheMatchingInterface(string example, Draft.InterceptionPoint point)
    {
        var hook = new PolicyHook();
        var emitter = HookEmitter.CreateBuilder()
            .AddHook(hook, new BindingOptions { Name = "policy" })
            .Build();

        var result = await emitter.EmitAsync(Request(example));

        Assert.False(result.Proceeds);
        Assert.Equal("policy_blocked", (string?)result.Verdict["reason"]);
        Assert.Equal(point, Assert.Single(hook.Calls));
        var slot = Assert.Single(result.Record.Verdicts!);
        Assert.Equal("policy", slot.Name);
    }

    [Theory]
    [InlineData("agent-startup", null)]
    [InlineData("input", "input")]
    [InlineData("pre-model-call", "messages")]
    [InlineData("post-model-call", "response")]
    [InlineData("pre-tool-call", "args")]
    [InlineData("post-tool-call", "value")]
    [InlineData("output", "output")]
    [InlineData("agent-shutdown", null)]
    public async Task NamedDelegatesEnforceWholeTargetTransforms(string example, string? target)
    {
        var content = JsonSerializer.SerializeToElement("redacted");
        var input = new Draft.Input { Content = content, Role = Draft.InputRole.User };
        Draft.Message[] messages = [new() { Content = content, Role = "user" }];
        var response = new Draft.Response { Content = content, ToolCalls = [], FinishReason = "stop" };
        var args = new Draft.JsonObject { ["query"] = content };
        var output = new Draft.Output { Content = content };
        var builder = HookEmitter.CreateBuilder();
        switch (example)
        {
            case "agent-startup":
                builder.OnAgentStartup("rewrite", (_, _) => Task.FromResult(AgentStartupResponses.Allow()));
                break;
            case "input":
                builder.OnInput("rewrite", (_, _) => Task.FromResult(InputResponses.TransformInput(input)));
                break;
            case "pre-model-call":
                builder.OnPreModelCall("rewrite", (_, _) => Task.FromResult(PreModelResponses.TransformMessages(messages)));
                break;
            case "post-model-call":
                builder.OnPostModelCall("rewrite", (_, _) => Task.FromResult(PostModelResponses.TransformResponse(response)));
                break;
            case "pre-tool-call":
                builder.OnPreToolCall("rewrite", (_, _) => Task.FromResult(PreToolResponses.TransformArgs(args)));
                break;
            case "post-tool-call":
                builder.OnPostToolCall("rewrite", (_, _) => Task.FromResult(PostToolResponses.TransformValue(content)));
                break;
            case "output":
                builder.OnOutput("rewrite", (_, _) => Task.FromResult(OutputResponses.TransformOutput(output)));
                break;
            case "agent-shutdown":
                builder.OnAgentShutdown("rewrite", (_, _) => Task.FromResult(AgentShutdownResponses.Allow()));
                break;
        }

        var request = Request(example);
        var original = request.DeepClone();
        var result = await builder.Build().EmitAsync(request);

        Assert.True(result.Proceeds);
        Assert.True(JsonNode.DeepEquals(original, request));
        Assert.Equal("rewrite", Assert.Single(result.Record.Verdicts!).Name);
        Assert.Equal(target is null ? Draft.Decision.Allow : Draft.Decision.Transform, result.Record.Verdict.Decision);
        Assert.Null(ContractSerializer.Serialize(result.Record)["verdict"]!["transform"]);
        if (target is not null)
        {
            var actual = target switch
            {
                "args" => result.Request["tool_call"]!["args"],
                "value" => result.Request["tool_result"]!["value"],
                _ => result.Request[target],
            };
            var expected = target switch
            {
                "input" => JsonSerializer.SerializeToNode(input),
                "messages" => JsonSerializer.SerializeToNode(messages),
                "response" => JsonSerializer.SerializeToNode(response),
                "args" => JsonSerializer.SerializeToNode(args),
                "output" => JsonSerializer.SerializeToNode(output),
                _ => JsonSerializer.SerializeToNode(content),
            };
            Assert.True(JsonNode.DeepEquals(expected, actual), actual?.ToJsonString());
            Assert.NotEqual(result.Record.InputIdentity, result.Record.EnforcedIdentity);
        }
    }

    [Fact]
    public async Task ToolOnlyHookDoesNotBindOtherPointsAndKeepsFailureOptions()
    {
        var notices = new List<ControlFailureNotice>();
        var emitter = HookEmitter.CreateBuilder()
            .AddHook(new FailingToolHook(), new BindingOptions
            {
                Name = "tool-policy",
                OnError = Draft.OnError.Continue,
                Timeout = TimeSpan.FromMilliseconds(20),
            })
            .OnControlFailure(notices.Add)
            .Build();

        var pre = await emitter.EmitAsync(Request("pre-tool-call"));
        var post = await emitter.EmitAsync(Request("post-tool-call"));
        var input = await emitter.EmitAsync(Request("input"));

        Assert.True(pre.Proceeds);
        Assert.True(post.Proceeds);
        Assert.Equal([HostErrors.InterceptorTimeout, HostErrors.InterceptorFailed], notices.Select(n => n.Reason));
        Assert.All(notices, notice => Assert.Equal("tool-policy", notice.Binding));
        Assert.False(input.Proceeds);
        Assert.Equal(HostErrors.NoInterceptor, (string?)input.Verdict["reason"]);
    }

    [Fact]
    public async Task NamedDelegateOverridesOnlyTheNameAndReceivesACancellableToken()
    {
        CancellationToken seen = default;
        var notices = new List<ControlFailureNotice>();
        var options = new BindingOptions { Name = "old-name", OnError = Draft.OnError.Continue, Timeout = TimeSpan.FromMilliseconds(20) };
        var emitter = HookEmitter.CreateBuilder()
            .OnPreToolCall("new-name", async (_, ct) =>
            {
                seen = ct;
                await Task.Delay(Timeout.Infinite, ct);
                return PreToolResponses.Allow();
            }, options)
            .OnControlFailure(notices.Add)
            .Build();

        var result = await emitter.EmitAsync(HookEmitterTests.PreToolCall());

        Assert.True(result.Proceeds);
        Assert.True(seen.IsCancellationRequested);
        Assert.Equal(("new-name", HostErrors.InterceptorTimeout), (Assert.Single(notices).Binding, notices[0].Reason));
        Assert.Equal("old-name", options.Name);
    }

    [Fact]
    public async Task TransformValuePreservesJsonNullAfterTheSourceDocumentIsDisposed()
    {
        Draft.PostToolHookResponse response;
        using (var document = JsonDocument.Parse("null"))
            response = PostToolResponses.TransformValue(document.RootElement);
        var emitter = HookEmitter.CreateBuilder()
            .OnPostToolCall("redact-result", (_, _) => Task.FromResult(response))
            .Build();
        var request = ContractSerializer.Deserialize<Draft.PostToolCallRequest>(Request("post-tool-call"));

        var result = await emitter.EmitAsync(request);

        Assert.True(result.Proceeds);
        Assert.Equal(JsonValueKind.Null, result.Request.ToolResult.Value.ValueKind);
        Assert.Equal(Draft.Decision.Transform, result.Record.Verdict.Decision);
        Assert.Equal(JsonValueKind.Object, request.ToolResult.Value.ValueKind);
    }

    [Fact]
    public async Task InvalidRegistrationThrowsWithoutChangingTheBuilder()
    {
        var builder = HookEmitter.CreateBuilder();
        Assert.Throws<ArgumentNullException>(() => builder.AddHook(null!));
        Assert.Throws<ArgumentException>(() => builder.AddHook(new object()));
        Assert.Throws<ArgumentException>(() => builder.AddHook(new PolicyHook(), new BindingOptions { Name = "" }));
        Assert.Throws<ArgumentOutOfRangeException>(() => builder.AddHook(new PolicyHook(), new BindingOptions { Timeout = TimeSpan.Zero }));
        Assert.Throws<ArgumentNullException>(() => builder.OnPreToolCall("guard", null!));
        Assert.Throws<ArgumentNullException>(() => builder.OnPreToolCall(null!, (_, _) => Task.FromResult(PreToolResponses.Allow())));

        var result = await builder.Build().EmitAsync(HookEmitterTests.PreToolCall());
        Assert.Equal(HostErrors.NoInterceptor, (string?)result.Verdict["reason"]);
    }

    [Fact]
    public async Task FactoryDenyStillUsesTheRuntimeVerdictGate()
    {
        var response = PreToolResponses.Deny("policy_blocked");
        response.Extensions = new Draft.Extensions { ["acme"] = JsonSerializer.SerializeToElement(new string('x', 65536)) };
        var emitter = HookEmitter.CreateBuilder()
            .OnPreToolCall("oversized-metadata", (_, _) => Task.FromResult(response))
            .Build();

        var result = await emitter.EmitAsync(HookEmitterTests.PreToolCall());

        Assert.False(result.Proceeds);
        Assert.Equal(HostErrors.VerdictInvalid, (string?)result.Verdict["reason"]);
    }

    private static JsonObject Request(string example) =>
        JsonNode.Parse(File.ReadAllText(HookEmitterTests.Example($"AgentContext/{example}.json")))!.AsObject();

    private sealed class FailingToolHook : IPreToolCallHook, IPostToolCallHook
    {
        public async Task<Draft.PreToolHookResponse> OnPreToolCallAsync(Draft.PreToolCallRequest request, CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return PreToolResponses.Allow();
        }

        public Task<Draft.PostToolHookResponse> OnPostToolCallAsync(Draft.PostToolCallRequest request, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("policy unavailable");
    }

    private sealed class PolicyHook : IAgentStartupHook, IInputHook, IPreModelCallHook, IPostModelCallHook,
        IPreToolCallHook, IPostToolCallHook, IOutputHook, IAgentShutdownHook
    {
        public List<Draft.InterceptionPoint> Calls { get; } = [];

        private Task<T> Denied<T>(Draft.InterceptionPoint point, T response)
        {
            Calls.Add(point);
            return Task.FromResult(response);
        }

        public Task<Draft.AgentStartupHookResponse> OnAgentStartupAsync(Draft.AgentStartupRequest request, CancellationToken cancellationToken) =>
            Denied(Draft.InterceptionPoint.AgentStartup, AgentStartupResponses.Deny("policy_blocked"));
        public Task<Draft.InputHookResponse> OnInputAsync(Draft.InputRequest request, CancellationToken cancellationToken) =>
            Denied(Draft.InterceptionPoint.Input, InputResponses.Deny("policy_blocked"));
        public Task<Draft.PreModelHookResponse> OnPreModelCallAsync(Draft.PreModelCallRequest request, CancellationToken cancellationToken) =>
            Denied(Draft.InterceptionPoint.PreModelCall, PreModelResponses.Deny("policy_blocked"));
        public Task<Draft.PostModelHookResponse> OnPostModelCallAsync(Draft.PostModelCallRequest request, CancellationToken cancellationToken) =>
            Denied(Draft.InterceptionPoint.PostModelCall, PostModelResponses.Deny("policy_blocked"));
        public Task<Draft.PreToolHookResponse> OnPreToolCallAsync(Draft.PreToolCallRequest request, CancellationToken cancellationToken) =>
            Denied(Draft.InterceptionPoint.PreToolCall, PreToolResponses.Deny("policy_blocked"));
        public Task<Draft.PostToolHookResponse> OnPostToolCallAsync(Draft.PostToolCallRequest request, CancellationToken cancellationToken) =>
            Denied(Draft.InterceptionPoint.PostToolCall, PostToolResponses.Deny("policy_blocked"));
        public Task<Draft.OutputHookResponse> OnOutputAsync(Draft.OutputRequest request, CancellationToken cancellationToken) =>
            Denied(Draft.InterceptionPoint.Output, OutputResponses.Deny("policy_blocked"));
        public Task<Draft.AgentShutdownHookResponse> OnAgentShutdownAsync(Draft.AgentShutdownRequest request, CancellationToken cancellationToken) =>
            Denied(Draft.InterceptionPoint.AgentShutdown, AgentShutdownResponses.Deny("policy_blocked"));
    }
}
