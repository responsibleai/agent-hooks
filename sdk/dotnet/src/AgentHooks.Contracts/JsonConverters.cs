// Copyright (c) Microsoft. All rights reserved.

using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace AgentHooks.Contracts;

/// <summary>Reads and writes JSON integers of any size without a floating-point round trip.</summary>
internal sealed class BigIntegerJsonConverter : JsonConverter<BigInteger>
{
    public override BigInteger Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.Number)
            throw new JsonException("Expected a JSON integer.");
        var token = reader.HasValueSequence ? Encoding.UTF8.GetString(reader.ValueSequence) : Encoding.UTF8.GetString(reader.ValueSpan);
        return BigInteger.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
            ? value
            : throw new JsonException("Expected an integral JSON number.");
    }

    public override void Write(Utf8JsonWriter writer, BigInteger value, JsonSerializerOptions options) =>
        writer.WriteRawValue(value.ToString(CultureInfo.InvariantCulture), skipInputValidation: true);
}

/// <summary>Accepts only the declared wire names; rejects numbers and C# member names.</summary>
internal sealed class StrictJsonStringEnumConverter<TEnum>()
    : JsonStringEnumConverter<TEnum>(namingPolicy: null, allowIntegerValues: false)
    where TEnum : struct, Enum;

/// <summary>Serializes a present <see cref="Optional{T}"/> with the metadata the options resolve for <typeparamref name="T"/>.</summary>
internal sealed class OptionalJsonConverter<T> : JsonConverter<Optional<T>>
{
    public override bool HandleNull => true;

    public override Optional<T> Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        new(JsonSerializer.Deserialize(ref reader, TypeInfo(options))!);

    public override void Write(Utf8JsonWriter writer, Optional<T> value, JsonSerializerOptions options) =>
        JsonSerializer.Serialize(writer, value.Value, TypeInfo(options));

    private static JsonTypeInfo<T> TypeInfo(JsonSerializerOptions options) =>
        (JsonTypeInfo<T>)options.GetTypeInfo(typeof(T));
}

/// <summary>Serializes a present, nullable <see cref="Optional{T}"/> value with a specific converter.</summary>
internal sealed class OptionalJsonConverter<T, TConverter> : JsonConverter<Optional<T?>>
    where T : struct
    where TConverter : JsonConverter<T>, new()
{
    private readonly TConverter _converter = new();

    public override bool HandleNull => true;

    public override Optional<T?> Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.TokenType == JsonTokenType.Null ? new(null) : new(_converter.Read(ref reader, typeof(T), options));

    public override void Write(Utf8JsonWriter writer, Optional<T?> value, JsonSerializerOptions options)
    {
        if (value.Value is { } present)
            _converter.Write(writer, present, options);
        else
            writer.WriteNullValue();
    }
}

/// <summary>
/// Selects a union variant by a literal member, which may be a boolean and may be
/// absent when one variant is the default. Unlike [JsonPolymorphic], the member
/// can appear anywhere in the object and is part of each variant's own contract.
/// </summary>
internal abstract class DiscriminatedUnionJsonConverter<T>(
    string discriminator, Type? defaultVariant, params (string Value, Type Type)[] variants) : JsonConverter<T>
    where T : class
{
    private readonly Dictionary<string, Type> _variants = variants.ToDictionary(variant => variant.Value, variant => variant.Type);

    public override T Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.StartObject)
            throw new JsonException($"Expected an object for {typeof(T).Name}.");
        var variant = FindVariant(reader) ?? defaultVariant
            ?? throw new JsonException($"Missing {discriminator} for {typeof(T).Name}.");
        return (T)JsonSerializer.Deserialize(ref reader, options.GetTypeInfo(variant))!;
    }

    public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options)
    {
        var variant = value.GetType();
        if (!_variants.ContainsValue(variant))
            throw new JsonException($"Unsupported variant of {typeof(T).Name}.");
        JsonSerializer.Serialize(writer, value, options.GetTypeInfo(variant));
    }

    // Scans a copy of the reader: the serializer buffers the whole object before calling a converter.
    private Type? FindVariant(Utf8JsonReader reader)
    {
        while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
        {
            var match = reader.ValueTextEquals(discriminator);
            reader.Read();
            if (match)
            {
                var key = reader.TokenType switch
                {
                    JsonTokenType.String => reader.GetString(),
                    JsonTokenType.True => "true",
                    JsonTokenType.False => "false",
                    _ => null,
                };
                return key is not null && _variants.TryGetValue(key, out var variant)
                    ? variant
                    : throw new JsonException($"Unknown {discriminator} for {typeof(T).Name}.");
            }
            if (!reader.TrySkip())
                throw new JsonException($"Incomplete {typeof(T).Name} object.");
        }
        return null;
    }
}
