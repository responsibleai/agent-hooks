# Agent Hooks specification versions

Released specifications live in semantic-version folders named
`MAJOR.MINOR.PATCH`. Ongoing work lives in [`draft/`](draft/).

| Version | Status | Wire version | Specification | Schemas |
| --- | --- | --- | --- | --- |
| [0.1.0](0.1.0/) | Beta snapshot (`0.1.0-beta`, not yet tagged) | `agent-hooks/0.1` | [AGENT-HOOKS-0.1.md](0.1.0/AGENT-HOOKS-0.1.md) | [schema/](0.1.0/schema/) |
| [draft](draft/) | In progress | `agent-hooks/0.1` | [AGENT-HOOKS-0.1.md](draft/AGENT-HOOKS-0.1.md) | [schema/](draft/schema/) |

Each folder is a complete specification bundle:

- `AGENT-HOOKS-<wire-major>.<wire-minor>.md`: the normative text
- `DECLARATION-VERSIONS.md`: host declaration contract versions
- `declaration-errors.json`, `reserved-reasons.json`,
  `reserved-warnings.json`: machine-readable inventories, published
  next to the bundle's schemas on the documentation site
- `schema/`: TypeScript schema source (`src/`), the generated normative
  JSON Schemas (`generated/`), and the path grammar. The `schema/README.md`
  inside a released bundle is the copy frozen at the release; follow
  [`draft/schema/README.md`](draft/schema/README.md) for how to edit,
  generate and check schemas.

The conformance vector grammar, `conformance/vectors.schema.json`, is
not part of a bundle: it tracks the draft, and the documentation site
publishes it once at its own `$id` path.

Standalone JSON examples are organized by type under
`<version>/schema/examples/<Type>/<example>.json`; draft source definitions link
to their examples. From `sdk/typescript` after `npm ci`, run
`node scripts/check-schema-examples.mjs` to validate every bundle, or name
one bundle (`draft`, `0.1.0`) to limit the run. CI runs the full check; each
bundle is checked against its own local schemas, and a symbolic link under
`examples/` fails.

## Working on the specification

Make normative changes in `draft/`. Edit schema shapes in
`draft/schema/src/` and regenerate `draft/schema/generated/` with
`npm run generate:schema` in `sdk/typescript`; the generator and its
drift check target `draft/` by default. SDK development tracks `draft/`
as well: the Python schema mirror, the Rust tests and the version
script read it, the CI schema and vector checks cover every bundle, and
a release tag names the version it ships against. Prose links cite the
latest release.

Released folders are immutable records of a release. The `change-class`
CI check fails a pull request that changes any `MAJOR.MINOR.PATCH`
folder that already exists on its base branch, with one exception: a
new regular `.json` file under `<version>/schema/examples/<Type>/` may
be added, because an example illustrates a schema without changing it.
A modified or deleted file anywhere in a released folder, and any other
new file, fail the check, as does a symbolic link, a submodule or a
hidden file anywhere under `spec/`. Make other changes in `draft/` and
release a new version; adding a new version folder is allowed. The
check reports on every pull request but is not yet in the required
set, so a red result still needs a reviewer to act on it.

The folder version is the specification release version. It is separate
from the wire version (`agent-hooks/X.Y`), the host declaration contract
version, and SDK package versions (see [VERSIONING.md](../VERSIONING.md)).
