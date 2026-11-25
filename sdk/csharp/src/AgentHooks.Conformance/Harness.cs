// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json.Nodes;

namespace AgentHooks.Conformance;

/// <summary>
/// The CTK harness contract (spec §13.2): a framework integration that drives a scripted scenario through an
/// emitter the runner builds. The runner captures records, identities and control-failure messages itself.
/// </summary>
public interface IHarness
{
    string Name { get; }

    /// <summary>What the host implements; vectors needing other capabilities are skipped.</summary>
    HostSurface Surface { get; }

    Task<RunRecord> RunAsync(Scenario scenario, HookEmitter emitter, CancellationToken cancellationToken = default);
}

public enum RunOutcome { Completed, Blocked, Suspended, Error }

/// <summary>What the harness observed during a run.</summary>
public sealed record RunRecord(RunOutcome Outcome, JsonNode? FinalOutput, IReadOnlyList<JsonObject> ToolInvocations);

public sealed record ToolSpec(string Name, IReadOnlyList<JsonObject> Behavior)
{
    public (JsonNode? Value, bool IsError) Invoke(JsonObject args)
    {
        foreach (var clause in Behavior)
        {
            if (clause["when_args"] is not JsonObject when || JsonNode.DeepEquals(when, args))
                return (clause["return"]?.DeepClone(), (bool?)clause["is_error"] ?? false);
        }
        throw new InvalidOperationException($"tool {Name}: no behavior clause matched {args.ToJsonString()}");
    }
}

public sealed record ModelResponse(JsonNode? Content, JsonArray ToolCalls, string FinishReason);

public sealed record Scenario(JsonObject Input, IReadOnlyDictionary<string, ToolSpec> Tools, IReadOnlyList<ModelResponse> ModelScript)
{
    public static Scenario FromWire(JsonObject wire)
    {
        var tools = (wire["tools"] as JsonArray ?? []).Select(t => t!.AsObject()).ToDictionary(
            t => (string)t["name"]!,
            t => new ToolSpec((string)t["name"]!, t["behavior"]!.AsArray().Select(b => b!.DeepClone().AsObject()).ToList()));
        var script = (wire["model_script"] as JsonArray ?? []).Select(m => m!["respond"]!).Select(r => new ModelResponse(
            r["content"]?.DeepClone(), r["tool_calls"]!.DeepClone().AsArray(), (string)r["finish_reason"]!)).ToList();
        return new(wire["input"]!.DeepClone().AsObject(), tools, script);
    }
}
