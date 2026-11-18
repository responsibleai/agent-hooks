// Copyright (c) Microsoft. All rights reserved.

using System.Globalization;
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AgentHooks.Contracts.Serialization;

internal sealed class BigIntegerJsonConverter : JsonConverter<BigInteger>
{
    public override BigInteger Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.Number)
            throw new JsonException("Expected a JSON integer.");
        using var document = JsonDocument.ParseValue(ref reader);
        if (!BigInteger.TryParse(document.RootElement.GetRawText(), NumberStyles.Float,
            CultureInfo.InvariantCulture, out var value))
            throw new JsonException("Expected an integral JSON number.");
        return value;
    }

    public override void Write(Utf8JsonWriter writer, BigInteger value, JsonSerializerOptions options) =>
        writer.WriteRawValue(value.ToString(CultureInfo.InvariantCulture));
}

internal sealed class OptionalJsonConverterFactory : JsonConverterFactory
{
    public override bool CanConvert(Type typeToConvert) =>
        typeToConvert.IsGenericType && typeToConvert.GetGenericTypeDefinition() == typeof(Optional<>);

    public override JsonConverter CreateConverter(Type typeToConvert, JsonSerializerOptions options) =>
        (JsonConverter)Activator.CreateInstance(
            typeof(OptionalJsonConverter<>).MakeGenericType(typeToConvert.GetGenericArguments()))!;

    private sealed class OptionalJsonConverter<T> : JsonConverter<Optional<T>>
    {
        public override bool HandleNull => true;

        private static JsonSerializerOptions WithIntegerConverter(JsonSerializerOptions options)
        {
            if (options.Converters.Any(converter => converter is BigIntegerJsonConverter))
                return options;
            var result = new JsonSerializerOptions(options);
            result.Converters.Add(new BigIntegerJsonConverter());
            return result;
        }

        public override Optional<T> Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
            new(JsonSerializer.Deserialize<T>(ref reader, WithIntegerConverter(options))!);

        public override void Write(Utf8JsonWriter writer, Optional<T> value, JsonSerializerOptions options)
        {
            if (!value.IsDefined)
                throw new JsonException("An absent optional value cannot be serialized on its own.");
            JsonSerializer.Serialize(writer, value.Value, WithIntegerConverter(options));
        }
    }
}

internal abstract class StringEnumJsonConverter<T>(IReadOnlyDictionary<T, string> values) : JsonConverter<T>
    where T : struct, Enum
{
    private readonly Dictionary<string, T> _fromWire = values.ToDictionary(pair => pair.Value, pair => pair.Key);

    public override T Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String || !_fromWire.TryGetValue(reader.GetString()!, out var value))
            throw new JsonException($"Unknown {typeof(T).Name} wire value.");
        return value;
    }

    public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options)
    {
        if (!values.TryGetValue(value, out var wire))
            throw new JsonException($"Unknown {typeof(T).Name} value.");
        writer.WriteStringValue(wire);
    }
}

internal abstract class DiscriminatedUnionJsonConverter<T>(
    string discriminator, IReadOnlyDictionary<string, Type> variants, Type? defaultVariant) : JsonConverter<T>
{
    public override T Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var document = JsonDocument.ParseValue(ref reader);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
            throw new JsonException($"Expected an object for {typeof(T).Name}.");
        Type? variant;
        if (root.TryGetProperty(discriminator, out var value))
        {
            var key = value.ValueKind switch
            {
                JsonValueKind.String => value.GetString(),
                JsonValueKind.True => "true",
                JsonValueKind.False => "false",
                _ => null,
            };
            if (key is null || !variants.TryGetValue(key, out variant))
                throw new JsonException($"Unknown {discriminator} for {typeof(T).Name}.");
        }
        else
        {
            variant = defaultVariant;
        }
        if (variant is null)
            throw new JsonException($"Missing {discriminator} for {typeof(T).Name}.");
        return (T)root.Deserialize(variant, options)!;
    }

    public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options)
    {
        if (value is null || !variants.Values.Contains(value.GetType()))
            throw new JsonException($"Unsupported variant of {typeof(T).Name}.");
        JsonSerializer.Serialize(writer, value, value.GetType(), options);
    }
}
