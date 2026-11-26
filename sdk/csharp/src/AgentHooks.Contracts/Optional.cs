// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json.Serialization;
using AgentHooks.Contracts.Serialization;

namespace AgentHooks.Contracts;

/// <summary>Distinguishes an omitted JSON property from a present value, including null.</summary>
[JsonConverter(typeof(OptionalJsonConverterFactory))]
public readonly struct Optional<T>
{
    private readonly T _value;

    /// <summary>Creates a defined optional holding <paramref name="value"/>.</summary>
    public Optional(T value)
    {
        _value = value;
        IsDefined = true;
    }

    /// <summary>Whether the property was present on the wire.</summary>
    public bool IsDefined { get; }

    /// <summary>The present value; throws <see cref="InvalidOperationException"/> when <see cref="IsDefined"/> is <c>false</c>.</summary>
    public T Value => IsDefined ? _value : throw new InvalidOperationException("The property is absent.");

    /// <summary>Wraps <paramref name="value"/> as a defined <see cref="Optional{T}"/>.</summary>
    public static implicit operator Optional<T>(T value) => new(value);
}
