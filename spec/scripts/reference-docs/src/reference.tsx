// Copyright (c) Microsoft. All rights reserved.

import { For, Output } from "@alloy-js/core";
import * as md from "@alloy-js/markdown";
import {
  getDoc,
  getEntityName,
  getExamples,
  getFormat,
  getMaxItemsAsNumeric,
  getMaxLengthAsNumeric,
  getMaxValueAsNumeric,
  getMinItemsAsNumeric,
  getMinLengthAsNumeric,
  getMinValueAsNumeric,
  getNamespaceFullName,
  getPattern,
  getSourceLocation,
  getSummary,
  getTypeName,
  isArrayModelType,
  isTemplateInstance,
  isTemplateDeclaration,
  isType,
  serializeValueAsJson,
  walkPropertiesInherited,
  type Program,
  type Model,
  type Type,
} from "@typespec/compiler";
import { getExtensions, getUniqueItems, isOneOf } from "@typespec/json-schema";
import { isCategoryDecorator, isSummaryDecorator } from "./category.js";
import type { Declaration } from "./index.js";

interface ReferenceProps {
  program: Program;
  categories: { title: string; declarations: Declaration[] }[];
  declarations: Set<Declaration>;
}

interface PropertyDoc {
  name: string;
  type: string;
  description: string;
  constraints: string;
}

function anchor(type: Declaration): string {
  const namespace = type.namespace && getNamespaceFullName(type.namespace);
  return [namespace, type.name]
    .filter(Boolean)
    .join(".")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .toLowerCase();
}

function inline(value: string): string {
  const fence = "`".repeat(
    Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length)) +
      1,
  );
  const padding = /^[` ]|[` ]$/.test(value) ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

function cell(value: string): string {
  // HTML code preserves pipes inside GFM table cells without ending the cell.
  return value
    .replace(/(`+)([\s\S]*?)\1(?!`)/g, (span, _fence, content: string) => {
      if (!content.includes("|")) return span;
      let text = content.replace(/\r?\n/g, " ");
      if (text.startsWith(" ") && text.endsWith(" ") && text.trim()) {
        text = text.slice(1, -1);
      }
      return `<code>${text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("|", "&#124;")}</code>`;
    })
    .replaceAll("|", "&#124;")
    .replace(/\r?\n/g, "<br>");
}

function isTypeReference(value: unknown): value is Type {
  return (
    typeof value === "object" &&
    value !== null &&
    "entityKind" in value &&
    value.entityKind === "Type"
  );
}

function Table(props: { headings: string[]; rows: string[][] }) {
  return (
    <For
      each={[props.headings, props.headings.map(() => "---"), ...props.rows]}
    >
      {(row) => `| ${row.map(cell).join(" | ")} |`}
    </For>
  );
}

