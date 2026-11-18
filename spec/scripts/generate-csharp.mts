// Copyright (c) Microsoft. All rights reserved.

import { compile, formatDiagnostic, NodeHost, normalizePath } from "@typespec/compiler";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(directory, "../../sdk/dotnet/src/AgentHooks.Contracts/Generated");
const emitter = normalizePath(join(directory, "dist/csharp/emitter.js"));
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((argument) => argument !== "--check")) {
  throw new Error("Usage: generate-csharp.mts [--check]");
}
const output = new Map<string, string>();
const program = await compile({
  ...NodeHost,
  mkdirp: async () => {},
  writeFile: async (path, content) => {
    if (dirname(path) !== normalizePath(outputDirectory)) throw new Error(`Unexpected output: ${path}`);
    output.set(path, content);
  },
}, join(directory, "schema-emitter.tsp"), {
  additionalImports: [join(directory, "../draft/schema/src/main.tsp")],
  emit: [emitter],
  options: { [emitter]: { "emitter-output-dir": outputDirectory } },
});
if (program.diagnostics.length > 0) {
  throw new Error(program.diagnostics.map(formatDiagnostic).join("\n"));
}
if (output.size === 0) throw new Error("The C# emitter produced no contracts.");
if (check) {
  const actual = await readdir(outputDirectory);
  if (actual.length !== output.size) throw new Error("Unexpected or missing generated C# files.");
  for (const [path, content] of output) {
    if (await readFile(path, "utf8") !== content) throw new Error(`Generated C# drift: ${path}`);
  }
  console.log("Generated C# contracts are up to date.");
} else {
  await mkdir(outputDirectory, { recursive: true });
  for (const [path, content] of output) await writeFile(path, content);
  console.log(`Generated ${output.size} C# contract file(s).`);
}
