# Architecture

## Rust core, per-language wrappers

`sdk/rust/core` (`agent-hooks-sdk` crate, lib name `agent_hooks`) is the single canonical
implementation of AGENT-HOOKS-0.1. Every other SDK binds to it so that
the security-relevant primitives have exactly one implementation:

| §    | Primitive | Core symbol |
| ---- | --------- | ----------- |
| 10.2 | Canonical JSON (RFC 8785) | `canonical::canonical_json` |
| 10.2 | Context identity (jcs-sha256 provider, fail-closed I-JSON domain) | `canonical::context_identity`, `canonical::scan_projection_raw` |
| 5    | Verdict wire validation | `verdict::from_wire` |
| 5.2  | Transform path parse/apply | `path::apply`, `enforce::apply_transform_to_ctx` |
| 7.3/7.5 | Multi-verdict aggregation (severity, unions, conflicts) | `composition::aggregate_strictest`, `ffi_surface::compose_aggregate` |
| 10.3 | Record assembly | `enforce::finalize` |

What stays per-language: the `Interceptor` callback protocol, the
`AgentContextBuilder` convenience helper, exception/error types, and the
CTK `Harness` glue — anything that calls back into user code. For
Rust-native hosts these live in the core crate itself
(`InterceptionEmitter`, `AgentContextBuilder`, `ctk::ReferenceHarness`
behind the `ctk` feature); the other languages implement them over the
FFI.

## FFI surface

`sdk/rust/core/src/ffi_surface.rs` defines the shared surface every
binding wraps. All functions take and return UTF-8 JSON strings, because
`AgentContext` and `Verdict` are already wire-shaped JSON. Errors return
`(host_error_code, detail)` where `host_error_code` is the §11 wire
string; bindings raise a native exception carrying both.

| Binding | Path | Mechanism |
| --- | --- | --- |
| Python | `sdk/python/{Cargo.toml,src/lib.rs}` | PyO3 abi3-py310, built by maturin as `agent_hooks._core` |
| TypeScript | `sdk/typescript/{Cargo.toml,src/native.rs}` | napi-rs, built by `@napi-rs/cli` as `agent-hooks.<platform>.node` |
| C ABI | `sdk/rust/ffi/` | `libagent_hooks_ffi` cdylib + `include/agent_hooks.h` |
| .NET | `sdk/dotnet/src/AgentHooks/Native.cs` | `[DllImport("agent_hooks_ffi")]` over the C ABI |
| Go | `sdk/go/agenthooks/native.go` | cgo over the C ABI |

The C ABI returns a heap-allocated `AhResult{ok, value, error_code}` the
caller frees with `ah_free_result`.

## Emitter split

```
per-language wrapper                       Rust core (via FFI)
──────────────────────                     ─────────────────────────
build AgentContext              ──────►
dispatch per composition profile
(sequential fold / parallel snapshots):
    r = interceptor.intercept(ctx)  ◄── native callback
                                ──────►    validate_verdict(r)
                                ──────►    compose_aggregate([...])
if liftable deny (per profile):
    resolver.resolve(...)           ◄── native callback
                                ──────►    enforce(ctx, verdict, mode)
                                ◄──────    {record, ctx'}  (target rewritten)
raise/return InterceptionRecord
```

## TCB surface (what is single-implementation and what is not)

The security primitives that are implemented **once** in the Rust core
and inherited by every binding: canonical JSON + context identity
(§10), the §5 verdict gate (`validate_verdict`/`from_wire`), severity
aggregation (`compose_aggregate`), transform application (§5.2), record
assembly and the payload-free projection (`finalize`, §10.3), and the
CTK engine.

Duplicated per language, by necessity (they call back into user code):
the per-profile dispatch loops (§7.4–§7.5 fold, short-circuit, snapshot
isolation), approval-seam consultation and substitution (§7.6, §9),
timeout enforcement, and the §7.3 union application on substitution
paths. These five implementations CAN drift; the pin is the CTK — the
composition vectors assert wire-shaped records (combined verdict,
`decided_by`, `verdicts[]`, `fold_truncated`, `resolved_by`) that are
byte-comparable across SDKs, so a divergence in any duplicated surface
fails that SDK's self-test. (AH-CTK-104's `verdicts[]` assertions
caught exactly such a drift during development.)

## Latency budget

The emitter sits on the critical path of every model and tool call.
Budget (allow path, `sequential/first_deny`, jcs-sha256 provider, per
emission, excluding interceptor bodies):

| Context size | Interceptors | Budget |
| --- | --- | --- |
| ≤1 KiB | 1 | < 50 µs |
| ≤100 KiB | 5 | < 2 ms |
| ≤1 MiB | 10 | < 20 ms |

Dominated by canonicalization+hash of the payload (once per emission on
the allow path: `finalize` reuses the pre-dispatch identity when no
transform folded). Verify with `cargo bench -p agent-hooks-sdk` —
`benches/emission.rs` covers `context_identity`, `compose_aggregate`,
and the full emit path at these sizes. Numbers are targets on
commodity x86-64; CI does not gate on them (shared-runner variance
makes threshold gates flaky) — regressions are caught by running the
bench suite before release tags.

## Golden vectors

`conformance/golden/identity.json` is generated from the Rust core by
`scripts/gen-golden-identity.py` and asserted by every SDK's test suite
(`sdk/rust/core/tests/golden_identity.rs`,
`sdk/python/tests/test_golden_identity.py`, and equivalents). A binding
that fails this test is not calling into the core.

## Trade-offs

Every SDK now requires a compiled native artefact per (OS, arch). The
abi3 stable ABI (Python) and napi (Node) minimize the matrix. Go via cgo
loses `CGO_ENABLED=0` cross-compilation and pure-static binaries; hosts
that require pure-Go should vendor the golden vectors and treat the Rust
core as the reference oracle. This is documented, not hidden.
Per-OS deployment of the native artefact is covered in each SDK's
README ("Native library deployment").

## Design decisions

Contract-level decisions are made through written proposals under
[`docs/proposals/`](docs/proposals/README.md) (P-001..P-004 to date:
verdict algebra, composition profiles, identity provider seam). The
proposal README defines which change classes require one.
