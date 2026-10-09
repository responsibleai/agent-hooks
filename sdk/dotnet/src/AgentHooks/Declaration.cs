// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Host declaration document (§7.7): the versioned JSON contract a host
// loads for its configuration, declared surface and interceptor
// bindings, and the registry it resolves against.
//
// Steps 2 to 10 of the §7.7.6 pipeline run in the Rust core behind
// ah_declaration_resolve, so this wrapper cannot skip a check and every
// SDK refuses a given document with the same class, pointers and
// details. The wrapper owns step 1 (reading a file), step 11 (running
// the host's kind resolvers) and construction of the sealed emitter.

using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentHooks;

/// <summary>The host declaration contract (§7.7.2): its version,
/// independent of <see cref="Spec.Version"/> (the wire contract) and of
/// the package version, and the fixed bounds of §7.7.3.</summary>
public static class Declaration
{
    /// <summary>The contract version this SDK writes and accepts.</summary>
    public const string Version = "agent-hooks-declaration/1.0";

    /// <summary>Every contract version this SDK's loader accepts. A
    /// document carrying any other <c>declaration</c> value is refused
    /// with <c>declaration_error:version_unsupported</c>.</summary>
    public static readonly IReadOnlyList<string> SupportedVersions = [Version];

    /// <summary>Largest document the text and file paths accept, in bytes.</summary>
    public const int MaxDocumentBytes = 1 << 20;

    /// <summary>Longest refusal detail, in characters.</summary>
    public const int MaxDetailLength = 512;

    /// <summary>The closed capability vocabulary a surface may name
    /// (§7.7.4, §13.1).</summary>
    public static readonly IReadOnlyList<string> Capabilities =
    [
        "model_calls",
        "tool_calls",
        "parallel_tool_calls",
        "streaming",
        "multi_turn",
        "int64_json",
        "bigint_json",
        "incremental_output",
        "host_declaration",
    ];

    internal const string ErrorPrefix = "declaration_error:";

    /// <summary>Bound a detail at <see cref="MaxDetailLength"/>
    /// characters, the ellipsis included.</summary>
    internal static string Truncate(string s)
    {
        if (s.Length <= MaxDetailLength) return s;
        return string.Concat(s.AsSpan(0, MaxDetailLength - 1), "…");
    }
}

/// <summary>The eleven refusal classes (§7.7.6), in pipeline order.</summary>
public enum DeclarationErrorClass
{
    Unreadable,
    Malformed,
    VersionUnsupported,
    SpecUnsupported,
    UnknownField,
    InvalidField,
    Inconsistent,
    SurfaceUnsupported,
    ReferenceUnresolved,
    KindUnknown,
    BindingRejected,
}

public static class DeclarationErrorClassExtensions
{
    /// <summary>The bare class name (<c>unknown_field</c>).</summary>
    public static string ToWireName(this DeclarationErrorClass c) => c switch
    {
        DeclarationErrorClass.Unreadable => "unreadable",
        DeclarationErrorClass.Malformed => "malformed",
        DeclarationErrorClass.VersionUnsupported => "version_unsupported",
        DeclarationErrorClass.SpecUnsupported => "spec_unsupported",
        DeclarationErrorClass.UnknownField => "unknown_field",
        DeclarationErrorClass.InvalidField => "invalid_field",
        DeclarationErrorClass.Inconsistent => "inconsistent",
        DeclarationErrorClass.SurfaceUnsupported => "surface_unsupported",
        DeclarationErrorClass.ReferenceUnresolved => "reference_unresolved",
        DeclarationErrorClass.KindUnknown => "kind_unknown",
        DeclarationErrorClass.BindingRejected => "binding_rejected",
        _ => throw new ArgumentOutOfRangeException(nameof(c)),
    };

    /// <summary>The namespaced code (<c>declaration_error:unknown_field</c>),
    /// the value that crosses the FFI in the result's error code.</summary>
    public static string ToCode(this DeclarationErrorClass c) =>
        Declaration.ErrorPrefix + c.ToWireName();

    /// <summary>Parse a namespaced code or a bare class name.</summary>
    public static DeclarationErrorClass? FromCode(string s)
    {
        foreach (var c in Enum.GetValues<DeclarationErrorClass>())
            if (c.ToCode() == s || c.ToWireName() == s) return c;
        return null;
    }
}

/// <summary>One problem a load step found: a JSON pointer into the
/// document (<c>/bindings/1/kind</c>; the empty string is the root) and
/// a detail that names members, kinds and ids but never binding
/// configuration.</summary>
public sealed record DeclarationFinding(string Pointer, string Detail);

/// <summary>A refused declaration (§7.7.6). Carries one class, every
/// finding that step produced and, for <c>version_unsupported</c>, the
/// accepted version set. A refusal is a construction error, never a
/// verdict: no emitter exists yet.</summary>
public sealed class DeclarationException : Exception
{
    public DeclarationException(
        DeclarationErrorClass errorClass,
        IReadOnlyList<DeclarationFinding> findings,
        IReadOnlyList<string>? accepted = null)
        : base(Describe(errorClass, findings))
    {
        Class = errorClass;
        Findings = findings;
        Accepted = accepted ?? [];
    }

    /// <summary>One finding under <paramref name="errorClass"/>.</summary>
    public DeclarationException(DeclarationErrorClass errorClass, string pointer, string detail)
        : this(errorClass, [new DeclarationFinding(pointer, Declaration.Truncate(detail))])
    {
    }

    public DeclarationErrorClass Class { get; }

    /// <summary>The namespaced code, <c>declaration_error:&lt;class&gt;</c>.</summary>
    public string Code => Class.ToCode();

    public IReadOnlyList<DeclarationFinding> Findings { get; }

    /// <summary>The loader's accepted contract versions; filled for
    /// <c>version_unsupported</c>, empty otherwise.</summary>
    public IReadOnlyList<string> Accepted { get; }

