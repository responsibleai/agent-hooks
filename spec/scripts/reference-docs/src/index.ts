// Copyright (c) Microsoft. All rights reserved.

import { render, traverseOutput } from "@alloy-js/core";
import {
  createTypeSpecLibrary,
  emitFile,
  getAutoDecoratorValue,
  getTypeName,
  isTemplateInstance,
  isType,
  navigateProgram,
  resolvePath,
  type EmitContext,
  type Enum,
  type EnumMember,
  type Model,
  type Program,
  type Scalar,
  type Union,
} from "@typespec/compiler";
import { isCategoryDecorator } from "./category.js";
import { Reference } from "./reference.js";

export type Declaration = Model | Enum | Union | Scalar;

export const $lib = createTypeSpecLibrary({
  name: "@agent-hooks/reference-docs",
  diagnostics: {
    "no-categories": {
      severity: "error",
      messages: {
        default:
          "No categorized declarations found. Add @category(Categories.<member>).",
      },
    },
  },
});

function isEnumMember(value: unknown): value is EnumMember {
  return (
    typeof value === "object" &&
    value !== null &&
    "entityKind" in value &&
    value.entityKind === "Type" &&
    "kind" in value &&
    value.kind === "EnumMember"
  );
}

function getCategory(
  program: Program,
  type: Declaration,
): EnumMember | undefined {
  const stored = getAutoDecoratorValue(
    program,
    "AgentHooks.Docs.category",
    type,
  );
  if (stored) {
    if (!isEnumMember(stored.value)) {
      throw new Error("The category decorator did not store an enum member.");
    }
    return stored.value;
  }

  // Template declarations retain their decorators without executing them.
  const application = type.decorators.find(isCategoryDecorator);
  const argument = application?.args[0]?.value;
  return argument && isType(argument) && argument.kind === "EnumMember"
    ? argument
    : undefined;
}

export async function $onEmit(context: EmitContext): Promise<void> {
  const { program } = context;
  const declarations = new Map<Declaration, EnumMember>();
  function collect(type: Declaration): void {
    if (!type.name || isTemplateInstance(type)) return;
    const category = getCategory(program, type);
    if (category) declarations.set(type, category);
  }
  navigateProgram(
    program,
    { model: collect, enum: collect, union: collect, scalar: collect },
    { includeTemplateDeclaration: true },
  );
  const firstCategory = declarations.values().next().value;
  if (!firstCategory) {
    $lib.reportDiagnostic(program, {
      code: "no-categories",
      target: program.getGlobalNamespaceType(),
    });
    return;
  }
  const categories = [...firstCategory.enum.members.values()]
    .map((category) => ({
      title: String(category.value ?? category.name),
      declarations: [...declarations]
        .filter(([, member]) => member === category)
        .map(([type]) => type)
        .sort((a, b) => getTypeName(a).localeCompare(getTypeName(b), "en")),
    }))
    .filter((category) => category.declarations.length > 0);

  const output = render(
    Reference({
      program,
      categories,
      declarations: new Set(declarations.keys()),
    }),
  );
  await traverseOutput(output, {
    visitDirectory: () => {},
    visitFile: async (file) => {
      if (!("contents" in file))
        throw new Error(`Unexpected copied reference file: ${file.path}`);
      await emitFile(program, {
        path: resolvePath(context.emitterOutputDir, file.path),
        content: file.contents,
      });
    },
  });
}
