// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks;

/// <summary>Configures a <see cref="HookEmitter"/>. Not thread-safe; the built emitter is immutable.</summary>
public sealed partial class HookEmitterBuilder
{
    internal sealed record Binding(
        IHookInterceptor Interceptor, string? Name, IReadOnlySet<Draft.InterceptionPoint>? Points, TimeSpan? Timeout, Draft.OnError? OnError);

    internal readonly List<Binding> Bindings = [];
    internal Draft.Mode Mode = Draft.Mode.Enforce;
    internal Draft.CompositionProfile Profile = Draft.CompositionProfile.SequentialFirstDeny;
    internal Draft.OnApproval OnApproval = Draft.OnApproval.Stop;
    internal Draft.ConflictResolution OnTransformConflict = Draft.ConflictResolution.Deny;
    internal Draft.ConflictResolution OnDisagreement = Draft.ConflictResolution.Deny;
    internal IdentityProvider? Identity = IdentityProvider.JcsSha256;
    internal IApprovalResolver? Resolver;
    internal Func<JsonObject, JsonObject>? Redactor;
    internal TimeSpan InterceptorTimeout = TimeSpan.FromMilliseconds(5000);
    internal TimeSpan? ResolverTimeout;
    internal Draft.OnError DefaultOnError = Draft.OnError.Deny;
    internal Draft.ToolSeamHostError ToolSeamPosture = Draft.ToolSeamHostError.Continue;
    internal Action<ControlFailureNotice>? Notifier;
    internal Action<Draft.InterceptionRecord>? Sink;
    internal JsonObject? Declaration;

    /// <summary>Binds an interceptor at <paramref name="points"/>, or at every point when none are given.</summary>
    public HookEmitterBuilder Use(IHookInterceptor interceptor, BindingOptions? options = null, params Draft.InterceptionPoint[] points)
    {
        ArgumentNullException.ThrowIfNull(interceptor);
        if (options?.Name is { } name && !Verdicts.IsLabel(name))
            throw new ArgumentException("Binding names are 1 to 128 UTF-8 bytes.", nameof(options));
        if (options?.Timeout is { } timeout) CheckTimeout(timeout, nameof(options));
        Bindings.Add(new(interceptor, options?.Name, points.Length == 0 ? null : points.ToHashSet(), options?.Timeout, options?.OnError));
        return this;
    }

    /// <summary>Binds a delegate interceptor at <paramref name="points"/>, or at every point when none are given.</summary>
    public HookEmitterBuilder Use(
        Func<HookCall, CancellationToken, Task<HookOutcome>> interceptor, BindingOptions? options = null,
        params Draft.InterceptionPoint[] points)
    {
        ArgumentNullException.ThrowIfNull(interceptor);
        return Use(new DelegateInterceptor(interceptor), options, points);
    }

    public HookEmitterBuilder OnAgentStartup(Func<Draft.AgentStartupRequest, CancellationToken, Task<Draft.AgentStartupHookResponse>> handler, BindingOptions? options = null) =>
        Typed(Draft.InterceptionPoint.AgentStartup, handler, options);

    public HookEmitterBuilder OnInput(Func<Draft.InputRequest, CancellationToken, Task<Draft.InputHookResponse>> handler, BindingOptions? options = null) =>
        Typed(Draft.InterceptionPoint.Input, handler, options);

    public HookEmitterBuilder OnPreModelCall(Func<Draft.PreModelCallRequest, CancellationToken, Task<Draft.PreModelHookResponse>> handler, BindingOptions? options = null) =>
        Typed(Draft.InterceptionPoint.PreModelCall, handler, options);

    public HookEmitterBuilder OnPostModelCall(Func<Draft.PostModelCallRequest, CancellationToken, Task<Draft.PostModelHookResponse>> handler, BindingOptions? options = null) =>
        Typed(Draft.InterceptionPoint.PostModelCall, handler, options);

    public HookEmitterBuilder OnPreToolCall(Func<Draft.PreToolCallRequest, CancellationToken, Task<Draft.PreToolHookResponse>> handler, BindingOptions? options = null) =>
        Typed(Draft.InterceptionPoint.PreToolCall, handler, options);

    public HookEmitterBuilder OnPostToolCall(Func<Draft.PostToolCallRequest, CancellationToken, Task<Draft.PostToolHookResponse>> handler, BindingOptions? options = null) =>
        Typed(Draft.InterceptionPoint.PostToolCall, handler, options);

    public HookEmitterBuilder OnOutput(Func<Draft.OutputRequest, CancellationToken, Task<Draft.OutputHookResponse>> handler, BindingOptions? options = null) =>
        Typed(Draft.InterceptionPoint.Output, handler, options);

    public HookEmitterBuilder OnAgentShutdown(Func<Draft.AgentShutdownRequest, CancellationToken, Task<Draft.AgentShutdownHookResponse>> handler, BindingOptions? options = null) =>
        Typed(Draft.InterceptionPoint.AgentShutdown, handler, options);

    /// <summary>Enforce verdicts, or record them only (§8).</summary>
    public HookEmitterBuilder WithMode(Draft.Mode mode)
    {
        Mode = mode;
        return this;
    }

