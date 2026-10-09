// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Reference in-memory conformant host. Self-test target for the CTK.
// Port of sdk/rust/core/src/ctk.rs ReferenceHarness.
//
// Every emitter it builds goes through the host declaration loader
// (§7.7): for a field-based vector it writes the vector's mode,
// composition and provider into a copy of its own document
// (reference.declaration.json, embedded) and binds the scripted
// interceptors through a `ctk.instance` kind, so the field-based
// vectors exercise the loader too.

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
            // Every emitter is built through the loader.
            Capability.HostDeclaration,
        };

    private Scenario? _scenario;
    private InterceptionEmitter? _emitter;
    private AgentContextBuilder? _builder;
    private readonly List<JsonObject> _toolLog = [];

    public HostSurface HostSurface => HostSurface.FromCapabilities(
        Capabilities.Select(c => c.ToWireName()), ToolSeamPosture.Continue);

    /// <summary>The reference harness's own declaration (§7.7.9), with
    /// an explicit surface a claim can cite.</summary>
    public JsonObject? Declaration => Document();

    /// <summary>The embedded <c>reference.declaration.json</c>.</summary>
    public static JsonObject Document()
    {
        using var stream = typeof(ReferenceHarness).Assembly
            .GetManifestResourceStream("reference.declaration.json")
            ?? throw new InvalidOperationException("reference.declaration.json is not embedded");
        return (JsonObject)JsonNode.Parse(stream)!;
    }

    public void Setup(
        Scenario scenario, IReadOnlyList<IInterceptor> interceptors,
        IApprovalResolver? resolver, EnforcementMode mode,
        CompositionConfig composition, string? identityProvider,
        IReadOnlyList<string>? redactForApproval = null)
    {
        // Field-based vector: write the vector's configuration into a
        // copy of the reference document and bind the interceptors by
        // index through the `ctk.instance` kind.
        var doc = Document();
        var cfg = (JsonObject)doc["configuration"]!;
        cfg["mode"] = mode == EnforcementMode.EvaluateOnly ? "evaluate_only" : "enforce";
        cfg["composition"] = composition.ToWire();
        var registry = HostRegistry.ForConformance(HostSurface);
        switch (identityProvider)
        {
            case null:
                cfg["identity_provider"] = null;
                break;
            case "ctk-fault":
                // §13.2: "ctk-fault" is a custom provider that throws,
                // pinning the §10.1 provider-failure rule (deny
                // context_invalid pre-dispatch).
                registry.IdentityProvider(
                    "ctk-fault", _ => throw new InvalidOperationException("ctk scripted provider fault"));
                cfg["identity_provider"] = "ctk-fault";
                break;
            default:
                cfg["identity_provider"] = Spec.JcsSha256;
                break;
        }
        var approval = new JsonObject();
        if (resolver is not null)
        {
            registry.ApprovalResolver("ctk-scripted", resolver);
            approval["resolver"] = "ctk-scripted";
        }
        else
        {
            approval["resolver"] = null;
        }
        if (redactForApproval is { Count: > 0 })
        {
            registry.ApprovalRedactor("ctk-redact", Redactor(redactForApproval.ToList()));
            approval["redactor"] = "ctk-redact";
        }
        else
        {
            approval["redactor"] = null;
        }
        cfg["approval"] = approval;

        var slots = interceptors.Select(i => (IInterceptor?)i).ToArray();
        registry.Kind("ctk.instance", (config, ctx) =>
        {
            if (config?["index"] is not JsonValue v || !v.TryGetValue(out long index) || index < 0)
                throw new InvalidOperationException("config.index must be an unsigned integer");
            if (index >= slots.Length || slots[index] is not { } instance)
                throw new InvalidOperationException(
                    $"no interceptor instance {index} for binding {ctx.Id}");
            slots[index] = null;
            return instance;
        });
        var bindings = new JsonArray();
        for (var i = 0; i < slots.Length; i++)
        {
            bindings.Add(new JsonObject
            {
                ["id"] = $"interceptor-{i}",
                ["kind"] = "ctk.instance",
                ["config"] = new JsonObject { ["index"] = i },
            });
        }
        doc["bindings"] = bindings;

        InterceptionEmitter emitter;
        try
        {
            emitter = InterceptionEmitter.FromDeclarationNode(doc, registry);
        }
        catch (DeclarationException e)
        {
            throw new InvalidOperationException($"reference declaration refused: {e.Message}", e);
        }
        StartSession(scenario, emitter);
    }

    public void SetupDeclared(Scenario scenario, JsonObject document, HostRegistry registry) =>
        StartSession(scenario, InterceptionEmitter.FromDeclarationNode(document, registry));

    private void StartSession(Scenario scenario, InterceptionEmitter emitter)
    {
        _scenario = scenario;
        _toolLog.Clear();
        _emitter = emitter;
        _builder = new AgentContextBuilder(
            agentId: "ref-agent",
            framework: "reference-agent",
            sessionId: Guid.NewGuid().ToString());
    }

    /// <summary>§9 redaction seam, CTK convention: each listed path is
    /// replaced with "[redacted]" via the §5.2/§4.3 transform machinery;
    /// unresolvable paths are left untouched.</summary>
    internal static Func<AgentContext, AgentContext> Redactor(IReadOnlyList<string> paths) => ctx =>
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
                // unresolvable at this point, skip
            }
        }
        return current;
    };

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
