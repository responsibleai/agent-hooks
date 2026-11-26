// Copyright (c) Microsoft. All rights reserved.

import { code, List, type Children } from "@alloy-js/core";
import * as cs from "@alloy-js/csharp";
import { getReturnsDoc, type Operation } from "@typespec/compiler";
import { useTsp } from "@typespec/emitter-framework";
import { TypeExpression } from "@typespec/emitter-framework/csharp";

function escapeXmlDoc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function OperationHandler(props: { type: Operation; name: string }): Children {
  const { $ } = useTsp();
  const opParams = [...props.type.parameters.properties.values()];
  const parameters: cs.ParameterProps[] = opParams.map((parameter) => ({
    name: parameter.name,
    type: <TypeExpression type={parameter.type} />,
    optional: parameter.optional,
  }));
  parameters.push({ name: "cancellationToken", type: "CancellationToken", default: "default" });

  const docElements: Children[] = [];
  const opDoc = $.type.getDoc(props.type);
  if (opDoc) {
    docElements.push(<cs.DocSummary><cs.DocFromMarkdown markdown={escapeXmlDoc(opDoc)} /></cs.DocSummary>);
  }
  for (const parameter of opParams) {
    const paramDoc = $.type.getDoc(parameter);
    const fallback = parameter.type.kind === "Model" && parameter.type.name === "ApprovalRequest"
      ? "The approval request describing the liftable deny and presented context."
      : "The candidate request for this interception point.";
    docElements.push(
      <cs.DocParam name={parameter.name}>
        {paramDoc ? <cs.DocFromMarkdown markdown={escapeXmlDoc(paramDoc)} /> : fallback}
      </cs.DocParam>,
    );
  }
  docElements.push(
    <cs.DocParam name="cancellationToken">A token that signals the operation should be canceled.</cs.DocParam>,
  );
  const returnsDoc = getReturnsDoc($.program, props.type);
  const returnTypeName = "name" in props.type.returnType && typeof props.type.returnType.name === "string" && props.type.returnType.name
    ? cs.createCSharpNamePolicy().getName(props.type.returnType.name, "class")
    : undefined;
  docElements.push(
    <cs.DocReturns>
      {returnsDoc
        ? <cs.DocFromMarkdown markdown={escapeXmlDoc(returnsDoc)} />
        : returnTypeName
          ? code`A task that resolves to the <see cref="${returnTypeName}" />.`
          : "A task that resolves to the operation response."}
    </cs.DocReturns>,
  );

  return <cs.MethodScope name={props.name}>
    <cs.DocWhen doc={<List hardline>{docElements}</List>} />
    {code`Task<${<TypeExpression type={props.type.returnType} />}> ${props.name}${<cs.Parameters parameters={parameters} />};`}
  </cs.MethodScope>;
}
