# Go quickstart

```sh
go get github.com/responsibleai/agent-hooks/sdk/go/agenthooks
```

The Go binding uses cgo over the native core library; build it once and
point the linker at it:

```sh
git clone https://github.com/responsibleai/agent-hooks
cargo build --release -p agent-hooks-ffi --manifest-path agent-hooks/sdk/rust/Cargo.toml
export CGO_LDFLAGS="-L$PWD/agent-hooks/sdk/rust/target/release"
export LD_LIBRARY_PATH=$PWD/agent-hooks/sdk/rust/target/release
```

The per-platform linking details (rpath, Windows import libraries) are
in the SDK's README.

A minimal host with one control interceptor:

```go
package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/responsibleai/agent-hooks/sdk/go/agenthooks"
)

type EgressGuard struct{}

func (EgressGuard) OnHook(_ context.Context, hctx agenthooks.AgentContext) (agenthooks.Verdict, error) {
	if hctx["interception_point"] != "pre_tool_call" {
		return agenthooks.Verdict{Decision: agenthooks.Allow}, nil
	}
	args := fmt.Sprint(hctx["tool_call"].(map[string]any)["args"])
	if strings.Contains(args, "account_balance") || strings.Contains(args, "ssn") {
		return agenthooks.Verdict{Decision: agenthooks.Deny, Reason: "egress_blocked"}, nil
	}
	return agenthooks.Verdict{Decision: agenthooks.Allow}, nil
}

func main() {
	emitter := agenthooks.NewInterceptionEmitter(agenthooks.Enforce, nil)
	emitter.RegisterNamed(EgressGuard{}, "egress-guard")

	build := agenthooks.NewAgentContextBuilder("support-agent", "quickstart", "s-001")

	outcome, err := emitter.Emit(context.Background(),
		build.PreToolCall("t-1", "web_search", map[string]any{"q": "docs"}))
	if err != nil {
		panic(err)
	}
	fmt.Println("allowed:", outcome.Record.Verdict.Decision)

	_, err = emitter.Emit(context.Background(),
		build.PreToolCall("t-2", "send_email", map[string]any{"body": "account_balance: 991"}))
	fmt.Println("denied:", err)
}
```

Things to notice:

- The interceptor interface is `OnHook(ctx, agentContext)`, returning
  the verdict and an error; a returned error fails closed as
  `host_error:interceptor_failed`, and panics are recovered to the same
  fail-closed path.
- `Emit` returns `(EmitOutcome, error)`; a block is the error path, and
  the outcome's `Target` is the effective value on success.
- Exact enum and field spellings are in the package documentation; if
  this page and the compiler disagree, trust the compiler and file an
  issue.
