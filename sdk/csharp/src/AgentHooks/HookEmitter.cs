// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json;
using System.Text.Json.Nodes;
using Draft = AgentHooks.Contracts.Draft;
using static AgentHooks.Contracts.Draft.CompositionProfileExtensions;
using static AgentHooks.Contracts.Draft.ConflictResolutionExtensions;
using static AgentHooks.Contracts.Draft.ModeExtensions;
using static AgentHooks.Contracts.Draft.OnApprovalExtensions;

namespace AgentHooks;

/// <summary>
/// Emits interception points through bound interceptors under one composition profile and delivers
/// an <see cref="Draft.InterceptionRecord" /> per emission.
/// </summary>
/// <remarks>
/// <para>
/// Instances are immutable and safe for concurrent use across threads. Each interceptor invocation receives an
/// isolated deep clone of the request so mutations never leak to the caller or other bindings.
/// </para>
/// <para>
/// The emitter fails closed: invalid requests, missing bindings, timeouts, unhandled exceptions, cancellation,
/// invalid verdicts, invalid whole-target transforms, and identity-provider failures on permitting verdicts all
/// synthesize a reserved <c>host_error:*</c> deny verdict (unless an eligible interceptor failure is substituted
/// under <c>on_error: continue</c> with a configured control-failure notifier).
/// </para>
/// <para>
/// Whole-target transforms are validated in both modes and applied to the effective request only in
/// <see cref="Draft.Mode.Enforce" /> mode. Exceptions thrown by the configured record sink are swallowed so
/// audit delivery never disrupts emission.
/// </para>
/// </remarks>
public sealed partial class HookEmitter
{
    private sealed record Binding(
        IHookInterceptor Interceptor, string? Name, IReadOnlySet<Draft.InterceptionPoint>? Points, TimeSpan Timeout, Draft.OnError OnError);

    private sealed record Failure(string Reason, string? Detail, bool Continuable);

    private sealed record Outcome(
        JsonObject Verdict, int? DecidedBy, List<JsonObject> Slots, bool? FoldTruncated = null, string? ResolvedBy = null)
    {
        internal static Outcome Synthesized(string reason, string? detail = null) => new(Verdicts.HostError(reason, detail), null, []);
    }

    private readonly Binding[] _bindings;
    private readonly Draft.CompositionProfile _profile;
    private readonly Draft.OnApproval _onApproval;
    private readonly Draft.ConflictResolution _onTransformConflict;
    private readonly Draft.ConflictResolution _onDisagreement;
    private readonly IdentityProvider? _identity;
    private readonly IApprovalResolver? _resolver;
    private readonly Func<JsonObject, JsonObject>? _redactor;
    private readonly TimeSpan _resolverTimeout;
    private readonly Action<ControlFailureNotice>? _notifier;
    private readonly Action<Draft.InterceptionRecord>? _sink;

    internal HookEmitter(HookEmitterBuilder builder)
    {
        Mode = builder.Mode;
        ToolSeamPosture = builder.ToolSeamPosture;
        _bindings = builder.Bindings
            .Select(b => new Binding(b.Interceptor, b.Name, b.Points, b.Timeout ?? builder.InterceptorTimeout, b.OnError ?? builder.DefaultOnError))
            .ToArray();
        (_profile, _onApproval, _onTransformConflict, _onDisagreement) =
            (builder.Profile, builder.OnApproval, builder.OnTransformConflict, builder.OnDisagreement);
        _identity = builder.Identity;
        _resolver = builder.Resolver;
        _redactor = builder.Redactor;
        _resolverTimeout = builder.ResolverTimeout ?? builder.InterceptorTimeout;
        _notifier = builder.Notifier;
        _sink = builder.Sink;
        Declaration = (JsonObject?)builder.Declaration?.DeepClone();
    }

    /// <summary>Creates a new builder for configuring a <see cref="HookEmitter" />.</summary>
    /// <returns>A new <see cref="HookEmitterBuilder" /> initialized with specification defaults.</returns>
    public static HookEmitterBuilder CreateBuilder() => new();

    /// <summary>Gets the emitter's enforcement mode (§8).</summary>
    public Draft.Mode Mode { get; }

    /// <summary>Gets the host's posture when a tool seam yields a host error (§7.7.3).</summary>
    public Draft.ToolSeamHostError ToolSeamPosture { get; }

