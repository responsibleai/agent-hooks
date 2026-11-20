// Copyright (c) Microsoft. All rights reserved.

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { AgentContext, InterceptionPoint, JsonValue } from "./generated/types";
import type { HookResponse, LegacyInterceptorResponse, LegacyTransform, Transform } from "./index";
import { AgentHooksCoreError } from "./native";
import context from "./generated/schemas/agent-context.schema.json";
import startup from "./generated/schemas/agent-startup-hook-response.schema.json";
import input from "./generated/schemas/input-hook-response.schema.json";
import preModel from "./generated/schemas/pre-model-hook-response.schema.json";
import postModel from "./generated/schemas/post-model-hook-response.schema.json";
import preTool from "./generated/schemas/pre-tool-hook-response.schema.json";
import postTool from "./generated/schemas/post-tool-hook-response.schema.json";
import output from "./generated/schemas/output-hook-response.schema.json";
import shutdown from "./generated/schemas/agent-shutdown-hook-response.schema.json";
import approval from "./generated/schemas/approval.schema.json";

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const contextValidator = ajv.compile<AgentContext>(context);
const responseValidators = Object.fromEntries(
  Object.entries({
    agent_startup: startup, input, pre_model_call: preModel, post_model_call: postModel,
    pre_tool_call: preTool, post_tool_call: postTool, output, agent_shutdown: shutdown,
  }).map(([point, schema]) => [point, ajv.compile<HookResponse>(schema)]),
) as Record<InterceptionPoint, ValidateFunction<HookResponse>>;
ajv.addSchema(approval);
const resolutionValidator = ajv.compile({
  $ref: `${approval.$id}#/$defs/resolution`,
});

function assertValid<T>(
  validate: ValidateFunction<T>,
  value: unknown,
  code: string,
): asserts value is T {
  if (!validate(value)) {
    const error = validate.errors?.[0];
    throw new AgentHooksCoreError(code, `${error?.instancePath || "/"}: violates draft ${error?.keyword ?? "schema"} constraint`);
  }
}

export function validateDraftContext(value: unknown): asserts value is AgentContext {
  assertValid(contextValidator, value, "host_error:context_invalid");
}

export function validateDraftResolution(value: unknown): void {
  assertValid(resolutionValidator, value, "host_error:verdict_invalid");
}

export function validateDraftResponse(value: unknown, point: InterceptionPoint): asserts value is HookResponse {
  const validate = responseValidators[point];
  if (!validate) throw new AgentHooksCoreError("host_error:context_invalid", "Unknown interception point");
  assertValid(validate, value, "host_error:verdict_invalid");
}

/** The native fold still accepts its version-independent path/value representation. */
export function draftTransform(transform: Transform): LegacyTransform {
  if ("input" in transform) return { path: "$target", value: { ...transform.input } };
  if ("messages" in transform) return { path: "$target", value: transform.messages.map((message) => ({ ...message })) };
  if ("response" in transform) return {
    path: "$target",
    value: { ...transform.response, tool_calls: transform.response.tool_calls.map((call) => ({ ...call })) },
  };
  if ("args" in transform) return { path: "$target", value: transform.args };
  if ("value" in transform) return { path: "$target", value: transform.value };
  return { path: "$target", value: { ...transform.output } };
}

export function draftResponse(value: unknown, point: InterceptionPoint): LegacyInterceptorResponse {
  validateDraftResponse(value, point);
  const verdict = value.verdict;
  if (verdict.decision !== "transform") return { ...value, verdict };
  return {
    ...value,
    verdict: {
      ...verdict,
      transform: draftTransform(verdict.transform),
    },
  };
}

const transformKeys = {
  input: "input", pre_model_call: "messages", post_model_call: "response",
  pre_tool_call: "args", post_tool_call: "value", output: "output",
} as const;

export function restoreDraftResponse(value: LegacyInterceptorResponse, point: InterceptionPoint): HookResponse {
  const { transform, decision, ...metadata } = value.verdict;
  const key = point in transformKeys ? transformKeys[point as keyof typeof transformKeys] : undefined;
  const shape = {
    verdict: {
      decision,
      ...(transform && key ? { transform: { [key]: transform.value ?? null } } : {}),
    },
  };
  validateDraftResponse(shape, point);
  return { ...value, verdict: { ...shape.verdict, ...metadata } };
}

export function draftContextWithTarget(ctx: AgentContext) {
  let target: JsonValue;
  switch (ctx.interception_point) {
    case "agent_startup": target = { ...ctx.agent_init }; break;
    case "input": target = { ...ctx.input }; break;
    case "pre_model_call": target = ctx.messages.map((message) => ({ ...message })); break;
    case "post_model_call": target = {
      ...ctx.response, tool_calls: ctx.response.tool_calls.map((call) => ({ ...call })),
    }; break;
    case "pre_tool_call": target = ctx.tool_call.args; break;
    case "post_tool_call": target = ctx.tool_result.value; break;
    case "output": target = { ...ctx.output }; break;
    case "agent_shutdown": target = { ...ctx.summary }; break;
  }
  return { ...ctx, target };
}

export function withoutTarget<T extends object>(value: T): Omit<T, "target"> {
  const { target, ...context } = value as T & { target?: unknown };
  return context;
}
