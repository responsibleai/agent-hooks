# Implementing a CTK Harness

A **harness** is the ~100-line shim a framework author writes once so the
agent-hooks CTK can drive that framework through the conformance vectors. The
harness owns three responsibilities:

1. **Wire the scenario.** Inject the vector's mock model (a deterministic
   response script) and mock tools (a `name → args → return` lookup table)
   into the framework so a run is hermetic — no real LLM, no real I/O.
2. **Register the interceptor.** Attach the CTK-supplied `Interceptor` (a
   `ScriptedInterceptor` that records every `AgentContext` and replays the
   vector's `interceptor_script`) at every interception point the framework supports.
3. **Run and report.** Execute one agent session and return a `RunRecord`
   describing what happened.

The CTK runner handles everything else: loading vectors, building the
scripted interceptor/resolver, schema-validating recorded contexts, and asserting
`expect`.

## Interface (per language)

The exact signature is defined per SDK. The Python shape is canonical:

```python
from agent_hooks import Interceptor, ApprovalResolver, EnforcementMode
from agent_hooks.ctk import Harness, Scenario, RunRecord, Capability

class MyFrameworkHarness(Harness):
    name = "my-framework"
    capabilities = {Capability.MODEL_CALLS, Capability.TOOL_CALLS}

    def setup(
        self,
        scenario: Scenario,
        interceptors: list[Interceptor],
        resolver: ApprovalResolver | None,
        mode: EnforcementMode,
        composition: CompositionConfig,
        identity_provider: str | None,
    ) -> None:
        # 1. Build a mock model from scenario.model_script
        # 2. Build mock tools from scenario.tools (record every invocation!)
        # 3. Construct your framework's agent with those mocks
        # 4. Register `interceptors` (in order) so they receive an
        #    AgentContext at every interception point
        # 5. Register `resolver` as the approval seam (if your framework
        #    supports lifting deny+approval verdicts)
        # 6. Set enforcement mode, the vector's composition profile
        #    (§7.2), and its identity provider ("jcs-sha256" or None,
        #    §10.1)
        ...

    async def run(self) -> RunRecord:
        # Execute one session with scenario.input. Catch InterceptionBlocked.
        # Return outcome, final_output, the tool-invocation log captured by
        # your mock tools, and — from your emitter — the per-emission
        # identity pairs and wire-shaped InterceptionRecords (§10.3; they
        # power expect.identities_equal and expect.records).
        ...

    def teardown(self) -> None:
        ...
```

Equivalent interfaces ship in `sdk/typescript/src/ctk/harness.ts`,
`sdk/dotnet/src/AgentHooks.Conformance/IHarness.cs`,
`sdk/go/conformance/harness.go`, and `sdk/rust/core/src/ctk.rs (`ctk` feature)`.

## Mock model

`scenario.model_script` is an ordered list of responses. The Nth
`pre_model_call` your framework dispatches MUST receive `model_script[N]` as
its response. Your mock model implementation is typically a closure over a
counter.

## Mock tools

`scenario.tools[].behavior` is a list of `{when_args?, return, is_error?}`
clauses evaluated top-down; the first whose `when_args` deep-equals the
invocation args (or has no `when_args`) wins. **Your mock MUST record every
invocation** `{name, args}` into a list the harness returns in
`RunRecord.tool_invocations` — this is how the CTK proves a `transform` was
actually honoured independently of what the host *reports* in
`post_tool_call`.

## Capabilities

Declare only what your framework actually does. A vector whose
`capabilities` are not a subset of yours is **skipped**, not failed. The
mandatory baseline is `{}` (lifecycle only: `agent_startup`, `input`,
`output`, `agent_shutdown`).

`int64_json` declares that your harness *language* can hold integers
beyond 2^53 from vector JSON losslessly (§4.4). JavaScript harnesses
omit it (`JSON.parse` rounds before any guard can run); Go harnesses
need `json.Number` decoding to claim it (see `conformance/runner.go`).

`bigint_json` is the stronger form: integer tokens beyond u64/i64
survive your JSON layer byte-faithfully (Python `int`, Go
`json.Number`, .NET `JsonNode`). Rust harnesses omit it — `serde_json`
coerces such literals to a double at load — which is exactly the
coercion class the core's raw-text scan (§10.2) exists to reject; see
`AH-CTK-091`.

`buffered_output` (§12.1a) is **declaration-only**: it defaults to
`true` (the host buffers caller-bound output until the `output`
combined verdict permits), and a host that streams to its caller
without buffering declares `buffered_output: false` in its surface and
claim. The CTK drives hosts with mocked I/O and cannot exercise
streaming egress, so no vector carries this capability — the
declaration exists to make the retraction limitation visible (§13.3).

Non-finite floats (NaN/Infinity) and lone surrogates cannot be
expressed in a JSON vector at all — those §4.4 marshalling guards are
pinned by per-SDK unit tests, not vectors.

## Running

```bash
# Python
pytest --agent-hooks-harness=my_pkg.MyFrameworkHarness \
       --agent-hooks-vectors=path/to/conformance/vectors
```

See per-language `sdk/<lang>/README.md` for the equivalent invocation.
