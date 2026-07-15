// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// CTK runner: load vectors, drive an IHarness, assert `expect`.
//
// The assertion engine, capability skip check, and scripted
// interceptor/resolver evaluation live in the Rust core (Native.Ctk*).
// This class keeps only vector globbing, the harness setup/run/teardown
// orchestration (native callbacks), and RunRecord marshalling.
// See conformance/RUNNER.md.

using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentHooks.Conformance;

public sealed record VectorResult(
    string Id, string Title, string Status,
    string Detail, IReadOnlyList<string> Failures);

public static class Runner
{
    private static readonly JsonSerializerOptions Compact = new() { WriteIndented = false };

    public static IEnumerable<JsonObject> LoadVectors(string directory)
    {
        var files = Directory.EnumerateFiles(directory, "AH-CTK-*.json").OrderBy(p => p).ToList();
        if (files.Count == 0)
            // A runner fed zero vectors reports 100% pass — a false
            // conformance signal (§13.2). Fail loudly instead.
            throw new FileNotFoundException($"no AH-CTK-*.json vectors found in {directory}");
        foreach (var f in files)
            yield return (JsonObject)JsonNode.Parse(File.ReadAllText(f))!;
    }

    public static async Task<VectorResult> RunVectorAsync(
        IHarness harness, JsonObject vector, CancellationToken ct = default)
    {
        var id = (string)vector["id"]!;
        var title = (string)vector["title"]!;
        var vectorJson = vector.ToJsonString(Compact);

        // Capability skip via core.
        var caps = new JsonArray(
            harness.Capabilities.Select(c => (JsonNode)c.ToWireName()).ToArray());
        var skip = JsonNode.Parse(
            Native.CtkShouldSkip(vectorJson, caps.ToJsonString(Compact)));
        if (skip is JsonValue sv && sv.TryGetValue(out string? reason))
            return new VectorResult(id, title, "skip", reason!, []);

        var scenario = Scenario.FromWire((JsonObject)vector["scenario"]!);

        // Multi-interceptor vectors (§7.1 fold-through) use
        // interceptor_scripts; single-interceptor vectors use
        // interceptor_script. Only the FIRST interceptor records:
        // expect.interceptions describes each emission as the
        // first-registered interceptor saw it. An empty
        // interceptor_scripts registers zero interceptors (§7
        // fail-closed vector).
        List<JsonArray> scripts;
        if (vector["interceptor_scripts"] is JsonArray multi)
            scripts = multi.Select(s => (JsonArray)s!.DeepClone()).ToList();
        else
            scripts = [(JsonArray)(vector["interceptor_script"] ?? new JsonArray()).DeepClone()];

        var recorded = new List<JsonObject>();
        var interceptors = new List<IInterceptor>();
        if (scripts.Count > 0)
        {
            interceptors.Add(new RecordingScriptedInterceptor(
                scripts[0].ToJsonString(Compact), recorded));
            foreach (var s in scripts.Skip(1))
                interceptors.Add(new ScriptedInterceptor(s.ToJsonString(Compact)));
        }

        var approval = vector["approval_script"] as JsonArray;
        IApprovalResolver? resolver = approval is { Count: > 0 }
            ? new ScriptedResolver(approval.ToJsonString(Compact))
            : null;

        var mode = (string?)vector["mode"] == "evaluate_only"
            ? EnforcementMode.EvaluateOnly : EnforcementMode.Enforce;

        // §13.2: composition vectors carry the profile/knobs they apply
        // to; absent means the pre-P-003 default.
        var composition = vector["composition"] is JsonObject co
            ? CompositionConfig.FromWire(co)
            : CompositionConfig.Default;

        // §10.1: absent → the default provider; explicit null → unbound.
        var identityProvider = vector.ContainsKey("identity_provider")
            ? (string?)vector["identity_provider"]
            : Spec.JcsSha256;

        var redactForApproval = vector["redact_for_approval"] is JsonArray ra
            ? ra.Select(n => (string)n!).ToList()
            : [];

        harness.Setup(
            scenario, interceptors, resolver, mode, composition, identityProvider,
            redactForApproval);
        RunRecord rr;
        try
        {
            rr = await harness.RunAsync(ct);
        }
        catch (Exception e)
        {
            return new VectorResult(id, title, "fail", "",
                [$"harness.RunAsync raised: {e}"]);
        }
        finally
        {
            harness.Teardown();
        }

        var recordedJson = new JsonArray(
            recorded.Select(c => (JsonNode)c).ToArray()).ToJsonString(Compact);
        var rrJson = RunRecordToWire(rr);
        var result = (JsonObject)JsonNode.Parse(
            Native.CtkAssert(vectorJson, recordedJson, rrJson))!;
        return new VectorResult(
            (string)result["id"]!,
            (string)result["title"]!,
            (string)result["status"]!,
            (string?)result["detail"] ?? "",
            (result["failures"] as JsonArray)?.Select(n => (string)n!).ToList() ?? []);
    }

