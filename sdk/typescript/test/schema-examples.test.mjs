// Copyright (c) Microsoft. All rights reserved.

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { schemaMapping, schemaRoot, validateExamples } from "../scripts/check-schema-examples.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "schema-examples-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["generated", "examples"]) {
    await cp(path.join(schemaRoot, directory), path.join(root, directory), { recursive: true });
  }
  return root;
}

async function write(root, relative, instance) {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(instance));
}

test("all draft examples validate", async () => {
  assert.ok(await validateExamples() > 0);
});

test("every standalone example is referenced by its TypeScript schema source", async () => {
  const examples = path.join(schemaRoot, "examples");
  const sources = path.join(schemaRoot, "src");
  const files = [];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(filename);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(filename);
    }
  }
  await collect(examples);
  const sourceFiles = await readdir(sources);
  const source = (
    await Promise.all(
      sourceFiles
        .filter((filename) => filename.endsWith(".ts"))
        .map((filename) => readFile(path.join(sources, filename), "utf8")),
    )
  ).join("\n");
  for (const filename of files) {
    const relative = path.relative(examples, filename).split(path.sep).join("/");
    assert.ok(
      source.includes(`../examples/${relative})`),
      `No TypeScript schema @example reference for ${relative}`,
    );
  }
});

test("new mapped examples are included, including invalid ones", async (t) => {
  const root = await fixture(t);
  const count = await validateExamples(root);
  await write(root, "examples/Verdict/new.json", { decision: "allow" });
  assert.equal(await validateExamples(root), count + 1);
  await write(root, "examples/Verdict/new.json", { decision: "invalid" });
  await assert.rejects(validateExamples(root), /new.json.*verdict.schema.json/);
});

test("new types, root-level files and nested files cannot be silently skipped", async (t) => {
  const root = await fixture(t);
  for (const filename of [
    "examples/NewType/example.json",
    "examples/unmapped.json",
    "examples/Verdict/nested/example.json",
    "examples/toString/example.json",
  ]) {
    await write(root, filename, { decision: "allow" });
    await assert.rejects(validateExamples(root), /no schema mapping/);
    await rm(path.join(root, filename));
  }
});

test("invalid JSON fails with the file path", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "examples/Verdict/new.json"), "{");
  await assert.rejects(validateExamples(root), /new.json/);
});

test("each mapped type rejects invalid instances, including approval fragments", async (t) => {
  const root = await fixture(t);
  for (const name of Object.keys(schemaMapping)) {
    const filename = `examples/${name}/invalid.json`;
    await write(root, filename, {});
    await assert.rejects(validateExamples(root), /invalid.json/);
    await rm(path.join(root, filename));
  }
});

test("contexts are also checked against the hook-specific schema", async (t) => {
  const root = await fixture(t);
  const filename = "generated/strict-contexts/pre_tool_call.schema.json";
  const schema = JSON.parse(await readFile(path.join(root, filename), "utf8"));
  schema.properties.sequence.const = 99;
  await write(root, filename, schema);
  await assert.rejects(validateExamples(root), /strict-contexts\/pre_tool_call/);
});

test("context date-time format is checked", async (t) => {
  const root = await fixture(t);
  const filename = "examples/AgentContext/input.json";
  const instance = JSON.parse(await readFile(path.join(root, filename), "utf8"));
  instance.timestamp = "not-a-timestamp";
  await write(root, filename, instance);
  await assert.rejects(validateExamples(root), /date-time/);
});

test("bare verdict and envelope example directories are not interchangeable", async (t) => {
  const root = await fixture(t);
  for (const [type, instance] of Object.entries({
    Verdict: { verdict: { decision: "allow" } },
    InterceptorResponse: { decision: "allow" },
  })) {
    const filename = `examples/${type}/invalid.json`;
    await write(root, filename, instance);
    await assert.rejects(validateExamples(root), /invalid.json/);
    await rm(path.join(root, filename));
  }
});

test("unresolved references fail offline", async (t) => {
  const root = await fixture(t);
  const filename = "generated/verdict.schema.json";
  const schema = JSON.parse(await readFile(path.join(root, filename), "utf8"));
  schema.$ref = "https://unavailable.invalid/missing.schema.json";
  await write(root, filename, schema);
  await assert.rejects(validateExamples(root), /unavailable.invalid/);
});

test("invalid schemas fail", async (t) => {
  const root = await fixture(t);
  const filename = "generated/verdict.schema.json";
  const schema = JSON.parse(await readFile(path.join(root, filename), "utf8"));
  schema.type = "not-a-json-type";
  await write(root, filename, schema);
  await assert.rejects(validateExamples(root), /invalid schema/);
});

test("duplicate schema identities fail", async (t) => {
  const root = await fixture(t);
  await cp(path.join(root, "generated/verdict.schema.json"), path.join(root, "generated/duplicate.schema.json"));
  await assert.rejects(validateExamples(root), /already exists/);
});

test("empty example trees fail", async (t) => {
  const root = await fixture(t);
  for (const entry of await readdir(path.join(root, "examples"), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await rm(path.join(root, "examples", entry.name), { recursive: true });
    }
  }
  await assert.rejects(validateExamples(root), /no JSON examples/);
});
