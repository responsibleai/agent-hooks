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
      <cs.ClassDeclaration
        public
        static
        name={extensionsName}
        doc={<cs.DocSummary>{code`Wire-format conversion helpers for <see cref="${props.name}" />.`}</cs.DocSummary>}
      >
        <List doubleHardline>
          <cs.Method
            public
            static
            name="ToWire"
            returns="string"
            parameters={[{ name: "value", type: code`this ${reference}` }]}
            doc={
              <List hardline>
                <cs.DocSummary>{code`Returns the specification wire string for <paramref name="value" />.`}</cs.DocSummary>
                <cs.DocParam name="value">The enum value to convert.</cs.DocParam>
                <cs.DocReturns>{code`The wire string representation of <paramref name="value" />.`}</cs.DocReturns>
                {code`<exception cref="ArgumentOutOfRangeException"><paramref name="value" /> is not a defined <see cref="${props.name}" /> value.</exception>`}
              </List>
            }
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
            doc={
              <List hardline>
                <cs.DocSummary>{code`Attempts to parse a wire string as <see cref="${props.name}" />.`}</cs.DocSummary>
                <cs.DocParam name="wire">The wire string to parse.</cs.DocParam>
                <cs.DocParam name="value">
                  {code`When this method returns <see langword="true" />, contains the parsed <see cref="${props.name}" /> value; otherwise, the default value.`}
                </cs.DocParam>
                <cs.DocReturns>
                  {code`<see langword="true" /> if <paramref name="wire" /> matched a defined value; otherwise, <see langword="false" />.`}
                </cs.DocReturns>
              </List>
            }
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
        doc={<cs.DocSummary>{code`JSON converter that serializes <see cref="${props.name}" /> values using their specification wire strings.`}</cs.DocSummary>}
      />
    </List>
  );
}
