// Copyright (c) Microsoft. All rights reserved.

using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentHooks;

/// <summary>RFC 8785 canonical JSON and the §10 <c>jcs-sha256</c> context identity.</summary>
public static class Jcs
{
    public const string ProviderName = "jcs-sha256";

    private const string MaxSafeInteger = "9007199254740991";
    private const string IntegerDomainDetail = "integer token exceeds 2^53; string-encode 64-bit identifiers, see spec §4.4";

    private static readonly double[] PowersOfTen = Enumerable.Range(0, 309)
        .Select(e => double.Parse("1e" + e.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture))
        .ToArray();

    private static readonly (string Key, string[]? Fields)[] CoreFields =
    [
        ("spec", null), ("interception_point", null), ("timestamp", null), ("sequence", null),
        ("agent", ["id", "framework"]), ("session", ["id"]),
    ];

    /// <summary>The members of each point's payload that bind into the identity (§10.1).</summary>
    private static (string Key, string[]? Fields)[] PointFields(string? point) => point switch
    {
        "agent_startup" => [("agent_init", ["tools_registered"])],
        "input" => [("input", ["content", "role"])],
        "pre_model_call" => [("model", ["id"]), ("messages", null)],
        "post_model_call" => [("model", ["id"]), ("response", ["content", "tool_calls", "finish_reason"])],
        "pre_tool_call" => [("tool_call", ["id", "name", "args"])],
        "post_tool_call" => [("tool_call", ["id", "name", "args"]), ("tool_result", ["value", "is_error"])],
        "output" => [("output", ["content"])],
        "agent_shutdown" => [("summary", ["reason"])],
        _ => [],
    };

    /// <summary>The RFC 8785 form of <paramref name="value"/>; integers must fit ±(2^53−1).</summary>
    public static string Canonicalize(JsonNode? value)
    {
        var element = ToElement(value);
        ScanIntegerDomain(element.GetRawText());
        return Write(element);
    }

