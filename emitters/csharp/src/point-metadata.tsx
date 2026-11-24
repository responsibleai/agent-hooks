// Copyright (c) Microsoft. All rights reserved.

import { code, For, type Children } from "@alloy-js/core";
import * as cs from "@alloy-js/csharp";
import {
  type Enum, type EnumMember, type Model, type Operation, type Program, type Type,
  isTemplateDeclaration,
} from "@typespec/compiler";
import * as ef from "@typespec/emitter-framework/csharp";
import { getJsonSchema } from "@typespec/json-schema";

export interface PointTransformTarget {
  readonly member: string;
  readonly path: readonly string[];
}

export interface PointMetadataEntry {
  readonly member: EnumMember;
  readonly wireName: string;
  readonly requestModel: Model;
  readonly responseModel: Model;
  readonly transformTarget?: PointTransformTarget;
}

export interface InterceptionPointsInfo {
  readonly pointEnum: Enum;
  readonly entries: readonly PointMetadataEntry[];
}

export const POINT_METADATA_TYPE_NAMES = [
  "TransformTarget",
  "InterceptionPointMetadata",
  "InterceptionPoints",
] as const;

function unwrap(type: Type): Type {
  return type.kind === "ModelProperty" || type.kind === "UnionVariant" ? unwrap(type.type) : type;
}

function literalValue(type: Type | undefined): string | number | boolean | undefined {
  if (!type) return undefined;
  const unwrapped = unwrap(type);
  if (unwrapped.kind === "String" || unwrapped.kind === "Boolean") return unwrapped.value;
  if (unwrapped.kind === "EnumMember") return unwrapped.value ?? unwrapped.name;
  return undefined;
}

function resolveTransformTarget(
  pointName: string,
  requestModel: Model,
  responseModel: Model,
): PointTransformTarget | undefined {
  const verdictProp = responseModel.properties.get("verdict");
  if (!verdictProp) {
    throw new Error(`Response model ${responseModel.name} for ${pointName} is missing a verdict property.`);
  }
  const verdictType = unwrap(verdictProp.type);
  if (verdictType.kind !== "Union") {
    throw new Error(`Response model ${responseModel.name}.verdict for ${pointName} must be a union.`);
  }
  const variants = [...verdictType.variants.values()].map((variant) => unwrap(variant.type));
  if (variants.length === 0 || !variants.every((variant): variant is Model => variant.kind === "Model")) {
    throw new Error(`Response model ${responseModel.name}.verdict for ${pointName} must be a non-empty union of models.`);
  }

  const transformVariants: Model[] = [];
  for (const variant of variants) {
    const decision = literalValue(variant.properties.get("decision")?.type);
    const hasTransform = variant.properties.has("transform");
    if (decision === "transform") {
      if (!hasTransform) {
        throw new Error(`Transform verdict in ${responseModel.name} for ${pointName} is missing a transform property.`);
      }
      transformVariants.push(variant);
    } else if (hasTransform) {
      throw new Error(
        `Non-transform verdict in ${responseModel.name} for ${pointName} unexpectedly declares a transform property.`,
      );
    }
  }

  if (transformVariants.length === 0) {
    return undefined;
  }
  if (transformVariants.length > 1) {
    throw new Error(`Response model ${responseModel.name} for ${pointName} declares multiple transform verdict variants.`);
  }

  const transformModel = unwrap(transformVariants[0].properties.get("transform")!.type);
  if (transformModel.kind !== "Model") {
    throw new Error(`Transform payload in ${responseModel.name} for ${pointName} must be a model.`);
  }
  if (transformModel.properties.size !== 1) {
    throw new Error(
      `Transform model ${transformModel.name || responseModel.name} for ${pointName} must declare exactly one property, found ${transformModel.properties.size}.`,
    );
  }

  const [transformMember] = transformModel.properties.values();
  const member = transformMember.name;
  const paths: string[][] = [];
  if (requestModel.properties.has(member)) {
    paths.push([member]);
  }
  for (const property of requestModel.properties.values()) {
    if (property.optional) continue;
    const propertyType = unwrap(property.type);
    if (propertyType.kind !== "Model" || propertyType.name === "Array") continue;
    if (propertyType.properties.has(member)) {
      paths.push([property.name, member]);
    }
  }
  if (paths.length !== 1) {
    const found = paths.length === 0 ? "none" : paths.map((path) => path.join(".")).join(", ");
    throw new Error(
      `Transform member "${member}" on ${transformModel.name || responseModel.name} must resolve to a unique path in ${requestModel.name}, found ${paths.length} (${found}).`,
    );
  }

  return { member, path: paths[0] };
}

/**
 * Derive per-interception-point metadata from enum InterceptionPoint,
 * interface Interceptor, and their request/response models by convention.
 */
