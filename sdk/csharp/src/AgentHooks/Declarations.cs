// Copyright (c) Microsoft. All rights reserved.

using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Draft = AgentHooks.Contracts.Draft;
using static AgentHooks.Contracts.Draft.CapabilityExtensions;
using static AgentHooks.Contracts.Draft.CompositionProfileExtensions;
using static AgentHooks.Contracts.Draft.ConflictResolutionExtensions;
using static AgentHooks.Contracts.Draft.ModeExtensions;
using static AgentHooks.Contracts.Draft.OnApprovalExtensions;
using static AgentHooks.Contracts.Draft.OnErrorExtensions;
using static AgentHooks.Contracts.Draft.ToolSeamHostErrorExtensions;

namespace AgentHooks;

/// <summary>What the host's code can do (§13.1); a declaration's surface must be a subset of it.</summary>
public sealed record HostSurface(IReadOnlySet<Draft.Capability> Capabilities, Draft.ToolSeamHostError ToolSeamPosture = Draft.ToolSeamHostError.Continue)
{
    /// <summary>Model and tool calls with 64-bit and big-integer JSON, a buffered <c>continue</c> host.</summary>
    public static HostSurface Default { get; } = new(new HashSet<Draft.Capability>
    {
        Draft.Capability.HostDeclaration, Draft.Capability.ModelCalls, Draft.Capability.ToolCalls, Draft.Capability.ParallelToolCalls,
        Draft.Capability.MultiTurn, Draft.Capability.Int64Json, Draft.Capability.BigintJson,
    });

    /// <summary>The §3.2 floor plus the model and tool point pairs the capabilities imply.</summary>
    public IReadOnlySet<Draft.InterceptionPoint> InterceptionPoints => Points.All
        .Where(p => p switch
        {
            Draft.InterceptionPoint.PreModelCall or Draft.InterceptionPoint.PostModelCall => Capabilities.Contains(Draft.Capability.ModelCalls),
            Draft.InterceptionPoint.PreToolCall or Draft.InterceptionPoint.PostToolCall => Capabilities.Contains(Draft.Capability.ToolCalls),
            _ => true,
        })
        .ToHashSet();
}

/// <summary>One declared binding, handed to its kind's factory.</summary>
public sealed record BindingDefinition(string Id, string Kind, JsonNode? Config);

/// <summary>The named components a host declaration may reference (§7.7).</summary>
public sealed class HostRegistry(HostSurface? surface = null)
{
    internal readonly Dictionary<string, Func<BindingDefinition, IHookInterceptor>> Kinds = new(StringComparer.Ordinal);
    internal readonly Dictionary<string, IdentityProvider> IdentityProviders = new(StringComparer.Ordinal);
    internal readonly Dictionary<string, IApprovalResolver> Resolvers = new(StringComparer.Ordinal);
    internal readonly Dictionary<string, Func<JsonObject, JsonObject>> Redactors = new(StringComparer.Ordinal);
    internal Action<ControlFailureNotice>? Notifier;
    internal Action<Draft.InterceptionRecord>? Sink;

    /// <summary>The surface the host code can honour.</summary>
    public HostSurface Surface { get; } = surface ?? HostSurface.Default;

    /// <summary>Registers a factory for bindings of <paramref name="kind"/>.</summary>
    public HostRegistry AddKind(string kind, Func<BindingDefinition, IHookInterceptor> factory) => Add(Kinds, kind, factory);

    /// <summary>Registers a named context identity provider.</summary>
    public HostRegistry AddIdentityProvider(IdentityProvider provider) => Add(IdentityProviders, provider.Name, provider);

    /// <summary>Registers a named approval resolver.</summary>
    public HostRegistry AddApprovalResolver(string name, IApprovalResolver resolver) => Add(Resolvers, name, resolver);

    /// <summary>Registers a named approval redactor.</summary>
    public HostRegistry AddApprovalRedactor(string name, Func<JsonObject, JsonObject> redactor) => Add(Redactors, name, redactor);

