// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// CTK runner: load vectors, drive an IHarness, assert `expect`.
//
// The assertion engine, capability skip check, and scripted
// interceptor/resolver evaluation live in the Rust core (Native.Ctk*).
// This class keeps only vector globbing, the harness setup/run/teardown
// orchestration (native callbacks), RunRecord marshalling and, for the
// declaration parts (§7.7.9), the CTK registry and the construction
// path proof. See conformance/RUNNER.md.

using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentHooks.Conformance;

public sealed record VectorResult(
    string Id, string Title, string Status,
    string Detail, IReadOnlyList<string> Failures);

/// <summary>What loading a vector's host declaration produced
/// (§7.7.9): <c>accepted</c> or <c>refused</c>, the
/// <c>declaration_error:*</c> code on refusal, and whether the value,
/// JSON, file and builder paths resolved to one canonical form (or
/// refused with one class).</summary>
public sealed record LoadRecord(
    string Outcome, string? Class, bool PathsEquivalent, string? Detail)
{
    public JsonObject ToWire()
    {
        var o = new JsonObject { ["outcome"] = Outcome };
        if (Class is not null) o["class"] = Class;
        o["paths_equivalent"] = PathsEquivalent;
        if (Detail is not null) o["detail"] = Detail;
        return o;
    }
}

public static class Runner
{
    private static readonly JsonSerializerOptions Compact = new() { WriteIndented = false };

    public static IEnumerable<JsonObject> LoadVectors(string directory)
    {
        var files = Directory.EnumerateFiles(directory, "AH-CTK-*.json").OrderBy(p => p).ToList();
        if (files.Count == 0)
            // A runner fed zero vectors reports 100% pass — a false
            // conformance signal (§13.2). Fail loudly instead.
            throw new FileNotFoundException($"no AH-CTK-*.json vectors found in {directory}");
        foreach (var f in files)
            yield return (JsonObject)JsonNode.Parse(File.ReadAllText(f))!;
    }

    public static async Task<VectorResult> RunVectorAsync(
        IHarness harness, JsonObject vector, CancellationToken ct = default)
    {
        var id = (string)vector["id"]!;
        var title = (string)vector["title"]!;
        var vectorJson = vector.ToJsonString(Compact);

        // §7.7.9: a harness with its own declaration is assessed against
        // the resolved document, so what ran is what a claim cites.
        var codeSurface = harness.HostSurface;
        IEnumerable<string> capabilities;
        string posture;
        if (harness.Declaration is { } own)
        {
            var assessed = AssessOwnDeclaration(own, codeSurface);
            if (assessed.Refused is { } refused)
                return new VectorResult(id, title, "fail", "",
                    [$"harness declaration refused: {refused}"]);
            capabilities = assessed.Capabilities;
            posture = assessed.Posture;
        }
        else
        {
            capabilities = harness.Capabilities.Select(c => c.ToWireName());
            posture = harness.ToolSeamHostError;
        }

        // Capability skip via core.
        var caps = new JsonArray(
            capabilities.Order(StringComparer.Ordinal).Select(c => (JsonNode)c).ToArray());
        var skip = JsonNode.Parse(
            Native.CtkShouldSkip(vectorJson, caps.ToJsonString(Compact)));
        if (skip is JsonValue sv && sv.TryGetValue(out string? reason))
            return new VectorResult(id, title, "skip", reason!, []);

        var scenario = Scenario.FromWire((JsonObject)vector["scenario"]!);
        var scripts = new Scripts(vector);

        var mode = (string?)vector["mode"] == "evaluate_only"
            ? EnforcementMode.EvaluateOnly : EnforcementMode.Enforce;

        // §13.2: composition vectors carry the profile/knobs they apply
        // to; absent means the pre-P-003 default.
        var composition = vector["composition"] is JsonObject co
            ? CompositionConfig.FromWire(co)
            : CompositionConfig.Default;

        // §10.1: absent → the default provider; explicit null → unbound.
        var identityProvider = vector.ContainsKey("identity_provider")
            ? (string?)vector["identity_provider"]
            : Spec.JcsSha256;

        RunRecord rr;
        LoadRecord? load = null;
        if (vector["host_declaration"] is JsonObject document)
        {
            // §7.7.9: a declaration vector builds the emitter through
            // the loader. The runner proves the construction paths
            // itself, then hands the document and the CTK registry to
            // the harness.
            var registry = scripts.Registry(codeSurface);
            var (pathsEquivalent, pathDetail) = ProvePaths(document, registry, id);
            try
            {
                harness.SetupDeclared(scenario, (JsonObject)document.DeepClone(), registry);
            }
            catch (DeclarationException e)
            {
                harness.Teardown();
                load = new LoadRecord(
                    "refused", e.Code, pathsEquivalent,
                    pathDetail.Length == 0 ? e.Message : $"{e.Message}; paths: {pathDetail}");
                rr = new RunRecord(RunOutcome.Error, null, [], e.Message);
                return Assert(vectorJson, id, title, scripts.Recorded, rr, posture, load);
            }
            try
            {
                rr = await harness.RunAsync(ct);
            }
            catch (Exception e)
            {
                return new VectorResult(id, title, "fail", "",
                    [$"harness.RunAsync raised: {e}"]);
            }
            finally
            {
                harness.Teardown();
            }
            load = new LoadRecord(
                "accepted", null, pathsEquivalent,
                pathDetail.Length == 0 ? null : pathDetail);
        }
        else
        {
            harness.Setup(
                scenario, scripts.Interceptors(), scripts.Resolver(), mode, composition,
                identityProvider, scripts.Redact);
            try
            {
                rr = await harness.RunAsync(ct);
            }
            catch (Exception e)
            {
                return new VectorResult(id, title, "fail", "",
                    [$"harness.RunAsync raised: {e}"]);
            }
            finally
            {
                harness.Teardown();
            }
        }

        return Assert(vectorJson, id, title, scripts.Recorded, rr, posture, load);
    }

