// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json.Nodes;
using Draft = AgentHooks.Contracts.Draft;
using static AgentHooks.Contracts.Draft.CompositionProfileExtensions;
using static AgentHooks.Contracts.Draft.ConflictResolutionExtensions;
using static AgentHooks.Contracts.Draft.ModeExtensions;
using static AgentHooks.Contracts.Draft.OnApprovalExtensions;

namespace AgentHooks;

/// <summary>
/// Emits interception points through the bound interceptors under one composition profile and delivers
/// an <see cref="Draft.InterceptionRecord"/> per emission. Immutable and thread-safe.
/// </summary>
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

    public static HookEmitterBuilder CreateBuilder() => new();

    public Draft.Mode Mode { get; }

    /// <summary>The host's posture when a tool seam yields a host error (§7.7.3).</summary>
    public Draft.ToolSeamHostError ToolSeamPosture { get; }

    /// <summary>Emits a generated draft request; <see cref="EmitResult{TRequest}.Request"/> carries any enforced transform.</summary>
    public async Task<EmitResult<TRequest>> EmitAsync<TRequest>(TRequest request, CancellationToken cancellationToken = default)
        where TRequest : class
    {
        ArgumentNullException.ThrowIfNull(request);
        var wire = ContractSerializer.Serialize(request);
        var result = await EmitAsync(wire, cancellationToken);
        var effective = JsonNode.DeepEquals(result.Request, wire) ? request : ContractSerializer.Deserialize<TRequest>(result.Request);
        return new(result.Proceeds, effective, result.Verdict, result.Record);
    }

    /// <summary>Emits a wire request. Invalid requests are denied with <c>host_error:context_invalid</c> before dispatch.</summary>
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
    /// Records an emission the host could not even construct (§10.3, §11): a <c>context_invalid</c> deny with a
    /// payload-free <paramref name="detail"/> and null identities. The host must still fail the action closed.
    /// </summary>
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

        var record = new JsonObject
        {
            ["interception_point"] = point is { } p ? Points.Wire(p) : Points.Wire(Draft.InterceptionPoint.AgentStartup),
            ["mode"] = Mode.ToWire(),
            ["verdict"] = Verdicts.Project(verdict),
            ["input_identity"] = inputIdentity,
            ["enforced_identity"] = enforcedIdentity,
            ["identity_provider"] = _identity?.Name,
            ["session_id"] = request["session"]?["id"] is JsonValue id && id.TryGetValue(out string? session) ? session : "",
            ["sequence"] = request["sequence"] is JsonValue seq && seq.TryGetValue(out long sequence) && sequence >= 0 ? sequence : -1,
            ["decided_by"] = decidedBy,
            ["composition"] = Composition(),
            ["interceptors_registered"] = registered,
        };
        if (request["timestamp"] is JsonValue ts && ts.TryGetValue(out string? timestamp)) record["timestamp"] = timestamp;
        if (request["trace"] is JsonObject trace)
        {
            var correlation = new JsonObject();
            foreach (var name in new[] { "trace_id", "span_id" })
                if (trace[name] is JsonValue v && v.TryGetValue(out string? text)) correlation[name] = text;
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
