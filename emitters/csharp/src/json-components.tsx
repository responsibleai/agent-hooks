// Copyright (c) Microsoft. All rights reserved.

import { code, For, type Children } from "@alloy-js/core";
import * as cs from "@alloy-js/csharp";

export function JsonConverterAttribute(props: { name: string }): Children {
  return <cs.Attribute name="JsonConverter" args={[`typeof(${props.name})`]} />;
}

export function JsonConverterDeclaration(props: {
  name: string;
  baseType: Children;
  baseArguments: Children[];
}): Children {
  return <cs.ClassDeclaration internal sealed name={props.name} baseType={props.baseType}>
    <cs.Constructor public baseConstructor={props.baseArguments} />
  </cs.ClassDeclaration>;
}

export function DictionaryInitializer(props: {
  keyType: Children;
  valueType: Children;
  entries: { key: Children; value: Children }[];
}): Children {
  return code`
    new Dictionary<${props.keyType}, ${props.valueType}>
    {
      ${<For each={props.entries} hardline>
        {(entry) => code`[${entry.key}] = ${entry.value},`}
      </For>}
    }
  `;
}
