// Copyright (c) Microsoft. All rights reserved.

import { code, For, type Children } from "@alloy-js/core";
import * as cs from "@alloy-js/csharp";
import {
  type EmitContext, type Enum, type Model, type ModelProperty, type Operation, type Program, type Type,
  type Union, createTypeSpecLibrary, isNeverType, isTemplateDeclaration,
} from "@typespec/compiler";
import {
  Experimental_ComponentOverrides, Experimental_ComponentOverridesConfig, Output, useTsp, writeOutput,
} from "@typespec/emitter-framework";
import * as ef from "@typespec/emitter-framework/csharp";
import { DictionaryInitializer, JsonConverterAttribute, JsonConverterDeclaration } from "./json-components.js";
import { OperationHandler } from "./operation-handler.js";

export const $lib = createTypeSpecLibrary({
  name: "@agent-hooks/emitter-csharp",
  diagnostics: {},
});

type Declaration = Model | Enum | Union;
type UnionContractInfo = ReturnType<typeof unionInfo>;

/** Nullable unions are type expressions, not additional declarations. */
function nullableInner(type: Type): Type | undefined {
  return type.kind === "Union" ? ef.getNullableUnionInnerType(type) : undefined;
}

function unwrap(type: Type): Type {
  return type.kind === "ModelProperty" || type.kind === "UnionVariant" ? unwrap(type.type) : type;
}

function literal(type: Type): string | number | boolean | undefined {
  type = unwrap(type);
  if (type.kind === "String" || type.kind === "Boolean") return type.value;
  if (type.kind === "EnumMember") return type.value ?? type.name;
  return undefined;
}

function closed(type: Model): boolean {
  return type.indexer !== undefined && isNeverType(type.indexer.value);
}

/**
 * An anonymous `{ ...Named; ...Record<never> }` closes a named model for
 * validation only; C# reuses the named contract.
 */
function closedProjection(type: Type): Model | undefined {
  if (type.kind !== "Model" || type.name || !closed(type)) return undefined;
  const sources = new Set([...type.properties.values()].map((property) => property.sourceProperty?.model));
  const [source] = sources;
  return sources.size === 1 && source?.name && source.properties.size === type.properties.size ? source : undefined;
}

/**
 * Collect concrete contracts, including instantiated verdicts and anonymous
 * metadata. Keep the TypeSpec objects as identities for Alloy's reference binder.
 */
function contracts(program: Program) {
  const namespace = program.getGlobalNamespaceType().namespaces.get("AgentHooks");
  if (!namespace) throw new Error("Missing AgentHooks namespace.");
  const names = new Map<Declaration, string>();
  const aliases = new Map<Model, Model>();
  const usedNames = new Set<string>();
  const policy = cs.createCSharpNamePolicy();
  function visit(source: Type, hint: string): void {
    const type = unwrap(source);
    const inner = nullableInner(type);
    if (inner) return visit(inner, hint);
    if (type.kind !== "Model" && type.kind !== "Union" && type.kind !== "Enum") return;
    if (type.kind === "Model" && type.name === "Array" && type.indexer) {
      return visit(type.indexer.value, `${hint}Item`);
    }
    const projected = closedProjection(type);
    if (projected) {
      aliases.set(type as Model, projected);
      return visit(projected, hint);
    }
    if (names.has(type)) return;
    const templateArguments = type.kind === "Model" ? type.templateMapper?.args : undefined;
    const sourceName = type.name;
    const name = policy.getName(
      templateArguments
        ? `${sourceName}${templateArguments.map((arg) => {
          if (!("name" in arg) || !arg.name) throw new Error("Unsupported unnamed template argument.");
          return arg.name;
        }).join("")}`
        : sourceName || hint,
      "class",
    );
    if (usedNames.has(name)) throw new Error(`Duplicate C# contract name: ${name}`);
    usedNames.add(name);
    names.set(type, name);
    if (type.kind === "Model") {
      for (const property of type.properties.values()) {
        visit(property.type, `${name}${policy.getName(property.name, "class")}`);
      }
      if (type.indexer) visit(type.indexer.value, `${name}Value`);
    } else if (type.kind === "Union") {
      for (const [index, variant] of [...type.variants.values()].entries()) {
        visit(variant.type, `${name}Variant${index + 1}`);
      }
    }
  }
  for (const type of [...namespace.enums.values(), ...namespace.models.values(), ...namespace.unions.values()]) {
    if (!isTemplateDeclaration(type)) visit(type, type.name ?? "Union");
  }
  const handlers = new Map<Operation, string>();
  for (const iface of namespace.interfaces.values()) {
    for (const operation of iface.operations.values()) {
      if (isTemplateDeclaration(operation)) continue;
      const responseName = operation.returnType.kind === "Model" ? operation.returnType.name : "";
      const name = responseName.endsWith("Response")
        ? `${responseName.slice(0, -"Response".length)}Handler`
        : `${iface.name}${iface.operations.size === 1 ? "" : policy.getName(operation.name, "class")}Handler`;
      for (const parameter of operation.parameters.properties.values()) {
        visit(parameter.type, `${name}${policy.getName(parameter.name, "class")}`);
      }
      visit(operation.returnType, `${name}Response`);
      if (usedNames.has(name)) throw new Error(`Duplicate C# contract name: ${name}`);
      handlers.set(operation, name);
      usedNames.add(name);
    }
  }
  return { names, aliases, handlers };
}

