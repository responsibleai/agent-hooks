// Copyright (c) Microsoft. All rights reserved.

import { For, type Children } from "@alloy-js/core";
import { createComponent as c } from "@alloy-js/core/jsx-runtime";
import * as ts from "@alloy-js/typescript";
import {
  compile,
  formatDiagnostic,
  getDoc,
  isTemplateDeclaration,
  isTemplateInstance,
  NodeHost,
  type Enum,
  type EnumMember,
  type Model,
  type ModelProperty,
  type Program,
  type Scalar,
  type Union,
} from "@typespec/compiler";
import {
  Experimental_ComponentOverrides,
  Experimental_ComponentOverridesConfig,
  Output,
  writeOutput,
} from "@typespec/emitter-framework";
import {
  InterfaceExpression,
  InterfaceMember,
  TypeDeclaration,
  TypeExpression,
  UnionDeclaration,
} from "@typespec/emitter-framework/typescript";
import { getExtensions } from "@typespec/json-schema";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outputPath = resolve(root, "sdk/typescript/src/generated/types.ts");
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((arg) => arg !== "--check")) {
  throw new Error("Usage: generate-typescript.mts [--check]");
}

const program = await compile(NodeHost, resolve(root, "spec/scripts/schema-emitter.tsp"), {
  additionalImports: [resolve(root, "spec/draft/schema/src/main.tsp")],
  noEmit: true,
});
assertDiagnostics(program);
const namespace = program.getGlobalNamespaceType().namespaces.get("AgentHooks");
if (!namespace) throw new Error("Missing AgentHooks namespace");

function isClosedEmptyModel(type: Model): boolean {
  return type.properties.size === 0 && !type.indexer && !type.baseModel &&
    getExtensions(program, type).some(({ key, value }) => key === "additionalProperties" && value === false);
}

const overrides = new Experimental_ComponentOverridesConfig()
  .forTypeKind("Intrinsic", {
    reference: ({ type, default: fallback }) => type.name === "unknown" ? "JsonValue" : fallback,
  })
  .forTypeKind("EnumMember", {
    reference: ({ type }) => c(ts.ValueExpression, { jsValue: type.value ?? type.name }),
  })
  .forTypeKind("Model", {
    reference: ({ type, default: fallback }) => {
      if (type.name === "JsonObject") return "Record<string, JsonValue>";
      if (isClosedEmptyModel(type)) return "Record<string, never>";
      if (type.indexer?.key.name === "string") {
        return c(RecordType, { type });
      }
      if (isTemplateInstance(type) && type.indexer?.key.name !== "integer") {
        return c(InterfaceExpression, { type });
      }
      return fallback;
    },
  });

function RecordType({ type }: { type: Model }) {
  if (!type.indexer) throw new Error(`Missing indexer on ${type.name}`);
  return [
    "Record<string, ", c(TypeExpression, { type: type.indexer.value }), ">",
    type.properties.size > 0 ? [" & ", c(ts.InterfaceExpression, {
      children: c(For<ModelProperty[], Children>, {
        each: [...type.properties.values()],
        semicolon: true,
        line: true,
        ender: ";",
        children: (property) => c(InterfaceMember, { type: property }),
      }),
    })] : "",
  ];
}

function EnumDeclaration({ type }: { type: Enum }) {
  return [
    c(ts.VarDeclaration, {
      name: type.name,
      export: true,
      const: true,
      doc: getDoc(program, type),
      children: [
        "Object.freeze(",
        c(ts.ObjectExpression, {
          children: c(For<EnumMember[], Children>, {
            each: [...type.members.values()],
            comma: true,
            line: true,
            children: (member) => c(ts.ObjectProperty, {
              name: member.name,
              jsValue: member.value ?? member.name,
            }),
          }),
        }),
        " as const)",
      ],
    }),
    ";\n\n",
    c(UnionDeclaration, { type, export: true }),
  ];
}

const declarations = [
  ...namespace.enums.values(),
  ...namespace.scalars.values(),
  ...namespace.models.values(),
  ...namespace.unions.values(),
].filter((type) => !isTemplateDeclaration(type));
const output = new Map<string, string>();
await writeOutput(
  { ...program, host: { ...program.host, mkdirp: async () => {}, writeFile: async (path, text) => {
    output.set(path, text);
  } } },
  c(Output, {
    program,
    children: c(ts.SourceFile, {
      path: "types.ts",
      children: [
        "// Copyright (c) Microsoft. All rights reserved.\n\n",
        "// Generated from spec/draft/schema/src/main.tsp. Do not edit.\n",
        "// Regenerate with pnpm run generate:typescript.\n\n",
        c(ts.TypeDeclaration, {
          name: "JsonValue",
          export: true,
          children: "null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }",
        }),
        "\n\n",
        c(Experimental_ComponentOverrides, {
          overrides,
          children: c(For<(Enum | Scalar | Model | Union)[], Children>, {
            each: declarations,
            doubleHardline: true,
            children: (type) => {
              if (type.kind === "Enum") return c(EnumDeclaration, { type });
              if (type.kind === "Model" && (type.name === "JsonObject" || type.indexer || isClosedEmptyModel(type))) {
                return c(ts.TypeDeclaration, {
                  name: type.name,
                  export: true,
                  doc: getDoc(program, type),
                  children: c(TypeExpression, { type, noReference: true }),
                });
              }
              return c(TypeDeclaration, { type, export: true });
            },
          }),
        }),
        "\n",
      ],
    }),
  }),
  dirname(outputPath),
);
assertDiagnostics(program);
if (output.size !== 1) throw new Error(`Expected one generated TypeScript file, got ${output.size}`);
for (const name of [
  "agent-context", "agent-startup-hook-response", "input-hook-response",
  "pre-model-hook-response", "post-model-hook-response", "pre-tool-hook-response",
  "post-tool-hook-response", "output-hook-response", "agent-shutdown-hook-response", "approval",
]) {
  output.set(
    resolve(dirname(outputPath), "schemas", `${name}.schema.json`),
    await readFile(resolve(root, "spec/draft/schema/generated", `${name}.schema.json`), "utf8"),
  );
}
for (const [path, text] of output) {
  if (check) {
    let actual: string | undefined;
    try {
      actual = await readFile(path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (actual !== text) throw new Error(`Generated TypeScript artifact ${path} is stale. Run pnpm run generate:typescript.`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
}

function assertDiagnostics(program: Program): void {
  if (program.diagnostics.length > 0) {
    throw new Error(program.diagnostics.map((diagnostic) => formatDiagnostic(diagnostic)).join("\n"));
  }
}
