// Copyright (c) Microsoft. All rights reserved.

// CTK self-test: run all vectors against the ReferenceHarness.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { SPEC_VERSION_0_1, SPEC_VERSION_DRAFT } from "../dist/index.js";
import {
  DRAFT_NOT_CLAIMABLE,
  conformanceReport,
  loadVectors,
  runVector,
  ReferenceHarness,
} from "../dist/ctk/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = resolve(here, "../../../conformance/vectors");

// Pinned skip set: a skip outside this manifest fails the
// suite — the parity gate must not silently degrade to green when a
// capability regresses or a new vector is quietly skipped.
// JSON.parse rounds beyond-2^53 integers before any guard can see
// them, so TS declares neither int64_json nor bigint_json. The
// streaming/incremental part (§12.1 exception) skips because the
// reference harness buffers caller-bound output and does not declare
// incremental_output. The declaration parts (§7.7.9) run: the harness
// declares host_declaration and builds every emitter through the loader.
const EXPECTED_SKIPS = new Set([
  "AH-CTK-090",
  "AH-CTK-091",
  "AH-CTK-095",
  "AH-CTK-110",
  "AH-CTK-111",
  "AH-CTK-112",
  "AH-CTK-113",
]);

const skipped = new Set();
const results = [];
const vectors = loadVectors(vectorsDir);

for (const v of vectors) {
  test(`ctk ${v.id} ${v.title}`, async () => {
    const r = await runVector(new ReferenceHarness(), v);
    results.push(r);
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

test("a conformance report names a released version, never the draft", () => {
  // Running the working test set is development; the report a claim
  // attaches names a released version, and the runner refuses the draft.
  assert.equal(results.length, vectors.length);
  assert.throws(() => conformanceReport(SPEC_VERSION_DRAFT, results), {
    name: "RangeError",
    message: DRAFT_NOT_CLAIMABLE,
  });
  assert.throws(() => conformanceReport("agent-hooks/9.9", results), /SUPPORTED_SPEC_VERSIONS/);
  const report = conformanceReport(SPEC_VERSION_0_1, results);
  assert.equal(report.spec, "agent-hooks/0.1");
  assert.equal(report.failed, 0);
  assert.equal(report.skipped, EXPECTED_SKIPS.size);
  assert.equal(report.passed + report.skipped, vectors.length);
  const names = report.parts.map((p) => p.part);
  assert.deepEqual(names, [...names].sort());
  for (const part of report.parts) {
    assert.equal(part.passed + part.failed + part.skipped, part.vectors.length);
  }
  const streaming = report.parts.find((p) => p.part === "streaming/incremental");
  assert.equal(streaming.skipped, 4);
});
