// Copyright (c) Microsoft. All rights reserved.

// CTK self-test: the vectors against the ReferenceHarness. The gating
// run is under 0.1, the newest released version: the released set runs
// and the draft-only vectors (`introduced_in: draft`) are skipped. The
// draft-only run lives in test/draft/, which the advisory job runs.
// Binding tests to a draft revision is #188.

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
  REFERENCE_DECLARATION,
} from "../dist/ctk/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = resolve(here, "../../../conformance/0.1/vectors");

// Pinned capability skips: a skip outside this manifest fails the
// suite — the parity gate must not silently degrade to green when a
// capability regresses or a new vector is quietly skipped.
// JSON.parse rounds beyond-2^53 integers before any guard can see
// them, so TS declares neither int64_json nor bigint_json. The
// streaming/incremental part (§12.1 exception) skips because the
// reference harness buffers caller-bound output and does not declare
// incremental_output. The declaration parts (§7.7.9) run: the harness
// declares host_declaration and builds every emitter through the loader.
const CAPABILITY_SKIPS = new Set([
  "AH-CTK-090",
  "AH-CTK-091",
  "AH-CTK-095",
  "AH-CTK-110",
  "AH-CTK-111",
  "AH-CTK-112",
  "AH-CTK-113",
]);
const EXPECTED_SKIPS = CAPABILITY_SKIPS;

const skipped = new Set();
const results = [];
const vectors = loadVectors(vectorsDir);

test("reference declaration uses the released specification", () => {
  assert.equal(REFERENCE_DECLARATION.spec, SPEC_VERSION_0_1);
  assert.equal(REFERENCE_DECLARATION.declaration, "agent-hooks-declaration/1.0");
  assert.deepEqual(REFERENCE_DECLARATION.surface.declaration_versions, ["agent-hooks-declaration/1.0"]);
});

for (const v of vectors) {
  test(`ctk ${v.id} ${v.title}`, async () => {
    const r = await runVector(new ReferenceHarness(SPEC_VERSION_0_1), v);
    results.push(r);
    if (r.status === "skip") {
      skipped.add(r.id);
      assert.ok(
        EXPECTED_SKIPS.has(r.id),
        `unexpected skip: ${r.id} (${r.detail}) — update CAPABILITY_SKIPS only with a capability rationale`,
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
  assert.ok(vectors.every((v) => v.introduced_in !== "draft"));
});

test("a conformance report names a released version, never the draft", () => {
  // The SDK runner currently exercises the released 0.1 suite.
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

test("a harness names the version it builds under", async () => {
  const nameless = {
    name: "nameless",
    capabilities: new Set(),
    setup() {
      throw new Error("setup must not be reached");
    },
    async run() {
      throw new Error("run must not be reached");
    },
    teardown() {},
  };
  await assert.rejects(
    () => runVector(nameless, vectors[0]),
    /harness nameless spec must name a supported specification version/,
  );
});
