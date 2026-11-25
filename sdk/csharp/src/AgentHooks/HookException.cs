// Copyright (c) Microsoft. All rights reserved.

namespace AgentHooks;

/// <summary>A reserved <c>host_error:*</c> failure (spec §11) with a payload-free detail.</summary>
public sealed class HookException(string reason, string? detail = null)
    : Exception(detail is null ? reason : $"{reason}: {detail}")
{
    /// <summary>The reserved <c>host_error:*</c> reason identifier (§11).</summary>
    public string Reason { get; } = reason;

    /// <summary>Optional payload-free detail describing the failure.</summary>
    public string? Detail { get; } = detail;
}

/// <summary>The reserved reasons of spec §11.</summary>
public static class HostErrors
{
    /// <summary>The candidate request failed schema or structural validation.</summary>
    public const string ContextInvalid = "host_error:context_invalid";
    /// <summary>No interceptor was bound for the interception point.</summary>
    public const string NoInterceptor = "host_error:no_interceptor";
    /// <summary>An interceptor exceeded its execution deadline.</summary>
    public const string InterceptorTimeout = "host_error:interceptor_timeout";
    /// <summary>An interceptor threw or reported failure.</summary>
    public const string InterceptorFailed = "host_error:interceptor_failed";
    /// <summary>An interceptor returned a verdict that failed schema or §5 validation.</summary>
    public const string VerdictInvalid = "host_error:verdict_invalid";
    /// <summary>An interceptor returned a transform that could not be applied validly.</summary>
    public const string TransformInvalid = "host_error:transform_invalid";
    /// <summary>The approval resolver failed or returned an invalid resolution.</summary>
    public const string ApprovalResolverFailed = "host_error:approval_resolver_failed";
    /// <summary>The approval resolution's context identity did not match the presented request.</summary>
    public const string ApprovalIdentityMismatch = "host_error:approval_identity_mismatch";
    /// <summary>An approval was required but could not be resolved.</summary>
    public const string ApprovalUnresolved = "host_error:approval_unresolved";
    /// <summary>Interceptors disagreed under a composition policy configured to deny disagreements.</summary>
    public const string CompositionDisagreement = "host_error:composition_disagreement";
    /// <summary>Multiple interceptors produced conflicting transforms.</summary>
    public const string TransformConflict = "host_error:transform_conflict";
    /// <summary>Host-synthesized warning attached when <c>on_error: continue</c> substitutes an allow (§6.3.1).</summary>
    public const string ControlFailedWarning = "host_warning:control_failed";
}
