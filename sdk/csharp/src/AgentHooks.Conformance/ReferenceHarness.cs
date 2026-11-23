// Copyright (c) Microsoft. All rights reserved.

using System.Globalization;
using System.Text.Json.Nodes;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks.Conformance;

/// <summary>An in-memory conformant host driving a scripted agent loop; the CTK self-test target.</summary>
public sealed class ReferenceHarness : IHarness
{
    public string Name => "reference-agent";

    public HostSurface Surface { get; } = new(new HashSet<Draft.Capability>
    {
        Draft.Capability.ModelCalls, Draft.Capability.ToolCalls, Draft.Capability.Int64Json,
        Draft.Capability.BigintJson, Draft.Capability.HostDeclaration,
    });

    public async Task<RunRecord> RunAsync(Scenario scenario, HookEmitter emitter, CancellationToken cancellationToken = default)
    {
        var requests = new RequestFactory("ref-agent", "reference-agent", Guid.NewGuid().ToString());
        var tools = new List<JsonObject>();
        async Task<EmitResult> Emit(Draft.InterceptionPoint point, JsonObject body) =>
            await emitter.EmitAsync(requests.Create(point, body), cancellationToken);
        static Exception Blocked() => new BlockedException();

        var outcome = RunOutcome.Completed;
        JsonNode? final = null;
        try
        {
            var registered = new JsonArray(scenario.Tools.Keys.Order(StringComparer.Ordinal).Select(k => (JsonNode)k).ToArray());
            if (!(await Emit(Draft.InterceptionPoint.AgentStartup, new() { ["agent_init"] = new JsonObject { ["tools_registered"] = registered } })).Proceeds)
                throw Blocked();
            var input = scenario.Input;
            if (!(await Emit(Draft.InterceptionPoint.Input, new() { ["input"] = input.DeepClone() })).Proceeds)
                throw Blocked();

            var messages = new JsonArray(new JsonObject { ["role"] = input["role"]?.DeepClone(), ["content"] = input["content"]?.DeepClone() });
            foreach (var response in scenario.ModelScript)
            {
                var model = new JsonObject { ["id"] = "mock" };
                var pre = await Emit(Draft.InterceptionPoint.PreModelCall, new() { ["model"] = model.DeepClone(), ["messages"] = messages.DeepClone() });
                if (!pre.Proceeds) throw Blocked();
                messages = pre.Request["messages"]!.DeepClone().AsArray();

                var post = await Emit(Draft.InterceptionPoint.PostModelCall, new()
                {
                    ["model"] = model,
                    ["response"] = new JsonObject
                    {
                        ["content"] = response.Content?.DeepClone(),
                        ["tool_calls"] = response.ToolCalls.DeepClone(),
                        ["finish_reason"] = response.FinishReason,
                    },
                });
                if (!post.Proceeds) throw Blocked();
                if (response.ToolCalls.Count == 0)
                {
                    final = response.Content?.DeepClone();
                    break;
                }
                foreach (var call in response.ToolCalls.Select(c => c!.AsObject()))
                {
                    var result = await CallToolAsync(call);
                    messages.Add(new JsonObject { ["role"] = "tool", ["content"] = result });
                }
                messages.Add(new JsonObject { ["role"] = "assistant", ["content"] = response.Content?.DeepClone() ?? "" });
            }

            if (final is not null)
            {
                var output = await Emit(Draft.InterceptionPoint.Output, new() { ["output"] = new JsonObject { ["content"] = final } });
                if (!output.Proceeds) throw Blocked();
                final = output.Request["output"]?["content"]?.DeepClone();
            }
        }
        catch (BlockedException)
        {
            outcome = RunOutcome.Blocked;
            final = null;
        }

        // The run is over either way: shutdown is reported, not guarded.
        await Emit(Draft.InterceptionPoint.AgentShutdown, new()
        {
            ["summary"] = new JsonObject { ["reason"] = outcome == RunOutcome.Completed ? "completed" : "error" },
        });
        return new(outcome, final, tools);

        // A denied tool seam is reported to the model and the loop continues (tool_seam_host_error: continue).
        async Task<JsonNode?> CallToolAsync(JsonObject call)
        {
            var name = (string)call["name"]!;
            var identity = new JsonObject { ["id"] = call["id"]!.DeepClone(), ["name"] = name };
            var toolCall = (JsonObject)identity.DeepClone();
            toolCall["args"] = call["args"]!.DeepClone();
            var pre = await Emit(Draft.InterceptionPoint.PreToolCall, new() { ["tool_call"] = toolCall });
            if (!pre.Proceeds) return $"blocked: {pre.Verdict["reason"]}";

            var args = pre.Request["tool_call"]!["args"]!.DeepClone().AsObject();
            var (value, isError) = scenario.Tools[name].Invoke(args);
            tools.Add(new JsonObject { ["name"] = name, ["args"] = args.DeepClone() });

            var executed = (JsonObject)identity.DeepClone();
            executed["args"] = args;
            var post = await Emit(Draft.InterceptionPoint.PostToolCall, new()
            {
                ["tool_call"] = executed,
                ["tool_result"] = new JsonObject { ["value"] = value?.DeepClone(), ["is_error"] = isError },
            });
            return post.Proceeds ? post.Request["tool_result"]!["value"]?.DeepClone() : $"blocked: {post.Verdict["reason"]}";
        }
    }

    private sealed class BlockedException : Exception;

    /// <summary>Stamps the §4 envelope (spec, point, timestamp, sequence, agent, session) onto per-point members.</summary>
    private sealed class RequestFactory(string agentId, string framework, string sessionId)
    {
        private long _sequence = -1;

        public JsonObject Create(Draft.InterceptionPoint point, JsonObject members)
        {
            var request = new JsonObject
            {
                ["spec"] = "agent-hooks/draft",
                ["interception_point"] = point.ToWire(),
                ["timestamp"] = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.ffffffZ", CultureInfo.InvariantCulture),
                ["sequence"] = Interlocked.Increment(ref _sequence),
                ["agent"] = new JsonObject { ["id"] = agentId, ["framework"] = framework },
                ["session"] = new JsonObject { ["id"] = sessionId },
            };
            foreach (var (key, value) in members.ToList())
            {
                members.Remove(key);
                request[key] = value;
            }
            return request;
        }
    }
}
