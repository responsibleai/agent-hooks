// Copyright (c) Microsoft. All rights reserved.

// Typed tool hooks (§3, §4.2, §5.2): read-only views over the
// pre_tool_call and post_tool_call contexts, the hook interfaces that
// receive them and the adapters that run a hook as an IInterceptor.
//
// A view never copies or deserializes the context: every property reads
// AgentContext.Json on access, so identity (§10), extensions, unknown
// members and int64 values reach the emitter exactly as the host built
// them. The field names follow the draft schema
// (spec/draft/schema/src/agent-context.ts); they are identical under 0.1.
//
// Transforms use the path-based Transform the emitter accepts today. At
// both tool points the context's target is the whole replaceable member
// (tool_call.args at pre_tool_call, tool_result.value at post_tool_call,
// §3) and the core writes the transformed target back to that member, so
// the helpers use the bare root "$target" (path-grammar.abnf: a root with
// zero segments replaces the whole target).

using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentHooks;

/// <summary>Read-only view of the <c>tool_call</c> member of a
/// <c>pre_tool_call</c> or <c>post_tool_call</c> context (§4.2). Reads the
/// underlying node on access; nothing is copied.</summary>
public sealed class ToolCall
{
    private readonly JsonObject _json;

    internal ToolCall(JsonObject json) => _json = json;

    /// <summary>The underlying <c>tool_call</c> object of the context.</summary>
    public JsonObject Json => _json;

    /// <summary><c>tool_call.id</c>.</summary>
    public string Id => HookJson.RequiredString(_json, "id", "tool_call");

    /// <summary><c>tool_call.name</c>.</summary>
    public string Name => HookJson.RequiredString(_json, "name", "tool_call");

    /// <summary><c>tool_call.args</c>, the live node of the context. Do not
    /// mutate it: return <see cref="PreToolCallRequest.TransformArgs"/>
    /// to change the arguments.</summary>
    public JsonObject Args => HookJson.RequiredObject(_json, "args", "tool_call");

    /// <summary><c>tool_call.content_hash</c>, or <c>null</c> when absent.</summary>
    public string? ContentHash => (string?)_json["content_hash"];
}

/// <summary>Read-only view of the <c>tool_result</c> member of a
/// <c>post_tool_call</c> context (§4.2). Reads the underlying node on
/// access; nothing is copied.</summary>
public sealed class ToolResult
{
    private readonly JsonObject _json;

    internal ToolResult(JsonObject json) => _json = json;

    /// <summary>The underlying <c>tool_result</c> object of the context.</summary>
    public JsonObject Json => _json;

    /// <summary><c>tool_result.value</c>, the live node of the context (any
    /// JSON, <c>null</c> for JSON null). Do not mutate it: return
    /// <see cref="PostToolCallRequest.TransformValue"/> to change it.</summary>
    public JsonNode? Value => _json["value"];

    /// <summary><c>tool_result.is_error</c>.</summary>
    public bool IsError => _json["is_error"] is JsonNode n
        ? (bool)n
        : throw HookJson.Missing("tool_result", "is_error");

    /// <summary><c>tool_result.duration_ms</c>, or <c>null</c> when absent.</summary>
    public double? DurationMs => _json["duration_ms"] is null
        ? null
        : HookJson.Number(_json, "duration_ms") ?? throw HookJson.Missing("tool_result", "duration_ms");
}

/// <summary>The typed request a <see cref="IPreToolCallHook"/> receives: a
/// read-only view over a <c>pre_tool_call</c> <see cref="AgentContext"/>
/// (§4.2 <c>PreToolCallRequest</c>). Every property reads
/// <see cref="Json"/> on access; wrapping changes nothing in the context,
/// so its identity (§10), extensions and unknown members are untouched.</summary>
public sealed class PreToolCallRequest
{
    /// <summary>Wrap <paramref name="context"/>; throws
    /// <see cref="ArgumentException"/> unless its
    /// <c>interception_point</c> is <c>pre_tool_call</c>.</summary>
    public PreToolCallRequest(AgentContext context)
    {
        Json = HookJson.RequirePoint(context, InterceptionPoint.PreToolCall, nameof(context));
    }

    /// <summary>The wrapped context object itself (same reference).</summary>
    public JsonObject Json { get; }

    /// <summary>The context's <c>spec</c> wire string (§4.1).</summary>
    public string Spec => HookJson.RequiredString(Json, "spec", null);

    /// <summary>The context's <c>sequence</c> (§4.1).</summary>
    public long Sequence => HookJson.Sequence(Json);

    /// <summary><c>agent.id</c>.</summary>
    public string AgentId => HookJson.RequiredString(HookJson.RequiredObject(Json, "agent", null), "id", "agent");

    /// <summary><c>session.id</c>.</summary>
    public string SessionId => HookJson.RequiredString(HookJson.RequiredObject(Json, "session", null), "id", "session");

    /// <summary>The optional <c>tenant</c> block (§4.5), or <c>null</c>
    /// when the context carries none.</summary>
    public JsonObject? Tenant => Json["tenant"] as JsonObject;