export function resolvePointMetadata(program: Program): InterceptionPointsInfo {
  const namespace = program.getGlobalNamespaceType().namespaces.get("AgentHooks");
  if (!namespace) throw new Error("Missing AgentHooks namespace.");

  const pointEnum = namespace.enums.get("InterceptionPoint");
  if (!pointEnum || pointEnum.members.size === 0) {
    throw new Error("Missing or empty InterceptionPoint enum in AgentHooks namespace.");
  }

  const interceptor = namespace.interfaces.get("Interceptor");
  if (!interceptor) {
    throw new Error("Missing Interceptor interface in AgentHooks namespace.");
  }

  const operationsByPoint = new Map<EnumMember, { operation: Operation; requestModel: Model; responseModel: Model }>();
  for (const operation of interceptor.operations.values()) {
    if (isTemplateDeclaration(operation)) continue;
    const parameters = [...operation.parameters.properties.values()];
    if (parameters.length !== 1) {
      throw new Error(
        `Interceptor.${operation.name} must declare exactly one request parameter, found ${parameters.length}.`,
      );
    }
    const requestModel = unwrap(parameters[0].type);
    if (requestModel.kind !== "Model" || !requestModel.name) {
      throw new Error(`Interceptor.${operation.name} request parameter must be a named model.`);
    }
    if (!getJsonSchema(program, requestModel)) {
      throw new Error(`Interceptor.${operation.name} request model ${requestModel.name} is missing @jsonSchema.`);
    }

    const pointProperty = requestModel.properties.get("interception_point");
    if (!pointProperty) {
      throw new Error(`Request model ${requestModel.name} is missing an interception_point property.`);
    }
    const pointType = unwrap(pointProperty.type);
    if (pointType.kind !== "EnumMember" || pointType.enum !== pointEnum) {
      throw new Error(
        `Request model ${requestModel.name}.interception_point must be a literal InterceptionPoint enum member.`,
      );
    }

    const existing = operationsByPoint.get(pointType);
    if (existing) {
      throw new Error(
        `Duplicate Interceptor operation for InterceptionPoint.${pointType.name}: ${existing.operation.name} and ${operation.name}.`,
      );
    }

    const responseModel = unwrap(operation.returnType);
    if (responseModel.kind !== "Model" || !responseModel.name) {
      throw new Error(`Interceptor.${operation.name} return type must be a named model.`);
    }
    if (!getJsonSchema(program, responseModel)) {
      throw new Error(`Interceptor.${operation.name} response model ${responseModel.name} is missing @jsonSchema.`);
    }

    operationsByPoint.set(pointType, { operation, requestModel, responseModel });
  }

  const seenWireNames = new Set<string>();
  const entries: PointMetadataEntry[] = [];
  for (const member of pointEnum.members.values()) {
    const wireName = member.value ?? member.name;
    if (typeof wireName !== "string" || wireName.length === 0) {
      throw new Error(`InterceptionPoint.${member.name} must have a non-empty string wire name.`);
    }
    if (seenWireNames.has(wireName)) {
      throw new Error(`Duplicate InterceptionPoint wire name: "${wireName}".`);
    }
    seenWireNames.add(wireName);

    const paired = operationsByPoint.get(member);
    if (!paired) {
      throw new Error(`Missing Interceptor operation for InterceptionPoint.${member.name}.`);
    }

    const transformTarget = resolveTransformTarget(member.name, paired.requestModel, paired.responseModel);
    entries.push({
      member,
      wireName,
      requestModel: paired.requestModel,
      responseModel: paired.responseModel,
      transformTarget,
    });
  }

  return { pointEnum, entries };
}

function fieldNameFor(member: EnumMember, policy: ReturnType<typeof cs.useCSharpNamePolicy>): string {
  const pascal = policy.getName(member.name, "enum-member");
  return `_${pascal[0].toLowerCase()}${pascal.slice(1)}`;
}

