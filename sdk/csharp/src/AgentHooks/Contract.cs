// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentHooks;

/// <summary>Bridges the generated contract types and their wire JSON.</summary>
internal static class Contract
{
    internal static readonly JsonSerializerOptions Options = new() { MaxDepth = 256 };

    /// <summary>Serializes a generated contract value to its wire object.</summary>
    public static JsonObject ToJson<T>(T value) where T : notnull =>
        JsonSerializer.SerializeToNode(value, value.GetType(), Options)?.AsObject()
        ?? throw new JsonException("Contract values serialize to JSON objects.");

    /// <summary>Reads a generated contract value from its wire JSON.</summary>
    public static T FromJson<T>(JsonNode? node) =>
        node.Deserialize<T>(Options) ?? throw new JsonException($"Expected {typeof(T).Name}, found null.");

    /// <summary>The wire string of a generated enum value.</summary>
    public static string Wire<TEnum>(TEnum value) where TEnum : struct, Enum =>
        JsonSerializer.SerializeToNode(value)!.GetValue<string>();

    /// <summary>Parses a generated enum from its wire string; null when unknown.</summary>
    public static TEnum? Parse<TEnum>(string? wire) where TEnum : struct, Enum
    {
        if (wire is null) return null;
        try { return JsonSerializer.Deserialize<TEnum>(JsonValue.Create(wire)); }
        catch (JsonException) { return null; }
    }

    internal static JsonElement Element(JsonNode? node) => JsonSerializer.SerializeToElement(node, Options);
}
