// Copyright (c) Microsoft. All rights reserved.

namespace AgentHooks;

internal delegate bool WireParser<T>(string? wire, out T value) where T : struct, Enum;

internal static class WireEnum
{
    /// <summary>Parses a generated enum from its wire string with its generated <c>TryParseWire</c>; null when absent or unknown.</summary>
    internal static T? Parse<T>(string? wire, WireParser<T> parse) where T : struct, Enum =>
        parse(wire, out var value) ? value : null;
}
