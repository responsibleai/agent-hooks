// Copyright (c) Microsoft. All rights reserved.

using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks;

public sealed partial class HookEmitterBuilder
{
    /// <summary>Registers a hook at each optional per-point interface it implements, in specification order.</summary>
    /// <exception cref="ArgumentException">The hook implements no supported per-point interface.</exception>
    public HookEmitterBuilder AddHook(object hook, BindingOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(hook);
        if (hook is not (IAgentStartupHook or IInputHook or IPreModelCallHook or IPostModelCallHook
            or IPreToolCallHook or IPostToolCallHook or IOutputHook or IAgentShutdownHook))
            throw new ArgumentException("The hook must implement at least one per-point hook interface.", nameof(hook));

        if (hook is IAgentStartupHook startup) OnAgentStartup(startup.OnAgentStartupAsync, options);
        if (hook is IInputHook input) OnInput(input.OnInputAsync, options);
        if (hook is IPreModelCallHook preModel) OnPreModelCall(preModel.OnPreModelCallAsync, options);
        if (hook is IPostModelCallHook postModel) OnPostModelCall(postModel.OnPostModelCallAsync, options);
        if (hook is IPreToolCallHook preTool) OnPreToolCall(preTool.OnPreToolCallAsync, options);
        if (hook is IPostToolCallHook postTool) OnPostToolCall(postTool.OnPostToolCallAsync, options);
        if (hook is IOutputHook output) OnOutput(output.OnOutputAsync, options);
        if (hook is IAgentShutdownHook shutdown) OnAgentShutdown(shutdown.OnAgentShutdownAsync, options);
        return this;
    }

    /// <summary>Binds a named agent-startup delegate; the explicit name overrides <see cref="BindingOptions.Name"/>.</summary>
    public HookEmitterBuilder OnAgentStartup(string name, Func<Draft.AgentStartupRequest, CancellationToken, Task<Draft.AgentStartupHookResponse>> handler, BindingOptions? options = null) =>
        OnAgentStartup(handler, Named(name, options));

    /// <summary>Binds a named input delegate; the explicit name overrides <see cref="BindingOptions.Name"/>.</summary>
    public HookEmitterBuilder OnInput(string name, Func<Draft.InputRequest, CancellationToken, Task<Draft.InputHookResponse>> handler, BindingOptions? options = null) =>
        OnInput(handler, Named(name, options));

    /// <summary>Binds a named pre-model delegate; the explicit name overrides <see cref="BindingOptions.Name"/>.</summary>
    public HookEmitterBuilder OnPreModelCall(string name, Func<Draft.PreModelCallRequest, CancellationToken, Task<Draft.PreModelHookResponse>> handler, BindingOptions? options = null) =>
        OnPreModelCall(handler, Named(name, options));

    /// <summary>Binds a named post-model delegate; the explicit name overrides <see cref="BindingOptions.Name"/>.</summary>
    public HookEmitterBuilder OnPostModelCall(string name, Func<Draft.PostModelCallRequest, CancellationToken, Task<Draft.PostModelHookResponse>> handler, BindingOptions? options = null) =>
        OnPostModelCall(handler, Named(name, options));

    /// <summary>Binds a named pre-tool delegate; the explicit name overrides <see cref="BindingOptions.Name"/>.</summary>
    public HookEmitterBuilder OnPreToolCall(string name, Func<Draft.PreToolCallRequest, CancellationToken, Task<Draft.PreToolHookResponse>> handler, BindingOptions? options = null) =>
        OnPreToolCall(handler, Named(name, options));

    /// <summary>Binds a named post-tool delegate; the explicit name overrides <see cref="BindingOptions.Name"/>.</summary>
    public HookEmitterBuilder OnPostToolCall(string name, Func<Draft.PostToolCallRequest, CancellationToken, Task<Draft.PostToolHookResponse>> handler, BindingOptions? options = null) =>
        OnPostToolCall(handler, Named(name, options));

    /// <summary>Binds a named output delegate; the explicit name overrides <see cref="BindingOptions.Name"/>.</summary>
    public HookEmitterBuilder OnOutput(string name, Func<Draft.OutputRequest, CancellationToken, Task<Draft.OutputHookResponse>> handler, BindingOptions? options = null) =>
        OnOutput(handler, Named(name, options));

    /// <summary>Binds a named agent-shutdown delegate; the explicit name overrides <see cref="BindingOptions.Name"/>.</summary>
    public HookEmitterBuilder OnAgentShutdown(string name, Func<Draft.AgentShutdownRequest, CancellationToken, Task<Draft.AgentShutdownHookResponse>> handler, BindingOptions? options = null) =>
        OnAgentShutdown(handler, Named(name, options));

    private static BindingOptions Named(string name, BindingOptions? options)
    {
        ArgumentNullException.ThrowIfNull(name);
        return (options ?? new BindingOptions()) with { Name = name };
    }
}
