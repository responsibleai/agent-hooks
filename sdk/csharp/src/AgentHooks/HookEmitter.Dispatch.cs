// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json;
using System.Text.Json.Nodes;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks;

// Dispatch under the §7 composition profiles, the §6.3 failure posture and the §9 approval seam.
public sealed partial class HookEmitter
{
    private sealed record Consultation(JsonObject Verdict, bool Permitted);

    private Task<Outcome> DispatchAsync(
        Draft.InterceptionPoint point, JsonObject state, Binding[] active, CancellationToken ct)
    {
        if (active.Length == 0)
            return Task.FromResult(Outcome.Synthesized(HostErrors.NoInterceptor, "no interceptor is bound at this point (see spec §6.2)"));
        return _profile switch
        {
            Draft.CompositionProfile.SequentialFirstDeny => FirstDenyAsync(point, state, active, ct),
            Draft.CompositionProfile.SequentialRunAll => RunAllAsync(point, state, active, ct),
            _ => ParallelAsync(point, state, active, ct),
        };
    }

    private async Task<Outcome> FirstDenyAsync(Draft.InterceptionPoint point, JsonObject state, Binding[] active, CancellationToken ct)
    {
        var slots = new List<JsonObject>();
        var pool = new List<JsonObject>();
        (int Index, JsonObject Verdict)? lastTransform = null;
        string? resolvedBy = null;
        bool Truncated(int i) => i + 1 < active.Length;

        for (var i = 0; i < active.Length; i++)
        {
            var (v, substitutedFor) = Settle(point, i, active[i], await CallAsync(point, state, active[i], ct));
            slots.Add(Verdicts.Slot(i, v, active[i].Name, substitutedFor));
            pool.Add(v);
            if (Verdicts.IsHostSynthesized(v))
                return new(Verdicts.WithUnions(v, pool), i, slots, Truncated(i), resolvedBy);

            if (Verdicts.Decision(v) == "deny")
            {
                if (await ConsultAsync(point, state, v, ct) is not { } c)
                    return new(Verdicts.WithUnions(v, pool), i, slots, Truncated(i), resolvedBy);
                if (!c.Permitted)
                    return new(Verdicts.WithUnions(c.Verdict, [.. pool, c.Verdict]), Verdicts.IsHostSynthesized(c.Verdict) ? null : i, slots, Truncated(i), "rejection");
                resolvedBy = "approval";
                pool.Add(c.Verdict);
                if (_onApproval == Draft.OnApproval.Stop)
                    return new(Verdicts.WithUnions(c.Verdict, pool), i, slots, Truncated(i), resolvedBy);
            }
            else if (Verdicts.Decision(v) == "transform")
            {
                if (Fold(point, state, v) is { } failure)
                    return new(Verdicts.WithUnions(failure, pool), null, slots, Truncated(i), resolvedBy);
                lastTransform = (i, v);
            }
        }

        var (combined, decidedBy) = lastTransform is { } t ? (t.Verdict, (int?)t.Index) : (Verdicts.Allow(), null);
        return new(Verdicts.WithUnions(combined, pool), decidedBy, slots, false, resolvedBy);
    }

    private async Task<Outcome> RunAllAsync(Draft.InterceptionPoint point, JsonObject state, Binding[] active, CancellationToken ct)
    {
        var all = new List<JsonObject>();
        var slots = new List<JsonObject>();
        for (var i = 0; i < active.Length; i++)
        {
            var (v, substitutedFor) = Settle(point, i, active[i], await CallAsync(point, state, active[i], ct));
            if (Verdicts.Decision(v) == "transform" && Fold(point, state, v) is { } failure)
            {
                slots.Add(Verdicts.Slot(i, failure, active[i].Name, substitutedFor));
                return new(Verdicts.WithUnions(failure, [.. all, v]), null, slots, i + 1 < active.Length);
            }
            all.Add(v);
            slots.Add(Verdicts.Slot(i, v, active[i].Name, substitutedFor));
        }
        return await AggregateAsync(point, state, all, slots, ct);
    }

