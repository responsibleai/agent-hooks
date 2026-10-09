// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Conformance Test Kit harness contract (§13.2).
//
// The CTK engine (scripted interceptor/resolver, capability skip,
// assertion pass) lives in the Rust core and is exposed via
// Native.Ctk*. This assembly provides the per-language glue: the
// IHarness contract framework authors implement, a Runner that drives
// it, and a ReferenceHarness for CTK self-test.

using System.Text.Json.Nodes;

namespace AgentHooks.Conformance;

/// <summary>Host-declared capability subset (§3.2, §13.1). The wire
/// names are the closed list the vector schema and the host
/// declaration surface share (§7.7.4).</summary>
public enum Capability
{
    ModelCalls,
    ToolCalls,
    ParallelToolCalls,
    Streaming,
    MultiTurn,
    Int64Json,
    BigintJson,
    IncrementalOutput,
    HostDeclaration,
}

public static class CapabilityExtensions
{
    public static string ToWireName(this Capability c) => c switch
    {
        Capability.ModelCalls => "model_calls",
        Capability.ToolCalls => "tool_calls",
        Capability.ParallelToolCalls => "parallel_tool_calls",
        Capability.Streaming => "streaming",
        Capability.MultiTurn => "multi_turn",
        // The harness language can hold >2^53 integers from vector JSON
        // losslessly (§4.4). JavaScript harnesses omit this.
        Capability.Int64Json => "int64_json",
        Capability.BigintJson => "bigint_json",
        // §12.1 exception: the host mediates post_model_call
        // incrementally and declares buffered_output: false.
        Capability.IncrementalOutput => "incremental_output",
        // §7.7.9: the host builds its emitter from a host declaration
        // document through the loader.
        Capability.HostDeclaration => "host_declaration",
        _ => throw new ArgumentOutOfRangeException(nameof(c)),
    };
}

public enum RunOutcome { Completed, Blocked, Suspended, Error }

public static class RunOutcomeExtensions
{
    public static string ToWireName(this RunOutcome o) => o switch
    {
        RunOutcome.Completed => "completed",
        RunOutcome.Blocked => "blocked",
        RunOutcome.Suspended => "suspended",
        RunOutcome.Error => "error",
        _ => throw new ArgumentOutOfRangeException(nameof(o)),
    };
}

/// <summary>One scripted mock-tool.</summary>
public sealed record ToolSpec(string Name, IReadOnlyList<JsonObject> Behavior)
{
    /// <summary>First matching behaviour clause wins.</summary>
    public (JsonNode? Value, bool IsError) Invoke(JsonObject args)
    {
        foreach (var b in Behavior)
        {
            var when = b["when_args"] as JsonObject;
            if (when is null || JsonNode.DeepEquals(when, args))
                return (b["return"]?.DeepClone(),
                        (bool?)b["is_error"] ?? false);
        }
        throw new InvalidOperationException(
            $"tool {Name!}: no behaviour clause matched {args.ToJsonString()}");
    }
}

/// <summary>One scripted model response.</summary>
public sealed record ModelResponse(
    JsonNode? Content, JsonArray ToolCalls, string FinishReason);

/// <summary>Hermetic scripted run loaded from a CTK vector.</summary>
public sealed record Scenario(
    JsonObject Input,
    IReadOnlyDictionary<string, ToolSpec> Tools,
    IReadOnlyList<ModelResponse> ModelScript)
{
    public static Scenario FromWire(JsonObject o)
    {
        var tools = new Dictionary<string, ToolSpec>();
        foreach (var t in (o["tools"] as JsonArray) ?? [])
        {
            var to = (JsonObject)t!;
            var behavior = ((JsonArray)to["behavior"]!)
                .Select(b => (JsonObject)b!.DeepClone()).ToList();
            tools[(string)to["name"]!] = new ToolSpec((string)to["name"]!, behavior);
        }
        var script = new List<ModelResponse>();
        foreach (var m in (o["model_script"] as JsonArray) ?? [])
        {
            var r = (JsonObject)m!["respond"]!;
            script.Add(new ModelResponse(
                r["content"]?.DeepClone(),
                (JsonArray)r["tool_calls"]!.DeepClone(),
                (string)r["finish_reason"]!));
        }
        return new Scenario((JsonObject)o["input"]!.DeepClone(), tools, script);
    }
}