function unionInfo(type: Union) {
  const models = [...type.variants.values()].map((variant) => unwrap(variant.type));
  if (!models.every((variant): variant is Model => variant.kind === "Model")) {
    throw new Error(`Unsupported non-model union: ${type.name}`);
  }
  const discriminator = [...models[0].properties.keys()].find((name) => {
    const properties = models.map((model) => model.properties.get(name));
    const values = properties.map((property) => property && literal(property.type));
    return values.every((value) => value !== undefined) && new Set(values).size === models.length;
  });
  if (!discriminator) throw new Error(`No unique literal discriminator for union ${type.name}`);
  return { type, models, discriminator };
}

function ContractProperty(props: { type: ModelProperty }): Children {
  const { $ } = useTsp();
  const property = props.type;
  const type = unwrap(property.type);
  const value = literal(type);
  const constant = value !== undefined && !property.optional;
  const attributes = [
    <cs.Attribute name="JsonPropertyName" args={[JSON.stringify(property.name)]} />,
  ];
  // Only optional nullable members need Optional<T?> to keep absent distinct from null.
  const nullable = nullableInner(type) !== undefined;
  const tristate = property.optional && nullable;
  if (tristate) {
    attributes.push(<cs.Attribute name="JsonIgnore" args={["Condition = JsonIgnoreCondition.WhenWritingDefault"]} />);
  } else {
    attributes.push(property.optional
      ? <cs.Attribute name="JsonIgnore" args={["Condition = JsonIgnoreCondition.WhenWritingNull"]} />
      : <cs.Attribute name="JsonRequired" />);
    const scalar = nullableInner(type) ?? type;
    if (scalar.kind === "Scalar" && $.scalar.getStdBase(scalar)?.name === "integer") {
      attributes.push(<JsonConverterAttribute name="BigIntegerJsonConverter" />);
    }
  }
  const expression = <ef.TypeExpression type={type} />;
  const propertyType = tristate ? code`Optional<${expression}>`
    : property.optional ? code`${expression}?` : expression;
  const initializer = type.kind === "EnumMember"
    ? code`${<ef.TypeExpression type={type.enum} />}.${cs.createCSharpNamePolicy().getName(type.name, "enum-member")}`
    : JSON.stringify(value);
  return <cs.Property
    public name={property.name}
    type={propertyType}
    required={!property.optional && !constant}
    get={constant ? code`return ${initializer};` : true}
    set={constant ? code`if (value != ${initializer}) throw new JsonException(${JSON.stringify(`Expected ${property.name} = ${String(value)}.`)});` : true}
    attributes={attributes}
    doc={ef.getDocComments($, property)}
  />;
}

function EnumContract(props: { type: Enum; name: string }): Children {
  const reference = <ef.TypeExpression type={props.type} />;
  const name = `${props.name}JsonConverter`;
  const policy = cs.useCSharpNamePolicy();
  return <>
    <ef.EnumDeclaration public type={props.type}
      attributes={[<JsonConverterAttribute name={name} />]} />
    <hbr /><hbr />
    <JsonConverterDeclaration name={name}
      baseType={code`StringEnumJsonConverter<${reference}>`}
      baseArguments={[<DictionaryInitializer keyType={reference} valueType="string"
        entries={[...props.type.members.values()].map((member) => ({
          key: code`${reference}.${policy.getName(member.name, "enum-member")}`,
          value: JSON.stringify(member.value ?? member.name),
        }))} />]} />
  </>;
}

function UnionContract(props: { type: Union; name: string; info: UnionContractInfo }): Children {
  const { models, discriminator } = props.info;
  const name = `${props.name}JsonConverter`;
  const reference = <cs.Reference refkey={ef.efRefkey(props.type)} />;
  const defaultModel = models.find((model) => model.properties.get(discriminator)!.optional);
  const defaultType = defaultModel ? code`typeof(${<ef.TypeExpression type={defaultModel} />})` : "null";
  return <>
    <cs.InterfaceDeclaration public name={props.name} refkey={ef.efRefkey(props.type)}
      attributes={[<JsonConverterAttribute name={name} />]} />
    <hbr /><hbr />
    <JsonConverterDeclaration name={name}
      baseType={code`DiscriminatedUnionJsonConverter<${reference}>`}
      baseArguments={[
        JSON.stringify(discriminator),
        <DictionaryInitializer keyType="string" valueType="Type"
          entries={models.map((model) => ({
            key: JSON.stringify(String(literal(model.properties.get(discriminator)!.type))),
            value: code`typeof(${<ef.TypeExpression type={model} />})`,
          }))} />,
        defaultType,
      ]} />
  </>;
}

