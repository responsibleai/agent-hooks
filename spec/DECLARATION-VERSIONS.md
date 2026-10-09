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
| `agent-hooks-declaration/1.0` | current | `spec/schema/host-declaration-1.0.schema.json` | 0.1.0-beta | First version. |

Major 0 is reserved for the conformance kit and is never accepted.

## SDK releases and the versions they accept

| SDK release | Accepts | Current |
| --- | --- | --- |
| `v0.1.0-beta.2` (next tag) | `agent-hooks-declaration/1.0` | `agent-hooks-declaration/1.0` |

Add a row for every tag that changes the accepted set or the current
version (RELEASING.md, step 1).

## Migrating across versions

Within a major, a loader accepts every older minor it supports and
brings a document to the current minor through one explicit step per
version (`declaration::migrate` in the Rust core). For 1.0 the step is
the identity. The record carries the document's own version, not the
migrated one.

Across a major, the spec revision that introduces the new major adds a
row above for the new version and a row here for each migration step:

| From | To | Steps |
| --- | --- | --- |
| (none yet) | | |

A loader may accept more than one major during a deprecation window of
at least two SDK minor releases. Re-run the CTK after migrating a
document.
