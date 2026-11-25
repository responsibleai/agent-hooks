// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json;
using System.Text.Json.Nodes;
using Draft = AgentHooks.Contracts.Draft;
using static AgentHooks.Contracts.Draft.CapabilityExtensions;
using static AgentHooks.Contracts.Draft.OnErrorExtensions;
using static AgentHooks.Contracts.Draft.ToolSeamHostErrorExtensions;

namespace AgentHooks.Conformance;

public sealed record VectorResult(string Id, string Title, string Part, string Status, string Detail, IReadOnlyList<string> Failures)
{
    public bool Passed => Status == "pass";

    public bool Skipped => Status == "skip";
}

/// <summary>The CTK runner (conformance/RUNNER.md): builds the emitter a vector describes, drives a harness, asserts.</summary>
public static class Runner
{
    public static IEnumerable<JsonObject> LoadVectors(string directory)
    {
        var files = Directory.EnumerateFiles(directory, "AH-CTK-*.json").Order(StringComparer.Ordinal).ToList();
        // Zero vectors would read as a 100% pass (§13.2).
        if (files.Count == 0) throw new FileNotFoundException($"no AH-CTK-*.json vectors found in {directory}");
        return files.Select(f => JsonNode.Parse(File.ReadAllText(f))!.AsObject());
    }

    public static async Task<VectorResult> RunVectorAsync(IHarness harness, JsonObject vector, CancellationToken cancellationToken = default)
    {
        VectorResult Result(string status, string detail, IReadOnlyList<string> failures) =>
            new((string)vector["id"]!, (string)vector["title"]!, (string?)vector["part"] ?? "", status, detail, failures);

        var surface = harness.Surface;
        if (CtkEngine.SkipReason(vector, surface.Capabilities.Select(c => c.ToWire())) is { } skip)
            return Result("skip", skip, []);

        var scripts = new Scripts(vector);
        var records = new List<Draft.InterceptionRecord>();
        var messages = new List<string>();
        void Notify(ControlFailureNotice notice)
        {
            lock (messages) messages.Add(notice.Message);
        }
        void Sink(Draft.InterceptionRecord record)
        {
            lock (records) records.Add(record);
        }

        HookEmitter? emitter = null;
        JsonObject? load = null;
        if (vector["host_declaration"] is JsonObject document)
        {
            // §7.7.9: a declaration vector builds through the loader; every construction path must agree.
            var registry = scripts.Registry(surface).OnControlFailure(Notify).WithRecordSink(Sink);
            var (equivalent, pathDetail) = ProvePaths(document, registry);
            load = new JsonObject { ["outcome"] = "accepted", ["paths_equivalent"] = equivalent };
            try
            {
                emitter = HookEmitter.FromDeclaration(document.ToJsonString(), registry);
            }
            catch (DeclarationException e)
            {
                load["outcome"] = "refused";
                load["class"] = e.Code;
                pathDetail = $"{e.Message} {pathDetail}";
            }
            if (pathDetail.Length != 0) load["detail"] = pathDetail.Trim();
        }
        else
        {
            emitter = FromFields(vector, scripts, surface).OnControlFailure(Notify).WithRecordSink(Sink).Build();
        }

        RunRecord run;
        if (emitter is null) run = new(RunOutcome.Error, null, []);
        else
        {
            try { run = await harness.RunAsync(Scenario.FromWire(vector["scenario"]!.AsObject()), emitter, cancellationToken); }
            catch (Exception e) when (e is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                return Result("fail", "", [$"harness.RunAsync raised: {e}"]);
            }
        }

        var wire = new JsonObject
        {
            ["outcome"] = run.Outcome.ToString().ToLowerInvariant(),
            ["final_output"] = run.FinalOutput?.DeepClone(),
            ["tool_invocations"] = new JsonArray(run.ToolInvocations.Select(t => (JsonNode)t.DeepClone()).ToArray()),
            ["records"] = new JsonArray(records.Select(r => (JsonNode)ContractSerializer.Serialize(r)).ToArray()),
            ["postures"] = new JsonObject
            {
                ["tool_seam_host_error"] = surface.ToolSeamPosture.ToWire(),
                ["on_error"] = Draft.OnError.Deny.ToWire(),
            },
            ["host_messages"] = new JsonArray(messages.Select(m => (JsonNode)m).ToArray()),
            ["load"] = load,
        };
        var failures = CtkEngine.Assert(vector, scripts.Recorded, wire);
        return Result(failures.Count == 0 ? "pass" : "fail", "", failures);
    }

