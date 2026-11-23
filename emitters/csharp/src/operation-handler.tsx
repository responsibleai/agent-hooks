// Copyright (c) Microsoft. All rights reserved.

import { code, type Children } from "@alloy-js/core";
import * as cs from "@alloy-js/csharp";
import type { Operation } from "@typespec/compiler";
import { useTsp } from "@typespec/emitter-framework";
import { getDocComments, TypeExpression } from "@typespec/emitter-framework/csharp";

export function OperationHandler(props: { type: Operation; name: string }): Children {
  const { $ } = useTsp();
  const parameters: cs.ParameterProps[] = [...props.type.parameters.properties.values()].map((parameter) => ({
    name: parameter.name,
    type: <TypeExpression type={parameter.type} />,
    optional: parameter.optional,
  }));
  parameters.push({ name: "cancellationToken", type: "CancellationToken", default: "default" });

  return <cs.MethodScope name={props.name}>
    <cs.DocWhen doc={getDocComments($, props.type)} />
    {code`Task<${<TypeExpression type={props.type.returnType} />}> ${props.name}${<cs.Parameters parameters={parameters} />};`}
  </cs.MethodScope>;
}
