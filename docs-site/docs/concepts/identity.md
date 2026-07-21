# Identity providers

`context_identity` is an opaque string produced by the host's declared
identity provider, a pure function from context to string. The
contract imposes exactly two rules on it: the
[echo rule](approval.md) at the approval seam, and the record rule
(the identities in effect, or explicit `null`, appear on every
[record](records.md) together with the provider's name).

| Declaration | Meaning |
| --- | --- |
| `jcs-sha256` | the shipped default, in effect unless configured otherwise |
| a host-defined name | a custom provider; the echo and record rules still apply |
| `null` | identity-unbound; approvals bind by correlation only, and records say so |

## The default provider

`jcs-sha256` canonicalizes the closed required+conditional projection
of the context per RFC 8785 and hashes it with SHA-256. The projection
is closed: optional and namespaced fields never perturb the identity,
so adding telemetry does not change what an approval binds to. Golden
vectors pin the exact bytes across all five SDKs.

The provider fails closed on input JCS cannot represent faithfully. An
integral value outside ±(2^53−1) is rejected with
`host_error:context_invalid` and a remediation message, because
canonicalization would silently round it and two distinct tool-argument
IDs could hash to the same identity. The supported pattern for 64-bit
identifiers is decimal-string encoding at the adapter boundary. The
provider never rewrites a value to make it hashable: a value is
accepted as supplied or rejected with a reason, and nothing is silently
normalized.

## Why identity is optional

The identity serves approval-content binding and tamper-evident audit.
Both are valuable, and neither requires the contract to mandate how the
string is computed. Making the provider pluggable keeps the value
domain constraint where it belongs, on the default provider's contract,
instead of imposing it on every host including those that never use
approvals. Opting out is permitted but visible: the record and any
conformance claim must state it. Honest absence beats pretend presence.
