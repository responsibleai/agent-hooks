// Copyright (c) Microsoft. All rights reserved.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { releasedVersions, schemaFiles, specPages } from "../src/spec.ts";

const ID_BASE = "https://responsibleai.github.io/agent-hooks/schema/";

describe("specification bundles", () => {
  let root: string;
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const document = (id: string, marker = id) => JSON.stringify({ $id: ID_BASE + id, marker });
  /** A bundle whose schemas and inventory publish under <wire>. */
  const bundle = (name: string, wire: string, marker = name) => {
    const text = name === "draft" ? "DRAFT" : name;
    write(`spec/${name}/AGENT-HOOKS-${text}.md`, `# Spec ${name}\n\nBody ${name}.\n`);
    write(`spec/${name}/reserved-reasons.json`, document(`${wire}/reserved-reasons.json`, marker));
    write(
      `spec/${name}/schema/generated/verdict.schema.json`,
      document(`${wire}/verdict.schema.json`, marker),
    );
    write(`spec/${name}/schema/src/verdict.json`, document(`${wire}/source.json`, marker));
    write(
      `spec/${name}/schema/examples/Verdict/allow.json`,
      document(`${wire}/example.json`, marker),
    );
    write(
      `conformance/${name}/vectors.schema.json`,
      document(`${wire}/conformance/vectors.schema.json`, marker),
    );
  };
  const published = () =>
    Object.fromEntries(
      [...schemaFiles(root)].map(([path, file]) => [path, file.slice(root.length + 1)]),
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-hooks-spec-"));
    bundle("0.1", "v0.1");
    bundle("0.2", "v0.2");
    // 0.10 sorts after 0.2 numerically, not lexically.
    bundle("0.10", "v0.10");
    bundle("draft", "draft");
    write("spec/draft/REFERENCE.md", "# Schema reference\n\nTypeSpec declarations.\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("orders released versions numerically, newest first", () => {
    assert.deepEqual(releasedVersions(root), ["0.10", "0.2", "0.1"]);
  });

  it("publishes each version, the newest as the latest alias, and the draft", () => {
    // Built from parts so the repository's spec-reference check does not
    // treat this fixture link as a reference to a real spec/0.10/ file.
    const latestText = ["AGENT-HOOKS", "0.10.md"].join("-");
    write(
      "spec/draft/AGENT-HOOKS-DRAFT.md",
      `# Draft\n\nSee [0.10](../0.10/${latestText}) and [grammar](schema/path-grammar.abnf). [Reference](REFERENCE.md).\n`,
    );
    assert.deepEqual(specPages(root), [
      { id: "spec", title: "Spec 0.10", body: "\nBody 0.10.\n" },
      { id: "spec/0.10", title: "Spec 0.10", body: "\nBody 0.10.\n" },
      { id: "spec/0.2", title: "Spec 0.2", body: "\nBody 0.2.\n" },
      { id: "spec/0.1", title: "Spec 0.1", body: "\nBody 0.1.\n" },
      {
        id: "spec/draft",
        title: "Draft",
        body: "\nSee [0.10](../0.10/) and [grammar](../../schema/draft/path-grammar.abnf). [Reference](reference/).\n",
      },
      {
        id: "spec/draft/reference",
        title: "Schema reference",
        body: "\nTypeSpec declarations.\n",
      },
    ]);
  });

  it("publishes every bundle document at its $id path", () => {
    write("spec/draft/schema/path-grammar.abnf", 'path = "test"\n');
    assert.deepEqual(published(), {
      "v0.1/reserved-reasons.json": "spec/0.1/reserved-reasons.json",
      "v0.1/verdict.schema.json": "spec/0.1/schema/generated/verdict.schema.json",
      "v0.1/conformance/vectors.schema.json": "conformance/0.1/vectors.schema.json",
      "v0.2/reserved-reasons.json": "spec/0.2/reserved-reasons.json",
      "v0.2/verdict.schema.json": "spec/0.2/schema/generated/verdict.schema.json",
      "v0.2/conformance/vectors.schema.json": "conformance/0.2/vectors.schema.json",
      "v0.10/reserved-reasons.json": "spec/0.10/reserved-reasons.json",
      "v0.10/verdict.schema.json": "spec/0.10/schema/generated/verdict.schema.json",
      "v0.10/conformance/vectors.schema.json": "conformance/0.10/vectors.schema.json",
      "draft/reserved-reasons.json": "spec/draft/reserved-reasons.json",
      "draft/verdict.schema.json": "spec/draft/schema/generated/verdict.schema.json",
      "draft/path-grammar.abnf": "spec/draft/schema/path-grammar.abnf",
      "draft/conformance/vectors.schema.json": "conformance/draft/vectors.schema.json",
    });
  });

  it("lets bundles share a published path only with identical bytes", () => {
    bundle("0.3", "v0.2", "0.2");
    assert.ok(schemaFiles(root).has("v0.2/verdict.schema.json"));
    bundle("0.3", "v0.2", "changed");
    assert.throws(
      () => schemaFiles(root),
      /spec\/0\.3\/reserved-reasons\.json and spec\/0\.2\/reserved-reasons\.json both publish schema\/v0\.2\/reserved-reasons\.json.*@baseUri/,
    );
  });

  it("rejects a bundle that publishes under more than one path", () => {
    write("spec/0.2/reserved-reasons.json", document("draft/reserved-reasons.json"));
    assert.throws(() => schemaFiles(root), /spec\/0\.2 publishes under \["draft","v0\.2"\]/);
  });

  it("rejects an $id outside the published schema folder", () => {
    for (const id of [
      "https://example.invalid/schema/v0.1/x.json",
      `${ID_BASE}v0.1/../x.json`,
      `${ID_BASE}v0.1`,
      `${ID_BASE}v0.1/x.txt`,
      `${ID_BASE}v0.1/x.json\n::error::injected`,
    ]) {
      write("spec/0.1/reserved-reasons.json", JSON.stringify({ $id: id }));
      assert.throws(
        () => schemaFiles(root),
        (error: Error) =>
          error.message ===
          `spec/0.1/reserved-reasons.json: $id must name a .json file under ${ID_BASE}`,
        id,
      );
    }
  });
});
