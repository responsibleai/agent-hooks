# Implementing Agent Hooks

What a harness or gateway maintainer takes on when it exposes the contract.

This guide is informative. The normative text is
[spec/AGENT-HOOKS-0.1.md](../spec/AGENT-HOOKS-0.1.md); section numbers
below point into it. Read it with
[conformance/HARNESS.md](../conformance/HARNESS.md), which covers the
test side in detail.

## What you are implementing

Implementing Agent Hooks means three things:

1. Emitting the wire contract: at each of the eight interception points
   your loop builds an `AgentContext`, hands it to the emitter, and acts
   on the verdict that comes back (§3 to §6).
2. Fixing host configuration: which composition profile runs, which
   identity provider, which approval resolver, which posture and
   timeouts, and which interceptors are bound where (§7 to §10). The
   host declaration document is the file form of this (§7.7).
3. Declaring a surface and proving it: the points, capabilities,
   profiles, provider and posture you support, tested by the CTK and
   recorded as a claim (§13).

The SDKs do the normative work for you. The Rust core validates
contexts and verdicts, applies transforms, composes verdicts,
computes identities and writes records; the Python, TypeScript, .NET
and Go SDKs bind it. What you write is the code between your loop and
the emitter: building contexts from your loop, calling the emitter at
the right moments, and obeying the result.

## Wire contract versus host configuration

The wire contract is what crosses between host and interceptor: the
`AgentContext` (§4), the `Verdict` (§5) and the `InterceptionRecord`
(§10.3). Its version is `agent-hooks/0.1`, stamped in every context's
`spec` member. Interceptors depend on it and nothing else.

Host configuration is everything the host decides about how
interceptors run: composition profile and knobs (§7.2), enforcement
mode (§8), identity provider (§10.1), approval resolver and redactor
(§9), posture (§13.1), timeouts (§7), and which interceptor runs at
which point. Interceptors do not see it. Records stamp the parts of it
that explain a decision: the profile and resolved knobs, the provider,
the mode, and the declaration version when a declaration built the
emitter.

Keep the two apart in your code. The wire contract changes with the
spec. Host configuration changes with your deployment, and the
declaration document lets it travel over a settings channel you
already have.

## The host declaration document

A host declaration is one JSON document the host loads at startup
(§7.7). It carries three blocks:

- `configuration`: mode, composition, identity provider, approval
  resolver and redactor references, posture, timeouts, record buffer
  bound.
- `surface`: the points you emit, your capabilities, the profiles and
  knob values you support, your streaming posture, and the contract
  versions you accept.
- `bindings`: an ordered list of `{id, kind, config, at, timeout_ms}`.

The document has its own version, `agent-hooks-declaration/1.0`,
written in the required `declaration` member. It moves independently
of the wire version and of package versions
([spec/DECLARATION-VERSIONS.md](../spec/DECLARATION-VERSIONS.md)).

### What the host does

Register, in code, what a document may name:

- a resolver per binding `kind`, a function from `config` to one
  interceptor;
- any custom identity provider, approval resolver or approval redactor
  by name;
- the surface your code supports (`HostSurface`).

Then build the emitter from the file path, from JSON text, from a
parsed value, or from a builder in code. All four go through one
loader and yield the same emitter and the same records (§7.7.7).
Hosts that construct the emitter with the constructor and setters
stay conformant; their records carry no `declaration` member.

### What a kind is

A kind is a namespaced lookup key you control, for
example `com.example.egress`. The loader never treats it as a path,
class name, URL or module. The spec defines no kinds. Your resolver
validates its own `config`, refuses what it does not understand, and
never echoes the config in an error, because load errors are logged
and config may hold secrets (§7.7.5).

### What fails at load