export function PointMetadataDeclarations(props: { info: InterceptionPointsInfo }): Children {
  const { pointEnum, entries } = props.info;
  const policy = cs.useCSharpNamePolicy();
  const enumReference = <ef.TypeExpression type={pointEnum} />;

  return <>
    <cs.ClassDeclaration
      public
      sealed
      name="TransformTarget"
      doc={<cs.DocSummary>The hook transform property name and the request JSON path it replaces.</cs.DocSummary>}
    >
      <cs.Constructor
        internal
        parameters={[
          { name: "member", type: "string" },
          { name: "path", type: "IReadOnlyList<string>" },
        ]}
      >
        {"Member = member;"}<hbr />
        {"Path = path;"}
      </cs.Constructor>
      <hbr /><hbr />
      <cs.Property public name="Member" type="string" get />
      <hbr /><hbr />
      <cs.Property public name="Path" type="IReadOnlyList<string>" get />
    </cs.ClassDeclaration>
    <hbr /><hbr />
    <cs.ClassDeclaration
      public
      sealed
      name="InterceptionPointMetadata"
      doc={<cs.DocSummary>Metadata describing an interception point's wire name, schemas, contract types, and transform target.</cs.DocSummary>}
    >
      <cs.Constructor
        internal
        parameters={[
          { name: "point", type: enumReference },
          { name: "wireName", type: "string" },
          { name: "requestSchema", type: "string" },
          { name: "responseSchema", type: "string" },
          { name: "requestType", type: "Type" },
          { name: "responseType", type: "Type" },
          { name: "transformTarget", type: "TransformTarget?" },
        ]}
      >
        {"Point = point;"}<hbr />
        {"WireName = wireName;"}<hbr />
        {"RequestSchema = requestSchema;"}<hbr />
        {"ResponseSchema = responseSchema;"}<hbr />
        {"RequestType = requestType;"}<hbr />
        {"ResponseType = responseType;"}<hbr />
        {"TransformTarget = transformTarget;"}
      </cs.Constructor>
      <hbr /><hbr />
      <cs.Property public name="Point" type={enumReference} get />
      <hbr /><hbr />
      <cs.Property public name="WireName" type="string" get />
      <hbr /><hbr />
      <cs.Property public name="RequestSchema" type="string" get />
      <hbr /><hbr />
      <cs.Property public name="ResponseSchema" type="string" get />
      <hbr /><hbr />
      <cs.Property public name="RequestType" type="Type" get />
      <hbr /><hbr />
      <cs.Property public name="ResponseType" type="Type" get />
      <hbr /><hbr />
      <cs.Property public name="TransformTarget" type="TransformTarget?" get />
    </cs.ClassDeclaration>
    <hbr /><hbr />
    <cs.ClassDeclaration
      public
      static
      name="InterceptionPoints"
      doc={<cs.DocSummary>Metadata lookup for every InterceptionPoint declared in the specification.</cs.DocSummary>}
    >
      <For each={[...entries]} doubleHardline>
        {(entry) => {
          const field = fieldNameFor(entry.member, policy);
          const enumMember = code`${enumReference}.${policy.getName(entry.member.name, "enum-member")}`;
          const target = entry.transformTarget
            ? code`new TransformTarget(${JSON.stringify(entry.transformTarget.member)}, Array.AsReadOnly(new[] { ${entry.transformTarget.path.map((segment) => JSON.stringify(segment)).join(", ")} }))`
            : "null";
          return code`
            private static readonly InterceptionPointMetadata ${field} = new(
                ${enumMember},
                ${JSON.stringify(entry.wireName)},
                ${JSON.stringify(entry.requestModel.name)},
                ${JSON.stringify(entry.responseModel.name)},
                typeof(${<ef.TypeExpression type={entry.requestModel} />}),
                typeof(${<ef.TypeExpression type={entry.responseModel} />}),
                ${target}
            );
          `;
        }}
      </For>
      <hbr /><hbr />
      <cs.Property
        public
        static
        name="All"
        type="IReadOnlyList<InterceptionPointMetadata>"
        get
        initializer={code`
          Array.AsReadOnly(
              new[]
              {
                  ${<For each={[...entries]} hardline>
                    {(entry) => code`${fieldNameFor(entry.member, policy)},`}
                  </For>}
              }
          )
        `}
      />
      <hbr /><hbr />
      <cs.Method
        public
        static
        name="Get"
        returns="InterceptionPointMetadata"
        parameters={[{ name: "point", type: enumReference }]}
        expression
      >
        {"TryGet(point, out var metadata) ? metadata : throw new ArgumentOutOfRangeException(nameof(point), point, null)"}
      </cs.Method>
      <hbr /><hbr />
      <cs.Method
        public
        static
        name="TryGet"
        returns="bool"
        parameters={[
          { name: "point", type: enumReference },
          {
            name: "metadata",
            type: "InterceptionPointMetadata?",
            out: true,
            attributes: [<cs.Attribute name="NotNullWhen" args={["true"]} />],
          },
        ]}
      >
        {code`
          metadata = point switch
          {
              ${<For each={[...entries]} hardline>
                {(entry) => code`${enumReference}.${policy.getName(entry.member.name, "enum-member")} => ${fieldNameFor(entry.member, policy)},`}
              </For>}
              _ => null,
          };
          return metadata is not null;
        `}
      </cs.Method>
      <hbr /><hbr />
      <cs.Method
        public
        static
        name="TryGetByWireName"
        returns="bool"
        parameters={[
          { name: "wireName", type: "string?" },
          {
            name: "metadata",
            type: "InterceptionPointMetadata?",
            out: true,
            attributes: [<cs.Attribute name="NotNullWhen" args={["true"]} />],
          },
        ]}
      >
        {code`
          metadata = wireName switch
          {
              ${<For each={[...entries]} hardline>
                {(entry) => code`${JSON.stringify(entry.wireName)} => ${fieldNameFor(entry.member, policy)},`}
              </For>}
              _ => null,
          };
          return metadata is not null;
        `}
      </cs.Method>
      <hbr /><hbr />
      <cs.Method
        public
        static
        name="TryParse"
        returns="bool"
        parameters={[
          { name: "wireName", type: "string?" },
          { name: "point", type: enumReference, out: true },
        ]}
      >
        {code`
          if (TryGetByWireName(wireName, out var metadata))
          {
              point = metadata.Point;
              return true;
          }

          point = default;
          return false;
        `}
      </cs.Method>
    </cs.ClassDeclaration>
  </>;
}
