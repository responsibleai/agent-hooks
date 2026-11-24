// Copyright (c) Microsoft. All rights reserved.

using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks;

public sealed partial class HookEmitterBuilder
{
    /// <summary>
    /// Registers a hook at each generated per-point interface it implements (for example
    /// <see cref="Draft.IPreToolCallHook"/>), in specification order.
    /// </summary>
    /// <exception cref="ArgumentException">The hook implements no per-point hook interface.</exception>
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
