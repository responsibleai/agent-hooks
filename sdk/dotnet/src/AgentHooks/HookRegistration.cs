// Copyright (c) Microsoft. All rights reserved.

// Registration of typed tool hooks (Hooks.cs) on an InterceptionEmitter.
//
// Each call registers an adapter through the existing
// RegisterWithOptions with At = {pre_tool_call} or {post_tool_call}, so
// name and on_error (§6.3.1) behave exactly as for any code
// registration, and so does a refusal (sealed emitter, continue without
// a notifier or under 0.1).
//
// Counting (§7.7.8): a hook registration is one ordinary registration
// bound at one point. At that point it counts once toward
// interceptors_registered and takes the next verdicts[].index in
// registration order among the registrations bound there; at every other
// point it is not counted and has no index. An object that implements
// both hook interfaces is two registrations, one per point, so it still
// counts once at each.

namespace AgentHooks;

/// <summary>Registers typed tool hooks (<see cref="IPreToolCallHook"/>,
/// <see cref="IPostToolCallHook"/>) on an <see cref="InterceptionEmitter"/>.</summary>
public static class HookRegistration
{
    private static readonly IReadOnlySet<InterceptionPoint> PreOnly =
        new HashSet<InterceptionPoint> { InterceptionPoint.PreToolCall };

    private static readonly IReadOnlySet<InterceptionPoint> PostOnly =
        new HashSet<InterceptionPoint> { InterceptionPoint.PostToolCall };

    /// <summary>Register <paramref name="hook"/> at <c>pre_tool_call</c>
    /// with the payload-free <paramref name="name"/> stamped on
    /// <c>verdicts[].name</c> (§10.3) and failure posture
    /// <paramref name="onError"/> (§6.3.1). When <paramref name="hook"/>
    /// also implements <see cref="IPostToolCallHook"/> it is registered at
    /// <c>post_tool_call</c> too, once per point. Refusals are those of
    /// <see cref="InterceptionEmitter.RegisterWithOptions"/>.</summary>
    public static InterceptionEmitter RegisterHook(
        this InterceptionEmitter emitter, IPreToolCallHook hook, string? name = null, OnError onError = OnError.Deny)
    {
        ArgumentNullException.ThrowIfNull(emitter);
        ArgumentNullException.ThrowIfNull(hook);
        return RegisterAt(emitter, hook, hook as IPostToolCallHook, name, onError);
    }

    /// <summary>Register <paramref name="hook"/> at <c>post_tool_call</c>.
    /// When <paramref name="hook"/> also implements
    /// <see cref="IPreToolCallHook"/> it is registered at
    /// <c>pre_tool_call</c> too, once per point. See
    /// <see cref="RegisterHook(InterceptionEmitter, IPreToolCallHook, string?, OnError)"/>.</summary>
    public static InterceptionEmitter RegisterHook(
        this InterceptionEmitter emitter, IPostToolCallHook hook, string? name = null, OnError onError = OnError.Deny)
    {
        ArgumentNullException.ThrowIfNull(emitter);
        ArgumentNullException.ThrowIfNull(hook);
        return RegisterAt(emitter, hook as IPreToolCallHook, hook, name, onError);
    }

    /// <summary>Register one adapter per hook interface implemented by
    /// <paramref name="hook"/>: <c>pre_tool_call</c> first, then
    /// <c>post_tool_call</c>. Throws <see cref="RegistrationException"/>
    /// when neither interface is implemented; nothing is registered then.</summary>
    public static InterceptionEmitter RegisterHook<THook>(
        this InterceptionEmitter emitter, THook hook, string? name = null, OnError onError = OnError.Deny)
    {
        ArgumentNullException.ThrowIfNull(emitter);
        ArgumentNullException.ThrowIfNull(hook);
        var pre = hook as IPreToolCallHook;
        var post = hook as IPostToolCallHook;
        if (pre is null && post is null)
            throw new RegistrationException(
                "hook must implement IPreToolCallHook or IPostToolCallHook; nothing was registered");
        return RegisterAt(emitter, pre, post, name, onError);
    }

    /// <summary>Register <paramref name="hook"/> as a
    /// <c>pre_tool_call</c> hook named <paramref name="name"/>.</summary>
    public static InterceptionEmitter OnPreToolCall(
        this InterceptionEmitter emitter,
        string name,
        Func<PreToolCallRequest, CancellationToken, ValueTask<Verdict>> hook,
        OnError onError = OnError.Deny)
    {
        ArgumentNullException.ThrowIfNull(hook);
        return emitter.RegisterHook(new DelegatePreToolCallHook(hook), name, onError);
    }

    /// <summary>Register <paramref name="hook"/> as a
    /// <c>post_tool_call</c> hook named <paramref name="name"/>.</summary>
    public static InterceptionEmitter OnPostToolCall(
        this InterceptionEmitter emitter,
        string name,
        Func<PostToolCallRequest, CancellationToken, ValueTask<Verdict>> hook,
        OnError onError = OnError.Deny)
    {
        ArgumentNullException.ThrowIfNull(hook);
        return emitter.RegisterHook(new DelegatePostToolCallHook(hook), name, onError);
    }

    private static InterceptionEmitter RegisterAt(
        InterceptionEmitter emitter, IPreToolCallHook? pre, IPostToolCallHook? post, string? name, OnError onError)
    {
        if (pre is not null)
            emitter.RegisterWithOptions(new PreToolCallHookInterceptor(pre), new RegistrationOptions(name, PreOnly, onError));
        if (post is not null)
            emitter.RegisterWithOptions(new PostToolCallHookInterceptor(post), new RegistrationOptions(name, PostOnly, onError));
        return emitter;
    }
}
