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

@@jsonSchema(AgentHooks.InterceptionPoint);
@@jsonSchema(AgentHooks.AgentContext);
@@jsonSchema(AgentHooks.AgentStartupHookResponse);
@@jsonSchema(AgentHooks.InputHookResponse);
@@jsonSchema(AgentHooks.PreModelHookResponse);
@@jsonSchema(AgentHooks.PostModelHookResponse);
@@jsonSchema(AgentHooks.PreToolHookResponse);
@@jsonSchema(AgentHooks.PostToolHookResponse);
@@jsonSchema(AgentHooks.OutputHookResponse);
@@jsonSchema(AgentHooks.AgentShutdownHookResponse);
@@jsonSchema(AgentHooks.request);
@@jsonSchema(AgentHooks.resolution);
@@jsonSchema(AgentHooks.Outcome);
@@jsonSchema(AgentHooks.LiftableDeny);
@@jsonSchema(AgentHooks.ApproveResolution);
@@jsonSchema(AgentHooks.RejectResolution);
@@jsonSchema(AgentHooks.UnresolvedResolution);
@@jsonSchema(AgentHooks.InterceptionRecord);
@@jsonSchema(AgentHooks.HostDeclaration);
