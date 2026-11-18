// Copyright (c) Microsoft. All rights reserved.

import { createLibrary } from "@alloy-js/csharp";

/**
 * Hand-written support types in sdk/dotnet/src/AgentHooks.Contracts, declared
 * as an Alloy library so generated code references them like any other symbol.
 */
export const Contracts = createLibrary("AgentHooks.Contracts", {
  Optional: { kind: "struct", members: {} },
  BigIntegerJsonConverter: { kind: "class", members: {} },
  DiscriminatedUnionJsonConverter: { kind: "class", members: {} },
  OptionalJsonConverter: { kind: "class", members: {} },
  StrictJsonStringEnumConverter: { kind: "class", members: {} },
});
