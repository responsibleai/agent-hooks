// Copyright (c) Microsoft. All rights reserved.

import { For, namekey, type Children } from "@alloy-js/core";
import {
  group as Group,
  indent as Indent,
  ifBreak as IfBreak,
  hbr as Hardline,
  sbr as Softline,
  br as Line,
} from "@alloy-js/core/stc";
import * as py from "@alloy-js/python";
import {
  createTypeSpecLibrary,
  getDoc,
  isArrayModelType,
  isNeverType,
  isTemplateDeclaration,
  isTemplateInstance,
  walkPropertiesInherited,
  type EmitContext,
  type Model,
  type Type,
} from "@typespec/compiler";
import { $ } from "@typespec/compiler/typekit";
import { Output, writeOutput } from "@typespec/emitter-framework";
import { efRefkey, TypeExpression } from "@typespec/emitter-framework/python";

export const $lib = createTypeSpecLibrary({
  name: "@agent-hooks/python-emitter",
  diagnostics: {},
});

const keywords = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);
const isIdentifier = (name: string) =>
  /^[a-zA-Z_]\w*$/.test(name) && !keywords.has(name);
const isCollection = (type: Model) =>
  type.indexer !== undefined &&
  !isNeverType(type.indexer.value) &&
  type.properties.size === 0;
const isObject = (type: Type): type is Model =>
  type.kind === "Model" && type.name !== "JsonObject" && !isCollection(type);
const isClass = (type: Type) =>
  isObject(type) &&
  [...walkPropertiesInherited(type)].every((property) =>
    isIdentifier(property.name),
  );
const exactName = (name: string) => namekey(name, { ignoreNamePolicy: true });

