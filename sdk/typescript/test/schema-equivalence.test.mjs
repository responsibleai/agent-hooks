import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(packageRoot, "scripts", "schema-equivalence.mts");
const idOrigin = "https://responsibleai.github.io/agent-hooks/schema/";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "schema-equivalence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeSchema(root, set, version, name, schema) {
  const directory = path.join(root, set);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, name),
    JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: `${idOrigin}${version}/${name}`, ...schema }),
  );
}

function compare(oldPath, newPath, structural = false) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      script,
      "--old",
      oldPath,
      "--new",
      newPath,
      "--random",
      "0",
      ...(structural ? ["--structural-diff"] : []),
    ],
    { cwd: packageRoot, encoding: "utf8" },
  );
}

test("schema equivalence tests schema-specific values in either comparison direction", async (t) => {
  const root = await fixture(t);
  const oldPath = path.join(root, "v01");
  const newPath = path.join(root, "draft");
  await writeSchema(root, "v01", "0.1", "interception-point.schema.json", { type: "string", enum: ["input"] });
  await writeSchema(root, "draft", "draft", "interception-point.schema.json", { type: "string", enum: ["custom"] });

  for (const [oldSet, newSet] of [[oldPath, newPath], [newPath, oldPath]]) {
    const result = compare(oldSet, newSet);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^interception-point\s+.*\s+[1-9]\d*$/m);
    assert.match(result.stdout, /disagreements/);
  }
});

test("schema equivalence reports a newly added schema file whichever side contains it", async (t) => {
  const root = await fixture(t);
  const oldPath = path.join(root, "v01");
  const newPath = path.join(root, "draft");
  await mkdir(oldPath);
  await mkdir(newPath);
  await writeSchema(root, "v01", "0.1", "new-contract.schema.json", { type: "object" });

  const oldOnly = compare(oldPath, newPath);
  assert.equal(oldOnly.status, 1, `${oldOnly.stderr}\n${oldOnly.stdout}`);
  assert.match(oldOnly.stdout, /new-contract\.schema\.json.*file exists only in the old set/, oldOnly.stderr);
  const oldOnlyStructural = compare(oldPath, newPath, true);
  assert.equal(oldOnlyStructural.status, 0, oldOnlyStructural.stderr);
  assert.match(oldOnlyStructural.stdout, /new-contract\.schema\.json.*file exists only in the old set/);

  await rm(path.join(oldPath, "new-contract.schema.json"));
  await writeSchema(root, "draft", "draft", "new-contract.schema.json", { type: "object" });
  const newOnly = compare(oldPath, newPath);
  assert.equal(newOnly.status, 1, `${newOnly.stderr}\n${newOnly.stdout}`);
  assert.match(newOnly.stdout, /new-contract\.schema\.json.*file exists only in the new set/, newOnly.stderr);
  const newOnlyStructural = compare(oldPath, newPath, true);
  assert.equal(newOnlyStructural.status, 0, newOnlyStructural.stderr);
  assert.match(newOnlyStructural.stdout, /new-contract\.schema\.json.*file exists only in the new set/);
});
