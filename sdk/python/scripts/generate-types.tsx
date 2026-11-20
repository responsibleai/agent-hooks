// Copyright (c) Microsoft. All rights reserved.

import { For, namekey, type Children } from "@alloy-js/core";
import * as py from "@alloy-js/python";
import {
  compile,
  formatDiagnostic,
  getDoc,
  isArrayModelType,
  isTemplateDeclaration,
  NodeHost,
  walkPropertiesInherited,
  type Model,
  type Type,
} from "@typespec/compiler";
import { Output, writeOutput } from "@typespec/emitter-framework";
import { efRefkey, TypeExpression, typingModule } from "@typespec/emitter-framework/python";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(sdkRoot, "python/agent_hooks_contract");
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((arg) => arg !== "--check")) {
  throw new Error("Usage: generate-types.tsx [--check]");
}

const program = await compile(NodeHost, resolve(sdkRoot, "scripts/contract.tsp"), { noEmit: true });
assertDiagnostics();
const namespace = program.getGlobalNamespaceType().namespaces.get("AgentHooks");
if (!namespace) throw new Error("Missing AgentHooks namespace");

const declarations = new Map<Type, string>();
for (const type of [
  ...namespace.enums.values(),
  ...namespace.scalars.values(),
  ...namespace.models.values(),
  ...namespace.unions.values(),
]) {
  if (!isTemplateDeclaration(type)) {
    if (!type.name) throw new Error("Missing contract declaration name");
    declarations.set(type, type.name === "request" ? "ApprovalRequest" :
      type.name === "resolution" ? "ApprovalResolution" : type.name);
  }
}

// TypeSpec templates and anonymous objects need concrete, reusable TypedDict names.
function collect(type: Type, suggestedName: string): void {
  if (type.kind === "ModelProperty" || type.kind === "UnionVariant") {
    collect(type.type, suggestedName);
  } else if (type.kind === "Union") {
    for (const variant of type.variants.values()) {
      collect(variant.type, `${suggestedName}${variant.type.kind === "Model" ? variant.type.name : ""}`);
    }
  } else if (type.kind === "Model") {
    if (type.indexer && type.properties.size === 0) {
      collect(type.indexer.value, `${suggestedName}Item`);
    } else {
      if (!declarations.has(type)) {
        declarations.set(type, suggestedName);
      }
      if (visited.has(type)) return;
      visited.add(type);
      for (const property of walkPropertiesInherited(type)) {
        collect(property.type, `${declarations.get(type)}${pascalCase(property.name)}`);
      }
    }
  }
}
const visited = new Set<Model>();
for (const [type, name] of declarations) collect(type, name);

const typingExtensions = py.createModule({
  name: "typing_extensions",
  descriptor: { ".": ["NotRequired", "TypedDict"] },
});
const typing = typingModule["."];
const dictionary = typingExtensions["."];
const exactName = (name: string) => namekey(name, { ignoreNamePolicy: true });

function ContractType({ type, inline = false }: { type: Type; inline?: boolean }): Children {
  if (type.kind === "ModelProperty" || type.kind === "UnionVariant") {
    return <ContractType type={type.type} />;
  }
  if (!inline && declarations.has(type)) {
    // Quoted references also work in runtime-evaluated aliases on Python 3.10.
    return ['"', <py.Reference refkey={efRefkey(type)} />, '"'];
  }
  switch (type.kind) {
    case "Enum":
      return [
        typing.Literal, "[",
        <For each={[...type.members.values()]} comma space>
          {(member) => <py.Atom jsValue={member.value ?? member.name} />}
        </For>,
        "]",
      ];
    case "EnumMember":
      return [typing.Literal, "[", <py.Atom jsValue={type.value ?? type.name} />, "]"];
    case "Union":
      return [
        typing.Union, "[",
        <For each={[...type.variants.values()]} comma space>
          {(variant) => <ContractType type={variant.type} />}
        </For>,
        "]",
      ];
    case "Model":
      if (type.name === "JsonObject") return 'dict[str, JsonValue]';
      if (type.indexer && type.properties.size === 0) {
        return [
          isArrayModelType(type) ? "list[" : "dict[str, ",
          <ContractType type={type.indexer.value} />,
          "]",
        ];
      }
      throw new Error(`Missing TypedDict declaration for ${type.name}`);
    case "Intrinsic":
      if (type.name === "unknown") return "JsonValue";
  }
  return <TypeExpression type={type} />;
}