    /// <summary>A field-based vector: mode, composition, provider and scripts configure a builder directly.</summary>
    private static HookEmitterBuilder FromFields(JsonObject vector, Scripts scripts, HostSurface surface)
    {
        var builder = HookEmitter.CreateBuilder()
            .WithMode(WireEnum.Parse<Draft.Mode>((string?)vector["mode"], Draft.ModeExtensions.TryParseWire) ?? Draft.Mode.Enforce)
            .WithToolSeamPosture(surface.ToolSeamPosture);
        if (vector["composition"] is JsonObject c)
        {
            builder.WithComposition(
                WireEnum.Parse<Draft.CompositionProfile>((string?)c["profile"], Draft.CompositionProfileExtensions.TryParseWire) ?? Draft.CompositionProfile.SequentialFirstDeny,
                WireEnum.Parse<Draft.OnApproval>((string?)c["on_approval"], Draft.OnApprovalExtensions.TryParseWire) ?? Draft.OnApproval.Stop,
                WireEnum.Parse<Draft.ConflictResolution>((string?)c["on_transform_conflict"], Draft.ConflictResolutionExtensions.TryParseWire) ?? Draft.ConflictResolution.Deny,
                WireEnum.Parse<Draft.ConflictResolution>((string?)c["on_disagreement"], Draft.ConflictResolutionExtensions.TryParseWire) ?? Draft.ConflictResolution.Deny);
        }
        // §10.1: absent selects the default provider; an explicit null leaves records unbound.
        if (vector.TryGetPropertyValue("identity_provider", out var provider))
            builder.WithIdentityProvider((string?)provider switch
            {
                null => null,
                "ctk-fault" => Scripts.FaultingProvider,
                _ => IdentityProvider.JcsSha256,
            });
        foreach (var interceptor in scripts.Interceptors()) builder.Use(interceptor);
        if (scripts.Resolver is { } resolver) builder.WithApprovalResolver(resolver);
        if (scripts.Redactor is { } redactor) builder.WithApprovalRedactor(redactor);
        return builder;
    }

    /// <summary>
    /// §7.7.9: the JSON text, file and typed <see cref="Draft.HostDeclaration"/> paths must resolve to the same
    /// declaration or refuse with the same class. A document the typed model cannot represent skips that path.
    /// </summary>
    public static (bool Equivalent, string Detail) ProvePaths(JsonObject document, HostRegistry registry)
    {
        var text = document.ToJsonString();
        var file = Path.Combine(Path.GetTempPath(), $"ctk-declaration-{Guid.NewGuid():N}.json");
        var outcomes = new List<(string Path, string Key)>
        {
            ("json", Outcome(() => HookEmitter.FromDeclaration(text, registry))),
            ("file", Outcome(() =>
            {
                try
                {
                    File.WriteAllText(file, text);
                    return HookEmitter.FromDeclarationFile(file, registry);
                }
                finally { File.Delete(file); }
            })),
        };
        Draft.HostDeclaration? typed = null;
        try { typed = ContractSerializer.Deserialize<Draft.HostDeclaration>(document); }
        catch (Exception e) when (e is JsonException or InvalidOperationException or NotSupportedException) { }
        if (typed is not null) outcomes.Add(("typed", Outcome(() => HookEmitter.FromDeclaration(typed, registry))));

        return outcomes.All(o => o.Key == outcomes[0].Key)
            ? (true, "")
            : (false, string.Join("; ", outcomes.Select(o => $"{o.Path}: {o.Key}")));

        static string Outcome(Func<HookEmitter> build)
        {
            try { return "ok:" + Jcs.Canonicalize(build().Declaration!); }
            catch (DeclarationException e) { return "err:" + e.Code; }
        }
    }
}
