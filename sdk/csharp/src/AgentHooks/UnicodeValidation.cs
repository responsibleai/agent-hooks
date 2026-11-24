// Copyright (c) Microsoft. All rights reserved.

using System.Collections;
using System.Numerics;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using AgentHooks.Contracts;

namespace AgentHooks;

/// <summary>Rejects lone UTF-16 surrogates in strings, JSON elements, and object graphs before UTF-8 serialization replaces them with U+FFFD.</summary>
internal static class UnicodeValidation
{
    internal static void CheckString(string value)
    {
        for (var i = 0; i < value.Length; i++)
        {
            if (!char.IsSurrogate(value[i])) continue;
            if (!char.IsHighSurrogate(value[i]) || i + 1 == value.Length || !char.IsLowSurrogate(value[++i]))
                throw new JsonException("lone surrogate");
        }
    }

    internal static void CheckObjectGraph(object? value, int maxDepth = 256)
    {
        try
        {
            CheckObjectGraphCore(value, maxDepth);
        }
        catch (InvalidOperationException e)
        {
            throw new JsonException("invalid Unicode string", e);
        }
    }

    internal static void CheckElement(JsonElement root, int startDepth, int maxDepth)
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
                        CheckString(property.Name);
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
                    CheckString(entry.Element.GetString()!);
                    break;
            }
        }
    }

    private static void CheckObjectGraphCore(object? value, int maxDepth)
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
                    CheckString(text);
                    continue;
                case char ch:
                    if (char.IsSurrogate(ch)) throw new JsonException("lone surrogate");
                    continue;
                case Uri uri:
                    CheckString(uri.OriginalString);
                    continue;
                case JsonElement element:
                    CheckElement(element, depth, maxDepth);
                    continue;
                case JsonObject obj:
                    if (depth + 1 > maxDepth)
                        throw new JsonException($"nesting depth exceeds {maxDepth} levels");
                    if (!visited.Add(obj)) continue;
                    foreach (var (key, child) in obj)
                    {
                        CheckString(key);
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
                    if (jsonValue.TryGetValue(out string? str)) CheckString(str);
                    else if (jsonValue.TryGetValue(out char c))
                    {
                        if (char.IsSurrogate(c)) throw new JsonException("lone surrogate");
                    }
                    else if (jsonValue.TryGetValue(out JsonElement el)) CheckElement(el, depth, maxDepth);
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
}
