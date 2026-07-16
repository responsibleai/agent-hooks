// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// CTK self-test: run all vectors against the in-tree
// ReferenceHarness. Assertion engine is the Rust core; this proves
// the .NET emitter, builder, runner, and harness wire correctly.

using System.Text.Json.Nodes;
using AgentHooks.Conformance;
using Xunit;

namespace AgentHooks.Tests;

public sealed class CtkReferenceTests
{
    private static string VectorsDir()
    {
        var here = Path.GetDirectoryName(typeof(CtkReferenceTests).Assembly.Location)!;
        var root = Path.GetFullPath(Path.Combine(here, "..", "..", "..", "..", "..", "..", ".."));
        return Path.Combine(root, "conformance", "vectors");
    }

    public static IEnumerable<object[]> Vectors() =>
        Runner.LoadVectors(VectorsDir())
              .Select(v => new object[] { (string)v["id"]!, v });

    // Pinned skip set: JsonNode preserves raw numeric tokens,
    // so the .NET reference harness declares every value-domain
    // capability — nothing may skip. An unexpected skip fails; a stale
    // manifest (expected-but-not-skipped) fails the aggregate test.
    private static readonly IReadOnlySet<string> ExpectedSkips = new HashSet<string>();

    [Theory]
    [MemberData(nameof(Vectors))]
    public async Task ReferenceHarnessConformance(string id, JsonObject vector)
    {
        var result = await Runner.RunVectorAsync(new ReferenceHarness(), vector);
        Assert.Equal(id, result.Id);
        if (result.Status == "skip")
        {
            Assert.True(
                ExpectedSkips.Contains(result.Id),
                $"unexpected skip: {result.Id} ({result.Detail}) — update " +
                "ExpectedSkips only with a capability rationale");
            return;
        }
        Assert.True(
            result.Status == "pass",
            $"[{result.Id}] {result.Title}\n" +
            string.Join("\n", result.Failures.Select(f => $"  - {f}")));
    }

    [Fact]
    public async Task SkipSetMatchesManifest()
    {
        var skipped = new HashSet<string>();
        foreach (var v in Runner.LoadVectors(VectorsDir()))
        {
            var result = await Runner.RunVectorAsync(new ReferenceHarness(), v);
            if (result.Status == "skip") skipped.Add(result.Id);
        }
        Assert.True(
            skipped.SetEquals(ExpectedSkips),
            "expected-but-not-skipped vectors mean the manifest is stale: " +
            $"actual=[{string.Join(",", skipped)}]");
    }
}
