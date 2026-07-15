// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// AgentContext construction (§4).
//
// Stateful per-session builder that owns the L0 envelope
// (agent/session/sequence/timestamp) and exposes one method per
// interception point that fills L1 and sets `target`. Port of
// sdk/python/python/agent_hooks/context.py.

using System.Text.Json.Nodes;

using System.Threading;

namespace AgentHooks;

/// <summary>Stateful per-session builder for <see cref="AgentContext"/> values.
/// One instance per session.</summary>
public sealed class AgentContextBuilder
{
    private readonly JsonObject _agent;
    private readonly JsonObject _session;
    private readonly Dictionary<string, JsonNode?> _l2 = [];
    private int _seq = -1; // advanced via Interlocked.Increment (§12.2.3)

    public AgentContextBuilder(
        string agentId,
        string framework,
        string sessionId,
        string? agentName = null,
        string? agentVersion = null,
        string? sessionStartedAt = null)
    {
        _agent = new JsonObject { ["id"] = agentId, ["framework"] = framework };
        if (agentName is not null) _agent["name"] = agentName;
        if (agentVersion is not null) _agent["version"] = agentVersion;
        _session = new JsonObject { ["id"] = sessionId };
        if (sessionStartedAt is not null) _session["started_at"] = sessionStartedAt;
    }

    /// <summary>Attach L2 fields (trace, tenant, budgets, actor…) to every
    /// subsequent context.</summary>
    public AgentContextBuilder WithL2(string key, JsonNode? value)
    {
        if (value is not null) _l2[key] = value;
        return this;
    }

    private static string Now() =>
        DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.ffffffZ");

    private JsonObject Envelope(InterceptionPoint ip, JsonNode? target)
    {
        var ctx = new JsonObject
        {
            ["spec"] = Spec.Version,
            ["interception_point"] = ip.ToWireName(),
            ["timestamp"] = Now(),
            ["sequence"] = Interlocked.Increment(ref _seq),
            ["agent"] = _agent.DeepClone(),
            ["session"] = _session.DeepClone(),
            ["target"] = target?.DeepClone(),
        };
        foreach (var (k, v) in _l2) ctx[k] = v?.DeepClone();
        return ctx;
    }

    // ---- per-interception-point L1 builders --------------------------------

    public AgentContext AgentStartup(IEnumerable<string> toolsRegistered)
    {
        var init = new JsonObject
        {
            ["tools_registered"] = new JsonArray(toolsRegistered.Select(t => (JsonNode)t).ToArray()),
        };
        var ctx = Envelope(InterceptionPoint.AgentStartup, init);
        ctx["agent_init"] = init.DeepClone();
        return ctx;
    }

    public AgentContext Input(JsonNode? content, string role = "user")
    {
        var inp = new JsonObject { ["content"] = content?.DeepClone(), ["role"] = role };
        var ctx = Envelope(InterceptionPoint.Input, inp);
        ctx["input"] = inp.DeepClone();
        return ctx;
    }

    public AgentContext PreModelCall(string modelId, JsonArray messages,
        JsonArray? tools = null, string? requestId = null)
    {
        var ctx = Envelope(InterceptionPoint.PreModelCall, messages);
        ctx["model"] = new JsonObject { ["id"] = modelId };
        ctx["messages"] = messages.DeepClone();
        if (tools is not null) ctx["tools"] = tools.DeepClone();
        if (requestId is not null) ctx["request_id"] = requestId;
        return ctx;
    }

    public AgentContext PostModelCall(string modelId, JsonNode? content,
        JsonArray toolCalls, string finishReason,
        JsonObject? usage = null, string? requestId = null)
    {
        var response = new JsonObject
        {
            ["content"] = content?.DeepClone(),
            ["tool_calls"] = toolCalls.DeepClone(),
            ["finish_reason"] = finishReason,
        };
        var ctx = Envelope(InterceptionPoint.PostModelCall, response);
        ctx["model"] = new JsonObject { ["id"] = modelId };
        ctx["response"] = response.DeepClone();
        if (usage is not null) ctx["usage"] = usage.DeepClone();
        if (requestId is not null) ctx["request_id"] = requestId;
        return ctx;
    }

    public AgentContext PreToolCall(string callId, string name, JsonObject args)
    {
        var tc = new JsonObject
        {
            ["id"] = callId,
            ["name"] = name,
            ["args"] = args.DeepClone(),
        };
        var ctx = Envelope(InterceptionPoint.PreToolCall, args);
        ctx["tool_call"] = tc;
        return ctx;
    }

    public AgentContext PostToolCall(string callId, string name, JsonObject args,
        JsonNode? value, bool isError = false, double? durationMs = null)
    {
        var tr = new JsonObject { ["value"] = value?.DeepClone(), ["is_error"] = isError };
        if (durationMs is not null) tr["duration_ms"] = durationMs;
        var ctx = Envelope(InterceptionPoint.PostToolCall, value);
        ctx["tool_call"] = new JsonObject
        {
            ["id"] = callId,
            ["name"] = name,
            ["args"] = args.DeepClone(),
        };
        ctx["tool_result"] = tr;
        return ctx;
    }

    public AgentContext Output(JsonNode? content)
    {
        var o = new JsonObject { ["content"] = content?.DeepClone() };
        var ctx = Envelope(InterceptionPoint.Output, o);
        ctx["output"] = o.DeepClone();
        return ctx;
    }

    public AgentContext AgentShutdown(string reason)
    {
        var summary = new JsonObject { ["reason"] = reason };
        var ctx = Envelope(InterceptionPoint.AgentShutdown, summary);
        ctx["summary"] = summary.DeepClone();
        return ctx;
    }
}