    private async Task<Outcome> ParallelAsync(Draft.InterceptionPoint point, JsonObject state, Binding[] active, CancellationToken ct)
    {
        var snapshot = (JsonObject)state.DeepClone();
        var failures = await Task.WhenAll(active.Select(b => CallAsync(point, snapshot, b, ct)));
        var all = new List<JsonObject>();
        var slots = new List<JsonObject>();
        for (var i = 0; i < active.Length; i++)
        {
            var (v, substitutedFor) = Settle(point, i, active[i], failures[i]);
            all.Add(v);
            slots.Add(Verdicts.Slot(i, v, active[i].Name, substitutedFor));
        }
        return await AggregateAsync(point, state, all, slots, ct);
    }

    /// <summary>Severity-max aggregation (§7.3) with the parallel conflict rules (§7.5), then at most one consultation.</summary>
    private async Task<Outcome> AggregateAsync(
        Draft.InterceptionPoint point, JsonObject state, List<JsonObject> all, List<JsonObject> slots, CancellationToken ct)
    {
        var parallel = _profile is Draft.CompositionProfile.ParallelStrictest or Draft.CompositionProfile.ParallelUnanimous;
        var max = all.Max(Verdicts.Severity);
        var top = Enumerable.Range(0, all.Count).Where(i => Verdicts.Severity(all[i]) == max).ToList();
        JsonObject combined;
        int? decidedBy = null;
        if (_profile == Draft.CompositionProfile.ParallelUnanimous && max > 0)
        {
            combined = Verdicts.HostError(
                HostErrors.CompositionDisagreement, "non-unanimous outcome under parallel/unanimous (see spec §7.5)",
                _onDisagreement == Draft.ConflictResolution.Approval);
        }
        else if (parallel && max == 1 && top.Count > 1)
        {
            combined = Verdicts.HostError(
                HostErrors.TransformConflict, $"conflicting transforms from interceptors [{string.Join(", ", top)}] (see spec §7.5)",
                _onTransformConflict == Draft.ConflictResolution.Approval);
        }
        else
        {
            var winner = !parallel && max == 1 ? top[^1] : top[0];
            combined = all[winner];
            if (max > 0) decidedBy = winner;
            if (parallel && max == 1 && Fold(point, state, combined) is { } failure)
                return new(Verdicts.WithUnions(failure, all), null, slots);
        }
        combined = Verdicts.WithUnions(combined, all);

        string? resolvedBy = null;
        if (await ConsultAsync(point, state, combined, ct) is { } c)
        {
            if (c.Permitted)
            {
                resolvedBy = "approval";
                combined = Verdicts.WithUnions(c.Verdict, [.. all, c.Verdict]);
            }
            else
            {
                resolvedBy = "rejection";
                combined = Verdicts.WithUnions(c.Verdict, [.. all, c.Verdict]);
                if (Verdicts.IsHostSynthesized(c.Verdict)) decidedBy = null;
            }
        }
        return new(combined, decidedBy, slots, ResolvedBy: resolvedBy);
    }

    /// <summary>Calls one interceptor on an isolated copy under its time limit; returns its verdict or a §6.3 failure.</summary>
    private async Task<(JsonObject? Verdict, Failure? Failure)> CallAsync(
        Draft.InterceptionPoint point, JsonObject state, Binding binding, CancellationToken ct)
    {
        var call = new HookCall(point, (JsonObject)state.DeepClone(), binding.Timeout);
        HookOutcome outcome;
        try
        {
            var (timedOut, value) = await RaceAsync(binding.Timeout, t => binding.Interceptor.InterceptAsync(call, t), ct);
            if (timedOut) return (null, new(HostErrors.InterceptorTimeout, "timeout", true));
            outcome = value!;
        }
        catch (Exception e)
        {
            return (null, new(HostErrors.InterceptorFailed, e.GetType().Name, !ct.IsCancellationRequested));
        }
        return outcome switch
        {
            HookOutcome.Responded { Body: var body } => Verdicts.Gate(point, body) is { } detail
                ? (null, new(HostErrors.VerdictInvalid, detail, true))
                : ((JsonObject)body["verdict"]!.DeepClone(), null),
            HookOutcome.TimedOut => (null, new(HostErrors.InterceptorTimeout, "timeout", true)),
            HookOutcome.Cancelled => (null, new(HostErrors.InterceptorFailed, "the interceptor was cancelled (see spec §6.3)", false)),
            HookOutcome.Failed { Detail: var detail } => (null, new(HostErrors.InterceptorFailed, detail, true)),
            _ => (null, new(HostErrors.InterceptorFailed, outcome.GetType().Name, true)),
        };
    }

