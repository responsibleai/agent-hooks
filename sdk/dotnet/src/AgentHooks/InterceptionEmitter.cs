// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Host-side emitter: dispatch context -> interceptors -> composition ->
// combined verdict -> record (§6-§10).
//
// Interceptor dispatch (§7) and approval-seam resolution (§9) stay in
// C# because they call back into user code. Verdict validation (§5),
// severity-max aggregation (§7.3/§7.5, ah_compose_aggregate), transform
// fold-through (§7.4), identity computation (§10), and record assembly
// (§10.3, ah_finalize) delegate to the Rust core so behaviour is
// byte-identical across SDKs. Port of
// sdk/rust/core/src/emitter.rs.
//
// Composition is host configuration (§7.1): the profile is set on the
// emitter (default `sequential/first_deny, on_approval: stop`) and
// recorded on every emission. "Parallel" profiles are implemented with
// serial dispatch over isolated snapshots — §7.2: parallel names
// isolation semantics, not scheduling.
//
// Fail-closed defaults: an enforce-mode emission with zero registered
// interceptors yields deny host_error:no_interceptor (§7), and EmitAsync
// THROWS InterceptionBlockedException on any block — the ignorable-result
// variant is the explicitly named EmitUncheckedAsync.

using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentHooks;

/// <summary>The host-declared identity provider (§10.1).</summary>
public sealed class IdentityProvider
{
    private readonly Func<JsonObject, string>? _custom;

    private IdentityProvider(string? name, Func<JsonObject, string>? custom)
    {
        Name = name;
        _custom = custom;
    }

    /// <summary>Provider name recorded on every emission; <c>null</c> iff
    /// identity-unbound (§10.1).</summary>
    public string? Name { get; }

    /// <summary>The shipped default (§10.2): JCS + SHA-256 over the closed
    /// required+conditional projection; fail-closed I-JSON domain.</summary>
    public static readonly IdentityProvider JcsSha256 = new(Spec.JcsSha256, null);

    /// <summary>Identity-unbound: approvals bind by correlation only; records
    /// carry <c>null</c> identities and self-describe as unbound.</summary>
    public static readonly IdentityProvider Null = new(null, null);

    /// <summary>A host-supplied pure function. The echo and record rules
    /// (§10.1) still apply; the golden vectors do not.</summary>
    public static IdentityProvider Custom(string name, Func<JsonObject, string> f) =>
        new(name, f);

    internal bool IsCustom => _custom is not null;

    /// <summary><c>null</c> iff the provider is <see cref="Null"/>; throws
    /// <see cref="AgentHooksCoreException"/> iff the default provider
    /// rejected the value domain (§10.2).</summary>
    internal string? Compute(AgentContext ctx)
    {
        if (_custom is not null) return _custom(ctx.Json);
        if (Name is null) return null;
        return Canonical.ContextIdentity(ctx);
    }
}

/// <summary>Host-side helper that implements §6–§10 once so adapters don't have to.</summary>
public sealed class InterceptionEmitter
{
    private static readonly JsonSerializerOptions Compact = new() { WriteIndented = false };

    /// <summary>§7 RECOMMENDED interceptor/resolver timeout.</summary>
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromMilliseconds(5000);

    private readonly List<IInterceptor> _interceptors = [];
    private readonly List<InterceptionRecord> _records = [];
    private readonly IApprovalResolver? _resolver;
    private readonly EnforcementMode _mode;
    private readonly TimeSpan _timeout;
    private CompositionConfig _composition = CompositionConfig.Default;
    private IdentityProvider _identity = IdentityProvider.JcsSha256;

    /// <param name="timeout">Bounds each interceptor
    /// <c>InterceptAsync</c> and resolver <c>ResolveAsync</c> call (§7,
    /// RECOMMENDED default 5000 ms); breach fails closed with
    /// <c>host_error:interceptor_timeout</c> / <c>approval_resolver_failed</c>.
    /// The cancellation token is signalled on breach, but a callee that
    /// ignores it keeps running detached. <c>null</c> = 5000 ms;
    /// <see cref="Timeout.InfiniteTimeSpan"/> disables enforcement.</param>
    public InterceptionEmitter(
        EnforcementMode mode = EnforcementMode.Enforce,
        IApprovalResolver? resolver = null,
        TimeSpan? timeout = null)
    {
        _mode = mode;
        _resolver = resolver;
        _timeout = timeout ?? DefaultTimeout;
    }

