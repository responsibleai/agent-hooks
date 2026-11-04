// Copyright (c) Microsoft. All rights reserved.

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

    // Pinned skip set: JsonNode preserves raw numeric tokens, so the
    // .NET reference harness declares every value-domain capability
    // and no value-domain vector may skip. The streaming/incremental
    // part (§12.1 exception) skips because the reference harness
    // buffers caller-bound output and does not declare
    // incremental_output. An unexpected skip fails; a stale manifest
    // (expected-but-not-skipped) fails the aggregate test.
    private static readonly IReadOnlySet<string> ExpectedSkips = new HashSet<string>
    {
        "AH-CTK-110",
        "AH-CTK-111",
        "AH-CTK-112",
        "AH-CTK-113",
    };

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
    public async Task AReportNamesAReleasedVersionNeverTheDraft()
    {
        // Running the working test set is development; the report a
        // claim attaches names a released version, and the runner
        // refuses the draft.
        var results = new List<VectorResult>();
        foreach (var v in Runner.LoadVectors(VectorsDir()))
            results.Add(await Runner.RunVectorAsync(new ReferenceHarness(), v));
        var refused = Assert.Throws<ArgumentException>(() => Runner.Report(Spec.Draft, results));
        Assert.StartsWith(Runner.DraftNotClaimable, refused.Message);
        Assert.Throws<ArgumentException>(() => Runner.Report("agent-hooks/9.9", results));
        var report = Runner.Report(Spec.V01, results);
        Assert.Equal(Spec.V01, report.Spec);
        Assert.Equal(0, report.Failed);
        Assert.Equal(ExpectedSkips.Count, report.Skipped);
        Assert.Equal(results.Count, report.Passed + report.Skipped);
        var names = report.Parts.Select(p => p.Part).ToList();
        Assert.Equal(names.OrderBy(n => n, StringComparer.Ordinal), names);
        Assert.All(report.Parts, p => Assert.Equal(p.Vectors.Count, p.Passed + p.Failed + p.Skipped));
        var streaming = report.Parts.Single(p => p.Part == "streaming/incremental");
        Assert.Equal(4, streaming.Skipped);
        Assert.True(ExpectedSkips.SetEquals(streaming.Vectors.Select(v => v.Id)));
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
