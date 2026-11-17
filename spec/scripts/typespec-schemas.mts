// Copyright (c) Microsoft. All rights reserved.

import { compile, formatDiagnostic, NodeHost } from "@typespec/compiler";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: Json };

/**
 * Compile a bundle's main.tsp once with @typespec/json-schema and return each
 * emitted schema keyed by its $id below idBase, which is its published path.
 */
export async function typespecSchemas(main: string, idBase: string): Promise<Map<string, Schema>> {
  const directory = dirname(fileURLToPath(import.meta.url));
  const outputs: string[] = [];
  const program = await compile(
    {
      ...NodeHost,
      mkdirp: async () => {},
      writeFile: async (_path, content) => {
        outputs.push(content);
      },
    },
    // Loads the emitter installed under spec/scripts, then the bundle.
    join(directory, "schema-emitter.tsp"),
    {
      additionalImports: [main],
      emit: ["@typespec/json-schema"],
      outputDir: join(directory, "tsp-output"),
      options: { "@typespec/json-schema": { "file-type": "json" } },
    },
  );
  if (program.diagnostics.length > 0) {
    throw new Error(program.diagnostics.map((diagnostic) => formatDiagnostic(diagnostic)).join("\n"));
  }
  const schemas = new Map<string, Schema>();
  for (const content of outputs) {
    const schema = JSON.parse(content) as Schema;
    const id = schema.$id;
    if (typeof id !== "string" || !id.startsWith(idBase)) {
      throw new Error(`${main}: schema ${JSON.stringify(id)} is not under ${idBase}; check @@baseUri`);
    }
    schemas.set(id.slice(idBase.length), schema);
  }
  return schemas;
}