    /// <summary>Selects the composition profile and its knobs (§7); a profile consults only its own knob.</summary>
    public HookEmitterBuilder WithComposition(
        Draft.CompositionProfile profile,
        Draft.OnApproval onApproval = Draft.OnApproval.Stop,
        Draft.ConflictResolution onTransformConflict = Draft.ConflictResolution.Deny,
        Draft.ConflictResolution onDisagreement = Draft.ConflictResolution.Deny)
    {
        (Profile, OnApproval, OnTransformConflict, OnDisagreement) = (profile, onApproval, onTransformConflict, onDisagreement);
        return this;
    }

    /// <summary>Sets the identity provider (§10.1); <c>null</c> leaves records unbound. Defaults to <c>jcs-sha256</c>.</summary>
    public HookEmitterBuilder WithIdentityProvider(IdentityProvider? provider)
    {
        if (provider is not null && provider != IdentityProvider.JcsSha256 &&
            (!ProviderName().IsMatch(provider.Name) || provider.Name.StartsWith("jcs", StringComparison.Ordinal)))
            throw new ArgumentException("Custom identity provider names match ^[a-z][a-z0-9_-]*$ and do not start with jcs.", nameof(provider));
        Identity = provider;
        return this;
    }

    public HookEmitterBuilder WithApprovalResolver(IApprovalResolver resolver)
    {
        Resolver = resolver ?? throw new ArgumentNullException(nameof(resolver));
        return this;
    }

    public HookEmitterBuilder WithApprovalResolver(Func<Draft.ApprovalRequest, CancellationToken, Task<Draft.ApprovalResolution>> resolver)
    {
        ArgumentNullException.ThrowIfNull(resolver);
        return WithApprovalResolver(new TypedResolver(resolver));
    }

    /// <summary>Redacts the request the resolver sees (§9); the identity is computed over the redacted form.</summary>
    public HookEmitterBuilder WithApprovalRedactor(Func<JsonObject, JsonObject> redactor)
    {
        Redactor = redactor ?? throw new ArgumentNullException(nameof(redactor));
        return this;
    }

    /// <summary>Sets the interceptor limit (default 5 s) and the resolver limit (defaults to the interceptor limit).</summary>
    public HookEmitterBuilder WithTimeouts(TimeSpan interceptor, TimeSpan? approvalResolver = null)
    {
        CheckTimeout(interceptor, nameof(interceptor));
        if (approvalResolver is { } resolver) CheckTimeout(resolver, nameof(approvalResolver));
        (InterceptorTimeout, ResolverTimeout) = (interceptor, approvalResolver);
        return this;
    }

    /// <summary>The failure posture bindings inherit (§6.3.1).</summary>
    public HookEmitterBuilder WithDefaultOnError(Draft.OnError onError)
    {
        DefaultOnError = onError;
        return this;
    }

    /// <summary>The host's posture when a tool seam yields a host error (§7.7.3).</summary>
    public HookEmitterBuilder WithToolSeamPosture(Draft.ToolSeamHostError posture)
    {
        ToolSeamPosture = posture;
        return this;
    }

    /// <summary>Receives each control failure before an <c>on_error: continue</c> substitution; required for it to apply.</summary>
    public HookEmitterBuilder OnControlFailure(Action<ControlFailureNotice> notifier)
    {
        Notifier = notifier ?? throw new ArgumentNullException(nameof(notifier));
        return this;
    }

    /// <summary>Receives every interception record (§10.3); exceptions thrown by the sink are swallowed.</summary>
    public HookEmitterBuilder WithRecordSink(Action<Draft.InterceptionRecord> sink)
    {
        Sink = sink ?? throw new ArgumentNullException(nameof(sink));
        return this;
    }

    public HookEmitter Build() => new(this);

    private HookEmitterBuilder Typed<TRequest, TResponse>(
        Draft.InterceptionPoint point, Func<TRequest, CancellationToken, Task<TResponse>> handler, BindingOptions? options)
        where TResponse : notnull
    {
        ArgumentNullException.ThrowIfNull(handler);
        return Use(async (call, ct) => ContractSerializer.Serialize(await handler(ContractSerializer.Deserialize<TRequest>(call.Request), ct)), options, point);
    }

    private static void CheckTimeout(TimeSpan value, string name)
    {
        if (value <= TimeSpan.Zero && value != Timeout.InfiniteTimeSpan)
            throw new ArgumentOutOfRangeException(name, "Timeouts are positive or infinite.");
    }

    [GeneratedRegex("^[a-z][a-z0-9_-]*$")]
    private static partial Regex ProviderName();

    private sealed class DelegateInterceptor(Func<HookCall, CancellationToken, Task<HookOutcome>> fn) : IHookInterceptor
    {
        public Task<HookOutcome> InterceptAsync(HookCall call, CancellationToken cancellationToken) => fn(call, cancellationToken);
    }

    private sealed class TypedResolver(Func<Draft.ApprovalRequest, CancellationToken, Task<Draft.ApprovalResolution>> handler) : IApprovalResolver
    {
        public async Task<JsonObject> ResolveAsync(JsonObject request, CancellationToken cancellationToken) =>
            ContractSerializer.Serialize(await handler(ContractSerializer.Deserialize<Draft.ApprovalRequest>(request), cancellationToken));
    }
}
