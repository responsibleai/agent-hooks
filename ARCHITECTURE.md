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
