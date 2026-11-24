// Copyright (c) Microsoft. All rights reserved.

import {
  code, Declaration, For, List, memo, Name, refkey,
  type Children, type Refkey,
} from "@alloy-js/core";
import * as cs from "@alloy-js/csharp";
import {
  type Enum, type EnumMember, type Model, type Operation, type Program, type Type,
  isArrayModelType, isTemplateDeclaration,
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

const POINT_METADATA_NAMES = {
  transformTarget: "TransformTarget",
  metadata: "InterceptionPointMetadata",
  lookup: "InterceptionPoints",
} as const;

export const POINT_METADATA_TYPE_NAMES = Object.values(POINT_METADATA_NAMES);

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

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

function requireSchemaModel(program: Program, type: Type, label: string): Model {
  const model = unwrap(type);
  invariant(model.kind === "Model" && model.name, `${label} must be a named model.`);
  invariant(getJsonSchema(program, model), `${label} ${model.name} is missing @jsonSchema.`);
  return model;
}

function findTransformModel(pointName: string, responseModel: Model): Model | undefined {
  const verdictProp = responseModel.properties.get("verdict");
  invariant(verdictProp, `Response model ${responseModel.name} for ${pointName} is missing a verdict property.`);

  const verdictType = unwrap(verdictProp.type);
  invariant(verdictType.kind === "Union", `Response model ${responseModel.name}.verdict for ${pointName} must be a union.`);

  const variants = [...verdictType.variants.values()].map((variant) => unwrap(variant.type));
  invariant(
    variants.length > 0 && variants.every((variant): variant is Model => variant.kind === "Model"),
    `Response model ${responseModel.name}.verdict for ${pointName} must be a non-empty union of models.`,
  );

  const transformVariants: Model[] = [];
  for (const variant of variants) {
    const decision = literalValue(variant.properties.get("decision")?.type);
    const hasTransform = variant.properties.has("transform");
    if (decision === "transform") {
      invariant(hasTransform, `Transform verdict in ${responseModel.name} for ${pointName} is missing a transform property.`);
      transformVariants.push(variant);
    } else {
      invariant(
        !hasTransform,
        `Non-transform verdict in ${responseModel.name} for ${pointName} unexpectedly declares a transform property.`,
      );
    }
  }

  if (transformVariants.length === 0) return undefined;
  invariant(
    transformVariants.length === 1,
    `Response model ${responseModel.name} for ${pointName} declares multiple transform verdict variants.`,
  );

  const transformModel = unwrap(transformVariants[0].properties.get("transform")!.type);
  invariant(transformModel.kind === "Model", `Transform payload in ${responseModel.name} for ${pointName} must be a model.`);
  invariant(
    transformModel.properties.size === 1,
    `Transform model ${transformModel.name || responseModel.name} for ${pointName} must declare exactly one property, found ${transformModel.properties.size}.`,
  );
  return transformModel;
}

function findUniqueRequestPath(
  program: Program,
  member: string,
  requestModel: Model,
  ownerName: string,
): readonly string[] {
  const paths: string[][] = [];
  if (requestModel.properties.has(member)) {
    paths.push([member]);
  }
  for (const property of requestModel.properties.values()) {
    if (property.optional) continue;
    const propertyType = unwrap(property.type);
    if (propertyType.kind !== "Model" || isArrayModelType(program, propertyType)) continue;
    if (propertyType.properties.has(member)) {
      paths.push([property.name, member]);
    }
  }
  invariant(
    paths.length === 1,
    `Transform member "${member}" on ${ownerName} must resolve to a unique path in ${requestModel.name}, found ${paths.length} (${paths.length === 0 ? "none" : paths.map((p) => p.join(".")).join(", ")}).`,
  );
  return paths[0];
}

function resolveTransformTarget(
  program: Program,
  pointName: string,
  requestModel: Model,
  responseModel: Model,
): PointTransformTarget | undefined {
  const transformModel = findTransformModel(pointName, responseModel);
  if (!transformModel) return undefined;
  const [transformMember] = transformModel.properties.values();
  const path = findUniqueRequestPath(program, transformMember.name, requestModel, transformModel.name || responseModel.name);
  return { member: transformMember.name, path };
}

/**
 * Derive per-interception-point metadata from enum InterceptionPoint,
 * interface Interceptor, and their request/response models by convention.
 */
export function resolvePointMetadata(program: Program): InterceptionPointsInfo {
  const namespace = program.getGlobalNamespaceType().namespaces.get("AgentHooks");
  invariant(namespace, "Missing AgentHooks namespace.");

  const pointEnum = namespace.enums.get("InterceptionPoint");
  invariant(pointEnum && pointEnum.members.size > 0, "Missing or empty InterceptionPoint enum in AgentHooks namespace.");

  const interceptor = namespace.interfaces.get("Interceptor");
  invariant(interceptor, "Missing Interceptor interface in AgentHooks namespace.");

  const operationsByPoint = new Map<EnumMember, { operation: Operation; requestModel: Model; responseModel: Model }>();
  for (const operation of interceptor.operations.values()) {
    if (isTemplateDeclaration(operation)) continue;
    const parameters = [...operation.parameters.properties.values()];
    invariant(
      parameters.length === 1,
      `Interceptor.${operation.name} must declare exactly one request parameter, found ${parameters.length}.`,
    );

    const requestModel = requireSchemaModel(program, parameters[0].type, `Interceptor.${operation.name} request parameter`);
    const pointProperty = requestModel.properties.get("interception_point");
    invariant(pointProperty, `Request model ${requestModel.name} is missing an interception_point property.`);

    const pointType = unwrap(pointProperty.type);
    invariant(
      pointType.kind === "EnumMember" && pointType.enum === pointEnum,
      `Request model ${requestModel.name}.interception_point must be a literal InterceptionPoint enum member.`,
    );

    const existing = operationsByPoint.get(pointType);
    invariant(
      !existing,
      `Duplicate Interceptor operation for InterceptionPoint.${pointType.name}: ${existing?.operation.name} and ${operation.name}.`,
    );

    const responseModel = requireSchemaModel(program, operation.returnType, `Interceptor.${operation.name} return type`);
    operationsByPoint.set(pointType, { operation, requestModel, responseModel });
  }

  const seenWireNames = new Set<string>();
  const entries: PointMetadataEntry[] = [];
  for (const member of pointEnum.members.values()) {
    const wireName = member.value ?? member.name;
    invariant(
      typeof wireName === "string" && wireName.length > 0,
      `InterceptionPoint.${member.name} must have a non-empty string wire name.`,
    );
    invariant(!seenWireNames.has(wireName), `Duplicate InterceptionPoint wire name: "${wireName}".`);
    seenWireNames.add(wireName);

    const paired = operationsByPoint.get(member);
    invariant(paired, `Missing Interceptor operation for InterceptionPoint.${member.name}.`);

    entries.push({
      member,
      wireName,
      requestModel: paired.requestModel,
      responseModel: paired.responseModel,
      transformTarget: resolveTransformTarget(program, member.name, paired.requestModel, paired.responseModel),
    });
  }

  return { pointEnum, entries };
}

const transformTargetKey = (pointEnum: Enum) => refkey(pointEnum, POINT_METADATA_NAMES.transformTarget);
const metadataTypeKey = (pointEnum: Enum) => refkey(pointEnum, POINT_METADATA_NAMES.metadata);
const lookupTypeKey = (pointEnum: Enum) => refkey(pointEnum, POINT_METADATA_NAMES.lookup);
const fieldKey = (member: EnumMember) => refkey(member, "metadata-field");

interface PropertySpec {
  readonly param: string;
  readonly prop: string;
  readonly type: Children;
  readonly nullable?: boolean;
}

interface ImmutableModelClassProps {
  name: string;
  refkey: Refkey;
  doc: string;
  members: readonly PropertySpec[];
}

function ImmutableModelClass(props: ImmutableModelClassProps): Children {
  return (
    <cs.ClassDeclaration
      public
      sealed
      name={props.name}
      refkey={props.refkey}
      doc={<cs.DocSummary>{props.doc}</cs.DocSummary>}
    >
      <List doubleHardline>
        <cs.Constructor
          internal
          parameters={props.members.map((m) => ({
            name: m.param,
            type: m.nullable ? code`${m.type}?` : m.type,
          }))}
        >
          <For each={props.members} semicolon hardline enderPunctuation>
            {(m) => code`${m.prop} = ${m.param}`}
          </For>
        </cs.Constructor>
        <For each={props.members} doubleHardline>
          {(m) => <cs.Property public name={m.prop} type={m.type} nullable={m.nullable} get />}
        </For>
      </List>
    </cs.ClassDeclaration>
  );
}

interface StaticReadonlyFieldProps {
  name: string;
  type: Children;
  refkey: Refkey;
  initializer: Children;
}

function StaticReadonlyField(props: StaticReadonlyFieldProps): Children {
  const symbol = cs.createFieldSymbol(props.name, {
    accessibility: "private",
    isStatic: true,
    isReadOnly: true,
    refkeys: props.refkey,
  });
  return (
    <Declaration symbol={symbol}>
      {code`private static readonly ${props.type} ${<Name />} = ${props.initializer};`}
    </Declaration>
  );
}

interface TransformTargetExpressionProps {
  target?: PointTransformTarget;
  typeRef: Refkey;
}

function TransformTargetExpression(props: TransformTargetExpressionProps): Children {
  return memo(() => {
    if (!props.target) return "null";
    const path = (
      <For each={props.target.path} comma space>
        {(segment) => JSON.stringify(segment)}
      </For>
    );
    return code`new ${props.typeRef}(${JSON.stringify(props.target.member)}, [${path}])`;
  });
}

interface InterceptionPointsClassProps {
  pointEnum: Enum;
  entries: readonly PointMetadataEntry[];
}

function InterceptionPointsClass(props: InterceptionPointsClassProps): Children {
  const outMetadataParam = (): cs.ParameterProps => ({
    name: "metadata",
    type: code`${metadataTypeKey(props.pointEnum)}?`,
    out: true,
    attributes: [<cs.Attribute name="NotNullWhen" args={["true"]} />],
  });

  return (
    <cs.ClassDeclaration
      public
      static
      name={POINT_METADATA_NAMES.lookup}
      refkey={lookupTypeKey(props.pointEnum)}
      doc={<cs.DocSummary>Metadata lookup for every InterceptionPoint declared in the specification.</cs.DocSummary>}
    >
      <List doubleHardline>
        <For each={props.entries} doubleHardline>
          {(entry) => (
            <StaticReadonlyField
              name={entry.member.name}
              type={metadataTypeKey(props.pointEnum)}
              refkey={fieldKey(entry.member)}
              initializer={code`
                new(
                    ${ef.efRefkey(entry.member)},
                    ${JSON.stringify(entry.wireName)},
                    ${JSON.stringify(entry.requestModel.name)},
                    ${JSON.stringify(entry.responseModel.name)},
                    typeof(${ef.efRefkey(entry.requestModel)}),
                    typeof(${ef.efRefkey(entry.responseModel)}),
                    ${<TransformTargetExpression target={entry.transformTarget} typeRef={transformTargetKey(props.pointEnum)} />}
                )
              `}
            />
          )}
        </For>
        <cs.Property
          public
          static
          name="All"
          type={code`ImmutableArray<${metadataTypeKey(props.pointEnum)}>`}
          get
          initializer={code`
            [
                ${<For each={props.entries} comma hardline enderPunctuation>
                  {(entry) => fieldKey(entry.member)}
                </For>}
            ]
          `}
        />
        <cs.Method
          public
          static
          name="Get"
          returns={metadataTypeKey(props.pointEnum)}
          parameters={[{ name: "point", type: ef.efRefkey(props.pointEnum) }]}
          expression
        >
          TryGet(point, out var metadata) ? metadata : throw new ArgumentOutOfRangeException(nameof(point), point, null)
        </cs.Method>
        <cs.Method
          public
          static
          name="TryGet"
          returns="bool"
          parameters={[{ name: "point", type: ef.efRefkey(props.pointEnum) }, outMetadataParam()]}
        >
          {code`
            metadata = point switch
            {
                ${<For each={props.entries} comma hardline enderPunctuation>
                  {(entry) => code`${ef.efRefkey(entry.member)} => ${fieldKey(entry.member)}`}
                </For>}
                _ => null,
            };
            return metadata is not null;
          `}
        </cs.Method>
        <cs.Method
          public
          static
          name="TryGetByWireName"
          returns="bool"
          parameters={[{ name: "wireName", type: "string?" }, outMetadataParam()]}
        >
          {code`
            metadata = wireName switch
            {
                ${<For each={props.entries} comma hardline enderPunctuation>
                  {(entry) => code`${JSON.stringify(entry.wireName)} => ${fieldKey(entry.member)}`}
                </For>}
                _ => null,
            };
            return metadata is not null;
          `}
        </cs.Method>
        <cs.Method
          public
          static
          name="TryParse"
          returns="bool"
          parameters={[
            { name: "wireName", type: "string?" },
            { name: "point", type: ef.efRefkey(props.pointEnum), out: true },
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
      </List>
    </cs.ClassDeclaration>
  );
}

export interface PointMetadataDeclarationsProps {
  info: InterceptionPointsInfo;
}

export function PointMetadataDeclarations(props: PointMetadataDeclarationsProps): Children {
  return (
    <List doubleHardline>
      <ImmutableModelClass
        name={POINT_METADATA_NAMES.transformTarget}
        refkey={transformTargetKey(props.info.pointEnum)}
        doc="The hook transform property name and the request JSON path it replaces."
        members={[
          { param: "member", prop: "Member", type: "string" },
          { param: "path", prop: "Path", type: "ImmutableArray<string>" },
        ]}
      />
      <ImmutableModelClass
        name={POINT_METADATA_NAMES.metadata}
        refkey={metadataTypeKey(props.info.pointEnum)}
        doc="Metadata describing an interception point's wire name, schemas, contract types, and transform target."
        members={[
          { param: "point", prop: "Point", type: ef.efRefkey(props.info.pointEnum) },
          { param: "wireName", prop: "WireName", type: "string" },
          { param: "requestSchema", prop: "RequestSchema", type: "string" },
          { param: "responseSchema", prop: "ResponseSchema", type: "string" },
          { param: "requestType", prop: "RequestType", type: "Type" },
          { param: "responseType", prop: "ResponseType", type: "Type" },
          { param: "transformTarget", prop: "TransformTarget", type: transformTargetKey(props.info.pointEnum), nullable: true },
        ]}
      />
      <InterceptionPointsClass pointEnum={props.info.pointEnum} entries={props.info.entries} />
    </List>
  );
}
