// Copyright (c) Microsoft. All rights reserved.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  parseInterceptorResponse,
  serializeInterceptorResponse,
} from "../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(
    path.join(here, "../../../conformance/golden/interceptor-response.json"),
    "utf8",
  ),
);

for (const entry of fixture.valid) {
  test(`valid response: ${entry.name}`, () => {
    const response = parseInterceptorResponse(entry.input);
    assert.deepEqual(
      response,
      JSON.parse(entry.normalized),
    );
    assert.deepEqual(
      parseInterceptorResponse(serializeInterceptorResponse(response)),
      response,
    );
  });
}

for (const entry of fixture.invalid) {
  test(`invalid response: ${entry.name}`, () => {
    assert.throws(
      () => parseInterceptorResponse(entry.input),
      (error) => error.code === fixture.invalid_error,
    );
  });
}

for (const entry of fixture.metadata_bounds) {
  test(`metadata boundary: ${entry.name}`, () => {
    const value = {
      verdict: { decision: "allow" },
      extensions: { provider: { receipt: { p: "x".repeat(entry.padding) } } },
    };
    if (entry.second_provider) {
      value.extensions.second = {};
    }
    const bytes = Buffer.byteLength(canonicalJson(value.extensions));
    assert.equal(bytes, entry.bytes);
    if (entry.valid) {
      parseInterceptorResponse(value);
    } else {
      assert.throws(
        () => parseInterceptorResponse(value),
        (error) => error.code === fixture.invalid_error,
      );
    }
  });
}

test("serialization prefers a bare verdict without metadata", () => {
  assert.deepEqual(
    serializeInterceptorResponse({ verdict: { decision: "allow" } }),
    { decision: "allow" },
  );
  assert.deepEqual(
    serializeInterceptorResponse({ verdict: { decision: "allow" }, extensions: {} }),
    { decision: "allow" },
  );
  assert.deepEqual(
    serializeInterceptorResponse({
      verdict: { decision: "allow" }, extensions: { provider: {} },
    }),
    { verdict: { decision: "allow" }, extensions: { provider: {} } },
  );
});
