// Copyright (c) Microsoft. All rights reserved.

using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentHooks.Conformance;

/// <summary>The CTK assertion engine (conformance/RUNNER.md): checks a run against a vector's <c>expect</c>.</summary>
internal static class CtkEngine
{
    private const string Ip = "interception_point";
    private static readonly JsonSerializerOptions Compact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>The capabilities a vector needs that the surface lacks; null when none.</summary>
    public static string? SkipReason(JsonObject vector, IEnumerable<string> capabilities)
    {
        var missing = Strings(vector["capabilities"]).Except(capabilities, StringComparer.Ordinal).ToList();
        return missing.Count == 0 ? null : $"missing capabilities: {string.Join(", ", missing)}";
    }

    /// <summary>True when every <c>path: value</c> predicate holds; <c>target.*</c> paths use the legacy alias.</summary>
    public static bool Matches(JsonNode? root, JsonNode? predicates) =>
        predicates is not JsonObject obj || obj.All(p => Lookup(root, p.Key, out var got) && Equal(got, p.Value));

    public static List<string> Assert(JsonObject vector, IReadOnlyList<JsonObject> recorded, JsonObject run)
    {
        var expect = vector["expect"];
        var failures = new List<string>();
        if (AssertLoad(expect, recorded, run, failures)) return failures;
        AssertInterceptions(expect, recorded, failures);
        AssertRun(expect, run, failures);
        AssertRecords(expect, run, failures);
        var messages = Strings(run["host_messages"]).ToList();
        foreach (var needle in Strings(expect?["host_messages_must_contain"]))
            if (!messages.Any(m => m.Contains(needle, StringComparison.Ordinal)))
                failures.Add($"no host message contains {Quote(needle)} (messages: {Json(run["host_messages"])})");
        var sequence = recorded.Select(c => Integer(c["sequence"])).OfType<long>().ToList();
        if (sequence.Count != recorded.Count || !sequence.SequenceEqual(sequence.Distinct().Order()))
            failures.Add($"sequence not strictly increasing: [{string.Join(", ", sequence)}]");
        AssertIdentities(expect, run, failures);
        return failures;
    }

    /// <summary>Checks the declaration load outcome; true when nothing else applies (the load was refused).</summary>
    private static bool AssertLoad(JsonNode? expect, IReadOnlyList<JsonObject> recorded, JsonObject run, List<string> failures)
    {
        var want = expect?["load"];
        if (run["load"] is not JsonObject got)
        {
            if (want is null) return false;
            failures.Add("expect.load is set but the runner reported no load outcome");
            return true;
        }
        var detail = (string?)got["detail"] ?? "";
        var outcome = (string)got["outcome"]!;
        if ((bool?)got["paths_equivalent"] == false) failures.Add($"construction paths diverged: {detail}");
        if (want is null)
        {
            if (outcome == "accepted") return false;
            failures.Add($"declaration refused ({got["class"]}) but the vector expects a run: {detail}");
            return true;
        }
        var wantOutcome = (string?)want["outcome"] ?? "accepted";
        if (outcome != wantOutcome) failures.Add($"load.outcome == {Quote(outcome)}, want {Quote(wantOutcome)} ({detail})");
        if ((string?)want["class"] is { } wantClass && (string?)got["class"] != wantClass)
            failures.Add($"load.class == {Json(got["class"])}, want {Quote(wantClass)} ({detail})");
        if ((bool?)want["paths_equivalent"] is { } pe && (bool?)got["paths_equivalent"] != pe)
            failures.Add($"load.paths_equivalent == {Json(got["paths_equivalent"])}, want {pe}");
        if (wantOutcome != "refused") return false;
        if (recorded.Count != 0) failures.Add($"declaration refused but {recorded.Count} interception(s) were recorded");
        if (Array(run["records"]).Count != 0) failures.Add("declaration refused but records were produced");
        return true;
    }

