// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Host declaration tests (§7.7): the three construction paths, the
// refusal classes a vector cannot express, sealing, per-point bindings,
// the record stamp, the registry rules and the cross-SDK golden file.

using System.Text;
using System.Text.Json.Nodes;
using AgentHooks;
using AgentHooks.Conformance;
using Xunit;

namespace AgentHooks.Tests;

public sealed class DeclarationTests
{
    private static readonly InterceptionPoint[] AllPoints = Enum.GetValues<InterceptionPoint>();

    private static string RepoRoot()
    {
        var here = Path.GetDirectoryName(typeof(DeclarationTests).Assembly.Location)!;
        return Path.GetFullPath(Path.Combine(here, "..", "..", "..", "..", "..", "..", ".."));
    }

    private sealed class Scripted(Verdict verdict) : IInterceptor
    {
        public int Calls;

        public ValueTask<Verdict> InterceptAsync(AgentContext ctx, CancellationToken ct = default)
        {
            Calls++;
            return ValueTask.FromResult(verdict);
        }
    }

    /// <summary>Ignores the cancellation token on purpose: the §7 bound
    /// must hold against a callee that does not cooperate.</summary>
    private sealed class Slow(TimeSpan delay) : IInterceptor
    {
        public async ValueTask<Verdict> InterceptAsync(AgentContext ctx, CancellationToken ct = default)
        {
            await Task.Delay(delay, CancellationToken.None);
            return Verdict.Allow;
        }
    }

    private sealed class SlowApprover(TimeSpan delay) : IApprovalResolver
    {
        public async ValueTask<ApprovalResolution> ResolveAsync(ApprovalRequest req, CancellationToken ct = default)
        {
            await Task.Delay(delay, CancellationToken.None);
            return new ApprovalResolution(ApprovalOutcome.Approve, req.ContextIdentity, Verdict.Allow);
        }
    }

    private static HostSurface FullSurface() =>
        HostSurface.SdkDefault()
            .WithPoints(AllPoints)
            .WithCapabilities("model_calls", "tool_calls", "int64_json", "bigint_json");

    /// <summary>A registry over the full surface with the kinds the
    /// tests bind: <c>com.example.allow</c>, <c>com.example.deny</c>,
    /// <c>com.example.rewrite</c>, <c>com.example.throws</c> (its
    /// message names nothing from the config) and <c>com.example.none</c>
    /// (returns null).</summary>
    private static HostRegistry Registry(HostSurface? surface = null) =>
        new HostRegistry(surface ?? FullSurface())
            .Kind("com.example.allow", (_, _) => new Scripted(Verdict.Allow))
            .Kind("com.example.deny", (_, _) => new Scripted(Verdict.Deny("ctk:dangerous_tool")))
            .Kind("com.example.rewrite", (_, _) => new Scripted(
                new Verdict(Decision.Transform, Transform: new Transform("$target.url", "https://safe"))))
            .Kind("com.example.throws", (_, _) => throw new InvalidOperationException("config not understood"))
            .Kind("com.example.none", (_, _) => null!);

    private static AgentContext Ctx(string point = "pre_tool_call", long sequence = 0)
    {
        var o = (JsonObject)JsonNode.Parse($$"""
            {
              "spec": "agent-hooks/0.1",
              "interception_point": "{{point}}",
              "timestamp": "2026-01-01T00:00:00Z",
              "sequence": {{sequence}},
              "agent": {"id": "a", "framework": "test"},
              "session": {"id": "s"},
              "target": {"url": "https://x"}
            }
            """)!;
        if (point == "pre_tool_call")
            o["tool_call"] = new JsonObject
            {
                ["id"] = "tc-1",
                ["name"] = "http_get",
                ["args"] = new JsonObject { ["url"] = "https://x" },
            };
        else if (point == "input")
            o["input"] = new JsonObject { ["content"] = "hi", ["role"] = "user" };
        else if (point == "agent_startup")
            o["agent_init"] = new JsonObject { ["tools_registered"] = new JsonArray() };
        return new AgentContext(o);
    }

    private static string Minimal(string kind = "com.example.allow") => $$"""
        {"declaration": "agent-hooks-declaration/1.0",
         "bindings": [{"id": "allow", "kind": "{{kind}}"}]}
        """;

    // ---- versions and inventory ---------------------------------------------

    [Fact]
    public void VersionConstantsMatchTheCore()
    {
        var core = (JsonObject)JsonNode.Parse(Native.DeclarationVersions())!;
        Assert.Equal(Declaration.Version, (string)core["current"]!);
        Assert.Equal(
            Declaration.SupportedVersions,
            ((JsonArray)core["supported"]!).Select(n => (string)n!).ToList());
        Assert.NotEqual(Spec.Version, Declaration.Version);
    }

