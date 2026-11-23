// Copyright (c) Microsoft. All rights reserved.

using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks;

/// <summary>RFC 8785 canonical JSON and the §10 <c>jcs-sha256</c> context identity.</summary>
internal static class Jcs
{
    public const string ProviderName = "jcs-sha256";

    private const string MaxSafeInteger = "9007199254740991";
    private const string IntegerDomainDetail = "integer token exceeds 2^53; string-encode 64-bit identifiers, see spec §4.4";

    // §10.2: the identity preimage is exactly the required members of the point's request schema,
    // keeping only the required subfields of object members, so it follows the generated schemas.
    private static readonly Lazy<Dictionary<Draft.InterceptionPoint, (string Key, string[]? Fields)[]>> Projections = new(() =>
        Points.All.ToDictionary(p => p, p => Project(Schemas.Document(Points.RequestSchema(p)))));

    private static (string Key, string[]? Fields)[] Project(JsonObject schema)
    {
        var properties = schema["properties"]!.AsObject();
        return schema["required"]!.AsArray().Select(r => r!.GetValue<string>()).Select(key =>
        {
            var property = Resolve(schema, properties[key]);
            var fields = property?["type"] is JsonValue type && type.TryGetValue(out string? kind) && kind == "object" &&
                property["required"] is JsonArray required
                ? required.Select(f => f!.GetValue<string>()).ToArray()
                : null;
            return (key, fields);
        }).ToArray();
    }

    private static JsonNode? Resolve(JsonObject schema, JsonNode? property) =>
        property?["$ref"]?.GetValue<string>() is { } reference && reference.StartsWith("#/$defs/", StringComparison.Ordinal)
            ? schema["$defs"]?[reference["#/$defs/".Length..]]
            : property;

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
            ? Contract.Parse<Draft.InterceptionPoint>(ip.GetString())
            : null;
        if (point is null)
            throw Invalid("$.interception_point: missing or unknown interception point (see spec §3)");
        if (!context.TryGetProperty("sequence", out var sequence) || sequence.ValueKind != JsonValueKind.Number ||
            sequence.GetRawText().StartsWith('-'))
            throw Invalid("$.sequence: missing or not an integer >= 0 (see spec §4)");
        var schema = Points.RequestSchema(point.Value);
        if (!Schemas.IsValid(context, schema))
        {
            var pointer = Schemas.Errors(context, schema).Select(e => e.Pointer).FirstOrDefault(p => p.Length > 0) ?? "";
            throw Invalid($"${pointer.Replace('/', '.')}: does not satisfy the {schema} request schema (see spec §4)");
        }
        var projection = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var (key, keep) in Projections.Value[point.Value])
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
        CheckParsed(document.RootElement);
        return JsonNode.Parse(document.RootElement.GetRawText(), documentOptions: new() { MaxDepth = maxDepth });
    }

    internal static int CanonicalSize(JsonNode? value) => Encoding.UTF8.GetByteCount(Canonicalize(value));

    /// <summary>Truncates to at most <paramref name="bytes"/> UTF-8 bytes on a character boundary, appending <c>…</c>.</summary>
    internal static string? Truncate(string? value, int bytes = 256)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(bytes);
        if (value is null || Encoding.UTF8.GetByteCount(value) <= bytes) return value;
        const int ellipsisBytes = 3; // U+2026 ('…') in UTF-8
        var includeEllipsis = bytes >= ellipsisBytes;
        var budget = includeEllipsis ? bytes - ellipsisBytes : bytes;
        var count = 0;
        var result = new StringBuilder();
        foreach (var rune in value.EnumerateRunes())
        {
            if (count + rune.Utf8SequenceLength > budget) break;
            count += rune.Utf8SequenceLength;
            result.Append(rune);
        }
        if (includeEllipsis) result.Append('\u2026');
        return result.ToString();
    }

    /// <summary>True when every integer token in <paramref name="json"/> lies within ±(2^53−1).</summary>
    internal static bool InIntegerDomain(string json)
    {
        try { ScanIntegerDomain(json); return true; }
        catch (AgentHooksCoreException) { return false; }
    }

    private static JsonElement ToElement(JsonNode? value)
    {
        try
        {
            var element = Contract.Element(value);
            CheckParsed(element);
            Contract.ValidateUnicode(value);
            return element;
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or ArgumentException)
        {
            throw Invalid("invalid JSON, Unicode string, or non-finite number");
        }
    }

    private static void CheckParsed(JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var property in value.EnumerateObject())
                {
                    CheckUnicode(property.Name);
                    if (!seen.Add(property.Name))
                        throw new JsonException($"duplicate member \"{property.Name}\"");
                    CheckParsed(property.Value);
                }
                break;
            case JsonValueKind.Array:
                foreach (var item in value.EnumerateArray()) CheckParsed(item);
                break;
            case JsonValueKind.String:
                CheckUnicode(value.GetString()!);
                break;
            case JsonValueKind.Number:
                _ = ParseNumber(value.GetRawText());
                break;
        }
    }

    internal static void CheckUnicode(string value)
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

    private static double ParseNumber(string text)
    {
        if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) ||
            !double.IsFinite(number))
            throw new JsonException("non-finite number");
        return number;
    }

    private static AgentHooksCoreException Invalid(string detail) => new(HostError.ContextInvalid, detail);
}
