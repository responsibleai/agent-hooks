---
title: .NET SDK
---

`ResponsibleAI.AgentHooks` is a fully managed .NET 8 host SDK targeting the
[draft specification](../../spec/draft/): typed interception points, all four
[composition profiles](../concepts/composition.md), evaluation mode, timeouts
and failure posture, the [approval seam](../concepts/approval.md), RFC 8785
[context identity](../concepts/identity.md), payload-free
[interception records](../concepts/records.md), and host declarations. It
ships with no native libraries or platform-specific assets.

```sh
dotnet add package ResponsibleAI.AgentHooks --prerelease
```

If you want a five-minute walkthrough first, start with the
[.NET quickstart](../quickstart/dotnet.md).

:::caution[Trust model]
Agent Hooks is a cooperative contract, not a security boundary: the host is
fully trusted and interceptors run in-process with full access to request
payloads. See [§1.4 of the draft specification](../../spec/draft/#14-trust-model-and-non-goals).
:::

## Package layout

The `ResponsibleAI.AgentHooks` NuGet package bundles two managed assemblies:

| Assembly | Contents |
| --- | --- |
| `AgentHooks.Contracts` | Types generated from `spec/draft` TypeSpec under `AgentHooks.Contracts.Draft`: per-point requests, responses (with `Allow`/`Deny`/`Transform*` factories), transforms, verdicts, approval requests/resolutions, `InterceptionRecord`, `HostDeclaration`, per-point hook interfaces (`IAgentStartupHook` … `IAgentShutdownHook`), `IInterceptor`, `IApprovalResolver`, and `InterceptionPoints` metadata. |
| `AgentHooks` | The runtime under `AgentHooks`: `HookEmitter`, `HookEmitterBuilder`, `IHookInterceptor`, `IApprovalResolver`, `BindingOptions`, `IdentityProvider`, `Jcs`, `HostErrors`, `HookException`, `ContractSerializer`, `HostSurface`, `HostRegistry`, and `DeclarationException`. |

`AgentHooks.Conformance`, the draft Conformance Test Kit runner and reference
harness, lives in the repository under `sdk/csharp/src/AgentHooks.Conformance`
and is not packed into NuGet. See [Conformance](../conformance.md) for harness
details.

The examples below alias the generated draft contracts namespace to avoid a
name collision between `System.Text.Json.Nodes.JsonObject` and
`AgentHooks.Contracts.Draft.JsonObject`:

```csharp
using System.Text.Json;
using System.Text.Json.Nodes;
using AgentHooks;
using Draft = AgentHooks.Contracts.Draft;
```

## Emitting interception points

Configure an emitter once with `HookEmitter.CreateBuilder()` and call `Build()`.
The built `HookEmitter` is immutable and safe for concurrent emissions; each
interceptor invocation receives an isolated deep clone of the request so
mutations never leak across bindings or back to the caller.

### Typed emission

`EmitAsync<TRequest>` accepts any generated draft request type and returns an
`EmitResult<TRequest>` with four properties:

- `Proceeds`: `true` when the guarded action may run (an `allow` or `transform`
  verdict, or any emission in `Draft.Mode.EvaluateOnly`); `false` when the host
  must block the action.
- `Request`: the effective typed request after any enforced whole-target
  transforms (the original instance when unchanged). **Always consume
  `result.Request`**, not the original request you passed in.
- `Verdict`: the combined wire `JsonObject` verdict before record projection.
- `Record`: the payload-free `Draft.InterceptionRecord` delivered to any
  configured record sink.

```csharp
var emitter = HookEmitter.CreateBuilder()
    .OnPreToolCall((call, _) => Task.FromResult(
        call.ToolCall.Name == "send_email"
            ? Draft.PreToolHookResponse.Deny("egress_blocked", "External email is disabled.")
            : Draft.PreToolHookResponse.Allow()),
        new BindingOptions { Name = "egress-guard" })
    .WithRecordSink(record =>
        Console.WriteLine($"{record.InterceptionPoint}: {record.Verdict.Decision}"))
    .Build();

var result = await emitter.EmitAsync(new Draft.PreToolCallRequest
{
    Timestamp = DateTimeOffset.UtcNow.ToString("O"),
    Sequence = 0,
    Agent = new() { Id = "support-agent", Framework = "my-host" },
    Session = new() { Id = "s-001" },
    ToolCall = new()
    {
        Id = "t-1",
        Name = "send_email",
        Args = new() { ["body"] = JsonSerializer.SerializeToElement("hello") },
    },
});

if (!result.Proceeds)
{
    Console.WriteLine($"blocked: {result.Verdict["reason"]}");
    return;
}

// Pass result.Request.ToolCall.Args to the tool, not the original arguments.
```

`EmitAsync` never throws for a deny, an unbound point (`HostErrors.NoInterceptor`),
a validation failure (`HostErrors.ContextInvalid`), or cancellation during
dispatch — all of those fail closed in `EmitResult` and still emit an
`InterceptionRecord`. `EmitAsync<TRequest>` throws `JsonException` only if the
caller-supplied object fails strict wire serialization (for example, lone
UTF-16 surrogates).

### Wire-JSON emission and record sinks

Hosts that already hold wire JSON can call `EmitAsync(JsonObject, CancellationToken)`,
which returns a non-generic `EmitResult` whose `Request` is the effective wire
`JsonObject`. `ContractSerializer.Serialize<T>` and `ContractSerializer.Deserialize<T>`
convert strictly between generated contract types and `JsonObject` (rejecting
lone UTF-16 surrogates and excessive nesting depth).

Register a record sink with `WithRecordSink(Action<Draft.InterceptionRecord>)`.
Every emission invokes the sink once; exceptions thrown by the sink are
swallowed so audit delivery never disrupts enforcement.

### Recording unconstructible emissions

If a host cannot construct a valid request at an interception point (for
example, an adapter fails to serialize a tool payload), record the failure with
`RecordHostFailure` and fail the guarded action closed:

```csharp
Draft.InterceptionRecord record = emitter.RecordHostFailure(
    Draft.InterceptionPoint.PreToolCall,
    detail: "tool arguments could not be serialized",
    sessionId: "s-001",
    sequence: 4,
    timestamp: DateTimeOffset.UtcNow.ToString("O"));
```

`RecordHostFailure` produces a projected `Draft.InterceptionRecord` with a
`HostErrors.ContextInvalid` deny and `null` identities, and delivers it to the
configured sink.

## Authoring hooks

### Inline per-point delegates

`HookEmitterBuilder` provides a typed registration method for each of the eight
closed [interception points](../concepts/interception-points.md):

- `OnAgentStartup` (`Draft.AgentStartupRequest` → `Draft.AgentStartupHookResponse`)
- `OnInput` (`Draft.InputRequest` → `Draft.InputHookResponse`)
- `OnPreModelCall` (`Draft.PreModelCallRequest` → `Draft.PreModelHookResponse`)
- `OnPostModelCall` (`Draft.PostModelCallRequest` → `Draft.PostModelHookResponse`)
- `OnPreToolCall` (`Draft.PreToolCallRequest` → `Draft.PreToolHookResponse`)
- `OnPostToolCall` (`Draft.PostToolCallRequest` → `Draft.PostToolHookResponse`)
- `OnOutput` (`Draft.OutputRequest` → `Draft.OutputHookResponse`)
- `OnAgentShutdown` (`Draft.AgentShutdownRequest` → `Draft.AgentShutdownHookResponse`)

Each handler has signature `(TRequest request, CancellationToken ct) => Task<TResponse>`
and accepts an optional `BindingOptions`.

### Generated response factories

Every generated hook response type exposes `Allow()` and `Deny(reason, message?)`.
The six transformable points also expose whole-target transform factories:

| Interception point | Response type | Factories |
| --- | --- | --- |
| `agent_startup` | `Draft.AgentStartupHookResponse` | `Allow()`, `Deny(reason, message?)` |
| `input` | `Draft.InputHookResponse` | `Allow()`, `Deny(reason, message?)`, `TransformInput(Draft.Input)` |
| `pre_model_call` | `Draft.PreModelHookResponse` | `Allow()`, `Deny(reason, message?)`, `TransformMessages(Draft.Message[])` |
| `post_model_call` | `Draft.PostModelHookResponse` | `Allow()`, `Deny(reason, message?)`, `TransformResponse(Draft.Response)` |
| `pre_tool_call` | `Draft.PreToolHookResponse` | `Allow()`, `Deny(reason, message?)`, `TransformArgs(Draft.JsonObject)` |
| `post_tool_call` | `Draft.PostToolHookResponse` | `Allow()`, `Deny(reason, message?)`, `TransformValue(JsonElement)` |
| `output` | `Draft.OutputHookResponse` | `Allow()`, `Deny(reason, message?)`, `TransformOutput(Draft.Output)` |
| `agent_shutdown` | `Draft.AgentShutdownHookResponse` | `Allow()`, `Deny(reason, message?)` |

Transforms in the draft specification replace the **whole target member**, not
individual JSON paths:

```csharp
var emitter = HookEmitter.CreateBuilder()
    .OnPreToolCall((request, _) => Task.FromResult(
        Draft.PreToolHookResponse.TransformArgs(new Draft.JsonObject
        {
            ["query"] = JsonSerializer.SerializeToElement("redacted"),
        })))
    .OnPostToolCall((request, _) => Task.FromResult(
        Draft.PostToolHookResponse.TransformValue(
            JsonSerializer.SerializeToElement("redacted"))))
    .Build();
```

`TransformValue` clones its `JsonElement` (including JSON `null`), so any
backing `JsonDocument` can be disposed before the handler returns. Runtime
schema and semantic validation still run on every factory-created response.

### Reusable per-point interfaces

For reusable or DI-managed policies, implement only the generated per-point
interfaces you need:

- `Draft.IAgentStartupHook` (`OnAgentStartupAsync`)
- `Draft.IInputHook` (`OnInputAsync`)
- `Draft.IPreModelCallHook` (`OnPreModelCallAsync`)
- `Draft.IPostModelCallHook` (`OnPostModelCallAsync`)
- `Draft.IPreToolCallHook` (`OnPreToolCallAsync`)
- `Draft.IPostToolCallHook` (`OnPostToolCallAsync`)
- `Draft.IOutputHook` (`OnOutputAsync`)
- `Draft.IAgentShutdownHook` (`OnAgentShutdownAsync`)
- `Draft.IInterceptor` (composes all eight interfaces)

Register an instance with `AddHook(hook, options?)`. `AddHook` binds every
implemented interface in specification order using the same `BindingOptions`,
and throws `ArgumentNullException` if `hook` is `null` or `ArgumentException`
if it implements none of the eight interfaces:

```csharp
sealed class EgressGuard : Draft.IPreToolCallHook, Draft.IPostToolCallHook
{
    public Task<Draft.PreToolHookResponse> OnPreToolCallAsync(
        Draft.PreToolCallRequest request, CancellationToken cancellationToken = default) =>
        Task.FromResult(request.ToolCall.Name == "send_email"
            ? Draft.PreToolHookResponse.Deny("egress_blocked")
            : Draft.PreToolHookResponse.Allow());

    public Task<Draft.PostToolHookResponse> OnPostToolCallAsync(
        Draft.PostToolCallRequest request, CancellationToken cancellationToken = default) =>
        Task.FromResult(Draft.PostToolHookResponse.Allow());
}

var emitter = HookEmitter.CreateBuilder()
    .AddHook(new EgressGuard(), new BindingOptions { Name = "egress-guard" })
    .Build();
```

### Advanced verdict metadata

When a policy needs warnings, offline-verifiable evidence, liftable-deny
approval metadata, or result labels, construct the generated verdict object
directly:

```csharp
// Allow with warnings and result labels
var advisory = new Draft.PreToolHookResponse
{
    Verdict = new Draft.AllowVerdict
    {
        Warnings = [new() { Reason = "quota_80_percent", Message = "80% of call budget used" }],
        ResultLabels = ["external_egress"],
    },
};

// Liftable deny with approval block and evidence
var escalate = new Draft.PreToolHookResponse
{
    Verdict = new Draft.DenyVerdict
    {
        Reason = "transfer_requires_approval",
        Message = "Requires operator approval.",
        Approval = new Draft.JsonObject
        {
            ["scope"] = JsonSerializer.SerializeToElement("wire_transfer"),
        },
        Evidence = new Draft.Evidence
        {
            Artefact = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            VerificationPointers = new Draft.VerificationPointers
            {
                ["policy"] = "https://example.invalid/policies/wire-transfer",
            },
        },
    },
};
```

See [Verdicts](../concepts/verdicts.md) for the verdict validation rules
(reserved `host_error:` / `host_warning:` prefixes and the 10,240-byte
canonical evidence cap).

### Low-level `IHookInterceptor`

Every typed delegate and interface binding adapts down to `IHookInterceptor`.
Implement `IHookInterceptor` (or pass a `Func<HookCall, CancellationToken, Task<HookOutcome>>`
delegate to `Use`) for untyped, multi-point, or bridge interceptors:

```csharp
sealed class AuditOnlyInterceptor : IHookInterceptor
{
    public Task<HookOutcome> InterceptAsync(HookCall call, CancellationToken cancellationToken)
    {
        // call.Point, call.Request (isolated JsonObject clone), call.Timeout
        var body = new JsonObject
        {
            ["verdict"] = new JsonObject { ["decision"] = "allow" },
        };
        return Task.FromResult<HookOutcome>(body); // implicit conversion to HookOutcome.Responded
    }
}

var emitter = HookEmitter.CreateBuilder()
    .Use(
        new AuditOnlyInterceptor(),
        new BindingOptions { Name = "audit-bridge" },
        Draft.InterceptionPoint.PreToolCall,
        Draft.InterceptionPoint.PostToolCall)
    .Build();
```

Omitting `points` binds the interceptor at all eight points. Besides returning
a wire response `JsonObject` (`HookOutcome.Responded`), low-level interceptors
can return `HookOutcome.Timeout` (`HookOutcome.TimedOut`),
`HookOutcome.Cancellation` (`HookOutcome.Cancelled`), or
`new HookOutcome.Failed(detail)` to report execution outcomes explicitly.

### Unit-testing hooks directly

Generated request types are plain constructible classes with no runtime
dependencies, so hooks can be tested directly without spinning up a
`HookEmitter` or mocking special request factories:

```csharp
var guard = new EgressGuard();
var request = new Draft.PreToolCallRequest
{
    Timestamp = "2026-07-21T09:14:03.120Z",
    Sequence = 0,
    Agent = new() { Id = "test-agent", Framework = "xunit" },
    Session = new() { Id = "s-test" },
    ToolCall = new()
    {
        Id = "t-1",
        Name = "send_email",
        Args = new() { ["to"] = JsonSerializer.SerializeToElement("a@example.invalid") },
    },
};

Draft.PreToolHookResponse response = await guard.OnPreToolCallAsync(request);
// Assert response.Verdict is Draft.DenyVerdict { Reason: "egress_blocked" }
```

## Composition, mode, timeouts, and failure posture

`HookEmitterBuilder` defaults to the specification baseline:
`Draft.Mode.Enforce`, `Draft.CompositionProfile.SequentialFirstDeny` with
`Draft.OnApproval.Stop`, `Draft.ConflictResolution.Deny`, a 5-second timeout,
`Draft.OnError.Deny`, and `Draft.ToolSeamHostError.Continue`.

```csharp
var emitter = HookEmitter.CreateBuilder()
    .WithComposition(
        Draft.CompositionProfile.SequentialFirstDeny,
        onApproval: Draft.OnApproval.Resume)
    .WithMode(Draft.Mode.Enforce)
    .WithTimeouts(
        interceptor: TimeSpan.FromSeconds(2),
        approvalResolver: TimeSpan.FromSeconds(30))
    .WithDefaultOnError(Draft.OnError.Deny)
    .WithToolSeamPosture(Draft.ToolSeamHostError.Continue)
    .OnControlFailure(notice =>
        Console.WriteLine($"control failed [{notice.Binding} at {notice.InterceptionPoint}]: {notice.Reason}"))
    .AddHook(
        new EgressGuard(),
        new BindingOptions
        {
            Name = "egress-guard",
            Timeout = TimeSpan.FromMilliseconds(500),
            OnError = Draft.OnError.Continue,
        })
    .Build();
```

Key behaviors:

- **Composition (`WithComposition`)**: Supports `SequentialFirstDeny` (knob:
  `onApproval` = `Stop` | `Resume`), `SequentialRunAll`, `ParallelStrictest`
  (knob: `onTransformConflict` = `Deny` | `Approval`), and `ParallelUnanimous`
  (knob: `onDisagreement` = `Deny` | `Approval`). Each profile consults only
  its own knob.
- **Enforcement mode (`WithMode`)**: In `Draft.Mode.EvaluateOnly`, transforms
  are still validated against the point's request schema, but they are not
  applied to `result.Request`, the approval seam is not consulted, and
  `result.Proceeds` is always `true`. The emitted `InterceptionRecord` records
  what would have been decided.
- **Timeouts (`WithTimeouts`, `BindingOptions.Timeout`)**: Both the default
  interceptor timeout and per-binding overrides must be positive or
  `Timeout.InfiniteTimeSpan`. When `approvalResolver` is omitted, it defaults
  to the emitter's interceptor timeout. A timeout cancels the binding's
  `CancellationToken` and maps to `HostErrors.InterceptorTimeout` (or
  `HostErrors.ApprovalResolverFailed` for the resolver).
- **Failure posture (`WithDefaultOnError`, `BindingOptions.OnError`, `OnControlFailure`)**:
  Failures synthesize a reserved `HostErrors.*` deny by default. Setting
  `OnError = Draft.OnError.Continue` substitutes an `allow` carrying a
  `HostErrors.ControlFailedWarning` (`host_warning:control_failed`) warning for
  continuable failures (timeouts, unhandled exceptions, `HookOutcome.Failed`,
  invalid verdicts) **only when `OnControlFailure` is registered and succeeds**.
  Without a notifier — or if the notifier throws — the fail-closed deny stands.
  Caller cancellation (`CancellationToken` canceled or `HookOutcome.Cancelled`)
  is never continuable. `ControlFailureNotice` carries `Index`, `Binding`,
  `Reason`, `Message`, and `InterceptionPoint`.
- **Tool-seam posture (`WithToolSeamPosture`)**: Configures
  `emitter.ToolSeamPosture` (`Draft.ToolSeamHostError.Continue` or `Terminate`)
  for host adapters handling tool-seam host errors.
- **Binding names (`BindingOptions.Name`)**: Payload-free label of 1–128 UTF-8
  bytes recorded in `InterceptionRecord.Verdicts[].Name` and
  `ControlFailureNotice.Binding`.

## Approval seam and context identity

### Approval resolver and redactor

Register an approval resolver for liftable denies (a `DenyVerdict` with a
non-null `Approval` block) using either a typed delegate or a wire-level
`AgentHooks.IApprovalResolver`:

```csharp
var emitter = HookEmitter.CreateBuilder()
    .OnPreToolCall((call, _) => Task.FromResult(
        call.ToolCall.Name == "wire_transfer"
            ? new Draft.PreToolHookResponse
            {
                Verdict = new Draft.DenyVerdict
                {
                    Reason = "transfer_requires_approval",
                    Approval = new Draft.JsonObject(),
                },
            }
            : Draft.PreToolHookResponse.Allow()))
    .WithApprovalRedactor(context =>
    {
        // Mutate the isolated clone before the resolver sees it.
        // context_identity is computed over this redacted context.
        context["tool_call"]!["args"] = new JsonObject { ["redacted"] = true };
        return context;
    })
    .WithApprovalResolver((request, ct) => Task.FromResult<Draft.ApprovalResolution>(
        new Draft.ApproveResolution
        {
            ContextIdentity = request.ContextIdentity,
            Verdict = new Draft.AllowVerdict { Reason = "approved_by_operator" },
        }))
    .Build();
```

- Typed resolvers return `Draft.ApproveResolution`, `Draft.RejectResolution`,
  or `Draft.UnresolvedResolution` and **must echo `request.ContextIdentity`
  verbatim** (including `null` when identity-unbound). Any mismatch fails
  closed with `HostErrors.ApprovalIdentityMismatch`; `UnresolvedResolution`
  fails closed with `HostErrors.ApprovalUnresolved`.
- If you implement the generated `Draft.IApprovalResolver` interface, pass its
  method group `resolver.OnResolveAsync` to `WithApprovalResolver`. For raw
  JSON handling, implement `AgentHooks.IApprovalResolver` (`ResolveAsync(JsonObject, CancellationToken)`).
- The approval seam is consulted only in `Draft.Mode.Enforce` and never at
  `Draft.InterceptionPoint.AgentShutdown`. With no resolver registered,
  liftable denies are enforced as plain denies.

### Context identity and `Jcs`

By default, the emitter uses `IdentityProvider.JcsSha256` (`"jcs-sha256"`),
which computes RFC 8785 canonical JSON over the required fields of the request
and hashes it with SHA-256. Configure identity with `WithIdentityProvider`:

```csharp
// Default: RFC 8785 + SHA-256 (jcs-sha256)
builder.WithIdentityProvider(IdentityProvider.JcsSha256);

// Custom provider (name matches ^[a-z][a-z0-9_-]*$ and must not start with "jcs")
builder.WithIdentityProvider(new IdentityProvider(
    "my-host-sha256",
    request => ComputeHostIdentity(request)));

// Explicitly identity-unbound (records report identity_provider: null)
builder.WithIdentityProvider(null);
```

If a custom provider throws `HookException`, the emitter maps its `Reason` and
`Detail` directly into a fail-closed deny; any other exception maps to
`HostErrors.ContextInvalid`.

`Jcs` also exposes the standalone helpers `Jcs.ProviderName` (`"jcs-sha256"`),
`Jcs.Canonicalize(JsonNode?)`, and `Jcs.ContextIdentity(JsonObject)`. Like the
other SDKs, `Jcs` enforces the I-JSON ±(2^53−1) integer domain and throws
`HookException(HostErrors.ContextInvalid, ...)` rather than silently rounding
64-bit integers.

## Host declarations

Hosts can be configured declaratively from a draft `HostDeclaration` JSON
document, a file on disk, or a typed `Draft.HostDeclaration` instance.

1. Describe what your host supports with `HostSurface` (or use
   `HostSurface.Default`, which includes `ModelCalls`, `ToolCalls`,
   `ParallelToolCalls`, `MultiTurn`, `Int64Json`, `BigintJson`,
   `HostDeclaration`, and `Draft.ToolSeamHostError.Continue`).
2. Register named factories and runtime seams in a `HostRegistry`.
3. Build the emitter with `HookEmitter.FromDeclaration` or
   `HookEmitter.FromDeclarationFile`.

```csharp
var surface = new HostSurface(
    new HashSet<Draft.Capability>
    {
        Draft.Capability.HostDeclaration,
        Draft.Capability.ModelCalls,
        Draft.Capability.ToolCalls,
    },
    Draft.ToolSeamHostError.Continue);

var registry = new HostRegistry(surface)
    .AddKind("example.document_policy", binding => new DocumentPolicy(binding.Config))
    .AddIdentityProvider(new IdentityProvider("host-hash", ComputeHostIdentity))
    .AddApprovalResolver("operator", new OperatorResolver())
    .AddApprovalRedactor("strip-secrets", RedactContext)
    .OnControlFailure(notice => Console.WriteLine($"{notice.Binding}: {notice.Reason}"))
    .WithRecordSink(record => auditLog.Write(record));

try
{
    HookEmitter emitter = HookEmitter.FromDeclarationFile("agent-hooks.json", registry);
}
catch (DeclarationException ex)
{
    Console.Error.WriteLine($"Declaration refused ({ex.Code}):");
    foreach (var finding in ex.Findings)
    {
        var path = finding.Pointer.Length == 0 ? "/" : finding.Pointer;
        Console.Error.WriteLine($"  {path}: {finding.Detail}");
    }
}
```

Each `AddKind` factory receives a `BindingDefinition(Id, Kind, Config)` —
where `Config` is a deep clone of the binding's `config` JSON value (defaulting
to an empty JSON object) — and returns an `IHookInterceptor`.
`AddApprovalResolver` accepts an `AgentHooks.IApprovalResolver`.
`FromDeclarationFile` enforces BOM-less UTF-8 and a 1 MiB maximum document
size (`declaration_error:unreadable` on violation).

Declarations are validated in strict §7.7.6 stage order; a refused document
throws `DeclarationException` with `Code` set to `declaration_error:<class>`
(`unreadable`, `malformed`, `spec_unsupported`, `unknown_field`,
`invalid_field`, `inconsistent`, `surface_unsupported`,
`reference_unresolved`, `kind_unknown`, or `binding_rejected`) and
payload-free `Findings` carrying RFC 6901 JSON pointers.
