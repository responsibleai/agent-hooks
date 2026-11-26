---
name: agent-hooks-dotnet
description: >-
  Add the Agent Hooks SDK for .NET (ResponsibleAI.AgentHooks) to an app or agent: install the right package,
  emit at the input, pre_tool_call, post_tool_call and output points, write interceptors, and test allow and
  deny. USE FOR: add Agent Hooks to a .NET app, write an interceptor, guard tool calls, check prompts or
  answers. DO NOT USE FOR: other languages, or changing this repository's specification or SDKs.
---

# Add Agent Hooks to a .NET app

Read [sdk/csharp/README.md](../../../sdk/csharp/README.md) first. It covers install, the request at each point, reading the result and authoring hooks.

## Steps

1. Install `ResponsibleAI.AgentHooks` and pin the version. Check that `obj/project.assets.json` doesn't list `0.1.0-beta.3` or earlier, the retired 0.1 API.
2. Build one emitter at startup with `HookEmitter.CreateBuilder()` and share it. Emitters are immutable and thread safe.
3. At each point, build the typed request with every required member, `await hooks.EmitAsync(request, cancellationToken)`, and enforce the result:

   | Point | On deny |
   | --- | --- |
   | `input` | Return the message. Don't call the model. |
   | `pre_tool_call` | Don't run the tool. Give the model the message as the tool output. |
   | `post_tool_call` | Replace the tool result with the message. |
   | `output` | Replace the answer with the message. |

4. Write each interceptor. One point: a typed handler such as `OnPreToolCall`. Several points: a class that implements the point interfaces, such as `Draft.IInputHook`, bound with `AddHook`. Return `Deny(reason, message)` or `Allow()` from the point's response type. A kind loaded from a host declaration implements `IHookInterceptor` instead.
5. Bind every interceptor with `new BindingOptions { Name = "..." }`. The name appears in `Record.Verdicts`.
6. Test an allow and a deny at each point through the real emitter, plus an interceptor that throws and one that runs past its timeout. Both must deny.

## Rules

- Fail closed. Never catch an exception to return allow.
- Run each step on `result.Request`, the effective request, not your original.
- Emit only at points that have a binding. A point with none denies with `host_error:no_interceptor`.
- Log the point, decision, reason and interceptor name. Never log prompts, tool arguments, tool results or answers.