    /// <summary>Applies <c>on_error</c> (§6.3.1): a deny, or the notified allow substitute under <c>continue</c>.</summary>
    private (JsonObject Verdict, string? SubstitutedFor) Settle(
        Draft.InterceptionPoint point, int index, Binding binding, (JsonObject? Verdict, Failure? Failure) call)
    {
        if (call.Failure is not { } failure) return (call.Verdict!, null);
        if (binding.OnError != Draft.OnError.Continue || !failure.Continuable)
            return (Verdicts.HostError(failure.Reason, failure.Detail), null);
        if (_notifier is null)
            return (Verdicts.HostError(failure.Reason, "on_error: continue without a control failure notifier; the deny stands (see spec §6.3)"), null);
        var label = binding.Name ?? $"interceptor-{index}";
        var message = $"{label}: {failure.Reason}; host continued";
        try { _notifier(new(index, label, failure.Reason, message, point)); }
        catch (Exception e)
        {
            return (Verdicts.HostError(failure.Reason, $"control failure notifier threw {e.GetType().Name}; the deny stands (see spec §6.3)"), null);
        }
        return (Verdicts.Substitute(message), failure.Reason);
    }

    /// <summary>
    /// Applies a whole-member transform (§5) to <paramref name="state"/> in enforce mode, or only validates it in
    /// evaluate-only mode. Returns the host-error deny when the candidate request is invalid.
    /// </summary>
    private JsonObject? Fold(Draft.InterceptionPoint point, JsonObject state, JsonObject verdict)
    {
        if (Points.TransformTarget(point) is not var (member, path)
            || verdict["transform"] is not JsonObject transform
            || !transform.TryGetPropertyValue(member, out var value))
            return Verdicts.HostError(HostErrors.TransformInvalid, "transforms are forbidden at this point (see spec §5)");
        var candidate = (JsonObject)state.DeepClone();
        var parent = candidate;
        foreach (var step in path[..^1])
        {
            if (parent[step] is not JsonObject next)
                return Verdicts.HostError(HostErrors.TransformInvalid, "the transform target is absent (see spec §5)");
            parent = next;
        }
        parent[path[^1]] = value?.DeepClone();
        if (!Schemas.IsValid(candidate, Points.RequestSchema(point)))
            return Verdicts.HostError(HostErrors.TransformInvalid, $"the transformed request does not satisfy the {Points.RequestSchema(point)} schema (see spec §5)");
        if (Mode == Draft.Mode.Enforce)
        {
            state.Clear();
            foreach (var (key, node) in candidate.ToList())
            {
                candidate.Remove(key);
                state[key] = node;
            }
        }
        return null;
    }