    /// <summary>The FFI detail shape: <c>{"findings": [...], "accepted": [...]}</c>.</summary>
    public JsonObject ToWire()
    {
        var findings = new JsonArray();
        foreach (var f in Findings)
            findings.Add(new JsonObject { ["pointer"] = f.Pointer, ["detail"] = f.Detail });
        return new JsonObject
        {
            ["findings"] = findings,
            ["accepted"] = new JsonArray(Accepted.Select(a => (JsonNode)a).ToArray()),
        };
    }

    /// <summary>Rebuild the typed error from a core refusal: the code is
    /// <c>declaration_error:&lt;class&gt;</c> and the detail is the JSON
    /// findings. Returns <c>null</c> when the exception is not a
    /// declaration refusal.</summary>
    internal static DeclarationException? FromCore(AgentHooksCoreException e)
    {
        if (DeclarationErrorClassExtensions.FromCode(e.Code) is not { } cls
            || !e.Code.StartsWith(Declaration.ErrorPrefix, StringComparison.Ordinal))
            return null;
        var findings = new List<DeclarationFinding>();
        var accepted = new List<string>();
        try
        {
            var detail = JsonNode.Parse(e.Detail) as JsonObject;
            foreach (var f in (detail?["findings"] as JsonArray) ?? [])
                findings.Add(new DeclarationFinding(
                    (string?)f?["pointer"] ?? "", (string?)f?["detail"] ?? ""));
            foreach (var a in (detail?["accepted"] as JsonArray) ?? [])
                if (a is not null) accepted.Add((string)a!);
        }
        catch (JsonException)
        {
            findings.Add(new DeclarationFinding("", e.Detail));
        }
        return new DeclarationException(cls, findings, accepted);
    }

    private static string Describe(
        DeclarationErrorClass errorClass, IReadOnlyList<DeclarationFinding> findings)
    {
        var sb = new StringBuilder(errorClass.ToCode());
        for (var i = 0; i < findings.Count; i++)
        {
            sb.Append(i == 0 ? ": " : "; ");
            if (findings[i].Pointer.Length > 0)
                sb.Append(findings[i].Pointer).Append(": ");
            sb.Append(findings[i].Detail);
        }
        return sb.ToString();
    }
}

/// <summary>What the host does with the run after a <c>host_error:*</c>
/// deny at the tool seam (§6.2, §13.1).</summary>
public enum ToolSeamPosture { Continue, Terminate }

public static class ToolSeamPostureExtensions
{
    public static string ToWireName(this ToolSeamPosture p) =>
        p == ToolSeamPosture.Terminate ? "terminate" : "continue";

    public static ToolSeamPosture FromWireName(string s) => s switch
    {
        "continue" => ToolSeamPosture.Continue,
        "terminate" => ToolSeamPosture.Terminate,
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, "Unknown tool seam posture"),
    };
}

/// <summary>The knob values a host supports for one profile (§13.1
/// "profiles and knob values supported"). Only the knobs the profile
/// consults are present; an empty set for a consulted knob is never
/// valid.</summary>
public sealed record KnobSupport(
    IReadOnlySet<string> OnApproval,
    IReadOnlySet<string> OnDisagreement,
    IReadOnlySet<string> OnTransformConflict)
{
    private static readonly IReadOnlySet<string> Empty = new HashSet<string>();

    /// <summary>No knob at all (<c>sequential/run_all</c>).</summary>
    public static readonly KnobSupport None = new(Empty, Empty, Empty);

    /// <summary>Every value of every knob the profile consults.</summary>
    public static KnobSupport Full(CompositionProfile profile) => profile switch
    {
        CompositionProfile.SequentialFirstDeny => new(Set("stop", "resume"), Empty, Empty),
        CompositionProfile.ParallelStrictest => new(Empty, Empty, Set("deny", "approval")),
        CompositionProfile.ParallelUnanimous => new(Empty, Set("deny", "approval"), Empty),
        _ => None,
    };

    /// <summary>The §7.2 default value only, for every knob the profile consults.</summary>
    public static KnobSupport DefaultsOnly(CompositionProfile profile) => profile switch
    {
        CompositionProfile.SequentialFirstDeny => new(Set("stop"), Empty, Empty),
        CompositionProfile.ParallelStrictest => new(Empty, Empty, Set("deny")),
        CompositionProfile.ParallelUnanimous => new(Empty, Set("deny"), Empty),
        _ => None,
    };

    private static IReadOnlySet<string> Set(params string[] values) => new HashSet<string>(values);

    /// <summary>Serialize; absent knobs are omitted, sets are sorted.</summary>
    public JsonObject ToWire()
    {
        var o = new JsonObject();
        if (OnApproval.Count > 0) o["on_approval"] = Sorted(OnApproval);
        if (OnDisagreement.Count > 0) o["on_disagreement"] = Sorted(OnDisagreement);
        if (OnTransformConflict.Count > 0) o["on_transform_conflict"] = Sorted(OnTransformConflict);
        return o;
    }

    public static KnobSupport FromWire(JsonObject o) => new(
        Strings(o["on_approval"]), Strings(o["on_disagreement"]), Strings(o["on_transform_conflict"]));

    internal static JsonArray Sorted(IEnumerable<string> values) =>
        new(values.Order(StringComparer.Ordinal).Select(v => (JsonNode)v).ToArray());

    internal static IReadOnlySet<string> Strings(JsonNode? node) =>
        node is JsonArray a ? new HashSet<string>(a.Select(n => (string)n!)) : Empty;
}

/// <summary>What the host's code can honour (§7.7.4, §13.1): the one
/// value the loader checks a document against and the CTK derives the
/// harness surface from. A document may select a subset of this, never
/// more. This SDK bounds interceptor and resolver execution in its own
/// runtime, so the surface always reports <c>interceptor_timeout:
/// bounded</c>.</summary>
public sealed record HostSurface
{
    /// <summary>Points the host emits. Always includes the §3.2 floor.</summary>
    public required IReadOnlySet<InterceptionPoint> InterceptionPoints { get; init; }