    private static VectorResult Assert(
        string vectorJson, string id, string title,
        List<JsonObject> recorded, RunRecord rr, string posture, LoadRecord? load)
    {
        var recordedJson = new JsonArray(
            recorded.Select(c => (JsonNode)c.DeepClone()).ToArray()).ToJsonString(Compact);
        var rrJson = RunRecordToWire(rr, posture, load);
        var result = (JsonObject)JsonNode.Parse(
            Native.CtkAssert(vectorJson, recordedJson, rrJson))!;
        return new VectorResult(
            (string?)result["id"] ?? id,
            (string?)result["title"] ?? title,
            (string)result["status"]!,
            (string?)result["detail"] ?? "",
            (result["failures"] as JsonArray)?.Select(n => (string)n!).ToList() ?? []);
    }

    /// <summary>What a harness's own declaration resolves to: the
    /// capabilities and posture a run is assessed against, or the
    /// refusal that fails the run.</summary>
    private sealed record AssessedSurface(
        IReadOnlyList<string> Capabilities, string Posture, string? Refused);

    /// <summary>Resolutions of harness declarations, keyed on the
    /// document text and the code surface. The pair fixes the result,
    /// so one entry serves every vector of a run and every harness
    /// instance that ships the same document: §7.7.9 resolves the
    /// document once, before any vector runs, not once per vector.</summary>
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, AssessedSurface>
        OwnDeclarations = new(StringComparer.Ordinal);

    /// <summary>Resolve a harness's own document against its code
    /// surface (steps 2 to 8 of §7.7.6). The references and kinds it
    /// names are the host's to register per run, so they are not
    /// checked here; the CTK registry a vector builds is checked when
    /// that vector's document is loaded.</summary>
    private static AssessedSurface AssessOwnDeclaration(JsonObject own, HostSurface codeSurface)
    {
        var text = own.ToJsonString(Compact);
        var key = text + "\n" + codeSurface.ToWire().ToJsonString(Compact);
        return OwnDeclarations.GetOrAdd(key, _ =>
        {
            try
            {
                var resolved = HostDeclaration.FromJson(text).ResolveSurfaceOnly(codeSurface);
                return new AssessedSurface(
                    resolved.SurfaceCapabilities.Order(StringComparer.Ordinal).ToList(),
                    resolved.ToolSeamHostError.ToWireName(),
                    null);
            }
            catch (DeclarationException e)
            {
                return new AssessedSurface([], "", e.Message);
            }
        });
    }

