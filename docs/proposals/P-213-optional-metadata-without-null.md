# P-213: Use null only when it has a defined meaning

- **Status:** Draft
- **Created:** 2026-11-18
- **Author(s):** Timothee Guerin (@timotheeguerin)
- **PR:** https://github.com/responsibleai/agent-hooks/pull/213

## Context

Optionality and nullability are independent: an optional property may be
omitted, while a nullable property may carry the explicit JSON value
`null`. Allowing both without defining what `null` means introduces a
second representation of absence that producers and consumers must handle.

Some draft metadata fields allowed both forms without assigning `null`
a meaning. This was already explicit in the TypeScript schema sources
before the TypeSpec conversion; the conversion preserved it.

## Decision

Use optional properties (`?`) when a value may be absent. Add explicit
nullability (`| null`) only when `null` is a value with a specific,
documented meaning.

```typespec
model Example {
  // Omit when there is no message.
  message?: string;

  // Omission inherits the configured timeout; null explicitly means unbounded.
  timeout_ms?: integer | null;
}
```

Decide requiredness separately. A required property can still be nullable
when its defined states include `null`. Values that accept arbitrary JSON
also continue to accept `null` as a JSON value.

Express accepted types and property presence in the schema. Use
specification prose to explain the meaning of a null state, rather than
repeat each property's schema constraints.

## Rationale

Omission provides one representation for missing data. Explicit nullability
remains useful for domain states such as an unbounded timeout or an
identity-unbound emission. Keeping that distinction avoids unnecessary
states without erasing meaningful ones.

## Application

Apply this rule to verdict metadata and record projections by removing
redundant `| null` unions, including `resolved_by` where omission already
means the approval seam was never consulted. Keep nullability for defined
identity, attribution and configuration states.

The schema changes and regression cases in this PR illustrate the
decision; they are not an exhaustive inventory of where it applies.
