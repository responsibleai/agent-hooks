// Copyright (c) Microsoft. All rights reserved.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("workflow annotation data escapes percent and line breaks", () => {
  const result = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'import { escapeWorkflowCommandData } from "./scripts/generate-schemas.mts"; process.stdout.write(escapeWorkflowCommandData("%\\r\\n::error::injected"))',
    ],
    { cwd: sdk, encoding: "utf8" },
  );
  assert.equal(result, "%25%0D%0A::error::injected");
});
