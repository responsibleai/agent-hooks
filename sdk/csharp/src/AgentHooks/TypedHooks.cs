// Copyright (c) Microsoft. All rights reserved.

using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks;

/// <summary>An optional agent-startup hook. Register with <see cref="HookEmitterBuilder.AddHook"/>.</summary>
public interface IAgentStartupHook
{
    Task<Draft.AgentStartupHookResponse> OnAgentStartupAsync(Draft.AgentStartupRequest request, CancellationToken cancellationToken);
}

/// <summary>An optional input hook. Register with <see cref="HookEmitterBuilder.AddHook"/>.</summary>
public interface IInputHook
{
    Task<Draft.InputHookResponse> OnInputAsync(Draft.InputRequest request, CancellationToken cancellationToken);
}

/// <summary>An optional pre-model hook. Register with <see cref="HookEmitterBuilder.AddHook"/>.</summary>
public interface IPreModelCallHook
{
    Task<Draft.PreModelHookResponse> OnPreModelCallAsync(Draft.PreModelCallRequest request, CancellationToken cancellationToken);
}

/// <summary>An optional post-model hook. Register with <see cref="HookEmitterBuilder.AddHook"/>.</summary>
public interface IPostModelCallHook
{
    Task<Draft.PostModelHookResponse> OnPostModelCallAsync(Draft.PostModelCallRequest request, CancellationToken cancellationToken);
}

/// <summary>An optional pre-tool hook. Register with <see cref="HookEmitterBuilder.AddHook"/>.</summary>
public interface IPreToolCallHook
{
    Task<Draft.PreToolHookResponse> OnPreToolCallAsync(Draft.PreToolCallRequest request, CancellationToken cancellationToken);
}

/// <summary>An optional post-tool hook. Register with <see cref="HookEmitterBuilder.AddHook"/>.</summary>
public interface IPostToolCallHook
{
    Task<Draft.PostToolHookResponse> OnPostToolCallAsync(Draft.PostToolCallRequest request, CancellationToken cancellationToken);
}

/// <summary>An optional output hook. Register with <see cref="HookEmitterBuilder.AddHook"/>.</summary>
public interface IOutputHook
{
    Task<Draft.OutputHookResponse> OnOutputAsync(Draft.OutputRequest request, CancellationToken cancellationToken);
}

/// <summary>An optional agent-shutdown hook. Register with <see cref="HookEmitterBuilder.AddHook"/>.</summary>
public interface IAgentShutdownHook
{
    Task<Draft.AgentShutdownHookResponse> OnAgentShutdownAsync(Draft.AgentShutdownRequest request, CancellationToken cancellationToken);
}
