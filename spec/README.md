# Agent Hooks specification versions

A specification version is `MAJOR.MINOR`, the same number as the wire
string `agent-hooks/MAJOR.MINOR`. Released versions live in
`spec/<MAJOR.MINOR>/`; the working text lives in [`draft/`](draft/).

| Version | Status | Wire version | Specification | Schemas |
| --- | --- | --- | --- | --- |
| [0.1](0.1/) | Released 2026-10-22 | `agent-hooks/0.1` | [AGENT-HOOKS-0.1.md](0.1/AGENT-HOOKS-0.1.md) | [schema/](0.1/schema/) |
| [draft](draft/) | Draft | `agent-hooks/0.1` | [AGENT-HOOKS-DRAFT.md](draft/AGENT-HOOKS-DRAFT.md) | [schema/](draft/schema/) |

0.1 is the text the SDKs shipped against at the `v0.1.0-beta.3` tag,
read in unchanged except for its header line. The draft carries the
last released wire string until the first breaking change lands in it;
that pull request moves the draft's wire string to the version the cut
will be named, and from then until the cut the draft announces the
coming version ([VERSIONING.md](../VERSIONING.md)).

Each folder is a complete specification bundle with the same layout:

- `AGENT-HOOKS-<MAJOR.MINOR>.md`, or `AGENT-HOOKS-DRAFT.md` in the draft:
  the normative text. Its header line reads
  `**Status:** Released · **Version:** \`X.Y\` · **Date:** YYYY-MM-DD`
  for a version and `**Status:** Draft · **Version:** \`DRAFT\`` with a
  date for the draft. Alpha and beta never appear in a header.
- `DECLARATION-VERSIONS.md`: host declaration contract versions
- `declaration-errors.json`, `reserved-reasons.json` and, from the
  draft on, `reserved-warnings.json`: machine-readable inventories
- `schema/`: the normative JSON Schemas, generated from TypeScript
  source: `src/`, `generated/` with the per-point context schemas in
  `strict-contexts/`, standalone examples under
  `examples/<Type>/<example>.json`, and the path grammar. See
  [`draft/schema/README.md`](draft/schema/README.md) for how to edit,
  generate and check them. 0.1's source is the draft's with everything
  after 0.1 removed; its schemas are instance-equivalent to the ones
  the tag shipped ([RELEASING.md](../RELEASING.md)).

From `sdk/typescript` after `npm ci`, run
`node scripts/check-schema-examples.mjs` to validate the examples of
every bundle, or name one bundle to limit the run. CI runs the full
check; a symbolic link under `examples/` fails.

## Working on the specification

Make normative changes in `draft/`. Edit schema shapes in
`draft/schema/src/` and regenerate `draft/schema/generated/` with
`npm run generate:schema` in `sdk/typescript`; the generator and its
drift check target `draft/` by default.

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
