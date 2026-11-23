// Copyright (c) Microsoft. All rights reserved.

using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks.Tests;

public sealed class JcsTests
{
    [Theory]
    [InlineData("-0.0", "0")]
    [InlineData("1e21", "1e+21")]
    [InlineData("1e20", "100000000000000000000")]
    [InlineData("1e-7", "1e-7")]
    [InlineData("5e-324", "5e-324")]
    [InlineData("9007199254740993.0", "9007199254740994")]
    [InlineData("9.999999999999997e22", "9.999999999999996e+22")]
    public void NumbersUseEcmaScriptFormatting(string json, string expected) =>
        Assert.Equal(expected, Jcs.Canonicalize(JsonNode.Parse(json)));

    [Theory]
    [InlineData("9007199254740992")]
    [InlineData("-18446744073709551616")]
    public void IntegersOutsideTheSafeDomainFailClosed(string json)
    {
        var error = Assert.Throws<AgentHooksCoreException>(() => Jcs.Canonicalize(JsonNode.Parse(json)));
        Assert.Equal(HostError.ContextInvalid, error.Code);
        Assert.DoesNotContain(json, error.Detail);
    }

    [Fact]
    public void IdentityBindsOnlyTheRequiredProjection()
    {
        var request = new Draft.PreToolCallRequest
        {
            Timestamp = "2026-01-01T00:00:00Z",
            Sequence = 0,
            Agent = new Draft.ContextMetadataAgent { Id = "a", Framework = "x", Name = "ignored" },
            Session = new Draft.ContextMetadataSession { Id = "s", StartedAt = "2025-01-01T00:00:00Z" },
            ToolCall = new Draft.ToolCall
            {
                Id = "tc",
                Name = "t",
                Args = new Draft.JsonObject { ["x"] = JsonSerializer.SerializeToElement(1) },
                ContentHash = "sha256:" + new string('0', 64),
            },
            Extensions = new Draft.Extensions { ["host"] = JsonSerializer.SerializeToElement(new { big = 18446744073709551616m }) },
        };

        // An independently computed SHA-256 over the §10.1 required-member preimage.
        Assert.Equal(
            "sha256:8016f23f96d960d3df8db5c868d52536238435af56c29e403eba660c5f3713c5",
            Jcs.ContextIdentity(Contract.ToJson(request)));
    }

    public static TheoryData<string> GoldenFixtures() => new(Golden().Where(f => f!["expect"]!["canonical_json"] is not null).Select(f => (string)f!["id"]!));

    /// <summary>Cross-SDK canonical JSON fixtures; their identities are 0.1-shaped (they bind <c>target</c>) and are not asserted.</summary>
    [Theory]
    [MemberData(nameof(GoldenFixtures))]
    public void GoldenCanonicalJson(string id)
    {
        var fixture = Golden().Single(f => (string)f!["id"]! == id)!;
        Assert.Equal((string)fixture["expect"]!["canonical_json"]!, Jcs.Canonicalize(fixture["ctx"]));
    }

    private static JsonArray Golden([CallerFilePath] string source = "") =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(Path.GetDirectoryName(source)!, "../../../../conformance/golden/identity.json")))!["fixtures"]!.AsArray();
}