    /// <summary>Closed vocabulary (<see cref="Declaration.Capabilities"/>).</summary>
    public required IReadOnlySet<string> Capabilities { get; init; }

    /// <summary>Profiles and the knob values supported under each.</summary>
    public required IReadOnlyDictionary<CompositionProfile, KnobSupport> Profiles { get; init; }

    /// <summary>The posture the code implements (§13.1).</summary>
    public ToolSeamPosture ToolSeamHostError { get; init; } = ToolSeamPosture.Continue;

    /// <summary>Whether the host may declare <c>buffered_output: false</c> (§12.1a).</summary>
    public bool StreamsUnbuffered { get; init; }

    /// <summary>The §12.1a exposure bound the host enforces. Required
    /// when <see cref="Capabilities"/> names <c>incremental_output</c>.</summary>
    public string? ExposureBound { get; init; }

    /// <summary>Contract versions the host accepts; a subset of
    /// <see cref="Declaration.SupportedVersions"/>.</summary>
    public required IReadOnlySet<string> DeclarationVersions { get; init; }

    /// <summary>The §3.2 lifecycle floor.</summary>
    public static readonly IReadOnlyList<InterceptionPoint> FloorPoints =
    [
        InterceptionPoint.AgentStartup,
        InterceptionPoint.Input,
        InterceptionPoint.Output,
        InterceptionPoint.AgentShutdown,
    ];

    /// <summary>The smallest honest surface for this SDK: the lifecycle
    /// floor, <c>host_declaration</c>, every profile with every knob
    /// value, posture <c>continue</c>, buffered output and every accepted
    /// contract version. A host adds what its runtime does.</summary>
    public static HostSurface SdkDefault() => new()
    {
        InterceptionPoints = new HashSet<InterceptionPoint>(FloorPoints),
        Capabilities = new HashSet<string> { "host_declaration" },
        Profiles = Enum.GetValues<CompositionProfile>().ToDictionary(p => p, KnobSupport.Full),
        DeclarationVersions = new HashSet<string>(Declaration.SupportedVersions),
    };

    /// <summary>The surface the CTK derives from a harness's capability
    /// list and posture (§7.7.9): the floor plus the model points iff
    /// <c>model_calls</c> plus the tool points iff <c>tool_calls</c>. A
    /// list naming <c>incremental_output</c> yields a surface without
    /// its exposure bound, which the core refuses; such a host adds the
    /// bound with <see cref="WithExposureBound"/>.</summary>
    public static HostSurface FromCapabilities(IEnumerable<string> capabilities, ToolSeamPosture posture)
    {
        var points = new HashSet<InterceptionPoint>(FloorPoints);
        var caps = new HashSet<string>();
        var unbuffered = false;
        foreach (var c in capabilities)
        {
            switch (c)
            {
                case "model_calls":
                    points.Add(InterceptionPoint.PreModelCall);
                    points.Add(InterceptionPoint.PostModelCall);
                    break;
                case "tool_calls":
                    points.Add(InterceptionPoint.PreToolCall);
                    points.Add(InterceptionPoint.PostToolCall);
                    break;
                case "incremental_output":
                    unbuffered = true;
                    break;
            }
            caps.Add(c);
        }
        return SdkDefault() with
        {
            InterceptionPoints = points,
            Capabilities = caps,
            ToolSeamHostError = posture,
            StreamsUnbuffered = unbuffered,
        };
    }

    /// <summary>Add the model points, the tool points, or both.</summary>
    public HostSurface WithPoints(params InterceptionPoint[] points) =>
        this with { InterceptionPoints = new HashSet<InterceptionPoint>(InterceptionPoints.Concat(points)) };

    /// <summary>Add capabilities.</summary>
    public HostSurface WithCapabilities(params string[] capabilities) =>
        this with { Capabilities = new HashSet<string>(Capabilities.Concat(capabilities)) };

    /// <summary>State the §12.1a exposure bound an incremental host
    /// enforces. Also marks the host as able to declare
    /// <c>buffered_output: false</c>.</summary>
    public HostSurface WithExposureBound(string bound) =>
        this with { ExposureBound = bound, StreamsUnbuffered = true };

    /// <summary>The JSON form the core receives in the host description.</summary>
    public JsonObject ToWire()
    {
        var profiles = new JsonObject();
        foreach (var (p, k) in Profiles.OrderBy(kv => kv.Key.ToWireName(), StringComparer.Ordinal))
            profiles[p.ToWireName()] = k.ToWire();
        var o = new JsonObject
        {
            ["interception_points"] = new JsonArray(
                InterceptionPoints.Order().Select(p => (JsonNode)p.ToWireName()).ToArray()),
            ["capabilities"] = KnobSupport.Sorted(Capabilities),
            ["profiles"] = profiles,
            ["tool_seam_host_error"] = ToolSeamHostError.ToWireName(),
            ["streams_unbuffered"] = StreamsUnbuffered,
        };
        if (ExposureBound is not null) o["exposure_bound"] = ExposureBound;
        o["interceptor_timeout"] = "bounded";
        o["declaration_versions"] = KnobSupport.Sorted(DeclarationVersions);
        return o;
    }

