// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks;

/// <summary>Configures a <see cref="HookEmitter" />. Not thread-safe; the built emitter is immutable and thread-safe.</summary>
/// <remarks>
/// Defaults follow the draft specification: <see cref="Draft.Mode.Enforce" />,
/// <see cref="Draft.CompositionProfile.SequentialFirstDeny" /> with <see cref="Draft.OnApproval.Stop" />,
/// <see cref="Draft.ConflictResolution.Deny" />, <see cref="IdentityProvider.JcsSha256" />, a 5-second interceptor
/// and resolver timeout, <see cref="Draft.OnError.Deny" />, and <see cref="Draft.ToolSeamHostError.Continue" />.
/// </remarks>
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

    /// <summary>Binds an interceptor at <paramref name="points" />, or at every point when none are specified.</summary>
    /// <param name="interceptor">The interceptor to invoke.</param>
    /// <param name="options">Optional per-binding label, timeout override, and failure posture override.</param>
    /// <param name="points">The interception points this binding applies to, or empty to apply to all points.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="interceptor" /> is <see langword="null" />.</exception>
    /// <exception cref="ArgumentException"><see cref="BindingOptions.Name" /> is empty or exceeds 128 UTF-8 bytes.</exception>
    /// <exception cref="ArgumentOutOfRangeException"><see cref="BindingOptions.Timeout" /> is neither positive nor <see cref="Timeout.InfiniteTimeSpan" />.</exception>
    public HookEmitterBuilder Use(IHookInterceptor interceptor, BindingOptions? options = null, params Draft.InterceptionPoint[] points)
    {
        ArgumentNullException.ThrowIfNull(interceptor);
        if (options?.Name is { } name && !Verdicts.IsLabel(name))
            throw new ArgumentException("Binding names are 1 to 128 UTF-8 bytes.", nameof(options));
        if (options?.Timeout is { } timeout) CheckTimeout(timeout, nameof(options));
        Bindings.Add(new(interceptor, options?.Name, points.Length == 0 ? null : points.ToHashSet(), options?.Timeout, options?.OnError));
        return this;
    }

    /// <summary>Binds a delegate interceptor at <paramref name="points" />, or at every point when none are specified.</summary>
    /// <param name="interceptor">The asynchronous interceptor delegate to invoke.</param>
    /// <param name="options">Optional per-binding label, timeout override, and failure posture override.</param>
    /// <param name="points">The interception points this binding applies to, or empty to apply to all points.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="interceptor" /> is <see langword="null" />.</exception>
    /// <exception cref="ArgumentException"><see cref="BindingOptions.Name" /> is empty or exceeds 128 UTF-8 bytes.</exception>
    /// <exception cref="ArgumentOutOfRangeException"><see cref="BindingOptions.Timeout" /> is neither positive nor <see cref="Timeout.InfiniteTimeSpan" />.</exception>
    public HookEmitterBuilder Use(
        Func<HookCall, CancellationToken, Task<HookOutcome>> interceptor, BindingOptions? options = null,
        params Draft.InterceptionPoint[] points)
    {
        ArgumentNullException.ThrowIfNull(interceptor);
        return Use(new DelegateInterceptor(interceptor), options, points);
    }

    /// <summary>Binds a typed handler at <see cref="Draft.InterceptionPoint.AgentStartup" />.</summary>
    /// <param name="handler">The typed handler delegate.</param>
    /// <param name="options">Optional per-binding settings.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="handler" /> is <see langword="null" />.</exception>
    /// <exception cref="ArgumentException"><see cref="BindingOptions.Name" /> is empty or exceeds 128 UTF-8 bytes.</exception>
    /// <exception cref="ArgumentOutOfRangeException"><see cref="BindingOptions.Timeout" /> is neither positive nor <see cref="Timeout.InfiniteTimeSpan" />.</exception>
    public HookEmitterBuilder OnAgentStartup(Func<Draft.AgentStartupRequest, CancellationToken, Task<Draft.AgentStartupHookResponse>> handler, BindingOptions? options = null) =>
        Typed(Draft.InterceptionPoint.AgentStartup, handler, options);

    /// <summary>Binds a typed handler at <see cref="Draft.InterceptionPoint.Input" />.</summary>
    /// <param name="handler">The typed handler delegate.</param>
    /// <param name="options">Optional per-binding settings.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="handler" /> is <see langword="null" />.</exception>
    /// <exception cref="ArgumentException"><see cref="BindingOptions.Name" /> is empty or exceeds 128 UTF-8 bytes.</exception>
    /// <exception cref="ArgumentOutOfRangeException"><see cref="BindingOptions.Timeout" /> is neither positive nor <see cref="Timeout.InfiniteTimeSpan" />.</exception>
    public HookEmitterBuilder OnInput(Func<Draft.InputRequest, CancellationToken, Task<Draft.InputHookResponse>> handler, BindingOptions? options = null) =>
        Typed(Draft.InterceptionPoint.Input, handler, options);

    /// <summary>Binds a typed handler at <see cref="Draft.InterceptionPoint.PreModelCall" />.</summary>
    /// <param name="handler">The typed handler delegate.</param>
    /// <param name="options">Optional per-binding settings.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="handler" /> is <see langword="null" />.</exception>
    /// <exception cref="ArgumentException"><see cref="BindingOptions.Name" /> is empty or exceeds 128 UTF-8 bytes.</exception>
    /// <exception cref="ArgumentOutOfRangeException"><see cref="BindingOptions.Timeout" /> is neither positive nor <see cref="Timeout.InfiniteTimeSpan" />.</exception>
    public HookEmitterBuilder OnPreModelCall(Func<Draft.PreModelCallRequest, CancellationToken, Task<Draft.PreModelHookResponse>> handler, BindingOptions? options = null) =>
        Typed(Draft.InterceptionPoint.PreModelCall, handler, options);

    /// <summary>Binds a typed handler at <see cref="Draft.InterceptionPoint.PostModelCall" />.</summary>
    /// <param name="handler">The typed handler delegate.</param>
    /// <param name="options">Optional per-binding settings.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="handler" /> is <see langword="null" />.</exception>
    /// <exception cref="ArgumentException"><see cref="BindingOptions.Name" /> is empty or exceeds 128 UTF-8 bytes.</exception>
    /// <exception cref="ArgumentOutOfRangeException"><see cref="BindingOptions.Timeout" /> is neither positive nor <see cref="Timeout.InfiniteTimeSpan" />.</exception>
    public HookEmitterBuilder OnPostModelCall(Func<Draft.PostModelCallRequest, CancellationToken, Task<Draft.PostModelHookResponse>> handler, BindingOptions? options = null) =>
        Typed(Draft.InterceptionPoint.PostModelCall, handler, options);

    /// <summary>Binds a typed handler at <see cref="Draft.InterceptionPoint.PreToolCall" />.</summary>
    /// <param name="handler">The typed handler delegate.</param>
    /// <param name="options">Optional per-binding settings.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="handler" /> is <see langword="null" />.</exception>
    /// <exception cref="ArgumentException"><see cref="BindingOptions.Name" /> is empty or exceeds 128 UTF-8 bytes.</exception>
    /// <exception cref="ArgumentOutOfRangeException"><see cref="BindingOptions.Timeout" /> is neither positive nor <see cref="Timeout.InfiniteTimeSpan" />.</exception>
    public HookEmitterBuilder OnPreToolCall(Func<Draft.PreToolCallRequest, CancellationToken, Task<Draft.PreToolHookResponse>> handler, BindingOptions? options = null) =>
        Typed(Draft.InterceptionPoint.PreToolCall, handler, options);

    /// <summary>Binds a typed handler at <see cref="Draft.InterceptionPoint.PostToolCall" />.</summary>
    /// <param name="handler">The typed handler delegate.</param>
    /// <param name="options">Optional per-binding settings.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="handler" /> is <see langword="null" />.</exception>
    /// <exception cref="ArgumentException"><see cref="BindingOptions.Name" /> is empty or exceeds 128 UTF-8 bytes.</exception>
    /// <exception cref="ArgumentOutOfRangeException"><see cref="BindingOptions.Timeout" /> is neither positive nor <see cref="Timeout.InfiniteTimeSpan" />.</exception>
    public HookEmitterBuilder OnPostToolCall(Func<Draft.PostToolCallRequest, CancellationToken, Task<Draft.PostToolHookResponse>> handler, BindingOptions? options = null) =>
        Typed(Draft.InterceptionPoint.PostToolCall, handler, options);

    /// <summary>Binds a typed handler at <see cref="Draft.InterceptionPoint.Output" />.</summary>
    /// <param name="handler">The typed handler delegate.</param>
    /// <param name="options">Optional per-binding settings.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="handler" /> is <see langword="null" />.</exception>
    /// <exception cref="ArgumentException"><see cref="BindingOptions.Name" /> is empty or exceeds 128 UTF-8 bytes.</exception>
    /// <exception cref="ArgumentOutOfRangeException"><see cref="BindingOptions.Timeout" /> is neither positive nor <see cref="Timeout.InfiniteTimeSpan" />.</exception>
    public HookEmitterBuilder OnOutput(Func<Draft.OutputRequest, CancellationToken, Task<Draft.OutputHookResponse>> handler, BindingOptions? options = null) =>
        Typed(Draft.InterceptionPoint.Output, handler, options);

    /// <summary>Binds a typed handler at <see cref="Draft.InterceptionPoint.AgentShutdown" />.</summary>
    /// <param name="handler">The typed handler delegate.</param>
    /// <param name="options">Optional per-binding settings.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="handler" /> is <see langword="null" />.</exception>
    /// <exception cref="ArgumentException"><see cref="BindingOptions.Name" /> is empty or exceeds 128 UTF-8 bytes.</exception>
    /// <exception cref="ArgumentOutOfRangeException"><see cref="BindingOptions.Timeout" /> is neither positive nor <see cref="Timeout.InfiniteTimeSpan" />.</exception>
    public HookEmitterBuilder OnAgentShutdown(Func<Draft.AgentShutdownRequest, CancellationToken, Task<Draft.AgentShutdownHookResponse>> handler, BindingOptions? options = null) =>
        Typed(Draft.InterceptionPoint.AgentShutdown, handler, options);

    /// <summary>Sets whether verdicts are enforced or evaluated and recorded only (§8).</summary>
    /// <param name="mode">The enforcement mode.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    public HookEmitterBuilder WithMode(Draft.Mode mode)
    {
        Mode = mode;
        return this;
    }

    /// <summary>Selects the composition profile and its resolution knobs (§7).</summary>
    /// <param name="profile">The composition profile governing dispatch order and verdict aggregation.</param>
    /// <param name="onApproval">Whether to stop or resume remaining interceptors after an approval lifts a deny under <see cref="Draft.CompositionProfile.SequentialFirstDeny" />.</param>
    /// <param name="onTransformConflict">Whether conflicting transforms deny or consult approval under <see cref="Draft.CompositionProfile.ParallelStrictest" />.</param>
    /// <param name="onDisagreement">Whether non-unanimous verdicts deny or consult approval under <see cref="Draft.CompositionProfile.ParallelUnanimous" />.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <remarks>
    /// Each profile consults only its own knob (<see cref="Draft.CompositionProfile.SequentialRunAll" /> consults none).
    /// </remarks>
    public HookEmitterBuilder WithComposition(
        Draft.CompositionProfile profile,
        Draft.OnApproval onApproval = Draft.OnApproval.Stop,
        Draft.ConflictResolution onTransformConflict = Draft.ConflictResolution.Deny,
        Draft.ConflictResolution onDisagreement = Draft.ConflictResolution.Deny)
    {
        (Profile, OnApproval, OnTransformConflict, OnDisagreement) = (profile, onApproval, onTransformConflict, onDisagreement);
        return this;
    }

    /// <summary>Sets the context identity provider (§10.1); defaults to <see cref="IdentityProvider.JcsSha256" />.</summary>
    /// <param name="provider">The identity provider to use, or <see langword="null" /> to leave records unbound.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentException">
    /// A custom provider's <see cref="IdentityProvider.Name" /> does not match <c>^[a-z][a-z0-9_-]*$</c> or starts
    /// with <c>jcs</c>.
    /// </exception>
    public HookEmitterBuilder WithIdentityProvider(IdentityProvider? provider)
    {
        if (provider is not null && provider != IdentityProvider.JcsSha256 &&
            (!ProviderName().IsMatch(provider.Name) || provider.Name.StartsWith("jcs", StringComparison.Ordinal)))
            throw new ArgumentException("Custom identity provider names match ^[a-z][a-z0-9_-]*$ and do not start with jcs.", nameof(provider));
        Identity = provider;
        return this;
    }

    /// <summary>Sets the wire-level approval resolver consulted for liftable denies (§9).</summary>
    /// <param name="resolver">The approval resolver implementation.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="resolver" /> is <see langword="null" />.</exception>
    public HookEmitterBuilder WithApprovalResolver(IApprovalResolver resolver)
    {
        Resolver = resolver ?? throw new ArgumentNullException(nameof(resolver));
        return this;
    }

    /// <summary>Sets a typed approval resolver delegate consulted for liftable denies (§9).</summary>
    /// <param name="resolver">The asynchronous delegate resolving a typed <see cref="Draft.ApprovalRequest" /> to a <see cref="Draft.ApprovalResolution" />.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="resolver" /> is <see langword="null" />.</exception>
    public HookEmitterBuilder WithApprovalResolver(Func<Draft.ApprovalRequest, CancellationToken, Task<Draft.ApprovalResolution>> resolver)
    {
        ArgumentNullException.ThrowIfNull(resolver);
        return WithApprovalResolver(new TypedResolver(resolver));
    }

    /// <summary>Sets a redactor applied to the request context before approval consultation (§9).</summary>
    /// <param name="redactor">A function that receives an isolated deep clone of the request and returns the redacted request to present to the resolver.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="redactor" /> is <see langword="null" />.</exception>
    /// <remarks>
    /// The <c>context_identity</c> presented to the approval resolver is computed over the redacted request. Returning
    /// <see langword="null" /> or throwing fails the consultation closed with <see cref="HostErrors.ApprovalResolverFailed" />.
    /// </remarks>
    public HookEmitterBuilder WithApprovalRedactor(Func<JsonObject, JsonObject> redactor)
    {
        Redactor = redactor ?? throw new ArgumentNullException(nameof(redactor));
        return this;
    }

    /// <summary>Sets the default interceptor timeout (default 5 s) and approval-resolver timeout.</summary>
    /// <param name="interceptor">Default timeout for each interceptor binding; must be positive or <see cref="Timeout.InfiniteTimeSpan" />.</param>
    /// <param name="approvalResolver">Optional timeout for approval consultation; defaults to <paramref name="interceptor" /> when <see langword="null" />.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentOutOfRangeException">Either timeout is neither positive nor <see cref="Timeout.InfiniteTimeSpan" />.</exception>
    public HookEmitterBuilder WithTimeouts(TimeSpan interceptor, TimeSpan? approvalResolver = null)
    {
        CheckTimeout(interceptor, nameof(interceptor));
        if (approvalResolver is { } resolver) CheckTimeout(resolver, nameof(approvalResolver));
        (InterceptorTimeout, ResolverTimeout) = (interceptor, approvalResolver);
        return this;
    }

    /// <summary>Sets the default failure posture inherited by bindings that do not override <see cref="BindingOptions.OnError" /> (§6.3.1).</summary>
    /// <param name="onError">The default failure posture.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <remarks>
    /// <see cref="Draft.OnError.Continue" /> takes effect only when a notifier is also configured via
    /// <see cref="OnControlFailure" />; otherwise failures remain fail-closed denies.
    /// </remarks>
    public HookEmitterBuilder WithDefaultOnError(Draft.OnError onError)
    {
        DefaultOnError = onError;
        return this;
    }

    /// <summary>Sets the host's posture when a tool seam yields a host error (§7.7.3).</summary>
    /// <param name="posture">The tool-seam host-error posture.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    public HookEmitterBuilder WithToolSeamPosture(Draft.ToolSeamHostError posture)
    {
        ToolSeamPosture = posture;
        return this;
    }

    /// <summary>Registers the notifier invoked before an <c>on_error: continue</c> substitution takes effect (§6.3.1).</summary>
    /// <param name="notifier">Callback invoked synchronously with a <see cref="ControlFailureNotice" /> before substituting an allow.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="notifier" /> is <see langword="null" />.</exception>
    /// <remarks>
    /// Required for <see cref="Draft.OnError.Continue" /> to apply; if the notifier throws, substitution is aborted
    /// and the fail-closed deny stands.
    /// </remarks>
    public HookEmitterBuilder OnControlFailure(Action<ControlFailureNotice> notifier)
    {
        Notifier = notifier ?? throw new ArgumentNullException(nameof(notifier));
        return this;
    }

    /// <summary>Registers the sink that receives every emitted <see cref="Draft.InterceptionRecord" /> (§10.3).</summary>
    /// <param name="sink">Callback invoked once per emission; exceptions thrown by the sink are swallowed.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="sink" /> is <see langword="null" />.</exception>
    public HookEmitterBuilder WithRecordSink(Action<Draft.InterceptionRecord> sink)
    {
        Sink = sink ?? throw new ArgumentNullException(nameof(sink));
        return this;
    }

    /// <summary>Builds an immutable, thread-safe <see cref="HookEmitter" /> from the current configuration.</summary>
    /// <returns>A new <see cref="HookEmitter" /> instance.</returns>
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
