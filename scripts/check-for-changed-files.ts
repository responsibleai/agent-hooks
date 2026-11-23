// Copyright (c) Microsoft. All rights reserved.

// Fails when the working tree has changes after a build, so CI catches
// generated output that was not committed with its source.

import { spawnSync } from "node:child_process";

const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf-8" });
if (status.stderr) console.error(status.stderr);
if (status.status !== 0) process.exit(status.status ?? 1);

if (status.stdout) {
  console.log(status.stdout);
  spawnSync("git", ["--no-pager", "diff"], { stdio: "inherit" });
  console.error(
    "ERROR: Files above were changed during the build but not included in the change. " +
      "Run pnpm generate and commit the result.",
  );
  process.exit(1);
}