    /// <summary>Parse the JSON form (the golden fixtures carry one).
    /// <c>interceptor_timeout</c> is this SDK's own fact and is not read.</summary>
    public static HostSurface FromWire(JsonObject o)
    {
        var profiles = new Dictionary<CompositionProfile, KnobSupport>();
        foreach (var (name, knobs) in (o["profiles"] as JsonObject) ?? [])
            profiles[CompositionProfileExtensions.FromWireName(name)] =
                KnobSupport.FromWire((JsonObject)knobs!);
        return new HostSurface
        {
            InterceptionPoints = new HashSet<InterceptionPoint>(
                ((JsonArray)o["interception_points"]!)
                    .Select(n => InterceptionPointExtensions.FromWireName((string)n!))),
            Capabilities = KnobSupport.Strings(o["capabilities"]),
            Profiles = profiles,
            ToolSeamHostError = ToolSeamPostureExtensions.FromWireName(
                (string?)o["tool_seam_host_error"] ?? "continue"),
            StreamsUnbuffered = (bool?)o["streams_unbuffered"] ?? false,
            ExposureBound = (string?)o["exposure_bound"],
            DeclarationVersions = KnobSupport.Strings(o["declaration_versions"]),
        };
    }
}

/// <summary>The informative <c>host</c> block of a declaration.</summary>
public sealed record HostInfo(string Name, string? Version = null);

/// <summary>What a kind resolver learns about the binding it builds
/// (§7.7.5). <see cref="Timeout"/> is the resolved per-binding bound;
/// <c>null</c> is unbounded.</summary>
public sealed record BindingContext(
    string Id,
    string Kind,
    IReadOnlySet<InterceptionPoint> At,
    TimeSpan? Timeout,
    HostInfo? Host,
    string DeclarationVersion);

/// <summary>Host code that turns one binding's <c>config</c> into one
/// interceptor, or refuses it by throwing. The message of the exception
/// is the refusal detail and MUST NOT echo the config (§7.7.5).</summary>
public delegate IInterceptor KindResolver(JsonNode? config, BindingContext context);

/// <summary>Everything a host registers in code for a declaration to
/// reference (§7.7.5): the code surface, kind resolvers, custom identity
/// providers, approval resolvers and approval redactors. Registering an
/// invalid, reserved or duplicate name is a programming error
/// (<see cref="ArgumentException"/>), not a refusal of any document.</summary>
public sealed class HostRegistry
{
    private const int MaxIdLength = 64;
    private const int MaxKindLength = 128;
    private static readonly string[] ReservedKindSegments = ["agent_hooks", "ctk"];

    private readonly bool _allowReserved;
    private readonly SortedDictionary<string, KindResolver> _kinds = new(StringComparer.Ordinal);
    private readonly SortedDictionary<string, Func<JsonObject, string>> _identityProviders = new(StringComparer.Ordinal);
    private readonly SortedDictionary<string, IApprovalResolver> _approvalResolvers = new(StringComparer.Ordinal);
    private readonly SortedDictionary<string, Func<AgentContext, AgentContext>> _approvalRedactors = new(StringComparer.Ordinal);

    /// <summary>A registry over the given code surface. Kinds under the
    /// reserved <c>agent_hooks</c> and <c>ctk</c> segments are refused.
    /// The surface is checked by the core at construction: one that
    /// breaks the §3.2 floor, the omission pairs or a closed vocabulary
    /// is a programming error.</summary>
    public HostRegistry(HostSurface surface) : this(surface, allowReserved: false)
    {
    }

    private HostRegistry(HostSurface surface, bool allowReserved)
    {
        Surface = surface;
        _allowReserved = allowReserved;
        ValidateSurface(surface);
    }

    /// <summary>The conformance kit's registry: as the constructor, but
    /// the <c>ctk</c> kind segment may be registered.</summary>
    public static HostRegistry ForConformance(HostSurface surface) => new(surface, allowReserved: true);

    public HostSurface Surface { get; }

    /// <summary>Register a kind resolver.</summary>
    public HostRegistry Kind(string kind, KindResolver resolver)
    {
        ArgumentNullException.ThrowIfNull(resolver);
        if (!ValidKind(kind))
            throw new ArgumentException(
                $"host registry: kind \"{kind}\" does not match the kind grammar (see spec §7.7.5)", nameof(kind));
        var head = kind.Split('.')[0];
        if (ReservedKindSegments.Contains(head) && !(_allowReserved && head == "ctk"))
            throw new ArgumentException(
                $"host registry: kind \"{kind}\" uses the reserved segment \"{head}\" (see spec §7.7.5)", nameof(kind));
        if (!_kinds.TryAdd(kind, resolver))
            throw new ArgumentException($"host registry: kind \"{kind}\" registered twice", nameof(kind));
        return this;
    }

    /// <summary>Register a custom identity provider (§10.1 name rules apply).</summary>
    public HostRegistry IdentityProvider(string name, Func<JsonObject, string> f)
    {
        ArgumentNullException.ThrowIfNull(f);
        // Reuses the §10.1 check so the registry and the constructor agree.
        _ = AgentHooks.IdentityProvider.Custom(name, f);
        if (name.Length > MaxIdLength)
            throw new ArgumentException(
                $"host registry: identity provider name \"{name}\" exceeds {MaxIdLength} characters", nameof(name));
        if (!_identityProviders.TryAdd(name, f))
            throw new ArgumentException(
                $"host registry: identity provider \"{name}\" registered twice", nameof(name));
        return this;
    }

    /// <summary>Register an approval resolver under a reference name.</summary>
    public HostRegistry ApprovalResolver(string name, IApprovalResolver resolver)
    {
        ArgumentNullException.ThrowIfNull(resolver);
        CheckReference(name, "approval resolver");
        if (!_approvalResolvers.TryAdd(name, resolver))
            throw new ArgumentException(
                $"host registry: approval resolver \"{name}\" registered twice", nameof(name));
        return this;
    }

    /// <summary>Register an approval redactor under a reference name.</summary>
    public HostRegistry ApprovalRedactor(string name, Func<AgentContext, AgentContext> redactor)
    {
        ArgumentNullException.ThrowIfNull(redactor);
        CheckReference(name, "approval redactor");
        if (!_approvalRedactors.TryAdd(name, redactor))
            throw new ArgumentException(
                $"host registry: approval redactor \"{name}\" registered twice", nameof(name));
        return this;
    }

