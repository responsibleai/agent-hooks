// Copyright (c) Microsoft. All rights reserved.

import { code, Declaration, For, List, Name, namekey, refkey, type Children } from "@alloy-js/core";
import * as cs from "@alloy-js/csharp";
import type { Model, Operation, Type } from "@typespec/compiler";
import * as ef from "@typespec/emitter-framework/csharp";
import { OperationHandler } from "./operation-handler.js";
import type { PointMetadataEntry } from "./point-metadata.js";

function unwrap(type: Type): Type {
  return type.kind === "ModelProperty" || type.kind === "UnionVariant" ? unwrap(type.type) : type;
}

/** `preToolCall` -> `IPreToolCallHook`: one optional interface per interception point. */
export function hookInterfaceName(
  operation: Operation,
  policy: ReturnType<typeof cs.createCSharpNamePolicy> = cs.createCSharpNamePolicy(),
): string {
  return `I${policy.getName(operation.name, "class")}Hook`;
}

/**
 * Split an interceptor into one single-method interface per point so hook
 * authors implement only the points they care about; the full interceptor
 * composes them.
 */
export function PointHookInterfaces(props: { name: string; operations: [Operation, string][] }): Children {
  const policy = cs.useCSharpNamePolicy();
  const hooks = props.operations.map(([operation, method]) => ({
    operation,
    method,
    name: hookInterfaceName(operation, policy),
    key: refkey(operation, "hook-interface"),
  }));
  // @alloy-js/csharp InterfaceDeclaration does not expose base interfaces yet,
  // so register the symbol directly and render the base interface list inline.
  const compositeSymbol = cs.createNamedTypeSymbol(props.name, "interface", {
    namePolicy: policy.for("interface"),
  });
  return (
    <List doubleHardline>
      <For each={hooks} doubleHardline>
        {(hook) => (
          <cs.InterfaceDeclaration public name={hook.name} refkey={hook.key}>
            <OperationHandler type={hook.operation} name={hook.method} />
          </cs.InterfaceDeclaration>
        )}
      </For>
      <Declaration symbol={compositeSymbol}>
        {code`public interface ${<Name />} : ${<For each={hooks} joiner=", ">{(hook) => hook.key}</For>};`}
      </Declaration>
    </List>
  );
}

type VerdictKind = "allow" | "deny" | "transform";

function verdictVariants(response: Model): [VerdictKind, Model][] {
  const verdict = unwrap(response.properties.get("verdict")!.type);
  if (verdict.kind !== "Union") throw new Error(`${response.name}.verdict must be a union.`);
  return [...verdict.variants.values()].map((variant) => {
    const model = unwrap(variant.type);
    const decision = model.kind === "Model" ? unwrap(model.properties.get("decision")?.type ?? model) : model;
    const value = decision.kind === "String" ? decision.value
      : decision.kind === "EnumMember" ? decision.value ?? decision.name : undefined;
    if (model.kind !== "Model" || (value !== "allow" && value !== "deny" && value !== "transform")) {
      throw new Error(`Unsupported verdict variant in ${response.name}; add a response factory for it.`);
    }
    return [value, model];
  });
}

function ResponseFactoryMethod(props: { response: Model; kind: VerdictKind; verdict: Model }): Children {
  const policy = cs.useCSharpNamePolicy();
  const self = <ef.TypeExpression type={props.response} />;
  const verdict = <ef.TypeExpression type={props.verdict} />;

  if (props.kind === "allow") {
    return (
      <cs.Method
        public
        static
        name="Allow"
        returns={self}
        expression
        doc={<cs.DocSummary>Creates a response that allows the action.</cs.DocSummary>}
      >
        {code`new() { Verdict = new ${verdict}() }`}
      </cs.Method>
    );
  }

  if (props.kind === "deny") {
    const reasonKey = refkey();
    const messageKey = refkey();
    return (
      <cs.Method
        public
        static
        name="Deny"
        returns={self}
        parameters={[
          { name: "reason", type: "string", refkey: reasonKey },
          { name: "message", type: "string", optional: true, default: "null", refkey: messageKey },
        ]}
        doc={
          <>
            <cs.DocSummary>Creates a response that denies the action.</cs.DocSummary>
            <cs.DocParam name="reason">Machine-readable reason identifier.</cs.DocParam>
            <cs.DocParam name="message">Optional human-readable text for the caller.</cs.DocParam>
          </>
        }
      >
        {code`
          ArgumentNullException.ThrowIfNull(${reasonKey});
          return new() { Verdict = new ${verdict} { Reason = ${reasonKey}, Message = ${messageKey} } };
        `}
      </cs.Method>
    );
  }

  const transform = unwrap(props.verdict.properties.get("transform")!.type) as Model;
  const [member] = transform.properties.values();
  const memberName = policy.getName(member.name, "class");
  const memberType = unwrap(member.type);
  const paramName = policy.getName(member.name, "parameter");
  const paramKey = refkey();
  const element = memberType.kind === "Intrinsic" && memberType.name === "unknown";
  return (
    <cs.Method
      public
      static
      name={`Transform${memberName}`}
      returns={self}
      parameters={[{ name: member.name, type: <ef.TypeExpression type={memberType} />, refkey: paramKey }]}
      expression={element}
      doc={
        <cs.DocSummary>
          Creates a response that proceeds with
          <br />
          <cs.DocParamRef name={paramName} />
          <br />
          {`replacing the whole ${member.name} target.`}
        </cs.DocSummary>
      }
    >
      {element
        ? code`new() { Verdict = new ${verdict} { Transform = new() { ${memberName} = ${paramKey}.Clone() } } }`
        : code`
            ArgumentNullException.ThrowIfNull(${paramKey});
            return new() { Verdict = new ${verdict} { Transform = new() { ${memberName} = ${paramKey} } } };
          `}
    </cs.Method>
  );
}

/** Static Allow/Deny/Transform{Member} factories on each point's generated response type. */
export function ResponseFactories(props: {
  entries: readonly PointMetadataEntry[];
  names: ReadonlyMap<Type, string>;
}): Children {
  const policy = cs.useCSharpNamePolicy();
  return (
    <For each={props.entries} doubleHardline>
      {(entry) => {
        const responseName = props.names.get(entry.responseModel) ?? policy.getName(entry.responseModel.name, "class");
        return (
          <cs.ClassDeclaration
            public
            sealed
            partial
            name={namekey(responseName, { ignoreNameConflict: true })}
          >
            <For each={verdictVariants(entry.responseModel)} doubleHardline>
              {([kind, verdict]) => (
                <ResponseFactoryMethod response={entry.responseModel} kind={kind} verdict={verdict} />
              )}
            </For>
          </cs.ClassDeclaration>
        );
      }}
    </For>
  );
}
