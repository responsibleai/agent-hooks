#!/usr/bin/env tsx
// Copyright (c) Microsoft. All rights reserved.

// Write the JSON Schemas under spec/<version>/schema/generated/ from the
// TypeScript source in spec/<version>/schema/src/, or check that the committed
// files match. <version> is draft unless --spec <version> names another folder;
// released folders are immutable, so only the draft is normally regenerated.
//
//   npm run generate:schema        write every schema file
//   npm run check:schema           type-check the source, then compare the
//                                  committed files with the generated text
//
// typescript-json-schema 0.68.0 runs with the settings the MCP repository
// passes on its command line (--required --defaultNumberType integer
// --skipLibCheck) plus --strictNullChecks, so that `| null` survives, and
// --validationKeywords propertyNames allOf, so that the two JSDoc tags that
// carry JSON Schema the type system cannot express are copied through.
//
// The post-pass, in the order applied:
//   1. $schema: draft-07 becomes 2020-12.
//   2. definitions becomes $defs, in the member and in every $ref.
//   3. A $ref keeps only description beside it. Draft-07 ignores the siblings
//      of $ref, and the tool copies the referenced type's tags (for one,
//      additionalProperties: false) onto an optional member that references
//      it; under 2020-12 those siblings would apply to the member itself.
//   4. $id is set from ROOTS. approval.schema.json has no root type (it is a
//      set of definitions), so its title and description come from ROOTS too.
//   5. The per-point files under strict-contexts/ are derived from the master:
//      the variant for one interception point becomes the root, and the
//      payload objects that point requires are closed.
//   6. Keys are ordered $id, $schema, title, description, the rest as the
//      tool emits them, $defs last; two-space indent; trailing newline.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as TJS from "typescript-json-schema";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: Json };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const specArg = process.argv.indexOf("--spec");
const SPEC = specArg >= 0 && specArg + 1 < process.argv.length ? process.argv[specArg + 1] : "draft";
const SCHEMA_DIR = `spec/${SPEC}/schema`;
const SRC = join(ROOT, "spec", SPEC, "schema", "src");
const OUT = join(ROOT, "spec", SPEC, "schema", "generated");
const ID_BASE = "https://responsibleai.github.io/agent-hooks/schema/v0.1/";
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

const SETTINGS: TJS.PartialArgs = {
  required: true,
  defaultNumberType: "integer",
  skipLibCheck: true,
  strictNullChecks: true,
  validationKeywords: ["propertyNames", "allOf"],
};

interface Root {
  file: string;
  source: string;
  /** The exported type name, or "*" for a file whose exports are all definitions. */
  type: string;
  title?: string;
  description?: string;
}

const ROOTS: Root[] = [
  { file: "interception-point.schema.json", source: "interception-point.ts", type: "InterceptionPoint" },
  { file: "verdict.schema.json", source: "verdict.ts", type: "Verdict" },
  { file: "interceptor-response.schema.json", source: "interceptor-response.ts", type: "InterceptorResponse" },
  { file: "agent-context.schema.json", source: "agent-context.ts", type: "AgentContext" },
  {
    file: "approval.schema.json",
    source: "approval.ts",
    type: "*",
    title: "Agent Hooks — approval seam",
    description:
      "Approval request and resolution shapes for lifting a liftable deny (AGENT-HOOKS-0.1 §9). " +
      "context_identity is an opaque provider-produced string, or null when identity_provider is " +
      "null (§10.1); the only normative constraint is the echo rule.",
  },
  { file: "interception-record.schema.json", source: "interception-record.ts", type: "InterceptionRecord" },
  { file: "host-declaration-1.0.schema.json", source: "host-declaration.ts", type: "HostDeclaration10" },
  { file: "host-declaration-1.1.schema.json", source: "host-declaration.ts", type: "HostDeclaration11" },
];

const MASTER = "agent-context.schema.json";

const compilerOptions = JSON.parse(readFileSync(join(SRC, "tsconfig.json"), "utf8")).compilerOptions;
const programs = new Map<string, TJS.Program>();

function programFor(source: string): TJS.Program {
  let program = programs.get(source);
  if (!program) {
    program = TJS.getProgramFromFiles([join(SRC, source)], compilerOptions, SRC);
    programs.set(source, program);
  }
  return program;
}

function ordered(schema: Schema): Schema {
  const { $id, $schema, title, description, $defs, ...rest } = schema;
  const out: Schema = { $id, $schema };
  if (title !== undefined) out.title = title;
  if (description !== undefined) out.description = description;
  Object.assign(out, rest);
  if ($defs !== undefined) out.$defs = $defs;
  return out;
}

