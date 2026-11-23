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
