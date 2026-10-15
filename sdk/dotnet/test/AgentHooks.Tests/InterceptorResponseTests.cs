// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json.Nodes;
using AgentHooks;
using Xunit;

namespace AgentHooks.Tests;

public sealed class InterceptorResponseTests
{
    private static JsonObject Fixture
    {
        get
        {
            var here = Path.GetDirectoryName(typeof(InterceptorResponseTests).Assembly.Location)!;
            var root = Path.GetFullPath(
                Path.Combine(here, "..", "..", "..", "..", "..", "..", ".."));
            return JsonNode.Parse(
                File.ReadAllText(
                    Path.Combine(
                        root,
                        "conformance",
                        "golden",
                        "interceptor-response.json")))!
                .AsObject();
        }
    }

    [Fact]
    public void SharedResponseFixtures()
    {
        foreach (var item in Fixture["valid"]!.AsArray())
        {
            var response = Canonical.ParseInterceptorResponse(
                item!["input"]!.GetValue<string>());
            var normalized = new JsonObject
            {
                ["verdict"] = response.Verdict.ToWire(),
            };
            if (response.Extensions is not null)
                normalized["extensions"] = response.Extensions.DeepClone();
            Assert.True(
                JsonNode.DeepEquals(
                    normalized,
                    JsonNode.Parse(item["normalized"]!.GetValue<string>())));
            var reparsed = Canonical.ParseInterceptorResponse(response.ToWire());
            Assert.True(JsonNode.DeepEquals(response.ToWire(), reparsed.ToWire()));
        }

        foreach (var item in Fixture["invalid"]!.AsArray())
        {
            var error = Assert.Throws<AgentHooksCoreException>(
                () => Canonical.ParseInterceptorResponse(
                    item!["input"]!.GetValue<string>()));
            Assert.Equal(Fixture["invalid_error"]!.GetValue<string>(), error.Code);
        }
        foreach (var item in Fixture["metadata_bounds"]!.AsArray())
        {
            var value = new JsonObject
            {
                ["verdict"] = new JsonObject { ["decision"] = "allow" },
                ["extensions"] = new JsonObject
                {
                    ["provider"] = new JsonObject
                    {
                        ["receipt"] = new JsonObject { ["p"] = new string('x', item!["padding"]!.GetValue<int>()) },
                    },
                },
            };
            if (item["second_provider"]!.GetValue<bool>())
            {
                value["extensions"]!["second"] = new JsonObject();
            }
            var bytes = System.Text.Encoding.UTF8.GetByteCount(Canonical.Json(value["extensions"]!));
            Assert.Equal(item["bytes"]!.GetValue<int>(), bytes);
            if (item["valid"]!.GetValue<bool>())
                Canonical.ParseInterceptorResponse(value);
            else
            {
                var error = Assert.Throws<AgentHooksCoreException>(
                    () => Canonical.ParseInterceptorResponse(value));
                Assert.Equal(Fixture["invalid_error"]!.GetValue<string>(), error.Code);
            }
        }
    }

    [Fact]
    public void SerializationPrefersBareVerdictWithoutMetadata()
    {
        var response = Canonical.ParseInterceptorResponse(
            JsonNode.Parse("""{"decision":"allow"}""")!);
        Assert.True(
            JsonNode.DeepEquals(
                response.ToWire(),
                JsonNode.Parse("""{"decision":"allow"}""")));
    }
}
