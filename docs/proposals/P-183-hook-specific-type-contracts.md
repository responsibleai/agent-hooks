# P-183: Hook-specific type contracts from existing context schemas

- **Status:** Draft
- **Created:** 2026-11-03
- **Author(s):** Caitie McCaffrey `<caitiem20@github.com>` (@CaitieM20)
- **PR:** https://github.com/agent-hooks/pull/183

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


## Security and privacy


## Backward compatibility



## SDK surface and implementation impact


## Conformance and tests

