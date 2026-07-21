# Example: redaction transform

A transform rewrites the target before the action runs. The tool
receives the redacted value; the audit record proves the rewrite
happened without containing the secret. Runnable as written.

```python
"""Transform: redact a field before the tool runs; the record carries
the path, never the value."""
import asyncio
import json

from agent_hooks import (
    AgentContextBuilder,
    Decision,
    InterceptionEmitter,
    Transform,
    Verdict,
)


class Redactor:
    def intercept(self, context) -> Verdict:
        if context["interception_point"] != "pre_tool_call":
            return Verdict(decision=Decision.ALLOW)
        if "ssn" in context["tool_call"]["args"]:
            return Verdict(
                decision=Decision.TRANSFORM,
                transform=Transform(path="$target.ssn", value="[REDACTED]"),
                reason="pii_redacted",
            )
        return Verdict(decision=Decision.ALLOW)


async def main() -> None:
    emitter = InterceptionEmitter()
    emitter.register(Redactor(), name="redactor")

    build = AgentContextBuilder(
        agent_id="records-agent", framework="quickstart", session_id="s-003"
    )
    ctx = build.pre_tool_call(
        name="lookup", args={"name": "J. Doe", "ssn": "078-05-1120"}, call_id="t-3"
    )
    outcome = await emitter.emit(ctx)

    # The action consumes the effective target, not the original.
    print("tool receives:", outcome.target)

    r = outcome.record
    print(json.dumps({
        "decision": r.verdict.decision.value,
        "transform_in_record": r.verdict.transform.to_wire() if r.verdict.transform else None,
        "identities_differ": r.input_identity != r.enforced_identity,
    }, indent=2))


asyncio.run(main())
```

Output:

```text
tool receives: {'name': 'J. Doe', 'ssn': '[REDACTED]'}
```

```json
{
  "decision": "transform",
  "transform_in_record": {
    "path": "$target.ssn"
  },
  "identities_differ": true
}
```

Three properties on display:

- The transform path is rooted at `$target` and uses a small,
  normatively-defined JSONPath subset: dot members, bracket members,
  bracket indexes. A path that does not resolve fails closed as
  `host_error:transform_invalid`.
- The record's projection keeps `path` and drops `value`: the audit
  trail shows *that* `$target.ssn` was rewritten, not what it was
  rewritten to, and certainly not what it was before.
- `input_identity != enforced_identity` is the tamper-evident proof
  that content changed between dispatch and action, without storing
  either version. Under `sequential/*` profiles, a second interceptor
  registered after the redactor would have seen the redacted context,
  which is exactly how redact-then-scan pipelines compose.