    /// <summary>
    /// Emits a generated draft request through the bound interceptors.
    /// </summary>
    /// <typeparam name="TRequest">The generated draft request contract type.</typeparam>
    /// <param name="request">The typed candidate request to evaluate.</param>
    /// <param name="cancellationToken">A token that cancels active interceptor or approval-resolver invocations.</param>
    /// <returns>
    /// A task resolving to an <see cref="EmitResult{TRequest}" /> whose <see cref="EmitResult{TRequest}.Request" />
    /// carries any enforced whole-target transform (or the original <paramref name="request" /> instance when
    /// unchanged).
    /// </returns>
    /// <exception cref="ArgumentNullException"><paramref name="request" /> is <see langword="null" />.</exception>
    /// <exception cref="JsonException"><paramref name="request" /> fails strict wire-JSON serialization (for example, lone UTF-16 surrogates).</exception>
    public async Task<EmitResult<TRequest>> EmitAsync<TRequest>(TRequest request, CancellationToken cancellationToken = default)
        where TRequest : class
    {
        ArgumentNullException.ThrowIfNull(request);
        var wire = ContractSerializer.Serialize(request);
        var result = await EmitAsync(wire, cancellationToken);
        var effective = JsonNode.DeepEquals(result.Request, wire) ? request : ContractSerializer.Deserialize<TRequest>(result.Request);
        return new(result.Proceeds, effective, result.Verdict, result.Record);
    }

    /// <summary>
    /// Emits a wire JSON request through the bound interceptors and delivers an <see cref="Draft.InterceptionRecord" />.
    /// </summary>
    /// <param name="request">The wire request object; never mutated in place.</param>
    /// <param name="cancellationToken">A token that cancels active interceptor or approval-resolver invocations.</param>
    /// <returns>A task resolving to the emission outcome, effective request, combined verdict, and projected record.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="request" /> is <see langword="null" />.</exception>
    /// <remarks>
    /// Invalid requests and identity-provider failures fail closed with <see cref="HostErrors.ContextInvalid" />
    /// before any interceptor is invoked. If <paramref name="cancellationToken" /> is canceled during dispatch, the
    /// emission does not throw; it fails closed with a non-continuable <see cref="HostErrors.InterceptorFailed" />
    /// deny and still emits an interception record.
    /// </remarks>
    public async Task<EmitResult> EmitAsync(JsonObject request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        var state = (JsonObject)request.DeepClone();
        var point = Points.Parse(state["interception_point"]);
        var active = point is { } p ? _bindings.Where(b => b.Points?.Contains(p) ?? true).ToArray() : [];
        var problem = point is { } q ? RequestProblem(state, q) : "$.interception_point: missing or not one of the eight closed values (see spec §4)";
        string? inputIdentity = null;
        Outcome? outcome = problem is null ? null : Outcome.Synthesized(HostErrors.ContextInvalid, problem);
        if (outcome is null)
        {
            try { inputIdentity = _identity?.Compute(state); }
            catch (HookException e) { outcome = Outcome.Synthesized(e.Reason, e.Detail); }
            catch (Exception e)
            {
                outcome = Outcome.Synthesized(HostErrors.ContextInvalid, $"identity provider failed: {e.GetType().Name} (see spec §10.1)");
            }
        }
        outcome ??= await DispatchAsync(point!.Value, state, active, cancellationToken);
        var (verdict, record) = Finalize(state, point, problem is null, outcome, inputIdentity, active.Length);
        return new(Mode == Draft.Mode.EvaluateOnly || Verdicts.Permits(verdict), state, verdict, record);
    }

    /// <summary>
    /// Records an emission the host could not construct (§10.3, §11) and delivers it to the configured record sink.
    /// </summary>
    /// <param name="point">The interception point at which request construction failed.</param>
    /// <param name="detail">Optional payload-free diagnostic detail attached to the synthesized deny message.</param>
    /// <param name="sessionId">Optional session identifier, if known.</param>
    /// <param name="sequence">Optional non-negative sequence number; omitted or negative values are recorded as <c>-1</c>.</param>
    /// <param name="timestamp">Optional RFC 3339 timestamp string, if known.</param>
    /// <returns>The projected <see cref="Draft.InterceptionRecord" /> carrying a <see cref="HostErrors.ContextInvalid" /> deny and <see langword="null" /> identities.</returns>
    /// <remarks>
    /// This method records the failure only; the host must still fail the guarded action closed.
    /// </remarks>
    public Draft.InterceptionRecord RecordHostFailure(
        Draft.InterceptionPoint point, string? detail = null, string? sessionId = null, long? sequence = null, string? timestamp = null)
    {
        var basis = new JsonObject { ["interception_point"] = Points.Wire(point) };
        if (sessionId is not null) basis["session"] = new JsonObject { ["id"] = sessionId };
        if (sequence is { } s) basis["sequence"] = s;
        if (timestamp is not null) basis["timestamp"] = timestamp;
        var registered = _bindings.Count(b => b.Points?.Contains(point) ?? true);
        return Finalize(basis, point, false, Outcome.Synthesized(HostErrors.ContextInvalid, detail), null, registered).Record;
    }

