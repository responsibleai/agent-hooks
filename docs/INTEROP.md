# Ecosystem interop (informative)

How agent-hooks maps onto the protocols agent frameworks actually
speak. agent-hooks is deliberately protocol-neutral: it intercepts a
host's agent loop, not the wire. This appendix shows the canonical
correspondences so adapters agree on them instead of re-deriving them.

## MCP (Model Context Protocol)

An MCP **client** (the agent host) invoking tools on MCP servers is
the exact surface `pre_tool_call`/`post_tool_call` mediates. The
canonical field mapping:

### `tools/call` request → `pre_tool_call` context

| MCP | AgentContext (§4.2) |
| --- | --- |
| request `id` (JSON-RPC) | `tool_call.id` |
| `params.name` | `tool_call.name` |
| `params.arguments` | `tool_call.args` — also the `target`, so a `transform` rewrites the arguments actually sent (§4.3) |

A combined `deny` means the host MUST NOT send the `tools/call`
request (§6); surface a tool error to the model per §6.2.

### `tools/call` result → `post_tool_call` context

| MCP | AgentContext (§4.2) |
| --- | --- |
| result `content` | `tool_result.value` — the `target`; a `transform` rewrites what enters agent state |
| result `isError` | `tool_result.is_error` |
| (request echo) | `tool_call.{id,name,args}` MUST reflect the arguments actually sent, i.e. post-transform (§4.2) |

A combined `deny` at `post_tool_call` discards the result as if it
had errored (§6.1); the host MUST NOT re-invoke the tool.

Notes:

- Multi-part MCP `content` arrays pass through as the JSON value they
  are; the contract does not flatten them.
- 64-bit identifiers inside `arguments` are subject to the §4.4 value
  domain — string-encode at the adapter boundary.
- MCP resource reads and prompt gets are not tool calls; a host that
  wants them mediated surfaces them as tools (gaining
  `pre/post_tool_call` coverage) or treats fetched content as `input`.
- MCP **sampling** (`sampling/createMessage`, server-initiated model
  calls through the client) is a model call in the host's loop:
  bracket it with `pre_model_call`/`post_model_call`.

## MCP elicitation and the approval seam

MCP **elicitation** (a server asking the user for input mid-call) and
agent-hooks **escalation** solve adjacent problems and compose rather
than compete:

- An agent-hooks liftable deny (§5.1) consults the host's approval
  resolver (§9). A host whose UI stack is MCP-native MAY implement
  that resolver *via* an elicitation round-trip to the user — the
  elicitation is the resolver's transport, not a separate verdict
  path.
- The §9 rules still bind: the request carries the context identity
  (computed over the redacted context the approver sees), the
  resolution echoes it byte-for-byte, and `approve` carries a permit
  verdict. An elicitation answer maps to
  `approve`/`reject`/`unresolved` at the adapter.
- Server-initiated elicitation for the tool's own parameters (a form,
  a confirmation) is ordinary tool behaviour and needs no agent-hooks
  involvement.

## A2A (agent-to-agent) delegation

From the delegating agent's perspective, sending a task to another
agent is an outbound action: bracket it as a tool call
(`pre_tool_call`/`post_tool_call` with the A2A task as `args`/
`tool_result`). The remote agent's own loop — if it also implements
agent-hooks — is a separate session with its own `agent_startup`,
records, and identities; the contract defines no cross-session
identity propagation today (the `trace.*` optional fields, §4.5,
carry W3C Trace Context for correlation).