    /// <summary>Race <paramref name="fn"/> against the §7 timeout.</summary>
    private async ValueTask<T> WithTimeoutAsync<T>(
        Func<CancellationToken, ValueTask<T>> fn, CancellationToken ct)
    {
        if (_timeout == Timeout.InfiniteTimeSpan) return await fn(ct);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(_timeout);
        var task = fn(cts.Token).AsTask();
        var completed = await Task.WhenAny(task, Task.Delay(_timeout, CancellationToken.None));
        if (completed != task) throw new TimeoutException();
        return await task;
    }

    public EnforcementMode Mode => _mode;

    /// <summary>The composition profile and knobs in effect (§7.1).</summary>
    public CompositionConfig Composition => _composition;

    /// <summary>All interception records emitted so far in this session, in order.</summary>
    private readonly object _recordsLock = new();

    /// <summary>Snapshot of every record emitted so far, in sequence
    /// order. Emissions for different tool calls may run concurrently
    /// (§12.2), so the backing list is lock-guarded.</summary>
    public IReadOnlyList<InterceptionRecord> Records
    {
        get { lock (_recordsLock) return _records.ToList(); }
    }

    public InterceptionEmitter Register(IInterceptor interceptor)
    {
        _interceptors.Add(interceptor);
        return this;
    }

    /// <summary>Declare the composition profile for subsequent emissions (§7.1).</summary>
    public InterceptionEmitter SetComposition(CompositionConfig composition)
    {
        _composition = composition;
        return this;
    }

    /// <summary>Declare the identity provider (§10.1).</summary>
    public InterceptionEmitter SetIdentityProvider(IdentityProvider provider)
    {
        _identity = provider;
        return this;
    }

    /// <summary>Run the emission and THROW
    /// <see cref="InterceptionBlockedException"/> if the guarded action must
    /// not proceed (§6). This is the primary entry point; the safe path is
    /// the default.</summary>
    public async ValueTask<InterceptionRecord> EmitAsync(
        AgentContext ctx, CancellationToken ct = default)
    {
        var record = await EmitUncheckedAsync(ctx, ct);
        if (!record.Proceeds) throw new InterceptionBlockedException(record);
        return record;
    }

    /// <summary>Run the emission and return the record without throwing.
    /// The caller MUST inspect <see cref="InterceptionRecord.Proceeds"/> and
    /// halt the guarded action itself; prefer <see cref="EmitAsync"/>.</summary>
    public async ValueTask<InterceptionRecord> EmitUncheckedAsync(
        AgentContext ctx, CancellationToken ct = default)
    {
        // §10.3: input identity binds to the context BEFORE dispatch, so
        // neither interceptor mutation nor fold-through can retroactively
        // alter what the record claims was evaluated.
        string? inputId = null;
        DispatchOutcome? outcome = null;
        try
        {
            inputId = _identity.Compute(ctx);
        }
        catch (AgentHooksCoreException e)
        {
            // §10.2: the default provider rejected the value domain.
            // Fail closed before any interceptor runs.
            outcome = DispatchOutcome.Synthesized(e.Code, e.Detail);
        }
        outcome ??= await DispatchAsync(ctx, ct);

        var options = new JsonObject
        {
            ["input_identity"] = inputId,
            ["identity_provider"] = _identity.Name,
            // Custom providers only; ah_finalize computes the default
            // provider's enforced identity (and leaves null unbound).
            ["enforced_identity"] = _identity.IsCustom ? _identity.Compute(ctx) : null,
            ["decided_by"] = outcome.DecidedBy,
            ["composition"] = _composition.ToWire(),
            ["verdicts"] = new JsonArray(
                outcome.Verdicts.Select(s => (JsonNode)s.ToWire()).ToArray()),
            ["fold_truncated"] = outcome.FoldTruncated,
            ["resolved_by"] = outcome.ResolvedBy,
        };
        var recordJson = Native.Finalize(
            ctx.Json.ToJsonString(Compact),
            outcome.Combined.ToWire().ToJsonString(Compact),
            _mode == EnforcementMode.Enforce ? "enforce" : "evaluate_only",
            options.ToJsonString(Compact));
        var record = RecordFromCore((JsonObject)JsonNode.Parse(recordJson)!);
        lock (_recordsLock) _records.Add(record);
        return record;
    }

    // -------------------------------------------------------------------------

