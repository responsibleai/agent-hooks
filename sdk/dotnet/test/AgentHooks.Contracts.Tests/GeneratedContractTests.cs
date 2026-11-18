// Copyright (c) Microsoft. All rights reserved.

using System.Numerics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using AgentHooks.Contracts;
using Draft = AgentHooks.Contracts.Draft;
using Xunit;

namespace AgentHooks.Contracts.Tests;

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
            var type = group == "Verdict" ? VerdictType(path) : ContractType(group);
            yield return [Path.GetRelativePath(ExamplesDirectory(), path), type];
        }
    }

    // Unions are interfaces: AgentContext is IAgentContext.
    private static Type ContractType(string name) =>
        typeof(Draft.IAgentContext).Assembly.GetType($"AgentHooks.Contracts.Draft.{name}")
        ?? typeof(Draft.IAgentContext).Assembly.GetType($"AgentHooks.Contracts.Draft.I{name}", throwOnError: true)!;

    private static Type VerdictType(string path)
    {
        var json = JsonNode.Parse(File.ReadAllText(path))!;
        if (json["decision"]!.GetValue<string>() != "transform") return typeof(Draft.INonTransformVerdict);
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
        // Reflection and the source-generated (trimming/AOT) metadata must agree.
        foreach (var options in new[] { JsonSerializerOptions.Default, Draft.ContractsJsonContext.Default.Options })
        {
            var value = JsonSerializer.Deserialize(json, contract, options);
            Assert.NotNull(value);
            var actual = JsonSerializer.Serialize(value, contract, options);
            Assert.True(JsonNode.DeepEquals(JsonNode.Parse(json), JsonNode.Parse(actual)), actual);
        }
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
            JsonSerializer.Serialize<Draft.ISurface>(new Draft.UnbufferedSurface { ExposureBound = "one token" }));

        // An explicit null is a value of an optional `unknown` member, distinct from omission.
        var declaration = JsonNode.Parse(File.ReadAllText(Path.Combine(ExamplesDirectory(), "HostDeclaration/document-policy.json")))!;
        declaration["bindings"]![0]!["config"] = null;
        var roundTripped = JsonSerializer.Serialize(JsonSerializer.Deserialize<Draft.HostDeclaration>(declaration.ToJsonString()));
        Assert.True(JsonNode.DeepEquals(declaration, JsonNode.Parse(roundTripped)), roundTripped);
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
        var context = Assert.IsType<Draft.PreToolCallRequest>(
            JsonSerializer.Deserialize<Draft.IAgentContext>(json.ToJsonString()));
        Assert.Equal(BigInteger.Parse(integer), context.Sequence);
        Assert.Equal(integer, context.Agent.AdditionalProperties["extra"].GetProperty("nested").GetRawText());
        Assert.Equal(integer, context.ToolCall.Args["n"].GetRawText());
        Assert.True(JsonNode.DeepEquals(json, JsonNode.Parse(JsonSerializer.Serialize<Draft.IAgentContext>(context))));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.Usage>("""{"prompt_tokens":0.5}"""));
    }

    [Fact]
    public void UnionSelectionHonorsOptionalSurfaceDiscriminatorAndLiteralWireValues()
    {
        Assert.IsType<Draft.BufferedSurface>(JsonSerializer.Deserialize<Draft.ISurface>("{}"));
        Assert.IsType<Draft.DenyVerdict>(JsonSerializer.Deserialize<Draft.INonTransformVerdict>(
            """{"reason":"policy","decision":"deny"}"""));
        Assert.IsType<Draft.UnbufferedSurface>(JsonSerializer.Deserialize<Draft.ISurface>(
            """{"buffered_output":false,"exposure_bound":"one token"}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.ISurface>("""{"buffered_output":"false"}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.HostDeclaration>(
            """{"spec":"agent-hooks/0.1","bindings":[]}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.HostDeclaration>("""{"bindings":[]}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.CompositionConfig>("""{"profile":0}"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Draft.CompositionConfig>(
            """{"profile":"SequentialFirstDeny"}"""));
    }
}