    /// <summary>The <c>tool_call</c> member.</summary>
    public ToolCall ToolCall => new(HookJson.RequiredObject(Json, "tool_call", null));

    /// <summary>A <see cref="Decision.Transform"/> verdict replacing the
    /// whole of <c>tool_call.args</c> with <paramref name="args"/> (§5.2):
    /// path <c>$target</c>, since the <c>pre_tool_call</c> target is
    /// <c>tool_call.args</c> (§3). The value is a detached copy, so the
    /// verdict never aliases the live context.</summary>
    public static Verdict TransformArgs(JsonObject args)
    {
        ArgumentNullException.ThrowIfNull(args);
        return new Verdict(Decision.Transform, Transform: new Transform(HookJson.TargetRoot, args.DeepClone()));
    }

    /// <summary>A request for a unit test, built with
    /// <see cref="AgentContextBuilder.PreToolCall"/> under
    /// <paramref name="spec"/>. <paramref name="tenant"/>, when given, is
    /// attached as the context's <c>tenant</c> block.</summary>
    public static PreToolCallRequest ForTest(
        string name,
        JsonObject args,
        string spec = AgentHooks.Spec.V01,
        string callId = "call-1",
        string agentId = "test-agent",
        string sessionId = "test-session",
        JsonObject? tenant = null)
    {
        var builder = HookJson.TestBuilder(spec, agentId, sessionId, tenant);
        return new PreToolCallRequest(builder.PreToolCall(callId, name, args));
    }
}

/// <summary>The typed request a <see cref="IPostToolCallHook"/> receives: a
/// read-only view over a <c>post_tool_call</c> <see cref="AgentContext"/>
/// (§4.2 <c>PostToolCallRequest</c>). Every property reads
/// <see cref="Json"/> on access; wrapping changes nothing in the context,
/// so its identity (§10), extensions and unknown members are untouched.</summary>
public sealed class PostToolCallRequest
{
    /// <summary>Wrap <paramref name="context"/>; throws
    /// <see cref="ArgumentException"/> unless its
    /// <c>interception_point</c> is <c>post_tool_call</c>.</summary>
    public PostToolCallRequest(AgentContext context)
    {
        Json = HookJson.RequirePoint(context, InterceptionPoint.PostToolCall, nameof(context));
    }

    /// <summary>The wrapped context object itself (same reference).</summary>
    public JsonObject Json { get; }

    /// <summary>The context's <c>spec</c> wire string (§4.1).</summary>
    public string Spec => HookJson.RequiredString(Json, "spec", null);

    /// <summary>The context's <c>sequence</c> (§4.1).</summary>
    public long Sequence => HookJson.Sequence(Json);

    /// <summary><c>agent.id</c>.</summary>
    public string AgentId => HookJson.RequiredString(HookJson.RequiredObject(Json, "agent", null), "id", "agent");

    /// <summary><c>session.id</c>.</summary>
    public string SessionId => HookJson.RequiredString(HookJson.RequiredObject(Json, "session", null), "id", "session");

    /// <summary>The optional <c>tenant</c> block (§4.5), or <c>null</c>
    /// when the context carries none.</summary>
    public JsonObject? Tenant => Json["tenant"] as JsonObject;

    /// <summary>The <c>tool_call</c> member.</summary>
    public ToolCall ToolCall => new(HookJson.RequiredObject(Json, "tool_call", null));

    /// <summary>The <c>tool_result</c> member.</summary>
    public ToolResult ToolResult => new(HookJson.RequiredObject(Json, "tool_result", null));

    /// <summary>A <see cref="Decision.Transform"/> verdict replacing the
    /// whole of <c>tool_result.value</c> with <paramref name="value"/>
    /// (§5.2): path <c>$target</c>, since the <c>post_tool_call</c> target
    /// is <c>tool_result.value</c> (§3). <c>null</c> replaces it with JSON
    /// null. The value is a detached copy, so the verdict never aliases
    /// the live context.</summary>
    public static Verdict TransformValue(JsonNode? value) =>
        new(Decision.Transform, Transform: new Transform(HookJson.TargetRoot, value?.DeepClone()));

    /// <summary>A request for a unit test, built with
    /// <see cref="AgentContextBuilder.PostToolCall"/> under
    /// <paramref name="spec"/>. <paramref name="tenant"/>, when given, is
    /// attached as the context's <c>tenant</c> block.</summary>
    public static PostToolCallRequest ForTest(
        string name,
        JsonObject args,
        JsonNode? value,
        bool isError = false,
        double? durationMs = null,
        string spec = AgentHooks.Spec.V01,
        string callId = "call-1",
        string agentId = "test-agent",
        string sessionId = "test-session",
        JsonObject? tenant = null)
    {
        var builder = HookJson.TestBuilder(spec, agentId, sessionId, tenant);
        return new PostToolCallRequest(builder.PostToolCall(callId, name, args, value, isError, durationMs));
    }
}