    /// <summary>Internal result of one profile dispatch.</summary>
    private sealed record DispatchOutcome(
        Verdict Combined,
        int? DecidedBy,
        IReadOnlyList<VerdictSummary> Verdicts,
        bool? FoldTruncated = null,
        string? ResolvedBy = null)
    {
        public static DispatchOutcome Synthesized(string hookError, string? detail = null) =>
            new(Verdict.FromHostError(hookError, detail), null, []);
    }

    /// <summary>What a seam consultation produced (§7.6, §9). <c>null</c>
    /// stands for "not consulted": no resolver, <c>evaluate_only</c>, or
    /// <c>agent_shutdown</c> — the liftable deny stands as-is.</summary>
    private sealed record Consultation(Verdict Verdict, bool Permitted);

    /// <summary>Whether a verdict was synthesized by the host (§11) rather
    /// than returned by an interceptor or resolver.</summary>
    private static bool IsHostSynthesized(Verdict v) =>
        v.Reason?.StartsWith("host_error:", StringComparison.Ordinal) == true;

    /// <summary>Payload-free per-interceptor summaries for the record (§10.3).</summary>
    private static List<VerdictSummary> Summaries(IReadOnlyList<Verdict> verdicts) =>
        verdicts.Select((v, i) => new VerdictSummary(i, v.Decision, v.Reason)).ToList();

    /// <summary>Apply the §7.3 metadata unions to a combined verdict:
    /// warnings from every verdict in the pool (first-seen order); labels
    /// only onto a permit combination (§5.4 drops labels when the emission
    /// does not proceed).</summary>
    private static Verdict WithUnions(Verdict combined, IReadOnlyList<Verdict> pool)
    {
        var warnings = new List<Warning>();
        foreach (var v in pool)
            foreach (var w in v.Warnings ?? [])
                if (!warnings.Contains(w)) warnings.Add(w);
        if (warnings.Count > 0)
            combined = combined with { Warnings = warnings };
        if (combined.Decision.Permits())
        {
            var labels = new List<string>();
            foreach (var v in pool.Where(p => p.Decision.Permits()))
                foreach (var l in v.ResultLabels ?? [])
                    if (!labels.Contains(l)) labels.Add(l);
            if (labels.Count > 0)
                combined = combined with { ResultLabels = labels };
        }
        return combined;
    }

    /// <summary>Profile dispatch (§7.4–§7.5). Returns the combined verdict
    /// and its record metadata.</summary>
    private ValueTask<DispatchOutcome> DispatchAsync(AgentContext ctx, CancellationToken ct)
    {
        if (_interceptors.Count == 0)
        {
            // §7: zero interceptors fails closed, profile-independent.
            // Register an explicit allow-all interceptor for a
            // deliberate passthrough.
            return ValueTask.FromResult(DispatchOutcome.Synthesized(HostError.NoInterceptor));
        }
        return _composition.Profile switch
        {
            CompositionProfile.SequentialFirstDeny => DispatchFirstDenyAsync(ctx, ct),
            CompositionProfile.SequentialRunAll => DispatchRunAllAsync(ctx, ct),
            _ => DispatchParallelAsync(ctx, ct),
        };
    }

    /// <summary>Run one interceptor over a deep copy of
    /// <paramref name="basis"/> (§7: in-place mutation of the copy cannot
    /// alter enforcement) and cross the §5 gate. Failures come back as
    /// host-synthesized denies (§6.3, fail closed).</summary>
    private async ValueTask<Verdict> RunOneAsync(
        IInterceptor interceptor, AgentContext basis, CancellationToken ct)
    {
        try
        {
            var copy = new AgentContext((JsonObject)basis.Json.DeepClone());
            var v = await WithTimeoutAsync(t => interceptor.InterceptAsync(copy, t), ct);
            Native.ValidateVerdict(v.ToWire().ToJsonString(Compact)); // §5
            return v;
        }
        catch (TimeoutException)
        {
            return Verdict.FromHostError(HostError.InterceptorTimeout);
        }
        catch (AgentHooksCoreException e)
        {
            return Verdict.FromHostError(e.Code, e.Detail);
        }
        catch (Exception e) // fail closed per §6.3
        {
            return Verdict.FromHostError(HostError.InterceptorFailed, e.GetType().Name);
        }
    }

