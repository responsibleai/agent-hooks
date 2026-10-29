// Copyright (c) Microsoft. All rights reserved.

// Core types for AGENT-HOOKS-0.1 (§3, §5, §7, §8, §9, §10.3, §11).
// Lifted and adapted from policy-engine/sdk/dotnet/.../Primitives.cs.

using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentHooks;

/// <summary>Spec version this SDK implements (§4.1 <c>spec</c> field).</summary>
public static class Spec
{
    public const string Version = "agent-hooks/0.1";

    /// <summary>Name of the default identity provider (§10.1, §10.2).</summary>
    public const string JcsSha256 = "jcs-sha256";
}

/// <summary>The closed set of agent lifecycle interception points (§3).</summary>
public enum InterceptionPoint
{
    AgentStartup,
    Input,
    PreModelCall,
    PostModelCall,
    PreToolCall,
    PostToolCall,
    Output,
    AgentShutdown,
}

public static class InterceptionPointExtensions
{
    public static string ToWireName(this InterceptionPoint hp) => hp switch
    {
        InterceptionPoint.AgentStartup => "agent_startup",
        InterceptionPoint.Input => "input",
        InterceptionPoint.PreModelCall => "pre_model_call",
        InterceptionPoint.PostModelCall => "post_model_call",
        InterceptionPoint.PreToolCall => "pre_tool_call",
        InterceptionPoint.PostToolCall => "post_tool_call",
        InterceptionPoint.Output => "output",
        InterceptionPoint.AgentShutdown => "agent_shutdown",
        _ => throw new ArgumentOutOfRangeException(nameof(hp)),
    };

    public static InterceptionPoint FromWireName(string s) => s switch
    {
        "agent_startup" => InterceptionPoint.AgentStartup,
        "input" => InterceptionPoint.Input,
        "pre_model_call" => InterceptionPoint.PreModelCall,
        "post_model_call" => InterceptionPoint.PostModelCall,
        "pre_tool_call" => InterceptionPoint.PreToolCall,
        "post_tool_call" => InterceptionPoint.PostToolCall,
        "output" => InterceptionPoint.Output,
        "agent_shutdown" => InterceptionPoint.AgentShutdown,
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, "Unknown interception point"),
    };

    /// <summary>Whether a <c>transform</c> verdict is permitted at this point (§3, §4.3).</summary>
    public static bool TransformPermitted(this InterceptionPoint hp) =>
        hp is not (InterceptionPoint.AgentStartup or InterceptionPoint.AgentShutdown);
}

/// <summary>Verdict decision values (§5.1). Three, closed: <c>warn</c> is
/// <c>allow</c> + <c>warnings[]</c>; <c>escalate</c> is <c>deny</c> + an
/// <c>approval</c> block.</summary>
public enum Decision { Allow, Deny, Transform }

public static class DecisionExtensions
{
    public static string ToWireName(this Decision d) => d switch
    {
        Decision.Allow => "allow",
        Decision.Deny => "deny",
        Decision.Transform => "transform",
        _ => throw new ArgumentOutOfRangeException(nameof(d)),
    };

    public static Decision FromWireName(string s) => s switch
    {
        "allow" => Decision.Allow,
        "deny" => Decision.Deny,
        "transform" => Decision.Transform,
        // The closed set is three (§5.1): warn/escalate are not wire
        // decisions anymore; they fail closed at the §5 gate.
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, "Unknown decision"),
    };

    /// <summary>Whether the action proceeds under this decision (§2 permit class).</summary>
    public static bool Permits(this Decision d) =>
        d is Decision.Allow or Decision.Transform;
}

/// <summary>Whether the host acts on verdicts (§8).</summary>
public enum EnforcementMode { Enforce, EvaluateOnly }

/// <summary>Reserved <c>host_error:*</c> reasons a host synthesizes (§11).</summary>
public static class HostError
{
    public const string ContextInvalid = "host_error:context_invalid";
    public const string InterceptorFailed = "host_error:interceptor_failed";
    public const string InterceptorTimeout = "host_error:interceptor_timeout";
    public const string VerdictInvalid = "host_error:verdict_invalid";
    public const string TransformInvalid = "host_error:transform_invalid";
    public const string TransformTargetForbidden = "host_error:transform_target_forbidden";

    /// <summary>§7.5: two or more transforms against the same snapshot in
    /// a parallel profile.</summary>
    public const string TransformConflict = "host_error:transform_conflict";

    /// <summary>§7.5: non-unanimous outcome under <c>parallel/unanimous</c>.</summary>
    public const string CompositionDisagreement = "host_error:composition_disagreement";

    public const string ApprovalResolverFailed = "host_error:approval_resolver_failed";
    public const string ApprovalUnresolved = "host_error:approval_unresolved";