    /// <summary>Consults the approval resolver for a liftable deny (§9); null when the seam does not apply.</summary>
    private async Task<Consultation?> ConsultAsync(
        Draft.InterceptionPoint point, JsonObject state, JsonObject verdict, CancellationToken ct)
    {
        if (!Verdicts.IsLiftable(verdict) || Mode != Draft.Mode.Enforce || point == Draft.InterceptionPoint.AgentShutdown || _resolver is null)
            return null;
        static Consultation Fail(string reason, string? detail = null) => new(Verdicts.HostError(reason, detail), false);

        JsonObject presented;
        if (_redactor is null)
        {
            presented = (JsonObject)state.DeepClone();
        }
        else
        {
            try { presented = _redactor((JsonObject)state.DeepClone()); }
            catch (Exception e) { return Fail(HostErrors.ApprovalResolverFailed, e.GetType().Name); }
            if (presented is null) return Fail(HostErrors.ApprovalResolverFailed, "the approval redactor returned no context (see spec §9)");
        }

        string? identity;
        try { identity = _identity?.Compute(presented); }
        catch (HookException e) { return Fail(e.Reason, e.Detail); }
        catch (Exception e) { return Fail(HostErrors.ApprovalResolverFailed, e.GetType().Name); }

        var request = new JsonObject
        {
            ["context_identity"] = identity,
            ["interception_point"] = Points.Wire(point),
            ["verdict"] = verdict.DeepClone(),
            ["context"] = presented,
        };
        JsonObject resolution;
        try
        {
            var (timedOut, value) = await RaceAsync(_resolverTimeout, t => _resolver.ResolveAsync(request, t), ct);
            if (timedOut) return Fail(HostErrors.ApprovalResolverFailed, "timeout");
            resolution = value!;
        }
        catch (Exception e) { return Fail(HostErrors.ApprovalResolverFailed, e.GetType().Name); }

        // §9 order: identity echo, then outcome/verdict shape, then unresolved, then the resolution schema.
        if (resolution is null) return Fail(HostErrors.ApprovalResolverFailed, "the resolver returned no resolution (see spec §9)");
        if (!resolution.TryGetPropertyValue("context_identity", out var rawEcho)
            || !(identity is null ? rawEcho is null : rawEcho is JsonValue v && v.TryGetValue(out string? s) && s == identity))
            return Fail(HostErrors.ApprovalIdentityMismatch);
        var outcome = resolution["outcome"] is JsonValue o && o.TryGetValue(out string? text) ? text : null;
        if (outcome is not ("approve" or "reject" or "unresolved") || (outcome == "unresolved") == resolution.ContainsKey("verdict"))
            return Fail(HostErrors.ApprovalResolverFailed, "the resolution outcome and verdict disagree (see spec §9)");
        if (outcome == "unresolved") return Fail(HostErrors.ApprovalUnresolved);
        if (!Schemas.IsValid(resolution, nameof(Draft.ApprovalResolution)) || resolution["verdict"] is not JsonObject resolved)
            return Fail(HostErrors.VerdictInvalid, "the resolution does not satisfy the approval resolution schema (see spec §9)");
        try
        {
            UnicodeValidation.CheckObjectGraph(resolution);
            if (resolved["evidence"] is { } evidence && Jcs.CanonicalSize(evidence) > 10240)
                return Fail(HostErrors.VerdictInvalid, "evidence canonical size exceeds 10240 bytes (see spec §5.3)");
        }
        catch (Exception e) when (e is HookException or JsonException)
        {
            return Fail(HostErrors.VerdictInvalid, "resolution metadata is outside the I-JSON domain (see spec §4.4)");
        }
        return new((JsonObject)resolved.DeepClone(), outcome == "approve");
    }

    /// <summary>
    /// Runs <paramref name="run"/> under one linked token that expires after <paramref name="limit"/>: a timeout cancels
    /// the call and reports <c>TimedOut</c>, caller cancellation propagates promptly, and late faults are observed.
    /// </summary>
    private static async Task<(bool TimedOut, T? Value)> RaceAsync<T>(
        TimeSpan limit, Func<CancellationToken, Task<T>> run, CancellationToken ct)
    {
        if (limit == Timeout.InfiniteTimeSpan) return (false, await run(ct));
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
        linked.CancelAfter(limit);
        var task = run(linked.Token);
        try
        {
            return (false, await task.WaitAsync(linked.Token));
        }
        catch (OperationCanceledException) when (linked.IsCancellationRequested)
        {
            _ = task.ContinueWith(
                static t => _ = t.Exception, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            if (ct.IsCancellationRequested) throw;
            return (true, default);
        }
    }
}
