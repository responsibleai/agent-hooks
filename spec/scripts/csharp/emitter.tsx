// Copyright (c) Microsoft. All rights reserved.

import { code, For, type Children } from "@alloy-js/core";
import * as cs from "@alloy-js/csharp";
import { Numerics } from "@alloy-js/csharp/global/System";
import { Generic } from "@alloy-js/csharp/global/System/Collections";
import { Json } from "@alloy-js/csharp/global/System/Text";
import { Serialization } from "@alloy-js/csharp/global/System/Text/Json";
import {
  type EmitContext, type Enum, type Model, type ModelProperty, type Program, type Type,
  type Union, getFriendlyName, isTemplateDeclaration,
} from "@typespec/compiler";
import type { Typekit } from "@typespec/compiler/typekit";
import {
  Experimental_ComponentOverrides, Experimental_ComponentOverridesConfig, Output, useTsp, writeOutput,
} from "@typespec/emitter-framework";
import * as ef from "@typespec/emitter-framework/csharp";
import { getExtensions } from "@typespec/json-schema";
import { Contracts } from "./runtime.js";

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

function closed(program: Program, type: Model): boolean {
  return getExtensions(program, type).some(
    (extension) => extension.key === "additionalProperties" && extension.value === false,
  );
}

/** Property-less models (`Record<T>`, `{}`) are plain dictionaries, not declarations. */
function dictionary(type: Type): boolean {
  return type.kind === "Model" && type.properties.size === 0;
}

function isInteger($: Typekit, type: Type): boolean {
  return type.kind === "Scalar" && $.scalar.getStdBase(type)?.name === "integer";
}

function isUnknown(type: Type): boolean {
  return type.kind === "Intrinsic" && type.name === "unknown";
}

function typeOf(type: Children): Children {
  return code`typeof(${type})`;
}

function converter(type: Children): Children {
  return <cs.Attribute name={Serialization.JsonConverterAttribute} args={[typeOf(type)]} />;
}

function ignoreWhen(condition: "WhenWritingDefault" | "WhenWritingNull"): Children {
  return <cs.Attribute name={Serialization.JsonIgnoreAttribute}
    args={[code`Condition = ${Serialization.JsonIgnoreCondition[condition]}`]} />;
}

/**
 * Collect concrete contracts, including instantiated verdicts and anonymous
 * metadata. Keep the TypeSpec objects as identities for Alloy's reference binder.
 */
function contracts(program: Program) {
  const namespace = program.getGlobalNamespaceType().namespaces.get("AgentHooks");
  if (!namespace) throw new Error("Missing AgentHooks namespace.");
  const names = new Map<Declaration, string>();
  const policy = cs.createCSharpNamePolicy();
  function visit(source: Type, hint: string): void {
    const type = unwrap(source);
    const inner = nullableInner(type);
    if (inner) return visit(inner, hint);
    if (type.kind === "Model" && type.indexer) visit(type.indexer.value, `${hint}Value`);
    if (dictionary(type)) return;
    if (type.kind !== "Model" && type.kind !== "Union" && type.kind !== "Enum") return;
    if (names.has(type)) return;
    if (type.kind === "Model" && type.templateMapper && !getFriendlyName(program, type)) {
      throw new Error(`Template instance ${type.name} needs @friendlyName for a stable C# name.`);
    }
    const name = policy.getName(getFriendlyName(program, type) ?? (type.name || hint), "class");
    if ([...names.values()].includes(name)) throw new Error(`Duplicate C# contract name: ${name}`);
    names.set(type, name);
    if (type.kind === "Model") {
      for (const property of type.properties.values()) {
        visit(property.type, `${name}${policy.getName(property.name, "class")}`);
      }
    } else if (type.kind === "Union") {
      for (const [index, variant] of [...type.variants.values()].entries()) {
        visit(variant.type, `${name}Variant${index + 1}`);
      }
    }
  }
  for (const type of [...namespace.enums.values(), ...namespace.models.values(), ...namespace.unions.values()]) {
    if (!isTemplateDeclaration(type)) visit(type, type.name ?? "Union");
  }
  return names;
}

/** Infer the literal member that selects each variant (`@discriminated` cannot express boolean or templated unions). */
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

/**
 * Optional members are nullable and omitted when null; only `?: T | null`
 * needs Optional<T> to keep an explicit null distinct from omission.
 */
