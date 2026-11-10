// Copyright (c) Microsoft. All rights reserved.

// Validate the standalone JSON examples of every specification bundle
// against that bundle's own generated schemas.
//
//   node scripts/check-schema-examples.mjs [<bundle> ...]
//
// A bundle is spec/draft or spec/<MAJOR.MINOR>; with no argument every
// bundle is checked. Each example sits at
// <bundle>/schema/examples/<Type>/<name>.json and is validated against the
// schema `schemaMapping` names for <Type>, using only the bundle's own
// schemas (under schema/generated/ when that folder exists, else flat
// under schema/; no fetching). A bundle without an examples/ folder is
// skipped and said so; 0.1 predates the examples. Anything under
// examples/ that is not a regular file or a directory, such as a
// symbolic link, fails.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const specRoot = fileURLToPath(new URL("../../../spec/", import.meta.url));
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export const schemaMapping = {
  AgentContext: "agent-context.schema.json",
  // The generic verdict root is retained only in the released 0.1 bundle.
  Verdict: "verdict.schema.json",
  InterceptorResponse: "interceptor-response.schema.json#/$defs/ResponseEnvelope",
  ApprovalRequest: "approval.schema.json#/$defs/request",
  ApprovalResolution: "approval.schema.json#/$defs/resolution",
  HostDeclaration10: "host-declaration-1.0.schema.json",
  HostDeclaration11: "host-declaration-1.1.schema.json",
  HostDeclaration: "host-declaration.schema.json",
  InterceptionRecord: "interception-record.schema.json",
  AgentStartupHookResponse: "agent-startup-hook-response.schema.json",
  InputHookResponse: "input-hook-response.schema.json",
  PreModelHookResponse: "pre-model-hook-response.schema.json",
  PostModelHookResponse: "post-model-hook-response.schema.json",
  PreToolHookResponse: "pre-tool-hook-response.schema.json",
  PostToolHookResponse: "post-tool-hook-response.schema.json",
  OutputHookResponse: "output-hook-response.schema.json",
  AgentShutdownHookResponse: "agent-shutdown-hook-response.schema.json",
};
const hookResponseSchemas = [
  "agent-startup-hook-response.schema.json",
  "input-hook-response.schema.json",
  "pre-model-hook-response.schema.json",
  "post-model-hook-response.schema.json",
  "pre-tool-hook-response.schema.json",
  "post-tool-hook-response.schema.json",
  "output-hook-response.schema.json",
  "agent-shutdown-hook-response.schema.json",
];
const transformHookResponseSchema = {
  input: "input-hook-response.schema.json",
  messages: "pre-model-hook-response.schema.json",
  response: "post-model-hook-response.schema.json",
  args: "pre-tool-hook-response.schema.json",
  value: "post-tool-hook-response.schema.json",
  output: "output-hook-response.schema.json",
};

/** The schema folder of one bundle, "draft" or a MAJOR.MINOR version. */
export function bundleSchemaRoot(name) {
  return path.join(specRoot, name, "schema") + path.sep;
}

/** The draft bundle's schema folder, where new examples are written first. */
export const schemaRoot = bundleSchemaRoot("draft");

/** Every bundle name under spec/, sorted. Anything else under spec/ that is
 *  a directory or a symbolic link is an error: the folder holds bundles only. */
