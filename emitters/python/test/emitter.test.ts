// Copyright (c) Microsoft. All rights reserved.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTester } from "@typespec/compiler/testing";

const tester = createTester(fileURLToPath(new URL("../", import.meta.url)), {
  libraries: ["@agent-hooks/python-emitter"],
})
  .wrap((code) => `namespace AgentHooks; ${code}`)
  .emit("@agent-hooks/python-emitter");

async function emit(code: string): Promise<string> {
  const { outputs } = await tester.compile(code);
  assert.deepEqual(Object.keys(outputs), ["__init__.py"]);
  return outputs["__init__.py"];
}

test("keyword and non-identifier properties use functional TypedDicts and retain documentation", async () => {
  const output = await emit(`
    model Message {
      /** The sender of the message. */
      \`from\`: string;
      \`class\`?: string;
      \`async\`?: boolean;
      \`return\`?: string;
      \`$schema\`?: string;
    }
  `);
  assert.match(output, /Message = TypedDict\(/);
  assert.match(output, /# The sender of the message\.\n\s+"from": str,/);
  for (const name of ["class", "async", "return", "$schema"]) {
    assert.ok(output.includes(`"${name}": NotRequired[`));
  }
});

test("Record<never> is an empty TypedDict, not a map to Never", async () => {
  const output = await emit(`
    model Holder { value: Empty; }
    model Empty is Record<never>;
  `);
  assert.match(output, /class Empty\(TypedDict\):\n\s+pass/);
  assert.match(output, /value: Empty/);
  assert.ok(output.indexOf("class Empty(") < output.indexOf("class Holder("));
  assert.doesNotMatch(output, /Never|Empty =/);
});

test("model-property references use their underlying type and dependencies", async () => {
  const output = await emit(`
    model Holder { copied: Envelope.payload; }
    model Envelope { payload: Payload; }
    model Payload { name: string; }
  `);
  assert.match(output, /copied: Payload/);
  assert.ok(output.indexOf("class Payload(") < output.indexOf("class Holder("));
  assert.doesNotMatch(output, /copied: "Payload"/);
});

test("template instances have concrete non-redundant names in union declarations", async () => {
  const output = await emit(`
    union Result { Envelope<Payload>, Envelope<Other>, TransformVerdict<PayloadTransform> }
    model Envelope<T> { value: T; }
    model TransformVerdict<T> { value: T; }
    model Payload { text: string; }
    model Other { number: int32; }
    model PayloadTransform { enabled: boolean; }
  `);
  assert.match(output, /class PayloadEnvelope\(TypedDict\):/);
  assert.match(output, /class OtherEnvelope\(TypedDict\):/);
  assert.match(output, /class PayloadTransformVerdict\(TypedDict\):/);
  assert.match(
    output,
    /Result = PayloadEnvelope \| OtherEnvelope \| PayloadTransformVerdict/,
  );
  assert.doesNotMatch(output, /TransformTransformVerdict/);
  assert.ok(
    output.indexOf("class Payload(") < output.indexOf("class PayloadEnvelope("),
  );
  assert.ok(
    output.indexOf("class OtherEnvelope(") < output.indexOf("Result ="),
  );
});

test("declarations are ordered through anonymous models, named unions, and scalar aliases", async () => {
  const output = await emit(`
    model Root { nested: { choice: Choice; }; }
    union Choice { Leaf, null }
    model Leaf { id: Identifier; kind?: Kind; }
    scalar Identifier extends string;
    enum Kind { One: "one", Two: "two" }
  `);
  for (const [dependency, dependent] of [
    ["Identifier = str", "class Leaf("],
    ["Kind = Literal[", "class Leaf("],
    ["class Leaf(", "Choice = Leaf | None"],
    ["Choice = Leaf | None", "class RootNested("],
    ["class RootNested(", "class Root("],
  ]) {
    assert.ok(output.indexOf(dependency) >= 0, dependency);
    assert.ok(
      output.indexOf(dependency) < output.indexOf(dependent),
      `${dependency} before ${dependent}`,
    );
  }
  assert.doesNotMatch(output, /"(?:Leaf|Choice|RootNested|Identifier|Kind)"/);
});

test("assigned names cannot collide with concrete declarations", async () => {
  await assert.rejects(
    () =>
      emit(`
    model Holder { value: Envelope<Payload>; }
    model Envelope<T> { value: T; }
    model Payload {}
    model PayloadEnvelope {}
  `),
    /Duplicate Python declaration name: PayloadEnvelope/,
  );
});
