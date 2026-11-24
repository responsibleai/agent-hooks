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

    private const int DefaultMaxDepth = 128;
    private const string MaxSafeInteger = "9007199254740991";
    private const string IntegerDomainDetail = "integer token exceeds 2^53; string-encode 64-bit identifiers, see spec §4.4";

    // §10.2: the identity preimage is exactly the required members of the point's request schema,
    // keeping only the required subfields of object members, pre-sorted in RFC 8785 key order.
    private static readonly Lazy<Dictionary<Draft.InterceptionPoint, (string Key, string[]? Fields)[]>> Projections = new(() =>
        Points.All.ToDictionary(p => p, p => Project(Schemas.Document(Points.RequestSchema(p)))));

    private static (string Key, string[]? Fields)[] Project(JsonObject schema)
    {
        var properties = schema["properties"]!.AsObject();
        return schema["required"]!.AsArray()
            .Select(r => r!.GetValue<string>())
            .Order(StringComparer.Ordinal)
            .Select(key =>
            {
                var property = Resolve(schema, properties[key]);
                var fields = property?["type"] is JsonValue type && type.TryGetValue(out string? kind) && kind == "object" &&
                    property["required"] is JsonArray required
                    ? required.Select(f => f!.GetValue<string>()).Order(StringComparer.Ordinal).ToArray()
                    : null;
                return (key, fields);
            })
            .ToArray();
    }

    private static JsonNode? Resolve(JsonObject schema, JsonNode? property) =>
        property?["$ref"]?.GetValue<string>() is { } reference && reference.StartsWith("#/$defs/", StringComparison.Ordinal)
            ? schema["$defs"]?[reference["#/$defs/".Length..]]
            : property;

    /// <summary>The RFC 8785 form of <paramref name="value"/>; integers must fit ±(2^53−1).</summary>
    public static string Canonicalize(JsonNode? value)
    {
        var element = ToElement(value);
        CheckIntegerDomain(element);
        return Write(element);
    }

    /// <summary>The <c>jcs-sha256</c> identity of a request (§10.1): <c>sha256:</c> + hex over the canonical projection.</summary>
    public static string ContextIdentity(JsonObject request)
    {
        var context = ToElement(request);
        Draft.InterceptionPoint? point = context.TryGetProperty("interception_point", out var ip) &&
            ip.ValueKind == JsonValueKind.String &&
            Draft.InterceptionPointExtensions.TryParseWire(ip.GetString(), out var parsedPoint)
            ? parsedPoint
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
        var builder = new StringBuilder();
        builder.Append('{');
        var first = true;
        foreach (var (key, keep) in Projections.Value[point.Value])
        {
            if (!context.TryGetProperty(key, out var value)) continue;
            if (!first) builder.Append(',');
            first = false;
            WriteString(builder, key);
            builder.Append(':');
            if (keep is not null && value.ValueKind == JsonValueKind.Object)
            {
                builder.Append('{');
                var firstMember = true;
                foreach (var member in keep)
                {
                    if (!value.TryGetProperty(member, out var kept)) continue;
                    CheckIntegerDomain(kept);
                    if (!firstMember) builder.Append(',');
                    firstMember = false;
                    WriteString(builder, member);
                    builder.Append(':');
                    Write(builder, kept);
                }
                builder.Append('}');
            }
            else
            {
                CheckIntegerDomain(value);
                Write(builder, value);
            }
        }
        builder.Append('}');
        return "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(builder.ToString()))).ToLowerInvariant();
    }

    /// <summary>Parses untrusted JSON text: rejects duplicate members, lone surrogates, non-finite numbers and excess depth.</summary>
    internal static JsonNode? Parse(string json, int maxDepth = DefaultMaxDepth)
    {
        UnicodeValidation.CheckString(json);
        try
        {
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = maxDepth });
            CheckParsed(document.RootElement, maxDepth);
        }
        catch (InvalidOperationException e)
        {
            throw new JsonException("invalid Unicode string", e);
        }
        return JsonNode.Parse(json, documentOptions: new() { MaxDepth = maxDepth });
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
        try
        {
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = DefaultMaxDepth });
            CheckIntegerDomain(document.RootElement);
            return true;
        }
        catch (Exception e) when (e is AgentHooksCoreException or JsonException)
        {
            return false;
        }
    }

    private static JsonElement ToElement(JsonNode? value)
    {
        try
        {
            UnicodeValidation.CheckObjectGraph(value, DefaultMaxDepth);
            var element = ContractSerializer.Element(value);
            CheckParsed(element, DefaultMaxDepth);
            return element;
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or ArgumentException)
        {
            throw Invalid("invalid JSON, Unicode string, or non-finite number");
        }
    }

    private static void CheckParsed(JsonElement root, int maxDepth)
    {
        var stack = new Stack<(JsonElement Value, int Depth)>();
        stack.Push((root, 0));
        while (stack.TryPop(out var entry))
        {
            switch (entry.Value.ValueKind)
            {
                case JsonValueKind.Object:
                    if (entry.Depth + 1 > maxDepth)
                        throw new JsonException($"nesting depth exceeds {maxDepth} levels, see spec §12.3");
                    var seen = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var property in entry.Value.EnumerateObject())
                    {
                        if (!seen.Add(property.Name))
                            throw new JsonException($"duplicate member \"{property.Name}\"");
                        stack.Push((property.Value, entry.Depth + 1));
                    }
                    break;
                case JsonValueKind.Array:
                    if (entry.Depth + 1 > maxDepth)
                        throw new JsonException($"nesting depth exceeds {maxDepth} levels, see spec §12.3");
                    foreach (var item in entry.Value.EnumerateArray())
                        stack.Push((item, entry.Depth + 1));
                    break;
                case JsonValueKind.String:
                    _ = entry.Value.GetString();
                    break;
                case JsonValueKind.Number:
                    _ = ParseNumber(entry.Value.GetRawText());
                    break;
            }
        }
    }

    private static void CheckIntegerDomain(JsonElement root)
    {
        var stack = new Stack<JsonElement>();
        stack.Push(root);
        while (stack.TryPop(out var current))
        {
            switch (current.ValueKind)
            {
                case JsonValueKind.Object:
                    foreach (var property in current.EnumerateObject()) stack.Push(property.Value);
                    break;
                case JsonValueKind.Array:
                    foreach (var item in current.EnumerateArray()) stack.Push(item);
                    break;
                case JsonValueKind.Number:
                    var raw = current.GetRawText();
                    if (raw.IndexOfAny(['.', 'e', 'E']) >= 0) break;
                    var digits = raw[0] == '-' ? raw.AsSpan(1) : raw.AsSpan();
                    if (digits.Length > MaxSafeInteger.Length ||
                        (digits.Length == MaxSafeInteger.Length && digits.SequenceCompareTo(MaxSafeInteger) > 0))
                        throw Invalid(IntegerDomainDetail);
                    break;
            }
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
