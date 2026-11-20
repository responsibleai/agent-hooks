// Copyright (c) Microsoft. All rights reserved.

import { For } from "@alloy-js/core";
import * as ts from "@alloy-js/typescript";
import {
  compile,
  formatDiagnostic,
  getDoc,
  isTemplateDeclaration,
  isTemplateInstance,
  NodeHost,
  type Model,
  type Program,
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

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(sdkRoot, "src/generated/types.ts");
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((arg) => arg !== "--check")) {
  throw new Error("Usage: generate-types.tsx [--check]");
}

const program = await compile(NodeHost, resolve(sdkRoot, "scripts/contract.tsp"), {
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
    reference: ({ type }) => <ts.ValueExpression jsValue={type.value ?? type.name} />,
  })
  .forTypeKind("Model", {
    reference: ({ type, default: fallback }) => {
      if (type.name === "JsonObject") return "Record<string, JsonValue>";
      if (isClosedEmptyModel(type)) return "Record<string, never>";
      if (type.indexer?.key.name === "string") {
        return <RecordType type={type} />;
      }
      if (isTemplateInstance(type) && type.indexer?.key.name !== "integer") {
        return <InterfaceExpression type={type} />;
      }
      return fallback;
    },
  });

function RecordType({ type }: { type: Model }) {
  if (!type.indexer) throw new Error(`Missing indexer on ${type.name}`);
  return [
    "Record<string, ", <TypeExpression type={type.indexer.value} />, ">",
    type.properties.size > 0 ? [
      " & ",
      <ts.InterfaceExpression>
        <For each={[...type.properties.values()]} semicolon line ender=";">
          {(property) => <InterfaceMember type={property} />}
        </For>
      </ts.InterfaceExpression>,
    ] : "",
  ];
}

const declarationNames = new Map([
  ["request", "ApprovalRequest"],
  ["resolution", "ApprovalResolution"],
]);
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
  <Output program={program}>
    <ts.SourceFile path="types.ts">
      {"// Copyright (c) Microsoft. All rights reserved.\n\n"}
      {"// Generated from spec/draft/schema/src/main.tsp. Do not edit.\n"}
      {"// Regenerate with pnpm run generate:types in sdk/typescript.\n\n"}
      <ts.TypeDeclaration name="JsonValue" export>
        {"null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }"}
      </ts.TypeDeclaration>
      {"\n\n"}
      <Experimental_ComponentOverrides overrides={overrides}>
        <For each={declarations} doubleHardline>
          {(type) => {
            if (type.kind === "Enum") return <UnionDeclaration type={type} export />;
            if (type.kind === "Model" && (type.name === "JsonObject" || type.indexer || isClosedEmptyModel(type))) {
              return (
                <ts.TypeDeclaration name={type.name} export doc={getDoc(program, type)}>
                  <TypeExpression type={type} noReference />
                </ts.TypeDeclaration>
              );
            }
            return (
              <TypeDeclaration
                type={type}
                name={type.name ? declarationNames.get(type.name) : undefined}
                export
              />
            );
          }}
        </For>
      </Experimental_ComponentOverrides>
      {"\n"}
    </ts.SourceFile>
  </Output>,
  dirname(outputPath),
);
assertDiagnostics(program);
if (output.size !== 1) throw new Error(`Expected one generated TypeScript file, got ${output.size}`);
for (const [path, text] of output) {
  if (check) {
    let actual: string | undefined;
    try {
      actual = await readFile(path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (actual !== text) throw new Error(`Generated TypeScript artifact ${path} is stale. Run pnpm run generate:types in sdk/typescript.`);
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
