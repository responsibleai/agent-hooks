// Copyright (c) Microsoft. All rights reserved.

import "../dist/index.js";

namespace AgentHooks.Docs;

/** Reference sections, in their presentation order. */
enum Categories {
  Common: "Common types",
  Requests: "Hook requests",
  Responses: "Hook responses",
  Verdicts: "Verdicts",
  Approval: "Approval seam",
  Records: "Interception records",
  Declaration: "Host declaration",
}

/** Include a declaration in the reference under the selected section. */
auto dec category(
  target:
    | TypeSpec.Reflection.Model
    | TypeSpec.Reflection.Enum
    | TypeSpec.Reflection.Union
    | TypeSpec.Reflection.Scalar,
  value: Categories
);
