// Copyright (c) Microsoft. All rights reserved.

// Advisory (the draft-tests job): the full draft suite runs under the
// draft. Binding tests to a draft revision is #188.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { SPEC_VERSION_DRAFT } from "../../dist/index.js";
import { loadVectors, runVector, ReferenceHarness } from "../../dist/ctk/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = loadVectors(resolve(here, "../../../../conformance/draft/vectors"));
const expectedSkips = new Set(["AH-CTK-090", "AH-CTK-091", "AH-CTK-095", "AH-CTK-110", "AH-CTK-111", "AH-CTK-112", "AH-CTK-113"]);

test("the full draft suite is selected", () => {
  assert.ok(vectors.length > 0);
});

const skipped = new Set();
for (const v of vectors) {
  test(`draft ${v.id} ${v.title}`, async () => {
    const r = await runVector(new ReferenceHarness(SPEC_VERSION_DRAFT), v);
    if (r.status === "skip") {
      skipped.add(r.id);
      assert.ok(expectedSkips.has(r.id), `unexpected skip: ${r.id} (${r.detail})`);
      return;
    }
    assert.equal(r.status, "pass", `${r.status} ${r.detail}\n  ${r.failures.join("\n  ")}`);
  });
}

test("draft capability skip set matches the manifest", () => {
  assert.deepEqual([...skipped].sort(), [...expectedSkips].sort());
});