function ContractDeclaration({ type, name }: { type: Type; name: string }): Children {
  const doc = getDoc(program, type);
  if (type.kind === "Model" && type.name !== "JsonObject" &&
      !(type.indexer && type.properties.size === 0)) {
    const properties = [...walkPropertiesInherited(type)];
    const members = (
      <For each={properties} hardline>
        {(property) => [
          getDoc(program, property)
            ? <py.SimpleCommentBlock>{getDoc(program, property)}</py.SimpleCommentBlock> : "",
          getDoc(program, property) ? "\n" : "",
          `${property.name}: `,
          property.optional ? [dictionary.NotRequired, "["] : "",
          <ContractType type={property.type} />,
          property.optional ? "]" : "",
        ]}
      </For>
    );
    if (properties.some((property) => !/^[a-zA-Z_]\w*$/.test(property.name))) {
      return (
        <py.VariableDeclaration name={exactName(name)} refkey={efRefkey(type)}
          doc={doc} initializer={[
            dictionary.TypedDict, `("${name}", {`,
            <For each={properties} comma space>
              {(property) => [
                <py.Atom jsValue={property.name} />, ": ",
                property.optional ? [dictionary.NotRequired, "["] : "",
                <ContractType type={property.type} />,
                property.optional ? "]" : "",
              ]}
            </For>,
            "})",
          ]} />
      );
    }
    return (
      <py.ClassDeclaration name={exactName(name)} refkey={efRefkey(type)}
        bases={[dictionary.TypedDict]}
        doc={doc ? <py.ClassDoc description={[doc]} /> : undefined}>
        {members}
      </py.ClassDeclaration>
    );
  }
  return (
    <py.VariableDeclaration name={exactName(name)} refkey={efRefkey(type)}
      doc={doc} initializer={<ContractType type={type} inline />} />
  );
}

const output = new Map<string, string>();
await writeOutput(
  { ...program, host: { ...program.host, mkdirp: async () => {},
    writeFile: async (path, text) => { output.set(path, text); } } },
  <Output program={program} externals={[typingModule, typingExtensions]}>
    <py.SourceFile path="__init__.py"
      header={"# Copyright (c) Microsoft. All rights reserved.\n\n# ruff: noqa: UP007\n"}
      doc={<py.ModuleDoc description={["Generated draft wire contracts. Do not edit.",
        "Regenerate with pnpm run generate:types in sdk/python."]} />}>
      <py.VariableDeclaration name={exactName("JsonValue")}
        initializer={[
          typing.Union,
          '[None, bool, int, float, str, list["JsonValue"], dict[str, "JsonValue"]]',
        ]} />
      {"\n\n"}
      <For each={[...declarations]} doubleHardline>
        {([type, name]) => <ContractDeclaration type={type} name={name} />}
      </For>
      {"\n"}
    </py.SourceFile>
  </Output>,
  outputDirectory,
);
assertDiagnostics();
if (output.size !== 1) throw new Error(`Expected one generated Python file, got ${output.size}`);
for (const [path, text] of output) {
  // Union[...] supports quoted recursive aliases on Python 3.10; X | "Y" does not.
  const sorted = execFileSync("ruff", ["check", "--select", "I", "--fix-only", "--stdin-filename", path, "-"], {
    input: text, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"],
  });
  const formatted = execFileSync("ruff", ["format", "--stdin-filename", path, "-"], {
    input: sorted, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"],
  });
  if (check) {
    let actual: string | undefined;
    try {
      actual = await readFile(path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (actual !== formatted) {
      throw new Error(`Generated Python artifact ${path} is stale. Run pnpm run generate:types in sdk/python.`);
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, formatted);
  }
}

function pascalCase(name: string): string {
  return name.replace(/(^|[^a-zA-Z0-9])([a-zA-Z0-9])/g, (_, _separator, letter: string) => letter.toUpperCase());
}

function assertDiagnostics(): void {
  if (program.diagnostics.length > 0) {
    throw new Error(program.diagnostics.map((diagnostic) => formatDiagnostic(diagnostic)).join("\n"));
  }
}
