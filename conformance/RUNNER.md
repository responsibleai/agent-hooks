# Writing a CTK runner

The CTK engine lives in the Rust core (`sdk/rust/core/src/ctk_engine.rs`)
and is exposed through every binding as four functions:

| Function | Purpose |
| --- | --- |
| `ctk_should_skip(vector, caps)` | Capability check; returns `null` or a skip-reason string |
| `ctk_scripted_intercept(rules, ctx)` | Evaluate `interceptor_script` against a context; returns a verdict |
| `ctk_scripted_resolve(rules, ctx, identity)` | Evaluate `approval_script`; returns `{outcome, context_identity, verdict?}` |
| `ctk_assert(vector, recorded, run_record)` | Run all `expect` assertions; returns `{id, title, part, status, failures}` |

Two more core functions serve the host declaration parts (§7.7.9):

| Function | Purpose |
| --- | --- |
| `declaration_versions()` | `{current, supported}`: the contract versions the core writes and accepts |
| `declaration_resolve(document, host)` | Steps 2 to 10 of §7.7.6 against `{surface, identity_providers, approval_resolvers, approval_redactors, kinds}`; returns the resolved declaration or a `declaration_error:*` code with JSON findings |

A per-language runner is the ~60 lines below. Only steps 3 and 5 touch
native code (the `Harness` protocol); everything else is a straight FFI
call. `sdk/python/python/agent_hooks/ctk/runner.py` is the reference.

```
for each vector file in conformance/vectors/*.json:
  1.  skip = ctk_should_skip(vector, harness.capabilities)
      if skip: yield {status:"skip", detail:skip}; continue

  2.  recorded = []
      interceptor = ctx => {
        recorded.push(deep_copy(ctx))                    # per-language
        return ctk_scripted_intercept(vector.interceptor_script, ctx)
      }
      resolver = req =>
        ctk_scripted_resolve(vector.approval_script, req.context, req.context_identity)

  3.  harness.setup(vector.scenario, interceptors,
                    vector.approval_script?.length ? resolver : null,   # [] registers NO resolver
                    vector.mode ?? "enforce",
                    vector.composition ?? sequential/first_deny+stop,   # §7.2
                    "identity_provider" in vector ? vector.identity_provider : "jcs-sha256")  # §10.1

  3b. if "host_declaration" in vector:                                # §7.7.9, see HARNESS.md
        registry = ctk registry over harness.host_surface()           # ctk.scripted, ctk-fault,
        paths_equivalent = resolve the document from value, JSON,     #   ctk-scripted, ctk-redact
                           a temp file and the builder; compare
        load = harness.setup_declared(setup, vector.host_declaration, registry)
        if load refused: rr = {outcome:"error", load:{outcome:"refused", class, paths_equivalent}}
                         harness.teardown(); go to 5
      else: harness.setup(...) as in 3

  4.  try:  rr = harness.run()
      except e: yield {status:"fail", failures:["harness.run raised: "+e]}; continue
      finally: harness.teardown()
      if "host_declaration" in vector: rr.load = {outcome:"accepted", paths_equivalent}

  5.  yield ctk_assert(vector, recorded,
                       {outcome:rr.outcome, final_output:rr.final_output,
                        tool_invocations:rr.tool_invocations, error:rr.error,
                        identities:rr.identities,      # (input, enforced) per emission
                        records:rr.records,            # wire-shaped §10.3 records
                        postures:{                     # harness *declarations* (§13.1),
                          tool_seam_host_error:        # not observed behavior — they
                            harness.tool_seam_host_error  # select run_outcome_by_posture
                              ?? "continue"}})            # (HARNESS.md "Postures")
```

## The conformance report (§13.1)

Group the yielded results by each vector's `part` tag
(`composition/parallel_strictest`, `approval_seam`,
`identity_provider`, …) and list pass/fail/skip per part: that grouping
**is** the conformance report a claim attaches (see
[`CLAIMS.md`](CLAIMS.md)). Skips must show their reason (a missing
capability such as `int64_json` is honest surface, not a failure).

The `Harness` interface (native, per language) is documented in
[`HARNESS.md`](HARNESS.md). Each SDK ships this runner under
`sdk/<lang>/.../ctk/`; the ReferenceHarness in
`sdk/python/python/agent_hooks/ctk/reference.py` is the model for the
per-language self-test harness.
