// Copyright (c) Microsoft. All rights reserved.

import { render, traverseOutput } from "@alloy-js/core";
import {
  createTypeSpecLibrary,
  emitFile,
  getLocationContext,
  getTypeName,
  isTemplateInstance,
  isType,
  navigateProgram,
  paramMessage,
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
    "missing-category": {
      severity: "error",
      messages: {
        default: paramMessage`Declaration '${"name"}' needs a reference category. Add @@category(${"name"}, Categories.<member>) to the docs entrypoint.`,
      },
    },
    "no-categories": {
      severity: "error",
      messages: {
        default:
          "No schema declarations found in the reference project.",
      },
    },
  },
});

function getCategory(type: Declaration): EnumMember | undefined {
  const application = type.decorators.findLast(isCategoryDecorator);
  const argument = application?.args[0]?.value;
  return argument && isType(argument) && argument.kind === "EnumMember"
    ? argument
    : undefined;
}

function schemaDeclarations(program: Program): Declaration[] {
  const declarations = new Set<Declaration>();
  function collect(type: Declaration): void {
    if (
      type.name &&
      !isTemplateInstance(type) &&
      getLocationContext(program, type).type === "project"
    ) {
      declarations.add(type);
    }
  }
  navigateProgram(
    program,
    { model: collect, enum: collect, union: collect, scalar: collect },
    { includeTemplateDeclaration: true },
  );
  return [...declarations];
}

export function $onValidate(program: Program): void {
  for (const type of schemaDeclarations(program)) {
    if (!getCategory(type)) {
      $lib.reportDiagnostic(program, {
        code: "missing-category",
        target: type,
        format: { name: getTypeName(type) },
      });
    }
  }
}

export async function $onEmit(context: EmitContext): Promise<void> {
  const { program } = context;
  if (program.hasError()) return;
  const declarations = new Map<Declaration, EnumMember>();
  for (const type of schemaDeclarations(program)) {
    const category = getCategory(type);
    if (category) declarations.set(type, category);
  }
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
