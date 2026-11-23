// Copyright (c) Microsoft. All rights reserved.

namespace AgentHooks;

/// <summary>A reserved <c>host_error:*</c> failure (spec §11) with a payload-free detail.</summary>
public sealed class HookException(string reason, string? detail = null)
    : Exception(detail is null ? reason : $"{reason}: {detail}")
{
    public string Reason { get; } = reason;

    public string? Detail { get; } = detail;
}

/// <summary>The reserved reasons of spec §11.</summary>
public static class HostErrors
{
    public const string ContextInvalid = "host_error:context_invalid";
    public const string NoInterceptor = "host_error:no_interceptor";
    public const string InterceptorTimeout = "host_error:interceptor_timeout";
    public const string InterceptorFailed = "host_error:interceptor_failed";
    public const string VerdictInvalid = "host_error:verdict_invalid";
    public const string TransformInvalid = "host_error:transform_invalid";
    public const string ApprovalResolverFailed = "host_error:approval_resolver_failed";
    public const string ApprovalIdentityMismatch = "host_error:approval_identity_mismatch";
    public const string ApprovalUnresolved = "host_error:approval_unresolved";
    public const string CompositionDisagreement = "host_error:composition_disagreement";
    public const string TransformConflict = "host_error:transform_conflict";
    public const string ControlFailedWarning = "host_warning:control_failed";

    /// <summary>The failures <c>on_error: continue</c> covers (§6.3.1).</summary>
    public static bool IsControlFailure(string reason) =>
        reason is InterceptorFailed or InterceptorTimeout or VerdictInvalid;
}
