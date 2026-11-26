// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json.Nodes;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks;

/// <summary>One interceptor invocation carrying an isolated copy of the request and its deadline.</summary>
/// <param name="Point">The interception point being evaluated.</param>
/// <param name="Request">
/// An isolated deep clone of the wire request for this invocation; mutating it does not affect the emitter or
/// other interceptors.
/// </param>
/// <param name="Timeout">
/// The execution deadline enforced by the emitter, or <see cref="System.Threading.Timeout.InfiniteTimeSpan" /> when
/// unbounded.
/// </param>
public sealed record HookCall(Draft.InterceptionPoint Point, JsonObject Request, TimeSpan Timeout);

/// <summary>How an interceptor call ended (spec §6.3). A plain JSON hook response converts implicitly.</summary>
/// <remarks>
/// <see cref="TimedOut" />, <see cref="Failed" />, and invalid <see cref="Responded" /> bodies are eligible for
/// substitution under <c>on_error: continue</c> when a control-failure notifier is configured.
/// <see cref="Cancelled" /> always fails closed and is never continuable.
/// </remarks>
public abstract record HookOutcome
{
    private HookOutcome() { }

    /// <summary>A hook response object: <c>{ "verdict": …, "extensions"?: … }</c>.</summary>
    /// <param name="Body">The wire hook response JSON object to validate against the point's response schema.</param>
    public sealed record Responded(JsonObject Body) : HookOutcome;

    /// <summary>The interceptor reports that it ran out of time (<see cref="HostErrors.InterceptorTimeout" />).</summary>
    public sealed record TimedOut : HookOutcome;

    /// <summary>The interceptor was cancelled (<see cref="HostErrors.InterceptorFailed" />); never continuable under <c>on_error: continue</c>.</summary>
    public sealed record Cancelled : HookOutcome;

    /// <summary>The interceptor failed (<see cref="HostErrors.InterceptorFailed" />).</summary>
    /// <param name="Detail">Optional payload-free failure detail safe to record in interception records.</param>
    public sealed record Failed(string? Detail) : HookOutcome;

    /// <summary>Gets a shared singleton <see cref="TimedOut" /> outcome.</summary>
    public static HookOutcome Timeout { get; } = new TimedOut();

    /// <summary>Gets a shared singleton <see cref="Cancelled" /> outcome.</summary>
    public static HookOutcome Cancellation { get; } = new Cancelled();

    /// <summary>Wraps a wire hook response JSON object as a <see cref="Responded" /> outcome.</summary>
    /// <param name="body">The wire hook response JSON object.</param>
    /// <returns>A <see cref="Responded" /> outcome carrying <paramref name="body" />.</returns>
    public static implicit operator HookOutcome(JsonObject body) => new Responded(body);
}

/// <summary>The single low-level interceptor abstraction every binding adapts to.</summary>
/// <remarks>
/// Implementations must be safe for concurrent invocations when bound to a shared <see cref="HookEmitter" /> or
/// used under parallel composition profiles. Any unhandled exception is caught by the emitter and mapped to
/// <see cref="HostErrors.InterceptorFailed" />.
/// </remarks>
public interface IHookInterceptor
{
    /// <summary>Evaluates <paramref name="call" /> and returns a hook response or failure outcome.</summary>
    /// <param name="call">The interception point, isolated request copy, and enforced timeout.</param>
    /// <param name="cancellationToken">Canceled when the binding timeout expires or the caller cancels emission.</param>
    /// <returns>A task resolving to the interceptor's <see cref="HookOutcome" />.</returns>
    Task<HookOutcome> InterceptAsync(HookCall call, CancellationToken cancellationToken);
}

/// <summary>The JSON-level approval resolver (§9): wire approval request in, wire approval resolution out.</summary>
/// <remarks>
/// Consulted only for liftable denies in <see cref="Draft.Mode.Enforce" /> mode, and never at
/// <see cref="Draft.InterceptionPoint.AgentShutdown" /> or in <see cref="Draft.Mode.EvaluateOnly" /> mode. The
/// returned resolution must echo the request's <c>context_identity</c> and satisfy the
/// <see cref="Draft.ApprovalResolution" /> schema; timeouts, exceptions, or invalid resolutions fail closed.
/// </remarks>
public interface IApprovalResolver
{
    /// <summary>Resolves a wire approval request and returns the wire approval resolution.</summary>
    /// <param name="request">The wire approval request object containing <c>context_identity</c>, <c>interception_point</c>, <c>verdict</c>, and (optionally redacted) <c>context</c>.</param>
    /// <param name="cancellationToken">Canceled when the approval resolver timeout expires or the caller cancels emission.</param>
    /// <returns>A task resolving to the wire approval resolution JSON object.</returns>
    Task<JsonObject> ResolveAsync(JsonObject request, CancellationToken cancellationToken);
}

