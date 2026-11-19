// Copyright (c) Microsoft. All rights reserved.

import { compile, formatDiagnostic, NodeHost } from "@typespec/compiler";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const references = ["REFERENCE.md", "REFERENCE-TABLES.md"];
const output = new Map<string, string>();
const program = await compile(
  {
    ...NodeHost,
    mkdirp: async () => {},
    writeFile: async (path, content) => {
      output.set(basename(path), content);
    },
  },
  join(directory, "schema-emitter.tsp"),
  {
    additionalImports: [join(directory, "../draft/schema/src/main.tsp")],
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
if (
  output.size !== references.length ||
  !references.every((name) => output.has(name))
) {
  throw new Error(
    `expected ${references.join(" and ")}, got ${[...output.keys()].join(", ")}`,
  );
}
const check = process.argv.includes("--check");
for (const [name, content] of output) {
  const target = join(directory, "../draft", name);
  if (check) {
    const committed = await readFile(target, "utf8");
    if (committed !== content)
      throw new Error(
        `${name} is out of date. Run pnpm run generate:reference.`,
      );
  } else {
    await writeFile(target, content);
    console.log(`Wrote spec/draft/${name}`);
  }
}
if (check) {
  console.log("Reference docs are up to date.");
}