The loader refuses a document that names
anything your code cannot honour: a point you do not emit, a profile
or knob value you do not support, a capability you lack, a provider or
resolver you did not register, a kind with no resolver, a version it
does not accept, an unknown member, or a knob under a profile that
does not consult it. Refusal is a construction error with one of
eleven `declaration_error:*` classes, a list of findings with JSON
pointers, and for an unsupported version the accepted set. It happens
before any emission and leaves no record. Nothing is narrowed,
defaulted past the code, or applied in part (§7.7.6). After a
successful load the emitter is sealed: registration and
reconfiguration are refused, so the document is what ran.

### Versioning

A loader accepts a published set of contract versions
and refuses every other value, including a higher minor it has not
seen. Within an accepted version the schema is closed, so a newer
document is never misread by an older loader. Log the contract
version, the document `id` and its `jcs-sha256` digest once at load
so an operator can match a running host to a pushed document
(§7.7.2, §7.7.8).

## The surface declaration and the claim

Your surface (§13.1) is the set of behaviours you ask the CTK to test:

- capabilities: `model_calls`, `tool_calls` and the others in
  `conformance/vectors.schema.json`, including `host_declaration`,
  which you declare when you build the emitter through the loader;
- the composition profiles and knob values you support;
- your identity provider;
- your posture, `tool_seam_host_error: continue | terminate`;
- `buffered_output`, and the exposure bound when it is `false`.

Declare only what your code does. The CTK skips vectors whose
capabilities you do not declare and runs every other one. A host that
does not call models omits the model points and `model_calls`; it
must still emit `agent_startup`, `input`, `output` and
`agent_shutdown` (§3.2).

You can present the surface in code (the `Harness` methods) or as the
`surface` block of a host declaration with every member written out.
When a claim cites a document, the CTK resolves that document against
your code surface before any vector runs and assesses the run against
the resolved surface, so what the CTK tested is what the claim cites
(§7.7.9).

A claim is the tuple `(framework, adapter version, agent-hooks/0.1,
capabilities, profiles, identity provider, sdk@version)` plus the CTK
report, filed in [conformance/CLAIMS.md](../conformance/CLAIMS.md)
(§13.3). It states any non-default posture, a `null` provider,
`buffered_output: false`, and the declaration file it cites. A claim
is not a security certification. It says which vectors ran and passed
against the surface you declared.

## What the host does at each point

Build a context with the SDK's `AgentContextBuilder` so the envelope
(§4.1) and the per-point fields (§4.2) are right, call `emit`, then
act on the combined verdict (§6):

| Point | Build | On `allow` or `transform` | On `deny` |
| --- | --- | --- | --- |
| `agent_startup` | once, before the first input | start the session | process no input; still emit `agent_shutdown` with `summary.reason: error` (§6.1a) |
| `input` | each request entering the session | begin the turn with the (possibly rewritten) input | do not begin the turn |
| `pre_model_call` | before each model request | send the (possibly rewritten) messages | do not send; do not emit `post_model_call` (§6.2) |
| `post_model_call` | after each model response | use the (possibly rewritten) response | discard the response as if it had errored; do not retry (§6.1) |
| `pre_tool_call` | before each tool invocation | invoke with the (possibly rewritten) args | do not invoke; surface a tool error to the model and continue (§6.2), or end the turn for a `host_error:*` deny under the `terminate` posture (§13.1); do not emit `post_tool_call` |
| `post_tool_call` | after each tool invocation, success or error | use the (possibly rewritten) result; echo the args as sent | discard the result; do not re-invoke (§6.1) |
| `output` | before the final response leaves | return the (possibly rewritten) output | do not return it |
| `agent_shutdown` | once, at the end | close the session | record it; nothing left to prevent, and never consult approval here (§6.1a) |

Rules that hold at every point:

- Emit in order, with `sequence` strictly increasing within a session
  and each `pre_*` paired with exactly one `post_*` unless blocked
  (§3.1).
- A `transform` rewrites the point's target only (§4.3, §5.2). In
  `enforce` mode the SDK applies it to the context you passed; proceed
  with the rewritten value, never the original.
- A liftable deny (a deny with an `approval` block) is still a deny
  until the approval seam lifts it (§9). Without a registered resolver
  it stays a deny.