    /// <summary><c>sequential/first_deny</c> (§7.4): fold-through, first
    /// deny short-circuits; a liftable deny consults the seam, then
    /// <c>stop</c> or <c>resume</c> per the knob.
    ///
    /// <c>perInterceptor</c> stays index-aligned with registration order
    /// (one entry per invoked interceptor, §10.3 summaries); <c>pool</c>
    /// additionally holds substituted resolutions for the §7.3 unions.</summary>
    private async ValueTask<DispatchOutcome> DispatchFirstDenyAsync(
        AgentContext ctx, CancellationToken ct)
    {
        var n = _interceptors.Count;
        var onApproval = _composition.OnApproval ?? OnApproval.Stop;
        var perInterceptor = new List<Verdict>();
        var pool = new List<Verdict>();
        (int Idx, Verdict V)? lastTransform = null;
        string? resolvedBy = null;
        bool Truncated(int i) => i + 1 < n;

        for (var i = 0; i < n; i++)
        {
            var v = await RunOneAsync(_interceptors[i], ctx, ct);
            perInterceptor.Add(v);
            pool.Add(v);
            if (IsHostSynthesized(v))
            {
                // §6.3: malformed verdict fails closed and — in this
                // profile — short-circuits like any deny. The failure
                // deny is attributed to the failing interceptor
                // (§10.3 decided_by), matching the aggregation
                // profiles.
                return new DispatchOutcome(
                    WithUnions(v, pool), i, Summaries(perInterceptor),
                    Truncated(i), resolvedBy);
            }

            switch (v.Decision)
            {
                case Decision.Deny:
                {
                    var c = await ConsultAsync(ctx, v, ct);
                    if (c is null)
                    {
                        return new DispatchOutcome(
                            WithUnions(v, pool), i, Summaries(perInterceptor),
                            Truncated(i), resolvedBy);
                    }
                    if (!c.Permitted)
                    {
                        // Reject / unresolved / echo violation: a deny
                        // stands (§9).
                        return new DispatchOutcome(
                            WithUnions(c.Verdict, pool),
                            IsHostSynthesized(c.Verdict) ? null : i,
                            Summaries(perInterceptor), Truncated(i), resolvedBy);
                    }
                    resolvedBy = "approval";
                    // §7.6: the permit resolution substitutes at this
                    // position; its transform folds like an interceptor's
                    // (§7.4).
                    var sub = c.Verdict.Decision == Decision.Transform
                        ? FoldTransform(ctx, c.Verdict)
                        : c.Verdict;
                    if (!sub.Decision.Permits())
                    {
                        return new DispatchOutcome(
                            sub, null, Summaries(perInterceptor),
                            Truncated(i), resolvedBy);
                    }
                    pool.Add(sub);
                    if (onApproval == OnApproval.Stop)
                    {
                        // §7.4 stop: the resolution is the combined
                        // verdict; the emission ends. fold_truncated makes
                        // the skip legible.
                        return new DispatchOutcome(
                            WithUnions(sub, pool), i, Summaries(perInterceptor),
                            Truncated(i), resolvedBy);
                    }
                    if (sub.Decision == Decision.Transform)
                        lastTransform = (i, sub);
                    break; // resume: fold continues at i+1
                }
                case Decision.Transform:
                {
                    var folded = FoldTransform(ctx, v);
                    if (!folded.Decision.Permits())
                    {
                        // Transform failed closed (host-synthesized §5.2).
                        return new DispatchOutcome(
                            folded, null, Summaries(perInterceptor),
                            Truncated(i), resolvedBy);
                    }
                    lastTransform = (i, folded);
                    break;
                }
            }
        }

        // No standing deny: combined is the last transform, else allow.
        var (combined, decidedBy) = lastTransform is { } lt
            ? (lt.V, (int?)lt.Idx)
            : (Verdict.Allow, null);
        return new DispatchOutcome(
            WithUnions(combined, pool), decidedBy, Summaries(perInterceptor),
            false, resolvedBy);
    }

