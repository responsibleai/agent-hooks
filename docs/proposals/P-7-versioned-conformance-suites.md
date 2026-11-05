# P-7: Version conformance suites with the specification

- **Status:** Draft
- **Created:** 2026-11-05
- **Author(s):** @CaitieM20
- **PR:** https://github.com/CaitieM20/agent-hooks/pull/7

See the [proposal process](README.md) for scope, lifecycle, decision authority, and review window.

## Abstract

Give each Agent Hooks specification version its own conformance vector schema and vector suite. A vector schema often references schemas owned by one specification version, so a single global schema cannot correctly validate vectors for multiple wire contracts. Versioning the schema and test data together lets CI validate each suite only against the matching specification, while keeping draft-only behavior separate from released conformance claims.

## The gap (Motivation)

Before this proposal, `conformance/vectors.schema.json` had a draft schema `$id` and directly referenced draft schemas, including the host declaration schema. The vectors in `conformance/vectors/` likewise described the working draft and included features not present in released 0.1. CI validated that one schema and suite against the draft schemas; the release workflow did the same. SDK runners also loaded one shared vector directory.

This coupling means the shared schema cannot validate vectors written for another specification version. Pointing it at a released schema would not solve the problem: the current draft vectors use the draft wire string and draft-only fields. Conversely, adding a new spec version can change the referenced schema IDs and make the old suite fail validation even where the old specification remains supported.

## Goals and non-goals

**Goals**

- Bind each vector schema and suite to one specification version.
- Validate each suite against only the corresponding specification bundle.
- Let SDK conformance runs select the suite for the specification being claimed.
- Keep draft development coverage distinct from released conformance claims.

**Non-goals**

- Change the semantics of existing vectors or the host declaration format.
- Make a draft suite eligible for a released conformance claim.
- Require every specification version to have identical scenarios or capabilities.

## Specification

### Recommended normative semantics

1. Each specification version has a vector schema and vector suite identified by that version. The recommended repository layout is `conformance/<version>/vectors.schema.json` and `conformance/<version>/vectors/`, using `draft` for the working draft and the released wire version (for example `0.1`) for a release.
2. A suite's vector schema MUST use an ID under that specification's published schema base and MUST reference schemas from that same specification bundle. It MUST NOT reference another version's schema IDs for version-specific shapes such as host declarations.
3. Every vector in a suite MUST declare the suite's specification version wherever the vector format requires a version. A vector MUST be validated only by its suite schema and the corresponding specification schemas. Unknown versions, missing schemas, or mismatched suite/vector versions MUST fail validation rather than be skipped or validated using another version.
4. An SDK conformance run for a released version MUST use that version's suite. A draft suite MAY be used for development and MUST NOT produce a released conformance claim. A claim MUST identify the released version and report results from its matching suite.
5. Version-specific suites MAY differ in fields and scenarios when the specification contracts differ. Moving a vector between versions or changing its expected behavior requires an explicit reviewed edit; no automatic translation or fallback between suites is performed.

### Schema and wire impact

The vector format remains the format for its selected specification; the change is that each version has its own schema rather than sharing one draft-specific schema. The current draft schema and vectors move together under `conformance/draft/`. A 0.1 schema and suite validate 0.1 vectors against `spec/0.1` schemas; draft vectors validate against `spec/draft` schemas. Existing draft vectors MUST NOT be relabeled as 0.1 merely to make validation pass.

The schema `$id` for each suite is published under the corresponding schema base, for example:

```text
schema/v0.1/conformance/vectors.schema.json
schema/draft/conformance/vectors.schema.json
```

The per-spec vector schemas should share a common schema fragment only for fields whose shape is truly version-independent. Version-specific references and constraints remain in each suite schema so validation does not depend on cross-version `$ref` resolution.

## Rationale

| Option | Advantages | Costs and risks |
| --- | --- | --- |
| Keep one global schema and suite | Minimal file movement and one runner path. | One schema cannot express independent version-specific `$ref`s; vectors for other versions are rejected or validated against the wrong contract. |
| One schema and suite per spec version (recommended) | Validation and fixtures are explicit and reproducible for each contract; released suites remain separate from draft experiments. | Requires coordinated changes to CI, release checks, SDK runners, docs publishing, and schema mirrors. |
| Keep one schema with a union of all versioned shapes | Could accept multiple formats in one place. | Couples a supposedly version-specific suite to every bundle; allows the wrong version's schema to validate a vector unless extra version/schema consistency logic is added. |

### Recommendation (for discussion)

Adopt the per-spec layout. Its file structure makes the schema/vector pairing visible and lets validators resolve only the matching bundle. It also avoids pretending that a draft-only vector establishes conformance for a released specification. The added runner and workflow plumbing is preferable to a growing union schema with implicit cross-version rules.

## Security and privacy

This proposal changes validation and test organization, not runtime authorization or enforcement. Each suite remains untrusted test input and continues to use the existing resource limits and harness isolation. Selecting the wrong or unavailable suite must fail closed as a test/configuration error; it must not silently fall back to draft vectors or report a passing claim.

## Backward compatibility

The vector schema path and vector directory path change. SDK runner defaults move to the released `conformance/0.1/vectors/` suite; draft-suite SDK support is deferred. Existing invocations that implicitly load `conformance/vectors/` must be updated. Released specification schemas and their contents remain immutable.

At migration, move the current working suite to `conformance/draft/` without changing its meaning. Add a `conformance/0.1/` suite only for cases valid under the released 0.1 contract; do not convert draft vectors by changing their `spec` string alone. Existing released claims remain tied to their reported specification and must not be retroactively evaluated against the draft suite.

## Performance and operational impact

CI validates each existing suite against its matching schema bundle. Workflows must fail if an expected schema or suite is absent, and should report which versions were validated. Documentation publishing must publish every versioned vector schema under its declared `$id`.

## SDK surface and implementation impact

- Keep the SDK CTK runners and packaged vector mirror on the released `0.1` suite for now; draft-suite SDK support is deferred to separate work.
- Keep draft development validation available in repository CI without allowing it to create a released conformance report.
- Update each reference harness and vendored CTK vector mirror to package the appropriate suite or suites.
- Update `scripts/check-spec-versions.py`, schema example/equivalence checks, release and CI workflows, schema-drift synchronization, and docs-site staging/publication to discover and validate suites by version.
- Preserve per-SDK tests for cases not expressible in JSON vectors.

## Conformance and tests

| Case | Expected result |
| --- | --- |
| A 0.1 vector is checked with the 0.1 suite schema and schema bundle. | It passes or fails according to the released 0.1 contract, independent of draft schemas. |
| A draft vector uses a draft-only field. | It is checked against the draft schema only and cannot contribute to a released claim. |
| A vector's declared spec does not match its suite directory. | Validation fails with an actionable mismatch. |
| A suite schema references a missing or cross-version-only schema ID. | Schema compilation fails; CI does not skip the suite. |
| A requested supported release has no suite or schema. | The conformance run fails rather than falling back to another version. |
| A draft suite is requested for a released claim. | The runner refuses to emit a released conformance report. |