    /// <summary>Sets the notifier invoked before an <c>on_error: continue</c> substitution.</summary>
    public HostRegistry OnControlFailure(Action<ControlFailureNotice> notifier)
    {
        Notifier = notifier;
        return this;
    }

    /// <summary>Sets the sink that receives every emitted interception record.</summary>
    public HostRegistry WithRecordSink(Action<Draft.InterceptionRecord> sink)
    {
        Sink = sink;
        return this;
    }

    private HostRegistry Add<T>(Dictionary<string, T> map, string name, T value)
    {
        ArgumentNullException.ThrowIfNull(value);
        map[name] = value;
        return this;
    }
}

/// <summary>A payload-free reason a declaration was refused: a JSON pointer into the document and a detail.</summary>
public sealed record DeclarationFinding(string Pointer, string Detail);

/// <summary>A refused host declaration (§7.7.6); <see cref="Code"/> is <c>declaration_error:&lt;class&gt;</c>.</summary>
public sealed class DeclarationException(string code, IReadOnlyList<DeclarationFinding> findings)
    : Exception($"{code}: {string.Join("; ", findings.Select(f => $"{(f.Pointer.Length == 0 ? "/" : f.Pointer)} {f.Detail}"))}")
{
    /// <summary>The <c>declaration_error:*</c> refusal class (§7.7.6).</summary>
    public string Code { get; } = code;

    /// <summary>Payload-free findings explaining why the declaration was refused.</summary>
    public IReadOnlyList<DeclarationFinding> Findings { get; } = findings;
}

public sealed partial class HookEmitter
{
    /// <summary>Builds an emitter from a draft host declaration document (§7.7).</summary>
    /// <exception cref="DeclarationException">The document is refused.</exception>
    public static HookEmitter FromDeclaration(string json, HostRegistry registry) => Declarations.Load(json, registry).Build();

    /// <inheritdoc cref="FromDeclaration(string, HostRegistry)"/>
    public static HookEmitter FromDeclarationFile(string path, HostRegistry registry) =>
        FromDeclaration(Declarations.ReadDocument(path), registry);

    /// <inheritdoc cref="FromDeclaration(string, HostRegistry)"/>
    public static HookEmitter FromDeclaration(Draft.HostDeclaration declaration, HostRegistry registry)
    {
        ArgumentNullException.ThrowIfNull(declaration);
        JsonObject wire;
        try { wire = ContractSerializer.Serialize(declaration); }
        catch (JsonException)
        {
            throw new DeclarationException("declaration_error:malformed", [new("", "not a valid I-JSON document")]);
        }
        return FromDeclaration(wire.ToJsonString(), registry);
    }

    /// <summary>The resolved declaration (every default filled), when built from one.</summary>
    internal JsonObject? Declaration { get; private init; }
}

/// <summary>The staged §7.7.6 declaration loader: each stage refuses with one error class before the next runs.</summary>
internal static class Declarations
{
    internal const int MaxDocumentBytes = 1 << 20;
    private const string Spec = "agent-hooks/draft";
    private static readonly Draft.InterceptionPoint[] Floor =
        [Draft.InterceptionPoint.AgentStartup, Draft.InterceptionPoint.Input, Draft.InterceptionPoint.Output, Draft.InterceptionPoint.AgentShutdown];
    private static readonly string[] Knobs = ["on_approval", "on_transform_conflict", "on_disagreement"];
    private static readonly JsonObject Schema = Schemas.Document(nameof(Draft.HostDeclaration));
    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    /// <summary>Reads a declaration file as BOM-less UTF-8 of at most <see cref="MaxDocumentBytes"/> bytes (§7.7.6).</summary>
    internal static string ReadDocument(string path)
    {
        byte[] bytes;
        try
        {
            if (!new FileInfo(path).Exists)
                throw Unreadable("the declaration is not a regular file");
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            bytes = new byte[MaxDocumentBytes + 1];
            var read = 0;
            for (int n; read < bytes.Length && (n = stream.Read(bytes, read, bytes.Length - read)) > 0;) read += n;
            if (read > MaxDocumentBytes)
                throw Unreadable($"the declaration exceeds {MaxDocumentBytes} bytes");
            Array.Resize(ref bytes, read);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Security.SecurityException or ArgumentException or NotSupportedException)
        {
            throw Unreadable($"the declaration cannot be read: {e.GetType().Name}");
        }
        if (bytes.AsSpan().StartsWith((ReadOnlySpan<byte>)[0xEF, 0xBB, 0xBF]))
            throw Unreadable("the declaration starts with a byte order mark");
        try { return StrictUtf8.GetString(bytes); }
        catch (DecoderFallbackException) { throw Unreadable("the declaration is not valid UTF-8"); }

        static DeclarationException Unreadable(string detail) => new("declaration_error:unreadable", [new("", detail)]);
    }