    /// <summary><c>sequential/run_all</c> (§7.4): everything runs,
    /// transforms fold through for visibility, severity-max aggregate; the
    /// seam is consulted at most once, only when the winner is liftable
    /// (a liftable winner implies every deny in the emission is liftable —
    /// severity puts a plain deny above it).</summary>
    private async ValueTask<DispatchOutcome> DispatchRunAllAsync(
        AgentContext ctx, CancellationToken ct)
    {
        var all = new List<Verdict>();
        foreach (var interceptor in _interceptors)
        {
            // §6.3 per-interceptor: a malformed verdict becomes that
            // interceptor's synthesized deny; the rest still run.
            var v = await RunOneAsync(interceptor, ctx, ct);
            if (v.Decision == Decision.Transform)
            {
                var folded = FoldTransform(ctx, v);
                if (!folded.Decision.Permits())
                {
                    // §7.4: a transform that fails to apply short-circuits
                    // in both sequential profiles.
                    all.Add(folded);
                    return new DispatchOutcome(folded, null, Summaries(all));
                }
                all.Add(folded);
            }
            else
            {
                all.Add(v);
            }
        }
        return await AggregateAndConsultAsync(ctx, all, ct);
    }

    /// <summary>Parallel profiles (§7.5): isolated snapshots, no fold;
    /// serial dispatch (isolation semantics, not scheduling). Unanimous
    /// disagreement and transform-conflict synthesis happen inside
    /// ah_compose_aggregate per the profile knobs.</summary>
    private async ValueTask<DispatchOutcome> DispatchParallelAsync(
        AgentContext ctx, CancellationToken ct)
    {
        var snapshot = new AgentContext((JsonObject)ctx.Json.DeepClone());
        var all = new List<Verdict>();
        foreach (var interceptor in _interceptors)
            all.Add(await RunOneAsync(interceptor, snapshot, ct));
        return await AggregateAndConsultAsync(ctx, all, ct);
    }

    /// <summary>Severity-max aggregation (ah_compose_aggregate) + winner
    /// handling, shared by <c>sequential/run_all</c> and the parallel
    /// profiles. The core returns the combined verdict with §7.3 unions
    /// applied plus the <c>consult</c>/<c>apply_transform</c> directives;
    /// the environment checks (resolver present, mode, shutdown) and the
    /// callbacks stay native.</summary>
    private async ValueTask<DispatchOutcome> AggregateAndConsultAsync(
        AgentContext ctx, List<Verdict> all, CancellationToken ct)
    {
        var agg = Canonical.ComposeAggregate(
            _composition,
            new JsonArray(all.Select(v => (JsonNode)v.ToWire()).ToArray()));
        var combined = Verdict.FromWire((JsonObject)agg["combined"]!);
        var decidedBy = agg["decided_by"] is null ? null : (int?)agg["decided_by"]!;
        var verdicts = ((JsonArray)agg["verdicts"]!)
            .Select(s => VerdictSummary.FromWire((JsonObject)s!)).ToList();
        string? resolvedBy = null;

        if ((bool)agg["apply_transform"]!)
        {
            // Parallel only: apply the single winning transform now
            // (sequential transforms already folded during dispatch).
            var folded = FoldTransform(ctx, combined);
            if (!folded.Decision.Permits())
                return new DispatchOutcome(folded, null, verdicts);
            combined = folded;
        }

        if ((bool)agg["consult"]! && await ConsultAsync(ctx, combined, ct) is { } c)
        {
            if (c.Permitted)
            {
                resolvedBy = "approval";
                var sub = c.Verdict.Decision == Decision.Transform
                    ? FoldTransform(ctx, c.Verdict)
                    : c.Verdict;
                // §7.3 step 2: the substituting resolution carries the
                // emission's unions, including for a §7.5-synthesized
                // trigger (conflict/disagreement).
                combined = sub.Decision.Permits()
                    ? WithUnions(sub, [.. all, sub])
                    : sub;
            }
            else
            {
                // Reject / unresolved / echo violation: a deny stands (§9).
                combined = WithUnions(c.Verdict, all);
                if (IsHostSynthesized(c.Verdict)) decidedBy = null;
            }
        }
        return new DispatchOutcome(combined, decidedBy, verdicts, ResolvedBy: resolvedBy);
    }

    /// <summary>Apply (enforce) or validate (evaluate_only) one transform
    /// (§7.4, §8). Mutates <paramref name="ctx"/>.Json in place on apply.</summary>
    private Verdict FoldTransform(AgentContext ctx, Verdict v)
    {
        if (v.Transform is not { } t)
            return Verdict.FromHostError(HostError.TransformInvalid);
        try
        {
            if (_mode == EnforcementMode.Enforce)
            {
                var newCtx = Canonical.ApplyTransformCtx(ctx, t.Path, t.Value);
                ctx.Json.Clear();
                foreach (var (k, val) in newCtx.ToList()) ctx.Json[k] = val?.DeepClone();
            }
            else
            {
                Canonical.ValidateTransformCtx(ctx, t.Path, t.Value);
            }
        }
        catch (AgentHooksCoreException e)
        {
            return Verdict.FromHostError(e.Code, t.Path);
        }
        return v;
    }

