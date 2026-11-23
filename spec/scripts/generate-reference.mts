// Copyright (c) Microsoft. All rights reserved.

import { compile, formatDiagnostic, NodeHost } from "@typespec/compiler";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const output = new Map<string, string>();
const program = await compile(
  {
    ...NodeHost,
    mkdirp: async () => {},
    writeFile: async (path, content) => {
      output.set(basename(path), content);
    },
  },
  join(directory, "reference.tsp"),
  {
    emit: ["@agent-hooks/reference-docs"],
    outputDir: join(directory, "tsp-output"),
  },
);
if (program.diagnostics.length > 0) {
  throw new Error(
    program.diagnostics
      .map((diagnostic) => formatDiagnostic(diagnostic))
      .join("\n"),
  );
}
const content = output.get("REFERENCE.md");
if (output.size !== 1 || content === undefined) {
  throw new Error(
    `expected REFERENCE.md, got ${[...output.keys()].join(", ")}`,
  );
}
const check = process.argv.includes("--check");
const target = join(directory, "../draft/REFERENCE.md");
if (check) {
  const committed = await readFile(target, "utf8");
  if (committed !== content)
    throw new Error(
      "REFERENCE.md is out of date. Run pnpm run generate:reference.",
    );
  console.log("Reference docs are up to date.");
} else {
  await writeFile(target, content);
  console.log("Wrote spec/draft/REFERENCE.md");
}