    private sealed class Findings : List<DeclarationFinding>
    {
        public void Bad(string pointer, string detail) => Add(new(pointer, detail));

        public void Refuse(string errorClass)
        {
            if (Count > 0) throw new DeclarationException("declaration_error:" + errorClass, [.. this]);
        }
    }

    internal static HookEmitterBuilder Load(string text, HostRegistry registry)
    {
        var doc = Parse(text);
        var f = new Findings();
        if (Str(doc["spec"]) != Spec) f.Bad("/spec", $"must be \"{Spec}\"");
        f.Refuse("spec_unsupported");

        Unknown(doc, Schema, "", f);
        f.Refuse("unknown_field");

        foreach (var (pointer, message) in Schemas.Errors(doc, nameof(Draft.HostDeclaration))) f.Bad(pointer, message);
        CheckIntegerTokens(text, f);
        if (!Jcs.InIntegerDomain(text)) f.Bad("", "an integer lies outside ±(2^53−1) (see spec §7.7.6)");
        f.Refuse("invalid_field");

        var host = registry.Surface;
        var surface = doc["surface"] as JsonObject;
        var points = Set<Draft.InterceptionPoint>(surface?["interception_points"], Draft.InterceptionPointExtensions.TryParseWire) ?? host.InterceptionPoints.ToHashSet();
        var caps = Set<Draft.Capability>(surface?["capabilities"], Draft.CapabilityExtensions.TryParseWire) ?? host.Capabilities.ToHashSet();
        var buffered = surface?["buffered_output"] is not JsonValue b || b.GetValue<bool>();
        var profiles = surface?["profiles"] as JsonObject;
        var cfg = doc["configuration"] as JsonObject;
        var composition = cfg?["composition"] as JsonObject;
        var profile = WireEnum.Parse<Draft.CompositionProfile>(Str(composition?["profile"]), Draft.CompositionProfileExtensions.TryParseWire) ?? Draft.CompositionProfile.SequentialFirstDeny;
        var profileWire = profile.ToWire();
        var knob = Knob(profile);
        CheckConsistency(doc, points, caps, buffered, profiles, composition, profileWire, knob, f);
        f.Refuse("inconsistent");

        foreach (var point in points.Where(p => !host.InterceptionPoints.Contains(p)).Select(Points.Wire))
            f.Bad("/surface/interception_points", $"the host does not emit {point}");
        foreach (var cap in caps.Where(c => !host.Capabilities.Contains(c)).Select(c => c.ToWire()))
            f.Bad("/surface/capabilities", $"the host does not have capability {cap}");
        if (!buffered && !host.Capabilities.Contains(Draft.Capability.Streaming))
            f.Bad("/surface/buffered_output", "the host buffers caller-bound output and cannot declare false");
        var posture = WireEnum.Parse<Draft.ToolSeamHostError>(Str(cfg?["posture"]?["tool_seam_host_error"]), Draft.ToolSeamHostErrorExtensions.TryParseWire) ?? Draft.ToolSeamHostError.Continue;
        if (posture != host.ToolSeamPosture)
            f.Bad("/configuration/posture/tool_seam_host_error", $"the host implements {host.ToolSeamPosture.ToWire()}");
        var defaultOnError = WireEnum.Parse<Draft.OnError>(Str(cfg?["failure"]?["on_error"]), Draft.OnErrorExtensions.TryParseWire) ?? Draft.OnError.Deny;
        if (registry.Notifier is null)
        {
            var declaredBindings = (JsonArray)doc["bindings"]!;
            var reportedDefault = false;
            for (var i = 0; i < declaredBindings.Count; i++)
            {
                var binding = (JsonObject)declaredBindings[i]!;
                var explicitOnError = WireEnum.Parse<Draft.OnError>(Str(binding["on_error"]), Draft.OnErrorExtensions.TryParseWire);
                if ((explicitOnError ?? defaultOnError) != Draft.OnError.Continue) continue;
                if (explicitOnError is not null)
                    f.Bad($"/bindings/{i}/on_error", "on_error: continue requires a control failure notifier (see spec §6.3.1)");
                else if (!reportedDefault)
                {
                    reportedDefault = true;
                    f.Bad("/configuration/failure/on_error", "on_error: continue requires a control failure notifier (see spec §6.3.1)");
                }
            }
        }
        f.Refuse("surface_unsupported");

        var builder = new HookEmitterBuilder()
            .WithMode(WireEnum.Parse<Draft.Mode>(Str(cfg?["mode"]), Draft.ModeExtensions.TryParseWire) ?? Draft.Mode.Enforce)
            .WithToolSeamPosture(posture)
            .WithDefaultOnError(defaultOnError);
        var knobValue = knob is null ? null : Str(composition?[knob]);
        builder.WithComposition(
            profile,
            WireEnum.Parse<Draft.OnApproval>(knob == "on_approval" ? knobValue : null, Draft.OnApprovalExtensions.TryParseWire) ?? Draft.OnApproval.Stop,
            WireEnum.Parse<Draft.ConflictResolution>(knob == "on_transform_conflict" ? knobValue : null, Draft.ConflictResolutionExtensions.TryParseWire) ?? Draft.ConflictResolution.Deny,
            WireEnum.Parse<Draft.ConflictResolution>(knob == "on_disagreement" ? knobValue : null, Draft.ConflictResolutionExtensions.TryParseWire) ?? Draft.ConflictResolution.Deny);
        var interceptorTimeout = Timeout(cfg?["timeouts"] as JsonObject, "interceptor_ms", TimeSpan.FromMilliseconds(5000));
        builder.WithTimeouts(interceptorTimeout, Timeout(cfg?["timeouts"] as JsonObject, "approval_resolver_ms", interceptorTimeout));

        var provider = cfg is not null && cfg.ContainsKey("identity_provider") ? Str(cfg["identity_provider"]) : Jcs.ProviderName;
        if (provider is null) builder.WithIdentityProvider(null);
        else if (provider == Jcs.ProviderName) builder.WithIdentityProvider(IdentityProvider.JcsSha256);
        else if (registry.IdentityProviders.TryGetValue(provider, out var custom)) builder.WithIdentityProvider(custom);
        else f.Bad("/configuration/identity_provider", $"no identity provider named {provider} is registered");
        var approval = cfg?["approval"];
        if (Str(approval?["resolver"]) is { } resolver)
        {
            if (registry.Resolvers.TryGetValue(resolver, out var r)) builder.WithApprovalResolver(r);
            else f.Bad("/configuration/approval/resolver", $"no approval resolver named {resolver} is registered");
        }
        if (Str(approval?["redactor"]) is { } redactor)
        {
            if (registry.Redactors.TryGetValue(redactor, out var r)) builder.WithApprovalRedactor(r);
            else f.Bad("/configuration/approval/redactor", $"no approval redactor named {redactor} is registered");
        }
        f.Refuse("reference_unresolved");

        var bindings = ((JsonArray)doc["bindings"]!).Select(n => (JsonObject)n!).ToList();
        for (var i = 0; i < bindings.Count; i++)
            if (!registry.Kinds.ContainsKey(Str(bindings[i]["kind"])!))
                f.Bad($"/bindings/{i}/kind", $"no factory is registered for kind {Str(bindings[i]["kind"])}");
        f.Refuse("kind_unknown");

        for (var i = 0; i < bindings.Count; i++)
        {
            var binding = bindings[i];
            var config = binding.ContainsKey("config") ? binding["config"]?.DeepClone() : new JsonObject();
            var definition = new BindingDefinition(Str(binding["id"])!, Str(binding["kind"])!, config);
            IHookInterceptor? interceptor;
            try { interceptor = registry.Kinds[definition.Kind](definition); }
            catch (Exception e)
            {
                throw new DeclarationException("declaration_error:binding_rejected", [new($"/bindings/{i}", $"the {definition.Kind} factory rejected the binding: {e.GetType().Name}")]);
            }
            if (interceptor is null)
                throw new DeclarationException("declaration_error:binding_rejected", [new($"/bindings/{i}", $"the {definition.Kind} factory returned no interceptor")]);
            var at = Set<Draft.InterceptionPoint>(binding["at"], Draft.InterceptionPointExtensions.TryParseWire) ?? points;
            builder.Use(interceptor, new BindingOptions
            {
                Name = definition.Id,
                OnError = WireEnum.Parse<Draft.OnError>(Str(binding["on_error"]), Draft.OnErrorExtensions.TryParseWire),
                Timeout = binding.ContainsKey("timeout_ms") ? Timeout(binding, "timeout_ms", interceptorTimeout) : null,
            }, [.. Points.All.Where(at.Contains)]);
        }

        if (registry.Notifier is { } notifier) builder.OnControlFailure(notifier);
        if (registry.Sink is { } sink) builder.WithRecordSink(sink);
        builder.Declaration = Resolved(doc, points, caps, buffered, builder);
        return builder;
    }