    /// <summary>Resolve <paramref name="document"/> through the four
    /// construction paths (§7.7.7) and compare: value, JSON text, a
    /// temporary file and the builder. Equal canonical forms, or equal
    /// refusal classes, prove the paths equivalent.</summary>
    public static (bool Equivalent, string Detail) ProvePaths(
        JsonObject document, HostRegistry registry, string tag)
    {
        var text = document.ToJsonString(Compact);
        var path = Path.Combine(
            Path.GetTempPath(),
            $"agent-hooks-ctk-{tag}-{Environment.ProcessId}-{DateTime.UtcNow.Ticks}.json");
        var outcomes = new List<(string Name, string Key, string Short)>
        {
            Outcome("value", () => HostDeclaration.FromNode(document).Resolve(registry)),
            Outcome("json", () => HostDeclaration.FromJson(text).Resolve(registry)),
            Outcome("file", () =>
            {
                try
                {
                    File.WriteAllText(path, text);
                    return HostDeclaration.FromPath(path).Resolve(registry);
                }
                finally
                {
                    try { File.Delete(path); } catch (IOException) { }
                }
            }),
            Outcome("builder", () => BuilderFromNode(document).Build().Resolve(registry)),
        };
        if (outcomes.All(o => o.Key == outcomes[0].Key))
            return (true, "");
        var detail = string.Concat(outcomes.Select(o => $"{o.Name}: {o.Short}; "));
        var oks = outcomes.Where(o => o.Key.StartsWith("ok:", StringComparison.Ordinal)).ToList();
        if (oks.Count >= 2 && oks[0].Key != oks[1].Key)
        {
            var a = oks[0].Key; var b = oks[1].Key;
            var pos = 0;
            while (pos < a.Length && pos < b.Length && a[pos] == b[pos]) pos++;
            detail += $"first difference at byte {pos}";
        }
        return (false, detail);

        static (string, string, string) Outcome(string name, Func<ResolvedDeclaration> f)
        {
            try
            {
                return (name, "ok:" + f().CanonicalJson(), "accepted");
            }
            catch (DeclarationException e)
            {
                return (name, "err:" + e.Code, e.Message);
            }
        }
    }

    /// <summary>Rebuild a document through <see cref="DeclarationBuilder"/>,
    /// member by member (§7.7.7, the code path). Members the typed
    /// setters cannot express exactly (an unknown member, a wrong type)
    /// go through <see cref="DeclarationBuilder.Raw"/>, so the result is
    /// validated like the file it came from.</summary>
    public static DeclarationBuilder BuilderFromNode(JsonObject document)
    {
        var b = DeclarationBuilder.Empty();
        foreach (var (key, value) in document)
        {
            switch (key, value)
            {
                case ("declaration", JsonValue v) when v.TryGetValue(out string? s):
                    b.Version(s);
                    break;
                case ("spec", JsonValue v) when v.TryGetValue(out string? s):
                    b.Spec(s);
                    break;
                case ("id", JsonValue v) when v.TryGetValue(out string? s):
                    b.Id(s);
                    break;
                case ("host", JsonObject h)
                    when h.All(kv => kv.Key is "name" or "version")
                        && IsString(h["name"], out var hostName)
                        && (h["version"] is null && !h.ContainsKey("version")
                            || IsString(h["version"], out _)):
                    b.Host(hostName, h.ContainsKey("version") ? (string?)h["version"] : null);
                    break;
                case ("configuration", JsonObject c) when TypedConfiguration(c) is { } apply:
                    foreach (var a in apply) a(b);
                    break;
                case ("surface", JsonObject sf) when TypedSurface(sf) is { } apply:
                    foreach (var a in apply) a(b);
                    break;
                case ("bindings", JsonArray items) when TypedBindings(items) is { } apply:
                    foreach (var a in apply) a(b);
                    break;
                case ("extensions", JsonObject e):
                    foreach (var (ek, ev) in e) b.Extension(ek, ev);
                    break;
                default:
                    b.Raw(key, value);
                    break;
            }
        }
        return b;
    }

