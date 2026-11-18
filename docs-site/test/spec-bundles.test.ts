// Copyright (c) Microsoft. All rights reserved.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { INVENTORIES, publishedPath, stageSpecBundles } from "../src/spec-bundles.ts";

const ID_BASE = "https://responsibleai.github.io/agent-hooks/schema/";
// Creating symbolic links may require elevation on Windows.
const symlinkTest = process.platform === "win32" ? it.skip : it;

function schema(identity: string, marker: string): string {
  return JSON.stringify({ $id: ID_BASE + identity, title: marker }) + "\n";
}

/**
 * A bundle whose schemas publish under <wire> and carry <marker>.
 * "generated" puts them under schema/generated/ with strict-contexts/ and a
 * src/ folder; "flat" puts them under schema/ with agent-context/.
 */
function bundle(
  root: string,
  name: string,
  wire: string,
  marker: string,
  layout: "generated" | "flat" = "generated",
  inventories: readonly string[] = INVENTORIES,
): string {
  const folder = join(root, "spec", name);
  const schemas = join(folder, "schema", layout === "generated" ? "generated" : "");
  const points = join(schemas, layout === "generated" ? "strict-contexts" : "agent-context");
  mkdirSync(points, { recursive: true });
  if (layout === "generated") {
    mkdirSync(join(folder, "schema/src"));
    writeFileSync(join(folder, "schema/src/verdict.tsp"), "model Verdict {}\n");
  }
  const text = name === "draft" ? "AGENT-HOOKS-DRAFT.md" : `AGENT-HOOKS-${name}.md`;
  writeFileSync(join(folder, text), `# spec ${name}\n`);
  for (const inventory of inventories) {
    writeFileSync(
      join(folder, inventory),
      JSON.stringify({ $id: ID_BASE + `${wire}/${inventory}`, from: name }),
    );
  }
  writeFileSync(
    join(schemas, "agent-context.schema.json"),
    schema(`${wire}/agent-context.schema.json`, marker),
  );
  writeFileSync(
    join(points, "input.schema.json"),
    schema(`${wire}/agent-context/input.schema.json`, marker),
  );
  return folder;
}