function ContractProperty(props: { type: ModelProperty }): Children {
  const { $ } = useTsp();
  const property = props.type;
  const type = unwrap(property.type);
  const inner = nullableInner(type);
  const value = literal(type);
  const expression = <ef.TypeExpression type={type} />;
  const attributes = [
    <cs.Attribute name={Serialization.JsonPropertyNameAttribute} args={[JSON.stringify(property.name)]} />,
  ];
  const doc = ef.getDocComments($, property);

  if (value !== undefined && !property.optional) {
    // Required literals are fixed wire values: supplied on write, checked on read.
    const initializer = type.kind === "EnumMember" ? <cs.Reference refkey={ef.efRefkey(type)} /> : JSON.stringify(value);
    attributes.push(<cs.Attribute name={Serialization.JsonRequiredAttribute} />);
    return <cs.Property public name={property.name} type={expression} attributes={attributes} doc={doc}
      get={code`return ${initializer};`}
      set={code`if (value != ${initializer}) throw new ${Json.JsonException}(${JSON.stringify(`Expected ${property.name} = ${String(value)}.`)});`} />;
  }

  let propertyType: Children = expression;
  if (property.optional && inner) {
    propertyType = code`${Contracts.Optional}<${expression}>`;
    attributes.push(converter(isInteger($, inner)
      ? code`${Contracts.OptionalJsonConverter}<${Numerics.BigInteger}, ${Contracts.BigIntegerJsonConverter}>`
      : code`${Contracts.OptionalJsonConverter}<${expression}>`));
    attributes.push(ignoreWhen("WhenWritingDefault"));
  } else {
    if (isInteger($, inner ?? type)) attributes.push(converter(Contracts.BigIntegerJsonConverter));
    if (property.optional && isUnknown(type)) {
      // An unset JsonElement is Undefined, so a present JSON null still round-trips.
      attributes.push(ignoreWhen("WhenWritingDefault"));
    } else if (property.optional) {
      propertyType = code`${expression}?`;
      attributes.push(ignoreWhen("WhenWritingNull"));
    }
  }
  return <cs.Property public name={property.name} type={propertyType} required={!property.optional}
    get set attributes={attributes} doc={doc} />;
}

/** The framework's EnumDeclaration cannot attach per-member wire names. */
function EnumContract(props: { type: Enum; name: string }): Children {
  const { $ } = useTsp();
  const policy = cs.useCSharpNamePolicy();
  const reference = <cs.Reference refkey={ef.efRefkey(props.type)} />;
  return <cs.EnumDeclaration public name={props.name} refkey={ef.efRefkey(props.type)}
    doc={ef.getDocComments($, props.type)}
    attributes={[converter(code`${Contracts.StrictJsonStringEnumConverter}<${reference}>`)]}>
    <For each={[...props.type.members.values()]} joiner={",\n"}>
      {(member) => <>
        <cs.DocWhen doc={ef.getDocComments($, member)} />
        <cs.EnumMember name={policy.getName(member.name, "enum-member")} refkey={ef.efRefkey(member)}
          attributes={[<cs.Attribute name={Serialization.JsonStringEnumMemberNameAttribute}
            args={[JSON.stringify(member.value ?? member.name)]} />]} />
      </>}
    </For>
  </cs.EnumDeclaration>;
}

function UnionContract(props: { type: Union; name: string; info: UnionContractInfo }): Children {
  const { $ } = useTsp();
  const { models, discriminator } = props.info;
  const converterName = `${props.name}JsonConverter`;
  const reference = <cs.Reference refkey={ef.efRefkey(props.type)} />;
  const defaultModel = models.find((model) => model.properties.get(discriminator)!.optional);
  const variants = models.map((model) =>
    code`(${JSON.stringify(String(literal(model.properties.get(discriminator)!.type)))}, ${typeOf(<ef.TypeExpression type={model} />)})`);
  return <>
    <cs.InterfaceDeclaration public name={`I${props.name}`} refkey={ef.efRefkey(props.type)}
      doc={ef.getDocComments($, props.type)} attributes={[converter(converterName)]} />
    <hbr /><hbr />
    <cs.ClassDeclaration internal sealed name={converterName}
      baseType={code`${Contracts.DiscriminatedUnionJsonConverter}<${reference}>`}>
      <cs.Constructor public baseConstructor={[
        JSON.stringify(discriminator),
        defaultModel ? typeOf(<ef.TypeExpression type={defaultModel} />) : "null",
        ...variants,
      ]} />
    </cs.ClassDeclaration>
  </>;
}

