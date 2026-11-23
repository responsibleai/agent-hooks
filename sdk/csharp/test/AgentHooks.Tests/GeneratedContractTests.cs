// Copyright (c) Microsoft. All rights reserved.

using System.Numerics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using AgentHooks.Contracts;
using Draft = AgentHooks.Contracts.Draft;
using Xunit;

namespace AgentHooks.Tests;

[Trait("Category", "draft")]
public sealed class GeneratedContractTests
{
    private static string ExamplesDirectory([CallerFilePath] string source = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(source)!, "../../../../spec/draft/schema/examples"));

    public static IEnumerable<object[]> Examples()
    {
        foreach (var path in Directory.EnumerateFiles(ExamplesDirectory(), "*.json", SearchOption.AllDirectories).Order())
        {
            var group = Path.GetFileName(Path.GetDirectoryName(path))!;
            var type = group == "Verdict" ? VerdictType(path) :
                typeof(Draft.AgentContext).Assembly.GetType($"AgentHooks.Contracts.Draft.{group}", throwOnError: true)!;
            yield return [Path.GetRelativePath(ExamplesDirectory(), path), type];
        }
    }

    private static Type VerdictType(string path)
    {
        var json = JsonNode.Parse(File.ReadAllText(path))!;
        if (json["decision"]!.GetValue<string>() != "transform") return typeof(Draft.NonTransformVerdict);
        return json["transform"]!.AsObject().Single().Key switch
        {
            "input" => typeof(Draft.TransformVerdictInputHookTransform),
            "messages" => typeof(Draft.TransformVerdictPreModelHookTransform),
            "response" => typeof(Draft.TransformVerdictPostModelHookTransform),
            "args" => typeof(Draft.TransformVerdictPreToolHookTransform),
            "value" => typeof(Draft.TransformVerdictPostToolHookTransform),
            "output" => typeof(Draft.TransformVerdictOutputHookTransform),
            var key => throw new InvalidOperationException($"Unexpected transform example: {key}"),
        };
    }

    [Theory]
    [MemberData(nameof(Examples))]
    public void SpecExamplesRoundTripWithoutChangingWireShape(string example, Type contract)
    {
        var json = File.ReadAllText(Path.Combine(ExamplesDirectory(), example));
        var value = JsonSerializer.Deserialize(json, contract);
        Assert.NotNull(value);
        var actual = JsonSerializer.Serialize(value, contract);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(json), JsonNode.Parse(actual)), actual);
    }

    [Fact]
    public void OptionalValuesPreserveOmissionNullFalseAndZero()
    {
        var timeouts = JsonSerializer.Deserialize<Draft.TimeoutsConfig>("""{"interceptor_ms":null}""")!;
        Assert.True(timeouts.InterceptorMs.IsDefined);
        Assert.Null(timeouts.InterceptorMs.Value);
        Assert.False(timeouts.ApprovalResolverMs.IsDefined);
        Assert.Throws<InvalidOperationException>(() => timeouts.ApprovalResolverMs.Value);
        Assert.Equal("""{"interceptor_ms":null}""", JsonSerializer.Serialize(timeouts));

        timeouts.InterceptorMs = new BigInteger(5000);
        Assert.Equal("""{"interceptor_ms":5000}""", JsonSerializer.Serialize(timeouts));
        Assert.Equal("""{"prompt_tokens":0}""",
            JsonSerializer.Serialize(JsonSerializer.Deserialize<Draft.Usage>("""{"prompt_tokens":0}""")));
        Assert.Equal("""{"buffered_output":false,"exposure_bound":"one token"}""",
            JsonSerializer.Serialize<Draft.Surface>(new Draft.UnbufferedSurface { ExposureBound = "one token" }));
    }

    [Fact]
    public void HookResponsesExposeTheirTypedTransformAndRejectUnsupportedDecisions()
    {
        var response = JsonSerializer.Deserialize<Draft.InputHookResponse>(
            """{"verdict":{"decision":"transform","transform":{"input":{"role":"user","content":["redacted"]}}}}""")!;
        var transform = Assert.IsType<Draft.TransformVerdictInputHookTransform>(response.Verdict);
        Assert.Equal(Draft.InputRole.User, transform.Transform.Input.Role);
        Assert.Equal("redacted", transform.Transform.Input.Content[0].GetString());
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.AgentStartupHookResponse>(
            """{"verdict":{"decision":"transform","transform":{}}}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.InputHookResponse>(
            """{"verdict":{"decision":"warn"}}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.InputHookResponse>(
            """{"verdict":{"decision":"allow","transform":{}}}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.InputHookResponse>("{}"));
    }

    [Fact]
    public void IntegersAndOpenMetadataAreLossless()
    {
        var json = JsonNode.Parse(File.ReadAllText(Path.Combine(ExamplesDirectory(), "AgentContext/pre-tool-call.json")))!;
        const string integer = "1844674407370955161600001";
        json["sequence"] = JsonNode.Parse(integer);
        json["agent"]!["extra"] = new JsonObject { ["nested"] = JsonNode.Parse(integer) };
        json["tool_call"]!["args"] = new JsonObject { ["n"] = JsonNode.Parse(integer), ["empty"] = null };
        var context = Assert.IsType<Draft.PreToolCallContext>(
            JsonSerializer.Deserialize<Draft.AgentContext>(json.ToJsonString()));
        Assert.Equal(BigInteger.Parse(integer), context.Sequence);
        Assert.Equal(integer, context.Agent.AdditionalProperties["extra"].GetProperty("nested").GetRawText());
        Assert.Equal(integer, context.ToolCall.Args["n"].GetRawText());
        Assert.True(JsonNode.DeepEquals(json, JsonNode.Parse(JsonSerializer.Serialize<Draft.AgentContext>(context))));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.Usage>("""{"prompt_tokens":0.5}"""));
    }

    [Fact]
    public void UnionSelectionHonorsOptionalSurfaceDiscriminatorAndLiteralWireValues()
    {
        Assert.IsType<Draft.BufferedSurface>(JsonSerializer.Deserialize<Draft.Surface>("{}"));
        Assert.IsType<Draft.UnbufferedSurface>(JsonSerializer.Deserialize<Draft.Surface>(
            """{"buffered_output":false,"exposure_bound":"one token"}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.Surface>("""{"buffered_output":"false"}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.HostDeclaration>(
            """{"spec":"agent-hooks/0.1","bindings":[]}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.HostDeclaration>("""{"bindings":[]}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.CompositionConfig>("""{"profile":0}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.CompositionConfig>(
            """{"profile":"SequentialFirstDeny"}"""));
    }

    [Theory]
    [InlineData(typeof(Draft.AgentStartupHookHandler), typeof(Draft.AgentStartupRequest), typeof(Draft.AgentStartupHookResponse))]
    [InlineData(typeof(Draft.InputHookHandler), typeof(Draft.InputRequest), typeof(Draft.InputHookResponse))]
    [InlineData(typeof(Draft.PreModelHookHandler), typeof(Draft.PreModelCallRequest), typeof(Draft.PreModelHookResponse))]
    [InlineData(typeof(Draft.PostModelHookHandler), typeof(Draft.PostModelCallRequest), typeof(Draft.PostModelHookResponse))]
    [InlineData(typeof(Draft.PreToolHookHandler), typeof(Draft.PreToolCallRequest), typeof(Draft.PreToolHookResponse))]
    [InlineData(typeof(Draft.PostToolHookHandler), typeof(Draft.PostToolCallRequest), typeof(Draft.PostToolHookResponse))]
    [InlineData(typeof(Draft.OutputHookHandler), typeof(Draft.OutputRequest), typeof(Draft.OutputHookResponse))]
    [InlineData(typeof(Draft.AgentShutdownHookHandler), typeof(Draft.AgentShutdownRequest), typeof(Draft.AgentShutdownHookResponse))]
    [InlineData(typeof(Draft.ApprovalResolverHandler), typeof(Draft.ApprovalRequest), typeof(Draft.ApprovalResolution))]
    public void HandlerSignaturesPairEachRequestWithItsResponse(Type handler, Type request, Type response)
    {
        Assert.True(typeof(Delegate).IsAssignableFrom(handler));
        var invoke = handler.GetMethod("Invoke")!;
        Assert.Equal(typeof(Task<>).MakeGenericType(response), invoke.ReturnType);
        var parameters = invoke.GetParameters();
        Assert.Equal(2, parameters.Length);
        Assert.Equal(request, parameters[0].ParameterType);
        Assert.Equal(typeof(CancellationToken), parameters[1].ParameterType);
        Assert.True(parameters[1].HasDefaultValue);
    }

    [Fact]
    public async Task HookHandlerReturnsTypedEnvelopeAndPropagatesCancellation()
    {
        var request = JsonSerializer.Deserialize<Draft.PreToolCallRequest>(
            File.ReadAllText(Path.Combine(ExamplesDirectory(), "AgentContext/pre-tool-call.json")))!;
        using var cancellation = new CancellationTokenSource();
        Draft.PreToolHookHandler handler = async (context, cancellationToken) =>
        {
            await Task.Yield();
            Assert.Same(request, context);
            Assert.Equal(cancellation.Token, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            return new Draft.PreToolHookResponse
            {
                Verdict = new Draft.TransformVerdictPreToolHookTransform
                {
                    Transform = new Draft.PreToolHookTransform { Args = context.ToolCall.Args },
                },
            };
        };

        var response = await handler(request, cancellation.Token);
        var transform = Assert.IsType<Draft.TransformVerdictPreToolHookTransform>(response.Verdict);
        Assert.Equal(request.ToolCall.Args["query"], transform.Transform.Args["query"]);
        Assert.Equal("transform", JsonNode.Parse(JsonSerializer.Serialize(response))!["verdict"]!["decision"]!.GetValue<string>());
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await handler(request, cancellation.Token));
    }

    [Fact]
    public async Task ApprovalHandlerReturnsResolutionEnvelopeWithEchoedIdentity()
    {
        var request = JsonSerializer.Deserialize<Draft.ApprovalRequest>(
            File.ReadAllText(Path.Combine(ExamplesDirectory(), "ApprovalRequest/collection-access.json")))!;
        request.ContextIdentity = "sha256:consulted-context";
        Draft.ApprovalResolverHandler resolver = (context, _) =>
            Task.FromResult<Draft.ApprovalResolution>(new Draft.ApproveResolution
            {
                ContextIdentity = context.ContextIdentity,
                Verdict = new Draft.AllowVerdict(),
            });

        var result = Assert.IsType<Draft.ApproveResolution>(await resolver(request));
        Assert.Equal(request.ContextIdentity, result.ContextIdentity);
        var wire = JsonNode.Parse(JsonSerializer.Serialize<Draft.ApprovalResolution>(result))!;
        Assert.Equal("approve", wire["outcome"]!.GetValue<string>());
        Assert.Equal("allow", wire["verdict"]!["decision"]!.GetValue<string>());
    }
}