    private static JsonObject Parse(string text)
    {
        var length = System.Text.Encoding.UTF8.GetByteCount(text);
        if (length > MaxDocumentBytes)
            throw new DeclarationException("declaration_error:malformed", [new("", $"the document is {length} bytes; the bound is {MaxDocumentBytes}")]);
        JsonNode? node;
        try { node = Jcs.Parse(text, maxDepth: 32); }
        catch (Exception e) when (e is HookException or System.Text.Json.JsonException)
        {
            throw new DeclarationException("declaration_error:malformed", [new("", "not a valid I-JSON document")]);
        }
        return node as JsonObject
            ?? throw new DeclarationException("declaration_error:malformed", [new("", "the document root is not a JSON object")]);
    }

    /// <summary>Flags members a closed schema object does not declare; open objects (config, extensions) are not walked.</summary>
    private static void Unknown(JsonNode? node, JsonObject schema, string pointer, Findings f)
    {
        var branches = Branches(schema).ToList();
        if (node is JsonArray array)
        {
            if (branches.Select(s => s["items"]).OfType<JsonObject>().FirstOrDefault() is { } items)
                for (var i = 0; i < array.Count; i++) Unknown(array[i], items, $"{pointer}/{i}", f);
            return;
        }
        if (node is not JsonObject obj) return;
        var properties = branches.Select(s => s["properties"]).OfType<JsonObject>().SelectMany(p => p).ToList();
        var closed = branches.Count > 0 && branches.All(s =>
            s["unevaluatedProperties"] is JsonObject { Count: 1 } u && u.ContainsKey("not") ||
            s["additionalProperties"] is JsonValue a && a.GetValueKind() == System.Text.Json.JsonValueKind.False);
        foreach (var (key, value) in obj)
        {
            var member = $"{pointer}/{key.Replace("~", "~0").Replace("/", "~1")}";
            var declared = properties.FirstOrDefault(p => p.Key == key).Value as JsonObject;
            if (declared is not null) Unknown(value, declared, member, f);
            else if (closed) f.Bad(member, "unknown member");
        }

        static IEnumerable<JsonObject> Branches(JsonObject schema)
        {
            if (schema["$ref"] is JsonValue r && r.GetValue<string>() is var reference && reference.StartsWith("#/$defs/", StringComparison.Ordinal))
                schema = (JsonObject)Schema["$defs"]![reference["#/$defs/".Length..]]!;
            if (schema["anyOf"] is JsonArray any)
                return any.OfType<JsonObject>().SelectMany(Branches);
            return schema.ContainsKey("properties") || schema.ContainsKey("items") ? [schema] : [];
        }
    }