    private static string? RequestProblem(JsonObject request, Draft.InterceptionPoint point)
    {
        try { UnicodeValidation.CheckObjectGraph(request); }
        catch (JsonException) { return "$: contains a lone UTF-16 surrogate (see spec §4.4)"; }
        var schema = Points.RequestSchema(point);
        if (Schemas.IsValid(request, schema)) return null;
        var pointer = Schemas.Errors(request, schema).Select(e => e.Pointer).FirstOrDefault(p => p.Length > 0) ?? "";
        return $"${pointer.Replace('/', '.')}: does not satisfy the {schema} request schema (see spec §4)";
    }

    private (JsonObject Verdict, Draft.InterceptionRecord Record) Finalize(
        JsonObject request, Draft.InterceptionPoint? point, bool valid, Outcome outcome, string? inputIdentity, int registered)
    {
        var verdict = outcome.Verdict;
        var decidedBy = outcome.DecidedBy;
        string? enforcedIdentity = null;
        if (!valid) inputIdentity = null;
        else if (_identity is not null && inputIdentity is not null)
        {
            // §10.1: a permitting verdict never goes out unbound; any provider failure fails it closed.
            try { enforcedIdentity = _identity.Compute(request); }
            catch (Exception e) when (Verdicts.Permits(verdict))
            {
                var (reason, detail) = e is HookException h
                    ? (h.Reason, h.Detail)
                    : (HostErrors.ContextInvalid, $"identity provider failed: {e.GetType().Name} (see spec §10.1)");
                (verdict, decidedBy) = (Verdicts.HostError(reason, detail), null);
            }
            catch (Exception) { }
        }

        static string? SafeString(JsonNode? node) =>
            node is JsonValue v && v.TryGetValue(out string? text) && UnicodeValidation.IsValidString(text) ? text : null;

        static JsonNode SafeSequence(JsonNode? node, bool isValid) =>
            isValid && node is not null ? node.DeepClone()
            : node is JsonValue v && v.TryGetValue(out long l) && l >= 0 ? l
            : node is JsonValue vi && vi.TryGetValue(out int i) && i >= 0 ? i
            : -1;

        var record = new JsonObject
        {
            ["interception_point"] = point is { } p ? Points.Wire(p) : Points.Wire(Draft.InterceptionPoint.AgentStartup),
            ["mode"] = Mode.ToWire(),
            ["verdict"] = Verdicts.Project(verdict),
            ["input_identity"] = inputIdentity,
            ["enforced_identity"] = enforcedIdentity,
            ["identity_provider"] = _identity?.Name,
            ["session_id"] = SafeString((request["session"] as JsonObject)?["id"]) ?? "",
            ["sequence"] = SafeSequence(request["sequence"], valid),
            ["decided_by"] = decidedBy,
            ["composition"] = Composition(),
            ["interceptors_registered"] = registered,
        };
        if (SafeString(request["timestamp"]) is { } timestamp) record["timestamp"] = timestamp;
        if (request["trace"] is JsonObject trace)
        {
            var correlation = new JsonObject();
            foreach (var name in new[] { "trace_id", "span_id" })
                if (SafeString(trace[name]) is { } text) correlation[name] = text;
            if (correlation.Count > 0) record["trace"] = correlation;
        }
        if (outcome.Slots.Count > 0 || _profile != Draft.CompositionProfile.SequentialFirstDeny)
            record["verdicts"] = new JsonArray(outcome.Slots.Select(s => (JsonNode)s.DeepClone()).ToArray());
        if (outcome.FoldTruncated is { } truncated) record["fold_truncated"] = truncated;
        if (outcome.ResolvedBy is { } resolvedBy) record["resolved_by"] = resolvedBy;

        var typed = ContractSerializer.Deserialize<Draft.InterceptionRecord>(record);
        try { _sink?.Invoke(typed); }
        catch (Exception) { }
        return (verdict, typed);
    }

    private JsonObject Composition()
    {
        var composition = new JsonObject { ["profile"] = _profile.ToWire() };
        switch (_profile)
        {
            case Draft.CompositionProfile.SequentialFirstDeny: composition["on_approval"] = _onApproval.ToWire(); break;
            case Draft.CompositionProfile.ParallelStrictest: composition["on_transform_conflict"] = _onTransformConflict.ToWire(); break;
            case Draft.CompositionProfile.ParallelUnanimous: composition["on_disagreement"] = _onDisagreement.ToWire(); break;
        }
        return composition;
    }
}