    /// <summary>Consult the approval seam for a liftable deny (§9), when
    /// the profile conditions allow it: <c>enforce</c> mode, not
    /// <c>agent_shutdown</c>, a resolver registered, and the verdict
    /// actually liftable. Enforces the echo rule and the §9
    /// outcome/verdict consistency requirements. <c>null</c> = not
    /// consulted; a no-resolver liftable deny stands, NOT an error.</summary>
    private async ValueTask<Consultation?> ConsultAsync(
        AgentContext ctx, Verdict verdict, CancellationToken ct)
    {
        if (!verdict.IsLiftable || _mode != EnforcementMode.Enforce)
            return null;
        // §6.1a: nothing to approve at agent_shutdown.
        if ((string?)ctx.Json["interception_point"] == "agent_shutdown")
            return null;
        // §9: no resolver → the deny stands. Conformant, not an error.
        if (_resolver is null)
            return null;

        // §9: identity of the context as presented to the resolver —
        // consultation time, after any transforms that folded earlier.
        string? identity;
        try
        {
            identity = _identity.Compute(ctx);
        }
        catch (AgentHooksCoreException e)
        {
            return new Consultation(Verdict.FromHostError(e.Code, e.Detail), false);
        }

        InterceptionPoint ip;
        try
        {
            ip = ctx.InterceptionPoint;
        }
        catch (ArgumentOutOfRangeException)
        {
            ip = InterceptionPoint.AgentStartup;
        }

        static Consultation Fail(string hookError, string? detail = null) =>
            new(Verdict.FromHostError(hookError, detail), false);

        ApprovalResolution res;
        try
        {
            res = await WithTimeoutAsync(
                t => _resolver.ResolveAsync(new ApprovalRequest(identity, ip, verdict, ctx), t),
                ct);
        }
        catch (TimeoutException)
        {
            return Fail(HostError.ApprovalResolverFailed, "timeout");
        }
        catch (Exception e)
        {
            return Fail(HostError.ApprovalResolverFailed, e.GetType().Name);
        }

        // §9 echo rule (byte-for-byte; null echoes as null).
        if (res.ContextIdentity != identity)
            return Fail(HostError.ApprovalIdentityMismatch);
        if (res.Verdict is not { } rv || res.Outcome == ApprovalOutcome.Unresolved)
            return Fail(HostError.ApprovalUnresolved);
        try
        {
            // §9: the resolver's verdict crosses the same §5 gate as an
            // interceptor's.
            Native.ValidateVerdict(rv.ToWire().ToJsonString(Compact));
        }
        catch (AgentHooksCoreException e)
        {
            return Fail(HostError.VerdictInvalid, e.Detail);
        }
        // §9: outcome/decision must agree — approve MUST carry a permit,
        // reject MUST carry a deny.
        var permitted = res.Outcome == ApprovalOutcome.Approve;
        if (permitted && !rv.Decision.Permits())
            return Fail(HostError.VerdictInvalid);
        if (!permitted && rv.Decision != Decision.Deny)
            return Fail(HostError.VerdictInvalid);
        return new Consultation(rv, permitted);
    }

    private static InterceptionRecord RecordFromCore(JsonObject r)
    {
        return new InterceptionRecord(
            InterceptionPointExtensions.FromWireName((string)r["interception_point"]!),
            (string)r["mode"]! == "enforce" ? EnforcementMode.Enforce : EnforcementMode.EvaluateOnly,
            Verdict.FromWire((JsonObject)r["verdict"]!),
            (string?)r["input_identity"],
            (string?)r["enforced_identity"],
            (string?)r["identity_provider"],
            (string?)r["session_id"] ?? string.Empty,
            (long?)r["sequence"] ?? -1,
            r["decided_by"] is null ? null : (int?)r["decided_by"]!,
            CompositionConfig.FromWire((JsonObject)r["composition"]!),
            (r["verdicts"] as JsonArray)?
                .Select(n => VerdictSummary.FromWire((JsonObject)n!)).ToList()
                ?? (IReadOnlyList<VerdictSummary>)[],
            (bool?)r["fold_truncated"],
            (string?)r["resolved_by"]);
    }
}