function Code(props: { lang: string; children: string }) {
  if (!props.children.includes("```")) {
    return <md.Code lang={props.lang}>{props.children}</md.Code>;
  }
  // Alloy's Code fixes the fence at three backticks, even if the body contains it.
  const fence = "`".repeat(
    Math.max(...[...props.children.matchAll(/`+/g)].map((match) => match[0].length)) + 1,
  );
  return `${fence}${props.lang}\n${props.children}\n${fence}`;
}

export function Reference(props: ReferenceProps) {
  const { program, declarations } = props;

  function doc(type: Type): string {
    const content = type.node?.docs
      ?.flatMap((doc) => doc.content.map((part) => part.text))
      .join("\n");
    return [getSummary(program, type), getDoc(program, type) ?? content]
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
  }

  function typeExpression(type: Type, active = new Set<Type>()): string {
    const name = getTypeName(type, { namespaceFilter: () => false });
    if (
      type.kind === "Model" ||
      type.kind === "Enum" ||
      type.kind === "Union" ||
      type.kind === "Scalar"
    ) {
      if (declarations.has(type)) return `[${inline(name)}](#${anchor(type)})`;
      if (active.has(type)) return inline(name);
      active = new Set(active).add(type);
    }
    switch (type.kind) {
      case "Model": {
        if (isArrayModelType(type)) {
          const element = type.indexer.value;
          const expression = typeExpression(element, active);
          return element.kind === "Union" && !element.name
            ? `(${expression})[]`
            : `${expression}[]`;
        }
        if (isTemplateInstance(type)) {
          const declaration = [...declarations].find(
            (item) =>
              item.kind === type.kind &&
              item.name === type.name &&
              item.namespace === type.namespace,
          );
          const label = declaration
            ? `[${inline(type.name)}](#${anchor(declaration)})`
            : inline(type.name);
          const args = type.templateMapper.args.map((arg) =>
            isType(arg)
              ? typeExpression(arg, active)
              : inline(getEntityName(arg)),
          );
          return `${label}&lt;${args.join(", ")}&gt;`;
        }
        if (type.name) return inline(name);
        const properties = [...walkPropertiesInherited(type)].map(
          (property) =>
            `${inline(property.name + (property.optional ? "?" : ""))}: ${typeExpression(property.type, active)}`,
        );
        if (type.indexer)
          properties.push(
            `[key: string]: ${typeExpression(type.indexer.value, active)}`,
          );
        return `{ ${properties.join("; ")} }`;
      }
      case "EnumMember":
        return declarations.has(type.enum)
          ? `[${inline(name)}](#${anchor(type.enum)})`
          : inline(name);
      case "Union":
        return [...type.variants.values()]
          .map((variant) => typeExpression(variant.type, active))
          .join(" | ");
      case "Tuple":
        return `[${type.values.map((value) => typeExpression(value, active)).join(", ")}]`;
      default:
        return inline(name);
    }
  }

  function constraints(type: Type): string {
    const values: string[] = [];
    const numeric = [
      ["minimum", getMinValueAsNumeric(program, type)],
      ["maximum", getMaxValueAsNumeric(program, type)],
      ["minLength", getMinLengthAsNumeric(program, type)],
      ["maxLength", getMaxLengthAsNumeric(program, type)],
      ["minItems", getMinItemsAsNumeric(program, type)],
      ["maxItems", getMaxItemsAsNumeric(program, type)],
    ] as const;
    for (const [name, value] of numeric) {
      if (value !== undefined)
        values.push(`${name}: ${inline(value.toString())}`);
    }
    const pattern = getPattern(program, type);
    if (pattern !== undefined) values.push(`pattern: ${inline(pattern)}`);
    const format = getFormat(program, type);
    if (format !== undefined) values.push(`format: ${inline(format)}`);
    if (getUniqueItems(program, type)) values.push("uniqueItems");
    if (type.kind === "Union" && isOneOf(program, type))
      values.push("exactly one variant");
    for (const extension of getExtensions(program, type)) {
      const value = isTypeReference(extension.value)
        ? getTypeName(extension.value)
        : JSON.stringify(extension.value);
      values.push(`${extension.key}: ${inline(value)}`);
    }
    return values.join("; ");
  }

  function sourceSnippet(type: Declaration): string {
    const source = getSourceLocation(type, { locateId: false });
    if (source.isSynthetic) {
      throw new Error(`No TypeSpec source found for ${getTypeName(type)}.`);
    }

    const ranges = new Map<number, number>();
    const visited = new Set<object>();
    function collectComments(value: unknown): void {
      if (typeof value !== "object" || value === null || visited.has(value)) {
        return;
      }
      visited.add(value);
      if (Array.isArray(value)) {
        for (const item of value) collectComments(item);
        return;
      }
      if ("docs" in value && Array.isArray(value.docs)) {
        for (const comment of value.docs) {
          if (
            typeof comment === "object" &&
            comment !== null &&
            "pos" in comment &&
            "end" in comment &&
            typeof comment.pos === "number" &&
            typeof comment.end === "number" &&
            comment.pos >= source.pos &&
            comment.end <= source.end
          ) {
            ranges.set(comment.pos - source.pos, comment.end - source.pos);
          }
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (
          key !== "docs" &&
          key !== "parent" &&
          key !== "symbol" &&
          key !== "locals"
        ) {
          collectComments(child);
        }
      }
    }
    collectComments(type.node);
    for (const application of type.decorators) {
      if (
        (!isCategoryDecorator(application) &&
          !isSummaryDecorator(application)) ||
        !application.node
      ) {
        continue;
      }
      const location = getSourceLocation(application.node);
      if (
        !location.isSynthetic &&
        location.file === source.file &&
        location.pos >= source.pos &&
        location.end <= source.end
      ) {
        ranges.set(location.pos - source.pos, location.end - source.pos);
      }
    }

    let text = source.file.text.slice(source.pos, source.end);
    for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) {
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      const nextLine = text.indexOf("\n", end);
      const lineEnd = nextLine === -1 ? text.length : nextLine;
      if (
        !text.slice(lineStart, start).trim() &&
        !text.slice(end, lineEnd).trim()
      ) {
        text =
          text.slice(0, lineStart) +
          text.slice(nextLine === -1 ? lineEnd : nextLine + 1);
      } else {
        text = text.slice(0, start) + text.slice(end).replace(/^[ \t]+/, "");
      }
    }
    return text.trim();
  }

  function DeclarationDoc({
    type,
    tables,
  }: {
    type: Declaration;
    tables: boolean;
  }) {
    const examples = getExamples(program, type);
    const model = type.kind === "Model" ? type : undefined;
    const properties = model ? propertyDocs(model) : [];
    const showSource = !tables || isTemplateDeclaration(type);
    return (
      <md.Section
        heading={inline(getTypeName(type, { namespaceFilter: () => false }))}
      >
        {`<a id="${anchor(type)}"></a>`}
        {doc(type)}
        {showSource && <Code lang="typespec">{sourceSnippet(type)}</Code>}
        {constraints(type)}
        {model?.baseModel && <>Extends {typeExpression(model.baseModel)}.</>}
        {model?.indexer && (
          <>Additional entries: {typeExpression(model.indexer.value)}.</>
        )}
        {model &&
          model.properties.size === 0 &&
          !model.baseModel &&
          !model.indexer &&
          "An object with no declared properties."}
        {tables && properties.length > 0 && (
          <Table
            headings={["Property", "Type", "Description", "Constraints"]}
            rows={properties.map((property) => [
              inline(property.name),
              property.type,
              property.description,
              property.constraints,
            ])}
          />
        )}
        {!tables && (
          <For each={properties} doubleHardline>
            {(property) => (
              <md.Section heading={inline(property.name)}>
                {property.description}
                {`Type: ${property.type}.`}
                {property.constraints}
              </md.Section>
            )}
          </For>
        )}
        {type.kind === "Union" && (
          <md.List bullet="-">
            {[...type.variants.values()].map((variant) => (
              <>
                {typeExpression(variant.type)}
                {doc(variant) && `: ${doc(variant)}`}
              </>
            ))}
          </md.List>
        )}
        {tables && type.kind === "Enum" && (
          <Table
            headings={["Member", "Value", "Description"]}
            rows={[...type.members.values()].map((member) => [
              inline(member.name),
              inline(JSON.stringify(member.value ?? member.name)),
              doc(member),
            ])}
          />
        )}
        {!tables && type.kind === "Enum" && (
          <For each={[...type.members.values()]} doubleHardline>
            {(member) => (
              <md.Section heading={inline(member.name)}>
                {doc(member)}
                {`Value: ${inline(JSON.stringify(member.value ?? member.name))}.`}
              </md.Section>
            )}
          </For>
        )}
        {type.kind === "Scalar" && type.baseScalar && (
          <>Base type: {typeExpression(type.baseScalar)}.</>
        )}
        <For each={examples} doubleHardline>
          {(example) => (
            <md.Section heading={example.title ?? "Example"}>
              {example.description}
              <Code lang="json">
                {JSON.stringify(
                  serializeValueAsJson(program, example.value, type),
                  null,
                  2,
                )}
              </Code>
            </md.Section>
          )}
        </For>
      </md.Section>
    );
  }

  function propertyDocs(
    model: Model,
    prefix = "",
    active = new Set<Model>(),
  ): PropertyDoc[] {
    if (active.has(model)) return [];
    active = new Set(active).add(model);
    return [...walkPropertiesInherited(model)].flatMap((property) => {
      const path = `${prefix}${property.name}${property.optional ? "?" : ""}`;
      const entry = {
        name: path,
        type: typeExpression(property.type),
        description: doc(property),
        constraints: constraints(property),
      };
      const nested =
        property.type.kind === "Model" && !property.type.name
          ? propertyDocs(property.type, `${path}.`, active)
          : [];
      return [entry, ...nested];
    });
  }

  return (
    <Output>
      {[
        { path: "REFERENCE.md", tables: false },
        { path: "REFERENCE-TABLES.md", tables: true },
      ].map(({ path, tables }) => (
        <md.SourceFile path={path}>
          <md.Section heading="Agent Hooks schema reference">
            {
              "<!-- Generated by @agent-hooks/reference-docs. Do not edit by hand. -->"
            }
            {
              "Generated from the TypeSpec declarations. A `?` marks an optional property; `null` is a separate allowed value. The published JSON Schemas remain the normative validation artifacts; the specification defines the behavioral requirements."
            }
            {!tables &&
              "Each declaration is shown as a TypeSpec source excerpt, followed by its member documentation. See the [table representation](REFERENCE-TABLES.md) to compare layouts."}
            {tables &&
              "See the [declaration reference](REFERENCE.md) for TypeSpec excerpts and per-property documentation."}
            <md.List bullet="-">
              {props.categories.map((category) => (
                <md.Link
                  href={`#${category.title.toLowerCase().replaceAll(" ", "-")}`}
                  title={category.title}
                />
              ))}
            </md.List>
            <For each={props.categories} doubleHardline>
              {(category) => (
                <md.Section heading={category.title}>
                  <md.List bullet="-">
                    {category.declarations.map((type) => (
                      <md.Link
                        href={`#${anchor(type)}`}
                        title={inline(
                          getTypeName(type, { namespaceFilter: () => false }),
                        )}
                      />
                    ))}
                  </md.List>
                  <For each={category.declarations} doubleHardline>
                    {(type) => <DeclarationDoc type={type} tables={tables} />}
                  </For>
                </md.Section>
              )}
            </For>
          </md.Section>
        </md.SourceFile>
      ))}
    </Output>
  );
}