    private static bool IsString(JsonNode? n, out string s)
    {
        if (n is JsonValue v && v.TryGetValue(out string? got))
        {
            s = got;
            return true;
        }
        s = "";
        return false;
    }

    /// <summary>A JSON integer without fraction or exponent, zero or more.</summary>
    private static bool IsUInt(JsonNode? n, out long value)
    {
        value = 0;
        return n is JsonValue v && v.TryGetValue(out value) && value >= 0;
    }

    private static List<Action<DeclarationBuilder>>? TypedConfiguration(JsonObject c)
    {
        var apply = new List<Action<DeclarationBuilder>>();
        foreach (var (k, v) in c)
        {
            switch (k)
            {
                case "mode" when IsString(v, out var m) && m is "enforce" or "evaluate_only":
                    var mode = m == "evaluate_only" ? EnforcementMode.EvaluateOnly : EnforcementMode.Enforce;
                    apply.Add(b => b.Mode(mode));
                    break;
                case "composition" when v is JsonObject comp
                    && comp.All(kv => kv.Key is "profile" or "on_approval" or "on_disagreement" or "on_transform_conflict"):
                    var profile = CompositionProfile.SequentialFirstDeny;
                    if (comp.ContainsKey("profile"))
                    {
                        if (!IsString(comp["profile"], out var p)) return null;
                        try { profile = CompositionProfileExtensions.FromWireName(p); }
                        catch (ArgumentOutOfRangeException) { return null; }
                    }
                    OnApproval? onApproval = null;
                    SynthesisPolicy? onDisagreement = null, onTransformConflict = null;
                    foreach (var (kk, vv) in comp)
                    {
                        if (kk == "profile") continue;
                        if (!IsString(vv, out var s)) return null;
                        switch (kk, s)
                        {
                            case ("on_approval", "stop"): onApproval = OnApproval.Stop; break;
                            case ("on_approval", "resume"): onApproval = OnApproval.Resume; break;
                            case ("on_disagreement", "deny"): onDisagreement = SynthesisPolicy.Deny; break;
                            case ("on_disagreement", "approval"): onDisagreement = SynthesisPolicy.Approval; break;
                            case ("on_transform_conflict", "deny"): onTransformConflict = SynthesisPolicy.Deny; break;
                            case ("on_transform_conflict", "approval"): onTransformConflict = SynthesisPolicy.Approval; break;
                            default: return null;
                        }
                    }
                    var cfg = new CompositionConfig(profile, onApproval, onDisagreement, onTransformConflict);
                    apply.Add(b => b.Composition(cfg));
                    break;
                case "identity_provider" when v is null:
                    apply.Add(b => b.IdentityProvider(null));
                    break;
                case "identity_provider" when IsString(v, out var ip):
                    apply.Add(b => b.IdentityProvider(ip));
                    break;
                case "approval" when v is JsonObject a:
                    foreach (var (ak, av) in a)
                    {
                        string? name;
                        if (av is null) name = null;
                        else if (IsString(av, out var n)) name = n;
                        else return null;
                        switch (ak)
                        {
                            case "resolver": apply.Add(b => b.ApprovalResolver(name)); break;
                            case "redactor": apply.Add(b => b.ApprovalRedactor(name)); break;
                            default: return null;
                        }
                    }
                    break;
                case "posture" when v is JsonObject p && p.Count == 1
                    && IsString(p["tool_seam_host_error"], out var posture)
                    && posture is "continue" or "terminate":
                    var tsp = posture == "terminate" ? ToolSeamPosture.Terminate : ToolSeamPosture.Continue;
                    apply.Add(b => b.ToolSeamHostError(tsp));
                    break;
                case "timeouts" when v is JsonObject t:
                    foreach (var (tk, tv) in t)
                    {
                        long? ms;
                        if (tv is null) ms = null;
                        else if (IsUInt(tv, out var n)) ms = n;
                        else return null;
                        switch (tk)
                        {
                            case "interceptor_ms": apply.Add(b => b.InterceptorTimeoutMs(ms)); break;
                            case "approval_resolver_ms": apply.Add(b => b.ApprovalResolverTimeoutMs(ms)); break;
                            default: return null;
                        }
                    }
                    break;
                case "records" when v is JsonObject r && r.Count == 1 && r.ContainsKey("max_buffered"):
                    if (r["max_buffered"] is null) apply.Add(b => b.MaxBufferedRecords(null));
                    else if (IsUInt(r["max_buffered"], out var n)) apply.Add(b => b.MaxBufferedRecords(n));
                    else return null;
                    break;
                default:
                    return null;
            }
        }
        return apply;
    }

