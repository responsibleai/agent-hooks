# TypeScript quickstart

```sh
npm install @responsibleai/agent-hooks
```

The package resolves a prebuilt native binary for your platform through
`optionalDependencies` (linux-x64-gnu, darwin-x64, darwin-arm64,
win32-x64-msvc today).

A minimal host with one control interceptor:

```ts
import {
  AgentContextBuilder,
  InterceptionBlocked,
  InterceptionEmitter,
  Verdict,
} from "@responsibleai/agent-hooks";

const CONFIDENTIAL = ["account_balance", "ssn"];

const egressGuard = {
  intercept(context) {
    if (context.interception_point !== "pre_tool_call") return Verdict.allow();
    const args = JSON.stringify(context.tool_call.args);
    if (CONFIDENTIAL.some((m) => args.includes(m))) {
      return { decision: "deny", reason: "egress_blocked" };
    }
    return Verdict.allow();
  },
};

const emitter = new InterceptionEmitter();
emitter.register(egressGuard, "egress-guard");

const build = new AgentContextBuilder({
  agentId: "support-agent",
  framework: "quickstart",
  sessionId: "s-001",
});

const ok = await emitter.emit(build.preToolCall("t-1", "web_search", { q: "docs" }));
console.log("allowed:", ok.record.verdict.decision);

try {
  await emitter.emit(build.preToolCall("t-2", "send_email", { body: "account_balance: 991" }));
} catch (e) {
  if (!(e instanceof InterceptionBlocked)) throw e;
  console.log("denied:", e.result.verdict.reason);
  console.log("decided_by:", e.result.decided_by, "profile:", e.result.composition.profile);
}
```

Output:

```text
allowed: allow
denied: egress_blocked
decided_by: 0 profile: sequential/first_deny
```

Things to notice:

- Builder methods take positional arguments:
  `preToolCall(callId, name, args)`.
- `emit()` throws `InterceptionBlocked` on any block, with the record
  as `.result`; on success it resolves to `{ record, target }`, and
  your action must consume the effective `target`.
- A deny is a plain wire object; `Verdict.allow()`, `Verdict.warn()`
  and `Verdict.escalate()` sugar exists for the other shapes.
- The emitter pre-scans contexts for non-finite numbers before any
  serialization, because JavaScript's `JSON.stringify` would silently
  turn `NaN` into `null`; the scan fails closed instead.
