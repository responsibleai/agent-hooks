// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Cross-SDK golden vectors for §10 canonical JSON and context identity.
// Loads conformance/golden/identity.json (generated from the Rust core)
// and asserts the TypeScript SDK — which delegates to the same core via
// napi-rs — produces identical output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, contextIdentity } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(resolve(here, "../../../conformance/golden/identity.json"), "utf8"),
);

for (const f of golden.fixtures) {
  if (f.expect.error) {
    test(`golden rejects out-of-domain ${f.id}`, () => {
      // §10.2: fail closed, never a real-looking identity.
      assert.throws(() => contextIdentity(f.ctx), /context_invalid/);
    });
    continue;
  }
  test(`golden canonical_json ${f.id}`, () => {
    assert.equal(canonicalJson(f.ctx), f.expect.canonical_json);
  });
  test(`golden context_identity ${f.id}`, () => {
    assert.equal(contextIdentity(f.ctx), f.expect.context_identity);
  });
}

test("golden L2/L3 stripped", () => {
  const byId = Object.fromEntries(golden.fixtures.map((f) => [f.id, f]));
  assert.equal(
    byId["G-05-l2-l3-stripped"].expect.context_identity,
    byId["G-05b-l2-l3-baseline"].expect.context_identity,
  );
});
