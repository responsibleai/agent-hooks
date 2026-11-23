// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json.Nodes;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks;

/// <summary>Per-point facts of spec §3/§5: wire names, schemas and the whole-member transform target.</summary>
internal static class Points
{
    internal static readonly Draft.InterceptionPoint[] All = Enum.GetValues<Draft.InterceptionPoint>();

    internal static readonly string[] Wires = All.Select(p => Contract.Wire(p)).ToArray();

    internal static string Wire(Draft.InterceptionPoint point) => Wires[(int)point];

    internal static Draft.InterceptionPoint? Parse(JsonNode? wire) =>
        wire is JsonValue value && value.TryGetValue(out string? text) ? Contract.Parse<Draft.InterceptionPoint>(text) : null;

    /// <summary>The strict request schema (§4).</summary>
    internal static string RequestSchema(Draft.InterceptionPoint point) => point switch
    {
        Draft.InterceptionPoint.AgentStartup => nameof(Draft.AgentStartupRequest),
        Draft.InterceptionPoint.Input => nameof(Draft.InputRequest),
        Draft.InterceptionPoint.PreModelCall => nameof(Draft.PreModelCallRequest),
        Draft.InterceptionPoint.PostModelCall => nameof(Draft.PostModelCallRequest),
        Draft.InterceptionPoint.PreToolCall => nameof(Draft.PreToolCallRequest),
        Draft.InterceptionPoint.PostToolCall => nameof(Draft.PostToolCallRequest),
        Draft.InterceptionPoint.Output => nameof(Draft.OutputRequest),
        Draft.InterceptionPoint.AgentShutdown => nameof(Draft.AgentShutdownRequest),
        _ => throw new ArgumentOutOfRangeException(nameof(point), point, null),
    };

    /// <summary>The hook response schema (§5).</summary>
    internal static string ResponseSchema(Draft.InterceptionPoint point) => point switch
    {
        Draft.InterceptionPoint.AgentStartup => nameof(Draft.AgentStartupHookResponse),
        Draft.InterceptionPoint.Input => nameof(Draft.InputHookResponse),
        Draft.InterceptionPoint.PreModelCall => nameof(Draft.PreModelHookResponse),
        Draft.InterceptionPoint.PostModelCall => nameof(Draft.PostModelHookResponse),
        Draft.InterceptionPoint.PreToolCall => nameof(Draft.PreToolHookResponse),
        Draft.InterceptionPoint.PostToolCall => nameof(Draft.PostToolHookResponse),
        Draft.InterceptionPoint.Output => nameof(Draft.OutputHookResponse),
        Draft.InterceptionPoint.AgentShutdown => nameof(Draft.AgentShutdownHookResponse),
        _ => throw new ArgumentOutOfRangeException(nameof(point), point, null),
    };

    /// <summary>The §5 transform member and the request path it replaces; null where transforms are forbidden.</summary>
    internal static (string Member, string[] Path)? TransformTarget(Draft.InterceptionPoint point) => point switch
    {
        Draft.InterceptionPoint.Input => ("input", ["input"]),
        Draft.InterceptionPoint.PreModelCall => ("messages", ["messages"]),
        Draft.InterceptionPoint.PostModelCall => ("response", ["response"]),
        Draft.InterceptionPoint.PreToolCall => ("args", ["tool_call", "args"]),
        Draft.InterceptionPoint.PostToolCall => ("value", ["tool_result", "value"]),
        Draft.InterceptionPoint.Output => ("output", ["output"]),
        _ => null,
    };
}
