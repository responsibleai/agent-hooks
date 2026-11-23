// Copyright (c) Microsoft. All rights reserved.

import { For } from "@alloy-js/core";
import * as ts from "@alloy-js/typescript";
import {
  createTypeSpecLibrary,
  getDoc,
  isTemplateDeclaration,
  isTemplateInstance,
  type EmitContext,
  type Model,
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

export const $lib = createTypeSpecLibrary({
  name: "@agent-hooks/typescript-emitter",
  diagnostics: {
    "missing-namespace": {
      severity: "error",
      messages: { default: "The TypeScript emitter requires the AgentHooks namespace." },
    },
  },
});

export async function $onEmit({ program, emitterOutputDir }: EmitContext): Promise<void> {
  const namespace = program.getGlobalNamespaceType().namespaces.get("AgentHooks");
  if (!namespace) {
    $lib.reportDiagnostic(program, { code: "missing-namespace", target: program.getGlobalNamespaceType() });
    return;
  }

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
  await writeOutput(
    program,
    <Output program={program}>
      <ts.SourceFile path="index.ts">
        {"// Copyright (c) Microsoft. All rights reserved.\n\n"}
        {"// Generated from the AgentHooks TypeSpec specification. Do not edit.\n"}
        {"// Regenerate with pnpm generate from the repository root.\n\n"}
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
    emitterOutputDir,
  );
}
