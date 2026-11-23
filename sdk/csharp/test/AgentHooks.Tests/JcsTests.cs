// Copyright (c) Microsoft. All rights reserved.

using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using AgentHooks.Contracts;
using Xunit;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks.Tests;

public sealed class JcsTests
{
    [Theory]
    [InlineData("-0.0", "0")]
    [InlineData("0.9999999999999999", "0.9999999999999999")]
    [InlineData("1e21", "1e+21")]
    [InlineData("1e20", "100000000000000000000")]
    [InlineData("1e-7", "1e-7")]
    [InlineData("5e-324", "5e-324")]
    [InlineData("9007199254740993.0", "9007199254740992")]
    [InlineData("9.999999999999997e22", "9.999999999999997e+22")]
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
    public void DistinctCloseDecimalsProduceDistinctIdentities()
    {
        static Draft.PreToolCallRequest Make(double n) => new()
        {
            Timestamp = "2026-01-01T00:00:00Z",
            Sequence = 0,
            Agent = new Draft.ContextMetadataAgent { Id = "a", Framework = "x" },
            Session = new Draft.ContextMetadataSession { Id = "s" },
            ToolCall = new Draft.ToolCall
            {
                Id = "tc",
                Name = "t",
                Args = new Draft.JsonObject { ["n"] = JsonSerializer.SerializeToElement(n) },
            },
        };

        Assert.NotEqual(
            Jcs.ContextIdentity(Contract.ToJson(Make(0.9999999999999999))),
            Jcs.ContextIdentity(Contract.ToJson(Make(1.0))));
    }

    [Fact]
    public void DuplicateMembersInParsedJsonNodeFailClosed()
    {
        var duplicate = JsonNode.Parse("{\"x\":1,\"x\":2}");
        Assert.Equal(HostError.ContextInvalid, Assert.Throws<AgentHooksCoreException>(() => Jcs.Canonicalize(duplicate)).Code);

        var nested = JsonNode.Parse("{\"a\":{\"x\":1,\"x\":2}}");
        Assert.Equal(HostError.ContextInvalid, Assert.Throws<AgentHooksCoreException>(() => Jcs.Canonicalize(nested)).Code);
    }

    [Theory]
    [InlineData("\"\\uD800\"")]
    [InlineData("{\"\\uD800\":1}")]
    [InlineData("{\"x\":1,\"x\":2}")]
    [InlineData("1e309")]
    public void ParseRejectsInvalidJsonText(string json) =>
        Assert.Throws<JsonException>(() => Jcs.Parse(json));

    [Fact]
    public void DepthLimitIsConsistentAcrossParseAndCanonicalize()
    {
        static string Nest(int depth) => new string('[', depth) + "0" + new string(']', depth);

        var atLimit = Jcs.Parse(Nest(128));
        Assert.Equal(Nest(128), Jcs.Canonicalize(atLimit));

        Assert.ThrowsAny<JsonException>(() => Jcs.Parse(Nest(129)));
        var tooDeep = JsonNode.Parse(Nest(129), documentOptions: new() { MaxDepth = 256 });
        Assert.Equal(HostError.ContextInvalid, Assert.Throws<AgentHooksCoreException>(() => Jcs.Canonicalize(tooDeep)).Code);
    }

    [Fact]
    public void ContractAndPointsRejectInvalidInputs()
    {
        Assert.Throws<JsonException>(() => Contract.ToJson("not-an-object"));
        Assert.Throws<ArgumentOutOfRangeException>(() => Points.RequestSchema((Draft.InterceptionPoint)99));
        Assert.Throws<ArgumentOutOfRangeException>(() => Points.ResponseSchema((Draft.InterceptionPoint)99));
    }

    [Fact]
    public void LoneSurrogatesFailClosedBeforeSerialization()
    {
        var typed = new Draft.PreToolCallRequest
        {
            Timestamp = "2026-01-01T00:00:00Z",
            Sequence = 0,
            Agent = new Draft.ContextMetadataAgent { Id = "\uD800", Framework = "x" },
            Session = new Draft.ContextMetadataSession { Id = "s" },
            ToolCall = new Draft.ToolCall { Id = "tc", Name = "t", Args = new Draft.JsonObject() },
        };
        Assert.Throws<JsonException>(() => Contract.ToJson(typed));

        var badKey = new Draft.PreToolCallRequest
        {
            Timestamp = "2026-01-01T00:00:00Z",
            Sequence = 0,
            Agent = new Draft.ContextMetadataAgent { Id = "a", Framework = "x" },
            Session = new Draft.ContextMetadataSession { Id = "s" },
            ToolCall = new Draft.ToolCall { Id = "tc", Name = "t", Args = new Draft.JsonObject() },
            Extensions = new Draft.Extensions { ["\uD800"] = JsonSerializer.SerializeToElement(1) },
        };
        Assert.Throws<JsonException>(() => Contract.ToJson(badKey));

        var badExtensionData = new Draft.PreToolCallRequest
        {
            Timestamp = "2026-01-01T00:00:00Z",
            Sequence = 0,
            Agent = new Draft.ContextMetadataAgent { Id = "a", Framework = "x" },
            Session = new Draft.ContextMetadataSession { Id = "s" },
            ToolCall = new Draft.ToolCall { Id = "tc", Name = "t", Args = new Draft.JsonObject() },
            AdditionalProperties = new Dictionary<string, JsonElement> { ["\uDC00"] = JsonSerializer.SerializeToElement(1) },
        };
        Assert.Throws<JsonException>(() => Contract.ToJson(badExtensionData));

        var badOptional = new Draft.ApprovalConfig { Resolver = new Optional<string?>("\uD800") };
        Assert.Throws<JsonException>(() => Contract.ToJson(badOptional));

        var badNodeValue = new JsonObject { ["k"] = "\uD800" };
        Assert.Equal(HostError.ContextInvalid, Assert.Throws<AgentHooksCoreException>(() => Jcs.Canonicalize(badNodeValue)).Code);

        var badNodeKey = new JsonObject { ["\uD800"] = 1 };
        Assert.Equal(HostError.ContextInvalid, Assert.Throws<AgentHooksCoreException>(() => Jcs.Canonicalize(badNodeKey)).Code);
    }

