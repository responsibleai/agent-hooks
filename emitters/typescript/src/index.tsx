// Copyright (c) Microsoft. All rights reserved.

import { For, refkey } from "@alloy-js/core";
import * as ts from "@alloy-js/typescript";
import {
  createTypeSpecLibrary,
  getDoc,
  isTemplateDeclaration,
  isTemplateInstance,
  type EmitContext,
  type Model,
  type ModelIndexer,
} from "@typespec/compiler";
import { SyntaxKind } from "@typespec/compiler/ast";
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

  const declarations = [
    ...namespace.enums.values(),
    ...namespace.scalars.values(),
    ...namespace.models.values(),
    ...namespace.unions.values(),
  ].filter((type) => !isTemplateDeclaration(type) || type.name === "TransformVerdict");
  const declaredTypes = new Set(declarations);
  const transformVerdict = namespace.models.get("TransformVerdict");
  const denyVerdict = namespace.models.get("DenyVerdict");

  const overrides = new Experimental_ComponentOverridesConfig()
    .forTypeKind("Intrinsic", {
      reference: ({ type, default: fallback }) => type.name === "unknown" ? "JsonValue" : fallback,
    })
    .forTypeKind("EnumMember", {
      reference: ({ type }) => <ts.ValueExpression jsValue={type.value ?? type.name} />,
    })
    .forTypeKind("TemplateParameter", {
      reference: ({ type }) => <ts.Reference refkey={refkey(type)} />,
    })
    .forTypeKind("Model", {
      reference: ({ type, default: fallback }) => {
        if (declaredTypes.has(type)) return <ts.Reference refkey={refkey(type)} />;
        if (isTemplateInstance(type) && type.name === transformVerdict?.name) {
          return [
            <ts.Reference refkey={refkey(transformVerdict)} />, "<",
            <For each={type.templateMapper.args} comma space>
              {(argument) => {
                if (argument.entityKind !== "Type") {
                  throw new Error("TransformVerdict requires a type argument");
                }
                return <TypeExpression type={argument} />;
              }}
            </For>, ">",
          ];
        }
        if (type.name) {
          if (isTemplateInstance(type) && type.indexer?.key.name !== "integer") {
            return <InterfaceExpression type={type} />;
          }
          return fallback;
        }
        if (isClosedEmptyModel(type)) return "Record<string, never>";
        if (type.indexer?.key.name === "string") {
          return <RecordType type={type} indexer={type.indexer} />;
        }
        return fallback;
      },
    });

  function RecordType({ type, indexer }: { type: Model; indexer: ModelIndexer }) {
    return [
      "Record<string, ", <TypeExpression type={indexer.value} />, ">",
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
              if (type.kind === "Model" && isTemplateDeclaration(type) && type.node?.kind === SyntaxKind.ModelStatement) {
                return (
                  <ts.InterfaceDeclaration
                    name={type.name}
                    refkey={refkey(type)}
                    typeParameters={type.node.templateParameters.map((parameter) => ({
                      name: parameter.id.sv,
                      refkey: refkey(program.checker.getTypeForNode(parameter)),
                    }))}
                    export
                    doc={getDoc(program, type)}
                  >
                    <For each={[...type.properties.values()]} semicolon line ender=";">
                      {(property) => <InterfaceMember type={property} />}
                    </For>
                  </ts.InterfaceDeclaration>
                );
              }
              if (type.kind === "Model" && (type.name === "JsonObject" || type.indexer || isClosedEmptyModel(type))) {
                // Open records alone reject interface values without an index signature.
                const includeDenyVerdict = type.name === "LiftableDeny" && denyVerdict;
                return (
                  <ts.TypeDeclaration name={type.name} refkey={refkey(type)} export doc={getDoc(program, type)}>
                    {includeDenyVerdict
                      ? [<TypeExpression type={includeDenyVerdict} />, " | "]
                      : ""}
                    {isClosedEmptyModel(type) ? "Record<string, never>" : type.indexer?.key.name === "integer"
                      ? ["Array<", <TypeExpression type={type.indexer.value} />, ">"]
                      : type.indexer
                      ? <RecordType type={type} indexer={type.indexer} />
                      : "Record<string, JsonValue>"}
                  </ts.TypeDeclaration>
                );
              }
              return (
                <TypeDeclaration
                  type={type}
                  refkey={refkey(type)}
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