/// <summary>Per-binding settings (§6.3.1, §7.7.5).</summary>
public sealed record BindingOptions
{
    /// <summary>Gets or sets the payload-free label (1–128 UTF-8 bytes) recorded in verdict slots and control-failure notices.</summary>
    public string? Name { get; init; }

    /// <summary>
    /// Gets or sets the binding's failure posture, overriding the emitter's default <c>on_error</c>.
    /// <see cref="Draft.OnError.Continue" /> only takes effect when a control-failure notifier is registered.
    /// </summary>
    public Draft.OnError? OnError { get; init; }

    /// <summary>
    /// Gets or sets the binding's execution timeout, overriding the emitter's default interceptor timeout.
    /// Must be positive or <see cref="System.Threading.Timeout.InfiniteTimeSpan" /> (unbounded).
    /// </summary>
    public TimeSpan? Timeout { get; init; }
}

/// <summary>A context identity provider (§10.1).</summary>
/// <param name="Name">
/// The wire name recorded in <c>identity_provider</c>. Custom provider names must match
/// <c>^[a-z][a-z0-9_-]*$</c> and must not start with <c>jcs</c>.
/// </param>
/// <param name="Compute">
/// Computes a deterministic identity string over a candidate (or approval-redacted) request. Throwing
/// <see cref="HookException" /> fails closed with its <see cref="HookException.Reason" />; any other exception
/// fails closed with <see cref="HostErrors.ContextInvalid" />.
/// </param>
public sealed record IdentityProvider(string Name, Func<JsonObject, string> Compute)
{
    /// <summary>Gets the built-in RFC 8785 / SHA-256 identity provider (<c>jcs-sha256</c>).</summary>
    public static IdentityProvider JcsSha256 { get; } = new(Jcs.ProviderName, Jcs.ContextIdentity);
}

/// <summary>Raised to the host before an <c>on_error: continue</c> substitution takes effect (§6.3.1).</summary>
/// <param name="Index">Zero-based index of the failing interceptor among the point's active bindings.</param>
/// <param name="Binding">The binding's configured label, or <c>interceptor-{Index}</c> when unnamed.</param>
/// <param name="Reason">The reserved <c>host_error:*</c> reason being substituted.</param>
/// <param name="Message">The payload-free warning message attached to the substituted allow verdict.</param>
/// <param name="InterceptionPoint">The interception point where the failure occurred.</param>
/// <remarks>
/// The host notifier is invoked synchronously before the allow substitution is applied. If the notifier throws,
/// substitution is aborted and the original fail-closed deny stands.
/// </remarks>
public sealed record ControlFailureNotice(
    int Index, string Binding, string Reason, string Message, Draft.InterceptionPoint InterceptionPoint);

/// <summary>The outcome of one emission at the wire JSON level.</summary>
/// <param name="Proceeds">
/// <see langword="true" /> if the guarded action may run (either <see cref="Draft.Mode.EvaluateOnly" /> mode or a
/// non-deny verdict); <see langword="false" /> if the host must block the action.
/// </param>
/// <param name="Request">The effective wire request after any enforced whole-target transforms.</param>
/// <param name="Verdict">The combined wire verdict as decided, before <see cref="Record" /> projection.</param>
/// <param name="Record">The projected interception record delivered to the configured sink.</param>
public sealed record EmitResult(bool Proceeds, JsonObject Request, JsonObject Verdict, Draft.InterceptionRecord Record);

/// <summary>The outcome of one typed emission; <see cref="Request" /> is what the guarded action must consume.</summary>
/// <typeparam name="TRequest">The generated draft request contract type.</typeparam>
/// <param name="Proceeds">
/// <see langword="true" /> if the guarded action may run (either <see cref="Draft.Mode.EvaluateOnly" /> mode or a
/// non-deny verdict); <see langword="false" /> if the host must block the action.
/// </param>
/// <param name="Request">
/// The effective typed request after any enforced whole-target transforms (the original instance when unchanged).
/// </param>
/// <param name="Verdict">The combined wire verdict as decided, before <see cref="Record" /> projection.</param>
/// <param name="Record">The projected interception record delivered to the configured sink.</param>
public sealed record EmitResult<TRequest>(bool Proceeds, TRequest Request, JsonObject Verdict, Draft.InterceptionRecord Record)
    where TRequest : class;
