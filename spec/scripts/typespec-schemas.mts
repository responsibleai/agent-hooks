// Copyright (c) Microsoft. All rights reserved.

import { compile, formatDiagnostic, NodeHost } from "@typespec/compiler";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: Json };

/**
 * Emit Draft 2020-12 schemas in memory. Publication keeps the existing
 * self-contained documents and fragment names instead of emitter filenames.
 */
export async function typespecSchemas(source: string): Promise<Map<string, Schema>> {
  const directory = dirname(fileURLToPath(import.meta.url));
  const output = new Map<string, string>();
  const program = await compile(
    {
      ...NodeHost,
      mkdirp: async () => {},
      writeFile: async (path, content) => {
        output.set(path, content);
      },
    },
    join(directory, "schema-emitter.tsp"),
    {
      additionalImports: [source],
      emit: ["@typespec/json-schema"],
      outputDir: join(directory, "tsp-output"),
      options: {
        "@typespec/json-schema": {
          "file-type": "json",
          bundleId: "bundle.json",
        },
      },
    },
  );
  if (program.diagnostics.length > 0) {
    throw new Error(program.diagnostics.map((diagnostic) => formatDiagnostic(diagnostic)).join("\n"));
  }
  if (output.size !== 1) throw new Error(`expected one TypeSpec bundle, got ${output.size}`);
  const bundle = JSON.parse([...output.values()][0]) as Schema;
  const all = new Map<string, Schema>();
  const namesById = new Map<string, string>();
  function collect(definitions: Record<string, Schema>): void {
    for (const [name, schema] of Object.entries(definitions)) {
      if (typeof schema.$id === "string") namesById.set(schema.$id, name);
      if (schema.$defs) collect(schema.$defs as Record<string, Schema>);
      delete schema.$defs;
      const previous = all.get(name);
      if (previous && JSON.stringify(previous) !== JSON.stringify(schema)) {
        throw new Error(`conflicting TypeSpec definitions for ${name}`);
      }
      all.set(name, schema);
    }
  }
  collect(bundle.$defs as Record<string, Schema>);

  function localize(node: Json): void {
    if (Array.isArray(node)) {
      for (const item of node) localize(item);
    } else if (node !== null && typeof node === "object") {
      if (typeof node.$ref === "string" && !node.$ref.startsWith("#/$defs/")) {
        const name = namesById.get(node.$ref);
        if (!name) throw new Error(`unresolved TypeSpec reference ${node.$ref}`);
        node.$ref = `#/$defs/${name}`;
      }
      for (const value of Object.values(node)) localize(value);
    }
  }

  for (const schema of all.values()) {
    delete schema.$id;
    delete schema.$schema;
    localize(schema);
  }
  return all;
}

/** Package a root, or approval's public definitions, with its reachable types. */
export function bundleSchema(all: Map<string, Schema>, roots: string[], definitionsOnly = false): Schema {
  const definitions: Record<string, Schema> = {};
  function include(name: string): void {
    if (Object.hasOwn(definitions, name)) return;
    const schema = all.get(name);
    if (!schema) throw new Error(`TypeSpec did not emit ${name}`);
    definitions[name] = schema;
    visit(schema);
  }
  function visit(node: Json): void {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
    } else if (node !== null && typeof node === "object") {
      if (typeof node.$ref === "string") include(node.$ref.slice("#/$defs/".length));
      for (const value of Object.values(node)) visit(value);
    }
  }
  let schema: Schema = {};
  if (definitionsOnly) {
    for (const name of roots) include(name);
  } else {
    const root = all.get(roots[0]);
    if (!root) throw new Error(`TypeSpec did not emit ${roots[0]}`);
    schema = structuredClone(root);
    visit(schema);
  }
  return { ...schema, $defs: definitions };
}
