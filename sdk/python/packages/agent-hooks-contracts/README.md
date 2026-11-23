# Agent Hooks Python contracts

Pure-Python wire contracts generated from the TypeSpec specification, with no
dependency on `agent-hooks-sdk`, PyO3, or Rust. Install this distribution
independently from the repository root:

```bash
pip install ./sdk/python/packages/agent-hooks-contracts
```

Select the specification version explicitly:

```python
import json

from agent_hooks_contract.generated.draft import PreToolHookResponse

response: PreToolHookResponse = {
    "verdict": {"decision": "transform", "transform": {"args": {"reviewed": True}}}
}
wire = json.dumps(response)
```

The `generated/draft/` bundle contains `TypedDict` models and literal unions.
There is no unversioned default, and no generated 0.1 bundle: the released
specification and existing runtime API are unchanged.

These are plain dictionaries: no constructors, runtime enums, serializer, or
validation dependency. `NotRequired` means a key may be absent, not that its
value is nullable. Arbitrary JSON uses a recursive `JsonValue` alias; integers
use Python's arbitrary-precision `int`. `typing_extensions` supplies
Python 3.10-compatible key qualifiers.

Static typing does not enforce numeric bounds, patterns, or conditional rules.
Type checkers may reject additional keys on objects the wire contract leaves
open. Use the normative JSON Schemas for validation. Adopting these draft types
in the existing runtime is separate work.

## Generation and development

The TypeSpec emitter lives in `emitters/python/`, not in this SDK package.
`spec/draft/main.tsp` is the shared entry point and `spec/draft/tspconfig.yaml`
selects emitters and versioned output locations. Edit the TypeSpec source, not
the committed Python under `src/agent_hooks_contract/generated/draft/`.

From the repository root, with the Python environment activated:

```bash
pip install -r sdk/python/packages/agent-hooks-contracts/requirements-dev.lock
pip install --no-build-isolation --no-deps -e ./sdk/python/packages/agent-hooks-contracts
pnpm install
pnpm generate
pnpm check:generated
mypy --strict sdk/python/packages/agent-hooks-contracts/src sdk/python/packages/agent-hooks-contracts/tests/typing_contract.py
pytest sdk/python/packages/agent-hooks-contracts/tests
```

`pnpm generate` builds the emitter and runs `tsp compile spec/draft`. Once the
emitter is built, `pnpm exec tsp compile spec/draft` also regenerates the bundle
directly. Ruff sorts imports and formats output. The shared drift command
regenerates and runs `git diff --exit-code`; run it with no unrelated edits.
Build this package's platform-independent wheel with `python -m hatchling build`
from this directory. No native toolchain is required.

This is the Python-only adoption of
[the repository structure proposal](https://github.com/responsibleai/agent-hooks/issues/225).
The native runtime and conformance kit remain under `sdk/python/`; moving
those, other emitters, and the existing schema-generation pipeline is deferred.