    private static void AssertInterceptions(JsonNode? expect, IReadOnlyList<JsonObject> recorded, List<string> failures)
    {
        var expected = Array(expect?["interceptions"]);
        var recordedPoints = recorded.Select(c => (string?)c[Ip]).ToList();
        var pairs = new List<(JsonNode? Expected, JsonObject Recorded)>();
        if ((bool?)expect?["sequence_strict"] ?? true)
        {
            var expectedPoints = expected.Select(e => (string?)e?[Ip]).ToList();
            if (!recordedPoints.SequenceEqual(expectedPoints))
            {
                failures.Add($"interception sequence mismatch: expected [{string.Join(", ", expectedPoints)}], got [{string.Join(", ", recordedPoints)}]");
                return;
            }
            pairs.AddRange(expected.Zip(recorded));
        }
        else
        {
            var ri = 0;
            foreach (var e in expected)
            {
                var want = (string?)e?[Ip];
                while (ri < recorded.Count && recordedPoints[ri] != want) ri++;
                if (ri == recorded.Count)
                {
                    failures.Add($"expected interception point {Quote(want ?? "")} not found in sequence");
                    return;
                }
                pairs.Add((e, recorded[ri++]));
            }
        }
        foreach (var (e, r) in pairs)
        {
            var ip = (string?)r[Ip] ?? "";
            if ((bool?)e?["context_must_validate"] ?? true) ValidateRequest(r, failures);
            AssertPaths(e?["context"], r, $"{ip}: ", failures);
            var serialized = Json(r);
            foreach (var needle in Strings(e?["context_must_contain"]))
                if (!serialized.Contains(needle, StringComparison.Ordinal))
                    failures.Add($"{ip}: context does not contain {Quote(needle)}");
            foreach (var needle in Strings(e?["context_must_not_contain"]))
                if (serialized.Contains(needle, StringComparison.Ordinal))
                    failures.Add($"{ip}: context contains {Quote(needle)}, which MUST NOT surface here");
        }
        foreach (var absent in Strings(expect?["interceptions_absent"]))
            if (recordedPoints.Contains(absent))
                failures.Add($"interception point {Quote(absent)} was emitted but MUST be absent");
    }

    private static void ValidateRequest(JsonObject request, List<string> failures)
    {
        if (Points.Parse(request[Ip]) is not { } point)
        {
            failures.Add($"unknown interception point {Json(request[Ip])}");
            return;
        }
        foreach (var (pointer, message) in Schemas.Errors(request, Points.RequestSchema(point)))
            failures.Add($"{Points.Wire(point)}: request fails §4 validation at {pointer}: {message}");
    }

    private static string ExpectedOutcome(JsonNode? expect, JsonObject run, List<string> failures)
    {
        var basis = (string?)expect?["run_outcome"] ?? "";
        if (expect?["run_outcome_by_posture"] is not JsonObject by) return basis;
        var posture = (string?)by["posture"] ?? "";
        var fallback = posture switch { "tool_seam_host_error" => "continue", "on_error" => "deny", _ => null };
        if (fallback is null)
        {
            failures.Add($"run_outcome_by_posture names unknown posture {Quote(posture)}");
            return basis;
        }
        var declared = (string?)run["postures"]?[posture] ?? fallback;
        if ((string?)by["outcomes"]?[declared] is { } outcome) return outcome;
        failures.Add($"declared posture {posture}={Quote(declared)} has no outcome in run_outcome_by_posture");
        return basis;
    }

    private static void AssertRun(JsonNode? expect, JsonObject run, List<string> failures)
    {
        var want = ExpectedOutcome(expect, run, failures);
        var outcome = (string)run["outcome"]!;
        if (outcome != want) failures.Add($"run_outcome == {Quote(outcome)}, want {Quote(want)}");
        if (expect is JsonObject e && e.ContainsKey("final_output") && !Equal(run["final_output"], e["final_output"]))
            failures.Add($"final_output == {Json(run["final_output"])}, want {Json(e["final_output"])}");
        var invocations = Array(run["tool_invocations"]);
        if (expect?["tool_invocations"] is JsonArray wanted && !Equal(invocations, wanted))
            failures.Add($"tool_invocations == {Json(invocations)}, want {Json(wanted)}");
        foreach (var name in Strings(expect?["tool_not_invoked"]))
            if (invocations.Any(i => (string?)i?["name"] == name))
                failures.Add($"tool {Quote(name)} was invoked but MUST NOT be");
    }

    private static void AssertIdentities(JsonNode? expect, JsonObject run, List<string> failures)
    {
        if ((bool?)expect?["identities_equal"] is not { } wantEqual) return;
        var records = Array(run["records"]);
        if (records.Count == 0)
        {
            failures.Add("expect.identities_equal is set but the run reported no records");
            return;
        }
        var differing = records.Select((r, i) => (r, i)).Where(p => !Equal(p.r?["input_identity"], p.r?["enforced_identity"])).Select(p => p.i).ToList();
        if (wantEqual && differing.Count != 0)
            failures.Add($"identities_equal: input != enforced at indices [{string.Join(", ", differing)}]");
        else if (!wantEqual && differing.Count == 0)
            failures.Add("identities_equal: expected input != enforced at some interception, but all pairs are equal");
    }