    [Fact]
    public void ErrorClassesMatchTheInventory()
    {
        var inventory = JsonNode.Parse(File.ReadAllText(
            Path.Combine(RepoRoot(), "spec", "declaration-errors.json")))!;
        var ids = ((JsonArray)inventory["classes"]!).Select(c => (string)c!["id"]!).ToList();
        var codes = Enum.GetValues<DeclarationErrorClass>().Select(c => c.ToCode()).ToList();
        Assert.Equal(ids, codes);
        foreach (var code in codes)
            Assert.Equal(code, DeclarationErrorClassExtensions.FromCode(code)!.Value.ToCode());
    }

    [Fact]
    public void CapabilityWireNamesAreTheClosedList()
    {
        var names = Enum.GetValues<Capability>().Select(c => c.ToWireName()).ToHashSet();
        Assert.True(names.SetEquals(Declaration.Capabilities));
    }

    // ---- loading and records -------------------------------------------------

    [Fact]
    public async Task MinimalDocumentLoadsAndStampsRecords()
    {
        var em = InterceptionEmitter.FromDeclarationJson(Minimal(), Registry());
        Assert.NotNull(em.Declaration);
        Assert.Equal(Declaration.Version, em.Declaration!.Version);
        Assert.Equal(CompositionConfig.Default, em.Declaration.Composition);
        Assert.Equal(5000, em.Declaration.InterceptorTimeoutMs);
        Assert.Equal(5000, em.Declaration.ApprovalResolverTimeoutMs);
        Assert.Equal(AllPoints.Length, em.Declaration.Bindings[0].At.Count);

        var r = await em.EmitUncheckedAsync(Ctx());
        Assert.True(r.Proceeds);
        Assert.Equal(Declaration.Version, r.Declaration);
        Assert.Equal(CompositionProfile.SequentialFirstDeny, r.Composition.Profile);
        Assert.Equal(OnApproval.Stop, r.Composition.OnApproval);
        Assert.Equal("jcs-sha256", r.IdentityProvider);
        Assert.Equal(1, r.InterceptorsRegistered);
        Assert.Equal("allow", r.Verdicts[0].Name);
        Assert.Equal(Declaration.Version, (string?)r.ToWire()["declaration"]);
    }

    [Fact]
    public async Task CodePathRecordsCarryNoDeclaration()
    {
        var em = new InterceptionEmitter();
        em.Register(new Scripted(Verdict.Allow));
        Assert.Null(em.Declaration);
        var r = await em.EmitUncheckedAsync(Ctx());
        Assert.Null(r.Declaration);
        Assert.False(r.ToWire().ContainsKey("declaration"));
        var failure = em.RecordHostFailure(InterceptionPoint.Output);
        Assert.Null(failure.Declaration);
    }