export async function bundles(root = specRoot) {
  const names = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${filename}: symbolic links are not allowed under spec/`);
    }
    if (!entry.isDirectory()) continue;
    if (entry.name !== "draft" && !VERSION.test(entry.name)) {
      throw new Error(`${filename}: not draft or a MAJOR.MINOR version`);
    }
    names.push(entry.name);
  }
  return names.sort();
}

async function jsonFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await jsonFiles(filename));
    else if (!entry.isFile()) throw new Error(`${filename}: not a regular file or directory`);
    else if (entry.name.endsWith(".json")) files.push(filename);
  }
  return files.sort();
}

async function readJson(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    throw new Error(`${filename}: ${error.message}`, { cause: error });
  }
}

/** Whether a bundle's schema folder carries standalone examples. */
export async function hasExamples(root) {
  try {
    return (await stat(path.join(root, "examples"))).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** Where a bundle keeps its schemas: schema/generated/ when present, else schema/. */
export async function schemaDirectory(root) {
  const generated = path.join(root, "generated");
  try {
    if ((await stat(generated)).isDirectory()) return generated;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return root;
}

export async function validateExamples(root = schemaRoot) {
  // Match schema-lint's Draft 2020-12 + ajv-formats behavior. The generated
  // schemas use union types and annotation keywords not covered by strict mode.
  // No loadSchema callback is supplied: missing refs fail, never fetch.
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const generated = await schemaDirectory(root);
  const schemas = new Map();
  for (const filename of await jsonFiles(generated)) {
    if (!filename.endsWith(".schema.json")) continue;
    const schema = await readJson(filename);
    if (!ajv.validateSchema(schema)) {
      throw new Error(`${filename}: invalid schema: ${ajv.errorsText()}`);
    }
    if (typeof schema.$id !== "string") {
      throw new Error(`${filename}: schema is missing $id`);
    }
    ajv.addSchema(schema);
    schemas.set(path.relative(generated, filename).split(path.sep).join("/"), schema);
  }
  function validate(instance, filename, reference) {
    const [schemaFile, fragment] = reference.split("#");
    const schema = schemas.get(schemaFile);
    if (!schema) throw new Error(`${filename}: missing local schema ${schemaFile}`);
    const ref = schema.$id + (fragment === undefined ? "" : `#${fragment}`);
    const validator = ajv.getSchema(ref);
    if (!validator) throw new Error(`${filename}: unresolved schema ${ref}`);
    if (!validator(instance)) {
      throw new Error(`${filename}: ${reference}: ${ajv.errorsText(validator.errors)}`);
    }
  }
  const examples = path.join(root, "examples");
  const files = await jsonFiles(examples);
  if (files.length === 0) throw new Error(`${examples}: no JSON examples found`);
  for (const filename of files) {
    const parts = path.relative(examples, filename).split(path.sep);
    if (parts.length !== 2) {
      throw new Error(`${filename}: no schema mapping for example`);
    }
    const instance = await readJson(filename);
    let references;
    if (parts[0] === "Verdict" && !schemas.has("verdict.schema.json")) {
      if (instance.decision === "transform") {
        const transformMembers = Object.keys(instance.transform ?? {});
        if (transformMembers.length !== 1 || !transformHookResponseSchema[transformMembers[0]]) {
          throw new Error(`${filename}: no hook response schema for transform payload`);
        }
        references = [transformHookResponseSchema[transformMembers[0]]];
      } else {
        references = hookResponseSchemas;
      }
    } else {
      const reference = schemaMapping[parts[0]];
      if (!reference) throw new Error(`${filename}: no schema mapping for example`);
      references = [reference];
    }
    const responseInstance = parts[0] === "Verdict" && !schemas.has("verdict.schema.json")
      ? { verdict: instance }
      : instance;
    for (const reference of references) validate(responseInstance, filename, reference);
    if (parts[0] === "AgentContext") {
      // The per-point folder is strict-contexts/ in the generated layout
      // and agent-context/ in the flat one.
      const point = `${instance.interception_point}.schema.json`;
      const folder = schemas.has(`strict-contexts/${point}`) ? "strict-contexts" : "agent-context";
      validate(instance, filename, `${folder}/${point}`);
    }
  }
  function assertSchemaProbe(schemaFile, instance, expected, label, definition) {
    const schema = schemas.get(schemaFile);
    if (!schema) throw new Error(`missing local schema ${schemaFile}`);
    const schemaId = schema.$id + (definition ? `#/$defs/${definition}` : "");
    const validator = ajv.getSchema(schemaId);
    if (!validator) throw new Error(`unresolved schema ${schemaId}`);
    const valid = validator(instance);
    if (valid !== expected) {
      throw new Error(
        `${schemaFile}: ${label} should ${expected ? "validate" : "be rejected"}: ${ajv.errorsText(validator.errors)}`,
      );
    }
  }
  const hasHookResponseSchemas = hookResponseSchemas.every((schemaFile) => schemas.has(schemaFile));
  if (hasHookResponseSchemas) {
    const hookPayloads = {
      agent_startup: ["agent_init"],
      input: ["input"],
      pre_model_call: ["model", "messages", "tools", "request_id"],
      post_model_call: ["model", "response", "request_id", "usage"],
      pre_tool_call: ["tool_call"],
      post_tool_call: ["tool_call", "tool_result"],
      output: ["output"],
      agent_shutdown: ["summary"],
    };
    const commonFields = [
      "spec",
      "timestamp",
      "sequence",
      "agent",
      "session",
      "trace",
      "tenant",
      "actor",
      "budgets",
      "extensions",
    ];
    for (const [point, payloadFields] of Object.entries(hookPayloads)) {
      const schema = schemas.get(`strict-contexts/${point}.schema.json`);
      if (!schema) throw new Error(`missing strict context schema for ${point}`);
      for (const field of commonFields) {
        if (!Object.hasOwn(schema.properties ?? {}, field)) {
          throw new Error(`strict-contexts/${point}.schema.json: expected common field ${field}`);
        }
      }
      for (const field of [
        "agent_init",
        "input",
        "model",
        "messages",
        "response",
        "request_id",
        "usage",
        "tool_call",
        "tool_result",
        "tools",
        "output",
        "summary",
      ]) {
        const shouldExist = payloadFields.includes(field);
        const exists = Object.hasOwn(schema.properties ?? {}, field);
        if (exists !== shouldExist) {
          throw new Error(
            `strict-contexts/${point}.schema.json: ${field} should ${shouldExist ? "be present" : "be absent"} from this hook's properties`,
          );
        }
      }
    }
    for (const schemaFile of hookResponseSchemas) {
      assertSchemaProbe(schemaFile, { decision: "allow" }, false, "bare allow");
      assertSchemaProbe(schemaFile, { verdict: { decision: "allow" } }, true, "enveloped allow");
      assertSchemaProbe(
        schemaFile,
        { decision: "allow", extensions: { policy: { receipt: "r" } } },
        false,
        "flat allow with extensions",
      );
      assertSchemaProbe(
        schemaFile,
        { verdict: { decision: "allow" }, extensions: { policy: { receipt: "r" } } },
        true,
        "enveloped allow with extensions",
      );
      assertSchemaProbe(
        schemaFile,
        { verdict: { decision: "allow" }, extra: true },
        false,
        "unknown envelope member",
      );
      assertSchemaProbe(
        schemaFile,
        { verdict: { decision: "allow" }, extensions: { "Bad-Key": true } },
        false,
        "invalid extensions namespace",
      );
      assertSchemaProbe(
        schemaFile,
        { verdict: { decision: "allow", unrecognized: true } },
        false,
        "closed verdict",
      );
      for (const instance of [
        {},
        { extensions: {} },
        { verdict: null },
        { verdict: { decision: "invalid" } },
        { verdict: { verdict: { decision: "allow" } } },
        { verdict: { decision: "allow", extensions: { policy: {} } } },
        { verdict: { decision: "allow" }, decision: "deny" },
        { verdict: { decision: "allow" }, extensions: null },
        { verdict: { decision: "allow" }, extensions: [] },
        { verdict: { decision: "allow" }, extensions: "invalid" },
      ]) {
        assertSchemaProbe(schemaFile, instance, false, "invalid response envelope");
      }
    }
    const transformCases = [
      ["input-hook-response.schema.json", { input: { content: "x", role: "user" } }],
      ["pre-model-hook-response.schema.json", { messages: [{ role: "user", content: "x" }] }],
      ["post-model-hook-response.schema.json", { response: { content: "x", tool_calls: [], finish_reason: "stop" } }],
      ["pre-tool-hook-response.schema.json", { args: {} }],
      ["post-tool-hook-response.schema.json", { value: null }],
      ["output-hook-response.schema.json", { output: { content: "x" } }],
    ];
    for (const [schemaFile, transform] of transformCases) {
      assertSchemaProbe(
        schemaFile,
        { verdict: { decision: "transform", transform } },
        true,
        "hook transform",
      );
      assertSchemaProbe(
        schemaFile,
        { verdict: { decision: "transform", transform: { ...transform, unexpected: true } } },
        false,
        "closed transform wrapper",
      );
      for (const otherSchemaFile of hookResponseSchemas.filter((file) => file !== schemaFile)) {
        assertSchemaProbe(
          otherSchemaFile,
          { verdict: { decision: "transform", transform } },
          false,
          "wrong-hook transform",
        );
      }
    }
    assertSchemaProbe(
      "pre-tool-hook-response.schema.json",
      { verdict: { decision: "transform", transform: { args: { limit: 20 } } }, extensions: { policy: {} } },
      true,
      "pre-tool transform",
    );
    assertSchemaProbe(
      "pre-tool-hook-response.schema.json",
      { verdict: { decision: "transform", transform: { args: {}, value: "unexpected" } } },
      false,
      "pre-tool transform rejects post-tool payload",
    );
    const inputRequest = {
      spec: "agent-hooks/draft",
      timestamp: "2026-01-01T00:00:00Z",
      sequence: 0,
      agent: { id: "a", framework: "test" },
      session: { id: "s" },
      interception_point: "input",
      input: { content: "x", role: "user" },
    };
    assertSchemaProbe(
      "input-hook-response.schema.json",
      {
        verdict: {
          decision: "transform",
          transform: { input: { content: "x", role: "user", extra: true } },
        },
      },
      true,
      "nested replacement remains open at response gate",
    );
    assertSchemaProbe(
      "strict-contexts/input.schema.json",
      inputRequest,
      true,
      "valid input replacement candidate",
    );
    assertSchemaProbe(
      "strict-contexts/input.schema.json",
      { ...inputRequest, input: { content: "x", role: "user", extra: true } },
      false,
      "strict request rejects nested replacement member",
    );
    assertSchemaProbe(
      "input-hook-response.schema.json",
      { verdict: { decision: "deny", approval: {} }, extensions: { policy: {} } },
      true,
      "deny with response metadata",
    );
    assertSchemaProbe(
      "input-hook-response.schema.json",
      { verdict: { decision: "transform", transform: { args: { limit: 20 } } } },
      false,
      "wrong-hook pre-tool transform",
    );
    for (const schemaFile of [
      "agent-startup-hook-response.schema.json",
      "agent-shutdown-hook-response.schema.json",
    ]) {
      assertSchemaProbe(
        schemaFile,
        { verdict: { decision: "transform", transform: { args: { limit: 20 } } } },
        false,
        "lifecycle transform",
      );
    }
    assertSchemaProbe(
      "approval.schema.json",
      { context_identity: null, outcome: "approve", verdict: { decision: "allow" } },
      true,
      "approval allows an allow verdict",
      "resolution",
    );
    assertSchemaProbe(
      "approval.schema.json",
      {
        context_identity: null,
        outcome: "approve",
        verdict: { decision: "transform", transform: { args: {} } },
      },
      false,
      "approval cannot lift a deny with transform",
      "resolution",
    );
    const record = {
      interception_point: "pre_tool_call",
      mode: "enforce",
      verdict: { decision: "transform" },
      input_identity: null,
      enforced_identity: null,
      identity_provider: null,
      session_id: "s",
      sequence: 0,
      composition: { profile: "sequential/first_deny" },
      interceptors_registered: 1,
    };
    assertSchemaProbe(
      "interception-record.schema.json",
      record,
      true,
      "record keeps transform decision only",
    );
    assertSchemaProbe(
      "interception-record.schema.json",
      { ...record, verdict: { decision: "transform", transform: { path: "$target" } } },
      false,
      "record omits transform details",
    );
    const request = {
      spec: "agent-hooks/draft",
      timestamp: "2026-01-01T00:00:00Z",
      sequence: 0,
      agent: { id: "a", framework: "test" },
      session: { id: "s" },
      interception_point: "pre_tool_call",
      tool_call: { id: "c", name: "tool", args: {} },
    };
    assertSchemaProbe(
      "agent-context.schema.json",
      { ...request, extensions: { policy: { receipt: "r" } } },
      true,
      "request extensions",
    );
    assertSchemaProbe(
      "agent-context.schema.json",
      { ...request, extensions: { "Bad-Key": true } },
      false,
      "invalid request extensions namespace",
    );
    assertSchemaProbe(
      "agent-context.schema.json",
      { ...request, harness_metadata: { private: true } },
      true,
      "open request root",
    );
  }
  return files.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const known = await bundles();
  const selected = process.argv.length > 2 ? process.argv.slice(2) : known;
  for (const name of selected) {
    if (!known.includes(name)) {
      throw new Error(`Usage: node check-schema-examples.mjs [${known.join("|")}]...`);
    }
  }
  let checked = 0;
  for (const name of selected) {
    const root = bundleSchemaRoot(name);
    if (!(await hasExamples(root))) {
      console.log(`check-schema-examples: skipping ${name}, it has no schema/examples/ folder`);
      continue;
    }
    const count = await validateExamples(root);
    checked++;
    console.log(`check-schema-examples: validated ${count} JSON examples for ${name}`);
  }
  if (checked === 0) throw new Error("no bundle with a schema/examples/ folder was checked");
}
