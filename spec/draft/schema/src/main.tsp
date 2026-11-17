// Copyright (c) Microsoft. All rights reserved.

import "./common.tsp";
import "./interception-point.tsp";
import "./agent-context.tsp";
import "./verdict.tsp";
import "./hook-responses.tsp";
import "./approval.tsp";
import "./interception-record.tsp";
import "./host-declaration.tsp";

using TypeSpec.JsonSchema;

// The published schema documents. Each $id is relative to the base URI;
// cutting a version rewrites schema/draft/ to schema/vX.Y/.
@@baseUri(
  AgentHooks,
  "https://responsibleai.github.io/agent-hooks/schema/draft/"
);

@@jsonSchema(AgentHooks.InterceptionPoint, "interception-point.schema.json");
@@jsonSchema(AgentHooks.AgentContext, "agent-context.schema.json");
@@jsonSchema(
  AgentHooks.AgentStartupHookResponse,
  "agent-startup-hook-response.schema.json"
);
@@jsonSchema(AgentHooks.InputHookResponse, "input-hook-response.schema.json");
@@jsonSchema(
  AgentHooks.PreModelHookResponse,
  "pre-model-hook-response.schema.json"
);
@@jsonSchema(
  AgentHooks.PostModelHookResponse,
  "post-model-hook-response.schema.json"
);
@@jsonSchema(
  AgentHooks.PreToolHookResponse,
  "pre-tool-hook-response.schema.json"
);
@@jsonSchema(
  AgentHooks.PostToolHookResponse,
  "post-tool-hook-response.schema.json"
);
@@jsonSchema(AgentHooks.OutputHookResponse, "output-hook-response.schema.json");
@@jsonSchema(
  AgentHooks.AgentShutdownHookResponse,
  "agent-shutdown-hook-response.schema.json"
);
@@jsonSchema(AgentHooks.request, "approval-request.schema.json");
@@jsonSchema(AgentHooks.resolution, "approval-resolution.schema.json");
@@jsonSchema(AgentHooks.InterceptionRecord, "interception-record.schema.json");
@@jsonSchema(AgentHooks.HostDeclaration, "host-declaration.schema.json");
