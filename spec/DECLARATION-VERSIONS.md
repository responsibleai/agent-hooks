# Host declaration versions

The host declaration document (spec §7.7) is a contract with its own
version, `agent-hooks-declaration/<major>.<minor>`. It is independent
of the wire version (`agent-hooks/X.Y`, the `spec` member of every
context) and of the package version (`vX.Y.Z[-pre.N]`, one tag for all
SDKs). This file is the record of both mappings. The Rust core
publishes the same facts as `DECLARATION_VERSION` and
`SUPPORTED_DECLARATION_VERSIONS` next to `SPEC_VERSION`, and
`scripts/check-version-consistency.py` checks that the current version
appears here.

## Contract versions

| Version | Status | Schema | Defined by spec revision | Notes |
| --- | --- | --- | --- | --- |
| `agent-hooks-declaration/1.0` | accepted | `spec/schema/host-declaration-1.0.schema.json` | 0.1.0-beta | First version. |
| `agent-hooks-declaration/1.1` | current | `spec/schema/host-declaration-1.1.schema.json` | 0.1.0-beta | Adds the OPTIONAL binding member `on_error` and the OPTIONAL document default `configuration.failure.on_error` (spec §6.3.1, §7.7.3, §7.7.5). Absent members keep the 1.0 meaning. |

Major 0 is reserved for the conformance kit and is never accepted.

## SDK releases and the versions they accept

| SDK release | Accepts | Current |
| --- | --- | --- |
| `v0.1.0-beta.2` (2026-10-13) | `agent-hooks-declaration/1.0` | `agent-hooks-declaration/1.0` |
| `v0.1.0-beta.4` | `agent-hooks-declaration/1.0`, `agent-hooks-declaration/1.1` | `agent-hooks-declaration/1.1` |

`v0.1.0-beta.2` is the first tag that accepts a host declaration;
`v0.1.0-beta.1` and earlier accept none. Add a row for every tag that
changes the accepted set or the current version (RELEASING.md,
step 1).

## Migrating across versions

Within a major, a loader accepts every older minor it supports and
brings a document to the current minor through one explicit step per
version (`declaration::migrate` in the Rust core). The record carries
the document's own version, not the migrated one.

| From | To | Step |
| --- | --- | --- |
| `agent-hooks-declaration/1.0` | `agent-hooks-declaration/1.1` | Rewrite `declaration` to `agent-hooks-declaration/1.1`. Every binding without `on_error`, and a document without `configuration.failure.on_error`, keep the absence; 1.1 resolves both to `deny`, which is what 1.0 did without a name for it. Nothing else changes. The record still says `agent-hooks-declaration/1.0`. |

A loader never performs this step on a document that writes
`on_error` under a 1.0 version string; that document is refused as
`declaration_error:unknown_field` (spec §7.7.2), and the operator opts
in by writing 1.1.

Across a major, the spec revision that introduces the new major adds a
row to the contract table for the new version and a row here for each
migration step:

| From | To | Steps |
| --- | --- | --- |
| (none yet) | | |

A loader may accept more than one major during a deprecation window of
at least two SDK minor releases. Re-run the CTK after migrating a
document.