    private static void AssertRecords(JsonNode? expect, JsonObject run, List<string> failures)
    {
        if (expect?["records"] is not JsonArray expected) return;
        var records = Array(run["records"]);
        var ri = 0;
        foreach (var e in expected)
        {
            var ip = (string?)e?[Ip];
            while (ri < records.Count && (string?)records[ri]?[Ip] != ip) ri++;
            if (ri == records.Count)
            {
                failures.Add($"expected record for {Quote(ip ?? "")} not found in order");
                return;
            }
            var record = records[ri];
            var prefix = $"record[{ri}] {ip}: ";
            AssertPaths(e?["assert"], record, prefix, failures);
            foreach (var path in Strings(e?["absent"]))
                if (Lookup(record, path, out var got)) failures.Add($"{prefix}{path} present ({Json(got)}), want absent");
            foreach (var path in Strings(e?["present"]))
                if (!Lookup(record, path, out _)) failures.Add($"{prefix}{path} absent, want present");
            ri++;
        }
    }

    private static void AssertPaths(JsonNode? predicates, JsonNode? root, string prefix, List<string> failures)
    {
        if (predicates is not JsonObject obj) return;
        foreach (var (path, want) in obj)
        {
            if (!Lookup(root, path, out var got)) failures.Add($"{prefix}path {Quote(path)} did not resolve");
            else if (!Equal(got, want)) failures.Add($"{prefix}{path} == {Json(got)}, want {Json(want)}");
        }
    }

    /// <summary>Resolves a <c>a.b[0].c</c> path.</summary>
    private static bool Lookup(JsonNode? root, string path, out JsonNode? value)
    {
        path = LegacyTarget.Resolve(root, path);
        value = root;
        var start = 0;
        for (var i = 0; i <= path.Length; i++)
        {
            var ch = i < path.Length ? path[i] : '.';
            if (ch is not ('.' or '[')) continue;
            if (i > start && (value is not JsonObject obj || !obj.TryGetPropertyValue(path[start..i], out value))) return false;
            if (ch == '[')
            {
                var end = path.IndexOf(']', i);
                if (end < 0 || !int.TryParse(path.AsSpan(i + 1, end - i - 1), NumberStyles.None, CultureInfo.InvariantCulture, out var index)
                    || value is not JsonArray array || index >= array.Count)
                    return false;
                value = array[index];
                i = end;
            }
            start = i + 1;
        }
        return true;
    }

    /// <summary>JSON equality where integers compare by token and floats by value.</summary>
    private static bool Equal(JsonNode? left, JsonNode? right)
    {
        if (left is null || right is null) return left is null && right is null;
        if (left is JsonObject lo && right is JsonObject ro)
            return lo.Count == ro.Count && lo.All(p => ro.TryGetPropertyValue(p.Key, out var r) && Equal(p.Value, r));
        if (left is JsonArray la && right is JsonArray ra)
            return la.Count == ra.Count && la.Zip(ra).All(p => Equal(p.First, p.Second));
        if (left.GetValueKind() != right.GetValueKind()) return false;
        if (left.GetValueKind() != JsonValueKind.Number) return JsonNode.DeepEquals(left, right);
        var (l, r) = (Json(left), Json(right));
        var (lf, rf) = (IsFloat(l), IsFloat(r));
        return lf == rf && (lf ? double.Parse(l, CultureInfo.InvariantCulture) == double.Parse(r, CultureInfo.InvariantCulture) : l == r);
    }

    private static bool IsFloat(string number) => number.IndexOfAny(['.', 'e', 'E']) >= 0;

    private static long? Integer(JsonNode? node) =>
        node?.GetValueKind() == JsonValueKind.Number && Json(node) is var raw && !IsFloat(raw)
        && long.TryParse(raw, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var n) ? n : null;

    private static JsonArray Array(JsonNode? node) => node as JsonArray ?? [];

    private static IEnumerable<string> Strings(JsonNode? node) =>
        Array(node).Select(n => n is JsonValue v && v.TryGetValue(out string? s) ? s : null).OfType<string>();

    private static string Json(JsonNode? node) => node?.ToJsonString(Compact) ?? "null";

    private static string Quote(string value) => JsonSerializer.Serialize(value, Compact);
}
