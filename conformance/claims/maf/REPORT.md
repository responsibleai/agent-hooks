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

Corpus: the 51 `AH-CTK-*` vectors vendored in the `agent-hooks-sdk`
0.1.0a5 build (`agent_hooks.ctk/vectors`), byte-identical to
`responsibleai/agent-hooks` `conformance/vectors/` at `4f7af78`.

**This is a §13.1 conformance claim**: 100% of the vectors applicable
to the declared surface pass (47 of 47; the 4 skips are the
capability-gated `streaming/incremental` part a `buffered_output: true`
host never declares). The two CTK expressibility findings of the
earlier cross-validation run (F1/F2 below) were fixed upstream as
agent-hooks [#68](https://github.com/responsibleai/agent-hooks/issues/68)
/ [#69](https://github.com/responsibleai/agent-hooks/issues/69)
(PR [#72](https://github.com/responsibleai/agent-hooks/pull/72)); this
report supersedes the 33/47 cross-validation report recorded at
agent-hooks `af249da`.

## Environment

| Component | Version |
| --- | --- |
| agent-framework-core | 1.13.0 (`4b1afd9052`, `main`, via git; subdirectory `python/packages/core`) |
| agent-hooks-sdk | 0.1.0a5, built from source at `responsibleai/agent-hooks@4f7af78`, `[ctk]` extra |
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
  beyond-u64 vectors run rather than skip).
- **Posture (§13.1): `tool_seam_host_error: terminate`** — Agent
  Framework deliberately terminates the run when a `host_error:*` deny
  lands at `pre_tool_call`/`post_tool_call` (module docstring: "the
  enforcement layer itself failed, so continuing would be unreliable";
  pinned by its own unit tests). §6.2 permits this posture ("unless the
  host's own semantics terminate the turn"); the tool call is blocked
  exactly as §6.2 requires before the turn ends, and the 13 tool-seam
  `host_error:*` vectors resolve to `run_outcome: "blocked"` under this
  declaration. Plain (policy) denies at the tool seam continue the loop.
- **Composition (§7.2):** SDK default `sequential/first_deny`
  (`on_approval: stop`); all four profiles and every knob are host
  configuration, passed through the factories' `composition=` parameter.
- **Identity provider (§10.1):** `jcs-sha256` (content-derived) by
  default; custom providers and `null` (identity-unbound records,
  vector-scoped) supported.
- **Enforcement modes (§8):** `enforce` (default) and `evaluate_only`.
- **`buffered_output: true` (§12.1a):** streaming runs are buffered and
  gated (`ResponseStream.buffered_and_gated`); the complete response is
  assembled before `post_model_call` / `output` and nothing egresses to
  the caller ahead of the combined verdict. No incremental mediation is
  performed, so no §12.1 exposure bound applies, `incremental_output`
  is not declared, and the `streaming/incremental` part skips.
- **Known limitation (disclosed by the feature):** service-side (hosted)
  tools executed by the model provider never traverse the framework's
  function-invocation seam, so `pre_tool_call`/`post_tool_call` cannot
  intercept them; their calls and outputs surface in the
  `post_model_call` content projection, where they remain
  observable/deniable/transformable.

## Results (per part)

| Part | Passed | Failed | Skipped |
| --- | --- | --- | --- |
| approval_seam | 8 | 0 | 0 |
| composition/parallel_strictest | 3 | 0 | 0 |
| composition/parallel_unanimous | 2 | 0 | 0 |
| composition/sequential_first_deny | 2 | 0 | 0 |
| composition/sequential_run_all | 5 | 0 | 0 |
| enforcement/evaluate_only | 1 | 0 | 0 |
| enforcement/isolation | 1 | 0 | 0 |
| enforcement/post_action_deny | 1 | 0 | 0 |
| fail_closed/verdict_gate | 1 | 0 | 0 |
| identity_provider | 5 | 0 | 0 |
| record/decided_by | 1 | 0 | 0 |
| record/projection | 1 | 0 | 0 |
| streaming/incremental | 0 | 0 | 4 |
| unspecified | 15 | 0 | 0 |
| verdict/warnings | 1 | 0 | 0 |

Total: **47 passed, 0 failed, 4 skipped** of 51. All skips are the
`incremental_output` capability gate (`AH-CTK-110`–`AH-CTK-113`), the
honest surface of a buffering host.

## Findings

### F1 (resolved) — terminate-on-`host_error` posture, now declarable

The earlier cross-validation failed 13 vectors (AH-CTK-070–073, -085,
-087, -092, -094, -095, -097, -098, -102, -103) on exactly one
assertion each: `run_outcome == "blocked", want "completed"` — the
CTK's single-valued `run_outcome` could not express the
terminate-on-`host_error` posture §6.2 permits. Fixed upstream
(agent-hooks #68): the harness declares
`tool_seam_host_error: "terminate"` and
`expect.run_outcome_by_posture` resolves each vector to the single
outcome this declared surface must produce. All 13 pass, still pinning
the synthesized deny reason, slot/`decided_by` attribution,
`tool_not_invoked`, and the absent `post_tool_call`.

Secondary, MAF-side design question (upstream agent-framework issue
material, unchanged): the halt keys on the `host_error:` reason prefix
and so also fires for composition-*produced* denies —
`host_error:transform_conflict` (AH-CTK-085) and
`host_error:composition_disagreement` (AH-CTK-087) are configured knob
outcomes (§7.5), not enforcement-layer failures. Distinguishing genuine
infrastructure failure from composed policy outcomes would narrow the
declared posture's blast radius.

### F2 (resolved) — AH-CTK-100 now asserts substance, not transcript shape

The vector previously pinned the reference host's transcript cosmetics
(tool message at `messages[1]`, content exactly
`"blocked: ctk:tainted-result"`). Fixed upstream (agent-hooks #69): it
now asserts the §6.1/§6.2 substance — the denied tool result never
surfaces at the next `pre_model_call` in any form, the deny reason
surfaces to the model in some form, the tool ran exactly once, and the
deny record is correct. Agent Framework's protocol-valid transcript
(assistant function-call message retained, structured
`{"error": …, "reason": "ctk:tainted-result"}` payload) passes as-is.

### F3 — observation (no vector impact): constructor-registered tools missing from `tools_registered`

The feature's `agent_startup` projection reads the run-level
`AgentContext.tools` and falls back to `getattr(agent, "tools", None)`,
but `agent_framework.Agent` stores constructor-registered tools in
`default_options["tools"]` (no `.tools` attribute), so
`agent_init.tools_registered` projects as `[]` for the
`Agent(tools=[...])` registration path. Tools supplied per run
(`Agent.run(..., tools=[...])`) project correctly; the harness uses
that path, which is why AH-CTK-001 passes and why this observation
costs no vector in this report (confirmed: 0 failures above). Filed
upstream as
[microsoft/agent-framework#7560](https://github.com/microsoft/agent-framework/issues/7560);
a SHOULD-grade optional-field projection gap (§4.5), not
conformance-gated.

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

- **`tool_seam_host_error: terminate`** (non-default posture, §13.1):
  a `host_error:*` deny at the tool seam blocks the action and then
  terminates the run instead of continuing the loop. The 13 passing
  tool-seam vectors attest this posture's outcomes, not the default's.
- `buffered_output: true` — a deny at `output` retracts nothing because
  nothing has egressed; streaming runs release content only after the
  combined verdict (§12.1a).
- Identity provider `jcs-sha256` is content-derived; vectors that pin
  `identity_provider: null` run identity-unbound for that vector only.
- Per CLAIMS.md: this report is not a security certification; it
  attests behaviour under hermetic CTK conditions only.
