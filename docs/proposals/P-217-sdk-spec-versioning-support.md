P-217: SDK support for multiple specification versions

**Status:** Draft.

## Abstract

Each SDK supports `0.1` and `draft` today, but we need to establish how the SDKs should carry more versions as the specification evolves and which models to generate and how to validate each version.

This proposal adopts strict semantic versioning for the specification (minors are additive only). Generate internal models for every supported version, map them to a public API that exposes only the latest models plus a thin idiomatic layer, and round-trip test the mapping.

The public API is the same in both phases, so moving between them
breaks no caller.

## Motivation

### A shared model does not validate older versions by itself

A model at the newest shape can *represent* an older payload but does
not *validate* it. If 1.1 adds an optional member to a closed object, a
1.1 model accepts it, yet a payload declaring 1.0 must reject it. On
write, a member from a newer version must not reach a peer that agreed
to an older one, and silently dropping it can weaken enforcement.

### The project controls only the specification

Hosts and interceptors come from different vendors and upgrade on their
own schedules. Unlike a service SDK, where the service validates
requests and retires old API versions, Agent Hooks peers have no
authoritative server. Each SDK must carry the version knowledge a
service would otherwise own, so that cost has to be designed and
bounded.

## Goals

A compatibility policy that can hold after 1.0, a public SDK surface that does not change shape as versions are added, strict per-version validation with native performance, and no per-minor model copies once the project is past 1.0.

## Specification

### Compatibility policy

- **Strict semver.** A minor may only add optional members, enum values
  and union variants. A rename, retype, removal, or a member made
  required is a major. CI enforces this by comparing each version's
  generated schemas with the previous one.
- **Members added in a minor are optional in the models.** Validation
  still requires them from the minor that introduces them. Absence means
  the previous minor's behavior, and a member that carries security
  semantics (enforcement, approval) fails closed when absent.
- **Closed schemas.** `extensions` remains the only open bag, so
  unknown members are rejected against the agreed version.
- **Pre-1.0.** 0.x minors may break, so 0.1 and `draft` are treated as
  separate majors until 1.0.
- **Kept from VERSIONING.md.** Version selection stays explicit with no
  default, and an SDK bumps its major only when its own public API
  breaks.

### Version negotiation

Peers agree on the highest version both support before any payload is
exchanged. With no common version, the binding fails closed with
`declaration_error:spec_unsupported`, carrying the supported set. An
SDK release supports the versions released when it shipped, never later
minors.

### Public SDK surface

- The root namespace holds the latest models plus the thin idiomatic
  layer (for example the typed hooks in #202). Callers still select the
  version explicitly.
- Hook and client authors do not branch on version. Members from a
  newer minor are optional and simply absent when the agreed version is
  older; `request.Spec` is available for the rare case that needs it.
- When a new major ships, its types take the root namespace and the
  previous major moves to a `V{x}` namespace in an SDK major. A `V{x}`
  namespace is removed in the first SDK major after its support window
  ends.

  For example

```typespec
model ToolCall {
  id: string;
  name: string;
  @added(Versions.v1_1) server?: string;
}
```

```csharp
// generated
static void CheckVersion(ToolCall t, SpecVersion v)
{
    if (t.Server is not null && v < SpecVersion.V1_1)
        throw new SpecVersionException("tool_call.server requires 1.1; agreed 1.0");
}
```

## Rationale

Two decisions are separate: the compatibility policy (strict semver or
every version may break) and the source shape (per-version snapshots or
one versioned TypeSpec source). Within a major, both source shapes
produce the same SDK footprint and runtime cost; a single source pays
off at the first major and as versions accumulate.

| Option | Benefits | Trade-offs |
| --- | --- | --- |
| A. Strict semver, latest models only, no validation of unknown members | Smallest SDK | A newer member is silently ignored by an older peer, which can weaken enforcement; conflicts with closed schemas; a major still needs mapping |
| B. Strict semver, latest models, validate against each version's JSON Schema at runtime | Exact validation | Slower than native types; needs a schema validator dependency (none built into .NET; `jsonschema` in Python, which has no runtime dependencies today) |
| C. Every version may break (date-based, like MCP) | Freedom to change shapes | Every version needs full models and mapping; peers upgrade independently, so the ecosystem fragments |
| D. Strict semver, per-version models now, then latest models plus a generated "introduced in" table (recommended) | Exact validation with native types; public surface unchanged across phases; cost bounded by the support window | Members added in a minor must be optional; needs a schema comparison or a versioned TypeSpec source to produce the table |

## Open questions
1. Set the support window and minor-release cadence that bound how many versions an SDK carries.