    private static string RunRecordToWire(RunRecord rr)
    {
        var identities = new JsonArray();
        foreach (var (i, e) in rr.Identities ?? [])
            identities.Add(new JsonObject
            {
                ["input_identity"] = i,
                ["enforced_identity"] = e,
            });
        var records = new JsonArray(
            (rr.Records ?? []).Select(r => (JsonNode)r.DeepClone()).ToArray());
        var o = new JsonObject
        {
            ["outcome"] = rr.Outcome.ToWireName(),
            ["final_output"] = rr.FinalOutput?.DeepClone(),
            ["tool_invocations"] = new JsonArray(
                rr.ToolInvocations.Select(t => (JsonNode)t.DeepClone()).ToArray()),
            ["error"] = rr.Error,
            ["identities"] = identities,
            ["records"] = records,
        };
        return o.ToJsonString(Compact);
    }

    /// <summary>A §5-invalid verdict shape (transform decision, no body)
    /// used to surface scripted stale wire vocabulary through the §5 gate
    /// (fail closed into <c>host_error:verdict_invalid</c>).</summary>
    private static Verdict InvalidVerdict() => new(Decision.Transform);

    /// <summary>Replays one interceptor rule list via the Rust core.</summary>
    private class ScriptedInterceptor(string rulesJson) : IInterceptor
    {
        protected readonly string RulesJson = rulesJson;

        public virtual ValueTask<Verdict> InterceptAsync(
            AgentContext ctx, CancellationToken ct = default)
        {
            var w = (JsonObject)JsonNode.Parse(
                Native.CtkScriptedIntercept(RulesJson, ctx.Json.ToJsonString(Compact)))!;
            if (w.ContainsKey("__ctk_fault__"))
            {
                if ((string?)w["__ctk_fault__"] == "mutate")
                {
                    // §7 isolation fault (TM-05): tamper with the received
                    // context in-place; the emitter's copy isolation must
                    // keep enforcement, identity, and siblings unaffected.
                    ctx.Json["target"] = "TAMPERED";
                    if (ctx.Json["tool_call"] is JsonObject tc)
                        tc["args"] = new JsonObject { ["tampered"] = true };
                    return ValueTask.FromResult(
                        new Verdict(Decision.Allow) { Reason = "ctk:mutated" });
                }
                // NOW-10 fault injection: exercise §6.3 interceptor_failed.
                throw new InvalidOperationException("ctk scripted fault: raise");
            }
            try
            {
                return ValueTask.FromResult(Verdict.FromWire(w));
            }
            catch (ArgumentOutOfRangeException)
            {
                // TODO(stage-4): pre-P-003 vectors still script `warn` /
                // `escalate`; the closed set is three (§5.1), so the
                // stale shape fails the §5 gate (fail closed).
                return ValueTask.FromResult(InvalidVerdict());
            }
        }
    }

    /// <summary>Records every ctx (deep copy) then replays the rules.</summary>
    private sealed class RecordingScriptedInterceptor(
        string rulesJson, List<JsonObject> recorded) : ScriptedInterceptor(rulesJson)
    {
        public override ValueTask<Verdict> InterceptAsync(
            AgentContext ctx, CancellationToken ct = default)
        {
            recorded.Add((JsonObject)ctx.Json.DeepClone());
            return base.InterceptAsync(ctx, ct);
        }
    }

    /// <summary>Replays the vector's approval_script via the Rust core.</summary>
    private sealed class ScriptedResolver(string rulesJson) : IApprovalResolver
    {
        public ValueTask<ApprovalResolution> ResolveAsync(
            ApprovalRequest req, CancellationToken ct = default)
        {
            // §10.1: identity may be null (null provider). The scripted
            // engine works in strings; "" round-trips to null below.
            var r = (JsonObject)JsonNode.Parse(
                Native.CtkScriptedResolve(
                    rulesJson, req.Context.Json.ToJsonString(Compact),
                    req.ContextIdentity ?? ""))!;
            if (r.ContainsKey("__ctk_fault__"))
            {
                // NOW-10 fault injection: exercise §9 approval_resolver_failed.
                throw new InvalidOperationException("ctk scripted fault: raise");
            }
            var outcome = (string)r["outcome"]! switch
            {
                "approve" => ApprovalOutcome.Approve,
                "reject" => ApprovalOutcome.Reject,
                _ => ApprovalOutcome.Unresolved,
            };
            Verdict? v;
            try
            {
                v = r["verdict"] is JsonObject vw ? Verdict.FromWire(vw) : null;
            }
            catch (ArgumentOutOfRangeException)
            {
                // TODO(stage-4): stale wire vocabulary fails the §5 gate.
                v = InvalidVerdict();
            }
            var echoed = (string?)r["context_identity"] ?? "";
            return ValueTask.FromResult(new ApprovalResolution(
                outcome,
                echoed.Length == 0 && req.ContextIdentity is null ? null : echoed,
                v));
        }
    }
}
