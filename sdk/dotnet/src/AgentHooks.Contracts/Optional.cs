// Copyright (c) Microsoft. All rights reserved.

namespace AgentHooks.Contracts;

/// <summary>
/// A <c>?: T | null</c> member: distinguishes an omitted JSON property
/// (<c>default</c>) from a present value, including an explicit null.
/// </summary>
public readonly struct Optional<T>(T value)
{
    public bool IsDefined { get; } = true;

    public T Value => IsDefined ? value : throw new InvalidOperationException("The property is absent.");

    public static implicit operator Optional<T>(T value) => new(value);
}
