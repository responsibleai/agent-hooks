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
    private static readonly BigIntegerJsonConverter IntegerConverter = new();

    public override bool CanConvert(Type typeToConvert) =>
        typeToConvert.IsGenericType && typeToConvert.GetGenericTypeDefinition() == typeof(Optional<>);

    public override JsonConverter CreateConverter(Type typeToConvert, JsonSerializerOptions options)
    {
        var valueType = typeToConvert.GetGenericArguments()[0];
        if (valueType == typeof(BigInteger))
            return new OptionalJsonConverter<BigInteger>(IntegerConverter);
        if (valueType == typeof(BigInteger?))
            return new OptionalJsonConverter<BigInteger?>(new NullableBigIntegerJsonConverter());
        return (JsonConverter)Activator.CreateInstance(typeof(OptionalJsonConverter<>).MakeGenericType(valueType))!;
    }

    private sealed class NullableBigIntegerJsonConverter : JsonConverter<BigInteger?>
    {
        public override BigInteger? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
            reader.TokenType == JsonTokenType.Null ? null : IntegerConverter.Read(ref reader, typeof(BigInteger), options);

        public override void Write(Utf8JsonWriter writer, BigInteger? value, JsonSerializerOptions options)
        {
            if (value is { } integer)
                IntegerConverter.Write(writer, integer, options);
            else
                writer.WriteNullValue();
        }
    }

    private sealed class OptionalJsonConverter<T> : JsonConverter<Optional<T>>
    {
        private readonly JsonConverter<T>? _valueConverter;

        public OptionalJsonConverter() { }

        public OptionalJsonConverter(JsonConverter<T> valueConverter) => _valueConverter = valueConverter;

        public override bool HandleNull => true;

        public override Optional<T> Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
            new(_valueConverter is null
                ? JsonSerializer.Deserialize<T>(ref reader, options)!
                : _valueConverter.Read(ref reader, typeof(T), options)!);

        public override void Write(Utf8JsonWriter writer, Optional<T> value, JsonSerializerOptions options)
        {
            if (!value.IsDefined)
                throw new JsonException("An absent optional value cannot be serialized on its own.");
            if (_valueConverter is null)
                JsonSerializer.Serialize(writer, value.Value, options);
            else
                _valueConverter.Write(writer, value.Value, options);
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
    string discriminator, IReadOnlyDictionary<(JsonValueKind, string), Type> variants, Type? defaultVariant) : JsonConverter<T>
    where T : class
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
            if (key is null || !variants.TryGetValue((value.ValueKind, key), out variant))
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
        if (!variants.Values.Contains(value.GetType()))
            throw new JsonException($"Unsupported variant of {typeof(T).Name}.");
        JsonSerializer.Serialize(writer, value, value.GetType(), options);
    }
}
