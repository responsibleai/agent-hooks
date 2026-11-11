# P-183: Hook-specific type contracts from existing context schemas

- **Status:** Accepted
- **Created:** 2026-11-03
- **Author(s):** Caitie McCaffrey `<caitiem20@github.com>` (@CaitieM20)
- **PR:** (https://github.com/responsibleai/agent-hooks/pull/183)

## Abstract

The Spec's broad `AgentContext` and interceptor contracts do not clearly
express which fields are available at each hook, leaving developers to
check and interpret payloads themselves. This proposal explores
hook-specific types, grounded in the existing schemas, so builders and
interceptors can expose the fields each hook requires and catch mistakes
at compile time. The goal is clearer, safer contracts with minimal changes
the wire format.

## The gap (Motivation)
### Specification knowledge instead of explicit contracts

The broad context contract leaves hook implementors to read the
specification to determine which fields are required at each interception
point, what `target` represents, and which assumptions are safe. Correctness
depends on translating that prose into checks and conventions rather than
implementing a well-defined hook contract. Hook-specific types would make
those requirements explicit and let tooling catch missing fields and
incorrect assumptions earlier.

To write an interceptor today the code looks as follows:
```python

  def intercept(self, context) -> Verdict:
      if context["interception_point"] != "pre_tool_call":
          return Verdict(decision=Decision.ALLOW)
      call = context["tool_call"]
      if call["name"] == "sql_query" and call["args"].get("limit", 0) > MAX_ROWS:
            return Verdict(
                decision=Decision.DENY,
                reason="row_limit_exceeded",
                message=f"limit {call['args']['limit']} > {MAX_ROWS}; "
                        "paginate or request an exemption via #data-access",
            )
        return Verdict(decision=Decision.ALLOW)

```
In the above example, the developer writes a generic interceptor, then must inspect the interception point before accessing the hook-specific payload. Ideally developers will want to write interceptors specific to the hook. Getting to a typed system makes this easier to do and less error prone. 

### Keeping harness internals private

Harnesses should be able to expose only the data needed by a hook without
revealing their internal state or representation. A broad context with many
optional fields blurs that boundary and leaves interceptor authors unsure
which additional data they can rely on. A well-defined per-hook contract
would give harnesses a clear minimum to supply, without requiring them to
populate or pass unrelated optional data to every interceptor.


## Goals and non-goals (optional)
- Goals are to make the current eight-hook interceptors defined as explicit types, with minimal changes to the schema.
- Non-goals are redesigning specific hooks, follow on proposals can do that as necessary.

## Specification
See specification for details on the existing context schemas and how they map to the hook-specific types.


### Schema
This proposal move to explicit hook-specific types, with base request & response classes. The below is meant to be illustrative full changes should be viewed in the PR.

``` ts
export interface HooksRequest extends ContextMetadata {
  interception_point: InterceptionPoint;
}

export interface HookResponse<TVerdict> {
  verdict: TVerdict;
  extensions?: Extensions;
}

export type HooksResponseNoTransform = HookResponse<NonTransformVerdict>;

export type HooksResponseTransformSupported<TTransform> =
  HookResponse<Verdict<TTransform>>;
```

Notably we will define a TransformVerdict type, which each hook will have to specify.
```ts
export interface TransformVerdict<TTransform> extends VerdictBase {
  decision: Decision.Transform;
  transform: TTransform;
}
```

We also will explicitly define the Hook Handler shape
```ts
export type HookHandler<TRequest, TResponse> = (request: TRequest) => TResponse;
```

For the PreTool Hook the specific types would look as follows:
```ts
export interface PreToolCallRequest extends HooksRequest {
  interception_point: "pre_tool_call";
  tool_call: ToolCall;
}

export interface PreToolHookTransform {
  args: PreToolRequest["tool_call"]["args"];
}

export type PreToolHookResponse = HooksResponseTransformSupported<PreToolHookTransform>;

export type PreToolHookHandler = HookHandler<PreToolRequest, PreToolHookResponse>;
```

### Response envelope

The proposed `HooksResponse` retains the envelope adopted in
[P-006](P-006-interceptor-response-envelope.md):

```json
{
  "verdict": {
    "decision": "allow"
  },
  "extensions": {
    "example_provider": {
      "request_id": "request-123"
    }
  }
}
```

For every `HooksResponse`, `verdict` MUST be present and MUST satisfy the verdict contract
for that request's interception point. The response root MUST contain only
`verdict` and optional `extensions`; 

All transports MUST use this same response data layer. The proposed
hook handler returns the envelope for in-process calls as well, so adapters
do not introduce a second hook-response representation.

## Rationale
The rationale for introducing hook-specific types is to provide clearer and safer contracts for interceptors, reducing the reliance on developers to manually check and interpret the broad `AgentContext`. By defining explicit types for each hook, we make the required fields and expected behavior explicit, enabling better tooling support, compile-time checks, and improved developer experience. This approach also allows harnesses to expose only the necessary data for each hook, maintaining encapsulation and minimizing the risk of accidental reliance on internal state.

Maintaining the existing schema & specification without introducing hook-specific types is a blocker for adoption by major harnesses.

### Response representation options

Hook-specific verdict types do not require flattening the response. Keeping
the decision inside `verdict` separates the closed control contract from
optional, non-authoritative metadata, as P-006 intended.

| Option | Benefits | Trade-offs |
| --- | --- | --- |
| A. Retain P-006 unchanged: accept both bare verdicts and envelopes, with bare verdicts for in-process calls | Preserves current parser and callable compatibility; avoids wrapping responses without metadata | Two valid response representations require normalization and separate parser/serializer cases; in-process and remote boundaries can expose different data shapes |
| B. Require envelopes remotely but retain bare verdicts for in-process hook handlers | Gives every remote transport the same wire shape while preserving the existing in-process callable | Still has two hook-response contracts; adapters must wrap or unwrap based on the boundary, and moving an interceptor between boundaries changes its response interface |
| C. Require `{ verdict, extensions? }` for every hook response, including in-process calls (recommended) | One response data layer regardless of transport; one outer parser/serializer contract with hook-specific validation of the nested verdict; preserves the metadata boundary | Breaking change for bare-verdict producers, consumers, and in-process callables; even responses without extensions require a small wrapper |
| D. Flatten verdict fields and extensions into one response object | Avoids nesting and exposes the decision directly | Abandons P-006's separate envelope; makes metadata and control members share a boundary and requires care to keep metadata out of verdict composition |

**Working recommendation: option C.** A protocol should have one canonical
response representation rather than two interchangeable ways to express the
same result. Uniform transport data makes validation, documentation, generated clients, and transport changes easier to reason about. 


## Security and privacy
The response envelope preserves P-006's separation between canonical control
data and opaque provider metadata. Hosts must validate the whole envelope
before using its nested verdict, enforce extension namespace and size limits,
and keep extensions out of enforcement and canonical records. Receipts are not
trusted merely because they appear in an envelope; authentication, signatures,
and receipt retention remain provider/host concerns. Removing bare-response
acceptance avoids ambiguous normalization paths but does not replace these
validation requirements.

## Backward compatibility
This is a breaking change because existing interceptors that rely on the broad `AgentContext` will need to be updated to use the new hook-specific types. Additionally optional requests that used to be valid on the broad context may no longer be available, requiring interceptors to adapt to the more specific hook contracts.



The envelope shape itself is retained from P-006. Requiring it everywhere is
a breaking change: P-006 accepts bare verdict responses and keeps
in-process interceptors returning `Verdict`. Existing bare-verdict producers
must wrap the value in `verdict`; response consumers must require and extract
that member. Transport serializers must stop preferring bare output when
extensions are absent. Standalone verdict parsing remains available for
internal values, not as an alternate response gate. Released contracts and
SDK behavior remain unchanged until the new contract is accepted and released.

## SDK surface and implementation impact
The SDKs will need to be updated to support the new hook-specific types, ensuring that interceptors can correctly handle the typed requests and responses for each hook. This may involve generating new type definitions, updating method signatures, and providing utilities to facilitate the transition from the broad `AgentContext` to the specific hook contracts.

The proposed SDK response surface is `HookResponse<TVerdict>`, specialized as
`HooksResponseNoTransform` or `HooksResponseTransformSupported<TTransform>`, with required
`verdict` and optional `extensions`. SDKs MAY provide utilities to facilitate the transition from bare verdicts to the new envelope format, ensuring that existing interceptors and response consumers can adapt to the new hook-specific types without breaking existing functionality.

This will require a Major Spec Version bump to indicate the breaking change introduced by the new hook-specific types, when draft is released.

## Conformance and tests
Interceptors should be tested against the new hook-specific types to ensure they correctly handle the typed requests and responses. This includes verifying that interceptors properly check the `interception_point`, access the expected fields, and return the appropriate verdicts. Test suites should be updated to reflect the new types and to catch any regressions caused by the transition from the broad `AgentContext` to the specific hook contracts.

Conformance tests will also need to be updated to support multiple spec versions. 