function generateRoot(root: Root): Schema {
  const program = programFor(root.source);
  // TJS compares this allowlist to TypeScript's normalized filenames exactly.
  const only = root.type === "*" ? program.getRootFileNames().map((f) => f.replaceAll("\\", "/")) : undefined;
  const raw = TJS.generateSchema(program, root.type, SETTINGS, only);
  if (!raw) {
    throw new Error(`${root.source}: no schema for ${root.type}`);
  }
  // 1 and 2: the 2020-12 spelling of the draft-07 output.
  const text = JSON.stringify(raw).replace(/"#\/definitions\//g, () => '"#/$defs/');
  const schema = JSON.parse(text) as Schema;
  schema.$schema = DRAFT_2020_12;
  if (schema.definitions !== undefined) {
    schema.$defs = schema.definitions;
    delete schema.definitions;
  }
  // 3: the draft-07 meaning of $ref, which ignores its siblings.
  stripRefSiblings(schema);
  // 4: identity and, for a definitions-only file, the root annotations.
  schema.$id = ID_BASE + root.file;
  if (root.title !== undefined) schema.title = root.title;
  if (root.description !== undefined) schema.description = root.description;
  return ordered(schema);
}

function stripRefSiblings(node: Json): void {
  if (Array.isArray(node)) {
    for (const item of node) stripRefSiblings(item);
  } else if (node !== null && typeof node === "object") {
    if (typeof node.$ref === "string") {
      for (const key of Object.keys(node)) {
        if (key !== "$ref" && key !== "description") delete node[key];
      }
      return;
    }
    for (const value of Object.values(node)) stripRefSiblings(value);
  }
}

function refName(ref: string): string {
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) {
    throw new Error(`unexpected $ref ${ref}`);
  }
  return decodeURIComponent(ref.slice(prefix.length));
}

function collectRefs(node: Json, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, into);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") into.add(refName(value));
      else collectRefs(value, into);
    }
  }
}

/** 5: the closed per-point variants, derived from the master's union members. */
function perPointSchemas(master: Schema): Map<string, Schema> {
  const defs = master.$defs as Record<string, Schema>;
  const variants = (master.anyOf as { $ref: string }[]).map((m) => defs[refName(m.$ref)]);
  const requiredSets = variants.map((v) => new Set(v.required as string[]));
  const core = [...requiredSets[0]].filter((m) => requiredSets.every((s) => s.has(m)));
  const files = new Map<string, Schema>();
  for (const variant of variants) {
    const properties = variant.properties as Record<string, Schema>;
    const point = properties.interception_point.const as string;
    const reachable = new Set<string>();
    collectRefs(variant, reachable);
    for (let size = 0; size !== reachable.size; ) {
      size = reachable.size;
      for (const name of [...reachable]) collectRefs(defs[name], reachable);
    }
    const copy = structuredClone(Object.fromEntries([...reachable].sort().map((n) => [n, defs[n]])));
    for (const member of (variant.required as string[]).filter((m) => !core.includes(m))) {
      const property = properties[member];
      const target = typeof property.$ref === "string" ? copy[refName(property.$ref)] : property;
      if (target.type === "object") target.additionalProperties = false;
    }
    files.set(
      `strict-contexts/${point}.schema.json`,
      ordered({
        $id: `${ID_BASE}agent-context/${point}.schema.json`,
        $schema: DRAFT_2020_12,
        title: `Agent Hooks — agent context (${point})`,
        description:
          `Closed required+conditional schema for interception_point=${point} ` +
          "(AGENT-HOOKS-0.1 §4.2). Used by the CTK for strict validation.",
        type: variant.type,
        properties: variant.properties,
        required: variant.required,
        $defs: copy,
      }),
    );
  }
  return files;
}

/** Every output file's text, keyed by its path under spec/<version>/schema/generated/. */
function render(): Map<string, string> {
  const files = new Map<string, Schema>();
  for (const root of ROOTS) files.set(root.file, generateRoot(root));
  for (const [file, schema] of perPointSchemas(files.get(MASTER)!)) files.set(file, schema);
  return new Map([...files].map(([file, schema]) => [file, JSON.stringify(schema, null, 2) + "\n"]));
}

function committed(): string[] {
  if (!existsSync(OUT)) return [];
  return readdirSync(OUT, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".schema.json"))
    .map((f) => f.replaceAll("\\", "/"));
}

function firstDifference(actual: string, expected: string): string {
  const a = actual.split("\n");
  const e = expected.split("\n");
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] !== e[i]) {
      return `line ${i + 1}: committed ${JSON.stringify(a[i] ?? "")}, generated ${JSON.stringify(e[i] ?? "")}`;
    }
  }
  return "";
}

export function escapeWorkflowCommandData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function main(): number {
  const check = process.argv.includes("--check");
  const files = render();
  let failing = 0;
  for (const [file, text] of files) {
    const annotationFile = escapeWorkflowCommandData(file);
    const path = join(OUT, file);
    if (!check) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      console.log(`wrote ${relative(ROOT, path)}`);
      continue;
    }
    if (!existsSync(path)) {
      failing++;
      console.log(`::error::${escapeWorkflowCommandData(SCHEMA_DIR)}/generated/${annotationFile} is missing; run npm run generate:schema in sdk/typescript`);
      continue;
    }
    const actual = readFileSync(path, "utf8");
    if (actual !== text) {
      failing++;
      console.log(`::error::${escapeWorkflowCommandData(SCHEMA_DIR)}/generated/${annotationFile} differs from the TypeScript source; run npm run generate:schema in sdk/typescript`);
      console.log(`  ${firstDifference(actual, text)}`);
    }
  }
  if (check) {
    for (const file of committed().filter((f) => !files.has(f))) {
      failing++;
      const annotationFile = escapeWorkflowCommandData(file);
      console.log(`::error::${escapeWorkflowCommandData(SCHEMA_DIR)}/generated/${annotationFile} has no source under ${escapeWorkflowCommandData(SCHEMA_DIR)}/src/`);
    }
    console.log(`generate-schemas --check: ${files.size} files generated, ${failing} failing`);
  }
  return failing ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