    /// <summary>§9 echo rule: the resolution's <c>context_identity</c> did
    /// not match the request's byte for byte.</summary>
    public const string ApprovalIdentityMismatch = "host_error:approval_identity_mismatch";

    public const string AdapterUnsupported = "host_error:adapter_unsupported";
    public const string StreamingUnsupported = "host_error:streaming_unsupported";

    /// <summary>§7: an <c>enforce</c>-mode emission with zero registered
    /// interceptors fails closed rather than silently allowing everything.</summary>
    public const string NoInterceptor = "host_error:no_interceptor";

    /// <summary>Whether <paramref name="reason"/> is one of the three
    /// interceptor failures <c>on_error</c> covers (§6.3.1): the
    /// interceptor raised, exceeded its timeout, or returned a value
    /// that fails §5 validation. Every other reason stays fail closed
    /// with no knob.</summary>
    public static bool IsControlFailure(string reason) =>
        reason is InterceptorFailed or InterceptorTimeout or VerdictInvalid;
}

/// <summary>Reserved <c>host_warning:*</c> reasons a host synthesizes
/// (§11.1, <c>spec/reserved-warnings.json</c>). Interceptors MUST NOT
/// emit them; the §5 gate refuses such a verdict as
/// <c>host_error:verdict_invalid</c>.</summary>
public static class HostWarning
{
    /// <summary>A registration whose <c>on_error</c> is <c>continue</c>
    /// failed and the host substituted an allow for its slot (§6.3.1).</summary>
    public const string ControlFailed = "host_warning:control_failed";
}

/// <summary>What a registration does when its interceptor fails
/// (§6.3.1). The three covered failures are a raise, a timeout and a
/// §5-invalid return value. <see cref="Deny"/> is the default and the
/// fail-closed posture; <see cref="Continue"/> substitutes an allow
/// carrying <see cref="HostWarning.ControlFailed"/> in the failing
/// registration's slot, records the underlying reason on
/// <c>verdicts[].substituted_for</c> and tells the principal. Nothing
/// else is affected by this setting.</summary>
public enum OnError
{
    Deny,
    Continue,
}

public static class OnErrorExtensions
{
    public static string ToWireName(this OnError e) => e switch
    {
        OnError.Deny => "deny",
        OnError.Continue => "continue",
        _ => throw new ArgumentOutOfRangeException(nameof(e)),
    };

    public static OnError FromWireName(string s) => s switch
    {
        "deny" => OnError.Deny,
        "continue" => OnError.Continue,
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, "Unknown on_error value"),
    };
}

/// <summary>What the host tells the principal when a control failed
/// and the action continued (§6.3.1). Payload-free: the binding label,
/// the reserved reason and the host-synthesized message; never context
/// or target content. <see cref="Binding"/> is the registration name
/// (a declaration binding id) or <c>interceptor-&lt;index&gt;</c> for
/// an unnamed code registration; <see cref="Index"/> is the dispatch
/// index (<c>verdicts[].index</c>); <see cref="Message"/> is
/// <c>&lt;binding&gt;: &lt;reason&gt;; host continued</c>.</summary>
public sealed record ControlFailureNotice(
    InterceptionPoint? InterceptionPoint,
    int Index,
    string Binding,
    string Reason,
    string Message)
{
    internal static ControlFailureNotice FromWire(JsonObject o) => new(
        o["interception_point"] is JsonValue p && p.TryGetValue(out string? point)
            ? InterceptionPointExtensions.FromWireName(point)
            : null,
        (int)o["index"]!,
        (string)o["binding"]!,
        (string)o["reason"]!,
        (string)o["message"]!);
}

// ---- composition (§7) --------------------------------------------------------

/// <summary>The closed profile set (§7.2).</summary>
public enum CompositionProfile
{
    SequentialFirstDeny,
    SequentialRunAll,
    ParallelStrictest,
    ParallelUnanimous,
}

public static class CompositionProfileExtensions
{
    public static string ToWireName(this CompositionProfile p) => p switch
    {
        CompositionProfile.SequentialFirstDeny => "sequential/first_deny",
        CompositionProfile.SequentialRunAll => "sequential/run_all",
        CompositionProfile.ParallelStrictest => "parallel/strictest",
        CompositionProfile.ParallelUnanimous => "parallel/unanimous",
        _ => throw new ArgumentOutOfRangeException(nameof(p)),
    };

