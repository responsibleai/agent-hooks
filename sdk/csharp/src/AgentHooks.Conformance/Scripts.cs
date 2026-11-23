// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json.Nodes;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks.Conformance;

/// <summary>
/// The scripted interceptors, resolver and redactor a vector describes (conformance/HARNESS.md), adapted to the
/// draft wire: scripts return bare verdicts and legacy <c>$target</c> transform paths, which become whole-member
/// hook responses (§5) here.
/// </summary>
internal sealed class Scripts
{
    private static readonly TimeSpan HangGrace = TimeSpan.FromSeconds(10);

    private readonly List<JsonArray> _interceptors;
    private readonly JsonArray _approval;
    private readonly List<string> _redact;

    public Scripts(JsonObject vector)
    {
        // Only the first interceptor records: expect.interceptions describes what it saw.
        _interceptors = vector["interceptor_scripts"] is JsonArray multi
            ? multi.Select(s => s!.AsArray()).ToList()
            : [vector["interceptor_script"] as JsonArray ?? []];
        _approval = vector["approval_script"] as JsonArray ?? [];
        _redact = (vector["redact_for_approval"] as JsonArray ?? []).Select(p => (string)p!).ToList();
    }

    public List<JsonObject> Recorded { get; } = [];

    public IEnumerable<IHookInterceptor> Interceptors() => Enumerable.Range(0, _interceptors.Count).Select(Interceptor);

    public IApprovalResolver? Resolver => _approval.Count == 0 ? null : new ScriptedResolver(_approval);

    public Func<JsonObject, JsonObject>? Redactor => _redact.Count == 0 ? null : Redact;

    /// <summary>The CTK registry for declaration vectors (§13.2).</summary>
    public HostRegistry Registry(HostSurface surface) => new HostRegistry(surface)
        .AddKind("ctk.scripted", Bind)
        .AddKind("ctk.managed", Bind)
        .AddIdentityProvider(FaultingProvider)
        .AddApprovalResolver("ctk-scripted", new ScriptedResolver(_approval))
        .AddApprovalRedactor("ctk-redact", Redact);

    /// <summary>A custom provider that always throws, pinning the §10.1 provider-failure rule.</summary>
    public static IdentityProvider FaultingProvider { get; } =
        new("ctk-fault", _ => throw new InvalidOperationException("ctk scripted provider fault"));

    private IHookInterceptor Bind(BindingDefinition binding)
    {
        if (binding.Config?["script"] is not JsonValue v || !v.TryGetValue(out long index) || index < 0)
            throw new InvalidOperationException("config.script must be an unsigned integer index");
        if (index >= _interceptors.Count)
            throw new InvalidOperationException($"config.script {index} is out of range for binding {binding.Id}");
        return Interceptor((int)index);
    }

    private ScriptedInterceptor Interceptor(int index) => new(_interceptors[index], index == 0 ? Recorded : null);

    private JsonObject Redact(JsonObject context)
    {
        foreach (var path in _redact) LegacyTarget.TrySet(context, path, "[redacted]");
        return context;
    }

    private sealed class ScriptedInterceptor(JsonArray rules, List<JsonObject>? recorded) : IHookInterceptor
    {
        public async ValueTask<HookOutcome> InterceptAsync(HookCall call, CancellationToken cancellationToken)
        {
            recorded?.Add((JsonObject)call.Request.DeepClone());
            var point = (string?)call.Request["interception_point"];
            var rule = rules.FirstOrDefault(r => (string?)r!["at"] == point && CtkEngine.Matches(call.Request, r!["match"]));
            switch ((string?)rule?["fault"])
            {
                case "raise":
                    throw new InvalidOperationException("ctk scripted fault: raise");
                case "hang":
                    await Task.Delay(HangGrace, cancellationToken);
                    return Respond(new JsonObject { ["decision"] = "allow" });
                case "cancel":
                    return HookOutcome.Cancellation;
                case "mutate":
                    // §7 isolation: tamper with the received copy; enforcement and siblings must be unaffected.
                    if (call.Request["tool_call"] is JsonObject toolCall) toolCall["args"] = new JsonObject { ["tampered"] = true };
                    return Respond(new JsonObject { ["decision"] = "allow", ["reason"] = "ctk:mutated" });
                case "malformed_verdict":
                    return Respond(new JsonObject { ["decision"] = "transform" });
            }
            var verdict = rule?["return"] as JsonObject ?? new JsonObject { ["decision"] = "allow" };
            return Respond(LegacyTarget.Translate(call.Request, verdict));
        }