    private static List<InterceptionPoint>? PointsOf(JsonNode? v)
    {
        if (v is not JsonArray a) return null;
        var points = new List<InterceptionPoint>();
        foreach (var n in a)
        {
            if (!IsString(n, out var s)) return null;
            try { points.Add(InterceptionPointExtensions.FromWireName(s)); }
            catch (ArgumentOutOfRangeException) { return null; }
        }
        return points;
    }

    private static List<string>? StringsOf(JsonNode? v)
    {
        if (v is not JsonArray a) return null;
        var strings = new List<string>();
        foreach (var n in a)
        {
            if (!IsString(n, out var s)) return null;
            strings.Add(s);
        }
        return strings;
    }

    private static List<Action<DeclarationBuilder>>? TypedSurface(JsonObject sf)
    {
        var apply = new List<Action<DeclarationBuilder>>();
        bool? buffered = null;
        if (sf.ContainsKey("buffered_output"))
        {
            if (sf["buffered_output"] is not JsonValue bv || !bv.TryGetValue(out bool bb)) return null;
            buffered = bb;
        }
        string? bound = null;
        if (sf.ContainsKey("exposure_bound"))
        {
            if (!IsString(sf["exposure_bound"], out var eb)) return null;
            bound = eb;
        }
        if (buffered is { } buf) apply.Add(b => b.BufferedOutput(buf, bound));
        else if (bound is not null) return null;
        foreach (var (k, v) in sf)
        {
            switch (k)
            {
                case "interception_points":
                    if (PointsOf(v) is not { } points) return null;
                    apply.Add(b => b.SurfacePoints(points));
                    break;
                case "capabilities":
                    if (StringsOf(v) is not { } caps) return null;
                    apply.Add(b => b.SurfaceCapabilities(caps));
                    break;
                case "declaration_versions":
                    if (StringsOf(v) is not { } versions) return null;
                    apply.Add(b => b.SurfaceDeclarationVersions(versions));
                    break;
                case "profiles":
                    if (v is not JsonObject profiles) return null;
                    foreach (var (name, knobs) in profiles)
                    {
                        CompositionProfile profile;
                        try { profile = CompositionProfileExtensions.FromWireName(name); }
                        catch (ArgumentOutOfRangeException) { return null; }
                        if (knobs is not JsonObject ko
                            || !ko.All(kv => kv.Key is "on_approval" or "on_disagreement" or "on_transform_conflict")
                            || ko.Any(kv => StringsOf(kv.Value) is null))
                            return null;
                        var support = KnobSupport.FromWire(ko);
                        apply.Add(b => b.SurfaceProfile(profile, support));
                    }
                    break;
                case "buffered_output":
                case "exposure_bound":
                    break;
                default:
                    return null;
            }
        }
        return apply;
    }

    private static List<Action<DeclarationBuilder>>? TypedBindings(JsonArray items)
    {
        var apply = new List<Action<DeclarationBuilder>>();
        if (items.Count == 0)
        {
            // The written-down empty-deny host (§7.7.5): Bind is never
            // called, so the member is set explicitly.
            apply.Add(b => b.Raw("bindings", new JsonArray()));
            return apply;
        }
        foreach (var item in items)
        {
            if (item is not JsonObject o
                || !o.All(kv => kv.Key is "id" or "kind" or "config" or "at" or "timeout_ms")
                || !IsString(o["id"], out var id)
                || !IsString(o["kind"], out var kind))
                return null;
            var config = o["config"]?.DeepClone() ?? new JsonObject();
            List<InterceptionPoint>? at = null;
            if (o.ContainsKey("at") && (at = PointsOf(o["at"])) is null) return null;
            long? timeout = null;
            var unbounded = false;
            if (o.ContainsKey("timeout_ms"))
            {
                if (o["timeout_ms"] is null) unbounded = true;
                else if (IsUInt(o["timeout_ms"], out var t)) timeout = t;
                else return null;
            }
            apply.Add(b => b.Bind(id, kind, config, at, timeout, unbounded));
        }
        return apply;
    }