    public static CompositionProfile FromWireName(string s) => s switch
    {
        "sequential/first_deny" => CompositionProfile.SequentialFirstDeny,
        "sequential/run_all" => CompositionProfile.SequentialRunAll,
        "parallel/strictest" => CompositionProfile.ParallelStrictest,
        "parallel/unanimous" => CompositionProfile.ParallelUnanimous,
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, "Unknown composition profile"),
    };

    /// <summary>Whether interceptors observe predecessors' transforms (§7.4)
    /// vs. isolated snapshots (§7.5).</summary>
    public static bool IsSequential(this CompositionProfile p) =>
        p is CompositionProfile.SequentialFirstDeny or CompositionProfile.SequentialRunAll;
}

/// <summary><c>sequential/first_deny</c> knob (§7.4): what a permit
/// resolution does to the rest of the fold.</summary>
public enum OnApproval
{
    /// <summary>The resolution becomes the combined verdict; the emission
    /// ends (<c>fold_truncated: true</c>).</summary>
    Stop,

    /// <summary>The resolution substitutes for the denying interceptor's
    /// verdict and the fold continues.</summary>
    Resume,
}

/// <summary><c>"deny" | "approval"</c> knob value (§7.5): synthesize a
/// plain deny, or a liftable one and consult the seam.</summary>
public enum SynthesisPolicy { Deny, Approval }

/// <summary>The composition profile and knobs in effect for one emission
/// (§7.1, §10.3). Serialized verbatim into the record's <c>composition</c>
/// block. Composition is host configuration, never verdict content.</summary>
public sealed record CompositionConfig(
    CompositionProfile Profile,
    OnApproval? OnApproval = null,
    SynthesisPolicy? OnDisagreement = null,
    SynthesisPolicy? OnTransformConflict = null)
{
    /// <summary>Today's pre-P-003 behaviour: <c>sequential/first_deny</c>
    /// with <c>on_approval: stop</c>. A default, not a conformance
    /// baseline — no profile is mandatory (§7.2, §13.1).</summary>
    public static readonly CompositionConfig Default =
        new(CompositionProfile.SequentialFirstDeny, AgentHooks.OnApproval.Stop);

    public static CompositionConfig FirstDeny(OnApproval onApproval) =>
        new(CompositionProfile.SequentialFirstDeny, onApproval);

    public static CompositionConfig RunAll() =>
        new(CompositionProfile.SequentialRunAll);

    public static CompositionConfig Strictest(SynthesisPolicy onTransformConflict) =>
        new(CompositionProfile.ParallelStrictest, OnTransformConflict: onTransformConflict);

    public static CompositionConfig Unanimous(
        SynthesisPolicy onDisagreement, SynthesisPolicy onTransformConflict) =>
        new(CompositionProfile.ParallelUnanimous,
            OnDisagreement: onDisagreement,
            OnTransformConflict: onTransformConflict);

    private static string PolicyWire(SynthesisPolicy p) =>
        p == SynthesisPolicy.Approval ? "approval" : "deny";

    private static SynthesisPolicy PolicyFromWire(string s) => s switch
    {
        "deny" => SynthesisPolicy.Deny,
        "approval" => SynthesisPolicy.Approval,
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, "Unknown synthesis policy"),
    };

    /// <summary>Serialize to the §10.3 <c>composition</c> block.</summary>
    public JsonObject ToWire()
    {
        var o = new JsonObject { ["profile"] = Profile.ToWireName() };
        if (OnApproval is not null)
            o["on_approval"] = OnApproval == AgentHooks.OnApproval.Stop ? "stop" : "resume";
        if (OnDisagreement is not null)
            o["on_disagreement"] = PolicyWire(OnDisagreement.Value);
        if (OnTransformConflict is not null)
            o["on_transform_conflict"] = PolicyWire(OnTransformConflict.Value);
        return o;
    }

    public static CompositionConfig FromWire(JsonObject o) => new(
        CompositionProfileExtensions.FromWireName((string)o["profile"]!),
        (string?)o["on_approval"] switch
        {
            "stop" => AgentHooks.OnApproval.Stop,
            "resume" => AgentHooks.OnApproval.Resume,
            _ => null,
        },
        o["on_disagreement"] is JsonNode d ? PolicyFromWire((string)d!) : null,
        o["on_transform_conflict"] is JsonNode t ? PolicyFromWire((string)t!) : null);
}

// ---- verdict (§5) --------------------------------------------------------

/// <summary>A single <c>$target</c>-rooted replacement (§5.2).</summary>
public sealed record Transform(string Path, JsonNode? Value);

/// <summary>Opaque pointer to an offline-verifiable artefact (§5.3).</summary>
public sealed record Evidence(
    string? Artefact = null,
    IReadOnlyDictionary<string, string>? VerificationPointers = null);

/// <summary>A recorded concern that does not affect control flow (§5.1).</summary>
public sealed record Warning(string? Reason = null, string? Message = null);

