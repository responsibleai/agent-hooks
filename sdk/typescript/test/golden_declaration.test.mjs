// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Cross-SDK golden fixtures for the host declaration document (§7.7).
// Loads conformance/golden/declaration.json (generated from the Rust
// core) and asserts this SDK resolves each document to the same
// canonical form byte for byte.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HostDeclaration,
  HostRegistry,
  InterceptionEmitter,
  canonicalDeclaration,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(resolve(here, "../../../conformance/golden/declaration.json"), "utf8"),
);

const allow = { intercept: () => ({ decision: "allow" }) };

/** A registry carrying exactly the golden names over the golden surface;
 * every resolver is a stand-in, since only the resolved form is under test. */
function goldenRegistry() {
  const reg = new HostRegistry(golden.surface);
  for (const k of golden.names.kinds) reg.kind(k, () => allow);
  for (const p of golden.names.identity_providers) reg.identityProvider(p, () => "id");
  for (const r of golden.names.approval_resolvers) {
    reg.approvalResolver(r, { resolve: (req) => ({ outcome: "reject", context_identity: req.context_identity }) });
  }
  for (const r of golden.names.approval_redactors) reg.approvalRedactor(r, (c) => c);
  return reg;
}

for (const f of golden.fixtures) {
  test(`golden declaration ${f.id}`, () => {
    const em = InterceptionEmitter.fromDeclaration(HostDeclaration.fromValue(f.document), goldenRegistry());
    assert.equal(canonicalDeclaration(em.declaration), f.expect.canonical_json);
    assert.equal(em.declaration.declaration, f.document.declaration);
  });
}
