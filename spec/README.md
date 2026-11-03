# Agent Hooks specification versions

A specification version is `MAJOR.MINOR`, the same number as the wire
string `agent-hooks/MAJOR.MINOR`. Released versions live in
`spec/<MAJOR.MINOR>/`; the working text lives in [`draft/`](draft/).

| Version | Status | Wire version | Specification | Schemas |
| --- | --- | --- | --- | --- |
| [0.1](0.1/) | Released 2026-10-22 | `agent-hooks/0.1` | [AGENT-HOOKS-0.1.md](0.1/AGENT-HOOKS-0.1.md) | [schema/](0.1/schema/) |
| [draft](draft/) | Draft | `agent-hooks/0.1` | [AGENT-HOOKS-DRAFT.md](draft/AGENT-HOOKS-DRAFT.md) | [schema/](draft/schema/) |

0.1 is the text the SDKs shipped against at the `v0.1.0-beta.3` tag,
read in unchanged except for its header line. The draft's wire string
names the released version the draft is compatible with; a breaking
change bumps it when the next version is cut
([VERSIONING.md](../VERSIONING.md)).

Each folder is a complete specification bundle:

- `AGENT-HOOKS-<MAJOR.MINOR>.md`, or `AGENT-HOOKS-DRAFT.md` in the draft:
  the normative text. Its header line reads
  `**Status:** Released · **Version:** \`X.Y\` · **Date:** YYYY-MM-DD`
  for a version and `**Status:** Draft · **Version:** \`DRAFT\` · **Date:**`
  the date of the last change for the draft. Alpha and beta never appear
  in a header.
- `DECLARATION-VERSIONS.md`: host declaration contract versions
- `declaration-errors.json`, `reserved-reasons.json` and, from the
  draft on, `reserved-warnings.json`: machine-readable inventories,
  published next to the bundle's schemas on the documentation site
- `schema/`: the normative JSON Schemas. 0.1 keeps them flat, with the
  per-point context schemas in `agent-context/`. The draft generates
  them from TypeScript source: `src/`, `generated/` with
  `strict-contexts/`, and standalone examples under
  `examples/<Type>/<example>.json`; see
  [`draft/schema/README.md`](draft/schema/README.md) for how to edit,
  generate and check them. Published schema paths are `schema/v<X.Y>/`
  for a version and `schema/draft/` for the draft.

The conformance vector grammar, `conformance/vectors.schema.json`, is
not part of a bundle: it tracks the draft, and the documentation site
publishes it once at its own `$id` path.

From `sdk/typescript` after `npm ci`, run
`node scripts/check-schema-examples.mjs` to validate the examples of
every bundle that has them, or name one bundle (`draft`) to limit the
run. CI runs the full check; a bundle without examples is named and
skipped, and a symbolic link under `examples/` fails.

## Working on the specification

Make normative changes in `draft/`, and set the header date to the day
of the change. Edit schema shapes in `draft/schema/src/` and regenerate
`draft/schema/generated/` with `npm run generate:schema` in
`sdk/typescript`; the generator and its drift check target `draft/` by
default. SDK development tracks `draft/` as well: the Python schema
mirror, the Rust tests and the version script read it, the CI schema
checks cover every bundle, and an SDK release names the specification
versions it supports. Prose links cite the released text, `0.1/`, and
the draft for what 0.1 does not define.

Released folders are immutable records of a release. The `change-class`
CI check fails a pull request that changes any `MAJOR.MINOR` folder
that already exists on its base branch, with one exception: a new
regular `.json` file under `<version>/schema/examples/<Type>/` may be
added, because an example illustrates a schema without changing it. A
modified or deleted file anywhere in a released folder, and any other
new file, fail the check, as does a symbolic link, a submodule or a
hidden file anywhere under `spec/`. Make other changes in `draft/` and
release a new version ([RELEASING.md](../RELEASING.md)); adding a new
version folder is allowed. The check reports on every pull request but
is not yet in the required set, so a red result still needs a reviewer
to act on it.
