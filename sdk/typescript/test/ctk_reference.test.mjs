// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// CTK self-test: run all vectors against the ReferenceHarness.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadVectors, runVector, ReferenceHarness } from "../dist/ctk/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = resolve(here, "../../../conformance/vectors");

// Pinned skip set (NEXT-15): a skip outside this manifest fails the
// suite — the parity gate must not silently degrade to green when a
// capability regresses or a new vector is quietly skipped.
// JSON.parse rounds beyond-2^53 integers before any guard can see
// them, so TS declares neither int64_json nor bigint_json.
const EXPECTED_SKIPS = new Set(["AH-CTK-090", "AH-CTK-091", "AH-CTK-095"]);

const skipped = new Set();
const vectors = loadVectors(vectorsDir);

for (const v of vectors) {
  test(`ctk ${v.id} ${v.title}`, async () => {
    const r = await runVector(new ReferenceHarness(), v);
    if (r.status === "skip") {
      skipped.add(r.id);
      assert.ok(
        EXPECTED_SKIPS.has(r.id),
        `unexpected skip: ${r.id} (${r.detail}) — update EXPECTED_SKIPS only with a capability rationale`,
      );
      return;
    }
    assert.equal(r.status, "pass", `\n  ${r.failures.join("\n  ")}`);
  });
}

test("ctk skip set matches the manifest exactly", () => {
  assert.deepEqual(
    [...skipped].sort(),
    [...EXPECTED_SKIPS].sort(),
    "expected-but-not-skipped vectors mean the manifest is stale",
  );
});