- Buffer `output` until the verdict permits, or declare
  `buffered_output: false` and state in your claim that a deny at
  `output` cannot retract streamed content (§12.1a).
- Persist the records. They are the audit trail, payload-free by
  construction, and the in-memory buffer drops the oldest when full
  (§10.3).

## What fails closed

The contract has no silent fallback. Each of these yields a deny with
a reserved reason, or a refusal before anything runs:

| Condition | Result |
| --- | --- |
| The host cannot build a valid context | `deny host_error:context_invalid`, no interceptor runs (§6.3) |
| An interceptor raises or panics | `deny host_error:interceptor_failed` in that interceptor's slot (§6.3) |
| An interceptor exceeds the timeout | `deny host_error:interceptor_timeout` (§6.3) |
| An interceptor returns an invalid verdict | `deny host_error:verdict_invalid` (§6.3) |
| A transform targets a forbidden path or fails to apply | `deny host_error:transform_target_forbidden` or `transform_invalid` (§5.2) |
| Parallel verdicts conflict or disagree | `deny` per the profile's knob, or an approval (§7.5) |
| The approval resolver fails, times out, or echoes the wrong identity | `deny host_error:approval_resolver_failed` or `approval_identity_mismatch` (§9) |
| Nothing is bound at the emitted point in `enforce` mode | `deny host_error:no_interceptor` (§7) |
| The identity provider raises | `deny host_error:context_invalid` before dispatch (§10.1) |
| A host declaration names anything the code cannot honour | refused at load with a `declaration_error:*` class; no emitter, no record (§7.7.6) |

A passthrough is an explicit allow-all interceptor you register on
purpose, never the absence of one. `evaluate_only` mode records
verdicts without acting on them and must never be reported downstream
as enforcement (§8).

## Running the CTK

1. Implement the `Harness` interface in the SDK you ship with. The
   harness drives your production dispatch path with model and tool
   I/O mocked; a harness that re-implements dispatch does not test your
   host.
   See [conformance/HARNESS.md](../conformance/HARNESS.md) for the
   interface in each language.
2. Declare your surface: capabilities, posture, and either the
   `Harness` surface methods or your declaration document. A harness
   that declares `host_declaration` also implements the declaration
   seam (`setup_declared` or its local name) and builds its emitter
   through the loader from the document and registry the runner
   supplies.
3. Run the vectors. In Python:

   ```bash
   pip install --pre "agent-hooks-sdk[ctk]"
   pytest --agent-hooks-harness=your_pkg:YourHarness
   ```

   The other SDKs ship their runner under `sdk/<lang>/` (§13.2);
   [conformance/HARNESS.md](../conformance/HARNESS.md) gives the
   `Harness` interface in each language.
4. Read the report. It lists, per part, which vectors ran, passed,
   failed or were skipped, and why. Fix every failure; a skip is
   acceptable only when the capability it needs is one you do not
   declare.
5. File the claim in [conformance/CLAIMS.md](../conformance/CLAIMS.md)
   with the report, the harness description, the disclosure flags, and
   the declaration file when you cite one.

## Checklist

- The eight points are emitted in order with a valid envelope, or the
  four lifecycle points plus the pairs your host performs.
- Every combined verdict is obeyed per §6, including the post-action
  discard rule and the shutdown rule.
- Host configuration is written down: in code, or in a host
  declaration the host loads and logs.
- The surface you declare is the surface your code has; the loader
  refuses anything else.
- Records reach a sink. `records_dropped` is monitored.
- The CTK passes on your declared surface, and the claim says what it
  covers.

## Related

- [PRODUCTION.md](PRODUCTION.md): the decisions to make before you run
  in production.
- [OPERATIONS.md](OPERATIONS.md): failure reasons, rollout, alerting.
- [THREAT-MODEL.md](THREAT-MODEL.md): what the contract does and does
  not defend against.
- [INTEROP.md](INTEROP.md): how the points map onto MCP and A2A.
