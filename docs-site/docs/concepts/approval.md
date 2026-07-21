# The approval seam

A liftable deny (a `deny` carrying an `approval` block) may be lifted
by a host-registered approval resolver. The composition profile decides
when the seam is consulted; the seam itself has a deliberately small
contract.

The host hands the resolver a request:

```json
{
  "context_identity": "sha256:3be2d78f...",
  "interception_point": "pre_tool_call",
  "verdict": { "decision": "deny", "reason": "transfer_requires_approval", "approval": {} },
  "context": { "...": "may be redacted per host policy" }
}
```

The resolver returns a resolution in the same three-verdict
vocabulary: `approve` carries a permit verdict (`allow`, or a
`transform` if the approver modified the content), `reject` carries a
deny, and `unresolved` fails closed as
`host_error:approval_unresolved`.

Two rules make the seam safe:

1. **The echo rule.** The resolution's `context_identity` must equal
   the request's byte for byte. A mismatch is rejected as
   `host_error:approval_identity_mismatch`.
2. **Escalation-time binding.** The identity in the request is computed
   from the context as presented to the resolver, after any transforms
   that folded earlier in the dispatch. When the declared
   [identity provider](identity.md) is content-derived, an approval
   obtained for one payload cannot be replayed against another.

If the host also registers an approval redactor, the request's context
is redacted before the resolver sees it, and the identity is computed
over the redacted form, so the hash covers exactly what the approver
saw.

A host with no resolver enforces liftable denies as plain denies. The
seam is never consulted at `agent_shutdown` (there is nothing left to
approve) or in `evaluate_only` mode.
