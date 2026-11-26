// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json.Serialization;
using AgentHooks.Contracts.Serialization;

namespace AgentHooks.Contracts;

/// <summary>
/// Distinguishes an omitted JSON property from a present value, including explicit <see langword="null" />.
/// </summary>
/// <typeparam name="T">The property value type when the property is present on the wire.</typeparam>
/// <remarks>
/// The default value (<see cref="IsDefined" /> is <see langword="false" />) represents an absent property and is
/// omitted during JSON serialization. A constructed value (<see cref="IsDefined" /> is <see langword="true" />),
/// including <c>new Optional&lt;T?&gt;(null)</c>, represents a property that was explicitly present on the wire
/// (for example, distinguishing an omitted timeout that inherits a default from an explicit <c>null</c> timeout
/// meaning unbounded).
/// </remarks>
[JsonConverter(typeof(OptionalJsonConverterFactory))]
public readonly struct Optional<T>
{
    private readonly T _value;

    /// <summary>Creates a defined optional holding <paramref name="value" />.</summary>
    /// <param name="value">The present property value, which may be <see langword="null" /> when <typeparamref name="T" /> is nullable.</param>
    public Optional(T value)
    {
        _value = value;
        IsDefined = true;
    }

    /// <summary>Gets a value indicating whether the property was explicitly present on the wire.</summary>
    public bool IsDefined { get; }

    /// <summary>Gets the present value when <see cref="IsDefined" /> is <see langword="true" />.</summary>
    /// <exception cref="InvalidOperationException"><see cref="IsDefined" /> is <see langword="false" />.</exception>
    public T Value => IsDefined ? _value : throw new InvalidOperationException("The property is absent.");

    /// <summary>Wraps <paramref name="value" /> as a defined <see cref="Optional{T}" />.</summary>
    /// <param name="value">The value to wrap as present.</param>
    /// <returns>An <see cref="Optional{T}" /> with <see cref="IsDefined" /> set to <see langword="true" />.</returns>
    public static implicit operator Optional<T>(T value) => new(value);
}
