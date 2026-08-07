# AGENT-HOOKS-0.1 conformance report — Microsoft Agent Framework (Python)

Host adapter: `agent-framework-core` 1.13.0
(microsoft/agent-framework@`4b1afd90520310547cb0e9cdc70f644d80161e82`,
upstream `main`; the agent-hooks middleware feature merged as
[microsoft/agent-framework#7515](https://github.com/microsoft/agent-framework/pull/7515)).
The enforcement surface under test is the middleware bundle returned by
`agent_framework.create_agent_hooks_middleware` /
`create_agent_hooks_middleware_from_emitter`, driven through a real
`agent_framework.Agent` with only the chat client and tools mocked
(`harness.py`, this directory).

Corpus: the 47 `AH-CTK-*` vectors vendored in the `agent-hooks-sdk`
0.1.0a4 wheel (`agent_hooks.ctk/vectors`), byte-identical to
`responsibleai/agent-hooks` `conformance/vectors/` at `6195293`.

**This is a cross-validation report, not a conformance claim**: 14 of 47
vectors fail, all from two documented host-semantics divergences analysed
under [Findings](#findings). Per spec §13.1/§13.2 a host claims
conformance only at 100% of non-skipped vectors, so Agent Framework MUST
NOT be recorded as conformant on this report.

## Environment

| Component | Version |
| --- | --- |
| agent-framework-core | 1.13.0 (`4b1afd9052`, `main`, via git; subdirectory `python/packages/core`) |
| agent-hooks-sdk | 0.1.0a4 (PyPI), `[ctk]` extra |
| CTK runner | Python SDK (`agent_hooks.ctk`), pytest plugin |
| Python | 3.12.3 |
| OS | Linux 6.6.87.2 (WSL2) |

Invocation:

```bash
pytest test_conformance.py \
    --agent-hooks-harness=harness:AgentFrameworkHarness
```

## Declared surface (§13.1)

- **Interception points:** all eight (`agent_startup`, `input`,
  `pre_model_call`, `post_model_call`, `pre_tool_call`, `post_tool_call`,
  `output`, `agent_shutdown`).
- **Capabilities (§3.2):** `model_calls`, `tool_calls`, `int64_json`,
  `bigint_json` (Python integers are arbitrary precision; the >2^53 and
  beyond-u64 vectors run rather than skip — no capability-gated skips in
  this report).
- **Composition (§7.2):** SDK default `sequential/first_deny`
  (`on_approval: stop`); all four profiles and every knob are host
  configuration, passed through the factories' `composition=` parameter.
  All composition vectors that reach a run-level verdict pass; see F1 for
  the tool-seam ones that do not.
- **Identity provider (§10.1):** `jcs-sha256` (content-derived) by
  default; custom providers and `null` (identity-unbound records,
  vector-scoped) supported.
- **Enforcement modes (§8):** `enforce` (default) and `evaluate_only`.
- **`buffered_output: true` (§12.1a):** streaming runs are buffered and
  gated (`ResponseStream.buffered_and_gated`); the complete response is
  assembled before `post_model_call` / `output` and nothing egresses to
  the caller ahead of the combined verdict. No incremental mediation is
  performed, so no §12.1 exposure bound applies.
- **Known limitation (disclosed by the feature):** service-side (hosted)
  tools executed by the model provider never traverse the framework's
  function-invocation seam, so `pre_tool_call`/`post_tool_call` cannot
  intercept them; their calls and outputs surface in the
  `post_model_call` content projection, where they remain
  observable/deniable/transformable.

## Results (per part)

| Part | Passed | Failed |
| --- | --- | --- |
| approval_seam | 4 | 4 |
| composition/parallel_strictest | 2 | 1 |
| composition/parallel_unanimous | 1 | 1 |
| composition/sequential_first_deny | 2 | 0 |
| composition/sequential_run_all | 3 | 2 |
| enforcement/evaluate_only | 1 | 0 |
| enforcement/isolation | 1 | 0 |
| enforcement/post_action_deny | 0 | 1 |
| fail_closed/verdict_gate | 0 | 1 |
| identity_provider | 4 | 1 |
| record/decided_by | 0 | 1 |
| record/projection | 1 | 0 |
| unspecified | 13 | 2 |
| verdict/warnings | 1 | 0 |

Total: **33 passed, 14 failed, 0 skipped** of 47.

## Findings

### F1 — a `host_error:*` deny at the tool seam halts the run (13 vectors)

AH-CTK-070, -071, -072, -073, -085, -087, -092, -094, -095, -097, -098,
-102, -103.

Every one of these vectors fails on **exactly one assertion**:
`run_outcome == "blocked", want "completed"`. Everything else those
vectors pin — the synthesized deny reason, the failing interceptor's
slot/`decided_by` attribution, `tool_not_invoked`, the absent
`post_tool_call`, record projections — passes.

Cause: Agent Framework deliberately halts the run when a `host_error:*`
deny lands at `pre_tool_call`/`post_tool_call` (module docstring: "the
enforcement layer itself failed, so continuing would be unreliable";
pinned by its own unit tests, e.g.
`test_interceptor_crash_fails_closed_and_halts_run`). The tool call is
blocked exactly as §6.2 requires, and then `InterceptionBlocked`
propagates to the caller instead of the loop continuing. Plain (policy)
denies at the tool seam continue the loop and their vectors (AH-CTK-010,
-030, -031, -032, -050, -080 …) pass.

Spec reading: §6.2's continue rule carries the clause "unless the host's
own semantics terminate the turn", which this posture satisfies; §6.3's
"a single failure does not abort the emission, it composes as a deny" is
also honoured (composition and records are exactly as expected). The
CTK's `run_outcome` grammar (a single enum value per vector) cannot
express a terminate-on-`host_error` host, so a spec-permitted posture is
unrepresentable — **CTK expressibility gap; upstream agent-hooks issue
material.**

Secondary, MAF-side design question (upstream agent-framework issue
material): the halt keys on the `host_error:` reason prefix and so also
fires for composition-*produced* denies — `host_error:transform_conflict`
(AH-CTK-085) and `host_error:composition_disagreement` (AH-CTK-087) are
configured knob outcomes (§7.5), not enforcement-layer failures.
Distinguishing genuine infrastructure failure from composed policy
outcomes would reduce this divergence.

### F2 — AH-CTK-100 prescribes the reference host's blocked-tool transcript (1 vector)

The vector asserts that after a `post_tool_call` deny, the next
`pre_model_call` request has `messages[1].role == "tool"` with content
the exact string `"blocked: ctk:tainted-result"` — the in-tree
reference agent's transcript convention. Agent Framework instead
(a) retains the assistant function-call message that precedes the tool
result (required for protocol-valid transcripts on real chat APIs, so
the tool message sits at index 2), and (b) surfaces a structured
tool-error payload (`{"error": …, "reason": "ctk:tainted-result"}`)
rather than a `"blocked: <reason>"` string. §6.2 requires only that the
host "surface a tool error to the model" and prescribes no transcript
shape or payload format. The vector's actual §6.1 substance — the deny
record, the discarded (never re-executed, never incorporated) result —
is honoured. **CTK over-prescription; upstream agent-hooks issue
material.**

### F3 — observation (no vector failure): constructor-registered tools missing from `tools_registered`

The feature's `agent_startup` projection reads the run-level
`AgentContext.tools` and falls back to `getattr(agent, "tools", None)`,
but `agent_framework.Agent` stores constructor-registered tools in
`default_options["tools"]` (no `.tools` attribute), so
`agent_init.tools_registered` projects as `[]` for the
`Agent(tools=[...])` registration path. Tools supplied per run
(`Agent.run(..., tools=[...])`) project correctly; the harness uses that
path, which is why AH-CTK-001 passes. **Upstream agent-framework fix
material.**

## Harness description (per CLAIMS.md)

`harness.py` drives the framework's **production dispatch path** with
only model/tool I/O mocked; it re-implements no dispatch:

- A real `agent_framework.Agent` executes each scenario; the middleware
  bundle performs every per-run emission, verdict write-back, and block.
- The mock chat client (`_ScriptedChatClient`) subclasses the
  framework's own `BaseChatClient` + `ChatMiddlewareLayer` +
  `FunctionInvocationLayer` stack and returns `model_script[N]` for the
  Nth model call.
- Mock tools are real `FunctionTool`s over the vector's behavior tables
  (`result_parser=SKIP_PARSING` keeps scripted return values native);
  every invocation is recorded for `RunRecord.tool_invocations`.
- Default wiring is `create_agent_hooks_middleware` (one agent-hooks
  session per run; the middleware owns `agent_startup`/`agent_shutdown`).
  `create_agent_hooks_middleware_from_emitter` is used only where the
  vector requires emitter-level host configuration the first factory
  deliberately does not expose — zero registered interceptors
  (the factory rejects an empty list at construction) and
  `redact_for_approval` (§9 redaction seam) — with the harness then
  emitting the session brackets in the documented host role.
- Disclosed host presentation policy: the caller-visible output of a run
  is the final assistant message. An inner agent middleware (installed
  after, i.e. inside, the enforcement bundle) trims the run result to
  its final message *before* the `output` point guards it — the verdict
  covers exactly what egresses, and nothing bypasses the gate.
- `identity_provider: "ctk-fault"` maps to a custom provider whose
  compute function always raises (§10.1 provider-failure rule);
  interception records are captured via the factories' `record_sink` /
  the emitter's record sink.

## Disclosures

- `buffered_output: true` — a deny at `output` retracts nothing because
  nothing has egressed; streaming runs release content only after the
  combined verdict (§12.1a).
- Identity provider `jcs-sha256` is content-derived; vectors that pin
  `identity_provider: null` run identity-unbound for that vector only.
- Per CLAIMS.md: this report is not a security certification; it
  attests behaviour under hermetic CTK conditions only.
