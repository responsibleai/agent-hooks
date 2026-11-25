// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json.Nodes;
using Xunit;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks.Tests;

public sealed class DeclarationTests
{
    private static readonly string Document = File.ReadAllText(HookEmitterTests.Example("HostDeclaration/document-policy.json"));

    private static HostRegistry Registry(List<JsonNode?>? configs = null) => new HostRegistry()
        .AddKind("example.document_policy", binding =>
        {
            configs?.Add(binding.Config);
            return new Deny();
        })
        .AddApprovalResolver("operator", new Approve());

    [Fact]
    public async Task JsonAndTypedDeclarationsBuildEquivalentEmitters()
    {
        var configs = new List<JsonNode?>();
        var fromJson = HookEmitter.FromDeclaration(Document, Registry(configs));
        var fromType = HookEmitter.FromDeclaration(ContractSerializer.Deserialize<Draft.HostDeclaration>(JsonNode.Parse(Document)), Registry());

        Assert.Equal("public", (string?)configs.Single()!["permitted_collection"]);
        foreach (var emitter in new[] { fromJson, fromType })
        {
            var result = await emitter.EmitAsync(HookEmitterTests.PreToolCall());
            Assert.True(result.Proceeds);
            Assert.Equal(Draft.ResolvedBy.Approval, result.Record.ResolvedBy);
            Assert.Null(result.Record.IdentityProvider);
            Assert.Equal(Draft.OnApproval.Resume, result.Record.Composition.OnApproval);
        }
    }

    [Theory]
    [InlineData("spec", "\"agent-hooks/0.1\"", "declaration_error:spec_unsupported", "/spec")]
    [InlineData("surprise", "true", "declaration_error:unknown_field", "/surprise")]
    [InlineData("bindings", "{}", "declaration_error:invalid_field", "/bindings")]
    public void MalformedDeclarationsAreRefusedWithPointers(string member, string value, string code, string pointer)
    {
        var document = JsonNode.Parse(Document)!.AsObject();
        document[member] = JsonNode.Parse(value);

        var error = Assert.Throws<DeclarationException>(() => HookEmitter.FromDeclaration(document.ToJsonString(), Registry()));

        Assert.Equal(code, error.Code);
        Assert.Contains(error.Findings, f => f.Pointer == pointer);
    }

    [Fact]
    public void UnregisteredReferencesAreRefusedInStageOrder()
    {
        var unresolved = Assert.Throws<DeclarationException>(() => HookEmitter.FromDeclaration(Document, new HostRegistry()));
        Assert.Equal("declaration_error:reference_unresolved", unresolved.Code);

        var unknownKind = Assert.Throws<DeclarationException>(
            () => HookEmitter.FromDeclaration(Document, new HostRegistry().AddApprovalResolver("operator", new Approve())));
        Assert.Equal("declaration_error:kind_unknown", unknownKind.Code);
        Assert.Equal("/bindings/0/kind", Assert.Single(unknownKind.Findings).Pointer);
    }

    [Theory]
    [InlineData(true, false, "/configuration/composition/on_approval")]
    [InlineData(false, true, "/configuration/composition/on_approval")]
    [InlineData(true, true, null)]
    public void OmittedKnobsAndSupportListsTakeTheirDefaults(bool omitKnob, bool omitSupport, string? refusedAt)
    {
        var document = JsonNode.Parse(Document)!.AsObject();
        if (omitKnob) document["configuration"]!["composition"]!.AsObject().Remove("on_approval");
        if (omitSupport) document["surface"]!["profiles"]!["sequential/first_deny"]!.AsObject().Remove("on_approval");

        if (refusedAt is null)
        {
            Assert.NotNull(HookEmitter.FromDeclaration(document.ToJsonString(), Registry()));
            return;
        }
        var error = Assert.Throws<DeclarationException>(() => HookEmitter.FromDeclaration(document.ToJsonString(), Registry()));
        Assert.Contains(error.Findings, f => f.Pointer == refusedAt);
    }