export async function $onEmit({
  program,
  emitterOutputDir,
}: EmitContext): Promise<void> {
  if (program.compilerOptions.noEmit) return;
  const namespace = program
    .getGlobalNamespaceType()
    .namespaces.get("AgentHooks");
  if (!namespace) throw new Error("Missing AgentHooks namespace");

  const roots = [
    ...namespace.enums,
    ...namespace.scalars,
    ...namespace.models,
    ...namespace.unions,
  ].filter(([, type]) => !isTemplateDeclaration(type));
  const declarations = new Map<Type, string>();
  const nameOwners = new Map<string, Type>();
  const imports = new Set(["Union"]);
  const dictionaryImports = new Set<string>();
  const ordered: Type[] = [];
  const visited = new Set<Type>();
  const visiting = new Set<Type>();

  function declare(type: Type, name: string): void {
    if (
      name === "JsonValue" ||
      (nameOwners.has(name) && nameOwners.get(name) !== type)
    ) {
      throw new Error(`Duplicate Python declaration name: ${name}`);
    }
    declarations.set(type, name);
    nameOwners.set(name, type);
  }
  for (const [name, type] of roots) {
    declare(
      type,
      name === "request"
        ? "ApprovalRequest"
        : name === "resolution"
          ? "ApprovalResolution"
          : name,
    );
  }

  // Discover concrete template/anonymous models and order all declarations by dependency.
  function visit(type: Type, suggestedName: string): void {
    if (type.kind === "ModelProperty") {
      visit(type.type, suggestedName);
      return;
    }
    if (visited.has(type)) return;
    if (visiting.has(type))
      throw new Error(`Recursive Python contract type: ${suggestedName}`);
    visiting.add(type);
    if (isObject(type) && !declarations.has(type)) {
      declare(
        type,
        isTemplateInstance(type) ? templateName(type) : suggestedName,
      );
    }
    const name = declarations.get(type) ?? suggestedName;
    switch (type.kind) {
      case "Enum":
      case "EnumMember":
      case "Boolean":
      case "String":
      case "Number":
        imports.add("Literal");
        break;
      case "Union":
        for (const [index, variant] of [...type.variants.values()].entries()) {
          visit(
            variant.type,
            `${name}${typeof variant.name === "string" ? pascalCase(variant.name) : `Variant${index + 1}`}`,
          );
        }
        break;
      case "Model":
        if (type.name === "JsonObject") break;
        if (isCollection(type)) {
          visit(type.indexer!.value, `${name}Item`);
        } else {
          dictionaryImports.add("TypedDict");
          for (const property of walkPropertiesInherited(type)) {
            if (property.optional) dictionaryImports.add("NotRequired");
            visit(property.type, `${name}${pascalCase(property.name)}`);
          }
        }
    }
    visiting.delete(type);
    visited.add(type);
    if (declarations.has(type)) ordered.push(type);
  }
  function templateName(type: Model): string {
    const plausible = $(program).type.getPlausibleName(type);
    const prefix = plausible.slice(0, -type.name.length);
    let overlap = type.name.length;
    while (overlap > 0 && !prefix.endsWith(type.name.slice(0, overlap)))
      overlap--;
    return prefix + type.name.slice(overlap);
  }
  for (const [name, type] of roots) visit(type, name);

  function Literal({ values }: { values: Children[] }): Children {
    return (
      <Group>
        {"Literal["}
        <Indent>
          <Softline />
          <For each={values} comma line ender={<IfBreak>,</IfBreak>}>
            {(value) => value}
          </For>
        </Indent>
        <Softline />
        {"]"}
      </Group>
    );
  }

  function ContractType({
    type,
    inline = false,
  }: {
    type: Type;
    inline?: boolean;
  }): Children {
    if (type.kind === "ModelProperty") return <ContractType type={type.type} />;
    if (!inline && declarations.has(type))
      return <py.Reference refkey={efRefkey(type)} />;
    switch (type.kind) {
      case "Enum":
        return (
          <Literal
            values={[...type.members.values()].map((member) => (
              <py.Atom jsValue={member.value ?? member.name} />
            ))}
          />
        );
      case "EnumMember":
        return (
          <Literal values={[<py.Atom jsValue={type.value ?? type.name} />]} />
        );
      case "Boolean":
      case "String":
      case "Number":
        return <Literal values={[<py.Atom jsValue={type.value} />]} />;
      case "Union":
        return (
          <Group>
            <IfBreak>(</IfBreak>
            <Indent>
              <Softline />
              <For each={[...type.variants.values()]} joiner={[<Line />, "| "]}>
                {(variant) => <ContractType type={variant.type} />}
              </For>
            </Indent>
            <Softline />
            <IfBreak>)</IfBreak>
          </Group>
        );
      case "Model":
        if (type.name === "JsonObject") return "dict[str, JsonValue]";
        if (isCollection(type))
          return [
            isArrayModelType(type) ? "list[" : "dict[str, ",
            <ContractType type={type.indexer!.value} />,
            "]",
          ];
        throw new Error(`Missing TypedDict declaration for ${type.name}`);
      case "Intrinsic":
        if (type.name === "unknown") return "JsonValue";
    }
    return <TypeExpression type={type} />;
  }

  function ContractDeclaration({ type }: { type: Type }): Children {
    const name = declarations.get(type)!;
    const doc = getDoc(program, type);
    if (isObject(type)) {
      const properties = [...walkPropertiesInherited(type)].map((property) => ({
        property,
        doc: getDoc(program, property),
      }));
      function Members({
        functional = false,
      }: {
        functional?: boolean;
      }): Children {
        return (
          <For
            each={properties}
            hardline
            ender={functional ? "," : undefined}
            joiner={functional ? [",", <Hardline />] : <Hardline />}
          >
            {({ property, doc }) => [
              doc
                ? [
                    <py.SimpleCommentBlock>{doc}</py.SimpleCommentBlock>,
                    <Hardline />,
                  ]
                : "",
              functional ? <py.Atom jsValue={property.name} /> : property.name,
              ": ",
              property.optional ? "NotRequired[" : "",
              <ContractType type={property.type} />,
              property.optional ? "]" : "",
            ]}
          </For>
        );
      }
      if (!isClass(type)) {
        return (
          <py.VariableDeclaration
            name={exactName(name)}
            refkey={efRefkey(type)}
            doc={doc}
            initializer={[
              "TypedDict(",
              <Indent>
                <Hardline />
                <py.Atom jsValue={name} />
                {","}
                <Hardline />
                {"{"}
                <Indent>
                  <Hardline />
                  <Members functional />
                </Indent>
                <Hardline />
                {"},"}
              </Indent>,
              <Hardline />,
              ")",
            ]}
          />
        );
      }
      return (
        <py.ClassDeclaration
          name={exactName(name)}
          refkey={efRefkey(type)}
          bases={["TypedDict"]}
          doc={doc ? <py.ClassDoc description={[doc]} /> : undefined}
        >
          <Members />
        </py.ClassDeclaration>
      );
    }
    return (
      <py.VariableDeclaration
        name={exactName(name)}
        refkey={efRefkey(type)}
        doc={doc}
        initializer={<ContractType type={type} inline />}
      />
    );
  }

  await writeOutput(
    program,
    <Output program={program}>
      <py.SourceFile path="__init__.py" printWidth={100}>
        <Group>
          {() => [
            "# Copyright (c) Microsoft. All rights reserved.\n\n",
            <py.ModuleDoc
              description={[
                "Generated wire contracts. Do not edit.",
                "Regenerate with pnpm generate at the repository root.",
              ]}
            />,
            "\n",
            `from typing import ${[...imports].sort().join(", ")}\n`,
            dictionaryImports.size
              ? `\nfrom typing_extensions import ${[...dictionaryImports].sort().join(", ")}\n`
              : "",
            "\n",
            <py.VariableDeclaration
              name={exactName("JsonValue")}
              initializer={[
                "Union[  # noqa: UP007",
                <Indent>
                  <Hardline />
                  {
                    'None,\nbool,\nint,\nfloat,\nstr,\nlist["JsonValue"],\ndict[str, "JsonValue"],'
                  }
                </Indent>,
                <Hardline />,
                "]",
              ]}
            />,
            <For each={ordered} joiner="">
              {(type, index) => [
                "\n\n",
                isClass(type) && !(index > 0 && isClass(ordered[index - 1]))
                  ? "\n"
                  : "",
                <ContractDeclaration type={type} />,
              ]}
            </For>,
            "\n",
          ]}
        </Group>
      </py.SourceFile>
    </Output>,
    emitterOutputDir,
  );
}

function pascalCase(name: string): string {
  return name.replace(
    /(^|[^a-zA-Z0-9])([a-zA-Z0-9])/g,
    (_, _separator, letter: string) => letter.toUpperCase(),
  );
}
