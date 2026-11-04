# P-183: Hook-specific type contracts from existing context schemas

- **Status:** Draft
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

export type HooksResponse<TTransform> = Verdict<TTransform>;
```

Notably we will define a TransforVerdict type, which each hook will have to specify.
```ts
export interface TransformVerdict<TTransform = Transform> extends VerdictBase {
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
export interface PreToolRequest extends HooksRequest {
  interception_point: "pre_tool_call";
  tool_call: ToolCall;
}

export interface PreToolHookTransform {
  args: PreToolCallRequest["tool_call"]["args"];
}

export type PreToolHookResponse = HooksResponse<PreToolHookTransform>;

export type PreToolHookHandler = HookHandler<PreToolCallRequest, PreToolHookResponse>;
```

## Rationale
The rationale for introducing hook-specific types is to provide clearer and safer contracts for interceptors, reducing the reliance on developers to manually check and interpret the broad `AgentContext`. By defining explicit types for each hook, we make the required fields and expected behavior explicit, enabling better tooling support, compile-time checks, and improved developer experience. This approach also allows harnesses to expose only the necessary data for each hook, maintaining encapsulation and minimizing the risk of accidental reliance on internal state.

Maintaining the existing schema & specification without introducing hook-specific types is a blocker for adoption by major harnesses.

## Security and privacy
No new security or privacy risks are introduced by defining hook-specific types, as they only formalize the existing contracts and do not expose additional internal state beyond what the harness already provides.

## Backward compatibility
This is a breaking change because existing interceptors that rely on the broad `AgentContext` will need to be updated to use the new hook-specific types. Additionally optional requests that used to be valid on the broad context may no longer be available, requiring interceptors to adapt to the more specific hook contracts.

This will require a Major Spec Version bump to indicate the breaking change introduced by the new hook-specific types, when draft is released.

## SDK surface and implementation impact
The SDKs will need to be updated to support the new hook-specific types, ensuring that interceptors can correctly handle the typed requests and responses for each hook. This may involve generating new type definitions, updating method signatures, and providing utilities to facilitate the transition from the broad `AgentContext` to the specific hook contracts.

## Conformance and tests
Interceptors should be tested against the new hook-specific types to ensure they correctly handle the typed requests and responses. This includes verifying that interceptors properly check the `interception_point`, access the expected fields, and return the appropriate verdicts. Test suites should be updated to reflect the new types and to catch any regressions caused by the transition from the broad `AgentContext` to the specific hook contracts.

Conformance tests will also need to be updated to support multiple spec versions. 

### Draft coverage plan

The checked-in CTK, harness APIs, and golden vectors remain on the released
contract; passing them does not by itself establish conformance to this
hook-contract proposal. Draft response validation must dispatch by
`interception_point` to the eight roots in §5, not the generic verdict or the
removed transport envelope. Coverage must exercise all six whole-member
replacements, required replacement members (including explicit null versus
absent result value), wrong-hook transforms, both lifecycle prohibitions, flat
response extensions and their non-enforcement semantics, namespace
reservations, byte caps, duplicate-member rejection, and nested envelope
rejection. Sequential fold-through, parallel conflict handling,
`evaluate_only`, and identity projection must be tested using these payloads.

The existing draft schema-example checker covers several shape cases, but
schema tests do not prove host application, semantic metadata rules, or CTK
coverage. Approval vectors must verify that `approve` accepts only `allow` and
rejects transforms; record vectors must verify that transform decisions remain
visible while transform payloads are omitted. No new conformance claim or SDK
migration is made by this prose update.