/// <summary>Interceptor return value (§5).</summary>
public sealed record Verdict(
    Decision Decision,
    string? Reason = null,
    string? Message = null,
    IReadOnlyList<Warning>? Warnings = null,
    JsonObject? Approval = null,
    Transform? Transform = null,
    Evidence? Evidence = null,
    IReadOnlyList<string>? ResultLabels = null)
{
    /// <summary>The trivial permit verdict.</summary>
    public static readonly Verdict Allow = new(Decision.Allow);

    /// <summary>Constructor sugar for what earlier drafts called
    /// <c>warn</c>: an <c>allow</c> carrying one warning (§5.1).</summary>
    public static Verdict Warn(string? reason = null, string? message = null) =>
        new(Decision.Allow, Warnings: [new Warning(reason, message)]);

    /// <summary>Constructor sugar for a plain, final deny: no
    /// <c>approval</c> block, so the approval seam cannot lift it
    /// (§5.1).</summary>
    public static Verdict Deny(string? reason = null, string? message = null) =>
        new(Decision.Deny, reason, message);

    /// <summary>Constructor sugar for what earlier drafts called
    /// <c>escalate</c>: a liftable deny — denied as-is unless the approval
    /// seam lifts it (§5.1, §9).</summary>
    public static Verdict Escalate(string? reason = null, string? message = null) =>
        new(Decision.Deny, reason, message, Approval: []);

    /// <summary>Host-synthesized deny verdict for a §11 failure.</summary>
    public static Verdict FromHostError(string hookError, string? message = null) =>
        new(Decision.Deny, Reason: hookError, Message: message);

    /// <summary>Host-synthesized <b>liftable</b> deny (§7.5 <c>"approval"</c>
    /// knob value): the failure is consultable rather than final.</summary>
    public static Verdict FromHostErrorLiftable(string hookError, string? message = null) =>
        new(Decision.Deny, Reason: hookError, Message: message, Approval: []);

    /// <summary>The message of the §6.3.1 substituted allow and of the
    /// principal notice: <c>&lt;binding&gt;: &lt;host_error reason&gt;;
    /// host continued</c>. Built from the registration label and the
    /// reserved reason only, so it never carries target-derived
    /// content.</summary>
    public static string ControlFailureMessage(string binding, string reason) =>
        $"{binding}: {reason}; host continued";

    /// <summary>The allow the host substitutes for a failing registration
    /// whose <c>on_error</c> is <c>continue</c> (§6.3.1): decision
    /// <c>allow</c>, one warning with reason
    /// <see cref="HostWarning.ControlFailed"/>, nothing else.
    /// <paramref name="reason"/> MUST be one of the three covered
    /// failures (<see cref="HostError.IsControlFailure"/>).</summary>
    public static Verdict ControlFailureSubstitute(string binding, string reason)
    {
        if (!HostError.IsControlFailure(reason))
            throw new ArgumentException(
                $"{reason} is not a failure on_error covers (§6.3.1)", nameof(reason));
        return Warn(HostWarning.ControlFailed, ControlFailureMessage(binding, reason));
    }

    /// <summary>Whether this verdict is exactly the shape
    /// <see cref="ControlFailureSubstitute"/> produces.</summary>
    public bool IsControlFailureSubstitute =>
        Decision == Decision.Allow
        && Reason is null
        && Message is null
        && Approval is null
        && Transform is null
        && Evidence is null
        && (ResultLabels is null || ResultLabels.Count == 0)
        && Warnings is { Count: 1 }
        && Warnings[0].Reason == HostWarning.ControlFailed;

    /// <summary>A deny carrying an <c>approval</c> block (§5.1).</summary>
    public bool IsLiftable => Decision == Decision.Deny && Approval is not null;

    /// <summary>Validate per §5; throws <see cref="ArgumentException"/> on violation.</summary>
    public void Validate()
    {
        if (Reason?.StartsWith("host_error:", StringComparison.Ordinal) == true)
            throw new ArgumentException("verdict.reason MUST NOT start with 'host_error:' (§5)");
        // §6.3.1/§11.1: host_warning:* is reserved for the host, like
        // host_error:*; an interceptor that emits either spoofs a host
        // substitution.
        foreach (var w in Warnings ?? [])
        {
            if (w.Reason?.StartsWith("host_error:", StringComparison.Ordinal) == true
                || w.Reason?.StartsWith("host_warning:", StringComparison.Ordinal) == true)
                throw new ArgumentException(
                    "verdict.warnings[].reason MUST NOT start with 'host_error:' or 'host_warning:' (§5, §11.1)");
        }
        if (Approval is not null && Decision != Decision.Deny)
            throw new ArgumentException("approval block permitted only on deny (§5.1)");
        if (Decision == Decision.Transform && Transform is null)
            throw new ArgumentException("transform body REQUIRED when decision=='transform' (§5)");
        if (Decision != Decision.Transform && Transform is not null)
            throw new ArgumentException("transform body FORBIDDEN when decision!='transform' (§5)");
    }

    /// <summary>Serialize to the wire shape the Rust core consumes.</summary>
    public JsonObject ToWire()
    {
        var o = new JsonObject { ["decision"] = Decision.ToWireName() };
        if (Reason is not null) o["reason"] = Reason;
        if (Message is not null) o["message"] = Message;
        if (Warnings is { Count: > 0 })
            o["warnings"] = new JsonArray(Warnings.Select(w =>
            {
                var wo = new JsonObject();
                if (w.Reason is not null) wo["reason"] = w.Reason;
                if (w.Message is not null) wo["message"] = w.Message;
                return (JsonNode)wo;
            }).ToArray());
        if (Approval is not null) o["approval"] = Approval.DeepClone();
        if (Transform is not null)
        {
            // Mirrors the core: value serialized only when non-null —
            // the §10.3 record projection drops it. The §5 wire gate
            // checks presence for interceptor verdicts in the core.
            var to = new JsonObject { ["path"] = Transform.Path };
            if (Transform.Value is not null) to["value"] = Transform.Value.DeepClone();
            o["transform"] = to;
        }
        if (Evidence is not null)
        {
            var e = new JsonObject();
            if (Evidence.Artefact is not null) e["artefact"] = Evidence.Artefact;
            if (Evidence.VerificationPointers is { Count: > 0 })
            {
                var vp = new JsonObject();
                foreach (var (k, v) in Evidence.VerificationPointers) vp[k] = v;
                e["verification_pointers"] = vp;
            }
            o["evidence"] = e;
        }
        if (ResultLabels is { Count: > 0 })
            o["result_labels"] = new JsonArray(ResultLabels.Select(l => (JsonNode)l).ToArray());
        return o;
    }

    /// <summary>Reconstruct from a wire-shaped verdict object.
    /// Permissive: accepts host_error:* reasons (used for records emitted by the core).</summary>
    public static Verdict FromWire(JsonObject o)
    {
        List<Warning>? warnings = null;
        if (o["warnings"] is JsonArray wa && wa.Count > 0)
            warnings = wa
                .Select(w => new Warning((string?)w!["reason"], (string?)w!["message"]))
                .ToList();
        Transform? t = null;
        if (o["transform"] is JsonObject to)
            t = new Transform((string)to["path"]!, to["value"]?.DeepClone());
        Evidence? ev = null;
        if (o["evidence"] is JsonObject eo)
            ev = new Evidence(
                (string?)eo["artefact"],
                (eo["verification_pointers"] as JsonObject)?
                    .ToDictionary(kv => kv.Key, kv => (string)kv.Value!));
        var labels = (o["result_labels"] as JsonArray)?
            .Select(n => (string)n!).ToList();
        return new Verdict(
            DecisionExtensions.FromWireName((string)o["decision"]!),
            (string?)o["reason"],
            (string?)o["message"],
            warnings,
            (o["approval"] as JsonObject)?.DeepClone() as JsonObject,
            t, ev, labels);
    }
}