/// <summary>What <see cref="IHarness.RunAsync"/> returns to the CTK runner.
/// Identity pairs are <c>null</c>-valued when the identity provider is
/// <c>null</c> (§10.1).</summary>
public sealed record RunRecord(
    RunOutcome Outcome,
    JsonNode? FinalOutput,
    IReadOnlyList<JsonObject> ToolInvocations,
    string? Error = null,
    IReadOnlyList<(string? InputIdentity, string? EnforcedIdentity)>? Identities = null,
    IReadOnlyList<JsonObject>? Records = null);

/// <summary>The single interface a framework adapter implements for the CTK.</summary>
public interface IHarness
{
    string Name { get; }
    IReadOnlySet<Capability> Capabilities { get; }

    /// <summary>Declared §6.2 posture at the tool seam (§13.1): what the
    /// host does with the run after a <c>host_error:*</c> deny at
    /// <c>pre_tool_call</c>/<c>post_tool_call</c>. <c>"continue"</c> (the
    /// default — surface a tool error to the model and keep the loop
    /// going) or <c>"terminate"</c> (the host's own semantics terminate
    /// the turn, which §6.2 explicitly permits). The runner forwards this
    /// declaration so <c>expect.run_outcome_by_posture</c> vectors resolve
    /// to the single outcome this surface must produce.</summary>
    string ToolSeamHostError => "continue";

    /// <summary>The code surface (§7.7.4) a declaration is resolved
    /// against. The default derives it from <see cref="Capabilities"/>
    /// and <see cref="ToolSeamHostError"/>: the §3.2 floor plus the model
    /// points iff <c>model_calls</c> plus the tool points iff
    /// <c>tool_calls</c>, every profile with every knob value, this SDK's
    /// timeout support and every accepted contract version. A host
    /// declaring <c>incremental_output</c> overrides this to add its
    /// exposure bound (<see cref="AgentHooks.HostSurface.WithExposureBound"/>);
    /// the derived surface alone is refused for such a host.</summary>
    HostSurface HostSurface => AgentHooks.HostSurface.FromCapabilities(
        Capabilities.Select(c => c.ToWireName()),
        ToolSeamHostError == "terminate" ? ToolSeamPosture.Terminate : ToolSeamPosture.Continue);

    /// <summary>The host's own declaration document (§7.7.9), when it
    /// has one. The runner resolves it against <see cref="HostSurface"/>
    /// and reads the capabilities and posture a run is assessed against
    /// from the resolved form, so what the CTK ran against is what a
    /// claim cites. <c>null</c> keeps the code-declared surface.</summary>
    JsonObject? Declaration => null;

    /// <summary>Wire the scenario's mock model + tools into the framework,
    /// register the interceptors and resolver, set the enforcement mode,
    /// the vector's composition profile (§7.1), and its identity provider
    /// (§10.1; vectors declare "jcs-sha256" or null — custom providers
    /// are functions and not vector-expressible). When
    /// <paramref name="redactForApproval"/> is non-empty the harness MUST
    /// register a §9 approval redactor that replaces each listed §5.2
    /// path in the request context's target with the string
    /// "[redacted]" (write-back mirrored per §4.3), leaving unresolvable
    /// paths untouched.</summary>
    void Setup(
        Scenario scenario,
        IReadOnlyList<IInterceptor> interceptors,
        IApprovalResolver? resolver,
        EnforcementMode mode,
        CompositionConfig composition,
        string? identityProvider,
        IReadOnlyList<string>? redactForApproval = null);

    /// <summary>Wire one declaration vector (§7.7.9): the harness MUST
    /// build its emitter from <paramref name="document"/> and
    /// <paramref name="registry"/> through the loader
    /// (<see cref="InterceptionEmitter.FromDeclarationNode"/>) and let the
    /// <see cref="DeclarationException"/> propagate on refusal, never fall
    /// back to the field-based <see cref="Setup"/>. The document and the
    /// registry carry the interceptors, resolver, composition and
    /// identity provider. Only harnesses declaring the
    /// <c>host_declaration</c> capability receive this call.</summary>
    void SetupDeclared(Scenario scenario, JsonObject document, HostRegistry registry) =>
        throw new DeclarationException(
            DeclarationErrorClass.SurfaceUnsupported,
            "",
            $"harness \"{Name}\" declares host_declaration but does not implement SetupDeclared");

    Task<RunRecord> RunAsync(CancellationToken ct = default);

    void Teardown();
}