    private static string RunRecordToWire(RunRecord rr, string toolSeamHostError, LoadRecord? load)
    {
        var identities = new JsonArray();
        foreach (var (i, e) in rr.Identities ?? [])
            identities.Add(new JsonObject
            {
                ["input_identity"] = i,
                ["enforced_identity"] = e,
            });
        var records = new JsonArray(
            (rr.Records ?? []).Select(r => (JsonNode)r.DeepClone()).ToArray());
        var o = new JsonObject
        {
            ["outcome"] = rr.Outcome.ToWireName(),
            ["final_output"] = rr.FinalOutput?.DeepClone(),
            ["tool_invocations"] = new JsonArray(
                rr.ToolInvocations.Select(t => (JsonNode)t.DeepClone()).ToArray()),
            ["error"] = rr.Error,
            ["identities"] = identities,
            ["records"] = records,
            // Harness *declarations* (§13.1), not observed behavior: the
            // engine selects expect.run_outcome_by_posture entries by them.
            ["postures"] = new JsonObject
            {
                ["tool_seam_host_error"] = toolSeamHostError,
            },
        };
        if (load is not null) o["load"] = load.ToWire();
        return o.ToJsonString(Compact);
    }

    /// <summary>The scripted interceptors and resolver a vector carries,
    /// shared by the field-based and the declaration path.</summary>
    private sealed class Scripts
    {
        private readonly List<string> _scripts;
        private readonly string _approval;

        public Scripts(JsonObject vector)
        {
            // Multi-interceptor vectors (§7.1 fold-through) use
            // interceptor_scripts; single-interceptor vectors use
            // interceptor_script. Only the FIRST interceptor records:
            // expect.interceptions describes each emission as the
            // first-registered interceptor saw it. An empty
            // interceptor_scripts registers zero interceptors (§7
            // fail-closed vector).
            if (vector["interceptor_scripts"] is JsonArray multi)
                _scripts = multi.Select(s => s!.ToJsonString(Compact)).ToList();
            else
                _scripts = [(vector["interceptor_script"] ?? new JsonArray()).ToJsonString(Compact)];
            _approval = (vector["approval_script"] ?? new JsonArray()).ToJsonString(Compact);
            Redact = vector["redact_for_approval"] is JsonArray ra
                ? ra.Select(n => (string)n!).ToList()
                : [];
        }

        public List<JsonObject> Recorded { get; } = [];

        public List<string> Redact { get; }

        /// <summary>Scripted interceptor <paramref name="i"/>; only index 0 records.</summary>
        private IInterceptor Interceptor(int i) => i == 0
            ? new RecordingScriptedInterceptor(_scripts[i], Recorded)
            : new ScriptedInterceptor(_scripts[i]);

        public List<IInterceptor> Interceptors() =>
            Enumerable.Range(0, _scripts.Count).Select(Interceptor).ToList();

        public IApprovalResolver? Resolver() =>
            _approval == "[]" ? null : new ScriptedResolver(_approval);

        /// <summary>The CTK registry for a declaration vector (§7.7.9):
        /// kind <c>ctk.scripted</c> (config <c>{"script": i}</c>),
        /// identity provider <c>ctk-fault</c>, approval resolver
        /// <c>ctk-scripted</c>, redactor <c>ctk-redact</c>.</summary>
        public HostRegistry Registry(HostSurface surface)
        {
            var approval = _approval;
            var redact = Redact.ToList();
            return HostRegistry.ForConformance(surface)
                .Kind("ctk.scripted", (config, ctx) =>
                {
                    if (config?["script"] is not JsonValue v || !v.TryGetValue(out long i) || i < 0)
                        throw new InvalidOperationException("config.script must be an unsigned integer index");
                    if (i >= _scripts.Count)
                        throw new InvalidOperationException(
                            $"config.script {i} is out of range for binding {ctx.Id}");
                    return Interceptor((int)i);
                })
                .IdentityProvider("ctk-fault", _ => throw new InvalidOperationException("ctk scripted provider fault"))
                .ApprovalResolver("ctk-scripted", new ScriptedResolver(approval))
                .ApprovalRedactor("ctk-redact", ReferenceHarness.Redactor(redact));
        }
    }