    /// <summary>The registered names, derived from what was registered
    /// and never hand-written (§7.7.5).</summary>
    public JsonObject Names() => new()
    {
        ["identity_providers"] = KnobSupport.Sorted(_identityProviders.Keys),
        ["approval_resolvers"] = KnobSupport.Sorted(_approvalResolvers.Keys),
        ["approval_redactors"] = KnobSupport.Sorted(_approvalRedactors.Keys),
        ["kinds"] = KnobSupport.Sorted(_kinds.Keys),
    };

    /// <summary>The host description the core resolves against:
    /// <c>{surface, identity_providers, approval_resolvers,
    /// approval_redactors, kinds}</c>.</summary>
    public JsonObject ToHostWire()
    {
        var o = new JsonObject { ["surface"] = Surface.ToWire() };
        foreach (var (k, v) in Names()) o[k] = v?.DeepClone();
        return o;
    }

    internal KindResolver? KindResolverFor(string kind) =>
        _kinds.TryGetValue(kind, out var r) ? r : null;

    internal Func<JsonObject, string>? IdentityProviderFor(string name) =>
        _identityProviders.TryGetValue(name, out var f) ? f : null;

    internal IApprovalResolver? ApprovalResolverFor(string name) =>
        _approvalResolvers.TryGetValue(name, out var r) ? r : null;

    internal Func<AgentContext, AgentContext>? ApprovalRedactorFor(string name) =>
        _approvalRedactors.TryGetValue(name, out var f) ? f : null;

    /// <summary>Reference grammar for resolver and redactor names and
    /// binding ids: <c>^[a-z][a-z0-9_-]{0,63}$</c>.</summary>
    public static bool ValidReference(string s) =>
        s.Length is >= 1 and <= MaxIdLength && ValidSegment(s);

    /// <summary>Binding kind grammar (§7.7.5): dot-separated lowercase
    /// segments, at least two, at most 128 characters.</summary>
    public static bool ValidKind(string s)
    {
        if (s.Length > MaxKindLength) return false;
        var segments = s.Split('.');
        return segments.Length >= 2 && segments.All(ValidSegment);
    }

    private static bool ValidSegment(string s) =>
        s.Length > 0
        && s[0] is >= 'a' and <= 'z'
        && s.All(c => c is (>= 'a' and <= 'z') or (>= '0' and <= '9') or '_' or '-');

    private static void CheckReference(string name, string what)
    {
        if (!ValidReference(name))
            throw new ArgumentException(
                $"host registry: {what} name \"{name}\" does not match ^[a-z][a-z0-9_-]{{0,63}}$", nameof(name));
    }

    /// <summary>Have the core check the surface (the §3.2 floor and
    /// pairs, the closed vocabularies, the exposure bound rule). The
    /// core reports a bad host description as <c>marshal_error</c>, a
    /// wrapper defect, never as a refusal of any document; the probe
    /// document is the minimal valid one and its own outcome is not
    /// of interest here.</summary>
    private static void ValidateSurface(HostSurface surface)
    {
        var host = new JsonObject { ["surface"] = surface.ToWire() };
        var probe = new JsonObject
        {
            ["declaration"] = Declaration.Version,
            ["bindings"] = new JsonArray(),
        };
        try
        {
            Native.DeclarationResolve(probe.ToJsonString(), host.ToJsonString());
        }
        catch (AgentHooksCoreException e) when (e.Code == "marshal_error")
        {
            throw new ArgumentException($"host registry: {e.Detail}", nameof(surface));
        }
        catch (AgentHooksCoreException e) when (e.Code.StartsWith(Declaration.ErrorPrefix, StringComparison.Ordinal))
        {
            // A refusal of the probe document says nothing about the
            // surface; the host's real documents report their own.
        }
    }
}

/// <summary>A host declaration document as read, before the core has
/// validated it. <see cref="FromPath"/> performs step 1 of §7.7.6
/// (regular file, size bound, strict UTF-8, no byte-order mark);
/// steps 2 to 10 run in the core when the document is resolved against
/// a <see cref="HostRegistry"/>, and step 11 when the emitter is built
/// (<see cref="InterceptionEmitter.FromDeclaration"/>).</summary>
public sealed class HostDeclaration
{
    private HostDeclaration(string text)
    {
        Text = text;
    }

    /// <summary>The JSON text handed to the core, byte for byte as read.</summary>
    public string Text { get; }

