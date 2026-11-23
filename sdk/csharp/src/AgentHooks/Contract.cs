// Copyright (c) Microsoft. All rights reserved.

using System.Collections;
using System.Numerics;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using AgentHooks.Contracts;

namespace AgentHooks;

/// <summary>Bridges the generated contract types and their wire JSON.</summary>
internal static class Contract
{
    internal static readonly JsonSerializerOptions Options = new() { MaxDepth = 256 };

    /// <summary>Serializes a generated contract value to its wire object.</summary>
    public static JsonObject ToJson<T>(T value) where T : notnull
    {
        ValidateUnicode(value);
        return JsonSerializer.SerializeToNode(value, value.GetType(), Options)?.AsObject()
            ?? throw new JsonException("Contract values serialize to JSON objects.");
    }

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

    /// <summary>Rejects lone UTF-16 surrogates in strings, keys, nodes and extension data before UTF-8 serialization replaces them with U+FFFD.</summary>
    internal static void ValidateUnicode(object? value) =>
        ValidateUnicode(value, new HashSet<object>(ReferenceEqualityComparer.Instance));

    private static void ValidateUnicode(object? value, HashSet<object> visited)
    {
        switch (value)
        {
            case null:
                return;
            case string text:
                Jcs.CheckUnicode(text);
                return;
            case char ch:
                if (char.IsSurrogate(ch)) throw new JsonException("lone surrogate");
                return;
            case Uri uri:
                Jcs.CheckUnicode(uri.OriginalString);
                return;
            case JsonElement element:
                ValidateElementUnicode(element);
                return;
            case JsonDocument document:
                ValidateElementUnicode(document.RootElement);
                return;
            case JsonObject obj:
                if (!visited.Add(obj)) return;
                foreach (var (key, child) in obj)
                {
                    Jcs.CheckUnicode(key);
                    ValidateUnicode(child, visited);
                }
                return;
            case JsonArray array:
                if (!visited.Add(array)) return;
                foreach (var item in array) ValidateUnicode(item, visited);
                return;
            case JsonValue jsonValue:
                if (jsonValue.TryGetValue(out string? str)) Jcs.CheckUnicode(str);
                else if (jsonValue.TryGetValue(out char c))
                {
                    if (char.IsSurrogate(c)) throw new JsonException("lone surrogate");
                }
                else if (jsonValue.TryGetValue(out JsonElement el)) ValidateElementUnicode(el);
                else if (jsonValue.TryGetValue(out object? raw) && raw is not JsonValue) ValidateUnicode(raw, visited);
                return;
        }

        var type = value.GetType();
        if (type.IsPrimitive || type.IsEnum ||
            value is decimal or BigInteger or DateTime or DateTimeOffset or TimeSpan or Guid)
            return;

        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(Optional<>))
        {
            if ((bool)type.GetProperty(nameof(Optional<object>.IsDefined))!.GetValue(value)!)
                ValidateUnicode(type.GetProperty(nameof(Optional<object>.Value))!.GetValue(value), visited);
            return;
        }

        if (!type.IsValueType && !visited.Add(value)) return;

        if (value is IDictionary dictionary)
        {
            foreach (DictionaryEntry entry in dictionary)
            {
                ValidateUnicode(entry.Key, visited);
                ValidateUnicode(entry.Value, visited);
            }
            return;
        }

        if (value is IEnumerable enumerable)
        {
            foreach (var item in enumerable) ValidateUnicode(item, visited);
            return;
        }

        foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (!property.CanRead || property.GetIndexParameters().Length > 0) continue;
            if (property.GetCustomAttribute<JsonIgnoreAttribute>()?.Condition == JsonIgnoreCondition.Always) continue;
            ValidateUnicode(property.GetValue(value), visited);
        }
    }

    private static void ValidateElementUnicode(JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var property in element.EnumerateObject())
                {
                    Jcs.CheckUnicode(property.Name);
                    ValidateElementUnicode(property.Value);
                }
                break;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray()) ValidateElementUnicode(item);
                break;
            case JsonValueKind.String:
                Jcs.CheckUnicode(element.GetString()!);
                break;
        }
    }
}