/// <summary>Wire-shaped agent context (§4). Wraps a <see cref="JsonObject"/> so
/// it round-trips to the schema without translation; <see cref="JsonObject"/>
/// is sealed so this is composition, not inheritance.</summary>
public readonly struct AgentContext(JsonObject json)
{
    public JsonObject Json { get; } = json;

    public JsonNode? this[string key] => Json[key];

    public InterceptionPoint InterceptionPoint => InterceptionPointExtensions.FromWireName((string)Json["interception_point"]!);

    public static implicit operator JsonObject(AgentContext ctx) => ctx.Json;
    public static implicit operator AgentContext(JsonObject json) => new(json);
}

/// <summary>Optional hosted/cross-process response envelope (§5.5).</summary>
public sealed record InterceptorResponse(
    Verdict Verdict,
    JsonObject? Extensions = null)
{
    /// <summary>Emit a bare Verdict when no transport metadata is present.</summary>
    public JsonNode ToWire()
    {
        if (Extensions is null || Extensions.Count == 0)
            return Verdict.ToWire();
        return new JsonObject
        {
            ["verdict"] = Verdict.ToWire(),
            ["extensions"] = Extensions.DeepClone(),
        };
    }

    internal static InterceptorResponse FromWire(JsonObject value) => new(
        Verdict.FromWire(value["verdict"]!.AsObject()),
        value["extensions"] as JsonObject);
}

