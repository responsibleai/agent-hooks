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
        var usage = JsonSerializer.Deserialize<Draft.Usage>("{}")!;
        Assert.Null(usage.PromptTokens);
        Assert.Equal("{}", JsonSerializer.Serialize(usage));
    }

    [Theory]
    [InlineData("""{"id":"one","kind":"example.kind"}""", false)]
    [InlineData("""{"id":"one","kind":"example.kind","config":null}""", true)]
    [InlineData("""{"id":"one","kind":"example.kind","config":{"enabled":false}}""", true)]
    public void BindingConfigPreservesPresenceAndArbitraryJson(string json, bool defined)
    {
        var binding = JsonSerializer.Deserialize<Draft.Binding>(json)!;
        Assert.Equal(defined, binding.Config.IsDefined);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(json), JsonNode.Parse(JsonSerializer.Serialize(binding))));
    }

    [Theory]
    [InlineData("{}", false, null)]
    [InlineData("""{"resolver":null}""", true, null)]
    [InlineData("""{"resolver":"human"}""", true, "human")]
    public void OptionalStringsPreserveOmissionNullAndValue(string json, bool defined, string? value)
    {
        var approval = JsonSerializer.Deserialize<Draft.ApprovalConfig>(json)!;
        Assert.Equal(defined, approval.Resolver.IsDefined);
        if (defined) Assert.Equal(value, approval.Resolver.Value);
        Assert.Equal(json, JsonSerializer.Serialize(approval));
    }

    [Fact]
    public void OptionalIntegersRemainLosslessAndRejectFractionalValues()
    {
        const string integer = "1844674407370955161600001";
        var options = new JsonSerializerOptions();
        var value = JsonSerializer.Deserialize<Optional<BigInteger>>(integer, options);
        Assert.Equal(BigInteger.Parse(integer), value.Value);
        Assert.Equal(integer, JsonSerializer.Serialize(value, options));
        var nullable = JsonSerializer.Deserialize<Optional<BigInteger?>>(integer, options);
        Assert.Equal(BigInteger.Parse(integer), nullable.Value);
        Assert.Equal(integer, JsonSerializer.Serialize(nullable, options));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Optional<BigInteger?>>("0.5", options));
    }

    [Fact]
    public void BufferedSurfacePreservesOmissionAndEnforcesItsLiteralDiscriminator()
    {
        Assert.Equal("{}", JsonSerializer.Serialize<Draft.Surface>(new Draft.BufferedSurface()));
        Assert.Equal("""{"buffered_output":false,"exposure_bound":"one token"}""",
            JsonSerializer.Serialize<Draft.Surface>(new Draft.UnbufferedSurface { ExposureBound = "one token" }));
        Assert.Equal("""{"buffered_output":true}""",
            JsonSerializer.Serialize<Draft.Surface>(new Draft.BufferedSurface { BufferedOutput = true }));
        Assert.Throws<JsonException>(() => _ = new Draft.BufferedSurface { BufferedOutput = false });
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<Draft.BufferedSurface>("""{"buffered_output":false}"""));
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<Draft.Surface>("""{"buffered_output":"true"}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.Surface>(
            """{"buffered_output":"false","exposure_bound":"one token"}"""));
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

    [Theory]
    [InlineData(typeof(Draft.IInterceptor), nameof(Draft.IInterceptor.OnAgentStartupAsync), typeof(Draft.AgentStartupRequest), typeof(Draft.AgentStartupHookResponse))]
    [InlineData(typeof(Draft.IInterceptor), nameof(Draft.IInterceptor.OnInputAsync), typeof(Draft.InputRequest), typeof(Draft.InputHookResponse))]
    [InlineData(typeof(Draft.IInterceptor), nameof(Draft.IInterceptor.OnPreModelCallAsync), typeof(Draft.PreModelCallRequest), typeof(Draft.PreModelHookResponse))]
    [InlineData(typeof(Draft.IInterceptor), nameof(Draft.IInterceptor.OnPostModelCallAsync), typeof(Draft.PostModelCallRequest), typeof(Draft.PostModelHookResponse))]
    [InlineData(typeof(Draft.IInterceptor), nameof(Draft.IInterceptor.OnPreToolCallAsync), typeof(Draft.PreToolCallRequest), typeof(Draft.PreToolHookResponse))]
    [InlineData(typeof(Draft.IInterceptor), nameof(Draft.IInterceptor.OnPostToolCallAsync), typeof(Draft.PostToolCallRequest), typeof(Draft.PostToolHookResponse))]
    [InlineData(typeof(Draft.IInterceptor), nameof(Draft.IInterceptor.OnOutputAsync), typeof(Draft.OutputRequest), typeof(Draft.OutputHookResponse))]
    [InlineData(typeof(Draft.IInterceptor), nameof(Draft.IInterceptor.OnAgentShutdownAsync), typeof(Draft.AgentShutdownRequest), typeof(Draft.AgentShutdownHookResponse))]
    [InlineData(typeof(Draft.IApprovalResolver), nameof(Draft.IApprovalResolver.OnResolveAsync), typeof(Draft.ApprovalRequest), typeof(Draft.ApprovalResolution))]
    public void HookMethodsExposeTypedRequestsAndResponses(Type contract, string name, Type request, Type response)
    {
        var method = contract.GetMethod(name);
        Assert.NotNull(method);
        Assert.Equal(typeof(Task<>).MakeGenericType(response), method.ReturnType);
        var parameters = method.GetParameters();
        Assert.Equal(2, parameters.Length);
        Assert.Equal(request, parameters[0].ParameterType);
        Assert.Equal(typeof(CancellationToken), parameters[1].ParameterType);
        Assert.True(parameters[1].HasDefaultValue);
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
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<Draft.Surface>("""{"buffered_output":false}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.Surface>("""{"buffered_output":"false"}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.HostDeclaration>(
            """{"spec":"agent-hooks/0.1","bindings":[]}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.HostDeclaration>("""{"bindings":[]}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.CompositionConfig>("""{"profile":0}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.CompositionConfig>(
            """{"profile":"SequentialFirstDeny"}"""));
    }

    [Theory]
    [InlineData(Draft.InterceptionPoint.AgentStartup, "agent_startup", "AgentStartupRequest", "AgentStartupHookResponse", typeof(Draft.AgentStartupRequest), typeof(Draft.AgentStartupHookResponse), null, null)]
    [InlineData(Draft.InterceptionPoint.Input, "input", "InputRequest", "InputHookResponse", typeof(Draft.InputRequest), typeof(Draft.InputHookResponse), "input", new[] { "input" })]
    [InlineData(Draft.InterceptionPoint.PreModelCall, "pre_model_call", "PreModelCallRequest", "PreModelHookResponse", typeof(Draft.PreModelCallRequest), typeof(Draft.PreModelHookResponse), "messages", new[] { "messages" })]
    [InlineData(Draft.InterceptionPoint.PostModelCall, "post_model_call", "PostModelCallRequest", "PostModelHookResponse", typeof(Draft.PostModelCallRequest), typeof(Draft.PostModelHookResponse), "response", new[] { "response" })]
    [InlineData(Draft.InterceptionPoint.PreToolCall, "pre_tool_call", "PreToolCallRequest", "PreToolHookResponse", typeof(Draft.PreToolCallRequest), typeof(Draft.PreToolHookResponse), "args", new[] { "tool_call", "args" })]
    [InlineData(Draft.InterceptionPoint.PostToolCall, "post_tool_call", "PostToolCallRequest", "PostToolHookResponse", typeof(Draft.PostToolCallRequest), typeof(Draft.PostToolHookResponse), "value", new[] { "tool_result", "value" })]
    [InlineData(Draft.InterceptionPoint.Output, "output", "OutputRequest", "OutputHookResponse", typeof(Draft.OutputRequest), typeof(Draft.OutputHookResponse), "output", new[] { "output" })]
    [InlineData(Draft.InterceptionPoint.AgentShutdown, "agent_shutdown", "AgentShutdownRequest", "AgentShutdownHookResponse", typeof(Draft.AgentShutdownRequest), typeof(Draft.AgentShutdownHookResponse), null, null)]
    public void InterceptionPointsExposeExpectedMetadata(
        Draft.InterceptionPoint point,
        string wireName,
        string requestSchema,
        string responseSchema,
        Type requestType,
        Type responseType,
        string? transformMember,
        string[]? transformPath)
    {
        var metadata = Draft.InterceptionPoints.Get(point);
        Assert.Equal(point, metadata.Point);
        Assert.Equal(wireName, metadata.WireName);
        Assert.Equal(JsonSerializer.Serialize(point), JsonSerializer.Serialize(metadata.WireName));
        Assert.Equal(requestSchema, metadata.RequestSchema);
        Assert.Equal(responseSchema, metadata.ResponseSchema);
        Assert.Equal(requestType, metadata.RequestType);
        Assert.Equal(responseType, metadata.ResponseType);

        if (transformMember is null)
        {
            Assert.Null(metadata.TransformTarget);
        }
        else
        {
            Assert.NotNull(metadata.TransformTarget);
            Assert.Equal(transformMember, metadata.TransformTarget.Member);
            Assert.Equal(transformPath, metadata.TransformTarget.Path);
        }

        Assert.True(Draft.InterceptionPoints.TryGet(point, out var byPoint));
        Assert.Same(metadata, byPoint);
        Assert.True(Draft.InterceptionPoints.TryGetByWireName(wireName, out var byWire));
        Assert.Same(metadata, byWire);
        Assert.True(Draft.InterceptionPoints.TryParse(wireName, out var parsed));
        Assert.Equal(point, parsed);
    }

    [Fact]
    public void InterceptionPointsCoverAllEnumValuesAndRejectInvalidLookups()
    {
        var expected = Enum.GetValues<Draft.InterceptionPoint>();
        Assert.Equal(expected.Length, Draft.InterceptionPoints.All.Length);
        Assert.Equal(expected, Draft.InterceptionPoints.All.Select(m => m.Point));

        var invalid = (Draft.InterceptionPoint)99;
        Assert.Throws<ArgumentOutOfRangeException>(() => Draft.InterceptionPoints.Get(invalid));
        Assert.False(Draft.InterceptionPoints.TryGet(invalid, out var missingByPoint));
        Assert.Null(missingByPoint);

        foreach (var wire in new[] { null, "", "Input", "unknown_point" })
        {
            Assert.False(Draft.InterceptionPoints.TryGetByWireName(wire, out var missingByWire));
            Assert.Null(missingByWire);
            Assert.False(Draft.InterceptionPoints.TryParse(wire, out _));
        }
    }
}
