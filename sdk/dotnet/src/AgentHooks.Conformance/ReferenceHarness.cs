// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Reference in-memory conformant host. Self-test target for the CTK.
// Port of sdk/python/python/agent_hooks/ctk/reference.py.

using System.Text.Json.Nodes;

namespace AgentHooks.Conformance;

public sealed class ReferenceHarness : IHarness
{
    public string Name => "reference-agent";
    public IReadOnlySet<Capability> Capabilities { get; } =
        new HashSet<Capability>
        {
            Capability.ModelCalls, Capability.ToolCalls, Capability.Int64Json,
            // JsonNode preserves raw numeric tokens: beyond-u64 literals
            // survive vector loading and emission byte-faithfully.
            Capability.BigintJson,
        };

    private Scenario? _scenario;
    private InterceptionEmitter? _emitter;
    private AgentContextBuilder? _builder;
    private readonly List<JsonObject> _toolLog = [];

    public void Setup(
        Scenario scenario, IReadOnlyList<IInterceptor> interceptors,
        IApprovalResolver? resolver, EnforcementMode mode,
        CompositionConfig composition, string? identityProvider,
        IReadOnlyList<string>? redactForApproval = null)
    {
        _scenario = scenario;
        _toolLog.Clear();
        var em = new InterceptionEmitter(mode, resolver);
        em.SetComposition(composition);
        // §13.2: "ctk-fault" is a custom provider that throws, pinning
        // the §10.1 provider-failure rule (deny context_invalid
        // pre-dispatch).
        em.SetIdentityProvider(identityProvider switch
        {
            null => IdentityProvider.Null,
            "ctk-fault" => IdentityProvider.Custom(
                "ctk-fault", _ => throw new InvalidOperationException("ctk scripted provider fault")),
            _ => IdentityProvider.JcsSha256,
        });
        if (redactForApproval is { Count: > 0 })
        {
            // §9 redaction seam, CTK convention: each listed path is
            // replaced with "[redacted]" via the §5.2/§4.3 transform
            // machinery; unresolvable paths are left untouched.
            var paths = redactForApproval.ToList();
            em.SetApprovalRedactor(ctx =>
            {
                var current = ctx;
                foreach (var path in paths)
                {
                    try
                    {
                        current = new AgentContext(
                            Canonical.ApplyTransformCtx(current, path, "[redacted]"));
                    }
                    catch (AgentHooksCoreException)
                    {
                        // unresolvable at this point — skip
                    }
                }
                return current;
            });
        }
        foreach (var i in interceptors) em.Register(i);
        _emitter = em;
        _builder = new AgentContextBuilder(
            agentId: "ref-agent",
            framework: "reference-agent",
            sessionId: Guid.NewGuid().ToString());
    }

    public async Task<RunRecord> RunAsync(CancellationToken ct = default)
    {
        var s = _scenario!; var em = _emitter!; var b = _builder!;
        var outcome = RunOutcome.Completed;
        JsonNode? final = null;
        try
        {
            await em.EmitAsync(
                b.AgentStartup(s.Tools.Keys.OrderBy(k => k)), ct);
            await em.EmitAsync(
                b.Input(s.Input["content"]?.DeepClone(), (string)s.Input["role"]!), ct);

            var messages = new JsonArray(new JsonObject
            {
                ["role"] = (string)s.Input["role"]!,
                ["content"] = s.Input["content"]?.DeepClone(),
            });

            foreach (var resp in s.ModelScript)
            {
                var pre = b.PreModelCall("mock", (JsonArray)messages.DeepClone());
                await em.EmitAsync(pre, ct);
                messages = (JsonArray)pre.Json["messages"]!.DeepClone(); // may be transformed

                await em.EmitAsync(
                    b.PostModelCall("mock", resp.Content?.DeepClone(),
                        (JsonArray)resp.ToolCalls.DeepClone(), resp.FinishReason), ct);

                if (resp.ToolCalls.Count > 0)
                {
                    foreach (var tc in resp.ToolCalls.Cast<JsonObject>())
                    {
                        try
                        {
                            await DoToolCallAsync(tc, messages, ct);
                        }
                        catch (InterceptionBlockedException e)
                        {
                            messages.Add(new JsonObject
                            {
                                ["role"] = "tool",
                                ["content"] = $"blocked: {e.Result.Verdict.Reason}",
                            });
                        }
                    }
                    messages.Add(new JsonObject
                    {
                        ["role"] = "assistant",
                        ["content"] = resp.Content?.DeepClone() ?? "",
                    });
                }
                else
                {
                    final = resp.Content?.DeepClone();
                    break;
                }
            }

            if (final is not null)
            {
                var outCtx = b.Output(final);
                await em.EmitAsync(outCtx, ct);
                final = outCtx.Json["output"]?["content"]?.DeepClone();
            }
        }
        catch (InterceptionBlockedException)
        {
            outcome = RunOutcome.Blocked;
            final = null;
        }

        await em.EmitUncheckedAsync(
            b.AgentShutdown(outcome == RunOutcome.Completed ? "completed" : "error"), ct);

        return new RunRecord(
            outcome,
            final,
            _toolLog.Select(t => (JsonObject)t.DeepClone()).ToList(),
            Identities: em.Records
                .Select(r => (r.InputIdentity, r.EnforcedIdentity))
                .ToList(),
            Records: em.Records.Select(r => r.ToWire()).ToList());
    }

    public void Teardown()
    {
        _scenario = null; _emitter = null; _builder = null;
    }

    private async Task DoToolCallAsync(JsonObject tc, JsonArray messages, CancellationToken ct)
    {
        var s = _scenario!; var em = _emitter!; var b = _builder!;
        var callId = (string)tc["id"]!;
        var name = (string)tc["name"]!;
        var args = (JsonObject)tc["args"]!.DeepClone();

        var pre = b.PreToolCall(callId, name, args);
        await em.EmitAsync(pre, ct);
        var postArgs = (JsonObject)pre.Json["tool_call"]!["args"]!.DeepClone(); // post-transform

        var (value, isError) = s.Tools[name].Invoke(postArgs);
        _toolLog.Add(new JsonObject
        {
            ["name"] = name,
            ["args"] = postArgs.DeepClone(),
        });

        await em.EmitAsync(
            b.PostToolCall(callId, name, (JsonObject)postArgs.DeepClone(),
                value, isError), ct);

        messages.Add(new JsonObject
        {
            ["role"] = "tool",
            ["content"] = value?.DeepClone(),
        });
    }
}