/// <summary>Payload-free per-interceptor summary on the record (§10.3).
/// <c>SubstitutedFor</c> is present iff the host substituted an allow
/// for this registration's failure under <c>on_error: continue</c>
/// (§6.3.1): the underlying <c>host_error:*</c> reason, so an auditor
/// can count continuations and see their cause.</summary>
public sealed record VerdictSummary(
    int Index, Decision Decision, string? Reason, string? Name, string? SubstitutedFor)
{
    /// <summary>The four-component shape shipped before
    /// <c>SubstitutedFor</c> existed. Kept for binary compatibility: an
    /// assembly compiled against it binds to this exact signature. The
    /// defaults let <c>new VerdictSummary(i, d)</c> keep resolving here.</summary>
    public VerdictSummary(int Index, Decision Decision, string? Reason = null, string? Name = null)
        : this(Index, Decision, Reason, Name, SubstitutedFor: null)
    {
    }

    /// <summary>The four-component deconstruction, kept next to the
    /// compiler's five-component one for the same reason.</summary>
    public void Deconstruct(out int Index, out Decision Decision, out string? Reason, out string? Name)
    {
        Index = this.Index;
        Decision = this.Decision;
        Reason = this.Reason;
        Name = this.Name;
    }

    public JsonObject ToWire()
    {
        var o = new JsonObject
        {
            ["index"] = Index,
            ["decision"] = Decision.ToWireName(),
        };
        if (Reason is not null) o["reason"] = Reason;
        if (Name is not null) o["name"] = Name;
        if (SubstitutedFor is not null) o["substituted_for"] = SubstitutedFor;
        return o;
    }

    public static VerdictSummary FromWire(JsonObject o) => new(
        (int)o["index"]!,
        DecisionExtensions.FromWireName((string)o["decision"]!),
        (string?)o["reason"],
        (string?)o["name"],
        (string?)o["substituted_for"]);
}

/// <summary>W3C Trace Context correlation echoed onto the record from
/// the context's optional <c>trace</c> block (§4.5, §10.3).
/// Payload-free: identifiers only.</summary>
public sealed record TraceContext(string? TraceId, string? SpanId)
{
    public JsonObject ToWire()
    {
        var o = new JsonObject();
        if (TraceId is not null) o["trace_id"] = TraceId;
        if (SpanId is not null) o["span_id"] = SpanId;
        return o;
    }

    public static TraceContext FromWire(JsonObject o) =>
        new((string?)o["trace_id"], (string?)o["span_id"]);
}

