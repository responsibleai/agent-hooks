// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks;

/// <summary>Factories for generated agent-startup responses; normal runtime verdict validation still applies.</summary>
public static class AgentStartupResponses
{
    public static Draft.AgentStartupHookResponse Allow() => new() { Verdict = new Draft.AllowVerdict() };
    public static Draft.AgentStartupHookResponse Deny(string reason) => new() { Verdict = ResponseVerdicts.Deny(reason) };
}

/// <summary>Factories for generated input responses; transforms replace the whole input.</summary>
public static class InputResponses
{
    public static Draft.InputHookResponse Allow() => new() { Verdict = new Draft.AllowVerdict() };
    public static Draft.InputHookResponse Deny(string reason) => new() { Verdict = ResponseVerdicts.Deny(reason) };

    public static Draft.InputHookResponse TransformInput(Draft.Input input)
    {
        ArgumentNullException.ThrowIfNull(input);
        return new() { Verdict = new Draft.TransformVerdictInputHookTransform { Transform = new() { Input = input } } };
    }
}

/// <summary>Factories for generated pre-model responses; transforms replace the whole messages array.</summary>
public static class PreModelResponses
{
    public static Draft.PreModelHookResponse Allow() => new() { Verdict = new Draft.AllowVerdict() };
    public static Draft.PreModelHookResponse Deny(string reason) => new() { Verdict = ResponseVerdicts.Deny(reason) };

    public static Draft.PreModelHookResponse TransformMessages(Draft.Message[] messages)
    {
        ArgumentNullException.ThrowIfNull(messages);
        return new() { Verdict = new Draft.TransformVerdictPreModelHookTransform { Transform = new() { Messages = messages } } };
    }
}

/// <summary>Factories for generated post-model responses; transforms replace the whole model response.</summary>
public static class PostModelResponses
{
    public static Draft.PostModelHookResponse Allow() => new() { Verdict = new Draft.AllowVerdict() };
    public static Draft.PostModelHookResponse Deny(string reason) => new() { Verdict = ResponseVerdicts.Deny(reason) };

    public static Draft.PostModelHookResponse TransformResponse(Draft.Response response)
    {
        ArgumentNullException.ThrowIfNull(response);
        return new() { Verdict = new Draft.TransformVerdictPostModelHookTransform { Transform = new() { Response = response } } };
    }
}

/// <summary>Factories for generated pre-tool responses; transforms replace the whole tool-call arguments object.</summary>
public static class PreToolResponses
{
    public static Draft.PreToolHookResponse Allow() => new() { Verdict = new Draft.AllowVerdict() };
    public static Draft.PreToolHookResponse Deny(string reason) => new() { Verdict = ResponseVerdicts.Deny(reason) };

    public static Draft.PreToolHookResponse TransformArgs(Draft.JsonObject args)
    {
        ArgumentNullException.ThrowIfNull(args);
        return new() { Verdict = new Draft.TransformVerdictPreToolHookTransform { Transform = new() { Args = args } } };
    }
}

/// <summary>Factories for generated post-tool responses; transforms replace the whole tool-result value, including JSON null.</summary>
public static class PostToolResponses
{
    public static Draft.PostToolHookResponse Allow() => new() { Verdict = new Draft.AllowVerdict() };
    public static Draft.PostToolHookResponse Deny(string reason) => new() { Verdict = ResponseVerdicts.Deny(reason) };

    public static Draft.PostToolHookResponse TransformValue(JsonElement value) =>
        new() { Verdict = new Draft.TransformVerdictPostToolHookTransform { Transform = new() { Value = value.Clone() } } };
}

/// <summary>Factories for generated output responses; transforms replace the whole output.</summary>
public static class OutputResponses
{
    public static Draft.OutputHookResponse Allow() => new() { Verdict = new Draft.AllowVerdict() };
    public static Draft.OutputHookResponse Deny(string reason) => new() { Verdict = ResponseVerdicts.Deny(reason) };

    public static Draft.OutputHookResponse TransformOutput(Draft.Output output)
    {
        ArgumentNullException.ThrowIfNull(output);
        return new() { Verdict = new Draft.TransformVerdictOutputHookTransform { Transform = new() { Output = output } } };
    }
}

/// <summary>Factories for generated agent-shutdown responses; normal runtime verdict validation still applies.</summary>
public static class AgentShutdownResponses
{
    public static Draft.AgentShutdownHookResponse Allow() => new() { Verdict = new Draft.AllowVerdict() };
    public static Draft.AgentShutdownHookResponse Deny(string reason) => new() { Verdict = ResponseVerdicts.Deny(reason) };
}

internal static class ResponseVerdicts
{
    internal static Draft.DenyVerdict Deny(string reason)
    {
        ArgumentNullException.ThrowIfNull(reason);
        return new() { Reason = reason };
    }
}