    [Fact]
    public void InvalidEnvelopesFailClosedInContextIdentity()
    {
        static JsonObject ValidBase() => Contract.ToJson(new Draft.PreToolCallRequest
        {
            Timestamp = "2026-01-01T00:00:00Z",
            Sequence = 0,
            Agent = new Draft.ContextMetadataAgent { Id = "a", Framework = "x" },
            Session = new Draft.ContextMetadataSession { Id = "s" },
            ToolCall = new Draft.ToolCall { Id = "tc", Name = "t", Args = new Draft.JsonObject() },
        });

        var missingPoint = ValidBase();
        missingPoint.Remove("interception_point");
        Assert.Equal(HostError.ContextInvalid, Assert.Throws<AgentHooksCoreException>(() => Jcs.ContextIdentity(missingPoint)).Code);

        var unknownPoint = ValidBase();
        unknownPoint["interception_point"] = "not_a_point";
        Assert.Equal(HostError.ContextInvalid, Assert.Throws<AgentHooksCoreException>(() => Jcs.ContextIdentity(unknownPoint)).Code);

        var negativeSequence = ValidBase();
        negativeSequence["sequence"] = -1;
        Assert.Equal(HostError.ContextInvalid, Assert.Throws<AgentHooksCoreException>(() => Jcs.ContextIdentity(negativeSequence)).Code);

        var fractionalSequence = ValidBase();
        fractionalSequence["sequence"] = 1.5;
        Assert.Equal(HostError.ContextInvalid, Assert.Throws<AgentHooksCoreException>(() => Jcs.ContextIdentity(fractionalSequence)).Code);

        var missingToolCall = ValidBase();
        missingToolCall.Remove("tool_call");
        Assert.Equal(HostError.ContextInvalid, Assert.Throws<AgentHooksCoreException>(() => Jcs.ContextIdentity(missingToolCall)).Code);
    }

    [Fact]
    public void TruncateReservesEllipsisBytesWithinLimit()
    {
        var exact = new string('a', 256);
        Assert.Equal(exact, Jcs.Truncate(exact));

        var ascii = Jcs.Truncate(new string('a', 300))!;
        Assert.EndsWith("\u2026", ascii, StringComparison.Ordinal);
        Assert.Equal(256, Encoding.UTF8.GetByteCount(ascii));

        var multibyte = Jcs.Truncate(new string('\u00E9', 150))!;
        Assert.EndsWith("\u2026", multibyte, StringComparison.Ordinal);
        Assert.True(Encoding.UTF8.GetByteCount(multibyte) <= 256);

        var emoji = Jcs.Truncate(string.Concat(Enumerable.Repeat("🌍", 100)))!;
        Assert.EndsWith("\u2026", emoji, StringComparison.Ordinal);
        Assert.True(Encoding.UTF8.GetByteCount(emoji) <= 256);

        Assert.Equal("ab", Jcs.Truncate("abcd", 2));
        Assert.Equal("\u2026", Jcs.Truncate("abcd", 3));
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

    private static readonly JsonArray Golden = LoadGolden();

    public static TheoryData<string> GoldenFixtures() => new(Golden.Where(f => f!["expect"]!["canonical_json"] is not null).Select(f => (string)f!["id"]!));

    /// <summary>Cross-SDK canonical JSON fixtures; their identities are 0.1-shaped (they bind <c>target</c>) and are not asserted.</summary>
    [Theory]
    [MemberData(nameof(GoldenFixtures))]
    public void GoldenCanonicalJson(string id)
    {
        var fixture = Golden.Single(f => (string)f!["id"]! == id)!;
        var expected = (string)fixture["expect"]!["canonical_json"]!;
        if (id == "G-15-rfc8785-numbers")
        {
            // conformance/golden/identity.json was generated by Rust serde_json without float_roundtrip,
            // which mis-rounds 9.999999999999997e+22 to 9.999999999999996e+22; reconcile separately.
            expected = expected.Replace("9.999999999999996e+22", "9.999999999999997e+22", StringComparison.Ordinal);
        }
        Assert.Equal(expected, Jcs.Canonicalize(fixture["ctx"]));
    }

    private static JsonArray LoadGolden([CallerFilePath] string source = "") =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(Path.GetDirectoryName(source)!, "../../../../conformance/golden/identity.json")))!["fixtures"]!.AsArray();
}
