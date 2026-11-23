// Copyright (c) Microsoft. All rights reserved.

import {
  code,
  For,
  Output,
  refkey,
  SourceFileContext,
  useContext,
  type Children,
} from "@alloy-js/core";
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
  type: Type;
  description: string;
  constraints: Type;
}

function anchor(type: Declaration): string {
  const namespace = type.namespace && getNamespaceFullName(type.namespace);
  return [namespace, type.name]
    .filter(Boolean)
    .join(".")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .toLowerCase();
}

function headingKey(target: object) {
  const file = useContext(SourceFileContext);
  if (!file) {
    throw new Error("Reference headings must be rendered inside a source file.");
  }
  return refkey(file.path, target);
}

function isTypeReference(value: unknown): value is Type {
  return (
    typeof value === "object" &&
    value !== null &&
    "entityKind" in value &&
    value.entityKind === "Type"
  );
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

  function typeExpression(type: Type, active = new Set<Type>()): Children {
    const name = getTypeName(type, { namespaceFilter: () => false });
    if (
      type.kind === "Model" ||
      type.kind === "Enum" ||
      type.kind === "Union" ||
      type.kind === "Scalar"
    ) {
      if (declarations.has(type)) {
        return <md.Link refkey={headingKey(type)} title={`\`${name}\``} />;
      }
      if (active.has(type)) return <md.InlineCode>{name}</md.InlineCode>;
      active = new Set(active).add(type);
    }
    switch (type.kind) {
      case "Model": {
        if (isArrayModelType(type)) {
          const element = type.indexer.value;
          const expression = typeExpression(element, active);
          return element.kind === "Union" && !element.name
            ? code`(${expression})[]`
            : code`${expression}[]`;
        }
        if (isTemplateInstance(type)) {
          const declaration = [...declarations].find(
            (item) =>
              item.kind === type.kind &&
              item.name === type.name &&
              item.namespace === type.namespace,
          );
          const label = declaration ? (
            <md.Link refkey={headingKey(declaration)} title={`\`${type.name}\``} />
          ) : (
            <md.InlineCode>{type.name}</md.InlineCode>
          );
          const args = type.templateMapper.args.map((arg) =>
            isType(arg)
              ? typeExpression(arg, active)
              : <md.InlineCode>{getEntityName(arg)}</md.InlineCode>,
          );
          return code`${label}&lt;${<For each={args} joiner=", ">{(arg) => arg}</For>}&gt;`;
        }
        if (type.name) return <md.InlineCode>{name}</md.InlineCode>;
        const properties = [...walkPropertiesInherited(type)].map(
          (property) =>
            code`${<md.InlineCode>{property.name + (property.optional ? "?" : "")}</md.InlineCode>}: ${typeExpression(property.type, active)}`,
        );
        if (type.indexer)
          properties.push(
            code`[key: string]: ${typeExpression(type.indexer.value, active)}`,
          );
        return code`{ ${<For each={properties} joiner="; ">{(property) => property}</For>} }`;
      }
      case "EnumMember":
        return declarations.has(type.enum) ? (
          <md.Link refkey={headingKey(type.enum)} title={`\`${name}\``} />
        ) : (
          <md.InlineCode>{name}</md.InlineCode>
        );
      case "Union":
        return (
          <For each={[...type.variants.values()]} joiner={" &#124; "}>
            {(variant) => typeExpression(variant.type, active)}
          </For>
        );
      case "Tuple":
        return code`[${<For each={type.values} joiner=", ">{(value) => typeExpression(value, active)}</For>}]`;
      default:
        return <md.InlineCode>{name}</md.InlineCode>;
    }
  }

  function constraints(type: Type): Children {
    const values: { label: string; value?: string }[] = [];
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
        values.push({ label: name, value: value.toString() });
    }
    const pattern = getPattern(program, type);
    if (pattern !== undefined) values.push({ label: "pattern", value: pattern });
    const format = getFormat(program, type);
    if (format !== undefined) values.push({ label: "format", value: format });
    if (getUniqueItems(program, type)) values.push({ label: "uniqueItems" });
    if (type.kind === "Union" && isOneOf(program, type))
      values.push({ label: "exactly one variant" });
    for (const extension of getExtensions(program, type)) {
      const value = isTypeReference(extension.value)
        ? getTypeName(extension.value)
        : JSON.stringify(extension.value);
      values.push({ label: extension.key, value });
    }
    return (
      <For each={values} joiner="; ">
        {(entry) => (
          <>
            {entry.label}
            {entry.value !== undefined && <>: <md.InlineCode>{entry.value}</md.InlineCode></>}
          </>
        )}
      </For>
    );
  }

  function TypeExpression(props: { type: Type }) {
    return typeExpression(props.type);
  }

  function Constraints(props: { type: Type }) {
    return constraints(props.type);
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

  function DeclarationDoc({ type }: { type: Declaration }) {
    const examples = getExamples(program, type);
    const model = type.kind === "Model" ? type : undefined;
    const properties = model ? propertyDocs(model) : [];
    return (
      <md.Section>
        <md.Heading level={3} refkey={headingKey(type)} id={anchor(type)}>
          <md.InlineCode>{getTypeName(type, { namespaceFilter: () => false })}</md.InlineCode>
        </md.Heading>
        {doc(type)}
        <md.Code lang="typespec">{sourceSnippet(type)}</md.Code>
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
        <For each={properties} doubleHardline>
          {(property) => (
            <md.Section heading={<md.InlineCode>{property.name}</md.InlineCode>}>
              {property.description}
              {code`Type: ${<TypeExpression type={property.type} />}.`}
              <Constraints type={property.constraints} />
            </md.Section>
          )}
        </For>
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
        {type.kind === "Enum" && (
          <For each={[...type.members.values()]} doubleHardline>
            {(member) => (
              <md.Section heading={<md.InlineCode>{member.name}</md.InlineCode>}>
                {doc(member)}
                {code`Value: ${<md.InlineCode>{JSON.stringify(member.value ?? member.name)}</md.InlineCode>}.`}
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
              <md.Code lang="json">
                {JSON.stringify(
                  serializeValueAsJson(program, example.value, type),
                  null,
                  2,
                )}
              </md.Code>
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
        type: property.type,
        description: doc(property),
        constraints: property,
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
      <md.SourceFile path="REFERENCE.md">
        <md.Section heading="Agent Hooks schema reference">
          {
            "<!-- Generated by @agent-hooks/reference-docs. Do not edit by hand. -->"
          }
          {
            "Generated from the TypeSpec declarations. A `?` marks an optional property; `null` is a separate allowed value. The published JSON Schemas remain the normative validation artifacts; the specification defines the behavioral requirements."
          }
          {"Each declaration is shown as a TypeSpec source excerpt, followed by its member documentation."}
          <md.List bullet="-">
            {props.categories.map((category) => (
              <md.Link
                refkey={headingKey(category)}
                title={category.title}
              />
            ))}
          </md.List>
          <For each={props.categories} doubleHardline>
            {(category) => (
              <md.Section>
                <md.Heading
                  level={2}
                  refkey={headingKey(category)}
                  id={`reference-${category.title.toLowerCase().replaceAll(" ", "-")}`}
                >
                  {category.title}
                </md.Heading>
                <md.List bullet="-">
                  {category.declarations.map((type) => (
                    <md.Link
                      refkey={headingKey(type)}
                      title={`\`${getTypeName(type, { namespaceFilter: () => false })}\``}
                    />
                  ))}
                </md.List>
                <For each={category.declarations} doubleHardline>
                  {(type) => <DeclarationDoc type={type} />}
                </For>
              </md.Section>
            )}
          </For>
        </md.Section>
      </md.SourceFile>
    </Output>
  );
}
