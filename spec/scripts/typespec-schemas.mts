// Copyright (c) Microsoft. All rights reserved.

import { compile, createSourceFile, formatDiagnostic, NodeHost, normalizePath } from "@typespec/compiler";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: Json };

/**
 * Select one public root at a time so the native emitter embeds all referenced
 * types in $defs instead of linking to other public schema files.
 */
export async function typespecSchema(source: string, roots: string[], id: string): Promise<Schema> {
  const directory = dirname(fileURLToPath(import.meta.url));
  const entrypoint = normalizePath(join(directory, "schema-emitter.tsp"));
  // Approval publishes definitions, not an instance shape. A temporary model
  // makes the native emitter collect those definitions and their dependencies.
  const definitionsOnly = roots.length > 1;
  const selection = definitionsOnly
    ? `model SchemaDefinitions { ${roots.map((name) => `${name}: AgentHooks.${name};`).join(" ")} }`
    : "";
  const target = definitionsOnly ? "SchemaDefinitions" : `AgentHooks.${roots[0]}`;
  const output = new Map<string, string>();
  const program = await compile(
    {
      ...NodeHost,
      readFile: async (path) => {
        const file = await NodeHost.readFile(path);
        return path === entrypoint
          ? createSourceFile(
              `${file.text}\n${selection}\n@@TypeSpec.JsonSchema.jsonSchema(${target}, ${JSON.stringify(id)});`,
              path,
            )
          : file;
      },
      mkdirp: async () => {},
      writeFile: async (path, content) => {
        output.set(path, content);
      },
    },
    entrypoint,
    {
      additionalImports: [source],
      emit: ["@typespec/json-schema"],
      outputDir: join(directory, "tsp-output"),
      options: {
        "@typespec/json-schema": {
          "file-type": "json",
        },
      },
    },
  );
  if (program.diagnostics.length > 0) {
    throw new Error(program.diagnostics.map((diagnostic) => formatDiagnostic(diagnostic)).join("\n"));
  }
  if (output.size !== 1) throw new Error(`expected one TypeSpec schema for ${id}, got ${output.size}`);
  const schema = JSON.parse([...output.values()][0]) as Schema;
  return definitionsOnly
    ? { $id: schema.$id, $schema: schema.$schema, $defs: schema.$defs }
    : schema;
}
