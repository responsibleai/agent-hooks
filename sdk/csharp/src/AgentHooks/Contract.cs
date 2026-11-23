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
        ValidateUnicode(value, Options.MaxDepth);
        return JsonSerializer.SerializeToNode(value, value.GetType(), Options) is JsonObject obj
            ? obj
            : throw new JsonException("Contract values serialize to JSON objects.");
    }

    /// <summary>Reads a generated contract value from its wire JSON.</summary>
    public static T FromJson<T>(JsonNode? node)
    {
        ValidateUnicode(node, Options.MaxDepth);
        return node.Deserialize<T>(Options) ?? throw new JsonException($"Expected {typeof(T).Name}, found null.");
    }

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
    internal static void ValidateUnicode(object? value, int maxDepth = 256)
    {
        try
        {
            ValidateUnicodeCore(value, maxDepth);
        }
        catch (InvalidOperationException e)
        {
            throw new JsonException("invalid Unicode string", e);
        }
    }

    private static void ValidateUnicodeCore(object? value, int maxDepth)
    {
        var visited = new HashSet<object>(ReferenceEqualityComparer.Instance);
        var stack = new Stack<(object? Value, int Depth)>();
        stack.Push((value, 0));
        while (stack.TryPop(out var entry))
        {
            var current = entry.Value;
            var depth = entry.Depth;
            switch (current)
            {
                case null:
                    continue;
                case string text:
                    Jcs.CheckUnicode(text);
                    continue;
                case char ch:
                    if (char.IsSurrogate(ch)) throw new JsonException("lone surrogate");
                    continue;
                case Uri uri:
                    Jcs.CheckUnicode(uri.OriginalString);
                    continue;
                case JsonElement element:
                    ValidateElementUnicode(element, depth, maxDepth);
                    continue;
                case JsonObject obj:
                    if (depth + 1 > maxDepth)
                        throw new JsonException($"nesting depth exceeds {maxDepth} levels");
                    if (!visited.Add(obj)) continue;
                    foreach (var (key, child) in obj)
                    {
                        Jcs.CheckUnicode(key);
                        stack.Push((child, depth + 1));
                    }
                    continue;
                case JsonArray array:
                    if (depth + 1 > maxDepth)
                        throw new JsonException($"nesting depth exceeds {maxDepth} levels");
                    if (!visited.Add(array)) continue;
                    foreach (var item in array) stack.Push((item, depth + 1));
                    continue;
                case JsonValue jsonValue:
                    if (jsonValue.TryGetValue(out string? str)) Jcs.CheckUnicode(str);
                    else if (jsonValue.TryGetValue(out char c))
                    {
                        if (char.IsSurrogate(c)) throw new JsonException("lone surrogate");
                    }
                    else if (jsonValue.TryGetValue(out JsonElement el)) ValidateElementUnicode(el, depth, maxDepth);
                    else if (jsonValue.TryGetValue(out object? raw) && raw is not JsonValue) stack.Push((raw, depth));
                    continue;
            }

            var type = current.GetType();
            if (type.IsPrimitive || type.IsEnum ||
                current is decimal or BigInteger or DateTime or DateTimeOffset or DateOnly or TimeOnly or TimeSpan or Guid or Half or Int128 or UInt128 or Version or byte[])
                continue;

            if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(Optional<>))
            {
                if ((bool)type.GetProperty(nameof(Optional<object>.IsDefined))!.GetValue(current)!)
                    stack.Push((type.GetProperty(nameof(Optional<object>.Value))!.GetValue(current), depth));
                continue;
            }

            if (depth + 1 > maxDepth)
                throw new JsonException($"nesting depth exceeds {maxDepth} levels");

            if (!type.IsValueType && !visited.Add(current)) continue;

            if (current is IDictionary dictionary)
            {
                foreach (DictionaryEntry item in dictionary)
                {
                    stack.Push((item.Key, depth + 1));
                    stack.Push((item.Value, depth + 1));
                }
                continue;
            }

            if (current is IEnumerable enumerable)
            {
                foreach (var item in enumerable) stack.Push((item, depth + 1));
                continue;
            }

            foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (!property.CanRead || property.GetIndexParameters().Length > 0) continue;
                if (property.GetCustomAttribute<JsonIgnoreAttribute>()?.Condition == JsonIgnoreCondition.Always) continue;
                stack.Push((property.GetValue(current), depth + 1));
            }
        }
    }

    private static void ValidateElementUnicode(JsonElement root, int startDepth, int maxDepth)
    {
        var stack = new Stack<(JsonElement Element, int Depth)>();
        stack.Push((root, startDepth));
        while (stack.TryPop(out var entry))
        {
            switch (entry.Element.ValueKind)
            {
                case JsonValueKind.Object:
                    if (entry.Depth + 1 > maxDepth)
                        throw new JsonException($"nesting depth exceeds {maxDepth} levels");
                    foreach (var property in entry.Element.EnumerateObject())
                    {
                        Jcs.CheckUnicode(property.Name);
                        stack.Push((property.Value, entry.Depth + 1));
                    }
                    break;
                case JsonValueKind.Array:
                    if (entry.Depth + 1 > maxDepth)
                        throw new JsonException($"nesting depth exceeds {maxDepth} levels");
                    foreach (var item in entry.Element.EnumerateArray())
                        stack.Push((item, entry.Depth + 1));
                    break;
                case JsonValueKind.String:
                    Jcs.CheckUnicode(entry.Element.GetString()!);
                    break;
            }
        }
    }
}
