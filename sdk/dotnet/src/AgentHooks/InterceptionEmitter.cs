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
// A host may also build the emitter from a host declaration document
// (§7.7): FromDeclaration and the path, JSON and node forms resolve
// the document in the core, run the host's kind resolvers and yield a
// sealed emitter whose records carry the contract version.
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
    public static IdentityProvider Custom(string name, Func<JsonObject, string> f)
    {
        // §10.1 name rules: enforced, not advisory — the jcs prefix is
        // reserved so a custom function can never claim golden-vector
        // semantics on records.
        if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[a-z][a-z0-9_-]*$")
            || name.StartsWith("jcs", StringComparison.Ordinal))
        {
            throw new ArgumentException(
                "identity provider name must match ^[a-z][a-z0-9_-]*$ and must not begin with 'jcs' (§10.1)",
                nameof(name));
        }
        return new(name, f);
    }

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

    /// <summary>How one registration is bounded (§7, §7.7.5).</summary>
    private enum BoundTimeout
    {
        /// <summary>The emitter-wide timeout.</summary>
        Inherit,

        /// <summary><c>timeout_ms: null</c> in a declaration.</summary>
        Unbounded,

        /// <summary>A per-binding bound from a declaration.</summary>
        Bounded,
    }

    /// <summary>One registered interceptor with its binding facts
    /// (§7.7.5): the payload-free name stamped on <c>verdicts[].name</c>,
    /// the points it runs at (<c>null</c> = every point, the
    /// pre-declaration behaviour) and its timeout.</summary>
    private sealed record Bound(
        IInterceptor Interceptor,
        string? Name,
        IReadOnlySet<InterceptionPoint>? At,
        BoundTimeout TimeoutKind,
        TimeSpan Timeout)
    {
        // An unparseable point never reaches dispatch (§4 validation
        // denies first); count every binding so the record is
        // conservative.
        public bool RunsAt(InterceptionPoint? point) =>
            At is null || point is null || At.Contains(point.Value);
    }

    private readonly List<Bound> _bound = [];
    private readonly List<InterceptionRecord> _records = [];
    private readonly IApprovalResolver? _resolver;
    private readonly EnforcementMode _mode;
    private readonly TimeSpan _timeout;
    private readonly TimeSpan _resolverTimeout;
    private readonly bool _sealed;
    private readonly ResolvedDeclaration? _declaration;
    private CompositionConfig _composition = CompositionConfig.Default;
    private IdentityProvider _identity = IdentityProvider.JcsSha256;
    private Func<AgentContext, AgentContext>? _approvalRedactor;
    private Action<InterceptionRecord>? _recordSink;
    private int? _maxRecords;
    private long _recordsDropped;

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
        _resolverTimeout = _timeout;
    }

    // ---- host declaration (§7.7) --------------------------------------------

    /// <summary>Build an emitter from a declaration: steps 2 to 11 of
    /// §7.7.6 (the core validates the document and resolves it against
    /// the registry's surface and names, then every binding's kind
    /// resolver runs). The result is sealed (§7.7.7) and stamps
    /// <c>declaration</c> on every record (§7.7.8). A refusal is a
    /// <see cref="DeclarationException"/>; no emitter exists then.</summary>
    public static InterceptionEmitter FromDeclaration(HostDeclaration declaration, HostRegistry registry)
    {
        ArgumentNullException.ThrowIfNull(declaration);
        ArgumentNullException.ThrowIfNull(registry);
        return new InterceptionEmitter(declaration.Resolve(registry), registry);
    }

    /// <summary><see cref="HostDeclaration.FromPath"/> then <see cref="FromDeclaration"/>.</summary>
    public static InterceptionEmitter FromDeclarationPath(string path, HostRegistry registry) =>
        FromDeclaration(HostDeclaration.FromPath(path), registry);

    /// <summary><see cref="HostDeclaration.FromJson"/> then <see cref="FromDeclaration"/>.</summary>
    public static InterceptionEmitter FromDeclarationJson(string text, HostRegistry registry) =>
        FromDeclaration(HostDeclaration.FromJson(text), registry);

    /// <summary><see cref="HostDeclaration.FromNode"/> then <see cref="FromDeclaration"/>.</summary>
    public static InterceptionEmitter FromDeclarationNode(JsonNode? node, HostRegistry registry) =>
        FromDeclaration(HostDeclaration.FromNode(node), registry);

    /// <summary>The resolved declaration this emitter runs under, when
    /// it was built from one (§7.7.7). Its canonical JSON is the
    /// equivalence oracle for the construction paths.</summary>
    public ResolvedDeclaration? Declaration => _declaration;

    /// <summary>Step 11 and construction. Every reference is looked up
    /// again in the registry's own maps, so bookkeeping drift between
    /// the names the core checked and what the registry holds fails
    /// closed.</summary>
    private InterceptionEmitter(ResolvedDeclaration resolved, HostRegistry registry)
    {
        static TimeSpan Limit(long? ms) =>
            ms is { } v ? TimeSpan.FromMilliseconds(v) : Timeout.InfiniteTimeSpan;

        _mode = resolved.Mode;
        _composition = resolved.Composition;
        _timeout = Limit(resolved.InterceptorTimeoutMs);
        _resolverTimeout = Limit(resolved.ApprovalResolverTimeoutMs);
        _maxRecords = resolved.MaxBufferedRecords is { } n ? (int)Math.Min(n, int.MaxValue) : null;

        if (resolved.ApprovalResolver is { } resolverName)
        {
            _resolver = registry.ApprovalResolverFor(resolverName) ?? throw new DeclarationException(
                DeclarationErrorClass.ReferenceUnresolved,
                "/configuration/approval/resolver",
                $"approval resolver \"{resolverName}\" vanished from the registry");
        }
        switch (resolved.IdentityProvider)
        {
            case null:
                _identity = IdentityProvider.Null;
                break;
            case Spec.JcsSha256:
                _identity = IdentityProvider.JcsSha256;
                break;
            case var name:
                var f = registry.IdentityProviderFor(name) ?? throw new DeclarationException(
                    DeclarationErrorClass.ReferenceUnresolved,
                    "/configuration/identity_provider",
                    $"identity provider \"{name}\" vanished from the registry");
                try
                {
                    _identity = IdentityProvider.Custom(name, f);
                }
                catch (ArgumentException e)
                {
                    throw new DeclarationException(
                        DeclarationErrorClass.InvalidField, "/configuration/identity_provider", e.Message);
                }
                break;
        }
        if (resolved.ApprovalRedactor is { } redactorName)
        {
            _approvalRedactor = registry.ApprovalRedactorFor(redactorName) ?? throw new DeclarationException(
                DeclarationErrorClass.ReferenceUnresolved,
                "/configuration/approval/redactor",
                $"approval redactor \"{redactorName}\" vanished from the registry");
        }

        for (var i = 0; i < resolved.Bindings.Count; i++)
        {
            var b = resolved.Bindings[i];
            var pointer = $"/bindings/{i}";
            var resolve = registry.KindResolverFor(b.Kind) ?? throw new DeclarationException(
                DeclarationErrorClass.KindUnknown,
                $"{pointer}/kind",
                $"kind \"{b.Kind}\" vanished from the registry");
            var timeout = b.TimeoutMs is { } ms ? TimeSpan.FromMilliseconds(ms) : (TimeSpan?)null;
            var context = new BindingContext(
                b.Id, b.Kind, b.At, timeout, resolved.Host, resolved.Version);
            // §7.7.5: a resolver exception or a non-interceptor return
            // refuses the document; the detail is bounded and the
            // config is never echoed by the loader.
            IInterceptor? interceptor;
            try
            {
                interceptor = resolve(b.Config, context);
            }
            catch (Exception e)
            {
                throw new DeclarationException(
                    DeclarationErrorClass.BindingRejected,
                    pointer,
                    $"binding \"{b.Id}\" (kind \"{b.Kind}\") rejected: {e.Message}");
            }
            if (interceptor is null)
            {
                throw new DeclarationException(
                    DeclarationErrorClass.BindingRejected,
                    pointer,
                    $"binding \"{b.Id}\" (kind \"{b.Kind}\") rejected: resolver returned no interceptor");
            }
            _bound.Add(new Bound(
                interceptor,
                b.Id,
                b.At,
                timeout is null ? BoundTimeout.Unbounded : BoundTimeout.Bounded,
                timeout ?? Timeout.InfiniteTimeSpan));
        }

        _sealed = true;
        _declaration = resolved;
    }

    /// <summary>§7.7.7: a declaration-built emitter refuses
    /// reconfiguration; otherwise the declaration would not be what ran.</summary>
    private void Unsealed(string what)
    {
        if (_sealed)
            throw new InvalidOperationException(
                $"{what}: this emitter was built from a host declaration and is sealed (see spec §7.7.7)");
    }

    /// <summary>Race <paramref name="fn"/> against <paramref name="limit"/>
    /// (§7); <see cref="Timeout.InfiniteTimeSpan"/> runs unbounded.</summary>
    private static async ValueTask<T> WithTimeoutAsync<T>(
        TimeSpan limit, Func<CancellationToken, ValueTask<T>> fn, CancellationToken ct)
    {
        if (limit == Timeout.InfiniteTimeSpan) return await fn(ct);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(limit);
        var task = fn(cts.Token).AsTask();
        var completed = await Task.WhenAny(task, Task.Delay(limit, CancellationToken.None));
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

    /// <summary>Register an interceptor, optionally with a host-chosen
    /// payload-free <paramref name="name"/> recorded on
    /// <c>verdicts[].name</c> (§10.3) and the points it runs
    /// <paramref name="at"/> (<c>null</c> = every point). At point P the
    /// interceptors that run are those bound there, in registration
    /// order; <c>interceptors_registered</c>, <c>verdicts[].index</c>
    /// and <c>decided_by</c> count and index that list (§7.7.8).
    /// Refused on a sealed emitter (§7.7.7).</summary>
    public InterceptionEmitter Register(
        IInterceptor interceptor, string? name = null, IReadOnlySet<InterceptionPoint>? at = null)
    {
        Unsealed("Register");
        _bound.Add(new Bound(
            interceptor, name,
            at is null ? null : new HashSet<InterceptionPoint>(at),
            BoundTimeout.Inherit, default));
        return this;
    }

    /// <summary>Declare the composition profile for subsequent emissions (§7.1).
    /// The default (<c>sequential/first_deny</c>, <c>on_approval: stop</c>) is the
    /// configuration §14 warns about: after an approval lifts a liftable deny,
    /// interceptors registered after the escalating one never run for that
    /// emission (<c>fold_truncated</c> on the record). Register must-run controls
    /// first, or use <c>sequential/run_all</c> / a parallel profile.
    /// See docs/PRODUCTION.md.</summary>
    public InterceptionEmitter SetComposition(CompositionConfig composition)
    {
        Unsealed("SetComposition");
        _composition = composition;
        return this;
    }

    /// <summary>Declare the identity provider (§10.1).</summary>
    public InterceptionEmitter SetIdentityProvider(IdentityProvider provider)
    {
        Unsealed("SetIdentityProvider");
        _identity = provider;
        return this;
    }

    /// <summary>Register the §9/§14 approval redactor: a pure function
    /// producing the context to place in every ApprovalRequest. The §9
    /// identity is computed over the redacted context (binding the
    /// approval to what the approver saw); the record's identities are
    /// unaffected. A redactor that throws fails the consultation closed
    /// as <c>host_error:approval_resolver_failed</c>.</summary>
    public InterceptionEmitter SetApprovalRedactor(Func<AgentContext, AgentContext> redactor)
    {
        Unsealed("SetApprovalRedactor");
        _approvalRedactor = redactor;
        return this;
    }

    /// <summary>Register a per-emission record callback (§10.3), invoked
    /// synchronously after every emission before buffering; a sink
    /// exception is swallowed (audit delivery is the host's liveness
    /// concern, not the control plane's). Allowed on a sealed emitter:
    /// it changes where records go, not what they say.</summary>
    public InterceptionEmitter SetRecordSink(Action<InterceptionRecord> sink)
    {
        _recordSink = sink;
        return this;
    }

    /// <summary>Bound the in-memory record buffer: when full, the OLDEST
    /// record is dropped and <see cref="RecordsDropped"/> increments.
    /// Unbounded by default.</summary>
    public InterceptionEmitter SetMaxRecords(int max)
    {
        Unsealed("SetMaxRecords");
        _maxRecords = max;
        return this;
    }

    /// <summary>Records evicted by the <see cref="SetMaxRecords"/> bound.</summary>
    public long RecordsDropped
    {
        get { lock (_recordsLock) return _recordsDropped; }
    }

    /// <summary>Drain the in-memory record buffer (retention stays
    /// bounded on long-running sessions).</summary>
    public List<InterceptionRecord> TakeRecords()
    {
        lock (_recordsLock)
        {
            var outRecords = new List<InterceptionRecord>(_records);
            _records.Clear();
            return outRecords;
        }
    }

    /// <summary>Run the emission and THROW
    /// <see cref="InterceptionBlockedException"/> if the guarded action must
    /// not proceed (§6). This is the primary entry point; the safe path is
    /// the default. Returns the record plus the <b>effective</b>
    /// (post-composition) target the guarded action MUST consume (§4.3) —
    /// a reference captured before the emission may predate a transform.</summary>
    public async ValueTask<EmitOutcome> EmitAsync(
        AgentContext ctx, CancellationToken ct = default)
    {
        var record = await EmitUncheckedAsync(ctx, ct);
        if (!record.Proceeds) throw new InterceptionBlockedException(record);
        return new EmitOutcome(record, ctx.Json["target"]);
    }

    /// <summary>Run the emission and return the record without throwing.
    /// The caller MUST inspect <see cref="InterceptionRecord.Proceeds"/> and
    /// halt the guarded action itself; prefer <see cref="EmitAsync"/>.</summary>
    public async ValueTask<InterceptionRecord> EmitUncheckedAsync(
        AgentContext ctx, CancellationToken ct = default)
    {
        // §7.7.8: the interceptors bound at this context's point, in
        // dispatch order; the record counts and indexes this list.
        var active = Active(ctx);

        // §10.3: input identity binds to the context BEFORE dispatch, so
        // neither interceptor mutation nor fold-through can retroactively
        // alter what the record claims was evaluated.
        string? inputId = null;
        DispatchOutcome? outcome = null;
        try
        {
            // §4/§6.3: an invalid envelope is denied before any
            // interceptor or identity provider sees it.
            Native.ValidateEnvelope(ctx.Json.ToJsonString(Compact));
            inputId = _identity.Compute(ctx);
        }
        catch (AgentHooksCoreException e)
        {
            // §4/§10.2: envelope invalid or value domain rejected.
            // Fail closed before any interceptor runs.
            outcome = DispatchOutcome.Synthesized(e.Code, e.Detail);
        }
        catch (Exception e)
        {
            // §10.1: a custom provider raised — fail closed, exception
            // *type* only (§14/TM-09).
            outcome = DispatchOutcome.Synthesized(
                HostError.ContextInvalid,
                $"identity provider failed: {e.GetType().Name} (see spec §10.1)");
        }
        outcome ??= await DispatchAsync(ctx, active, ct);

        var options = new JsonObject
        {
            ["input_identity"] = inputId,
            ["identity_provider"] = _identity.Name,
            // Custom providers only; ah_finalize computes the default
            // provider's enforced identity (and leaves null unbound).
            ["enforced_identity"] = _identity.IsCustom ? TryCustomIdentity(ctx) : null,
            ["decided_by"] = outcome.DecidedBy,
            ["composition"] = _composition.ToWire(),
            ["verdicts"] = new JsonArray(
                outcome.Verdicts.Select(s => (JsonNode)s.ToWire()).ToArray()),
            ["fold_truncated"] = outcome.FoldTruncated,
            ["resolved_by"] = outcome.ResolvedBy,
            ["interceptors_registered"] = active.Count,
        };
        StampDeclaration(options);
        var recordJson = Native.Finalize(
            ctx.Json.ToJsonString(Compact),
            outcome.Combined.ToWire().ToJsonString(Compact),
            _mode == EnforcementMode.Enforce ? "enforce" : "evaluate_only",
            options.ToJsonString(Compact));
        var record = RecordFromCore((JsonObject)JsonNode.Parse(recordJson)!);
        return Deliver(record);
    }

    /// <summary>§10.3/§11 host projection failure: synthesize and deliver
    /// the fail-closed record for an emission whose <see cref="AgentContext"/>
    /// the host could not construct at all — its own projection to the
    /// wire failed before anything existed to emit (e.g. a tool-call
    /// argument property getter threw during to-wire conversion at the
    /// chat seam). Without this the host can only fail the action closed
    /// <b>recordless</b>; with it the trail stays complete under host-side
    /// faults.
    ///
    /// <para>The record is the §10.3 rejection shape: the payload-free
    /// projection of a <c>deny host_error:context_invalid</c> carrying
    /// <paramref name="detail"/> (payload-free: an exception <b>type
    /// name</b> or a path, never the content that failed to project —
    /// §14 data minimization) as its message; <c>null</c> identities
    /// under the declared provider; <c>decided_by: null</c>; no
    /// per-interceptor summaries (no interceptor ran). The optional
    /// parameters carry the envelope facts the host still knows;
    /// <paramref name="sequence"/> SHOULD be the number the failed
    /// emission would have carried (consume the next one from the
    /// context source so records stay totally ordered); absent members
    /// record the §10.3 unknown values (<c>""</c>/<c>-1</c>). The record
    /// takes the next slot in the record stream (sink, then buffer) like
    /// any emission. In <c>enforce</c> mode the host MUST still fail the
    /// action closed; in <c>evaluate_only</c> the record documents the
    /// host fault without implying enforcement (§8).</para></summary>
    public InterceptionRecord RecordHostFailure(
        InterceptionPoint point,
        string? detail = null,
        string? sessionId = null,
        long? sequence = null,
        string? timestamp = null)
    {
        // Deliberately partial basis: only the envelope facts the host
        // still knows. It never passes §4 validation (`spec` is absent),
        // so the core's finalize always yields the §10.3 rejection shape
        // — null identities under the declared provider — and keeps the
        // synthesized `context_invalid` deny (with the host's detail)
        // instead of substituting its own.
        var basis = new JsonObject { ["interception_point"] = point.ToWireName() };
        if (sessionId is not null) basis["session"] = new JsonObject { ["id"] = sessionId };
        if (sequence is { } seq) basis["sequence"] = seq;
        if (timestamp is not null) basis["timestamp"] = timestamp;
        var options = new JsonObject
        {
            ["input_identity"] = null,
            ["identity_provider"] = _identity.Name,
            ["enforced_identity"] = null,
            ["decided_by"] = null,
            ["composition"] = _composition.ToWire(),
            ["verdicts"] = new JsonArray(),
            ["fold_truncated"] = null,
            ["resolved_by"] = null,
            ["interceptors_registered"] = _bound.Count(b => b.RunsAt(point)),
        };
        StampDeclaration(options);
        var recordJson = Native.Finalize(
            basis.ToJsonString(Compact),
            Verdict.FromHostError(HostError.ContextInvalid, detail).ToWire().ToJsonString(Compact),
            _mode == EnforcementMode.Enforce ? "enforce" : "evaluate_only",
            options.ToJsonString(Compact));
        return Deliver(RecordFromCore((JsonObject)JsonNode.Parse(recordJson)!));
    }

    /// <summary>§7.7.8: the contract version, present iff this emitter
    /// was built from a declaration. Never defaulted.</summary>
    private void StampDeclaration(JsonObject options)
    {
        if (_declaration is { } d) options["declaration"] = d.Version;
    }

    /// <summary>Deliver a record to the sink and the bounded buffer (§10.3).</summary>
    private InterceptionRecord Deliver(InterceptionRecord record)
    {
        if (_recordSink is { } sink)
        {
            // Audit delivery must not take down the control plane (§10.3).
            try { sink(record); }
            catch { /* swallowed by design */ }
        }
        lock (_recordsLock)
        {
            if (_maxRecords is { } max)
            {
                while (_records.Count >= Math.Max(max, 1))
                {
                    _records.RemoveAt(0);
                    _recordsDropped++;
                }
            }
            _records.Add(record);
        }
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

    private static InterceptionPoint? PointOf(AgentContext ctx)
    {
        if (ctx.Json["interception_point"] is not JsonValue v || !v.TryGetValue(out string? s))
            return null;
        try
        {
            return InterceptionPointExtensions.FromWireName(s);
        }
        catch (ArgumentOutOfRangeException)
        {
            return null;
        }
    }

    /// <summary>The interceptors bound at the context's point, in
    /// dispatch order (§7.7.8).</summary>
    private List<Bound> Active(AgentContext ctx)
    {
        var point = PointOf(ctx);
        return _bound.Where(b => b.RunsAt(point)).ToList();
    }

    private TimeSpan Limit(Bound b) => b.TimeoutKind switch
    {
        BoundTimeout.Inherit => _timeout,
        BoundTimeout.Unbounded => Timeout.InfiniteTimeSpan,
        _ => b.Timeout,
    };

    /// <summary>Payload-free per-interceptor summaries for the record
    /// (§10.3), with the bound names attached positionally.</summary>
    private static List<VerdictSummary> Summaries(
        IReadOnlyList<Verdict> verdicts, IReadOnlyList<Bound> active) =>
        verdicts.Select((v, i) => new VerdictSummary(
            i, v.Decision, v.Reason, i < active.Count ? active[i].Name : null)).ToList();

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
    private ValueTask<DispatchOutcome> DispatchAsync(
        AgentContext ctx, IReadOnlyList<Bound> active, CancellationToken ct)
    {
        if (active.Count == 0)
        {
            // §7: zero interceptors fails closed, profile-independent.
            // Register an explicit allow-all interceptor for a
            // deliberate passthrough. With per-point bindings (§7.7.5)
            // this is per point: a surface point with no binding denies.
            return ValueTask.FromResult(DispatchOutcome.Synthesized(HostError.NoInterceptor));
        }
        return _composition.Profile switch
        {
            CompositionProfile.SequentialFirstDeny => DispatchFirstDenyAsync(ctx, active, ct),
            CompositionProfile.SequentialRunAll => DispatchRunAllAsync(ctx, active, ct),
            _ => DispatchParallelAsync(ctx, active, ct),
        };
    }

    /// <summary>Run one interceptor over a deep copy of
    /// <paramref name="basis"/> (§7: in-place mutation of the copy cannot
    /// alter enforcement) and cross the §5 gate. Failures come back as
    /// host-synthesized denies (§6.3, fail closed).</summary>
    private async ValueTask<Verdict> RunOneAsync(
        Bound bound, AgentContext basis, CancellationToken ct)
    {
        try
        {
            var copy = new AgentContext((JsonObject)basis.Json.DeepClone());
            var v = await WithTimeoutAsync(Limit(bound), t => bound.Interceptor.InterceptAsync(copy, t), ct);
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
        AgentContext ctx, IReadOnlyList<Bound> active, CancellationToken ct)
    {
        var n = active.Count;
        var onApproval = _composition.OnApproval ?? OnApproval.Stop;
        var perInterceptor = new List<Verdict>();
        var pool = new List<Verdict>();
        (int Idx, Verdict V)? lastTransform = null;
        string? resolvedBy = null;
        bool Truncated(int i) => i + 1 < n;

        for (var i = 0; i < n; i++)
        {
            var v = await RunOneAsync(active[i], ctx, ct);
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
                    WithUnions(v, pool), i, Summaries(perInterceptor, active),
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
                                WithUnions(v, pool), i, Summaries(perInterceptor, active),
                                Truncated(i), resolvedBy);
                        }
                        if (!c.Permitted)
                        {
                            // Reject / unresolved / echo violation: a deny
                            // stands (§9); the consultation is still
                            // recorded (§10.3 resolved_by).
                            return new DispatchOutcome(
                                WithUnions(c.Verdict, pool),
                                IsHostSynthesized(c.Verdict) ? null : i,
                                Summaries(perInterceptor, active), Truncated(i), "rejection");
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
                                sub, null, Summaries(perInterceptor, active),
                                Truncated(i), resolvedBy);
                        }
                        pool.Add(sub);
                        if (onApproval == OnApproval.Stop)
                        {
                            // §7.4 stop: the resolution is the combined
                            // verdict; the emission ends. fold_truncated makes
                            // the skip legible.
                            return new DispatchOutcome(
                                WithUnions(sub, pool), i, Summaries(perInterceptor, active),
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
                                folded, null, Summaries(perInterceptor, active),
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
            WithUnions(combined, pool), decidedBy, Summaries(perInterceptor, active),
            false, resolvedBy);
    }

    /// <summary><c>sequential/run_all</c> (§7.4): everything runs,
    /// transforms fold through for visibility, severity-max aggregate; the
    /// seam is consulted at most once, only when the winner is liftable
    /// (a liftable winner implies every deny in the emission is liftable —
    /// severity puts a plain deny above it).</summary>
    private async ValueTask<DispatchOutcome> DispatchRunAllAsync(
        AgentContext ctx, IReadOnlyList<Bound> active, CancellationToken ct)
    {
        var all = new List<Verdict>();
        foreach (var bound in active)
        {
            // §6.3 per-interceptor: a malformed verdict becomes that
            // interceptor's synthesized deny; the rest still run.
            var v = await RunOneAsync(bound, ctx, ct);
            if (v.Decision == Decision.Transform)
            {
                var folded = FoldTransform(ctx, v);
                if (!folded.Decision.Permits())
                {
                    // §7.4: a transform that fails to apply short-circuits
                    // in both sequential profiles.
                    all.Add(folded);
                    return new DispatchOutcome(folded, null, Summaries(all, active));
                }
                all.Add(folded);
            }
            else
            {
                all.Add(v);
            }
        }
        return await AggregateAndConsultAsync(ctx, all, active, ct);
    }

    /// <summary>Parallel profiles (§7.5): isolated snapshots, no fold;
    /// serial dispatch (isolation semantics, not scheduling). Unanimous
    /// disagreement and transform-conflict synthesis happen inside
    /// ah_compose_aggregate per the profile knobs.</summary>
    private async ValueTask<DispatchOutcome> DispatchParallelAsync(
        AgentContext ctx, IReadOnlyList<Bound> active, CancellationToken ct)
    {
        var snapshot = new AgentContext((JsonObject)ctx.Json.DeepClone());
        var all = new List<Verdict>();
        foreach (var bound in active)
            all.Add(await RunOneAsync(bound, snapshot, ct));
        return await AggregateAndConsultAsync(ctx, all, active, ct);
    }

    /// <summary>Severity-max aggregation (ah_compose_aggregate) + winner
    /// handling, shared by <c>sequential/run_all</c> and the parallel
    /// profiles. The core returns the combined verdict with §7.3 unions
    /// applied plus the <c>consult</c>/<c>apply_transform</c> directives;
    /// the environment checks (resolver present, mode, shutdown) and the
    /// callbacks stay native.</summary>
    private async ValueTask<DispatchOutcome> AggregateAndConsultAsync(
        AgentContext ctx, List<Verdict> all, IReadOnlyList<Bound> active, CancellationToken ct)
    {
        var agg = Canonical.ComposeAggregate(
            _composition,
            new JsonArray(all.Select(v => (JsonNode)v.ToWire()).ToArray()));
        var combined = Verdict.FromWire((JsonObject)agg["combined"]!);
        var decidedBy = agg["decided_by"] is null ? null : (int?)agg["decided_by"]!;
        var verdicts = ((JsonArray)agg["verdicts"]!)
            .Select(s => VerdictSummary.FromWire((JsonObject)s!))
            .Select(v => v with { Name = v.Index < active.Count ? active[v.Index].Name : null })
            .ToList();
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
                // §10.3: consultation without a permit substitution.
                resolvedBy = "rejection";
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

        // §9/§14: the host's approval redactor minimizes the context
        // egressing through the seam; a throwing redactor fails closed.
        var presented = ctx;
        if (_approvalRedactor is { } redactor)
        {
            try
            {
                presented = redactor(ctx);
            }
            catch (Exception e)
            {
                return new Consultation(
                    Verdict.FromHostError(HostError.ApprovalResolverFailed, e.GetType().Name),
                    false);
            }
        }

        // §9: identity of the context as presented to the resolver —
        // consultation time, after any transforms that folded earlier
        // and after any redaction.
        string? identity;
        try
        {
            identity = _identity.Compute(presented);
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
            // §9: the resolver bound (`approval_resolver_ms`, §7.7.3).
            res = await WithTimeoutAsync(
                _resolverTimeout,
                t => _resolver.ResolveAsync(new ApprovalRequest(identity, ip, verdict, presented), t),
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

    /// <summary>Custom-provider identity, or null when the provider
    /// fails (honest absence, §10.1 — the emission was already decided
    /// by the pre-dispatch path).</summary>
    private string? TryCustomIdentity(AgentContext ctx)
    {
        try { return _identity.Compute(ctx); }
        catch { return null; }
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
            (string?)r["resolved_by"],
            (int?)r["interceptors_registered"] ?? 0,
            (string?)r["timestamp"],
            r["trace"] is JsonObject t ? TraceContext.FromWire(t) : null,
            (string?)r["declaration"]);
    }
}