function ModelContract(props: { type: Model; name: string; unions: UnionContractInfo[] }): Children {
  const { $ } = useTsp();
  const interfaces = props.unions.filter((union) => union.models.includes(props.type))
    .map((union) => <cs.Reference refkey={ef.efRefkey(union.type)} />);
  // The framework owns ordinary model declarations. Alloy supplies dictionaries
  // and extension-data members, which the C# framework does not yet expose.
  if (closed(props.type)) {
    return <ef.ClassDeclaration public sealed type={props.type} name={props.name}
      jsonAttributes interfaceTypes={interfaces}
      attributes={[<cs.Attribute name="JsonUnmappedMemberHandling" args={["JsonUnmappedMemberHandling.Disallow"]} />]} />;
  }
  const dictionary = props.type.properties.size === 0;
  return <cs.ClassDeclaration public sealed name={props.name} refkey={ef.efRefkey(props.type)}
    interfaceTypes={interfaces}
    baseType={dictionary ? code`Dictionary<string, ${props.type.indexer ? <ef.TypeExpression type={props.type.indexer.value} /> : "JsonElement"}>` : undefined}
    doc={ef.getDocComments($, props.type)}>
    <For each={[...props.type.properties.values()]} doubleHardline>
      {(property) => <ef.Property type={property} jsonAttributes />}
    </For>
    {!dictionary && <>
      <hbr /><hbr />
      <cs.Property public name="AdditionalProperties" type="Dictionary<string, JsonElement>"
        get set initializer="new()" attributes={[<cs.Attribute name="JsonExtensionData" />]} />
    </>}
  </cs.ClassDeclaration>;
}

function GeneratedContracts(): Children {
  const { program } = useTsp();
  const { names, aliases, handlers } = contracts(program);
  const unions = [...names.keys()].filter((type): type is Union => type.kind === "Union").map(unionInfo);
  const unionByType = new Map(unions.map((info) => [info.type, info]));
  const overrides = new Experimental_ComponentOverridesConfig()
    .forTypeKind("ModelProperty", { declaration: ({ type }) => <ContractProperty type={type} /> })
    .forTypeKind("Intrinsic", {
      reference: ({ type, default: fallback }) => type.name === "unknown" ? "JsonElement" : fallback,
    })
    .forTypeKind("Scalar", {
      reference: ({ type, default: fallback }) => {
        const { $ } = useTsp();
        return $.scalar.getStdBase(type)?.name === "integer" ? "BigInteger" : fallback;
      },
    });
  for (const [type] of names) {
    overrides.forType(type, { reference: () => <cs.Reference refkey={ef.efRefkey(type)} /> });
  }
  for (const [type, source] of aliases) {
    overrides.forType(type, { reference: () => <cs.Reference refkey={ef.efRefkey(source)} /> });
  }
  return <Experimental_ComponentOverrides overrides={overrides}>
    <cs.Namespace name="AgentHooks.Contracts.Draft">
      <cs.SourceFile path="Contracts.g.cs"
        header={"// Copyright (c) Microsoft. All rights reserved.\n\n// <auto-generated />\n// Generated from spec/draft/schema/src/. Do not edit by hand."}
        using={["System", "System.Collections.Generic", "System.Numerics", "System.Text.Json", "System.Text.Json.Serialization", "System.Threading", "System.Threading.Tasks", "AgentHooks.Contracts.Serialization"]}>
        {"#nullable enable"}<hbr /><hbr />
        <For each={[...names.entries()]} doubleHardline>
          {([type, name]) => type.kind === "Enum" ? <EnumContract type={type} name={name} />
            : type.kind === "Union" ? <UnionContract type={type} name={name} info={unionByType.get(type)!} />
            : <ModelContract type={type} name={name} unions={unions} />}
        </For>
        <hbr /><hbr />
        <For each={handlers} doubleHardline>
          {(type, name) => <OperationHandler type={type} name={name} />}
        </For>
      </cs.SourceFile>
    </cs.Namespace>
  </Experimental_ComponentOverrides>;
}

export async function $onEmit(context: EmitContext): Promise<void> {
  await writeOutput(context.program,
    <Output program={context.program} namePolicy={cs.createCSharpNamePolicy()} tabWidth={4}>
      <GeneratedContracts />
    </Output>,
    context.emitterOutputDir,
  );
}
