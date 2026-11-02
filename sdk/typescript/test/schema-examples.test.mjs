// Copyright (c) Microsoft. All rights reserved.

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  releaseSchemaRoot,
  schemaMapping,
  schemaRoot,
  validateExamples,
} from "../scripts/check-schema-examples.mjs";

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

async function assertExampleSourceLinks(bundleRoot) {
  const examples = path.join(bundleRoot, "examples");
  const sources = path.join(bundleRoot, "src");
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
      `No TypeScript schema @example reference in ${bundleRoot} for ${relative}`,
    );
  }
}

test("all draft examples validate", async () => {
  assert.ok(await validateExamples() > 0);
});

test("the released bundle has matching, byte-identical copies and validates independently", async () => {
  const draftExamples = path.join(schemaRoot, "examples");
  const releaseExamples = path.join(releaseSchemaRoot, "examples");
  async function files(directory) {
    const result = [];
    async function collect(current) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const filename = path.join(current, entry.name);
        if (entry.isDirectory()) await collect(filename);
        else if (entry.isFile() && entry.name.endsWith(".json")) result.push(filename);
      }
    }
    await collect(directory);
    return result.sort();
  }
  const draftFiles = await files(draftExamples);
  const releaseFiles = await files(releaseExamples);
  assert.equal(draftFiles.length, 38);
  assert.equal(releaseFiles.length, draftFiles.length);
  for (let index = 0; index < draftFiles.length; index += 1) {
    const relative = path.relative(draftExamples, draftFiles[index]);
    assert.equal(path.relative(releaseExamples, releaseFiles[index]), relative);
    assert.deepEqual(
      await readFile(draftFiles[index]),
      await readFile(releaseFiles[index]),
      relative,
    );
  }
  assert.equal(await validateExamples(releaseSchemaRoot), draftFiles.length);
});

test("context targets equal their hook payloads, including optional-feature variants", async () => {
  const examples = path.join(schemaRoot, "examples/AgentContext");
  for (const entry of await readdir(examples, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const context = JSON.parse(await readFile(path.join(examples, entry.name), "utf8"));
    let payload;
    switch (context.interception_point) {
      case "agent_startup": payload = context.agent_init; break;
      case "input": payload = context.input; break;
      case "pre_model_call": payload = context.messages; break;
      case "post_model_call": payload = context.response; break;
      case "pre_tool_call": payload = context.tool_call?.args; break;
      case "post_tool_call": payload = context.tool_result?.value; break;
      case "output": payload = context.output; break;
      case "agent_shutdown": payload = context.summary; break;
      default: assert.fail(`Unknown interception point ${context.interception_point}`);
    }
    assert.deepEqual(context.target, payload, entry.name);
  }
});

test("optional contexts illustrate tools, usage, metadata and tool errors", async () => {
  const readContext = async (name) =>
    JSON.parse(await readFile(path.join(schemaRoot, "examples/AgentContext", name), "utf8"));
  const beforeModel = await readContext("pre-model-call-with-tools.json");
  assert.ok(beforeModel.tools.some((tool) => tool.name === "search_documents"));
  assert.equal(beforeModel.model.vendor, "example");
  assert.ok(beforeModel.model.params);
  assert.equal(beforeModel.request_id, "model-request-001");

  const afterModel = await readContext("post-model-call-with-usage.json");
  assert.ok(afterModel.usage.prompt_tokens > 0);
  assert.ok(afterModel.usage.completion_tokens > 0);
  assert.equal(afterModel.response.tool_calls[0].id, "search-001");
  assert.equal(afterModel.request_id, "model-request-001");

  const metadata = await readContext("output-with-metadata.json");
  for (const field of ["trace", "tenant", "actor", "budgets", "extensions"]) {
    assert.ok(metadata[field], `missing ${field}`);
  }
  assert.ok(Object.hasOwn(metadata.extensions, "example_policy"));

  const failedTool = await readContext("post-tool-call-error.json");
  assert.equal(failedTool.tool_result.is_error, true);
  assert.ok(failedTool.tool_result.duration_ms >= 0);
});

test("optional declarations, evidence and timeout record preserve runtime semantics", async () => {
  const readExample = async (type, name) =>
    JSON.parse(await readFile(path.join(schemaRoot, "examples", type, name), "utf8"));
  const failure = await readExample("HostDeclaration11", "failure-posture.json");
  assert.equal(failure.configuration.failure.on_error, "deny");
  assert.equal(failure.bindings[0].on_error, "continue");
  assert.ok(failure.bindings[0].timeout_ms > 0);

  const streaming = await readExample("HostDeclaration11", "streaming-document-policy.json");
  assert.equal(streaming.surface.buffered_output, false);
  assert.ok(streaming.surface.exposure_bound);
  assert.ok(streaming.surface.capabilities.includes("incremental_output"));

  const evidence = await readExample("Verdict", "allow-with-evidence.json");
  assert.equal(evidence.decision, "allow");
  assert.ok(evidence.evidence.artefact);
  assert.ok(evidence.evidence.verification_pointers);
  assert.equal(evidence.extensions, undefined);

  const record = await readExample("InterceptionRecord", "continued-after-timeout.json");
  assert.equal(record.verdict.decision, "allow");
  assert.equal(record.verdicts[0].decision, "allow");
  assert.equal(record.verdicts[0].substituted_for, "host_error:interceptor_timeout");
  assert.equal(record.verdicts[0].reason, undefined);
  assert.equal(record.verdicts.length, 1);
  assert.equal(record.fold_truncated, false);
  assert.deepEqual(record.verdict.warnings, [{
    reason: "host_warning:control_failed",
    message: "document-policy: host_error:interceptor_timeout; host continued",
  }]);
});

test("every standalone example is referenced by its bundle's TypeScript schema source", async () => {
  await assertExampleSourceLinks(schemaRoot);
  await assertExampleSourceLinks(releaseSchemaRoot);
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
