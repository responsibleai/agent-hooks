# P-002: Which JSON values can carry a stable context identity?

**Status:** Superseded by
[P-004](P-004-identity-as-optional-seam.md) (decided 2026-07-09).
Identity became a pluggable provider seam; the I-JSON rejection rules
became the contract of the default `jcs-sha256` provider rather than a
wire mandate. The SDK marshalling guards, the SHOULD-level 64-bit
string-encoding guidance, and the tier rename survive unchanged.
**Raised by:** 2026-07-07 architectural review.

## Background: what RFC 8785 can and cannot represent

§10.1 adopts RFC 8785 (JCS). JCS defines canonical bytes only for
**I-JSON** (RFC 7493) data: the interoperable JSON subset. Three value
classes fall outside it:

| Class | Reality | Why it matters here |
| --- | --- | --- |
| **NaN / Infinity** | *Not JSON at all.* RFC 8259 has no literal for them; they can only arise **before** wire encoding, when a host's native float NaN hits the SDK's `json.dumps`/`JSON.stringify`/serde step. Python emits the invalid literal `NaN` (core parse then fails); JavaScript emits `null` (silent value change); serde/Go error out. | Today the failure mode is *per-language-accidental*: one SDK corrupts, others reject. Cross-SDK identity is moot because the value never canonicalizes uniformly. **Verdict: not a big deal on the wire, but the pre-marshalling divergence must be pinned.** |
| **Integers > 2⁵³** | Valid JSON text (`9007199254740993`), but JCS numbers are IEEE-754 doubles: canonicalization rounds to `9007199254740992`. Two distinct tool-arg IDs can hash to the same identity (non-injective), and a JS interceptor already sees the rounded value. | Real risk: 64-bit database/snowflake IDs in `tool_call.args`. Silent rounding means *the value the interceptor evaluated differs from the value the tool executes* — an integrity hole, not just a hash quirk. |
| **Lone surrogates** in strings | Valid in some languages' strings (JS, Python surrogateescape) but not valid Unicode; UTF-8 encoders differ (error vs U+FFFD replacement). | Identity divergence across SDKs; rare in practice (malformed input, binary-in-string smuggling). |

## Is there another standard that handles these?

Surveyed alternatives:

- **RFC 7493 (I-JSON)**: not an alternative canonicalization — it is
  the *constraint profile* JCS assumes. Its guidance: numbers needing
  >IEEE-754 precision and binary data **SHOULD be encoded as strings**.
- **CBOR + RFC 8949 §4.2 deterministic encoding**: handles big ints
  and NaN natively. Rejected: moves the whole wire format off JSON —
  disproportionate to the edge cases.
- **JSON Schema `format: int64` / string-encoded 64-bit ints**: the
  protobuf/JSON mapping convention (proto3 encodes int64 as decimal
  strings) — the de-facto industry answer for the >2⁵³ class.
- **ECMA-262 `JSON.stringify` semantics**: what JCS already uses;
  offers no escape for these classes.

Conclusion: there is no drop-in canonicalization that keeps JSON and
absorbs all three classes. The proto3 convention (string-encode 64-bit
integers) plus I-JSON constraints is the established path.

## Options

### A. Reject at the boundary (fail closed)

Core context parsing rejects contexts containing non-I-JSON values →
`deny host_error:context_invalid`.

| Pros | Cons |
| --- | --- |
| Fail-closed matches §1.3; no silent value change anywhere. | Hosts with 64-bit IDs in tool args break until they string-encode (adapter work). |
| One rule, enforced in one place (core), identical in 5 SDKs. | Detection of >2⁵³ requires arbitrary-precision parse (serde_json `arbitrary_precision` feature) — small core change. |
| Interceptor always evaluates exactly what executes. | NaN case still depends on pre-marshalling: Python/JS corrupt *before* the core sees it — needs SDK-side guards too. |

### B. Normalize per convention (string-encode)

Core (or SDK marshalling) converts >2⁵³ ints to decimal strings and
NaN/Infinity to strings ("NaN") before canonicalization, per proto3
convention.

| Pros | Cons |
| --- | --- |
| Nothing breaks; big-ID hosts work out of the box. | **The interceptor sees a string where the tool receives a number** — a match predicate `args.id == 9007...` silently fails; a transform writes a string back into a numeric field. This is a semantic change to user data, hidden in the plumbing. |
| Aligns with protobuf/JSON industry practice. | Round-tripping is ambiguous: was `"9007199254740993"` originally a string or a converted int? Identity non-injective in the other direction. |

### C. Reject in core + document the convention (A + guidance)

A's enforcement, plus §4 normative guidance: hosts carrying 64-bit
identifiers MUST string-encode them at the adapter boundary (proto3
convention), and SDK marshalling layers MUST reject native NaN/Infinity
before serialization (uniform `host_error:context_invalid` instead of
per-language accidents).

| Pros | Cons |
| --- | --- |
| Fail-closed core + a documented, standard escape hatch. | Same adapter burden as A for big-ID hosts. |
| Kills the per-language NaN divergence with an explicit SDK-side rule + tests. | Slightly more work: core check + 5 marshalling guards + vectors. |

## On NaN specifically (direct answer)

NaN is **not** a big deal as a wire concern — it cannot legally appear
in wire JSON. It **is** a real but small concern as a *marshalling*
divergence: today `float('nan')` in a Python tool arg produces a core
parse error, while `NaN` in a JS host silently becomes `null` before
the core ever sees it. Any option should include the SDK-side guard;
the only question is reject-vs-stringify, and stringify invents a value
the tool never received.

## Recommendation (for discussion)

**C.** Fail closed in the core for all three classes; document the
proto3 string-encoding convention for 64-bit identifiers as the
supported pattern; add SDK marshalling guards so NaN/Infinity fail
identically everywhere; ship vectors for each class. B is ruled out by
the interceptor-sees-different-value problem — the same integrity
principle that forbids evaluating bytes that differ from what
executes.

## Also in scope for this decision

Rename the context tier vocabulary **L0/L1/L2/L3** (spec §4) — it
collides verbally with the removed conformance "levels". Candidates:
`core / per-point / optional / extensions` or `required / conditional /
optional / namespaced`. Mechanical spec+docs sweep, no wire impact.

## Decision needed

- [ ] A / B / C
- [ ] If A or C: arbitrary-precision detection in core (serde feature) acceptable?
- [ ] Tier vocabulary rename: yes/no + preferred names
