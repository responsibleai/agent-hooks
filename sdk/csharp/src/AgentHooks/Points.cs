// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json.Nodes;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks;

/// <summary>Per-point facts of spec §3/§5: wire names, schemas and the whole-member transform target.</summary>
internal static class Points
{
    internal static readonly Draft.InterceptionPoint[] All =
        Draft.InterceptionPoints.All.Select(m => m.Point).ToArray();

    internal static readonly string[] Wires =
        Draft.InterceptionPoints.All.Select(m => m.WireName).ToArray();

    internal static string Wire(Draft.InterceptionPoint point) =>
        Draft.InterceptionPoints.Get(point).WireName;

    internal static Draft.InterceptionPoint? Parse(JsonNode? wire) =>
        wire is JsonValue value && value.TryGetValue(out string? text) &&
        Draft.InterceptionPoints.TryParse(text, out var point)
            ? point
            : null;

    /// <summary>The strict request schema (§4).</summary>
    internal static string RequestSchema(Draft.InterceptionPoint point) =>
        Draft.InterceptionPoints.Get(point).RequestSchema;

    /// <summary>The hook response schema (§5).</summary>
    internal static string ResponseSchema(Draft.InterceptionPoint point) =>
        Draft.InterceptionPoints.Get(point).ResponseSchema;

    /// <summary>The §5 transform member and the request path it replaces; null where transforms are forbidden.</summary>
    internal static (string Member, string[] Path)? TransformTarget(Draft.InterceptionPoint point) =>
        Draft.InterceptionPoints.Get(point).TransformTarget is { } target
            ? (target.Member, target.Path.ToArray())
            : null;
}