/// <summary>Host-side record of one emission (§10.3).
///
/// Payload-free by design: the identities (when a provider is declared)
/// bind the record to the exact pre/post-composition context without
/// duplicating the (possibly sensitive) payload into audit storage.
/// <c>Composition</c> makes the record interpretable without out-of-band
/// knowledge of host configuration. <c>Declaration</c> is the host
/// declaration contract version the emitter was built from (§7.7.8),
/// present iff the emitter came from a declaration document. Hosts that
/// need the raw transformed value log it at the callsite.</summary>
public sealed record InterceptionRecord(
    InterceptionPoint InterceptionPoint,
    EnforcementMode Mode,
    Verdict Verdict,
    string? InputIdentity,
    string? EnforcedIdentity,
    string? IdentityProvider,
    string SessionId,
    long Sequence,
    int? DecidedBy,
    CompositionConfig Composition,
    IReadOnlyList<VerdictSummary> Verdicts,
    bool? FoldTruncated,
    string? ResolvedBy,
    int InterceptorsRegistered = 0,
    string? Timestamp = null,
    TraceContext? Trace = null,
    string? Declaration = null)
{
    /// <summary>The constructor shape shipped in 0.1.0-alpha.5, before
    /// <c>Declaration</c> existed. Kept for binary compatibility: an
    /// assembly compiled against the sixteen-parameter constructor
    /// binds to this exact signature. No parameter carries a default,
    /// so source that omits trailing arguments still resolves to the
    /// primary constructor without ambiguity.</summary>
    public InterceptionRecord(
        InterceptionPoint interceptionPoint,
        EnforcementMode mode,
        Verdict verdict,
        string? inputIdentity,
        string? enforcedIdentity,
        string? identityProvider,
        string sessionId,
        long sequence,
        int? decidedBy,
        CompositionConfig composition,
        IReadOnlyList<VerdictSummary> verdicts,
        bool? foldTruncated,
        string? resolvedBy,
        int interceptorsRegistered,
        string? timestamp,
        TraceContext? trace)
        : this(
            interceptionPoint, mode, verdict, inputIdentity, enforcedIdentity,
            identityProvider, sessionId, sequence, decidedBy, composition, verdicts,
            foldTruncated, resolvedBy, interceptorsRegistered, timestamp, trace,
            Declaration: null)
    {
    }

    /// <summary>The sixteen-component deconstruction shipped in
    /// 0.1.0-alpha.5, kept next to the compiler's seventeen-component
    /// one for the same binary-compatibility reason.</summary>
    public void Deconstruct(
        out InterceptionPoint interceptionPoint,
        out EnforcementMode mode,
        out Verdict verdict,
        out string? inputIdentity,
        out string? enforcedIdentity,
        out string? identityProvider,
        out string sessionId,
        out long sequence,
        out int? decidedBy,
        out CompositionConfig composition,
        out IReadOnlyList<VerdictSummary> verdicts,
        out bool? foldTruncated,
        out string? resolvedBy,
        out int interceptorsRegistered,
        out string? timestamp,
        out TraceContext? trace)
    {
        interceptionPoint = InterceptionPoint;
        mode = Mode;
        verdict = Verdict;
        inputIdentity = InputIdentity;
        enforcedIdentity = EnforcedIdentity;
        identityProvider = IdentityProvider;
        sessionId = SessionId;
        sequence = Sequence;
        decidedBy = DecidedBy;
        composition = Composition;
        verdicts = Verdicts;
        foldTruncated = FoldTruncated;
        resolvedBy = ResolvedBy;
        interceptorsRegistered = InterceptorsRegistered;
        timestamp = Timestamp;
        trace = Trace;
    }

    /// <summary>Whether the guarded action executes (§6, §8).</summary>
    public bool Proceeds => Mode == EnforcementMode.EvaluateOnly || Verdict.Decision.Permits();

    /// <summary>Wire shape per <c>spec/schema/interception-record.schema.json</c>.
    /// Mirrors the core's serde serialization: <c>verdicts</c> omitted when
    /// empty; <c>declaration</c>, <c>fold_truncated</c> and
    /// <c>resolved_by</c> omitted when null.</summary>
    public JsonObject ToWire()
    {
        var o = new JsonObject
        {
            ["interception_point"] = InterceptionPoint.ToWireName(),
            ["mode"] = Mode == EnforcementMode.EvaluateOnly ? "evaluate_only" : "enforce",
            ["verdict"] = Verdict.ToWire(),
            ["input_identity"] = InputIdentity,
            ["enforced_identity"] = EnforcedIdentity,
            ["identity_provider"] = IdentityProvider,
            ["session_id"] = SessionId,
            ["sequence"] = Sequence,
            ["decided_by"] = DecidedBy,
            ["composition"] = Composition.ToWire(),
        };
        if (Declaration is not null) o["declaration"] = Declaration;
        if (Verdicts.Count > 0)
            o["verdicts"] = new JsonArray(Verdicts.Select(v => (JsonNode)v.ToWire()).ToArray());
        if (Timestamp is not null) o["timestamp"] = Timestamp;
        if (Trace is not null) o["trace"] = Trace.ToWire();
        if (FoldTruncated is not null) o["fold_truncated"] = FoldTruncated;
        if (ResolvedBy is not null) o["resolved_by"] = ResolvedBy;
        o["interceptors_registered"] = InterceptorsRegistered;
        return o;
    }
}

/// <summary>Interceptor protocol (§7).</summary>
public interface IInterceptor
{
    ValueTask<Verdict> InterceptAsync(AgentContext context, CancellationToken ct = default);
}

/// <summary>The four typed completions of a managed interceptor (§7
/// timeout ownership, §6.3.1).</summary>
public enum ManagedOutcomeKind
{
    /// <summary>A verdict; it crosses the same §5 gate as any interceptor's.</summary>
    Verdict,

    /// <summary>The work exceeded the resolved bound and has been
    /// cancelled and cleaned up. Recorded as
    /// <c>host_error:interceptor_timeout</c>; follows <c>on_error</c>.</summary>
    Timeout,

    /// <summary>The host cancelled the work for its own reasons.
    /// Recorded as <c>host_error:interceptor_failed</c>; never a
    /// timeout and never continues, whatever <c>on_error</c> says.</summary>
    Cancelled,

    /// <summary>The work failed. Recorded as
    /// <c>host_error:interceptor_failed</c>; follows <c>on_error</c>.</summary>
    Failed,
}

/// <summary>Typed completion of an <see cref="IManagedInterceptor"/>
/// (§7). <see cref="Timeout"/> is reported only after the interceptor
/// has cancelled and cleaned up its external work; <see cref="Cancelled"/>
/// is never a timeout and never continues.</summary>
public sealed class ManagedInterceptorOutcome
{
    private ManagedInterceptorOutcome(ManagedOutcomeKind kind, Verdict? verdict, string? detail)
    {
        Kind = kind;
        Verdict = verdict;
        Detail = detail;
    }

