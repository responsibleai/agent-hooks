// Copyright (c) Microsoft. All rights reserved.

// Advisory (the draft-tests job): the working test set for the next
// version, the draft-only vectors, passes under the draft. Binding tests
// to a draft revision is #188.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { SPEC_VERSION_DRAFT } from "../../dist/index.js";
import { loadVectors, runVector, ReferenceHarness } from "../../dist/ctk/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = loadVectors(resolve(here, "../../../../conformance/vectors")).filter(
  (v) => v.introduced_in === "draft",
);

test("the draft-only set is the 17 vectors since 0.1", () => {
  assert.equal(vectors.length, 17);
});

for (const v of vectors) {
  test(`draft-only ${v.id} ${v.title}`, async () => {
    const r = await runVector(new ReferenceHarness(SPEC_VERSION_DRAFT), v);
    assert.equal(r.status, "pass", `${r.status} ${r.detail}\n  ${r.failures.join("\n  ")}`);
  });
}
