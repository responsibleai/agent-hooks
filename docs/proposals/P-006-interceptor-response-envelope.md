# P-006: A transport response envelope around canonical Verdict

**Status:** **Decided** 2026-10-15 — Option D adopted as recommended, with
`extensions` as the only metadata carrier and provider receipts nested under their
provider namespace.
**Raised by:** Liam Crumm, for hosted integrations returning a canonical control
decision together with provider-specific evaluation receipts.

## The gap

Agent Hooks defines one closed control result:

```text
intercept(context: AgentContext) -> Verdict
```

That is the right in-process contract. A host needs one unambiguous decision and must
not allow transport metadata to change `allow`, `deny` or `transform`.

Hosted and cross-process integrations often need to return additional data alongside
the Verdict:

- an evaluation receipt proving which policy revisions were executed;
- a request or context binding;
- capability/freshness evidence;
- billing, correlation or service diagnostics;
- a signed proof over the decision and its authority state.

Today those APIs have three unsatisfactory choices:

1. return a bare Verdict and lose the additional response contract;
2. place provider fields inside Verdict, violating its closed schema;
3. return an ad hoc wrapper such as `{ "verdict": ..., "receipt": ... }`, requiring
   every consumer to know that it must extract `verdict` before using an Agent Hooks
   Verdict parser.

The third option is safe when implemented carefully, but Agent Hooks does not name or
standardize it. A generic Agent Hooks transport client therefore cannot deserialize
the whole response even though the control decision itself is canonical.

This problem is not specific to one cloud or policy engine. Any remote interceptor may
need a receipt while preserving one portable Verdict.

## Goals

1. Keep canonical `Verdict` closed and unchanged.
2. Define one optional transport envelope that can carry a canonical Verdict plus
   non-authoritative response data.
3. Let existing `{ verdict, receipt }` wrappers migrate receipts into a provider namespace.
4. Give SDKs one parser that safely accepts both a bare Verdict and the envelope.
5. Keep receipts out of host composition and enforcement semantics.
6. Preserve strict unknown-member rejection at the envelope boundary.

## Non-goals

- Standardizing policy-resource IDs, epochs, signatures or receipt contents.
- Turning receipts into passive telemetry or adding them to `InterceptionRecord`.
- Allowing arbitrary extra members on Verdict.
- Changing the in-process `Interceptor` callable or any composition profile.
- Requiring every interceptor or transport to emit a receipt.

## Options

### A. Keep wrappers outside Agent Hooks

Every hosted API defines its own envelope and tells callers which property contains the
Verdict.

**Advantages**

- No spec or SDK work.
- Agent Hooks stays limited to the in-process control surface.

**Costs**

- Generic transport clients cannot recognize a common response shape.
- SDK documentation can easily claim a method returns Verdict when it actually returns
  an envelope.
- Each API reinvents unknown-member, metadata and fail-closed parsing rules.

### B. Open Verdict to arbitrary additional properties

Allow provider metadata directly on Verdict.

**Advantages**

- Existing Verdict parsers could accept one flat response object.
- Minimal wrapper ceremony.

**Costs**

- Destroys the closed decision boundary.
- Creates collisions with future Agent Hooks members.
- Makes it unclear whether a member affects enforcement.
- Weakens closed discriminated unions in generated SDKs.

This option is rejected.

### C. Add optional `receipt` and `extensions` members to Verdict

Keep known members but expand Verdict itself.

**Advantages**

- One object crosses every boundary.
- Receipt is easy to discover.

**Costs**

- Still changes the canonical Verdict wire shape and every SDK type.
- In-process interceptors pay for transport concerns.
- Composition and record code must explicitly strip transport members.

### D. Define a separate transport response envelope

**Recommended.**

Keep `Verdict` unchanged. Define a disjoint `InterceptorResponse` object:

```json
{
  "verdict": {
    "decision": "deny",
    "reason": "policy_denied"
  },
  "extensions": {
    "provider_name": {
      "receipt": {
        "receiptVersion": "provider-contract/1.0",
        "evaluationId": "evaluation-123"
      },
      "requestId": "request-456"
    }
  }
}
```

`verdict` is required. `extensions` is optional. When there are no extensions,
a bare Verdict is the simpler representation.

