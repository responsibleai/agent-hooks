# P-005: Retractability as a declared capability

**Status:** **Draft** — no decision recorded. This is in a MUST class:
it changes what a conformance claim asserts (§13.3).
**Raised by:** @joslat, from a review comment on
[microsoft/agent-framework#7564](https://github.com/microsoft/agent-framework/pull/7564)
(2026-08-08); write-up invited by @MohammadHaroonAbuomar in the same
thread, 2026-08-11.

## The gap

Some effects cannot be undone by the verdict that denies them. The spec
has no slot to say which ones, so a host that has them says so in prose,
or not at all.

The .NET ADR that shipped with microsoft/agent-framework#7564
(`docs/decisions/0035-dotnet-agent-hooks-enforcement.md`, status still
`proposed`) records two limitations as free text on a factory:

> hosted (service-executed) tools never reach the function seam and are
> intercepted via the `post_model_call` content projection;
> service-managed (conversation-id) history is durable at the service
> and ungateable

The first is already in this repository, also as free text.
`conformance/claims/maf/REPORT.md` lists it under "Known limitation
(disclosed by the feature)": hosted tools "never traverse the
framework's function-invocation seam, so
`pre_tool_call`/`post_tool_call` cannot intercept them". Of everything
under "Declared surface (§13.1)", it is the only item with no slot in
the surface, the tuple, or the report.

Both limitations are one property, and §12.1a already uses it without
naming it. A seam is **retractable** when a combined verdict covering
it can still prevent the guarded effect, or stop it becoming durable,
inside the host's enforcement boundary. It is **unretractable** when
the effect has already happened, or has already become durable outside
that boundary, before any covering verdict exists. A hosted tool has
already run by the time the host sees it; service-owned history is
already written. `buffered_output: false` is the egress instance, where
the content is already streamed.

The one existing way to narrow a claim is §3.2 capability subsetting —
omitting interception points a host does not have — and it cannot
express either limitation: both hosts emit all eight points, and the
Python adapter passes the whole tool seam. As @MohammadHaroonAbuomar
put it, "these points ARE emitted, so capability subsetting can't
express them, and today a reader of the claim has to find the caveat in
host documentation."

## Two halves: one wants disclosure, one qualifies §6.1

The two limitations split by cost, so name them separately:
`tool_execution_retractable` for tools a service executes out of the
host's reach, `history_retractable` for history a service owns and
keeps. The names are from the thread; Option B specifies them. Each
half has an in-tree precedent to copy.

| | `tool_execution_retractable` | `history_retractable` |
| --- | --- | --- |
| Nearest precedent | §12.1a, `buffered_output` | §12.1's "**Exception — incremental mediation.**" |
| Ask | disclosure only | disclosure **plus** one conditional §6.1 qualification |

**The hosted-tool half is pure disclosure.** §12.1a is the precedent
for a declaration no vector can exercise: `conformance/HARNESS.md`
marks `buffered_output` **declaration-only** — no vector carries the
capability; the declaration exists to make the retraction limitation
visible (§13.3). That holds here unqualified: the CTK cannot represent
a service that executes a tool, and nothing in the 51 vectors asserts
that every tool execution traverses the function seam. §6.1 stays
satisfiable, the result discardable at `post_model_call`. **No new
vector, no re-run.** The instrument is a host-surface key, "never as a
vector requirement" (`vectors.schema.json`).

**The history half asks for one qualification of §6.1.** §6.1 is a
MUST conditioned on a deny: a "`deny` (lifted or not, per §7)" at
`post_model_call`/`post_tool_call` "means the host MUST NOT incorporate
the result into subsequent agent state" — which a host whose history a
service owns cannot satisfy for that copy.

§12.1's exception is the nearest in-tree shape. What carries across is
narrower but sufficient: a declared capability **can** carry a bounded,
additive qualification of a §6.1 obligation. The exception shipped in
alpha.5 as "Additive; no version-surface change", and its gate has
since landed on the same terms ("the vectors are additive and no
existing declared surface changes", CHANGELOG). Its placement argues
against putting the new qualification in §6.1: the exception gates §6.1
durability from inside §12.1, and §6.1 carries no back-reference.

Two disanalogies bound how much else carries:

- It is open only to a host that **already declares `buffered_output:
  false`** (§12.1a, §13.1), and governs one seam, streaming egress;
  `history_retractable` has neither predicate nor streaming relation.
- What it relaxes is §12.1's *own* assembly MUST ("A host that streams
  model output MUST assemble the complete response before emitting
  `post_model_call`"). It largely **keeps** §6.1: the exception's
  four-item discipline restates it at segment granularity — "durable
  incorporation (§6.1) is gated by the same discipline as release"
  (item 4) — and pins it with `AH-CTK-113`'s
  `persisted_must_not_contain`. Its one §6.1 concession is that an
  already-released, already-permitted prefix survives a later deny
  ("the released prefix MAY be persisted and is not pinned", in
  `AH-CTK-113`'s title). It
  bought that concession with four numbered conditions and four
  vectors; `history_retractable: false` has no substitute to offer.

One vector touches this. `AH-CTK-100` (part
`enforcement/post_action_deny`, ungated) asserts
`context_must_not_contain: ["SECRET-RESULT"]`, which the Python claim
passes today (1 passed, 0 failed, 0 skipped). But it asserts that over
"the serialization of the recorded `AgentContext`"
(`vectors.schema.json`) — the state the host projects, not a store it
does not own. So a declaring host passes it anyway, and gating the part
would drop a live assertion while buying no coverage: leave it ungated.

## Scope

**In — exactly the two limitations above.**

**Out**, though they share the ADR bullet:

- the deferred-OTel decorator — §1.1 puts it outside the contract
  ("This specification is a control plane, not a telemetry plane");
- the unrecorded chat-seam projection failure — closed as
  [#70](https://github.com/responsibleai/agent-hooks/issues/70) by
  `record_host_failure` and the §10.3 "Host projection failure"
  obligation (`ee5506d`).

Also out: the verdict shape, the point set, composition semantics, the
record shape, §1.4.

## Options

### A. Status quo — prose on the host, Notes in the claim table

*For:* zero cost, nothing to keep coherent across five SDKs, and §1.4
already tells every reader the spec "does not claim complete
mediation".

*Against:* nothing obliges the disclosure. `CLAIMS.md`'s
disclosure-flags item enumerates the non-default posture,
`identity_provider: null`, a custom provider's content-derivation and
`buffered_output: false` — not these — so "disclosure flags are
consistent" passes for a filer who omits the caveat, and two hosts of
different enforcement reach file identical-looking rows.

### B. Two declared capabilities — disclosure, plus one §6.1 qualification — **recommended**

`tool_execution_retractable` and `history_retractable` (the names from
the thread), each defaulting to `true` and requiring `false` to be
declared explicitly. §13.1 gains both in its declared-surface list;
§13.3 and `conformance/CLAIMS.md` gain MUST-state sentences beside the
`buffered_output: false` one:

- `tool_execution_retractable: false` MUST state which class of tool
  execution no verdict can prevent; that such executions and their
  outside effects precede every covering verdict, so lie outside the
  approval seam (§9) too; and which emission carries them
  (`post_model_call` for both MAF adapters);
- `history_retractable: false` MUST state which state store stays
  durable outside the host's gate, and — as §13.3 already makes an
  incrementally mediating host "state the exposure bound its accounting
  discipline enforces" — whether it covers every backend the adapter
  supports or the configuration the report ran.

`history_retractable: false` additionally needs one qualifying sentence
of normative text, beside the declaration rather than in §6.1: a host
that does not own the state store cannot satisfy non-incorporation for
that copy, and its §6.1 obligation is bounded to the state it does own.
That is the one place B changes normative text.

*For:* per-seam granularity survives into the declared surface, so two
adapters can be compared seam by seam without reading prose, and the
Python claim's prose bullet becomes a declaration.

*Against:*

- **One key per discovered mechanism.** A service-managed memory or
  context provider, a provider-side handoff, or a service-side content
  filter would each want a third and a fourth.
- **The boolean discriminates weakly.** Both properties are
  per-deployment, not structural, so an adapter over a provider that
  can do either will usually declare `false`; the discriminating power
  sits in the mandatory §13.3 sentence, as for `buffered_output:
  false`.
- **Silence asserts a property nothing tests.** No vector can
  contradict a wrong declaration — the bet §12.1a already made, now
  taken twice more.
- **Names.** `*_retractable` (per the thread) or
  `*_gated`/`*_gateable`; the proposal survives either.

### C. A single enumerated unretractable-seam surface

The alternative from the same reply: one declaration listing the
unretractable seams — e.g. `unretractable: ["hosted_tool_execution",
"service_managed_history"]`, default empty, from a closed vocabulary.

*For:* one key however many classes appear, one disclosure rule, growth
by vocabulary rather than schema, and an empty list that states
"nothing is unretractable" positively where B's silence only implies
it.

*Against:* both shapes need a spec-closed set — B's a key set, C's a
token vocabulary, on the closure discipline §7.2 already applies to
profiles — so closure is not a differentiator. C's real costs: its
members cannot be §3 point names (the tool seam is unretractable only
*for hosted tools*), so per-token prose is needed anyway, and a token
carries no default.

**Set aside.**

- **D. §3.2 point-omission — rejected:** it states something false and
  costs attested surface (omitting `tool_calls` skips the 13 tool-seam
  `host_error:*` vectors the Python claim passes).
- **E. A §13.1 posture — rejected:** a posture is a choice "where this
  specification permits two behaviors", which retractability is not.
- **F. Per-emission record annotation — deferred:** it serves an
  auditor reading records afterwards, but a claim is consulted *before*
  adoption.

## Defaults and change class — nothing already filed breaks

- **Polarity.** Both default to the retractable value, `false` declared
  explicitly — §13.1's rule for the neighbouring capability ("the
  egress capability `buffered_output` (§12.1a; defaults to `true`, and
  `false` MUST be declared explicitly)"). A host that says nothing
  keeps asserting the stronger posture, so no declared surface changes
  and **no existing claim becomes non-conformant**: the Python
  `agent-framework` row would simply declare
  `tool_execution_retractable: false` (its report already carries the
  limitation verbatim), an amendment rather than a re-certification,
  and the .NET row is unfiled.
- **Instrument.** `tool_execution_retractable` follows
  `buffered_output` exactly, a host-surface key "never as a vector
  requirement"; whether `history_retractable` instead marks a vector
  part is open (last item under "Decision needed").
- **Change class: spec MINOR, on precedent rather than on rule.**
  `VERSIONING.md`'s MINOR list is positive — "additive
  optional/namespaced fields, new vectors, new (optional) composition
  profiles" — and does not name a bounded qualification of an existing
  MUST; no MAJOR trigger is touched either. So the classification rests
  on §12.1's exception being the same shape and shipping as "Additive;
  no version-surface change". `docs/proposals/README.md`'s MAJOR gloss
  adds "failure (fail-closed) semantics", which `VERSIONING.md` does
  not — the maintainer's call, and a proposal is required either way,
  since README lists changes "to what a conformance claim asserts
  (§13.3)".

## Recommendation (for discussion)

**Adopt B**: two declared capabilities, `tool_execution_retractable`
and `history_retractable`, both defaulting to `true`, with `false`
declared explicitly and carrying a MUST-state sentence in §13.3. B
changes the least: the tool half copies an instrument the spec already
ships, the safe default preserves every filed claim, and only the
history half touches normative text. **A is the option to rule out**,
because it leaves the same class of limitation declared at one seam and
narrated at two others. Take C now if a third and fourth unretractable
class are already expected; if a third appears within 0.x, C is the
preferred migration.

**The honest cost of B:**

1. It is an unverifiable attestation — the CTK cannot catch a wrong
   declaration, exactly as it cannot for `buffered_output`. What the
   flag buys is that a wrong declaration becomes a false statement in a
   claim rather than an absent one in a comment.
2. The history half qualifies §6.1 with no substitute discipline to
   offer, where §12.1's exception paid for its narrower concession with
   four numbered conditions and four vectors. The asymmetry is real,
   and it is where the case for C, or for A, is strongest.
3. Surfaces touched: spec §13.1 and §13.3, `conformance/CLAIMS.md`, the
   closed `capabilities` enum in `conformance/vectors.schema.json` and
   its `HARNESS.md` paragraph — `buffered_output` sits in that enum
   despite being declaration-only, so even the tool half follows
   precedent into a schema edit. If the history half gates a part, add
   the per-SDK harness enums and CONTRIBUTING's five-SDK rule.

Not a .NET-specific fix: @MohammadHaroonAbuomar widened the case in the
thread, and it holds — the Python claim here carries the hosted-tool
limitation today, in prose, and the same declaration would apply to
ACS-style hosts with service-managed history.

I am happy to draft the spec and conformance-doc changes, or to hand
over the text; he offered to co-draft or review, which I would welcome
on the §6.1 wording.

## Decision needed

- [ ] A (status quo) / B (two capabilities) / C (one enumerated
      surface)? D, E, F rejected above. B and C both default to
      retractable per §13.1, so no filed claim is invalidated.
- [ ] Change class: spec MINOR on the §12.1-exception precedent,
      `agent-hooks/0.1` unchanged — or does README's "failure
      (fail-closed)" gloss pull it higher?
- [ ] If B: confirm the §6.1 qualification for
      `history_retractable: false`, and that it is written beside the
      declaration rather than in §6.1?
- [ ] If B: does `history_retractable: false` gate the
      `enforcement/post_action_deny` part, or stay ungated?
      (`AH-CTK-100` is ungated today; a declaring host passes it.)