    private static void CheckConsistency(
        JsonObject doc, HashSet<Draft.InterceptionPoint> points, HashSet<Draft.Capability> caps, bool buffered, JsonObject? profiles,
        JsonObject? composition, string profile, string? knob, Findings f)
    {
        foreach (var point in Floor.Where(p => !points.Contains(p)))
            f.Bad("/surface/interception_points", $"the §3.2 floor requires {Points.Wire(point)}");
        var model = Pair(points, Draft.InterceptionPoint.PreModelCall, Draft.InterceptionPoint.PostModelCall, "model", f);
        var tool = Pair(points, Draft.InterceptionPoint.PreToolCall, Draft.InterceptionPoint.PostToolCall, "tool", f);
        if (caps.Contains(Draft.Capability.ModelCalls) != model)
            f.Bad("/surface/capabilities", "model_calls is listed iff both model points are listed (see spec §3.2)");
        if (caps.Contains(Draft.Capability.ToolCalls) != tool)
            f.Bad("/surface/capabilities", "tool_calls is listed iff both tool points are listed (see spec §3.2)");
        if (caps.Contains(Draft.Capability.IncrementalOutput))
        {
            if (buffered) f.Bad("/surface/capabilities", "incremental_output requires buffered_output: false (see spec §12.1)");
            if (!model) f.Bad("/surface/capabilities", "incremental_output is mediated at post_model_call and requires model calls (see spec §7.7.4)");
        }
        foreach (var other in Knobs.Where(k => k != knob && composition?.ContainsKey(k) == true))
            f.Bad("/configuration/composition/" + other, $"{profile} does not consult {other}; the member is refused, not cleared");
        if (profiles is not null)
        {
            if (profiles[profile] is not JsonObject support)
                f.Bad("/configuration/composition/profile", $"{profile} is not in surface.profiles");
            else if (knob is not null)
            {
                // §7.2: an omitted knob takes its default, and an omitted support list admits only that default.
                var fallback = knob == "on_approval" ? Draft.OnApproval.Stop.ToWire() : Draft.ConflictResolution.Deny.ToWire();
                var value = Str(composition?[knob]) ?? fallback;
                var allowed = support[knob] is JsonArray list ? list.Select(Str) : [fallback];
                if (!allowed.Contains(value, StringComparer.Ordinal))
                    f.Bad("/configuration/composition/" + knob, $"{value} is not in surface.profiles for {profile}");
            }
        }
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var bindings = (JsonArray)doc["bindings"]!;
        for (var i = 0; i < bindings.Count; i++)
        {
            if (!ids.Add(Str(bindings[i]!["id"])!)) f.Bad($"/bindings/{i}/id", "binding ids are unique");
            foreach (var point in Set<Draft.InterceptionPoint>(bindings[i]!["at"], Draft.InterceptionPointExtensions.TryParseWire)?.Where(p => !points.Contains(p)) ?? [])
                f.Bad($"/bindings/{i}/at", $"{Points.Wire(point)} is not in surface.interception_points");
        }

        static bool Pair(HashSet<Draft.InterceptionPoint> points, Draft.InterceptionPoint pre, Draft.InterceptionPoint post, string noun, Findings f)
        {
            if (points.Contains(pre) != points.Contains(post))
                f.Bad("/surface/interception_points", $"the {noun} points are omitted together or not at all (see spec §3.2)");
            return points.Contains(pre) && points.Contains(post);
        }
    }