/// <summary>A hook that runs at <c>pre_tool_call</c> only (§3). Register it
/// with <see cref="HookRegistration.RegisterHook(InterceptionEmitter, IPreToolCallHook, string?, OnError)"/>.
/// The returned verdict crosses the same §5 gate as any interceptor's.</summary>
public interface IPreToolCallHook
{
    ValueTask<Verdict> OnPreToolCallAsync(PreToolCallRequest request, CancellationToken ct);
}

/// <summary>A hook that runs at <c>post_tool_call</c> only (§3). Register it
/// with <see cref="HookRegistration.RegisterHook(InterceptionEmitter, IPostToolCallHook, string?, OnError)"/>.
/// The returned verdict crosses the same §5 gate as any interceptor's.</summary>
public interface IPostToolCallHook
{
    ValueTask<Verdict> OnPostToolCallAsync(PostToolCallRequest request, CancellationToken ct);
}

/// <summary>Runs an <see cref="IPreToolCallHook"/> as an interceptor. A
/// context at another point is refused by the view's constructor, which
/// the emitter records as <c>host_error:interceptor_failed</c>.</summary>
internal sealed class PreToolCallHookInterceptor(IPreToolCallHook hook) : IInterceptor
{
    public ValueTask<Verdict> InterceptAsync(AgentContext context, CancellationToken ct = default) =>
        hook.OnPreToolCallAsync(new PreToolCallRequest(context), ct);
}

/// <summary>Runs an <see cref="IPostToolCallHook"/> as an interceptor.</summary>
internal sealed class PostToolCallHookInterceptor(IPostToolCallHook hook) : IInterceptor
{
    public ValueTask<Verdict> InterceptAsync(AgentContext context, CancellationToken ct = default) =>
        hook.OnPostToolCallAsync(new PostToolCallRequest(context), ct);
}

internal sealed class DelegatePreToolCallHook(
    Func<PreToolCallRequest, CancellationToken, ValueTask<Verdict>> f) : IPreToolCallHook
{
    public ValueTask<Verdict> OnPreToolCallAsync(PreToolCallRequest request, CancellationToken ct) =>
        f(request, ct);
}

internal sealed class DelegatePostToolCallHook(
    Func<PostToolCallRequest, CancellationToken, ValueTask<Verdict>> f) : IPostToolCallHook
{
    public ValueTask<Verdict> OnPostToolCallAsync(PostToolCallRequest request, CancellationToken ct) =>
        f(request, ct);
}

/// <summary>Shared accessors of the typed views.</summary>
internal static class HookJson
{
    /// <summary>The whole-target root of the §5.2 path grammar.</summary>
    public const string TargetRoot = "$target";

    public static JsonObject RequirePoint(AgentContext context, InterceptionPoint point, string paramName)
    {
        var json = context.Json ?? throw new ArgumentNullException(paramName);
        var actual = (json["interception_point"] as JsonValue)?.TryGetValue(out string? s) == true ? s : null;
        if (actual != point.ToWireName())
        {
            throw new ArgumentException(
                $"a {(point == InterceptionPoint.PreToolCall ? nameof(PreToolCallRequest) : nameof(PostToolCallRequest))} " +
                $"needs a {point.ToWireName()} context; got interception_point {(actual is null ? "<missing>" : $"\"{actual}\"")}",
                paramName);
        }
        return json;
    }

    public static InvalidOperationException Missing(string? parent, string member) =>
        new($"context member {(parent is null ? member : parent + "." + member)} is missing or has the wrong type (§4)");

    public static string RequiredString(JsonObject o, string member, string? parent) =>
        (o[member] as JsonValue)?.TryGetValue(out string? s) == true ? s : throw Missing(parent, member);

    public static JsonObject RequiredObject(JsonObject o, string member, string? parent) =>
        o[member] as JsonObject ?? throw Missing(parent, member);

    /// <summary><c>sequence</c> without assuming how the node is backed: a
    /// builder stores an <c>int</c>, a parsed context a
    /// <see cref="JsonElement"/>.</summary>
    public static long Sequence(JsonObject o)
    {
        if (o["sequence"] is JsonValue v)
        {
            if (v.TryGetValue(out long l)) return l;
            if (v.TryGetValue(out int i)) return i;
            if (v.TryGetValue(out JsonElement e) && e.ValueKind == JsonValueKind.Number && e.TryGetInt64(out l)) return l;
        }
        throw Missing(null, "sequence");
    }

    /// <summary>A numeric member as a double, whatever backs the node;
    /// <c>null</c> when absent or not a number.</summary>
    public static double? Number(JsonObject o, string member)
    {
        if (o[member] is not JsonValue v) return null;
        if (v.TryGetValue(out double d)) return d;
        if (v.TryGetValue(out long l)) return l;
        if (v.TryGetValue(out int i)) return i;
        if (v.TryGetValue(out JsonElement e) && e.ValueKind == JsonValueKind.Number) return e.GetDouble();
        return null;
    }

    public static AgentContextBuilder TestBuilder(string spec, string agentId, string sessionId, JsonObject? tenant) =>
        new AgentContextBuilder(spec, agentId, "test", sessionId).WithL2("tenant", tenant);
}
