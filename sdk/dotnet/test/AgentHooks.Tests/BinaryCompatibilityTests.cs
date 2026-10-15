// Copyright (c) Microsoft. All rights reserved.

// Binary-compatibility probes. An assembly compiled against a
// published release binds to each method by its exact parameter list,
// so the signatures 0.1.0-alpha.5 shipped must keep resolving by that
// list even though newer overloads exist. These tests look the old
// shapes up through reflection, the way the runtime does, and invoke
// them. The full surface is pinned in PublicApiTests.cs.

using System.Reflection;
using System.Text.Json.Nodes;
using AgentHooks;
using Xunit;

namespace AgentHooks.Tests;

public sealed class BinaryCompatibilityTests
{
    private sealed class Scripted(Verdict verdict) : IInterceptor
    {
        public ValueTask<Verdict> InterceptAsync(
            AgentContext ctx, CancellationToken ct = default) =>
            ValueTask.FromResult(verdict);
    }

    private static readonly AgentContextBuilder Builder = new("a", "x", "s");

    private static IEnumerable<AgentContext> EveryToolPoint()
    {
        var args = new JsonObject { ["n"] = 1 };
        yield return Builder.PreToolCall("tc", "t", args);
        yield return Builder.PostToolCall("tc", "t", args, JsonValue.Create(1));
    }

    // 0.1.0-alpha.5: Register(IInterceptor interceptor, string? name = null).
    // The default does not take part in binding; the parameter types do.
    private static readonly Type[] RegisterAlpha5 = [typeof(IInterceptor), typeof(string)];

    [Fact]
    public async Task RegisterResolvesByTheAlpha5ParameterListAndBindsAtEveryPoint()
    {
        var method = typeof(InterceptionEmitter).GetMethod(
            "Register", BindingFlags.Public | BindingFlags.Instance, RegisterAlpha5);
        Assert.NotNull(method);
        Assert.Equal(typeof(InterceptionEmitter), method.ReturnType);

        var emitter = new InterceptionEmitter(EnforcementMode.Enforce);
        var returned = method.Invoke(emitter, [new Scripted(Verdict.Allow), "alpha5"]);
        Assert.Same(emitter, returned);

        // The two-argument form means "every point", as it did in alpha.5.
        foreach (var ctx in EveryToolPoint())
        {
            var record = await emitter.EmitUncheckedAsync(ctx);
            Assert.True(record.Proceeds);
            Assert.Equal(1, record.InterceptorsRegistered);
            Assert.Equal("alpha5", Assert.Single(record.Verdicts).Name);
        }
    }

    [Fact]
    public void RegisterStillResolvesByTheThreeArgumentParameterList()
    {
        var method = typeof(InterceptionEmitter).GetMethod(
            "Register", BindingFlags.Public | BindingFlags.Instance,
            [typeof(IInterceptor), typeof(string), typeof(IReadOnlySet<InterceptionPoint>)]);
        Assert.NotNull(method);
    }

    // 0.1.0-alpha.5: the sixteen-component primary constructor, before
    // Declaration was added as a seventeenth component.
    private static readonly Type[] RecordAlpha5 =
    [
        typeof(InterceptionPoint), typeof(EnforcementMode), typeof(Verdict),
        typeof(string), typeof(string), typeof(string), typeof(string), typeof(long),
        typeof(int?), typeof(CompositionConfig), typeof(IReadOnlyList<VerdictSummary>),
        typeof(bool?), typeof(string), typeof(int), typeof(string), typeof(TraceContext),
    ];

    [Fact]
    public void InterceptionRecordResolvesByTheAlpha5ConstructorAndDeconstruct()
    {
        var ctor = typeof(InterceptionRecord).GetConstructor(RecordAlpha5);
        Assert.NotNull(ctor);
        var record = (InterceptionRecord)ctor.Invoke(
        [
            InterceptionPoint.PreToolCall, EnforcementMode.Enforce, Verdict.Allow,
            null, null, null, "s", 0L, null, CompositionConfig.Default,
            Array.Empty<VerdictSummary>(), null, null, 1, "2026-01-01T00:00:00Z", null,
        ]);
        Assert.Null(record.Declaration);
        Assert.Equal("s", record.SessionId);
        Assert.Equal(1, record.InterceptorsRegistered);
        Assert.False(record.ToWire().ContainsKey("declaration"));

        var deconstruct = typeof(InterceptionRecord).GetMethod(
            "Deconstruct", BindingFlags.Public | BindingFlags.Instance,
            RecordAlpha5.Select(t => t.MakeByRefType()).ToArray());
        Assert.NotNull(deconstruct);
        var slots = new object?[RecordAlpha5.Length];
        deconstruct.Invoke(record, slots);
        Assert.Equal(InterceptionPoint.PreToolCall, slots[0]);
        Assert.Equal("s", slots[6]);
        Assert.Equal("2026-01-01T00:00:00Z", slots[14]);
    }
}