    /// <summary>Step 1: open exactly <paramref name="path"/>, require a
    /// regular file of at most <see cref="Declaration.MaxDocumentBytes"/>
    /// bytes, strict UTF-8 without a byte-order mark, read once.</summary>
    public static HostDeclaration FromPath(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        static DeclarationException Unreadable(string detail) =>
            new(DeclarationErrorClass.Unreadable, "", detail);
        byte[] bytes;
        try
        {
            if (Directory.Exists(path)) throw Unreadable("not a regular file");
            if (!File.Exists(path)) throw Unreadable("cannot stat: NotFound");
            using var stream = new FileStream(
                path, FileMode.Open, FileAccess.Read, FileShare.Read);
            // Read through a bounded reader: a file that grows between
            // the stat and the read is still loaded only up to the
            // bound plus one byte, then refused.
            var buffer = new byte[Declaration.MaxDocumentBytes + 1];
            var total = 0;
            int n;
            while (total < buffer.Length
                && (n = stream.Read(buffer, total, buffer.Length - total)) > 0)
                total += n;
            if (total > Declaration.MaxDocumentBytes)
                throw Unreadable(
                    $"document is {Math.Max(total, stream.Length)} bytes; the bound is {Declaration.MaxDocumentBytes}");
            bytes = buffer.AsSpan(0, total).ToArray();
        }
        catch (UnauthorizedAccessException)
        {
            throw Unreadable("cannot read: PermissionDenied");
        }
        catch (IOException e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            throw Unreadable("cannot stat: NotFound");
        }
        catch (IOException e)
        {
            throw Unreadable($"cannot read: {e.GetType().Name}");
        }
        catch (ArgumentException)
        {
            throw Unreadable("cannot stat: InvalidInput");
        }
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
            throw Unreadable("document starts with a byte-order mark");
        string text;
        try
        {
            text = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true)
                .GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            throw Unreadable("document is not valid UTF-8");
        }
        return new HostDeclaration(text);
    }

    /// <summary>The JSON text path: the text crosses to the core as is,
    /// so duplicate keys, depth and size are checked there (step 2).</summary>
    public static HostDeclaration FromJson(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        return new HostDeclaration(text);
    }

    /// <summary>The value path: the node is serialized and handed to
    /// the JSON text path, so size, depth and shape checks are the same
    /// code on every path. A value that cannot be serialized (a
    /// non-finite number) is <c>malformed</c>.</summary>
    public static HostDeclaration FromNode(JsonNode? node)
    {
        try
        {
            return new HostDeclaration(node?.ToJsonString() ?? "null");
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or JsonException)
        {
            throw new DeclarationException(
                DeclarationErrorClass.Malformed, "", $"cannot serialize: {e.GetType().Name}");
        }
    }

    /// <summary>A builder for the code path (§7.7.7).</summary>
    public static DeclarationBuilder Builder() => new();

    /// <summary>Steps 2 to 10 of §7.7.6 in the core: validate the
    /// document and resolve it against the registry's surface and
    /// names. Kind resolvers do not run here; see
    /// <see cref="InterceptionEmitter.FromDeclaration"/> for step 11.</summary>
    public ResolvedDeclaration Resolve(HostRegistry registry)
    {
        ArgumentNullException.ThrowIfNull(registry);
        try
        {
            var json = Native.DeclarationResolve(Text, host.ToJsonString());
            return new ResolvedDeclaration(json);
        }
        return Resolve(registry.ToHostWire());
    }

    /// <summary>Steps 2 to 8 only: validate the document and resolve it
    /// against <paramref name="surface"/> without a registry. The CTK
    /// runner uses this on a harness's own document (§7.7.9), which is
    /// resolved against the host's code surface, not against the kinds
    /// and names a given run registers. The name sets handed to the
    /// core are derived from the document itself (its custom identity
    /// provider, approval resolver, redactor and binding kinds), so
    /// steps 9 and 10 cannot fire and steps 2 to 8 run exactly as in
    /// <see cref="Resolve(HostRegistry)"/>. Never a production path: a
    /// resolved document from here has not been checked against any
    /// registry.</summary>
    internal ResolvedDeclaration ResolveSurfaceOnly(HostSurface surface)
    {
        ArgumentNullException.ThrowIfNull(surface);
        var host = new JsonObject { ["surface"] = surface.ToWire() };
        AddNamesTheDocumentUses(host);
        return Resolve(host);
    }

    private ResolvedDeclaration Resolve(JsonObject host)
    {
        catch (AgentHooksCoreException e) when (DeclarationException.FromCore(e) is { } refused)
        {
            throw refused;
        }
    }
}

/// <summary>One binding with <c>at</c> and <c>timeout_ms</c> filled.</summary>
public sealed record ResolvedBinding(
    string Id,

    /// <summary>Add to <paramref name="host"/> the registry names this
    /// document references, read leniently: a document the core will
    /// refuse at steps 2 to 7 yields whatever names can be read (or
    /// none), and the core reports the real class.</summary>
    private void AddNamesTheDocumentUses(JsonObject host)
    {
        var providers = new SortedSet<string>(StringComparer.Ordinal);
        var resolvers = new SortedSet<string>(StringComparer.Ordinal);
        var redactors = new SortedSet<string>(StringComparer.Ordinal);
        var kinds = new SortedSet<string>(StringComparer.Ordinal);
        JsonObject? doc = null;
        try
        {
            doc = JsonNode.Parse(Text) as JsonObject;
        }
        catch (JsonException)
        {
            // Malformed: the core refuses it before any name is checked.
        }
        if (doc?["configuration"] is JsonObject configuration)
        {
            if (configuration["identity_provider"] is JsonValue ip
                && ip.TryGetValue(out string? provider)
                && provider != Spec.JcsSha256)
                providers.Add(provider);
            if (configuration["approval"] is JsonObject approval)
            {
                if (approval["resolver"] is JsonValue r && r.TryGetValue(out string? resolver))
                    resolvers.Add(resolver);
                if (approval["redactor"] is JsonValue d && d.TryGetValue(out string? redactor))
                    redactors.Add(redactor);
            }
        }
        if (doc?["bindings"] is JsonArray bindings)
            foreach (var b in bindings)
                if (b is JsonObject binding
                    && binding["kind"] is JsonValue k
                    && k.TryGetValue(out string? kind))
                    kinds.Add(kind);
        host["identity_providers"] = KnobSupport.Sorted(providers);
        host["approval_resolvers"] = KnobSupport.Sorted(resolvers);
        host["approval_redactors"] = KnobSupport.Sorted(redactors);
        host["kinds"] = KnobSupport.Sorted(kinds);
    }
    string Kind,
    JsonNode? Config,
    IReadOnlySet<InterceptionPoint> At,
    long? TimeoutMs);

/// <summary>The resolved declaration (§7.7.3 "Resolved form"): every
/// default filled, composition knobs resolved as §7.2 resolves them,
/// <c>$schema</c> dropped, sets sorted. Its canonical JSON is the
/// equivalence oracle for the construction paths (§7.7.7).</summary>
public sealed class ResolvedDeclaration
{
    private readonly JsonObject _wire;

