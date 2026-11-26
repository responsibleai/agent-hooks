// Copyright (c) Microsoft. All rights reserved.

using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;

[assembly: InternalsVisibleTo("AgentHooks.Conformance")]
[assembly: InternalsVisibleTo("AgentHooks.Tests")]

namespace AgentHooks;

/// <summary>Strict wire-JSON serializer bridging the generated contract types and JSON nodes.</summary>
/// <remarks>
/// Rejects lone UTF-16 surrogates across object graphs and enforces a maximum nesting depth of 256 before
/// serializing or deserializing so invalid Unicode is never silently replaced with <c>U+FFFD</c>.
/// </remarks>
public static class ContractSerializer
{
    internal static readonly JsonSerializerOptions Options = new() { MaxDepth = 256 };

    /// <summary>Serializes a generated contract value to its wire <see cref="JsonObject" />.</summary>
    /// <typeparam name="T">The generated contract type to serialize.</typeparam>
    /// <param name="value">The contract instance to serialize.</param>
    /// <returns>The serialized wire JSON object.</returns>
    /// <exception cref="JsonException">
    /// <paramref name="value" /> contains a lone UTF-16 surrogate, exceeds the maximum nesting depth, or does not
    /// serialize to a JSON object.
    /// </exception>
    public static JsonObject Serialize<T>(T value) where T : notnull
    {
        UnicodeValidation.CheckObjectGraph(value, Options.MaxDepth);
        return JsonSerializer.SerializeToNode(value, value.GetType(), Options) is JsonObject obj
            ? obj
            : throw new JsonException("Contract values serialize to JSON objects.");
    }

    /// <summary>Deserializes a generated contract value from its wire JSON representation.</summary>
    /// <typeparam name="T">The target contract type.</typeparam>
    /// <param name="node">The wire JSON node to deserialize.</param>
    /// <returns>The deserialized contract value.</returns>
    /// <exception cref="JsonException">
    /// <paramref name="node" /> is <see langword="null" />, contains a lone UTF-16 surrogate, exceeds the maximum
    /// nesting depth, or does not match the contract's JSON shape.
    /// </exception>
    public static T Deserialize<T>(JsonNode? node)
    {
        UnicodeValidation.CheckObjectGraph(node, Options.MaxDepth);
        return node.Deserialize<T>(Options) ?? throw new JsonException($"Expected {typeof(T).Name}, found null.");
    }

    internal static JsonElement Element(JsonNode? node) => JsonSerializer.SerializeToElement(node, Options);
}
