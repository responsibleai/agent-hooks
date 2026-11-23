// Copyright (c) Microsoft. All rights reserved.

using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;
using Draft = AgentHooks.Contracts.Draft;

namespace AgentHooks.Tests;

public sealed class SchemasTests
{
    private static JsonObject ValidPreToolCallRequest() => Contract.ToJson(new Draft.PreToolCallRequest
    {
        Timestamp = "2026-01-01T00:00:00Z",
        Sequence = 0,
        Agent = new Draft.ContextMetadataAgent { Id = "agent-1", Framework = "reference" },
        Session = new Draft.ContextMetadataSession { Id = "session-1" },
        ToolCall = new Draft.ToolCall
        {
            Id = "tc-1",
            Name = "search",
            Args = new Draft.JsonObject { ["q"] = JsonSerializer.SerializeToElement("hello") },
        },
    });

    [Fact]
    public void ValidDraftRequestAndResponsePass()
    {
        var request = ValidPreToolCallRequest();
        Assert.True(Schemas.IsValid(request, nameof(Draft.PreToolCallRequest)));
        Assert.Empty(Schemas.Errors(request, nameof(Draft.PreToolCallRequest)));

        var response = Contract.ToJson(new Draft.PreToolHookResponse
        {
            Verdict = new Draft.AllowVerdict { Reason = "ok" },
        });
        Assert.True(Schemas.IsValid(response, nameof(Draft.PreToolHookResponse)));
        Assert.Empty(Schemas.Errors(response, nameof(Draft.PreToolHookResponse)));
    }

    [Fact]
    public void MissingRequiredMembersReportRootError()
    {
        var request = ValidPreToolCallRequest();
        request.Remove("tool_call");
        Assert.False(Schemas.IsValid(request, nameof(Draft.PreToolCallRequest)));
        var requestErrors = Schemas.Errors(request, nameof(Draft.PreToolCallRequest));
        Assert.Contains(requestErrors, e => e.Pointer == "" && e.Message.Contains("tool_call", StringComparison.Ordinal));

        var response = new JsonObject();
        Assert.False(Schemas.IsValid(response, nameof(Draft.PreToolHookResponse)));
        var responseErrors = Schemas.Errors(response, nameof(Draft.PreToolHookResponse));
        Assert.Contains(responseErrors, e => e.Pointer == "" && e.Message.Contains("verdict", StringComparison.Ordinal));
    }

    [Fact]
    public void ClosedMembersRejectUnknownPropertiesWithPointer()
    {
        var request = ValidPreToolCallRequest();
        request["tool_call"]!.AsObject()["unexpected"] = true;
        Assert.False(Schemas.IsValid(request, nameof(Draft.PreToolCallRequest)));
        Assert.Contains(Schemas.Errors(request, nameof(Draft.PreToolCallRequest)), e => e.Pointer == "/tool_call/unexpected");

        var response = new JsonObject
        {
            ["verdict"] = new JsonObject { ["decision"] = "allow" },
            ["unexpected"] = 1,
        };
        Assert.False(Schemas.IsValid(response, nameof(Draft.PreToolHookResponse)));
        Assert.Contains(Schemas.Errors(response, nameof(Draft.PreToolHookResponse)), e => e.Pointer == "/unexpected");
    }

    [Fact]
    public void InvalidDateTimeFormatReportsTimestampPointer()
    {
        var request = ValidPreToolCallRequest();
        request["timestamp"] = "not-a-timestamp";
        Assert.False(Schemas.IsValid(request, nameof(Draft.PreToolCallRequest)));
        Assert.Contains(Schemas.Errors(request, nameof(Draft.PreToolCallRequest)), e => e.Pointer == "/timestamp");
    }

    [Fact]
    public void CrossDocumentRefResolvesValidAndInvalidInstances()
    {
        var valid = new JsonObject
        {
            ["context_identity"] = "sha256:" + new string('a', 64),
            ["interception_point"] = "pre_tool_call",
            ["verdict"] = new JsonObject { ["decision"] = "deny" },
            ["context"] = ValidPreToolCallRequest(),
        };
        Assert.True(Schemas.IsValid(valid, nameof(Draft.ApprovalRequest)));
        Assert.Empty(Schemas.Errors(valid, nameof(Draft.ApprovalRequest)));

        var invalidPoint = (JsonObject)valid.DeepClone();
        invalidPoint["interception_point"] = "not_a_point";
        Assert.False(Schemas.IsValid(invalidPoint, nameof(Draft.ApprovalRequest)));
        Assert.Contains(Schemas.Errors(invalidPoint, nameof(Draft.ApprovalRequest)), e => e.Pointer == "/interception_point");

        var invalidContext = (JsonObject)valid.DeepClone();
        invalidContext["context"]!.AsObject()["timestamp"] = "bad";
        Assert.False(Schemas.IsValid(invalidContext, nameof(Draft.ApprovalRequest)));
        Assert.Contains(Schemas.Errors(invalidContext, nameof(Draft.ApprovalRequest)), e => e.Pointer.StartsWith("/context", StringComparison.Ordinal));
    }
}
