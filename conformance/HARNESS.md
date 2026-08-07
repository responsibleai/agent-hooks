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
scripted interceptor/resolver, validating every recorded context against the full §4 envelope (required-core types plus per-point conditional fields — the same check the emitters run), and asserting
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

`incremental_output` gates the `streaming/incremental` vector part
(`AH-CTK-110`–`AH-CTK-113`), which exercises the §12.1 exception's
accounting discipline against a mocked stream (see "Incremental
mediation" below). Declare it only when your host declares
`buffered_output: false` **and** mediates `post_model_call`
incrementally with watermark-gated release (declared exposure bound:
none — the posture ACS §18.1 calls `blocking`); the vectors pin that
posture's deterministic release points, so a host with a looser bound
does not declare the capability and skips the part. A buffering host
never declares it.

Non-finite floats (NaN/Infinity) and lone surrogates cannot be
expressed in a JSON vector at all — those §4.4 marshalling guards are
pinned by per-SDK unit tests, not vectors.

## Postures

Where the spec permits two host behaviors, the harness **declares**
which one its host implements and the runner selects the single
expected outcome for that declared surface — a vector never accepts
"either outcome", so a pass always attests one specific behavior.

`tool_seam_host_error: continue | terminate` (default `continue`)
declares what the host does with the run after a `host_error:*` deny
at `pre_tool_call`/`post_tool_call` (§6.2): `continue` surfaces a tool
error to the model and keeps the loop going; `terminate` means the
host's own semantics terminate the turn — the posture §6.2's "unless
the host's own semantics terminate the turn" clause permits. Vectors
whose run ends in such a deny carry `expect.run_outcome_by_posture`,
and the runner resolves it against this declaration (forwarded in the
run-record wire as `postures.tool_seam_host_error`).

Declare it per SDK convention: a `tool_seam_host_error` attribute
(Python), `toolSeamHostError` (TypeScript), the optional
`ToolSeamHostErrorDeclarer` interface (Go), the `ToolSeamHostError`
property (default interface member, .NET), or the
`tool_seam_host_error()` trait method (Rust). Omitting it declares
`continue` — the posture every in-tree reference harness implements.
The declaration belongs in the host's §13.3 claim alongside its
capabilities.

## Incremental mediation

Vectors in the `streaming/incremental` part carry a chunked mock
stream: `respond.stream` is an ordered list of chunks whose
concatenation equals `respond.content`. A harness declaring
`incremental_output` MUST drive them as follows:

- The mock model delivers the chunks in order. Each chunk boundary
  closes one evaluated segment, and the host emits one
  `post_model_call` per segment over the **assembled prefix** through
  that chunk: `response.content` is the prefix, `response.finish_reason`
  is `"incremental"` for a non-final segment and the scripted
  `finish_reason` for the final one. Each emission is an ordinary
  `post_model_call` (§12.1); the scripted interceptor answers each.
- Release is watermark-gated: a permitted segment's text egresses on
  its verdict; a `deny` terminates the stream, withholds everything
  not yet released, and stops chunk consumption.
- `respond.stream_truncated: true` means the stream dies abnormally
  after the listed chunks: the final chunk is a partial segment no
  emission covers, and the scripted `finish_reason` never arrives. The
  host MUST fail closed per §12.1 exception item 3 — a
  `post_model_call` over the full delivered assembly with
  `response.finish_reason: "stream_incomplete"` and a deny
  self-verdict `host_error:streaming_unsupported` — withholding and
  not persisting the residue. The vectors assert the record, not
  whether interceptors observe that emission (host-defined, as with
  provider faults).
- The `RunRecord` grows two fields for this part: `released_output` —
  the caller-visible content the host actually egressed, in order
  (distinct from `final_output`, which stays null on a blocked run) —
  and `persisted` — a serialization of every durable incorporation the
  host made for the session (conversation history, session stores).
  `expect.released_output` is compared exactly;
  `expect.persisted_must_not_contain` asserts substrings that must not
  appear in `persisted`. A host that persists nothing reports an empty
  value and satisfies the durability assertions vacuously, which is
  the always-safe §6.1 posture.

No in-tree reference harness declares `incremental_output` yet (every
reference harness buffers), so runner-side assertion support for
`released_output`/`persisted_must_not_contain` lands with the first
declaring host; the part is capability-gated precisely so it stays
inert for every buffered surface until then.

## Running

```bash
# Python
pytest --agent-hooks-harness=my_pkg.MyFrameworkHarness \
       --agent-hooks-vectors=path/to/conformance/vectors
```

See per-language `sdk/<lang>/README.md` for the equivalent invocation.

## Provider faults and envelope validation

- `identity_provider: "ctk-fault"` in a vector means the harness MUST
  declare a custom provider named `ctk-fault` whose compute function
  fails on every call. It pins the §10.1 provider-failure rule: the
  emission is denied `host_error:context_invalid` before any
  interceptor runs, with null identities and the declared provider
  name on the record.
- Hosts validate the §4 envelope before dispatch (§10.2). The CTK
  cannot express an invalid envelope through a scenario (harnesses
  construct valid contexts by design), so envelope rejection is pinned
  by core and per-SDK emitter tests rather than vectors.
- `resolved_by` on asserted records distinguishes `"approval"`
  (permit substitution) from `"rejection"` (consulted, not lifted);
  absent means the seam was never consulted (§10.3).

## Coverage boundaries

Some normative behavior cannot be expressed in the vector grammar and
is pinned by per-SDK unit tests instead:

- **NaN/Infinity marshalling guards (§4.4)** — not representable in a
  JSON vector file.
- **§12.1 streaming assembly (buffered path)** — for a buffering host
  the scenario grammar has no partial-stream form, so the
  assemble-before-`post_model_call` rule and its fail-closed
  `host_error:streaming_unsupported` path remain host obligations the
  mocked model cannot exercise. The *incremental* path is different:
  the `streaming/incremental` part drives it through `respond.stream`
  for hosts declaring `incremental_output` (see "Incremental
  mediation"), including the residue fail-closed shape (`AH-CTK-112`).
- **§12.2 concurrent emissions** — vectors run single-threaded;
  sequence-uniqueness under concurrency is a per-SDK unit test.
- **Multi-turn sessions (§3.1)** — the scenario grammar carries one
  `input`; multi-turn ordering is pinned by emitter unit tests.
- **§5.4 result_labels persistence/resurfacing** — requires label
  storage in the harness agent; not yet implemented in the reference
  harnesses.