    public ManagedOutcomeKind Kind { get; }

    /// <summary>The verdict; non-null iff <see cref="Kind"/> is
    /// <see cref="ManagedOutcomeKind.Verdict"/>.</summary>
    public Verdict? Verdict { get; }

    /// <summary>Payload-free detail of a <see cref="ManagedOutcomeKind.Failed"/>
    /// outcome (an exception type name, never content).</summary>
    public string? Detail { get; }

    /// <summary>The work produced a verdict.</summary>
    public static ManagedInterceptorOutcome FromVerdict(Verdict verdict)
    {
        ArgumentNullException.ThrowIfNull(verdict);
        return new(ManagedOutcomeKind.Verdict, verdict, null);
    }

    /// <summary>The work exceeded the bound and is no longer running.</summary>
    public static readonly ManagedInterceptorOutcome Timeout = new(ManagedOutcomeKind.Timeout, null, null);

    /// <summary>The host cancelled the work.</summary>
    public static readonly ManagedInterceptorOutcome Cancelled = new(ManagedOutcomeKind.Cancelled, null, null);

    /// <summary>The work failed; <paramref name="detail"/> is a
    /// payload-free type name or <c>null</c>.</summary>
    public static ManagedInterceptorOutcome Failed(string? detail = null) =>
        new(ManagedOutcomeKind.Failed, null, detail);

    /// <summary>The wire shape <c>ah_managed_outcome</c> consumes:
    /// <c>{"outcome": "verdict", "verdict": {...}}</c> |
    /// <c>{"outcome": "timeout"}</c> | <c>{"outcome": "cancelled"}</c> |
    /// <c>{"outcome": "failed", "detail"?: "..."}</c>.</summary>
    public JsonObject ToWire()
    {
        var o = new JsonObject
        {
            ["outcome"] = Kind switch
            {
                ManagedOutcomeKind.Verdict => "verdict",
                ManagedOutcomeKind.Timeout => "timeout",
                ManagedOutcomeKind.Cancelled => "cancelled",
                _ => "failed",
            },
        };
        if (Verdict is not null) o["verdict"] = Verdict.ToWire();
        if (Detail is not null) o["detail"] = Detail;
        return o;
    }
}

/// <summary>An interceptor that owns external work (a process, an HTTP
/// call) and therefore its own deadline (§7). The emitter does not wrap
/// it in the outer timer; instead it hands the interceptor the resolved
/// bound for the registration (<c>null</c> is unbounded), and the
/// interceptor MUST cancel and clean up the work before it reports
/// <see cref="ManagedInterceptorOutcome.Timeout"/>. The cancellation
/// token is the host's: a cancelled token is the
/// <see cref="ManagedInterceptorOutcome.Cancelled"/> case, never a
/// timeout.</summary>
public interface IManagedInterceptor
{
    ValueTask<ManagedInterceptorOutcome> InterceptManagedAsync(
        AgentContext context, TimeSpan? bound, CancellationToken ct = default);
}

/// <summary>Approval seam (§9).</summary>
public enum ApprovalOutcome { Approve, Reject, Unresolved }

/// <summary>What the host hands the resolver when a profile consults the
/// seam (§9). <c>ContextIdentity</c> is <c>null</c> when the identity
/// provider is <c>null</c> (§10.1) — the approval is then identity-unbound.</summary>
public sealed record ApprovalRequest(
    string? ContextIdentity,
    InterceptionPoint InterceptionPoint,
    Verdict Verdict,
    AgentContext Context);

/// <summary>What the resolver returns (§9). <c>ContextIdentity</c> MUST
/// echo the request's byte for byte (<c>null</c> echoes as <c>null</c>).</summary>
public sealed record ApprovalResolution(
    ApprovalOutcome Outcome,
    string? ContextIdentity,
    Verdict? Verdict = null);

public interface IApprovalResolver
{
    ValueTask<ApprovalResolution> ResolveAsync(ApprovalRequest request, CancellationToken ct = default);
}

/// <summary>Raised by a host when a verdict blocks the guarded action (§6).</summary>
/// <summary>Returned by <c>InterceptionEmitter.EmitAsync</c> on a
/// proceeding emission: the record plus the <b>effective</b>
/// (post-composition) target the guarded action MUST consume (§4.3).</summary>
public sealed record EmitOutcome(InterceptionRecord Record, JsonNode? Target);

public sealed class InterceptionBlockedException(InterceptionRecord result)
    : InvalidOperationException(
        $"{result.InterceptionPoint.ToWireName()} blocked: {result.Verdict.Decision.ToWireName()} ({result.Verdict.Reason ?? "no reason"})")
{
    public InterceptionRecord Result { get; } = result;
}
