# Composition profiles

With more than one interceptor registered, the host decides how their
verdicts combine. That decision is host configuration, chosen from a
closed set of named profiles, and never something a returned verdict
can influence. The profile in effect is recorded on every emission.

| Profile | Dispatch | Combined verdict |
| --- | --- | --- |
| `sequential/first_deny` | in registration order; transforms fold through so each interceptor sees its predecessors' rewrites | first deny short-circuits; otherwise last transform, else allow |
| `sequential/run_all` | in order with fold-through; nothing short-circuits | severity maximum across all verdicts |
| `parallel/strictest` | every interceptor gets an isolated copy of the same untransformed snapshot | severity maximum |
| `parallel/unanimous` | isolated snapshots | allow only if every interceptor allowed; anything else is a disagreement |

"Parallel" names isolation semantics, not scheduling: no interceptor
observes another's transform, and a host may dispatch serially while
remaining conformant.

## Knobs

- `on_approval: stop | resume` (`sequential/first_deny` only). When a
  liftable deny is lifted by the approval seam, `stop` ends the
  emission there (recorded with `fold_truncated: true`); `resume`
  substitutes the resolution and continues with the remaining
  interceptors.
- `on_disagreement: deny | approval` (`parallel/unanimous`): a
  non-unanimous outcome becomes a plain deny or a liftable deny for
  human arbitration.
- `on_transform_conflict: deny | approval` (parallel profiles): two
  transforms produced against the same snapshot cannot compose, so a
  conflict is denied or handed to the seam, where the resolver may
  return its own transform.

## Deliberately rejected policies

Two aggregation policies are documented in the specification as
rejected, with reasons, and must not be implemented:

- **most-permissive-wins**: a single lax interceptor would silently
  bypass every other control, violating the no-silent-bypass invariant.
  Advisory controls are what warnings and result labels are for.
- **quorum (k-of-n)**: a large configuration surface for a weak
  security story, since n−k controls are silently overridden on every
  action.