The envelope and Verdict are structurally disjoint: Verdict requires `decision`, while
the envelope requires `verdict` and forbids `decision` at its root.

## Recommended normative semantics

### 1. Two distinct parsers

SDKs retain the strict Verdict parser:

```text
parse_verdict(value) -> Verdict
```

It accepts only the closed §5 Verdict and continues to reject an envelope.

SDKs add:

```text
parse_interceptor_response(value) -> InterceptorResponse
```

It accepts either:

- a bare §5 Verdict, normalized to `{ verdict: value }`; or
- the response envelope defined below.

This distinction prevents existing code that promises "Verdict only" from silently
accepting transport metadata, while giving hosted clients a standard Agent Hooks-aware
response parser.

### 2. Envelope shape

```json
{
  "verdict": "<required canonical Verdict>",
  "extensions": {
    "<namespace>": "<any JSON>"
  }
}
```

Rules:

- the root is closed: only `verdict` and `extensions` are allowed;
- `verdict` MUST pass every §5 validation rule;
- `extensions`, when present, follows the §4.6 namespace grammar
  `^[a-z][a-z0-9_]*$` and its reserved namespaces (`acs`, `ctk`, `agent_hooks`);
- duplicate JSON members at every object level of raw JSON text MUST be rejected;
  an already-parsed value cannot expose duplicates collapsed by its receiving parser;
- the RFC 8785 canonical JSON size of the complete `extensions` object, including
  namespace keys and all provider data, MUST NOT exceed 65536 bytes,
  independently of the 10240-byte §5.3 evidence cap;
- Extension values MUST satisfy the §4.4 I-JSON domain. Integer literals
  outside ±(2^53−1) are rejected; producers must string-encode larger integers.
- SDKs re-serialize extension data as I-JSON, without interpreting it or
  moving it into Verdict. They do not preserve original bytes or number spellings.
  Providers signing receipts must define and use a canonical form, not transport bytes.

The envelope has no independent version member. Like Verdict, its version is the Agent
Hooks spec version selected by the surrounding transport or the `AgentContext.spec`
used for the evaluation. A provider receipt can carry its own contract version.

### 3. Enforcement boundary

Only `response.verdict` participates in §6–§9 enforcement and composition.

- A receipt or extension MUST NOT make a deny liftable, alter a transform, add result
  labels or change warning unioning.
- A host MUST validate/extract the Verdict before composition.
- A host that cannot parse the response form MUST deny with
  `host_error:verdict_invalid` under §6.3.
- A transport that selects the response gate through its documented API contract
  MUST fail closed when the envelope,
  or extensions violate this contract, even if the nested Verdict alone is
  valid.

The last rule prevents a caller from receiving a success-shaped decision with malformed
transport metadata. Provider-specific trust or signature checks remain outside this gate.

### 4. In-process and remote boundaries

The canonical in-process `Interceptor` callable remains:

```text
intercept(context) -> Verdict
```

A remote-backed in-process adapter:

1. parses the remote body with `parse_interceptor_response`;
2. returns the normalized `.verdict` to the host emitter;
3. sends `.extensions`, if needed, to the adapter's own transport or
   audit consumer.

Agent Hooks does not require hosts to persist these fields and does not add them to the
payload-free `InterceptionRecord`.

### 5. Receipt opacity and provider schemas

Providers carry receipts under `extensions.<provider>.receipt`, never at the envelope
root. Each provider owns its namespace, so two providers can carry receipts without
colliding and consumers know which provider produced the data. A generic client must
know the provider's namespace to locate its receipt.

Agent Hooks treats these values as opaque I-JSON and does not claim that a receipt is
signed, current or trustworthy. Receipts share the single 64 KiB bound with all other
extensions, have no enforcement effect and are re-serialized, not byte-preserved.
Providers signing receipts define the canonical form covered by their signatures.

Providers SHOULD publish a closed schema for their receipt and SHOULD bind it to the
request/context and nested Verdict when it is used as evidence. Those provider rules
are outside Agent Hooks conformance.

The generic SDK type therefore exposes namespaced JSON values. Generated service SDKs
MAY use stricter provider-specific types within their namespace while retaining the
same envelope.

