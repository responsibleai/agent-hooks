// Copyright (c) Microsoft. All rights reserved.

using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks;

/// <summary>Wire-level verdict rules: validation, synthesis, severity, unions and record projection (§5–§7, §10.3).</summary>
internal static class Verdicts
{
    internal static JsonObject Allow() => new() { ["decision"] = "allow" };

    /// <summary>The host-synthesized deny of §11; <paramref name="liftable"/> adds the §7.5 approval marker.</summary>
    internal static JsonObject HostError(string reason, string? detail = null, bool liftable = false)
    {
        var verdict = new JsonObject { ["decision"] = "deny", ["reason"] = reason };
        if (detail is not null) verdict["message"] = detail;
        if (liftable) verdict["approval"] = new JsonObject();
        return verdict;
    }

    /// <summary>The <c>on_error: continue</c> substitute (§6.3.1).</summary>
    internal static JsonObject Substitute(string message) => new()
    {
        ["decision"] = "allow",
        ["warnings"] = new JsonArray(new JsonObject { ["reason"] = HostErrors.ControlFailedWarning, ["message"] = message }),
    };

    internal static string Decision(JsonObject verdict) => (string)verdict["decision"]!;

    internal static string? Reason(JsonObject verdict) =>
        verdict["reason"] is JsonValue value && value.TryGetValue(out string? reason) ? reason : null;

    internal static bool Permits(JsonObject verdict) => Decision(verdict) != "deny";

    internal static bool IsLiftable(JsonObject verdict) => Decision(verdict) == "deny" && verdict["approval"] is JsonObject;

    internal static bool IsHostSynthesized(JsonObject verdict) =>
        Reason(verdict)?.StartsWith("host_error:", StringComparison.Ordinal) == true;

    /// <summary>§7.3 severity: deny 3, liftable deny 2, transform 1, allow 0.</summary>
    internal static int Severity(JsonObject verdict) => Decision(verdict) switch
    {
        "deny" => IsLiftable(verdict) ? 2 : 3,
        "transform" => 1,
        _ => 0,
    };

    /// <summary>Checks a hook response beyond its schema (§5.3); returns a payload-free failure detail or null.</summary>
    internal static string? Gate(Draft.InterceptionPoint point, JsonObject response)
    {
        var schema = Points.ResponseSchema(point);
        if (!Schemas.IsValid(response, schema))
            return $"the response does not satisfy the {schema} schema (see spec §5)";
        var verdict = (JsonObject)response["verdict"]!;
        try
        {
            UnicodeValidation.CheckObjectGraph(response);
            if (verdict["evidence"] is { } evidence && Jcs.CanonicalSize(evidence) > 10240)
                return "evidence canonical size exceeds 10240 bytes (see spec §5.3)";
            if (response["extensions"] is JsonObject extensions && Jcs.CanonicalSize(extensions) > 65536)
                return "response extensions exceed 65536 bytes (see spec §5)";
        }
        catch (Exception e) when (e is HookException or JsonException)
        {
            return "response metadata is outside the I-JSON domain (see spec §4.4)";
        }
        return null;
    }

    /// <summary>Unions warnings over <paramref name="pool"/> and, on a permit, result labels over permitting verdicts (§7.3).</summary>
    internal static JsonObject WithUnions(JsonObject combined, IEnumerable<JsonObject> pool)
    {
        var result = (JsonObject)combined.DeepClone();
        var sources = pool.ToList();
        var warnings = Distinct(sources.SelectMany(v => v["warnings"] as JsonArray ?? []));
        if (warnings.Count > 0) result["warnings"] = warnings;
        result.Remove("result_labels");
        if (Permits(result))
        {
            var labels = Distinct(sources.Where(Permits).SelectMany(v => v["result_labels"] as JsonArray ?? []));
            if (labels.Count > 0) result["result_labels"] = labels;
        }
        return result;
    }

    /// <summary>The §10.3 record projection: messages truncated, approval presence only, transform body dropped.</summary>
    internal static JsonObject Project(JsonObject verdict)
    {
        var projected = (JsonObject)verdict.DeepClone();
        projected.Remove("transform");
        if (projected["approval"] is not null) projected["approval"] = new JsonObject();
        Truncate(projected);
        foreach (var warning in projected["warnings"] as JsonArray ?? [])
            if (warning is JsonObject w) Truncate(w);
        return projected;

        static void Truncate(JsonObject target)
        {
            if (target["message"] is JsonValue m && m.TryGetValue(out string? message))
                target["message"] = Jcs.Truncate(message);
        }
    }

    /// <summary>The verdict slot recorded for interceptor <paramref name="index"/> (§10.3).</summary>
    internal static JsonObject Slot(int index, JsonObject verdict, string? name, string? substitutedFor)
    {
        var slot = new JsonObject { ["index"] = index, ["decision"] = Decision(verdict) };
        if (Reason(verdict) is { } reason) slot["reason"] = reason;
        if (name is not null) slot["name"] = name;
        if (substitutedFor is not null) slot["substituted_for"] = substitutedFor;
        return slot;
    }

    /// <summary>A UTF-8 label of 1–128 bytes, as control-failure notices require.</summary>
    internal static bool IsLabel(string value) => value.Length > 0 && Encoding.UTF8.GetByteCount(value) <= 128;

    private static JsonArray Distinct(IEnumerable<JsonNode?> items)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        return new JsonArray(items.Where(item => seen.Add(Jcs.Canonicalize(item))).Select(item => item?.DeepClone()).ToArray());
    }
}
