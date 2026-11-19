// Copyright (c) Microsoft. All rights reserved.

import {
  getNamespaceFullName,
  type DecoratorApplication,
} from "@typespec/compiler";

export function isCategoryDecorator({
  definition,
}: DecoratorApplication): boolean {
  return (
    definition?.name === "@category" &&
    getNamespaceFullName(definition.namespace) === "AgentHooks.Docs"
  );
}

export function isSummaryDecorator({
  definition,
}: DecoratorApplication): boolean {
  return (
    definition?.name === "@summary" &&
    getNamespaceFullName(definition.namespace) === "TypeSpec"
  );
}
