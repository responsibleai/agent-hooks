// Copyright (c) Microsoft. All rights reserved.

using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks;

public sealed partial class HookEmitterBuilder
{
    /// <summary>
    /// Registers a hook object at each generated per-point interface it implements (for example,
    /// <see cref="Draft.IPreToolCallHook" /> or <see cref="Draft.IInterceptor" />), in specification order.
    /// </summary>
    /// <param name="hook">An object implementing one or more generated per-point hook interfaces.</param>
    /// <param name="options">Optional per-binding settings applied to every point registered from <paramref name="hook" />.</param>
    /// <returns>This builder instance for fluent chaining.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="hook" /> is <see langword="null" />.</exception>
    /// <exception cref="ArgumentException">
    /// <paramref name="hook" /> implements no per-point hook interface, or <see cref="BindingOptions.Name" /> is
    /// empty or exceeds 128 UTF-8 bytes.
    /// </exception>
    /// <exception cref="ArgumentOutOfRangeException"><see cref="BindingOptions.Timeout" /> is neither positive nor <see cref="Timeout.InfiniteTimeSpan" />.</exception>
    /// <remarks>
    /// One typed binding is added per implemented interface in specification order:
    /// <see cref="Draft.InterceptionPoint.AgentStartup" />, <see cref="Draft.InterceptionPoint.Input" />,
    /// <see cref="Draft.InterceptionPoint.PreModelCall" />, <see cref="Draft.InterceptionPoint.PostModelCall" />,
    /// <see cref="Draft.InterceptionPoint.PreToolCall" />, <see cref="Draft.InterceptionPoint.PostToolCall" />,
    /// <see cref="Draft.InterceptionPoint.Output" />, and <see cref="Draft.InterceptionPoint.AgentShutdown" />.
    /// </remarks>
    public HookEmitterBuilder AddHook(object hook, BindingOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(hook);
        if (hook is not (Draft.IAgentStartupHook or Draft.IInputHook or Draft.IPreModelCallHook or Draft.IPostModelCallHook
            or Draft.IPreToolCallHook or Draft.IPostToolCallHook or Draft.IOutputHook or Draft.IAgentShutdownHook))
            throw new ArgumentException("The hook must implement at least one per-point hook interface.", nameof(hook));

        if (hook is Draft.IAgentStartupHook startup) OnAgentStartup(startup.OnAgentStartupAsync, options);
        if (hook is Draft.IInputHook input) OnInput(input.OnInputAsync, options);
        if (hook is Draft.IPreModelCallHook preModel) OnPreModelCall(preModel.OnPreModelCallAsync, options);
        if (hook is Draft.IPostModelCallHook postModel) OnPostModelCall(postModel.OnPostModelCallAsync, options);
        if (hook is Draft.IPreToolCallHook preTool) OnPreToolCall(preTool.OnPreToolCallAsync, options);
        if (hook is Draft.IPostToolCallHook postTool) OnPostToolCall(postTool.OnPostToolCallAsync, options);
        if (hook is Draft.IOutputHook output) OnOutput(output.OnOutputAsync, options);
        if (hook is Draft.IAgentShutdownHook shutdown) OnAgentShutdown(shutdown.OnAgentShutdownAsync, options);
        return this;
    }
}
