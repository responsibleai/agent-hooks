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
        var fromType = HookEmitter.FromDeclaration(Contract.FromJson<Draft.HostDeclaration>(JsonNode.Parse(Document)), Registry());

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