function ModelContract(props: { type: Model; name: string; unions: UnionContractInfo[] }): Children {
  const { program, $ } = useTsp();
  const interfaces = props.unions.filter((union) => union.models.includes(props.type))
    .map((union) => <cs.Reference refkey={ef.efRefkey(union.type)} />);
  if (closed(program, props.type)) {
    return <ef.ClassDeclaration public sealed type={props.type} name={props.name}
      jsonAttributes interfaceTypes={interfaces}
      attributes={[<cs.Attribute name={Serialization.JsonUnmappedMemberHandlingAttribute}
        args={[Serialization.JsonUnmappedMemberHandling.Disallow]} />]} />;
  }
  // The framework's ClassDeclaration derives its whole body from the model, so
  // open models add their extension-data member here.
  return <cs.ClassDeclaration public sealed name={props.name} refkey={ef.efRefkey(props.type)}
    interfaceTypes={interfaces} doc={ef.getDocComments($, props.type)}>
    <For each={[...props.type.properties.values()]} doubleHardline>
      {(property) => <ef.Property type={property} jsonAttributes />}
    </For>
    <hbr /><hbr />
    <cs.Property public name="AdditionalProperties" type={code`${Generic.Dictionary}<string, ${Json.JsonElement}>`}
      get set initializer="[]" attributes={[<cs.Attribute name={Serialization.JsonExtensionDataAttribute} />]} />
  </cs.ClassDeclaration>;
}

/**
 * Source-generated metadata, so the contracts also serialize under trimming and
 * Native AOT. Every declaration is listed because union variants are reachable
 * only through their converters.
 */
function SerializerContext(props: { names: Map<Declaration, string> }): Children {
  return <cs.ClassDeclaration public partial name="ContractsJsonContext" baseType={Serialization.JsonSerializerContext}
    attributes={[...props.names.keys()].map((type) => <cs.Attribute name={Serialization.JsonSerializableAttribute}
      args={[typeOf(<cs.Reference refkey={ef.efRefkey(type)} />)]} />)} />;
}

function GeneratedContracts(): Children {
  const { program } = useTsp();
  const names = contracts(program);
  const unions = [...names.keys()].filter((type): type is Union => type.kind === "Union").map(unionInfo);
  const unionByType = new Map(unions.map((info) => [info.type, info]));
  const overrides = new Experimental_ComponentOverridesConfig()
    .forTypeKind("ModelProperty", { declaration: ({ type }) => <ContractProperty type={type} /> })
    .forTypeKind("Intrinsic", {
      reference: ({ type, default: fallback }) => isUnknown(type) ? Json.JsonElement : fallback,
    })
    .forTypeKind("Scalar", {
      reference: ({ type, default: fallback }) => isInteger(useTsp().$, type) ? Numerics.BigInteger : fallback,
    })
    .forTypeKind("Model", {
      reference: ({ type, default: fallback }) => dictionary(type) && type.name !== "Array"
        ? code`${Generic.IDictionary}<string, ${type.indexer ? <ef.TypeExpression type={type.indexer.value} /> : Json.JsonElement}>`
        : fallback,
    });
  for (const [type] of names) {
    overrides.forType(type, { reference: () => <cs.Reference refkey={ef.efRefkey(type)} /> });
  }
  return <Experimental_ComponentOverrides overrides={overrides}>
    <cs.Namespace name="AgentHooks.Contracts.Draft">
      <cs.SourceFile path="Contracts.g.cs"
        header={"// Copyright (c) Microsoft. All rights reserved.\n\n// <auto-generated />\n// Generated from spec/draft/schema/src/. Do not edit by hand."}>
        {"#nullable enable"}<hbr /><hbr />
        <For each={[...names.entries()]} doubleHardline>
          {([type, name]) => type.kind === "Enum" ? <EnumContract type={type} name={name} />
            : type.kind === "Union" ? <UnionContract type={type} name={name} info={unionByType.get(type)!} />
            : <ModelContract type={type} name={name} unions={unions} />}
        </For>
        <hbr /><hbr />
        <SerializerContext names={names} />
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