    /// <summary>The <c>jcs-sha256</c> identity of a request (§10.1): <c>sha256:</c> + hex over the canonical projection.</summary>
    public static string ContextIdentity(JsonObject request)
    {
        var context = ToElement(request);
        var point = context.TryGetProperty("interception_point", out var ip) && ip.ValueKind == JsonValueKind.String
            ? ip.GetString() : null;
        if (!context.TryGetProperty("sequence", out var sequence) || sequence.ValueKind != JsonValueKind.Number ||
            sequence.GetRawText() == "-0")
            throw Invalid("$.sequence: missing or not an integer >= 0 (see spec §4)");
        var projection = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var (key, keep) in CoreFields.Concat(PointFields(point)))
        {
            if (!context.TryGetProperty(key, out var value)) continue;
            if (keep is not null && value.ValueKind == JsonValueKind.Object)
            {
                var filtered = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
                foreach (var member in keep)
                    if (value.TryGetProperty(member, out var kept)) filtered[member] = kept;
                value = JsonSerializer.SerializeToElement(filtered, Contract.Options);
            }
            ScanIntegerDomain(value.GetRawText());
            projection[key] = value;
        }
        var preimage = JsonSerializer.SerializeToElement(projection, Contract.Options);
        CheckDepth(preimage);
        return "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Write(preimage)))).ToLowerInvariant();
    }

    /// <summary>Parses untrusted JSON text: rejects duplicate members, lone surrogates, non-finite numbers and excess depth.</summary>
    internal static JsonNode? Parse(string json, int maxDepth = 128)
    {
        CheckUnicode(json);
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = maxDepth });
        CheckParsed(document.RootElement, rejectDuplicates: true);
        return JsonNode.Parse(document.RootElement.GetRawText(), documentOptions: new() { MaxDepth = maxDepth });
    }

    internal static int CanonicalSize(JsonNode? value) => Encoding.UTF8.GetByteCount(Canonicalize(value));

    /// <summary>Truncates to at most <paramref name="bytes"/> UTF-8 bytes on a character boundary, appending <c>…</c>.</summary>
    internal static string? Truncate(string? value, int bytes = 256)
    {
        if (value is null || Encoding.UTF8.GetByteCount(value) <= bytes) return value;
        var count = 0;
        var result = new StringBuilder();
        foreach (var rune in value.EnumerateRunes())
        {
            if (count + rune.Utf8SequenceLength > bytes) break;
            count += rune.Utf8SequenceLength;
            result.Append(rune);
        }
        return result.Append('\u2026').ToString();
    }

    /// <summary>True when every integer token in <paramref name="json"/> lies within ±(2^53−1).</summary>
    internal static bool InIntegerDomain(string json)
    {
        try { ScanIntegerDomain(json); return true; }
        catch (HookException) { return false; }
    }

    private static JsonElement ToElement(JsonNode? value)
    {
        try
        {
            var element = Contract.Element(value);
            CheckParsed(element, rejectDuplicates: false);
            return element;
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or ArgumentException)
        {
            throw Invalid("invalid JSON, Unicode string, or non-finite number");
        }
    }

    private static void CheckParsed(JsonElement value, bool rejectDuplicates)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                var seen = rejectDuplicates ? new HashSet<string>(StringComparer.Ordinal) : null;
                foreach (var property in value.EnumerateObject())
                {
                    CheckUnicode(property.Name);
                    if (seen is not null && !seen.Add(property.Name))
                        throw new JsonException($"duplicate member \"{property.Name}\"");
                    CheckParsed(property.Value, rejectDuplicates);
                }
                break;
            case JsonValueKind.Array:
                foreach (var item in value.EnumerateArray()) CheckParsed(item, rejectDuplicates);
                break;
            case JsonValueKind.String:
                CheckUnicode(value.GetString()!);
                break;
            case JsonValueKind.Number:
                _ = ParseNumber(value.GetRawText());
                break;
        }
    }

    private static void CheckUnicode(string value)
    {
        for (var i = 0; i < value.Length; i++)
        {
            if (!char.IsSurrogate(value[i])) continue;
            if (!char.IsHighSurrogate(value[i]) || i + 1 == value.Length || !char.IsLowSurrogate(value[++i]))
                throw new JsonException("lone surrogate");
        }
    }

    private static void ScanIntegerDomain(string json)
    {
        for (var i = 0; i < json.Length; i++)
        {
            if (json[i] == '"')
            {
                while (++i < json.Length)
                {
                    if (json[i] == '\\') i++;
                    else if (json[i] == '"') break;
                }
            }
            else if (json[i] == '-' || char.IsAsciiDigit(json[i]))
            {
                var start = i;
                var integer = true;
                while (i < json.Length && (char.IsAsciiDigit(json[i]) || json[i] is '-' or '+' or '.' or 'e' or 'E'))
                {
                    if (json[i] is '.' or 'e' or 'E') integer = false;
                    i++;
                }
                var sign = json[start] == '-' ? 1 : 0;
                var digits = json.AsSpan(start + sign, i - start - sign);
                if (integer && (digits.Length > MaxSafeInteger.Length ||
                    (digits.Length == MaxSafeInteger.Length && digits.SequenceCompareTo(MaxSafeInteger) > 0)))
                    throw Invalid(IntegerDomainDetail);
                i--;
            }
        }
    }

    private static void CheckDepth(JsonElement value)
    {
        var stack = new Stack<(JsonElement Value, int Depth)>();
        stack.Push((value, 1));
        while (stack.TryPop(out var entry))
        {
            if (entry.Depth > 128) throw Invalid("context nests deeper than 128 levels, see spec §12.3");
            if (entry.Value.ValueKind == JsonValueKind.Array)
                foreach (var item in entry.Value.EnumerateArray()) stack.Push((item, entry.Depth + 1));
            else if (entry.Value.ValueKind == JsonValueKind.Object)
                foreach (var property in entry.Value.EnumerateObject()) stack.Push((property.Value, entry.Depth + 1));
        }
    }

    private static string Write(JsonElement value)
    {
        var builder = new StringBuilder();
        Write(builder, value);
        return builder.ToString();
    }

    private static void Write(StringBuilder builder, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                var members = new SortedDictionary<string, JsonElement>(StringComparer.Ordinal);
                foreach (var property in value.EnumerateObject()) members[property.Name] = property.Value;
                builder.Append('{');
                var first = true;
                foreach (var (key, member) in members)
                {
                    if (!first) builder.Append(',');
                    first = false;
                    WriteString(builder, key);
                    builder.Append(':');
                    Write(builder, member);
                }
                builder.Append('}');
                break;
            case JsonValueKind.Array:
                builder.Append('[');
                var separator = "";
                foreach (var item in value.EnumerateArray())
                {
                    builder.Append(separator);
                    separator = ",";
                    Write(builder, item);
                }
                builder.Append(']');
                break;
            case JsonValueKind.String:
                WriteString(builder, value.GetString()!);
                break;
            case JsonValueKind.Number:
                builder.Append(FormatNumber(ParseNumber(value.GetRawText())));
                break;
            case JsonValueKind.True:
                builder.Append("true");
                break;
            case JsonValueKind.False:
                builder.Append("false");
                break;
            default:
                builder.Append("null");
                break;
        }
    }

    private static void WriteString(StringBuilder builder, string value)
    {
        builder.Append('"');
        foreach (var c in value)
        {
            switch (c)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\b': builder.Append("\\b"); break;
                case '\f': builder.Append("\\f"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (c < 0x20) builder.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else builder.Append(c);
                    break;
            }
        }
        builder.Append('"');
    }

    /// <summary>The ECMAScript Number.prototype.toString form RFC 8785 requires.</summary>
    private static string FormatNumber(double value)
    {
        if (value == 0) return "0";
        var sign = value < 0 ? "-" : "";
        var text = Math.Abs(value).ToString("R", CultureInfo.InvariantCulture);
        var exponentIndex = text.IndexOf('E');
        var exponent = exponentIndex < 0 ? 0 : int.Parse(text.AsSpan(exponentIndex + 1), CultureInfo.InvariantCulture);
        var mantissa = exponentIndex < 0 ? text : text[..exponentIndex];
        var decimalIndex = mantissa.IndexOf('.');
        var decimalPosition = (decimalIndex < 0 ? mantissa.Length : decimalIndex) + exponent;
        var digits = mantissa.Replace(".", "", StringComparison.Ordinal);
        var leadingZeros = digits.Length - digits.TrimStart('0').Length;
        digits = digits[leadingZeros..].TrimEnd('0');
        decimalPosition -= leadingZeros;
        if (decimalPosition > 0 && decimalPosition <= 21)
            return sign + (digits.Length <= decimalPosition
                ? digits + new string('0', decimalPosition - digits.Length)
                : digits.Insert(decimalPosition, "."));
        if (decimalPosition <= 0 && decimalPosition > -6)
            return sign + "0." + new string('0', -decimalPosition) + digits;
        var scientific = decimalPosition - 1;
        return sign + digits[0] + (digits.Length > 1 ? "." + digits[1..] : "") +
            "e" + (scientific >= 0 ? "+" : "") + scientific.ToString(CultureInfo.InvariantCulture);
    }

    // Mirrors serde_json's default (non float_roundtrip) decimal parse so identities match the golden
    // vectors, including RFC 8785's 9.999999999999997e22.
    private static double ParseNumber(string text)
    {
        var negative = text[0] == '-';
        var position = negative ? 1 : 0;
        ulong significand = 0;
        var exponent = 0;
        var overflow = false;
        while (position < text.Length && char.IsAsciiDigit(text[position]))
        {
            var digit = (ulong)(text[position++] - '0');
            if (overflow || significand > (ulong.MaxValue - digit) / 10)
            {
                overflow = true;
                exponent++;
            }
            else significand = significand * 10 + digit;
        }
        if (position < text.Length && text[position] == '.')
        {
            position++;
            overflow = false;
            while (position < text.Length && char.IsAsciiDigit(text[position]))
            {
                var digit = (ulong)(text[position++] - '0');
                if (overflow || significand > (ulong.MaxValue - digit) / 10)
                {
                    overflow = true;
                    continue;
                }
                significand = significand * 10 + digit;
                exponent--;
            }
        }
        if (position < text.Length && text[position] is 'e' or 'E')
        {
            position++;
            var negativeExponent = position < text.Length && text[position] == '-';
            if (position < text.Length && text[position] is '+' or '-') position++;
            var magnitude = 0;
            while (position < text.Length)
            {
                var digit = text[position++] - '0';
                if (magnitude > (int.MaxValue - digit) / 10)
                {
                    if (negativeExponent || significand == 0) return negative ? -0.0 : 0.0;
                    throw new JsonException("non-finite number");
                }
                magnitude = magnitude * 10 + digit;
            }
            exponent = (int)Math.Clamp((long)exponent + (negativeExponent ? -(long)magnitude : magnitude),
                int.MinValue, int.MaxValue);
        }
        var number = (double)significand;
        while (exponent < -308 && number != 0)
        {
            number /= 1e308;
            exponent += 308;
        }
        if (exponent > 308)
        {
            if (number != 0) throw new JsonException("non-finite number");
        }
        else if (exponent >= 0) number *= PowersOfTen[exponent];
        else if (number != 0) number /= PowersOfTen[-exponent];
        if (!double.IsFinite(number)) throw new JsonException("non-finite number");
        return negative ? -number : number;
    }

    private static HookException Invalid(string detail) => new(HostErrors.ContextInvalid, detail);
}