    [Theory]
    [InlineData("bom")]
    [InlineData("invalid_utf8")]
    [InlineData("oversize")]
    [InlineData("directory")]
    [InlineData("missing")]
    public void UnreadableDeclarationFilesAreRefused(string kind)
    {
        var directory = Directory.CreateTempSubdirectory("agent-hooks-declaration-");
        try
        {
            var path = Path.Combine(directory.FullName, "declaration.json");
            var bytes = System.Text.Encoding.UTF8.GetBytes(Document);
            switch (kind)
            {
                case "bom": File.WriteAllBytes(path, [0xEF, 0xBB, 0xBF, .. bytes]); break;
                case "invalid_utf8": File.WriteAllBytes(path, [.. bytes[..^1], 0xFF, bytes[^1]]); break;
                case "oversize": File.WriteAllBytes(path, [.. bytes, .. Enumerable.Repeat((byte)' ', 1 << 20)]); break;
                case "directory": Directory.CreateDirectory(path); break;
            }

            var error = Assert.Throws<DeclarationException>(() => HookEmitter.FromDeclarationFile(path, Registry()));

            Assert.Equal("declaration_error:unreadable", error.Code);
        }
        finally
        {
            directory.Delete(recursive: true);
        }
    }

    [Fact]
    public void ReadableDeclarationFilesBuild()
    {
        var path = Path.GetTempFileName();
        try
        {
            File.WriteAllText(path, Document, new System.Text.UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            Assert.NotNull(HookEmitter.FromDeclarationFile(path, Registry()));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Theory]
    [InlineData("""{"spec":"agent-hooks/draft","configuration":{"timeouts":{"interceptor_ms":5000.0}},"bindings":[]}""", "/configuration/timeouts/interceptor_ms")]
    [InlineData("""{"spec":"agent-hooks/draft","configuration":{"timeouts":{"approval_resolver_ms":5e3}},"bindings":[]}""", "/configuration/timeouts/approval_resolver_ms")]
    [InlineData("""{"spec":"agent-hooks/draft","configuration":{"records":{"max_buffered":1e2}},"bindings":[]}""", "/configuration/records/max_buffered")]
    [InlineData("""{"spec":"agent-hooks/draft","bindings":[{"id":"a","kind":"example.document_policy","timeout_ms":5000.0}]}""", "/bindings/0/timeout_ms")]
    [InlineData("""{"spec":"agent-hooks/draft","bindings":[{"id":"a","kind":"example.document_policy","timeout_ms":5e3}]}""", "/bindings/0/timeout_ms")]
    public void NonIntegerNumberTokensAreRefusedAsInvalidField(string json, string pointer)
    {
        var error = Assert.Throws<DeclarationException>(() => HookEmitter.FromDeclaration(json, Registry()));

        Assert.Equal("declaration_error:invalid_field", error.Code);
        Assert.Contains(error.Findings, f => f.Pointer == pointer);
    }

    [Theory]
    [InlineData(true, "/configuration/failure/on_error")]
    [InlineData(false, "/bindings/0/on_error")]
    public void OnErrorContinueRequiresAControlFailureNotifier(bool inherited, string pointer)
    {
        var document = JsonNode.Parse(Document)!.AsObject();
        var binding = document["bindings"]![0]!.AsObject();
        if (inherited)
        {
            document["configuration"]!["failure"]!["on_error"] = "continue";
            binding.Remove("on_error");
        }
        else
        {
            binding["on_error"] = "continue";
        }
        var json = document.ToJsonString();

        var error = Assert.Throws<DeclarationException>(() => HookEmitter.FromDeclaration(json, Registry()));
        Assert.Equal("declaration_error:surface_unsupported", error.Code);
        Assert.Contains(error.Findings, f => f.Pointer == pointer);

        Assert.NotNull(HookEmitter.FromDeclaration(json, Registry().OnControlFailure(_ => { })));
    }

    [Fact]
    public void ResolvedDeclarationPreservesConfigNullAndOptionalMetadata()
    {
        var configs = new List<JsonNode?>();
        var json = """
        {
          "spec": "agent-hooks/draft",
          "id": "ops-host",
          "host": { "name": "example-host", "version": "1.2.3" },
          "configuration": {
            "records": { "max_buffered": 250 }
          },
          "surface": {
            "interception_points": ["agent_startup", "input", "output", "agent_shutdown"],
            "capabilities": ["host_declaration", "streaming"],
            "profiles": {
              "sequential/first_deny": { "on_approval": ["stop", "resume"] }
            },
            "buffered_output": false,
            "exposure_bound": "At most one sentence."
          },
          "bindings": [
            { "id": "explicit-null", "kind": "example.document_policy", "config": null },
            { "id": "omitted-config", "kind": "example.document_policy" }
          ]
        }
        """;
        var surface = new HostSurface(new HashSet<Draft.Capability>
        {
            Draft.Capability.HostDeclaration, Draft.Capability.Streaming,
        });
        var registry = new HostRegistry(surface).AddKind("example.document_policy", binding =>
        {
            configs.Add(binding.Config);
            return new Deny();
        });

        var emitter = HookEmitter.FromDeclaration(json, registry);

        Assert.Equal(2, configs.Count);
        Assert.Null(configs[0]);
        Assert.IsType<JsonObject>(configs[1]);
        Assert.Empty(configs[1]!.AsObject());

        var resolved = emitter.Declaration!;
        Assert.Equal("ops-host", (string?)resolved["id"]);
        Assert.Equal("example-host", (string?)resolved["host"]!["name"]);
        Assert.Equal("1.2.3", (string?)resolved["host"]!["version"]);
        Assert.Equal(250, (long)resolved["configuration"]!["records"]!["max_buffered"]!);
        Assert.Equal("At most one sentence.", (string?)resolved["surface"]!["exposure_bound"]);
        Assert.Equal(["resume", "stop"], resolved["surface"]!["profiles"]!["sequential/first_deny"]!["on_approval"]!.AsArray().Select(n => (string?)n));
        Assert.True(resolved["bindings"]![0]!.AsObject().ContainsKey("config"));
        Assert.Null(resolved["bindings"]![0]!["config"]);
        Assert.IsType<JsonObject>(resolved["bindings"]![1]!["config"]);
    }

    [Fact]
    public void TypedDeclarationSerializationErrorsAreWrappedAsMalformed()
    {
        var declaration = new Draft.HostDeclaration
        {
            Id = "bad-\uD800-id",
            Bindings = [],
        };

        var error = Assert.Throws<DeclarationException>(() => HookEmitter.FromDeclaration(declaration, Registry()));

        Assert.Equal("declaration_error:malformed", error.Code);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void FailingOrNullBindingFactoryRefusesImmediatelyWithoutInvokingLaterFactories(bool returnNull)
    {
        var calls = 0;
        var json = """
        {
          "spec": "agent-hooks/draft",
          "bindings": [
            { "id": "first", "kind": "example.bad" },
            { "id": "second", "kind": "example.bad" }
          ]
        }
        """;
        var registry = new HostRegistry().AddKind("example.bad", _ =>
        {
            calls++;
            return returnNull ? null! : throw new InvalidOperationException("bad");
        });

        var error = Assert.Throws<DeclarationException>(() => HookEmitter.FromDeclaration(json, registry));

        Assert.Equal("declaration_error:binding_rejected", error.Code);
        Assert.Equal("/bindings/0", Assert.Single(error.Findings).Pointer);
        Assert.Equal(1, calls);
    }

    private sealed class Deny : IHookInterceptor
    {
        public Task<HookOutcome> InterceptAsync(HookCall call, CancellationToken cancellationToken) =>
            Task.FromResult<HookOutcome>(new JsonObject
            {
                ["verdict"] = new JsonObject { ["decision"] = "deny", ["reason"] = "review", ["approval"] = new JsonObject() },
            });
    }

    private sealed class Approve : IApprovalResolver
    {
        public Task<JsonObject> ResolveAsync(JsonObject request, CancellationToken cancellationToken) =>
            Task.FromResult(new JsonObject
            {
                ["outcome"] = "approve",
                ["context_identity"] = request["context_identity"]?.DeepClone(),
                ["verdict"] = new JsonObject { ["decision"] = "allow" },
            });
    }
}
