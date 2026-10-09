# agent-hooks (Go SDK)

Go implementation of
[AGENT-HOOKS-0.1](https://github.com/responsibleai/agent-hooks/blob/main/spec/AGENT-HOOKS-0.1.md)
over the canonical Rust core (`libagent_hooks_ffi` via cgo):
interception points, `AgentContextBuilder`, `Verdict` types,
host-side `InterceptionEmitter` with the four composition profiles,
the identity-provider seam, and the CTK runner.

> **Trust model.** agent-hooks is a *cooperative contract*, not a security
> boundary: the host framework is fully trusted, interceptors run in-process
> with full data access, and no complete-mediation claim is made. Read
> [SECURITY.md](https://github.com/responsibleai/agent-hooks/blob/main/SECURITY.md)
> and [spec §1.4](https://github.com/responsibleai/agent-hooks/blob/main/spec/AGENT-HOOKS-0.1.md#14-trust-model-and-non-goals)
> before relying on it.

```bash
# Module path: github.com/responsibleai/agent-hooks/sdk/go
# (private repo — requires a Rust toolchain to build the native lib)
git clone https://github.com/responsibleai/agent-hooks && cd agent-hooks
cargo build --release --manifest-path sdk/rust/Cargo.toml -p agent-hooks-ffi
cd sdk/go && CGO_ENABLED=1 go build ./...
```

## Usage

```go
import "github.com/responsibleai/agent-hooks/sdk/go/agenthooks"

e := agenthooks.NewInterceptionEmitter(agenthooks.Enforce, nil)
e.Register(myPolicy{}) // implements Intercept(ctx, AgentContext) (Verdict, error)
b := agenthooks.NewAgentContextBuilder("my-agent", "my-fw", "s-1")

ctx := b.PreToolCall("tc-1", "http_get", map[string]any{"url": url})
rec, err := e.EmitUnchecked(context.Background(), ctx)
if err != nil { /* infrastructure error */ }
if !rec.Proceeds() { /* surface rec.Verdict.Reason as a tool error */ }
// proceed with ctx["tool_call"].(map[string]any)["args"] (post-transform)
```

`agenthooks.Warn(..)` / `agenthooks.Escalate(..)` are the §5
constructor shortcuts. Interceptor/resolver panics are recovered and
fail closed (§6.3). **Value-domain note (spec §4.4):** decode JSON
carrying 64-bit integers with `json.Number` — default `any`
decoding rounds beyond 2^53 exactly like JavaScript.

## Host declaration

A host can load its configuration, declared surface and interceptor
bindings from a host declaration document (spec section 7.7) instead of
calling the setters. The document is a versioned contract of its own,
`agent-hooks-declaration/1.0`, separate from the wire version. The
module exports `agenthooks.DeclarationVersion` and
`agenthooks.SupportedDeclarationVersions`; `DeclarationVersions()`
reads the same values from the Rust core.

The host registers in code what a document may reference: its surface,
kind resolvers (one Go func per binding kind), custom identity
providers, approval resolvers and redactors. A document that names
anything the registry does not hold is refused at load, before any
emission.

```go
surface := agenthooks.DefaultHostSurface().
	WithPoints(agenthooks.PreToolCall, agenthooks.PostToolCall).
	WithCapabilities("tool_calls")

reg := agenthooks.NewHostRegistry(surface)
if err := reg.Kind("com.example.egress", func(config json.RawMessage, ctx agenthooks.BindingContext) (agenthooks.Interceptor, error) {
	return newEgress(config) // validates its own config; never echoes it in errors
}); err != nil {
	return err
}
if err := reg.ApprovalResolver("operator-queue", queue); err != nil {
	return err
}

// Three construction paths, one loader, the same records:
e, err := agenthooks.NewInterceptionEmitterFromDeclarationPath("agent-hooks.declaration.json", reg)
e, err = agenthooks.NewInterceptionEmitterFromDeclarationJSON([]byte(text), reg)
decl, err := agenthooks.NewDeclarationBuilder().
	Composition(agenthooks.StrictestComposition("")).
	ApprovalResolver("operator-queue").
	Bind("egress", "com.example.egress", map[string]any{"allow_hosts": []string{"internal.example"}},
		agenthooks.BindAt(agenthooks.PreToolCall, agenthooks.Output)).
	Build()
if err != nil {
	return err
}
e, err = agenthooks.NewInterceptionEmitterFromDeclaration(decl, reg)
```

A refusal is a `*agenthooks.DeclarationError` with `Class`,
`Findings` (JSON pointer and detail) and, for an unsupported version,
`Accepted`; `errors.As` recovers it and `Code()` gives the namespaced
class (`declaration_error:unknown_field`). Steps 2 to 10 of the load
pipeline run in the Rust core, so Go reports the same class for a
document as every other SDK. A document a kind resolver refuses is
`declaration_error:binding_rejected`.

An emitter built from a declaration is sealed: the setters return
`agenthooks.ErrEmitterSealed` (or panic where their signature has no
error), and `Timeout` is read-only. `Declaration()` returns the
resolved form; its `CanonicalJSON()` is the same string for the path,
JSON and code paths. Every record such an emitter writes carries
`declaration: "agent-hooks-declaration/1.0"`; records from an emitter
configured in code carry no such member. Bindings run per point:
`RegisterAt` offers the same per-point binding in code, and
`interceptors_registered`, `verdicts[].index` and `decided_by` count
the interceptors bound at the emitted point.

## Native library deployment

The Go SDK links `libagent_hooks_ffi` via cgo. Build-time and run-time
are separate concerns:

```bash
# Build time (compile + link)
export CGO_ENABLED=1
export CGO_LDFLAGS="-L/path/to/agent-hooks/sdk/rust/target/release -lagent_hooks_ffi"
go build ./...

# Run time (dynamic loader must find the library)
# Linux:   export LD_LIBRARY_PATH=/path/to/sdk/rust/target/release
# macOS:   export DYLD_LIBRARY_PATH=/path/to/sdk/rust/target/release
# Windows: add the directory to PATH
```

To avoid the run-time variable on Linux, bake an rpath at link time:
`CGO_LDFLAGS="-L... -lagent_hooks_ffi -Wl,-rpath,/opt/agent-hooks/lib"`.
A missing library fails at process start with a loader error naming
`libagent_hooks_ffi` — deployment, not code. Cross-compiling requires a
Rust target + C toolchain for the same triple; build the cdylib with
`cargo build --release --target <triple> -p agent-hooks-ffi` first.
