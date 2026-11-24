// Copyright (c) Microsoft. All rights reserved.

import { code, For, refkey, type Children } from "@alloy-js/core";
import * as cs from "@alloy-js/csharp";
import type { Model, Operation, Type } from "@typespec/compiler";
import * as ef from "@typespec/emitter-framework/csharp";
import { OperationHandler } from "./operation-handler.js";
import type { PointMetadataEntry } from "./point-metadata.js";

function unwrap(type: Type): Type {
  return type.kind === "ModelProperty" || type.kind === "UnionVariant" ? unwrap(type.type) : type;
}

/** `preToolCall` -> `IPreToolCallHook`: one optional interface per interception point. */
export function hookInterfaceName(operation: Operation): string {
  return `I${cs.createCSharpNamePolicy().getName(operation.name, "class")}Hook`;
}

/**
 * Split an interceptor into one single-method interface per point so hook
 * authors implement only the points they care about; the full interceptor
 * composes them.
 */
export function PointHookInterfaces(props: { name: string; operations: [Operation, string][] }): Children {
  const hooks = props.operations.map(([operation, method]) => ({
    operation, method, name: hookInterfaceName(operation), key: refkey(operation, "hook-interface"),
  }));
  return <>
    <For each={hooks} doubleHardline>
      {(hook) => <cs.InterfaceDeclaration public name={hook.name} refkey={hook.key}>
        <OperationHandler type={hook.operation} name={hook.method} />
      </cs.InterfaceDeclaration>}
    </For>
    <hbr /><hbr />
    {code`public interface ${props.name} : ${<For each={hooks} joiner=", ">{(hook) => hook.key}</For>};`}
  </>;
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

/** Static Allow/Deny/Transform{Member} factories on each point's generated response type. */
export function ResponseFactories(props: { entries: readonly PointMetadataEntry[] }): Children {
  const policy = cs.createCSharpNamePolicy();
  return <For each={props.entries} doubleHardline>
    {(entry) => {
      const self = <ef.TypeExpression type={entry.responseModel} />;
      const methods = verdictVariants(entry.responseModel).map(([kind, model]) => {
        const verdict = <ef.TypeExpression type={model} />;
        if (kind === "allow") {
          return code`
            /// <summary>Creates a response that allows the action.</summary>
            public static ${self} Allow() => new() { Verdict = new ${verdict}() };
          `;
        }
        if (kind === "deny") {
          return code`
            /// <summary>Creates a response that denies the action.</summary>
            /// <param name="reason">Machine-readable reason identifier.</param>
            /// <param name="message">Optional human-readable text for the caller.</param>
            public static ${self} Deny(string reason, string? message = null)
            {
                ArgumentNullException.ThrowIfNull(reason);
                return new() { Verdict = new ${verdict} { Reason = reason, Message = message } };
            }
          `;
        }
        const transform = unwrap(model.properties.get("transform")!.type) as Model;
        const [member] = transform.properties.values();
        const memberName = policy.getName(member.name, "class");
        const memberType = unwrap(member.type);
        const parameter = policy.getName(member.name, "parameter");
        const element = memberType.kind === "Intrinsic" && memberType.name === "unknown";
        const signature = code`public static ${self} Transform${memberName}(${<ef.TypeExpression type={memberType} />} ${parameter})`;
        const doc = `/// <summary>Creates a response that proceeds with <paramref name="${parameter}"/> replacing the whole ${member.name} target.</summary>`;
        if (element) {
          return code`
            ${doc}
            ${signature} =>
                new() { Verdict = new ${verdict} { Transform = new() { ${memberName} = ${parameter}.Clone() } } };
          `;
        }
        return code`
          ${doc}
          ${signature}
          {
              ArgumentNullException.ThrowIfNull(${parameter});
              return new() { Verdict = new ${verdict} { Transform = new() { ${memberName} = ${parameter} } } };
          }
        `;
      });
      return code`
        public sealed partial class ${self}
        {
            ${<For each={methods} doubleHardline>{(method) => method}</For>}
        }
      `;
    }}
  </For>;
}
