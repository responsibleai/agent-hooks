// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json.Serialization;
using AgentHooks.Contracts.Serialization;

namespace AgentHooks.Contracts;

/// <summary>Distinguishes an omitted JSON property from a present value, including null.</summary>
[JsonConverter(typeof(OptionalJsonConverterFactory))]
public readonly struct Optional<T>
{
    private readonly T _value;

    public Optional(T value)
    {
        _value = value;
        IsDefined = true;
    }

    public bool IsDefined { get; }

    public T Value => IsDefined ? _value : throw new InvalidOperationException("The property is absent.");

    public static implicit operator Optional<T>(T value) => new(value);
}