## Adopted schema

The adopted schema is
[`spec/schema/interceptor-response.schema.json`](../../spec/schema/interceptor-response.schema.json).
That file is the single schema definition; the proposal does not maintain a second copy.

The 64 KiB extensions bound is enforced by SDK parsers because JSON Schema
cannot express RFC 8785 byte length.

## SDK surface

Each SDK gains:

- `InterceptorResponse` with `verdict` and optional namespaced `extensions`;
- `parse_interceptor_response` / idiomatic equivalent;
- construction from a bare Verdict;
- serialization that emits the envelope only when extensions are nonempty.

`Interceptor.intercept` and emitter registration continue to use Verdict.

## Conformance and tests

This optional artefact does not change host CTK execution. Cross-language fixtures
should live alongside schema/golden tests and cover:

| Case | Expected result |
| --- | --- |
| bare allow Verdict | accepted and normalized |
| bare deny/transform Verdict | accepted and normalized without mutation |
| envelope with Verdict only | accepted; serializer SHOULD prefer bare Verdict |
| envelope with typed provider receipt | accepted and re-serialized as I-JSON |
| envelope with namespaced extensions | accepted and preserved |
| two provider receipts | accepted under distinct namespaces |
| an existing `{ verdict, receipt }` wrapper | rejected; migrate receipt to `extensions.<provider>.receipt` |
| unknown root member | rejected |
| root `decision` plus `verdict` | rejected |
| missing or invalid nested Verdict | rejected |
| non-object extensions | rejected |
| invalid extension namespace | rejected |
| duplicate root/extension/namespaced receipt member | rejected |
| metadata above 64 KiB | rejected |
| receipt fields attempting to override decision | ignored for enforcement; nested Verdict wins |

Every language must use the same fixture corpus so generated and handwritten clients
agree.

## Security and privacy

| Risk | Treatment |
| --- | --- |
| Provider field collides with a future Verdict member | Metadata is outside Verdict; root is closed |
| Receipt changes enforcement | Only nested Verdict reaches composition |
| Consumer validates only Verdict and misses malformed extensions | Declared envelope parser rejects the whole response |
| Receipt leaks target content into canonical records | Receipt is not added to `InterceptionRecord` |
| Unbounded metadata causes memory/log amplification | 64 KiB canonical-byte bound |
| Arbitrary extension names collide | Existing namespaced grammar |
| Bare Verdict callers accidentally accept envelopes | Strict Verdict parser remains separate |

Transport authentication, signatures and receipt retention remain provider/host
concerns under §1.4 and §14.

## Compatibility and versioning

This is a new optional artefact under `spec/` with its own schema. Per
`VERSIONING.md`, that is a spec-minor addition rather than a Verdict-shape change.

- Existing valid Verdict JSON and Verdict-only APIs remain unchanged.
  The strict gate also fixes unknown-member and duplicate rejection to match the
  existing closed schema; this does not make envelopes valid Verdicts.
- Existing in-process interceptors remain unchanged.
- Hosted APIs can adopt the envelope without adding provider members to Verdict.
- APIs already returning `{ verdict, receipt }` migrate the receipt into
  `extensions.<provider>.receipt`.
- Clients that need only a Verdict can continue extracting `verdict` explicitly or use
  the new normalizing parser.

## Rejected shortcuts

- `additionalProperties: true` on Verdict.
- Silently ignoring unknown envelope root members.
- Putting receipts into `evidence`; evidence is a bounded offline-verifiable pointer,
  not an arbitrary transport response.
- Adding receipts to `InterceptionRecord`.
- Treating a provider receipt as authoritative merely because it used this envelope.

## Decision

The implementation adopts option D with the maintainer's requested shape:

- Use namespaced `extensions` as the only carrier; provider receipts live under
  `extensions.<provider>.receipt`. The root has only `verdict` and `extensions`.
- Accept an envelope with only `verdict`.
- Limit the canonical extensions object to 64 KiB across all namespaces.
- Prefer a bare Verdict when there is no extension data.
- Carry I-JSON values, not original receipt bytes; reject unsafe integer literals.

These choices record the maintainer's October 15, 2026 decision and define the
accepted spec section, schema and public SDK surface.
