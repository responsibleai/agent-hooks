// Copyright (c) Microsoft. All rights reserved.

// CTK self-test: the vectors against the in-tree ReferenceHarness.
// Assertion engine is the Rust core; this proves the .NET emitter,
// builder, runner, and harness wire correctly. The gating run is under
// 0.1, the newest released version: the released set runs and the
// draft-only vectors (introduced_in: draft) are skipped. The
// Category=draft test runs those under the draft in the advisory job.
// Binding tests to a draft revision is #188.

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
        return Path.Combine(root, "conformance", "0.1", "vectors");
    }

    public static IEnumerable<object[]> Vectors() =>
        Runner.LoadVectors(VectorsDir())
              .Select(v => new object[] { (string)v["id"]!, v });

    // Pinned capability skips: JsonNode preserves raw numeric tokens, so
    // the .NET reference harness declares every value-domain capability
    // and no value-domain vector may skip. The streaming/incremental
    // part (§12.1 exception) skips because the reference harness
    // buffers caller-bound output and does not declare
    // incremental_output. An unexpected skip fails; a stale manifest
    // (expected-but-not-skipped) fails the aggregate test.
    private static readonly IReadOnlySet<string> CapabilitySkips = new HashSet<string>
    {
        "AH-CTK-110",
        "AH-CTK-111",
        "AH-CTK-112",
        "AH-CTK-113",
    };

    // The draft-only vectors, skipped under 0.1 with Runner.DraftOnlySkip.
    private static readonly IReadOnlySet<string> DraftOnly =
        Enumerable.Range(144, 17).Select(n => $"AH-CTK-{n}").ToHashSet();

    private static readonly IReadOnlySet<string> ExpectedSkips =
        CapabilitySkips.Union(DraftOnly).ToHashSet();

    [Theory]
    [MemberData(nameof(Vectors))]
    public async Task ReferenceHarnessConformance(string id, JsonObject vector)
    {
        var result = await Runner.RunVectorAsync(new ReferenceHarness(Spec.V01), vector);
        Assert.Equal(id, result.Id);
        if (result.Status == "skip")
        {
            Assert.True(
                ExpectedSkips.Contains(result.Id),
                $"unexpected skip: {result.Id} ({result.Detail}) — update " +
                "CapabilitySkips only with a capability rationale");
            if (DraftOnly.Contains(result.Id)) Assert.Equal(Runner.DraftOnlySkip, result.Detail);
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
        // The SDK runner currently exercises the released 0.1 suite.
        var results = new List<VectorResult>();
        foreach (var v in Runner.LoadVectors(VectorsDir()))
            results.Add(await Runner.RunVectorAsync(new ReferenceHarness(Spec.V01), v));
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
        Assert.True(CapabilitySkips.SetEquals(streaming.Vectors.Select(v => v.Id)));
    }

    [Fact]
    public async Task SkipSetMatchesManifest()
    {
        var skipped = new HashSet<string>();
        foreach (var v in Runner.LoadVectors(VectorsDir()))
        {
            var result = await Runner.RunVectorAsync(new ReferenceHarness(Spec.V01), v);
            if (result.Status == "skip") skipped.Add(result.Id);
        }
        Assert.True(
            skipped.SetEquals(ExpectedSkips),
            "expected-but-not-skipped vectors mean the manifest is stale: " +
            $"actual=[{string.Join(",", skipped)}]");
        var draftOnly = Runner.LoadVectors(VectorsDir())
            .Where(v => (string?)v["introduced_in"] == "draft")
            .Select(v => (string)v["id"]!);
        Assert.True(DraftOnly.SetEquals(draftOnly));
    }

    /// <summary>Advisory (the draft-tests job): the working test set for
    /// the next version passes under the draft.</summary>
    [Fact]
    [Trait("Category", "draft")]
    public async Task DraftOnlyVectorsPassUnderTheDraft()
    {
        var draft = Runner.LoadVectors(VectorsDir())
            .Where(v => (string?)v["introduced_in"] == "draft")
            .ToList();
        Assert.Equal(17, draft.Count);
        foreach (var v in draft)
        {
            var result = await Runner.RunVectorAsync(new ReferenceHarness(Spec.Draft), v);
            Assert.True(
                result.Status == "pass",
                $"[{result.Id}] {result.Status} {result.Detail}\n" +
                string.Join("\n", result.Failures.Select(f => $"  - {f}")));
        }
    }

    private sealed class Nameless : IHarness
    {
        public string Name => "nameless";
        public IReadOnlySet<Capability> Capabilities => new HashSet<Capability>();
        public string Spec => "";
        public void Setup(
            Scenario scenario, IReadOnlyList<IInterceptor> interceptors, IApprovalResolver? resolver,
            EnforcementMode mode, CompositionConfig composition, string? identityProvider,
            IReadOnlyList<string>? redactForApproval = null) =>
            throw new InvalidOperationException("setup must not be reached");
        public Task<RunRecord> RunAsync(CancellationToken ct = default) =>
            throw new InvalidOperationException("run must not be reached");
        public void Teardown() { }
    }

    [Fact]
    public async Task AHarnessNamesTheVersionItBuildsUnder()
    {
        var vector = Runner.LoadVectors(VectorsDir()).First();
        var e = await Assert.ThrowsAsync<ArgumentException>(
            () => Runner.RunVectorAsync(new Nameless(), vector));
        Assert.Contains("harness.Spec must name a supported specification version", e.Message);
    }
}
