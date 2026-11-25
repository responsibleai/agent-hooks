// Copyright (c) Microsoft. All rights reserved.

using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using AgentHooks.Conformance;
using Xunit;

namespace AgentHooks.Tests;

/// <summary>The draft CTK vectors against the in-tree reference harness.</summary>
[Trait("Category", "draft")]
public sealed class ConformanceTests
{
    private static string VectorsDirectory([CallerFilePath] string source = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(source)!, "../../../../conformance/draft/vectors"));

    /// <summary>The reference harness buffers caller-bound output and does not declare incremental_output (§12.1).</summary>
    private static readonly HashSet<string> CapabilitySkips = ["AH-CTK-110", "AH-CTK-111", "AH-CTK-112", "AH-CTK-113"];

    /// <summary>Vectors whose expectations predate the draft wire and cannot hold for a draft host.</summary>
    private static readonly Dictionary<string, string> Stale = new()
    {
        ["AH-CTK-086"] = "scripts an approve resolution carrying a transform; draft ApproveResolution.verdict is AllowVerdict (§7.6)",
        ["AH-CTK-093"] = "asserts verdict.transform.path in the record; the draft projection drops transform (§10.3)",
        ["AH-CTK-102"] = "a whole-member pre_tool transform over open args cannot fail to apply (§5)",
        ["AH-CTK-103"] = "scripts an approve resolution carrying a transform; draft ApproveResolution.verdict is AllowVerdict (§7.6)",
        ["AH-CTK-122"] = "asserts verdict.transform.path in the record; the draft projection drops transform (§10.3)",
        ["AH-CTK-158"] = "binds every point (no `at`) yet strictly expects no interceptions (§7.7.3)",
    };

    private static readonly Dictionary<string, JsonObject> All =
        Runner.LoadVectors(VectorsDirectory()).ToDictionary(v => (string)v["id"]!, StringComparer.Ordinal);

    public static TheoryData<string> Vectors() => new(All.Keys);

    [Theory]
    [MemberData(nameof(Vectors))]
    public async Task ReferenceHarnessPassesVector(string id)
    {
        var vector = All[id];
        var result = await Runner.RunVectorAsync(new ReferenceHarness(), vector);

        Assert.Equal(CapabilitySkips.Contains(id), result.Skipped);
        if (result.Skipped) return;
        if (Stale.TryGetValue(id, out var reason))
        {
            Assert.False(result.Passed, $"{id} now passes; remove it from the stale list ({reason})");
            return;
        }
        Assert.True(result.Passed, $"[{id}] {result.Title}\n{string.Join("\n", result.Failures.Select(f => $"  - {f}"))}");
    }
}
