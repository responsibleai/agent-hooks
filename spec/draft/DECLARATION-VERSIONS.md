# Host declaration versioning

The experimental draft versions host declarations with the specification.
The required `spec` member selects the document schema and all loader rules;
there is no independent declaration version or supported-contract list.
SDK package versions remain independent.

| Specification | Declaration schema | Notes |
| --- | --- | --- |
| 0.1 | `spec/0.1/schema/generated/host-declaration-1.0.schema.json` | Released, unchanged; uses `agent-hooks-declaration/1.0`. |
| draft | `spec/draft/schema/generated/host-declaration.schema.json` | Experimental spec-only selector; optional `on_error` defaults to deny. |

## Migration and implementation status

To select the new draft, explicitly write `spec: "agent-hooks/draft"` and
remove top-level `declaration` and `surface.declaration_versions`.
The draft rejects removed fields as unknown fields; it does not migrate
documents automatically. Adding support for another spec does not change
the behavior of an existing document selecting 0.1.

Current SDK loaders, declaration-version APIs, migration routines and CTK
fixtures still implement the previous format. Their coordinated update is
deferred; deploying this draft format to those loaders is unsupported.
Interception records in the proposed draft also drop `declaration` entirely.
The mutable draft is not a frozen configuration contract.

See [the proposal process](../../docs/proposals/README.md) and
[VERSIONING.md](../../VERSIONING.md) for current SDK release history; those
SDK support tables are not an implementation claim for this experiment.
