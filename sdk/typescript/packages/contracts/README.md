# Agent Hooks contracts (TypeScript POC)

`@responsibleai/agent-hooks-contracts` contains TypeScript contracts generated
from the Agent Hooks TypeSpec specification. It has no native module, runtime
dependencies, runtime enums, or copied JSON Schemas.

Install the contracts package without installing the native SDK:

```bash
npm install @responsibleai/agent-hooks-contracts
```

The draft contract is exposed separately from any future released versions:

```ts
import type {
  PreToolCallRequest,
  PreToolHookResponse,
} from "@responsibleai/agent-hooks-contracts/draft";

function reviewTool(ctx: PreToolCallRequest): PreToolHookResponse {
  return {
    verdict: {
      decision: "transform",
      transform: { args: { ...ctx.tool_call.args, reviewed: true } },
    },
  };
}
```

Models are interfaces, enums are string-literal unions, and hook requests,
responses, and approval resolutions are discriminated unions. This is a
fresh contract, not an adaptation of the 0.1 SDK API.

Output is committed under `src/generated/<version>/`. Do not edit it by hand:
run `pnpm generate` from the repository root. Generation uses the Alloy JSX
emitter in `emitters/typescript`, configured by `spec/draft/tspconfig.yaml`.
Runtime integration is outside this POC.
