// Copyright (c) Microsoft. All rights reserved.

import { code, For, List, type Children } from "@alloy-js/core";
import * as cs from "@alloy-js/csharp";
import type { Enum } from "@typespec/compiler";
import * as ef from "@typespec/emitter-framework/csharp";
import { JsonConverterAttribute, JsonConverterDeclaration } from "./json-components.js";

export function enumExtensionsName(name: string): string {
  return `${name}Extensions`;
}

export function EnumContract(props: { type: Enum; name: string }): Children {
  const reference = <ef.TypeExpression type={props.type} />;
  const extensionsName = enumExtensionsName(props.name);
  const converterName = `${props.name}JsonConverter`;
  const policy = cs.useCSharpNamePolicy();
  const entries = [...props.type.members.values()].map((member) => ({
    member: code`${reference}.${policy.getName(member.name, "enum-member")}`,
    wire: JSON.stringify(member.value ?? member.name),
  }));

  return (
    <List doubleHardline>
      <ef.EnumDeclaration
        public
        type={props.type}
        attributes={[<JsonConverterAttribute name={converterName} />]}
      />
      <cs.ClassDeclaration public static name={extensionsName}>
        <List doubleHardline>
          <cs.Method
            public
            static
            name="ToWire"
            returns="string"
            parameters={[{ name: "value", type: code`this ${reference}` }]}
            expression
          >
            {code`
              value switch
              {
                  ${<For each={entries} comma hardline enderPunctuation>
                    {(entry) => code`${entry.member} => ${entry.wire}`}
                  </For>}
                  _ => throw new ArgumentOutOfRangeException(nameof(value), value, null),
              }
            `}
          </cs.Method>
          <cs.Method
            public
            static
            name="TryParseWire"
            returns="bool"
            parameters={[
              { name: "wire", type: "string?" },
              { name: "value", type: reference, out: true },
            ]}
          >
            {code`
              ${reference}? parsed = wire switch
              {
                  ${<For each={entries} comma hardline enderPunctuation>
                    {(entry) => code`${entry.wire} => ${entry.member}`}
                  </For>}
                  _ => null,
              };
              value = parsed ?? default;
              return parsed.HasValue;
            `}
          </cs.Method>
        </List>
      </cs.ClassDeclaration>
      <JsonConverterDeclaration
        name={converterName}
        baseType={code`StringEnumJsonConverter<${reference}>`}
        baseArguments={[`${extensionsName}.ToWire`, `${extensionsName}.TryParseWire`]}
      />
    </List>
  );
}
