// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json.Nodes;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks;

/// <summary>One interceptor invocation: an isolated copy of the request and the limit the emitter enforces.</summary>
public sealed record HookCall(Draft.InterceptionPoint Point, JsonObject Request, TimeSpan Timeout);

/// <summary>How an interceptor call ended (spec §6.3). A plain response converts implicitly.</summary>
public abstract record HookOutcome
{
    private HookOutcome() { }

    /// <summary>A hook response object: <c>{ "verdict": …, "extensions"?: … }</c>.</summary>
    public sealed record Responded(JsonObject Body) : HookOutcome;

    /// <summary>The interceptor reports that it ran out of time.</summary>
    public sealed record TimedOut : HookOutcome;

    /// <summary>The interceptor was cancelled; never continuable under <c>on_error: continue</c>.</summary>
    public sealed record Cancelled : HookOutcome;

    /// <summary>The interceptor failed; <paramref name="Detail"/> must be payload-free.</summary>
    public sealed record Failed(string? Detail) : HookOutcome;

    public static HookOutcome Timeout { get; } = new TimedOut();

    public static HookOutcome Cancellation { get; } = new Cancelled();

    public static implicit operator HookOutcome(JsonObject body) => new Responded(body);
}

/// <summary>The single interceptor abstraction every binding adapts to.</summary>
public interface IHookInterceptor
{
    ValueTask<HookOutcome> InterceptAsync(HookCall call, CancellationToken cancellationToken);
}

/// <summary>The JSON-level approval resolver (§9): approval request in, resolution out.</summary>
public interface IApprovalResolver
{
    ValueTask<JsonObject> ResolveAsync(JsonObject request, CancellationToken cancellationToken);
}

/// <summary>Per-binding settings (§6.3.1, §7.7.5).</summary>
public sealed record BindingOptions
{
    /// <summary>The payload-free label recorded in verdict slots and control-failure notices.</summary>
    public string? Name { get; init; }

    /// <summary>Overrides the emitter's default <c>on_error</c>.</summary>
    public Draft.OnError? OnError { get; init; }

    /// <summary>Overrides the emitter's interceptor timeout; <see cref="System.Threading.Timeout.InfiniteTimeSpan"/> is unbounded.</summary>
    public TimeSpan? Timeout { get; init; }
}

/// <summary>A context identity provider (§10.1).</summary>
public sealed record IdentityProvider(string Name, Func<JsonObject, string> Compute)
{
    public static IdentityProvider JcsSha256 { get; } = new(Jcs.ProviderName, Jcs.ContextIdentity);
}

/// <summary>Raised to the host before an <c>on_error: continue</c> substitution takes effect (§6.3.1).</summary>
public sealed record ControlFailureNotice(
    int Index, string Binding, string Reason, string Message, Draft.InterceptionPoint InterceptionPoint);

/// <summary>The outcome of one emission at the JSON level.</summary>
/// <param name="Proceeds">Whether the guarded action may run: evaluate-only mode, or a non-deny verdict.</param>
/// <param name="Request">The effective request, after any enforced transforms.</param>
/// <param name="Verdict">The combined verdict as decided, before record projection.</param>
/// <param name="Record">The interception record delivered to the sink.</param>
public sealed record EmitResult(bool Proceeds, JsonObject Request, JsonObject Verdict, Draft.InterceptionRecord Record);

/// <summary>The outcome of one typed emission; <see cref="Request"/> is what the guarded action must consume.</summary>
public sealed record EmitResult<TRequest>(bool Proceeds, TRequest Request, JsonObject Verdict, Draft.InterceptionRecord Record)
    where TRequest : class;