    [Fact]
    public void HostFailureRecordStampsTheDeclaration()
    {
        var em = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.0",
             "bindings": [{"id": "a", "kind": "com.example.allow", "at": ["pre_tool_call"]},
                          {"id": "b", "kind": "com.example.allow"}]}
            """, Registry());
        var r = em.RecordHostFailure(InterceptionPoint.PreToolCall, detail: "InvalidOperationException");
        Assert.Equal(Declaration.Version, r.Declaration);
        Assert.Equal(2, r.InterceptorsRegistered);
        Assert.Equal(1, em.RecordHostFailure(InterceptionPoint.Output).InterceptorsRegistered);
    }

    [Fact]
    public async Task ThreePathsYieldTheSameEmitterAndRecords()
    {
        var doc = (JsonObject)JsonNode.Parse("""
            {
              "declaration": "agent-hooks-declaration/1.0",
              "configuration": {
                "composition": {"profile": "parallel/strictest"},
                "timeouts": {"interceptor_ms": 4000}
              },
              "bindings": [
                {"id": "audit", "kind": "com.example.allow", "config": {"sink": "stdout"}, "timeout_ms": 2000},
                {"id": "rewrite", "kind": "com.example.rewrite", "at": ["pre_tool_call", "output"]}
              ]
            }
            """)!;
        var path = Path.GetTempFileName();
        try
        {
            File.WriteAllText(path, doc.ToJsonString());
            var builder = HostDeclaration.Builder()
                .Composition(new CompositionConfig(CompositionProfile.ParallelStrictest))
                .InterceptorTimeoutMs(4000)
                .Bind("audit", "com.example.allow", new JsonObject { ["sink"] = "stdout" }, timeoutMs: 2000)
                .Bind("rewrite", "com.example.rewrite", at: [InterceptionPoint.PreToolCall, InterceptionPoint.Output]);
            var emitters = new[]
            {
                InterceptionEmitter.FromDeclarationNode(doc, Registry()),
                InterceptionEmitter.FromDeclarationJson(doc.ToJsonString(), Registry()),
                InterceptionEmitter.FromDeclarationPath(path, Registry()),
                InterceptionEmitter.FromDeclaration(builder.Build(), Registry()),
            };
            var canonical = emitters.Select(e => e.Declaration!.CanonicalJson()).Distinct().ToList();
            Assert.Single(canonical);
            Assert.Contains("\"on_transform_conflict\":\"deny\"", canonical[0]);
            Assert.Contains("\"timeout_ms\":4000", canonical[0]);
            Assert.Contains("\"timeout_ms\":2000", canonical[0]);

            var records = new List<string>();
            foreach (var em in emitters)
            {
                var wire = new List<string>();
                foreach (var (point, seq) in new[] { ("input", 0L), ("pre_tool_call", 1L), ("output", 2L) })
                    wire.Add((await em.EmitUncheckedAsync(Ctx(point, seq))).ToWire().ToJsonString());
                records.Add(string.Join("\n", wire));
            }
            Assert.Single(records.Distinct());
            var pre = emitters[0].Records[1];
            Assert.Equal(2, pre.InterceptorsRegistered);
            Assert.Equal("audit", pre.Verdicts[0].Name);
            Assert.Equal("rewrite", pre.Verdicts[1].Name);
            Assert.Equal(1, pre.DecidedBy);
            Assert.Equal(Decision.Transform, pre.Verdict.Decision);
            Assert.Equal(1, emitters[0].Records[0].InterceptorsRegistered);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public async Task PerPointBindingsCountTheListAtThePoint()
    {
        var em = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.0",
             "bindings": [{"id": "a", "kind": "com.example.deny", "at": ["pre_tool_call"]},
                          {"id": "b", "kind": "com.example.allow"}]}
            """, Registry());
        var input = await em.EmitUncheckedAsync(Ctx("input"));
        Assert.True(input.Proceeds);
        Assert.Equal(1, input.InterceptorsRegistered);
        Assert.Equal("b", input.Verdicts[0].Name);

        var pre = await em.EmitUncheckedAsync(Ctx("pre_tool_call", 1));
        Assert.False(pre.Proceeds);
        Assert.Equal(2, pre.InterceptorsRegistered);
        Assert.Equal(0, pre.DecidedBy);
        Assert.Equal("a", pre.Verdicts[0].Name);
        Assert.Equal("ctk:dangerous_tool", pre.Verdict.Reason);
        Assert.True(pre.FoldTruncated);
    }

    [Fact]
    public async Task UnboundPointDeniesNoInterceptor()
    {
        var em = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.0",
             "bindings": [{"id": "only-tools", "kind": "com.example.allow", "at": ["pre_tool_call"]}]}
            """, Registry());
        var r = await em.EmitUncheckedAsync(Ctx("input"));
        Assert.False(r.Proceeds);
        Assert.Equal(HostError.NoInterceptor, r.Verdict.Reason);
        Assert.Equal(0, r.InterceptorsRegistered);
        Assert.Equal(Declaration.Version, r.Declaration);
        Assert.Null(r.DecidedBy);
    }

    [Fact]
    public async Task ZeroBindingsIsTheWrittenDownEmptyDenyHost()
    {
        var em = InterceptionEmitter.FromDeclarationJson(
            """{"declaration": "agent-hooks-declaration/1.0", "bindings": []}""", Registry());
        var r = await em.EmitUncheckedAsync(Ctx("agent_startup"));
        Assert.Equal(HostError.NoInterceptor, r.Verdict.Reason);
        Assert.Equal(Declaration.Version, r.Declaration);
    }

    [Fact]
    public async Task RegisterAtOnTheCodePathFiltersByPoint()
    {
        var em = new InterceptionEmitter();
        var a = new Scripted(Verdict.Allow);
        em.Register(a, "tools-only", new HashSet<InterceptionPoint> { InterceptionPoint.PreToolCall });
        var input = await em.EmitUncheckedAsync(Ctx("input"));
        Assert.Equal(HostError.NoInterceptor, input.Verdict.Reason);
        Assert.Equal(0, input.InterceptorsRegistered);
        Assert.Equal(0, a.Calls);
        var pre = await em.EmitUncheckedAsync(Ctx("pre_tool_call", 1));
        Assert.True(pre.Proceeds);
        Assert.Equal(1, pre.InterceptorsRegistered);
        Assert.Equal("tools-only", pre.Verdicts[0].Name);
        Assert.Null(pre.Declaration);
    }

    [Fact]
    public async Task EvaluateOnlyFromDeclarationValidatesButDoesNotApply()
    {
        var em = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.0",
             "configuration": {"mode": "evaluate_only"},
             "bindings": [{"id": "rewrite", "kind": "com.example.rewrite"}]}
            """, Registry());
        var ctx = Ctx();
        var r = await em.EmitUncheckedAsync(ctx);
        Assert.Equal(EnforcementMode.EvaluateOnly, r.Mode);
        Assert.Equal(Decision.Transform, r.Verdict.Decision);
        Assert.Equal("https://x", (string?)ctx.Json["tool_call"]!["args"]!["url"]);
        Assert.Equal("rewrite", r.Verdicts[0].Name);
    }

    [Fact]
    public async Task ReferencesResolveFromTheRegistry()
    {
        var approver = new SlowApprover(TimeSpan.Zero);
        var seen = new List<string>();
        var reg = Registry()
            .IdentityProvider("myco-hash", _ => "sha256:custom")
            .ApprovalResolver("operator-queue", approver)
            .ApprovalRedactor("strip-secrets", ctx =>
            {
                seen.Add("redacted");
                return ctx;
            })
            .Kind("com.example.escalate", (_, _) => new Scripted(Verdict.Escalate("check")));
        var em = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.0",
             "configuration": {
               "identity_provider": "myco-hash",
               "approval": {"resolver": "operator-queue", "redactor": "strip-secrets"}
             },
             "bindings": [{"id": "gate", "kind": "com.example.escalate"}]}
            """, reg);
        var r = await em.EmitUncheckedAsync(Ctx());
        Assert.True(r.Proceeds);
        Assert.Equal("approval", r.ResolvedBy);
        Assert.Equal("myco-hash", r.IdentityProvider);
        Assert.Equal("sha256:custom", r.InputIdentity);
        Assert.Equal(["redacted"], seen);
    }

    [Fact]
    public async Task DeclaredTimeoutsBoundInterceptorsAndTheResolver()
    {
        var reg = Registry()
            .Kind("com.example.slow", (_, _) => new Slow(TimeSpan.FromSeconds(1)))
            .Kind("com.example.escalate", (_, _) => new Scripted(Verdict.Escalate("check")))
            .ApprovalResolver("slow-queue", new SlowApprover(TimeSpan.FromSeconds(1)));
        var slow = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.0",
             "configuration": {"timeouts": {"interceptor_ms": 5000}},
             "bindings": [{"id": "slow", "kind": "com.example.slow", "timeout_ms": 50}]}
            """, reg);
        var r = await slow.EmitUncheckedAsync(Ctx());
        Assert.Equal(HostError.InterceptorTimeout, r.Verdict.Reason);

        var resolver = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.0",
             "configuration": {
               "approval": {"resolver": "slow-queue"},
               "timeouts": {"interceptor_ms": 5000, "approval_resolver_ms": 50}
             },
             "bindings": [{"id": "gate", "kind": "com.example.escalate"}]}
            """, reg);
        r = await resolver.EmitUncheckedAsync(Ctx());
        Assert.Equal(HostError.ApprovalResolverFailed, r.Verdict.Reason);
        Assert.Equal("timeout", r.Verdict.Message);
        Assert.Equal("rejection", r.ResolvedBy);
    }

    [Fact]
    public void MaxBufferedRecordsBoundsTheBuffer()
    {
        var em = InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.0",
             "configuration": {"records": {"max_buffered": 2}},
             "bindings": [{"id": "allow", "kind": "com.example.allow"}]}
            """, Registry());
        for (var i = 0; i < 3; i++) em.RecordHostFailure(InterceptionPoint.Output, sequence: i);
        Assert.Equal(2, em.Records.Count);
        Assert.Equal(1, em.RecordsDropped);
    }

    // ---- sealing -------------------------------------------------------------

    [Fact]
    public void SealedEmitterRefusesReconfiguration()
    {
        var em = InterceptionEmitter.FromDeclarationJson(Minimal(), Registry());
        Assert.Throws<InvalidOperationException>(() => em.Register(new Scripted(Verdict.Allow)));
        Assert.Throws<InvalidOperationException>(() => em.SetComposition(CompositionConfig.RunAll()));
        Assert.Throws<InvalidOperationException>(() => em.SetIdentityProvider(IdentityProvider.Null));
        Assert.Throws<InvalidOperationException>(() => em.SetApprovalRedactor(c => c));
        Assert.Throws<InvalidOperationException>(() => em.SetMaxRecords(1));
        // Delivery is not content: allowed.
        var seen = new List<InterceptionRecord>();
        em.SetRecordSink(seen.Add);
        em.RecordHostFailure(InterceptionPoint.Output);
        Assert.Single(seen);
        Assert.Single(em.TakeRecords());
    }

    // ---- refusal classes -----------------------------------------------------

    public static IEnumerable<object[]> Refusals() =>
    [
        [
            """{"declaration": "agent-hooks-declaration/0.1", "bindings": []}""",
            DeclarationErrorClass.VersionUnsupported, "/declaration",
        ],
        [
            """{"bindings": []}""",
            DeclarationErrorClass.VersionUnsupported, "/declaration",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.9", "bindings": []}""",
            DeclarationErrorClass.VersionUnsupported, "/declaration",
        ],
        [
            """{"declaration": 1, "bindings": []}""",
            DeclarationErrorClass.VersionUnsupported, "/declaration",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "spec": "agent-hooks/9.0", "bindings": []}""",
            DeclarationErrorClass.SpecUnsupported, "/spec",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "policy": {}, "bindings": []}""",
            DeclarationErrorClass.UnknownField, "/policy",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "configuration": {"composition": {"profile": "sequential/run_all", "on_timeout": "deny"}}, "bindings": []}""",
            DeclarationErrorClass.UnknownField, "/configuration/composition/on_timeout",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "configuration": {"mode": "audit"}, "bindings": []}""",
            DeclarationErrorClass.InvalidField, "/configuration/mode",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "configuration": {"timeouts": {"interceptor_ms": 5000.0}}, "bindings": []}""",
            DeclarationErrorClass.InvalidField, "/configuration/timeouts/interceptor_ms",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "configuration": {"composition": {"profile": "sequential/run_all", "on_approval": "resume"}}, "bindings": []}""",
            DeclarationErrorClass.Inconsistent, "/configuration/composition/on_approval",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "surface": {"interception_points": ["agent_startup", "input", "pre_model_call", "post_model_call", "output"]}, "bindings": []}""",
            DeclarationErrorClass.Inconsistent, "/surface/interception_points",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "bindings": [{"id": "a", "kind": "com.example.allow"}, {"id": "a", "kind": "com.example.allow"}]}""",
            DeclarationErrorClass.Inconsistent, "/bindings/1/id",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "surface": {"declaration_versions": ["agent-hooks-declaration/0.1", "agent-hooks-declaration/1.0"]}, "bindings": []}""",
            DeclarationErrorClass.SurfaceUnsupported, "/surface/declaration_versions",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "configuration": {"posture": {"tool_seam_host_error": "terminate"}}, "bindings": []}""",
            DeclarationErrorClass.SurfaceUnsupported, "/configuration/posture/tool_seam_host_error",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "configuration": {"identity_provider": "hmac-sha256-k1"}, "bindings": []}""",
            DeclarationErrorClass.ReferenceUnresolved, "/configuration/identity_provider",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "configuration": {"approval": {"resolver": "operator-queue"}}, "bindings": []}""",
            DeclarationErrorClass.ReferenceUnresolved, "/configuration/approval/resolver",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "bindings": [{"id": "x", "kind": "com.example.nonexistent"}]}""",
            DeclarationErrorClass.KindUnknown, "/bindings/0/kind",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "bindings": [{"id": "ok", "kind": "com.example.allow"}, {"id": "bad", "kind": "com.example.throws"}]}""",
            DeclarationErrorClass.BindingRejected, "/bindings/1",
        ],
        [
            """{"declaration": "agent-hooks-declaration/1.0", "bindings": [{"id": "bad", "kind": "com.example.none"}]}""",
            DeclarationErrorClass.BindingRejected, "/bindings/0",
        ],
    ];

    [Theory]
    [MemberData(nameof(Refusals))]
    public void RefusedDocumentsReportOneClassAndPointer(
        string json, DeclarationErrorClass expected, string pointer)
    {
        var e = Assert.Throws<DeclarationException>(
            () => InterceptionEmitter.FromDeclarationJson(json, Registry()));
        Assert.Equal(expected, e.Class);
        Assert.Equal(expected.ToCode(), e.Code);
        Assert.Contains(e.Findings, f => f.Pointer == pointer);
        Assert.StartsWith(expected.ToCode(), e.Message);
        if (expected == DeclarationErrorClass.VersionUnsupported)
        {
            Assert.Equal(Declaration.SupportedVersions, e.Accepted);
            Assert.Contains("accepted: agent-hooks-declaration/1.0", e.Findings[0].Detail);
        }
        else
        {
            Assert.Empty(e.Accepted);
        }
        // The same document refuses with the same class on every path.
        var node = JsonNode.Parse(json);
        var viaNode = Assert.Throws<DeclarationException>(
            () => InterceptionEmitter.FromDeclarationNode(node, Registry()));
        Assert.Equal(expected, viaNode.Class);
    }

    [Fact]
    public void SurfaceBeyondTheCodeIsRefusedNotNarrowed()
    {
        // The SDK default surface emits the floor only; a document that
        // lists the tool points and claims tool_calls asks for more.
        var e = Assert.Throws<DeclarationException>(() => InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.0",
             "surface": {
               "interception_points": ["agent_startup", "input", "pre_tool_call", "post_tool_call", "output", "agent_shutdown"],
               "capabilities": ["host_declaration", "tool_calls"]
             },
             "bindings": [{"id": "allow", "kind": "com.example.allow"}]}
            """, Registry(HostSurface.SdkDefault())));
        Assert.Equal(DeclarationErrorClass.SurfaceUnsupported, e.Class);
        Assert.Contains(e.Findings, f => f.Pointer == "/surface/interception_points");
        Assert.Contains(e.Findings, f => f.Pointer == "/surface/capabilities");

        // Absent surface fills from the code's own, never past it.
        var em = InterceptionEmitter.FromDeclarationJson(Minimal(), Registry(HostSurface.SdkDefault()));
        Assert.Equal(4, em.Declaration!.SurfaceInterceptionPoints.Count);
        Assert.Equal(4, em.Declaration.Bindings[0].At.Count);
        Assert.Equal(new HashSet<string> { "host_declaration" }, em.Declaration.SurfaceCapabilities);
    }

    [Fact]
    public void BindingRejectedNamesTheBindingAndNeverTheConfig()
    {
        var e = Assert.Throws<DeclarationException>(() => InterceptionEmitter.FromDeclarationJson("""
            {"declaration": "agent-hooks-declaration/1.0",
             "bindings": [{"id": "bad", "kind": "com.example.throws", "config": {"token": "SECRET-VALUE"}}]}
            """, Registry()));
        Assert.Equal(DeclarationErrorClass.BindingRejected, e.Class);
        Assert.Contains("\"bad\"", e.Findings[0].Detail);
        Assert.Contains("\"com.example.throws\"", e.Findings[0].Detail);
        Assert.Contains("config not understood", e.Findings[0].Detail);
        Assert.DoesNotContain("SECRET-VALUE", e.Message);
    }

    [Fact]
    public void RefusalDetailsAreBounded()
    {
        var reg = Registry().Kind("com.example.verbose", (_, _) =>
            throw new InvalidOperationException(new string('x', 2000)));
        var e = Assert.Throws<DeclarationException>(() => InterceptionEmitter.FromDeclarationJson(
            Minimal("com.example.verbose"), reg));
        Assert.True(e.Findings[0].Detail.Length <= Declaration.MaxDetailLength);
        Assert.EndsWith("…", e.Findings[0].Detail);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("null")]
    [InlineData("""{"declaration": "agent-hooks-declaration/1.0", "declaration": "agent-hooks-declaration/1.0", "bindings": []}""")]
    public void MalformedTextIsRefusedBeforeTheVersionCheck(string text)
    {
        var e = Assert.Throws<DeclarationException>(
            () => InterceptionEmitter.FromDeclarationJson(text, Registry()));
        Assert.Equal(DeclarationErrorClass.Malformed, e.Class);
    }

    [Fact]
    public void ExcessDepthIsMalformed()
    {
        var deep = new StringBuilder(
            "{\"declaration\": \"agent-hooks-declaration/1.0\", \"bindings\": [], \"extensions\": {\"x\": ");
        for (var i = 0; i < 40; i++) deep.Append("{\"a\":");
        deep.Append('1');
        for (var i = 0; i < 40; i++) deep.Append('}');
        deep.Append("}}");
        var e = Assert.Throws<DeclarationException>(
            () => InterceptionEmitter.FromDeclarationJson(deep.ToString(), Registry()));
        Assert.Equal(DeclarationErrorClass.Malformed, e.Class);
    }

    [Fact]
    public void NonFiniteValueOnTheNodePathIsMalformed()
    {
        var doc = (JsonObject)JsonNode.Parse(Minimal())!;
        doc["extensions"] = new JsonObject { ["x"] = new JsonObject { ["v"] = JsonValue.Create(double.NaN) } };
        var e = Assert.Throws<DeclarationException>(
            () => InterceptionEmitter.FromDeclarationNode(doc, Registry()));
        Assert.Equal(DeclarationErrorClass.Malformed, e.Class);
    }

    [Fact]
    public void UnreadablePathsAreRefusedWithoutReadingContent()
    {
        var dir = Directory.CreateTempSubdirectory("agent-hooks-decl-");
        try
        {
            void Expect(string path, string detail)
            {
                var e = Assert.Throws<DeclarationException>(
                    () => InterceptionEmitter.FromDeclarationPath(path, Registry()));
                Assert.Equal(DeclarationErrorClass.Unreadable, e.Class);
                Assert.Equal("", e.Findings[0].Pointer);
                Assert.Contains(detail, e.Findings[0].Detail);
            }

            Expect(Path.Combine(dir.FullName, "missing.json"), "cannot stat: NotFound");
            Expect(dir.FullName, "not a regular file");

            var big = Path.Combine(dir.FullName, "big.json");
            File.WriteAllBytes(big, new byte[Declaration.MaxDocumentBytes + 1]);
            Expect(big, $"the bound is {Declaration.MaxDocumentBytes}");

            var bom = Path.Combine(dir.FullName, "bom.json");
            File.WriteAllBytes(bom, [0xEF, 0xBB, 0xBF, .. Encoding.UTF8.GetBytes(Minimal())]);
            Expect(bom, "byte-order mark");

            var bad = Path.Combine(dir.FullName, "bad.json");
            File.WriteAllBytes(bad, [(byte)'{', 0xFF, 0xFE, (byte)'}']);
            Expect(bad, "not valid UTF-8");

            var good = Path.Combine(dir.FullName, "good.json");
            File.WriteAllText(good, Minimal());
            Assert.NotNull(InterceptionEmitter.FromDeclarationPath(good, Registry()).Declaration);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    // ---- registry ------------------------------------------------------------

    [Fact]
    public void RegistryRefusesReservedDuplicateAndMalformedNames()
    {
        var reg = new HostRegistry(FullSurface());
        Assert.Throws<ArgumentException>(() => reg.Kind("ctk.x", (_, _) => new Scripted(Verdict.Allow)));
        Assert.Throws<ArgumentException>(() => reg.Kind("agent_hooks.x", (_, _) => new Scripted(Verdict.Allow)));
        Assert.Throws<ArgumentException>(() => reg.Kind("nodot", (_, _) => new Scripted(Verdict.Allow)));
        Assert.Throws<ArgumentException>(() => reg.Kind("Com.Example", (_, _) => new Scripted(Verdict.Allow)));
        reg.Kind("com.example.a", (_, _) => new Scripted(Verdict.Allow));
        Assert.Throws<ArgumentException>(() => reg.Kind("com.example.a", (_, _) => new Scripted(Verdict.Allow)));
        Assert.Throws<ArgumentException>(() => reg.IdentityProvider("jcs-fake", _ => "x"));
        Assert.Throws<ArgumentException>(() => reg.ApprovalResolver("Bad Name", new SlowApprover(TimeSpan.Zero)));
        reg.ApprovalResolver("queue", new SlowApprover(TimeSpan.Zero));
        Assert.Throws<ArgumentException>(() => reg.ApprovalResolver("queue", new SlowApprover(TimeSpan.Zero)));

        var ctk = HostRegistry.ForConformance(FullSurface());
        ctk.Kind("ctk.x", (_, _) => new Scripted(Verdict.Allow));
        Assert.Throws<ArgumentException>(() => ctk.Kind("agent_hooks.x", (_, _) => new Scripted(Verdict.Allow)));

        var names = reg.Names();
        Assert.Equal(["com.example.a"], ((JsonArray)names["kinds"]!).Select(n => (string)n!));
        Assert.Equal(["queue"], ((JsonArray)names["approval_resolvers"]!).Select(n => (string)n!));
    }

    [Fact]
    public void RegistryRefusesAnInvalidCodeSurface()
    {
        var noFloor = HostSurface.SdkDefault() with
        {
            InterceptionPoints = new HashSet<InterceptionPoint> { InterceptionPoint.AgentStartup },
        };
        var e = Assert.Throws<ArgumentException>(() => new HostRegistry(noFloor));
        Assert.Contains("agent_shutdown", e.Message);

        var unknownCapability = HostSurface.SdkDefault().WithCapabilities("teleport");
        Assert.Throws<ArgumentException>(() => new HostRegistry(unknownCapability));

        var oneToolPoint = HostSurface.SdkDefault().WithPoints(InterceptionPoint.PreToolCall);
        Assert.Throws<ArgumentException>(() => new HostRegistry(oneToolPoint));
    }

    [Fact]
    public void FromCapabilitiesDerivesThePoints()
    {
        var s = HostSurface.FromCapabilities(["model_calls", "int64_json"], ToolSeamPosture.Terminate);
        Assert.Equal(6, s.InterceptionPoints.Count);
        Assert.Contains(InterceptionPoint.PreModelCall, s.InterceptionPoints);
        Assert.DoesNotContain(InterceptionPoint.PreToolCall, s.InterceptionPoints);
        Assert.Equal(ToolSeamPosture.Terminate, s.ToolSeamHostError);
        var wire = s.ToWire();
        Assert.Equal("bounded", (string?)wire["interceptor_timeout"]);
        Assert.Equal("terminate", (string?)wire["tool_seam_host_error"]);
        Assert.Equal(s.ToWire().ToJsonString(), HostSurface.FromWire(wire).ToWire().ToJsonString());
    }

    // ---- builder -------------------------------------------------------------

    [Fact]
    public void BuilderWritesWhatItIsToldAndIsValidatedLikeAFile()
    {
        var doc = HostDeclaration.Builder()
            .Id("prod-eu")
            .Host("example-runtime", "3.2.0")
            .Mode(EnforcementMode.Enforce)
            .Composition(CompositionConfig.Unanimous(SynthesisPolicy.Approval, SynthesisPolicy.Deny))
            .IdentityProvider(null)
            .ApprovalResolver(null)
            .ToolSeamHostError(ToolSeamPosture.Continue)
            .InterceptorTimeoutMs(null)
            .MaxBufferedRecords(10)
            .SurfacePoints(AllPoints)
            .SurfaceCapabilities(["host_declaration", "model_calls", "tool_calls"])
            .SurfaceProfile(CompositionProfile.ParallelUnanimous, KnobSupport.Full(CompositionProfile.ParallelUnanimous))
            .BufferedOutput(true)
            .SurfaceDeclarationVersions(Declaration.SupportedVersions)
            .Bind("a", "com.example.allow", unbounded: true)
            .Extension("acme", new JsonObject { ["note"] = 1 })
            .ToNode();
        Assert.Null(doc["configuration"]!["identity_provider"]);
        Assert.True(doc["configuration"]!.AsObject().ContainsKey("identity_provider"));
        Assert.Null(doc["configuration"]!["timeouts"]!["interceptor_ms"]);
        Assert.Null(doc["bindings"]![0]!["timeout_ms"]);

        // parallel/unanimous does not consult on_transform_conflict:
        // the builder wrote it out and the loader refuses it, as a file.
        var e = Assert.Throws<DeclarationException>(
            () => InterceptionEmitter.FromDeclarationNode(doc, Registry()));
        Assert.Equal(DeclarationErrorClass.Inconsistent, e.Class);
        Assert.Contains(e.Findings, f => f.Pointer == "/configuration/composition/on_transform_conflict");

        var unknown = HostDeclaration.Builder().Raw("policy", new JsonObject()).Build();
        var u = Assert.Throws<DeclarationException>(() => InterceptionEmitter.FromDeclaration(unknown, Registry()));
        Assert.Equal(DeclarationErrorClass.UnknownField, u.Class);
    }

    [Fact]
    public void BuilderFromNodeRoundTripsEveryVectorDocument()
    {
        var dir = Path.Combine(RepoRoot(), "conformance", "vectors");
        var seen = 0;
        foreach (var vector in Runner.LoadVectors(dir))
        {
            if (vector["host_declaration"] is not JsonObject doc) continue;
            seen++;
            var rebuilt = Runner.BuilderFromNode(doc).ToNode();
            Assert.True(JsonNode.DeepEquals(doc, rebuilt), $"{vector["id"]}: builder rebuilt a different document");
        }
        Assert.Equal(20, seen);
    }

    // ---- golden --------------------------------------------------------------

    [Fact]
    public void GoldenDeclarationsResolveByteForByte()
    {
        var golden = (JsonObject)JsonNode.Parse(File.ReadAllText(
            Path.Combine(RepoRoot(), "conformance", "golden", "declaration.json")))!;
        var surface = HostSurface.FromWire((JsonObject)golden["surface"]!);
        Assert.Equal("bounded", (string?)golden["surface"]!["interceptor_timeout"]);
        var names = (JsonObject)golden["names"]!;
        var reg = new HostRegistry(surface);
        foreach (var k in (JsonArray)names["kinds"]!)
            reg.Kind((string)k!, (_, _) => new Scripted(Verdict.Allow));
        foreach (var p in (JsonArray)names["identity_providers"]!)
            reg.IdentityProvider((string)p!, _ => "sha256:x");
        foreach (var r in (JsonArray)names["approval_resolvers"]!)
            reg.ApprovalResolver((string)r!, new SlowApprover(TimeSpan.Zero));
        foreach (var r in (JsonArray)names["approval_redactors"]!)
            reg.ApprovalRedactor((string)r!, c => c);
        Assert.True(JsonNode.DeepEquals(names, reg.Names()));

        var fixtures = (JsonArray)golden["fixtures"]!;
        Assert.Equal(5, fixtures.Count);
        foreach (var f in fixtures)
        {
            var resolved = HostDeclaration.FromNode(f!["document"]).Resolve(reg);
            Assert.True(
                (string)f["expect"]!["canonical_json"]! == resolved.CanonicalJson(),
                $"{f["id"]}: canonical form differs");
        }
    }

    // ---- reference harness ---------------------------------------------------

    [Fact]
    public void ReferenceDeclarationResolvesAgainstTheHarnessSurface()
    {
        var harness = new ReferenceHarness();
        Assert.Contains(Capability.HostDeclaration, harness.Capabilities);
        var resolved = HostDeclaration.FromNode(harness.Declaration).Resolve(new HostRegistry(harness.HostSurface));
        Assert.Equal(
            harness.Capabilities.Select(c => c.ToWireName()).Order(StringComparer.Ordinal),
            resolved.SurfaceCapabilities.Order(StringComparer.Ordinal));
        Assert.Equal(AllPoints.Length, resolved.SurfaceInterceptionPoints.Count);
        Assert.Empty(resolved.Bindings);
    }
}