describe("stageSpecBundles", () => {
  let root: string;
  let docs: string;
  let publicDir: string;
  const read = (path: string) =>
    readFileSync(join(path.startsWith("schema/") ? publicDir : docs, path), "utf8");
  const title = (path: string) => JSON.parse(read(path)).title;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-hooks-docs-"));
    // 0.1 is flat and predates reserved-warnings.json, like the real one.
    bundle(root, "0.1", "v0.1", "first", "flat", [
      "reserved-reasons.json",
      "declaration-errors.json",
    ]);
    bundle(root, "0.2", "v0.2", "second");
    // 0.10 sorts after 0.2 numerically, not lexically.
    bundle(root, "0.10", "v0.10", "tenth");
    const draft = bundle(root, "draft", "draft", "working");
    writeFileSync(
      join(draft, "AGENT-HOOKS-DRAFT.md"),
      "# draft\n\n> The latest released version is [0.10](../0.10/AGENT-HOOKS-0.10.md).\n",
    );
    for (const [version, published] of [
      ["0.1", "v0.1"],
      ["0.2", "v0.2"],
      ["0.10", "v0.10"],
      ["draft", "draft"],
    ]) {
      mkdirSync(join(root, "conformance", version), { recursive: true });
      writeFileSync(
        join(root, "conformance", version, "vectors.schema.json"),
        schema(`${published}/conformance/vectors.schema.json`, version),
      );
    }
    docs = join(root, "docs-site/src/content/docs");
    publicDir = join(root, "docs-site/public");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("orders versions numerically, newest first", () => {
    assert.deepEqual(stageSpecBundles(root), ["0.10", "0.2", "0.1"]);
  });

  it("writes one page per version, the draft page and the latest alias", () => {
    for (const version of stageSpecBundles(root)) {
      assert.ok(read(`spec/${version}.md`).includes(`\nslug: spec/${version}\n`));
    }
    assert.ok(read("spec.md").startsWith('---\ntitle: "spec 0.10"\nslug: spec\n---\n'));
    assert.equal(
      read("spec/draft.md"),
      '---\ntitle: "draft"\nslug: spec/draft\n---\n\n> The latest released version is [0.10](0.10.md).\n',
    );
  });

  it("publishes the draft grammar and points its link at it", () => {
    const draft = join(root, "spec/draft");
    writeFileSync(join(draft, "schema/path-grammar.abnf"), 'path = "test"\n');
    writeFileSync(
      join(draft, "AGENT-HOOKS-DRAFT.md"),
      "# draft\n[grammar](schema/path-grammar.abnf)\n",
    );
    stageSpecBundles(root);
    assert.ok(read("spec/draft.md").includes("](../../schema/draft/path-grammar.abnf)"));
    assert.equal(read("schema/draft/path-grammar.abnf"), 'path = "test"\n');
  });

  it("requires the text file to carry the folder name", () => {
    renameSync(
      join(root, "spec/0.2/AGENT-HOOKS-0.2.md"),
      join(root, "spec/0.2/AGENT-HOOKS-0.2.0.md"),
    );
    assert.throws(
      () => stageSpecBundles(root),
      /exactly one specification text, AGENT-HOOKS-0\.2\.md/,
    );
  });

  it("publishes schemas from any layout at their $id paths", () => {
    stageSpecBundles(root);
    assert.equal(title("schema/v0.1/agent-context.schema.json"), "first");
    assert.equal(title("schema/v0.1/agent-context/input.schema.json"), "first");
    assert.equal(title("schema/v0.2/agent-context.schema.json"), "second");
    assert.equal(title("schema/v0.10/agent-context.schema.json"), "tenth");
    assert.equal(title("schema/draft/agent-context/input.schema.json"), "working");
    for (const version of ["0.1", "0.2", "0.10"]) {
      assert.equal(title(`schema/v${version}/conformance/vectors.schema.json`), version);
    }
    assert.equal(title("schema/draft/conformance/vectors.schema.json"), "draft");
    assert.ok(!existsSync(join(publicDir, "schema/strict-contexts")));
    assert.ok(!existsSync(join(publicDir, "schema/v0.2/src")));
  });

  it("publishes only the inventories a bundle carries", () => {
    stageSpecBundles(root);
    for (const name of ["reserved-reasons.json", "declaration-errors.json"]) {
      assert.equal(JSON.parse(read(`schema/v0.1/${name}`)).from, "0.1");
    }
    assert.ok(!existsSync(join(publicDir, "schema/v0.1/reserved-warnings.json")));
    for (const name of INVENTORIES) {
      assert.equal(JSON.parse(read(`schema/v0.10/${name}`)).from, "0.10");
      assert.equal(JSON.parse(read(`schema/draft/${name}`)).from, "draft");
    }
  });

  it("allows bundles to share a path with identical bytes", () => {
    bundle(root, "0.3", "v0.2", "second");
    mkdirSync(join(root, "conformance/0.3"));
    writeFileSync(
      join(root, "conformance/0.3/vectors.schema.json"),
      schema("v0.2/conformance/vectors.schema.json", "0.2"),
    );
    for (const inventory of INVENTORIES) {
      writeFileSync(
        join(root, "spec/0.3", inventory),
        JSON.stringify({ $id: ID_BASE + `v0.2/${inventory}`, from: "0.2" }),
      );
    }
    assert.deepEqual(stageSpecBundles(root), ["0.10", "0.3", "0.2", "0.1"]);
  });

  it("rejects bundles that publish different bytes at the same path", () => {
    bundle(root, "0.3", "v0.2", "changed");
    assert.throws(
      () => stageSpecBundles(root),
      /spec\/0\.3 and spec\/0\.2 both publish schema\/v0\.2\/agent-context\.schema\.json.*ID_BASE/,
    );
  });

  it("rejects an inventory whose $id names another bundle's path", () => {
    writeFileSync(
      join(root, "spec/0.2/reserved-reasons.json"),
      JSON.stringify({ $id: ID_BASE + "draft/reserved-reasons.json" }),
    );
    assert.throws(() => stageSpecBundles(root), {
      message:
        "spec/0.2/reserved-reasons.json: $id names schema/draft/reserved-reasons.json; " +
        "the bundle publishes under schema/v0.2/",
    });
  });

  symlinkTest("rejects symbolic links to files", () => {
    const generated = join(root, "spec/0.2/schema/generated");
    symlinkSync("agent-context.schema.json", join(generated, "copy.schema.json"));
    assert.throws(() => stageSpecBundles(root), /copy\.schema\.json is a symbolic link/);
    unlinkSync(join(generated, "copy.schema.json"));
    const text = join(root, "spec/0.2/AGENT-HOOKS-0.2.md");
    unlinkSync(text);
    symlinkSync("../0.1/AGENT-HOOKS-0.1.md", text);
    assert.throws(() => stageSpecBundles(root), /AGENT-HOOKS-0\.2\.md is a symbolic link/);
  });

  symlinkTest("rejects symbolic links to schema directories", () => {
    const generated = join(root, "spec/0.2/schema/generated");
    rmSync(generated, { recursive: true });
    symlinkSync("../../0.10/schema/generated", generated);
    assert.throws(() => stageSpecBundles(root), /generated is a symbolic link/);
    unlinkSync(generated);
    const schemaDir = join(root, "spec/0.2/schema");
    rmSync(schemaDir, { recursive: true });
    symlinkSync("../0.10/schema", schemaDir);
    assert.throws(() => stageSpecBundles(root), /schema is a symbolic link/);
  });

  it("replaces stale output when restaging", () => {
    stageSpecBundles(root);
    writeFileSync(join(docs, "spec/9.9.md"), "stale\n");
    mkdirSync(join(publicDir, "schema/v9.9"));
    stageSpecBundles(root);
    assert.ok(!existsSync(join(docs, "spec/9.9.md")));
    assert.ok(!existsSync(join(publicDir, "schema/v9.9")));
  });
});

describe("publishedPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-hooks-id-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rejects unpublishable $id values without echoing line breaks", () => {
    const file = join(dir, "x.schema.json");
    const cases: Record<string, RegExp> = {
      "https://example.invalid/other/x.json": /no \/schema\/ segment/,
      [ID_BASE + "v0.1/../x.json"]: /does not name a file under a path/,
      [ID_BASE + "v0.1"]: /does not name a file under a path/,
      [ID_BASE + "v0.1/x.json\n::error::injected"]: /control characters/,
    };
    for (const [identity, expected] of Object.entries(cases)) {
      writeFileSync(file, JSON.stringify({ $id: identity }));
      assert.throws(
        () => publishedPath(file),
        (error: Error) => expected.test(error.message) && !error.message.includes("\n"),
        identity,
      );
    }
    writeFileSync(file, JSON.stringify({ title: "no id" }));
    assert.throws(() => publishedPath(file), /has no \$id/);
  });

  it("escapes percent signs in reported $id values", () => {
    const file = join(dir, "x.schema.json");
    writeFileSync(file, JSON.stringify({ $id: "https://example.invalid/50%/x.json" }));
    assert.throws(() => publishedPath(file), /50%25\/x\.json/);
  });
});
