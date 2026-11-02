// Copyright (c) Microsoft. All rights reserved.

// Validate the standalone JSON examples of every specification bundle
// against that bundle's own generated schemas.
//
//   node scripts/check-schema-examples.mjs [<bundle> ...]
//
// A bundle is spec/draft or spec/<MAJOR.MINOR.PATCH>; with no argument
// every bundle is checked. Each example sits at
// <bundle>/schema/examples/<Type>/<name>.json and is validated against the
// schema `schemaMapping` names for <Type>, using only the schemas under
// <bundle>/schema/generated (no fetching). Anything under examples/ that
// is not a regular file or a directory, such as a symbolic link, fails.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const specRoot = fileURLToPath(new URL("../../../spec/", import.meta.url));
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export const schemaMapping = {
  AgentContext: "agent-context.schema.json",
  Verdict: "verdict.schema.json",
  InterceptorResponse: "interceptor-response.schema.json#/$defs/ResponseEnvelope",
  ApprovalRequest: "approval.schema.json#/$defs/request",
  ApprovalResolution: "approval.schema.json#/$defs/resolution",
  HostDeclaration10: "host-declaration-1.0.schema.json",
  HostDeclaration11: "host-declaration-1.1.schema.json",
  InterceptionRecord: "interception-record.schema.json",
};

/** The schema folder of one bundle, "draft" or a MAJOR.MINOR.PATCH version. */
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
      throw new Error(`${filename}: not draft or a MAJOR.MINOR.PATCH version`);
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

export async function validateExamples(root = schemaRoot) {
  // Match schema-lint's Draft 2020-12 + ajv-formats behavior. The generated
  // schemas use union types and annotation keywords not covered by strict mode.
  // No loadSchema callback is supplied: missing refs fail, never fetch.
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const generated = path.join(root, "generated");
  const schemas = new Map();
  for (const filename of await jsonFiles(generated)) {
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
    if (parts.length !== 2 || !Object.hasOwn(schemaMapping, parts[0])) {
      throw new Error(`${filename}: no schema mapping for example`);
    }
    const instance = await readJson(filename);
    validate(instance, filename, schemaMapping[parts[0]]);
    if (parts[0] === "AgentContext") {
      validate(instance, filename, `strict-contexts/${instance.interception_point}.schema.json`);
    }
    if (parts[0] === "Verdict" || parts[0] === "InterceptorResponse") {
      validate(instance, filename, "interceptor-response.schema.json");
    }
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
  for (const name of selected) {
    const count = await validateExamples(bundleSchemaRoot(name));
    console.log(`check-schema-examples: validated ${count} JSON examples for ${name}`);
  }
}