        private static HookOutcome Respond(JsonObject verdict) => new JsonObject { ["verdict"] = verdict };
    }

    private sealed class ScriptedResolver(JsonArray rules) : IApprovalResolver
    {
        public ValueTask<JsonObject> ResolveAsync(JsonObject request, CancellationToken cancellationToken)
        {
            var context = request["context"]?.AsObject() ?? [];
            var identity = request["context_identity"]?.DeepClone();
            var resolve = rules.FirstOrDefault(r => CtkEngine.Matches(context, r!["match"]))?["resolve"];
            if (resolve is null) return ValueTask.FromResult(new JsonObject { ["outcome"] = "unresolved", ["context_identity"] = identity });
            if ((string?)resolve["fault"] == "raise") throw new InvalidOperationException("ctk scripted fault: raise");

            if (resolve["identity_override"] is JsonValue overridden) identity = overridden.DeepClone();
            else if ((bool?)resolve["echo_recomputed"] == true)
            {
                try { identity = Jcs.ContextIdentity(context); }
                catch (HookException) { identity = null; }
            }
            var resolution = new JsonObject { ["outcome"] = resolve["outcome"]?.DeepClone(), ["context_identity"] = identity };
            if (resolve["verdict"] is JsonObject verdict) resolution["verdict"] = LegacyTarget.Translate(context, verdict);
            return ValueTask.FromResult(resolution);
        }
    }
}

/// <summary>
/// The vectors still script the superseded <c>target</c> alias: <c>$target.x</c> transform paths and
/// <c>target.x</c> predicates. This maps them onto the draft request members.
/// </summary>
internal static class LegacyTarget
{
    /// <summary>The request member the legacy <c>target</c> aliased at each point.</summary>
    public static string[]? Path(JsonNode? request) => Points.Parse(request?["interception_point"]) switch
    {
        Draft.InterceptionPoint.AgentStartup => ["agent_init"],
        Draft.InterceptionPoint.AgentShutdown => ["summary"],
        { } point => Points.TransformTarget(point)?.Path,
        null => null,
    };

    /// <summary>Rewrites <c>target</c>/<c>target.x</c> to the aliased request path; other paths are returned unchanged.</summary>
    public static string Resolve(JsonNode? request, string path)
    {
        if (!(path == "target" || path.StartsWith("target.", StringComparison.Ordinal) || path.StartsWith("target[", StringComparison.Ordinal))
            || request?["target"] is not null || Path(request) is not { } target)
            return path;
        return string.Join('.', target) + path["target".Length..];
    }

    /// <summary>Sets a <c>$target.a.b</c> path on <paramref name="request"/> in place; false when it does not resolve.</summary>
    public static bool TrySet(JsonObject request, string path, JsonNode? value)
    {
        var segments = path.Split('.');
        if (segments[0] is not ("$target" or "$policy_target") || segments.Length < 2 || Path(request) is not { } target)
            return false;
        JsonNode? node = request;
        foreach (var key in target.Concat(segments[1..^1]))
            node = (node as JsonObject)?[key];
        if (node is not JsonObject parent) return false;
        parent[segments[^1]] = value?.DeepClone();
        return true;
    }

    /// <summary>
    /// Turns a scripted path transform <c>{path, value}</c> into the §5 whole-member transform. A path that does not
    /// resolve, or a point without a transform member, yields an empty transform, which fails the response schema.
    /// </summary>
    public static JsonObject Translate(JsonObject request, JsonObject verdict)
    {
        verdict = (JsonObject)verdict.DeepClone();
        if (verdict["transform"] is not JsonObject transform || transform["path"] is not JsonValue path) return verdict;
        var candidate = (JsonObject)request.DeepClone();
        var member = new JsonObject();
        if (TrySet(candidate, (string)path!, transform["value"])
            && Points.Parse(request["interception_point"]) is { } point
            && Points.TransformTarget(point) is var (name, memberPath))
        {
            member[name] = memberPath.Aggregate((JsonNode?)candidate, (node, key) => node?[key])?.DeepClone();
        }
        verdict["transform"] = member;
        return verdict;
    }
}
