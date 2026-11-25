// Copyright (c) Microsoft. All rights reserved.

using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;

[assembly: InternalsVisibleTo("AgentHooks.Conformance")]
[assembly: InternalsVisibleTo("AgentHooks.Tests")]

namespace AgentHooks;

/// <summary>Strict wire-JSON serializer bridging the generated contract types and JSON nodes.</summary>
public static class ContractSerializer
{
    internal static readonly JsonSerializerOptions Options = new() { MaxDepth = 256 };

    /// <summary>Serializes a generated contract value to its wire object.</summary>
    public static JsonObject Serialize<T>(T value) where T : notnull
    {
        UnicodeValidation.CheckObjectGraph(value, Options.MaxDepth);
        return JsonSerializer.SerializeToNode(value, value.GetType(), Options) is JsonObject obj
            ? obj
            : throw new JsonException("Contract values serialize to JSON objects.");
    }

    /// <summary>Deserializes a generated contract value from its wire JSON.</summary>
    public static T Deserialize<T>(JsonNode? node)
    {
        UnicodeValidation.CheckObjectGraph(node, Options.MaxDepth);
        return node.Deserialize<T>(Options) ?? throw new JsonException($"Expected {typeof(T).Name}, found null.");
    }

    internal static JsonElement Element(JsonNode? node) => JsonSerializer.SerializeToElement(node, Options);
}
