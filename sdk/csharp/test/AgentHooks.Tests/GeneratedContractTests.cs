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

    [Fact]
    public void GeneratedHookInterfacesUseSuggestedMethodNamesAndTypedResponses()
    {
        var interceptorMethods = typeof(Draft.IInterceptor).GetMethods()
            .ToDictionary(method => method.Name, method => method.ReturnType);
        Assert.Equal(
            new Dictionary<string, Type>
            {
                [nameof(Draft.IInterceptor.AgentStartingAsync)] = typeof(Task<Draft.AgentStartupHookResponse>),
                [nameof(Draft.IInterceptor.InputReceivedAsync)] = typeof(Task<Draft.InputHookResponse>),
                [nameof(Draft.IInterceptor.ModelCallingAsync)] = typeof(Task<Draft.PreModelHookResponse>),
                [nameof(Draft.IInterceptor.ModelCalledAsync)] = typeof(Task<Draft.PostModelHookResponse>),
                [nameof(Draft.IInterceptor.ToolCallingAsync)] = typeof(Task<Draft.PreToolHookResponse>),
                [nameof(Draft.IInterceptor.ToolCalledAsync)] = typeof(Task<Draft.PostToolHookResponse>),
                [nameof(Draft.IInterceptor.OutputSendingAsync)] = typeof(Task<Draft.OutputHookResponse>),
                [nameof(Draft.IInterceptor.AgentStoppingAsync)] = typeof(Task<Draft.AgentShutdownHookResponse>),
            },
            interceptorMethods);

        var resolverMethods = typeof(Draft.IApprovalResolver).GetMethods();
        var resolveApproval = Assert.Single(resolverMethods);
        Assert.Equal(nameof(Draft.IApprovalResolver.ResolveApprovalAsync), resolveApproval.Name);
        Assert.Equal(typeof(Task<Draft.ApprovalResolution>), resolveApproval.ReturnType);
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
}