    internal ResolvedDeclaration(string json)
    {
        RawJson = json;
        _wire = (JsonObject)JsonNode.Parse(json)!;
        var cfg = (JsonObject)_wire["configuration"]!;
        var approval = (JsonObject)cfg["approval"]!;
        var timeouts = (JsonObject)cfg["timeouts"]!;
        var surface = (JsonObject)_wire["surface"]!;
        Version = (string)_wire["declaration"]!;
        Spec = (string)_wire["spec"]!;
        Id = (string?)_wire["id"];
        Host = _wire["host"] is JsonObject h
            ? new HostInfo((string)h["name"]!, (string?)h["version"])
            : null;
        Mode = (string)cfg["mode"]! == "evaluate_only" ? EnforcementMode.EvaluateOnly : EnforcementMode.Enforce;
        Composition = CompositionConfig.FromWire((JsonObject)cfg["composition"]!);
        IdentityProvider = (string?)cfg["identity_provider"];
        ApprovalResolver = (string?)approval["resolver"];
        ApprovalRedactor = (string?)approval["redactor"];
        ToolSeamHostError = ToolSeamPostureExtensions.FromWireName(
            (string)cfg["posture"]!["tool_seam_host_error"]!);
        InterceptorTimeoutMs = (long?)timeouts["interceptor_ms"];
        ApprovalResolverTimeoutMs = (long?)timeouts["approval_resolver_ms"];
        MaxBufferedRecords = (long?)cfg["records"]!["max_buffered"];
        SurfaceInterceptionPoints = new HashSet<InterceptionPoint>(
            ((JsonArray)surface["interception_points"]!)
                .Select(n => InterceptionPointExtensions.FromWireName((string)n!)));
        SurfaceCapabilities = KnobSupport.Strings(surface["capabilities"]);
        BufferedOutput = (bool)surface["buffered_output"]!;
        ExposureBound = (string?)surface["exposure_bound"];
        SurfaceDeclarationVersions = KnobSupport.Strings(surface["declaration_versions"]);
        Bindings = ((JsonArray)_wire["bindings"]!).Select(b => new ResolvedBinding(
            (string)b!["id"]!,
            (string)b["kind"]!,
            b["config"]?.DeepClone(),
            new HashSet<InterceptionPoint>(
                ((JsonArray)b["at"]!).Select(n => InterceptionPointExtensions.FromWireName((string)n!))),
            (long?)b["timeout_ms"])).ToList();
    }

    /// <summary>The resolved form as the core serialized it.</summary>
    internal string RawJson { get; }

    /// <summary>The contract version the document carried.</summary>
    public string Version { get; }

    public string Spec { get; }
    public string? Id { get; }
    public HostInfo? Host { get; }
    public EnforcementMode Mode { get; }

    /// <summary>The composition <c>finalize</c> stamps; its knobs are
    /// already resolved.</summary>
    public CompositionConfig Composition { get; }

    /// <summary>The declared identity provider name (<c>null</c> is unbound).</summary>
    public string? IdentityProvider { get; }

    public string? ApprovalResolver { get; }
    public string? ApprovalRedactor { get; }
    public ToolSeamPosture ToolSeamHostError { get; }

    /// <summary><c>null</c> is unbounded.</summary>
    public long? InterceptorTimeoutMs { get; }

    /// <summary><c>null</c> is unbounded.</summary>
    public long? ApprovalResolverTimeoutMs { get; }

    /// <summary><c>null</c> is unbounded.</summary>
    public long? MaxBufferedRecords { get; }

    public IReadOnlySet<InterceptionPoint> SurfaceInterceptionPoints { get; }
    public IReadOnlySet<string> SurfaceCapabilities { get; }
    public bool BufferedOutput { get; }
    public string? ExposureBound { get; }
    public IReadOnlySet<string> SurfaceDeclarationVersions { get; }
    public IReadOnlyList<ResolvedBinding> Bindings { get; }

    /// <summary>The resolved form (a copy).</summary>
    public JsonObject ToWire() => (JsonObject)_wire.DeepClone();

    /// <summary>RFC 8785 canonical JSON of the resolved form (Rust core).</summary>
    public string CanonicalJson() => Native.CanonicalJson(RawJson);
}

/// <summary>Builds a declaration document in code, one setter per
/// member (§7.7.7). <see cref="Build"/> hands the document to
/// <see cref="HostDeclaration.FromNode"/>, so the code path is validated
/// by the same function, with the same classes, as a file.</summary>
public sealed class DeclarationBuilder
{
    private readonly JsonObject _doc;

    /// <summary>A builder with <c>declaration</c> set to
    /// <see cref="Declaration.Version"/> and an empty <c>bindings</c> array.</summary>
    public DeclarationBuilder()
    {
        _doc = new JsonObject
        {
            ["declaration"] = Declaration.Version,
            ["bindings"] = new JsonArray(),
        };
    }

    private DeclarationBuilder(JsonObject doc)
    {
        _doc = doc;
    }

    /// <summary>A builder with no member set at all, not even
    /// <c>declaration</c> or <c>bindings</c>. For harnesses that must
    /// express an incomplete document; a host wants the constructor.</summary>
    public static DeclarationBuilder Empty() => new(new JsonObject());

    private JsonObject Configuration()
    {
        if (_doc["configuration"] is not JsonObject c)
            _doc["configuration"] = c = new JsonObject();
        return c;
    }

    private JsonObject ConfigurationSub(string key)
    {
        var c = Configuration();
        if (c[key] is not JsonObject sub)
            c[key] = sub = new JsonObject();
        return sub;
    }

    private JsonObject Surface()
    {
        if (_doc["surface"] is not JsonObject s)
            _doc["surface"] = s = new JsonObject();
        return s;
    }

    private static JsonArray Points(IEnumerable<InterceptionPoint> points) =>
        new(points.Distinct().Order().Select(p => (JsonNode)p.ToWireName()).ToArray());

    /// <summary><c>declaration</c> (defaults to <see cref="Declaration.Version"/>).</summary>
    public DeclarationBuilder Version(string version)
    {
        _doc["declaration"] = version;
        return this;
    }