    /// <summary>The knob a profile consults (§7.4–§7.5); <c>sequential/run_all</c> has none.</summary>
    private static string? Knob(Draft.CompositionProfile profile) => profile switch
    {
        Draft.CompositionProfile.SequentialFirstDeny => "on_approval",
        Draft.CompositionProfile.ParallelStrictest => "on_transform_conflict",
        Draft.CompositionProfile.ParallelUnanimous => "on_disagreement",
        _ => null,
    };

    /// <summary>Refuses non-integer JSON number tokens (fractions or exponents) on integer declaration members (§7.7.3).</summary>
    private static void CheckIntegerTokens(string text, Findings f)
    {
        using var document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 32 });
        var root = document.RootElement;
        if (root.TryGetProperty("configuration", out var cfg) && cfg.ValueKind == JsonValueKind.Object)
        {
            if (cfg.TryGetProperty("timeouts", out var timeouts) && timeouts.ValueKind == JsonValueKind.Object)
            {
                CheckIntegerProperty(timeouts, "interceptor_ms", "/configuration/timeouts/interceptor_ms", f);
                CheckIntegerProperty(timeouts, "approval_resolver_ms", "/configuration/timeouts/approval_resolver_ms", f);
            }
            if (cfg.TryGetProperty("records", out var records) && records.ValueKind == JsonValueKind.Object)
                CheckIntegerProperty(records, "max_buffered", "/configuration/records/max_buffered", f);
        }
        if (root.TryGetProperty("bindings", out var bindings) && bindings.ValueKind == JsonValueKind.Array)
        {
            var index = 0;
            foreach (var binding in bindings.EnumerateArray())
            {
                if (binding.ValueKind == JsonValueKind.Object)
                    CheckIntegerProperty(binding, "timeout_ms", $"/bindings/{index}/timeout_ms", f);
                index++;
            }
        }

        static void CheckIntegerProperty(JsonElement parent, string name, string pointer, Findings f)
        {
            if (parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number &&
                value.GetRawText().IndexOfAny(['.', 'e', 'E']) >= 0)
                f.Bad(pointer, "integer members must be written without a fraction or exponent (see spec §7.7.3)");
        }
    }

    /// <summary>A declared timeout: absent inherits <paramref name="fallback"/>, null is unbounded.</summary>
    private static TimeSpan Timeout(JsonObject? parent, string key, TimeSpan fallback) =>
        parent is null || !parent.ContainsKey(key) ? fallback
        : parent[key] is null ? System.Threading.Timeout.InfiniteTimeSpan
        : parent[key] is JsonValue ms && ms.TryGetValue(out long value)
            ? TimeSpan.FromMilliseconds(value)
            : throw new DeclarationException("declaration_error:invalid_field", [new("", $"{key} must be an integer without a fraction or exponent (see spec §7.7.3)")]);

    private static JsonObject Resolved(
        JsonObject doc, HashSet<Draft.InterceptionPoint> points, HashSet<Draft.Capability> caps, bool buffered, HookEmitterBuilder b)
    {
        static JsonNode? Ms(TimeSpan t) => t == System.Threading.Timeout.InfiniteTimeSpan ? null : (long)t.TotalMilliseconds;
        var composition = new JsonObject { ["profile"] = b.Profile.ToWire() };
        if (Knob(b.Profile) is { } knob)
            composition[knob] = knob == "on_approval" ? b.OnApproval.ToWire()
                : (knob == "on_transform_conflict" ? b.OnTransformConflict : b.OnDisagreement).ToWire();
        var cfg = doc["configuration"] as JsonObject;
        var resolvedSurface = new JsonObject
        {
            ["interception_points"] = new JsonArray(Points.All.Where(points.Contains).Select(p => (JsonNode)Points.Wire(p)).ToArray()),
            ["capabilities"] = new JsonArray(caps.Select(c => c.ToWire()).Order(StringComparer.Ordinal).Select(c => (JsonNode)c).ToArray()),
            ["buffered_output"] = buffered,
        };
        if (doc["surface"]?["profiles"] is JsonObject profiles)
        {
            var resolvedProfiles = new JsonObject();
            foreach (var (profileKey, supportNode) in profiles)
            {
                var resolvedSupport = new JsonObject();
                if (supportNode is JsonObject support)
                    foreach (var (knobKey, valuesNode) in support)
                        resolvedSupport[knobKey] = valuesNode is JsonArray arr
                            ? new JsonArray(arr.Select(Str).OfType<string>().Order(StringComparer.Ordinal).Select(s => (JsonNode)s).ToArray())
                            : valuesNode?.DeepClone();
                resolvedProfiles[profileKey] = resolvedSupport;
            }
            resolvedSurface["profiles"] = resolvedProfiles;
        }
        if (!buffered && Str(doc["surface"]?["exposure_bound"]) is { } exposureBound)
            resolvedSurface["exposure_bound"] = exposureBound;

        var resolved = new JsonObject { ["spec"] = Spec };
        if (Str(doc["id"]) is { } id) resolved["id"] = id;
        if (doc["host"] is JsonObject host) resolved["host"] = host.DeepClone();
        resolved["configuration"] = new JsonObject
        {
            ["mode"] = b.Mode.ToWire(),
            ["composition"] = composition,
            ["identity_provider"] = b.Identity?.Name,
            ["approval"] = new JsonObject
            {
                ["resolver"] = Str(cfg?["approval"]?["resolver"]),
                ["redactor"] = Str(cfg?["approval"]?["redactor"]),
            },
            ["posture"] = new JsonObject { ["tool_seam_host_error"] = b.ToolSeamPosture.ToWire() },
            ["failure"] = new JsonObject { ["on_error"] = b.DefaultOnError.ToWire() },
            ["timeouts"] = new JsonObject
            {
                ["interceptor_ms"] = Ms(b.InterceptorTimeout),
                ["approval_resolver_ms"] = Ms(b.ResolverTimeout ?? b.InterceptorTimeout),
            },
            ["records"] = new JsonObject
            {
                ["max_buffered"] = cfg?["records"]?["max_buffered"]?.DeepClone(),
            },
        };
        resolved["surface"] = resolvedSurface;
        resolved["bindings"] = new JsonArray(((JsonArray)doc["bindings"]!).Select((n, i) =>
        {
            var binding = (JsonObject)n!;
            var bound = b.Bindings[i];
            return (JsonNode)new JsonObject
            {
                ["id"] = Str(binding["id"]),
                ["kind"] = Str(binding["kind"]),
                ["config"] = binding.ContainsKey("config") ? binding["config"]?.DeepClone() : new JsonObject(),
                ["at"] = new JsonArray(Points.All.Where(bound.Points!.Contains).Select(p => (JsonNode)Points.Wire(p)).ToArray()),
                ["timeout_ms"] = Ms(bound.Timeout ?? b.InterceptorTimeout),
                ["on_error"] = (bound.OnError ?? b.DefaultOnError).ToWire(),
            };
        }).ToArray());
        resolved["extensions"] = doc["extensions"]?.DeepClone() ?? new JsonObject();
        return resolved;
    }

    private static string? Str(JsonNode? node) => node is JsonValue v && v.TryGetValue(out string? s) ? s : null;

    private static HashSet<T>? Set<T>(JsonNode? node, WireParser<T> parse) where T : struct, Enum =>
        node is JsonArray array ? array.Select(n => WireEnum.Parse(Str(n), parse)).OfType<T>().ToHashSet() : null;
}
