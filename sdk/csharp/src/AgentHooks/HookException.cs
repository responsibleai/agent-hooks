// Copyright (c) Microsoft. All rights reserved.

namespace AgentHooks;

/// <summary>A reserved <c>host_error:*</c> failure (spec §11) carrying a payload-free detail.</summary>
/// <param name="reason">The reserved <c>host_error:*</c> reason identifier (see <see cref="HostErrors" />).</param>
/// <param name="detail">Optional payload-free detail describing the failure.</param>
/// <remarks>
/// When thrown by a custom <see cref="IdentityProvider" />, <see cref="HookEmitter" /> maps <see cref="Reason" />
/// and <see cref="Detail" /> directly into a fail-closed host-synthesized deny verdict.
/// </remarks>
public sealed class HookException(string reason, string? detail = null)
    : Exception(detail is null ? reason : $"{reason}: {detail}")
{
    /// <summary>Gets the reserved <c>host_error:*</c> reason identifier (§11).</summary>
    public string Reason { get; } = reason;

    /// <summary>Gets the optional payload-free detail describing the failure.</summary>
    public string? Detail { get; } = detail;
}

/// <summary>The reserved host-synthesized reason and warning identifiers of spec §11 and §6.3.1.</summary>
public static class HostErrors
{
    /// <summary>The candidate request failed schema, Unicode, or I-JSON validation, or identity computation failed.</summary>
    public const string ContextInvalid = "host_error:context_invalid";
    /// <summary>No interceptor was bound for the interception point (§6.2).</summary>
    public const string NoInterceptor = "host_error:no_interceptor";
    /// <summary>An interceptor exceeded its execution deadline (§6.3).</summary>
    public const string InterceptorTimeout = "host_error:interceptor_timeout";
    /// <summary>An interceptor threw, was cancelled, or reported failure (§6.3).</summary>
    public const string InterceptorFailed = "host_error:interceptor_failed";
    /// <summary>An interceptor or approval resolver returned a verdict that failed schema, Unicode, or §5.3 bounds validation.</summary>
    public const string VerdictInvalid = "host_error:verdict_invalid";
    /// <summary>An interceptor returned a transform at a forbidden point or whose result violated the request schema (§5).</summary>
    public const string TransformInvalid = "host_error:transform_invalid";
    /// <summary>The approval resolver or redactor failed, timed out, or returned a malformed resolution (§9).</summary>
    public const string ApprovalResolverFailed = "host_error:approval_resolver_failed";
    /// <summary>The approval resolution's echoed <c>context_identity</c> did not match the presented request (§9).</summary>
    public const string ApprovalIdentityMismatch = "host_error:approval_identity_mismatch";
    /// <summary>An approval consultation ended with outcome <c>unresolved</c> (§9).</summary>
    public const string ApprovalUnresolved = "host_error:approval_unresolved";
    /// <summary>Interceptors disagreed under <c>parallel/unanimous</c> composition (§7.5).</summary>
    public const string CompositionDisagreement = "host_error:composition_disagreement";
    /// <summary>Multiple interceptors produced transforms under a parallel composition profile (§7.5).</summary>
    public const string TransformConflict = "host_error:transform_conflict";
    /// <summary>Host-synthesized warning reason attached when <c>on_error: continue</c> substitutes an allow (§6.3.1).</summary>
    public const string ControlFailedWarning = "host_warning:control_failed";
}
