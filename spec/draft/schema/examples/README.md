# JSON examples

Each JSON file is a standalone instance of the named type, following MCP's
[type-directory layout](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/schema/2026-07-28/examples).
These examples illustrate the current draft definitions only.
The TypeScript definitions in `src/` link to every example with JSDoc
`@example` references; each link is relative to that source file. The schema
generator ignores these documentation-only tags, so examples do not change the
generated schema or its wire contract.

The scenario is a document-policy assistant searching for a retention policy.
The eight contexts form one session: a requested internal-collection search is
limited to the public collection before the tool executes. Verdicts and approval
resolutions illustrate **alternatives**, not steps that must all run. The
declarations use identity-unbound mode, so approval requests, resolutions, and
records consistently carry null identities. `operator` and
`example.document_policy` are illustrative host-registered resolver and kind
names, not built-in implementations.

## Schema mapping

All schema paths below are relative to [`../generated/`](../generated/).
Every `AgentContext` file validates against both `agent-context.schema.json`
and the indicated closed per-hook schema.

| Example file(s) | Validation schema or fragment |
| --- | --- |
| [AgentContext/agent-startup.json](AgentContext/agent-startup.json) | `strict-contexts/agent_startup.schema.json` |
| [AgentContext/input.json](AgentContext/input.json) | `strict-contexts/input.schema.json` |
| [AgentContext/pre-model-call.json](AgentContext/pre-model-call.json) | `strict-contexts/pre_model_call.schema.json` |
| [AgentContext/pre-model-call-with-tools.json](AgentContext/pre-model-call-with-tools.json) | `strict-contexts/pre_model_call.schema.json` |
| [AgentContext/post-model-call.json](AgentContext/post-model-call.json) | `strict-contexts/post_model_call.schema.json` |
| [AgentContext/post-model-call-with-usage.json](AgentContext/post-model-call-with-usage.json) | `strict-contexts/post_model_call.schema.json` |
| [AgentContext/pre-tool-call.json](AgentContext/pre-tool-call.json) | `strict-contexts/pre_tool_call.schema.json` |
| [AgentContext/post-tool-call.json](AgentContext/post-tool-call.json) | `strict-contexts/post_tool_call.schema.json` |
| [AgentContext/post-tool-call-error.json](AgentContext/post-tool-call-error.json) | `strict-contexts/post_tool_call.schema.json` |
| [AgentContext/output.json](AgentContext/output.json) | `strict-contexts/output.schema.json` |
| [AgentContext/output-with-metadata.json](AgentContext/output-with-metadata.json) | `strict-contexts/output.schema.json` |
| [AgentContext/agent-shutdown.json](AgentContext/agent-shutdown.json) | `strict-contexts/agent_shutdown.schema.json` |
| [Verdict/*.json](Verdict/) | `verdict.schema.json` |
| [Verdict/allow-with-evidence.json](Verdict/allow-with-evidence.json) | `verdict.schema.json` |
| [InterceptorResponse/*-envelope.json](InterceptorResponse/) | `interceptor-response.schema.json` and `#/$defs/ResponseEnvelope` |
| [ApprovalRequest/collection-access.json](ApprovalRequest/collection-access.json) | `approval.schema.json#/$defs/request` |
| [ApprovalResolution/*.json](ApprovalResolution/) | `approval.schema.json#/$defs/resolution` |
| [HostDeclaration10/document-policy.json](HostDeclaration10/document-policy.json) | `host-declaration-1.0.schema.json` |
| [HostDeclaration11/document-policy.json](HostDeclaration11/document-policy.json) | `host-declaration-1.1.schema.json` |
| [HostDeclaration11/failure-posture.json](HostDeclaration11/failure-posture.json) | `host-declaration-1.1.schema.json` |
| [HostDeclaration11/streaming-document-policy.json](HostDeclaration11/streaming-document-policy.json) | `host-declaration-1.1.schema.json` |
| [InterceptionRecord/*.json](InterceptionRecord/) | `interception-record.schema.json` |
| [InterceptionRecord/continued-after-timeout.json](InterceptionRecord/continued-after-timeout.json) | `interception-record.schema.json` |
`Verdict/` contains bare decisions: allow, allow with a warning and result label,
allow with offline-verifiable evidence, deny, liftable deny, and six transforms.
`allow-with-evidence.json` demonstrates evidence pointers; these are distinct from
the transport receipts in `InterceptorResponse/`. `InterceptorResponse/` shows the separate
envelope form with namespaced transport receipts for all three decisions. A bare
Verdict is also a valid InterceptorResponse; an envelope is not a bare Verdict.
Approval resolutions cover approve-with-allow, approve-with-transform, reject,
and unresolved; each echoes the request's `context_identity`.

The transforms map to these contexts and writable target slices:

| Verdict file | Context | Path |
| --- | --- | --- |
| `transform-input.json` | `input` | `$target.content` |
| `transform-messages.json` | `pre_model_call` | `$target[0].content` |
| `transform-response.json` | `post_model_call` | `$target.tool_calls[0].args.collection` |
| `transform-tool-args.json` | `pre_tool_call` | `$target.collection` |
| `transform-tool-result.json` | `post_tool_call` | `$target.text` |
| `transform-output.json` | `output` | `$target.content` |

Each context's `target` equals its required hook payload slice, per
[sections 3 and 4.3](../../AGENT-HOOKS-0.1.md#3-interception-points).
No transform is shown for startup or shutdown, where transforms are forbidden.
The approval transform and transform envelope also apply to `pre_tool_call`.
Records are payload-free projections: `transform.value` is deliberately absent.
These schema examples do not replace runtime validation of host registrations,
declaration consistency, transform application, or other cross-field semantics.

The optional-field contexts demonstrate model tool declarations and parameters,
token usage, trace/tenant/actor/budget metadata, namespaced extensions, and a
failed tool result; in every case `target` equals that hook's required payload.
`failure-posture.json` shows a declaration default of `deny` overridden to
`continue` by one binding. The schema validates the document shape, not whether
the host implements the registered `example.document_policy` kind, can bound
that registration's execution, or satisfies the §6.3.1 requirement to notify
the principal after a continuation. A running host and its conformance claim
must meet those requirements. `streaming-document-policy.json` demonstrates
the declaration shape for `buffered_output: false` and its required
`exposure_bound`; its host must actually support and satisfy the runtime
streaming requirements in §12.1a.

`continued-after-timeout.json` records a control timeout continued under that
binding posture, not a policy denial: the combined verdict is `allow`, while the
per-binding slot carries `substituted_for: host_error:interceptor_timeout`.
Its reserved `host_warning:control_failed` message contains the binding id and
failure reason as required, without exception or target content. The record
keeps only the payload-free verdict projection.

## Validate locally

Run the following commands from the repository root after installing the
existing TypeScript development dependencies (`npm ci` in `sdk/typescript`).
The check uses AJV's Draft 2020-12 support with `ajv-formats` and validates
every JSON instance, including approval fragments,
against only the draft schemas. References are registered under their
published `$id` values, including the per-hook `agent-context/` identities;
validation does not fetch schemas or mix in released definitions.

```bash
cd sdk/typescript
node scripts/check-schema-examples.mjs
node --test test/schema-examples.test.mjs
```

Both commands run in CI's TypeScript job using the existing locked dependencies.
The check recursively enumerates all example JSON files and requires the
`TypeName/file.json` layout. New files in a mapped type directory are checked
automatically; a new type requires an explicit mapping in
[`check-schema-examples.mjs`](../../../../sdk/typescript/scripts/check-schema-examples.mjs)
and a row in the table above. Add its source-level `@example` reference too.
Unknown types or nested/unmapped files fail rather than being skipped. Invalid
JSON, schema errors, unresolved references, and
instance validation errors also fail the check. Contexts are checked against
both the union and the closed hook variant; bare verdicts are also checked as
InterceptorResponses, while envelope examples must satisfy ResponseEnvelope.

Regression tests mutate temporary copies only, exercising invalid instances in
every type, new mapped/unmapped files, invalid JSON, closed context variants,
format validation, envelope separation, and schema/reference failures.