    /// <summary>A §5-invalid verdict shape (transform decision, no body)
    /// used to surface scripted stale wire vocabulary through the §5 gate
    /// (fail closed into <c>host_error:verdict_invalid</c>).</summary>
    private static Verdict InvalidVerdict() => new(Decision.Transform);

    /// <summary>Replays one interceptor rule list via the Rust core.</summary>
    private class ScriptedInterceptor(string rulesJson) : IInterceptor
    {
        protected readonly string RulesJson = rulesJson;

        public virtual ValueTask<Verdict> InterceptAsync(
            AgentContext ctx, CancellationToken ct = default)
        {
            var w = (JsonObject)JsonNode.Parse(
                Native.CtkScriptedIntercept(RulesJson, ctx.Json.ToJsonString(Compact)))!;
            if (w.ContainsKey("__ctk_fault__"))
            {
                if ((string?)w["__ctk_fault__"] == "mutate")
                {
                    // §7 isolation fault (TM-05): tamper with the received
                    // context in-place; the emitter's copy isolation must
                    // keep enforcement, identity, and siblings unaffected.
                    ctx.Json["target"] = "TAMPERED";
                    if (ctx.Json["tool_call"] is JsonObject tc)
                        tc["args"] = new JsonObject { ["tampered"] = true };
                    return ValueTask.FromResult(
                        new Verdict(Decision.Allow) { Reason = "ctk:mutated" });
                }
                // Fault injection: exercise §6.3 interceptor_failed.
                throw new InvalidOperationException("ctk scripted fault: raise");
            }
            try
            {
                return ValueTask.FromResult(Verdict.FromWire(w));
            }
            catch (ArgumentOutOfRangeException)
            {
                // A scripted verdict in the superseded five-verdict
                // vocabulary (pre-P-003 `warn`/`escalate`) fails the §5
                // gate (fail closed): the closed set is three (§5.1).
                return ValueTask.FromResult(InvalidVerdict());
            }
        }
    }

    /// <summary>Records every ctx (deep copy) then replays the rules.</summary>
    private sealed class RecordingScriptedInterceptor(
        string rulesJson, List<JsonObject> recorded) : ScriptedInterceptor(rulesJson)
    {
        public override ValueTask<Verdict> InterceptAsync(
            AgentContext ctx, CancellationToken ct = default)
        {
            recorded.Add((JsonObject)ctx.Json.DeepClone());
            return base.InterceptAsync(ctx, ct);
        }
    }

    /// <summary>Replays the vector's approval_script via the Rust core.</summary>
    private sealed class ScriptedResolver(string rulesJson) : IApprovalResolver
    {
        public ValueTask<ApprovalResolution> ResolveAsync(
            ApprovalRequest req, CancellationToken ct = default)
        {
            // §10.1: identity may be null (null provider). The scripted
            // engine works in strings; "" round-trips to null below.
            var r = (JsonObject)JsonNode.Parse(
                Native.CtkScriptedResolve(
                    rulesJson, req.Context.Json.ToJsonString(Compact),
                    req.ContextIdentity ?? ""))!;
            if (r.ContainsKey("__ctk_fault__"))
            {
                // Fault injection: exercise §9 approval_resolver_failed.
                throw new InvalidOperationException("ctk scripted fault: raise");
            }
            var outcome = (string)r["outcome"]! switch
            {
                "approve" => ApprovalOutcome.Approve,
                "reject" => ApprovalOutcome.Reject,
                _ => ApprovalOutcome.Unresolved,
            };
            Verdict? v;
            try
            {
                v = r["verdict"] is JsonObject vw ? Verdict.FromWire(vw) : null;
            }
            catch (ArgumentOutOfRangeException)
            {
                // Superseded wire vocabulary fails the §5 gate (fail closed).
                v = InvalidVerdict();
            }
            var echoed = (string?)r["context_identity"] ?? "";
            return ValueTask.FromResult(new ApprovalResolution(
                outcome,
                echoed.Length == 0 && req.ContextIdentity is null ? null : echoed,
                v));
        }
    }
}