    public DeclarationBuilder Spec(string spec)
    {
        _doc["spec"] = spec;
        return this;
    }

    public DeclarationBuilder Id(string id)
    {
        _doc["id"] = id;
        return this;
    }

    public DeclarationBuilder Host(string name, string? version = null)
    {
        var h = new JsonObject { ["name"] = name };
        if (version is not null) h["version"] = version;
        _doc["host"] = h;
        return this;
    }

    public DeclarationBuilder Mode(EnforcementMode mode)
    {
        Configuration()["mode"] = mode == EnforcementMode.EvaluateOnly ? "evaluate_only" : "enforce";
        return this;
    }

    /// <summary>The composition as the host states it. Knobs the profile
    /// does not consult are written out and refused by <see cref="Build"/>,
    /// exactly as in a file.</summary>
    public DeclarationBuilder Composition(CompositionConfig composition)
    {
        Configuration()["composition"] = composition.ToWire();
        return this;
    }

    /// <summary>A name for <c>jcs-sha256</c> or a custom provider,
    /// <c>null</c> for identity-unbound (written as JSON <c>null</c>).</summary>
    public DeclarationBuilder IdentityProvider(string? name)
    {
        Configuration()["identity_provider"] = name;
        return this;
    }

    public DeclarationBuilder ApprovalResolver(string? name)
    {
        ConfigurationSub("approval")["resolver"] = name;
        return this;
    }

    public DeclarationBuilder ApprovalRedactor(string? name)
    {
        ConfigurationSub("approval")["redactor"] = name;
        return this;
    }

    public DeclarationBuilder ToolSeamHostError(ToolSeamPosture posture)
    {
        ConfigurationSub("posture")["tool_seam_host_error"] = posture.ToWireName();
        return this;
    }

    /// <summary><c>null</c> writes JSON <c>null</c> (unbounded).</summary>
    public DeclarationBuilder InterceptorTimeoutMs(long? ms)
    {
        ConfigurationSub("timeouts")["interceptor_ms"] = ms;
        return this;
    }

    /// <summary><c>null</c> writes JSON <c>null</c> (unbounded).</summary>
    public DeclarationBuilder ApprovalResolverTimeoutMs(long? ms)
    {
        ConfigurationSub("timeouts")["approval_resolver_ms"] = ms;
        return this;
    }

    /// <summary><c>null</c> writes JSON <c>null</c> (unbounded).</summary>
    public DeclarationBuilder MaxBufferedRecords(long? count)
    {
        ConfigurationSub("records")["max_buffered"] = count;
        return this;
    }

    public DeclarationBuilder SurfacePoints(IEnumerable<InterceptionPoint> points)
    {
        Surface()["interception_points"] = Points(points);
        return this;
    }

    public DeclarationBuilder SurfaceCapabilities(IEnumerable<string> capabilities)
    {
        Surface()["capabilities"] = KnobSupport.Sorted(capabilities.Distinct());
        return this;
    }

    /// <summary>Declare support for one profile and its knob values.</summary>
    public DeclarationBuilder SurfaceProfile(CompositionProfile profile, KnobSupport knobs)
    {
        var s = Surface();
        if (s["profiles"] is not JsonObject profiles)
            s["profiles"] = profiles = new JsonObject();
        profiles[profile.ToWireName()] = knobs.ToWire();
        return this;
    }

    /// <summary><c>buffered_output</c> and, when <c>false</c>, the required exposure bound.</summary>
    public DeclarationBuilder BufferedOutput(bool buffered, string? exposureBound = null)
    {
        var s = Surface();
        s["buffered_output"] = buffered;
        if (exposureBound is not null) s["exposure_bound"] = exposureBound;
        else s.Remove("exposure_bound");
        return this;
    }

    public DeclarationBuilder SurfaceDeclarationVersions(IEnumerable<string> versions)
    {
        Surface()["declaration_versions"] = KnobSupport.Sorted(versions.Distinct());
        return this;
    }

    /// <summary>Append one binding. <paramref name="at"/> <c>null</c>
    /// binds at every surface point. <paramref name="timeoutMs"/>
    /// <c>null</c> inherits the configured interceptor timeout;
    /// <paramref name="unbounded"/> writes <c>timeout_ms: null</c>.</summary>
    public DeclarationBuilder Bind(
        string id,
        string kind,
        JsonNode? config = null,
        IEnumerable<InterceptionPoint>? at = null,
        long? timeoutMs = null,
        bool unbounded = false)
    {
        var b = new JsonObject
        {
            ["id"] = id,
            ["kind"] = kind,
            ["config"] = config?.DeepClone() ?? new JsonObject(),
        };
        if (at is not null) b["at"] = Points(at);
        if (unbounded) b["timeout_ms"] = null;
        else if (timeoutMs is { } t) b["timeout_ms"] = t;
        if (_doc["bindings"] is not JsonArray bindings)
            _doc["bindings"] = bindings = new JsonArray();
        bindings.Add(b);
        return this;
    }

    /// <summary>One <c>extensions</c> entry, kept verbatim.</summary>
    public DeclarationBuilder Extension(string key, JsonNode? value)
    {
        if (_doc["extensions"] is not JsonObject e)
            _doc["extensions"] = e = new JsonObject();
        e[key] = value?.DeepClone();
        return this;
    }

    /// <summary>Set a top-level member verbatim. For members this builder
    /// has no setter for; the result is validated like any other
    /// document (an unknown member is refused as <c>unknown_field</c>).</summary>
    public DeclarationBuilder Raw(string key, JsonNode? value)
    {
        _doc[key] = value?.DeepClone();
        return this;
    }

    /// <summary>The document as built, before validation (a copy).</summary>
    public JsonObject ToNode() => (JsonObject)_doc.DeepClone();

    /// <summary>Hand the document to <see cref="HostDeclaration.FromNode"/>.</summary>
    public HostDeclaration Build() => HostDeclaration.FromNode(_doc);
}
