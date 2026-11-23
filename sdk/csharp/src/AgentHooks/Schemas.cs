// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json;
using System.Text.Json.Nodes;
using Json.Schema;

namespace AgentHooks;

/// <summary>Validates wire JSON against the embedded schemas generated from the draft TypeSpec.</summary>
internal static class Schemas
{
    private const string Prefix = "AgentHooks.Schemas.";
    private static readonly EvaluationOptions Flag = new() { RequireFormatValidation = true };
    private static readonly EvaluationOptions List = new() { RequireFormatValidation = true, OutputFormat = OutputFormat.List };

    // Built together so cross-document $refs resolve; building registers each $id globally, so it happens once.
    private static readonly Lazy<IReadOnlyDictionary<string, JsonSchema>> All = new(() =>
        typeof(Schemas).Assembly.GetManifestResourceNames()
            .Where(n => n.StartsWith(Prefix, StringComparison.Ordinal))
            .Select(n => n[Prefix.Length..^".json".Length])
            .ToDictionary(n => n, n => JsonSchema.FromText(Document(n).ToJsonString()), StringComparer.Ordinal));

    /// <summary>True when <paramref name="value"/> satisfies the schema generated for the TypeSpec model <paramref name="schema"/>.</summary>
    internal static bool IsValid(JsonNode? value, string schema) => IsValid(Contract.Element(value), schema);

    /// <summary>True when <paramref name="value"/> satisfies the schema generated for the TypeSpec model <paramref name="schema"/>.</summary>
    internal static bool IsValid(JsonElement value, string schema) =>
        Load(schema).Evaluate(value, Flag).IsValid;

    /// <summary>The failing instance locations and messages of <paramref name="value"/>.</summary>
    internal static IReadOnlyList<(string Pointer, string Message)> Errors(JsonNode? value, string schema) =>
        Errors(Contract.Element(value), schema);

    /// <summary>The failing instance locations and messages of <paramref name="value"/>.</summary>
    internal static IReadOnlyList<(string Pointer, string Message)> Errors(JsonElement value, string schema)
    {
        var result = Load(schema).Evaluate(value, List);
        if (result.IsValid) return [];
        return (result.Details ?? [])
            .Where(d => d.Errors is { Count: > 0 })
            .SelectMany(d => d.Errors!.Values.Select(message => (d.InstanceLocation.ToString(), message)))
            .Distinct()
            .ToList();
    }

    /// <summary>The raw schema document, for structural walks.</summary>
    internal static JsonObject Document(string name)
    {
        using var stream = typeof(Schemas).Assembly.GetManifestResourceStream($"{Prefix}{name}.json")
            ?? throw new InvalidOperationException($"Missing generated schema: {name}.");
        return JsonNode.Parse(stream)!.AsObject();
    }

    private static JsonSchema Load(string schema) =>
        All.Value.TryGetValue(schema, out var loaded) ? loaded : throw new InvalidOperationException($"Missing generated schema: {schema}.");
}
