// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Cross-SDK golden vectors for §10 canonical JSON and context identity.
// Loads conformance/golden/identity.json (generated from the Rust core)
// and asserts the .NET SDK — which delegates to the same core via
// P/Invoke — produces identical output.

using System.Text.Json;
using System.Text.Json.Nodes;
using AgentHooks;
using Xunit;

namespace AgentHooks.Tests;

public sealed class GoldenIdentityTests
{
    private static readonly JsonArray Fixtures = LoadFixtures();

    private static JsonArray LoadFixtures()
    {
        // sdk/dotnet/test/AgentHooks.Tests/ -> repo root
        var here = Path.GetDirectoryName(typeof(GoldenIdentityTests).Assembly.Location)!;
        var root = Path.GetFullPath(Path.Combine(here, "..", "..", "..", "..", "..", "..", ".."));
        var doc = JsonNode.Parse(
            File.ReadAllText(Path.Combine(root, "conformance", "golden", "identity.json")))!;
        return doc["fixtures"]!.AsArray();
    }

    public static IEnumerable<object[]> Cases() =>
        Fixtures.Select(f => new object[] { (string)f!["id"]!, f });

    [Theory]
    [MemberData(nameof(Cases))]
    public void CanonicalJson(string id, JsonNode f)
    {
        _ = id;
        if (f["expect"]!["error"] is not null) return; // asserted via identity
        var got = Canonical.Json(f["ctx"]);
        Assert.Equal((string)f["expect"]!["canonical_json"]!, got);
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void ContextIdentity(string id, JsonNode f)
    {
        _ = id;
        var ctx = new AgentContext((JsonObject)f["ctx"]!.DeepClone());
        if (f["expect"]!["error"] is not null)
        {
            // §10.2: out-of-domain contexts fail closed — never a
            // real-looking identity.
            var ex = Assert.Throws<AgentHooksCoreException>(
                () => Canonical.ContextIdentity(ctx));
            Assert.Contains("context_invalid", ex.Code);
            return;
        }
        var got = Canonical.ContextIdentity(ctx);
        Assert.Equal((string)f["expect"]!["context_identity"]!, got);
    }

    [Fact]
    public void L2L3Stripped()
    {
        var byId = Fixtures.ToDictionary(f => (string)f!["id"]!, f => f!);
        Assert.Equal(
            (string)byId["G-05-l2-l3-stripped"]["expect"]!["context_identity"]!,
            (string)byId["G-05b-l2-l3-baseline"]["expect"]!["context_identity"]!);
    }
}
