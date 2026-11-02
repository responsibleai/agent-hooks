// Copyright (c) Microsoft. All rights reserved.

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  bundleSchemaRoot,
  bundles,
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

async function releasedBundles() {
  return (await bundles()).filter((name) => name !== "draft");
}

test("bundles lists the draft and every released version", async () => {
  const names = await bundles();
  assert.ok(names.includes("draft"));
  const released = names.filter((name) => name !== "draft");
  assert.ok(released.length > 0, "no released bundle under spec/");
  for (const name of released) assert.match(name, /^\d+\.\d+\.\d+$/);
});

test("bundles rejects a symbolic link and a stray folder under spec/", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "schema-bundles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "draft"));
  await mkdir(path.join(root, "0.1.0"));
  await writeFile(path.join(root, "README.md"), "# versions\n");
  assert.deepEqual(await bundles(root), ["0.1.0", "draft"]);
  await mkdir(path.join(root, "0.1.0-beta"));
  await assert.rejects(bundles(root), /not draft or a MAJOR\.MINOR\.PATCH version/);
  await rm(path.join(root, "0.1.0-beta"), { recursive: true });
  try {
    await symlink("draft", path.join(root, "0.2.0"));
  } catch (error) {
    if (error.code === "EPERM") return t.skip("symbolic links need a privilege here");
    throw error;
  }
  await assert.rejects(bundles(root), /symbolic links are not allowed/);
});

test("every bundle's examples validate against its own schemas", async () => {
  for (const name of await bundles()) {
    assert.ok(await validateExamples(bundleSchemaRoot(name)) > 0, name);
  }
});

test("draft-only example additions and edits do not affect release validation", async (t) => {
  const root = await fixture(t);
  const [release] = await releasedBundles();
  const releaseRoot = bundleSchemaRoot(release);
  const draftExample = path.join(root, "examples/Verdict/allow.json");
  const releaseExample = path.join(releaseRoot, "examples/Verdict/allow.json");
  const releaseContents = await readFile(releaseExample);
  const draft = JSON.parse(await readFile(draftExample, "utf8"));
  draft.message = "Updated draft-only example";
  await writeFile(draftExample, JSON.stringify(draft));
  await write(root, "examples/Verdict/draft-only.json", { decision: "allow" });

  assert.ok(await validateExamples(root) > 0);
  assert.ok(await validateExamples(releaseRoot) > 0);
  assert.deepEqual(await readFile(releaseExample), releaseContents);
});

test("invalid draft-only examples still fail validation", async (t) => {
  const root = await fixture(t);
  await write(root, "examples/Verdict/draft-only.json", { decision: "invalid" });
  await assert.rejects(validateExamples(root), /draft-only.json.*verdict.schema.json/);
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

test("the draft streaming declaration lists both model points and binds at every point", async () => {
  // Incremental mediation happens at post_model_call (spec §12.1), so a
  // surface naming incremental_output needs the model points and
  // model_calls; and a binding without `at` covers every surface point,
  // so no point is left to deny as host_error:no_interceptor.
  const streaming = JSON.parse(
    await readFile(path.join(schemaRoot, "examples/HostDeclaration11/streaming-document-policy.json"), "utf8"),
  );
  const points = streaming.surface.interception_points;
  assert.ok(points.includes("pre_model_call") && points.includes("post_model_call"));
  assert.ok(streaming.surface.capabilities.includes("model_calls"));
  assert.ok(streaming.surface.capabilities.includes("incremental_output"));
  assert.equal(streaming.surface.buffered_output, false);
  for (const binding of streaming.bindings) assert.equal(binding.at, undefined, binding.id);
});

test("draft interception records each hold their own position in a session", async () => {
  // `sequence` is strictly increasing within a session (spec §4.1), so
  // two records cannot share a (session_id, sequence) pair.
  const directory = path.join(schemaRoot, "examples/InterceptionRecord");
  const seen = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = JSON.parse(await readFile(path.join(directory, entry.name), "utf8"));
    const key = `${record.session_id}#${record.sequence}`;
    assert.equal(seen.get(key), undefined, `${entry.name} repeats ${key} of ${seen.get(key)}`);
    seen.set(key, entry.name);
  }
});

test("every draft example is referenced by the draft TypeScript schema source", async () => {
  // Draft only: a released bundle's source is frozen at the release and
  // carries no links to examples added after it.
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
      `No TypeScript schema @example reference in the draft source for ${relative}`,
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

test("a symbolic link in the example tree fails instead of being skipped", async (t) => {
  const root = await fixture(t);
  try {
    await symlink("allow.json", path.join(root, "examples/Verdict/link.json"));
  } catch (error) {
    if (error.code === "EPERM") return t.skip("symbolic links need a privilege here");
    throw error;
  }
  await assert.rejects(validateExamples(root), /link.json: not a regular file or directory/);
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
