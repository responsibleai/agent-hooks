// Copyright (c) Microsoft. All rights reserved.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTester } from "@typespec/compiler/testing";

const tester = createTester(
  resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  {
    libraries: ["@agent-hooks/reference-docs", "@typespec/json-schema"],
  },
)
  .importLibraries()
  .using("AgentHooks.Docs", "TypeSpec.JsonSchema");
const emitter = tester.emit("@agent-hooks/reference-docs");

test("groups declarations by enum order and links same-named types by namespace", async () => {
  const { outputs } = await emitter.compile(`
    namespace Hooks {
      @category(Categories.Responses) model Result { request: Requests.Result; }
    }
    namespace Requests {
      @category(Categories.Requests) model Result { id: string; }
    }
  `);
  assert.deepEqual(Object.keys(outputs).sort(), [
    "REFERENCE-TABLES.md",
    "REFERENCE.md",
  ]);
  for (const page of Object.values(outputs)) {
    assert.ok(
      page.indexOf("## Hook requests") < page.indexOf("## Hook responses"),
    );
    assert.match(
      page,
      /- \[Hook requests\]\(#hook-requests\)\n- \[Hook responses\]/,
    );
    assert.match(page, /\[\`Result\`\]\(#requests-result\)/);
    assert.match(page, /<a id="hooks-result"><\/a>/);
    assert.match(page, /<a id="requests-result"><\/a>/);
  }
});

test("documents generic declarations, concrete envelopes, and inherited and nested constraints", async () => {
  const { outputs } = await emitter.compile(`
    namespace Test;
    @category(Categories.Common)
    enum Kind { Allow: "allow", Deny: "deny" }
    model Base {
      /** A machine-readable reason. */
      @pattern("^(?!host_error:).*")
      reason?: string | null;
    }
    /** Generic response wrapper. */
    @category(Categories.Responses)
    model Envelope<T> {
      value: T;
    }
    @category(Categories.Responses)
    model Response extends Base {
      kind: Kind;
      wrapped: Envelope<Kind>;
      agent: { @minLength(1) id: string; };
      next?: Response;
    }
  `);
  const page = outputs["REFERENCE-TABLES.md"];
  assert.match(page, /### `Envelope<T>`/);
  assert.match(page, /Generic response wrapper\./);
  assert.match(page, /\| `value` \| `T` \|/);
  assert.match(
    page,
    /\[\`Envelope\`\]\(#test-envelope\)&lt;\[\`Kind\`\]\(#test-kind\)&gt;/,
  );
  assert.match(
    page,
    /\| `reason\?` \| `string` &#124; `null` \| A machine-readable reason\./,
  );
  assert.match(page, /pattern: `\^\(\?!host_error:\)\.\*`/);
  assert.match(page, /\| `agent.id` \| `string` \|  \| minLength: `1` \|/);
  assert.match(page, /\| `next\?` \| \[\`Response\`\]\(#test-response\)/);
  const declarations = outputs["REFERENCE.md"];
  assert.match(
    declarations,
    /Generic response wrapper\.\n\n```typespec\nmodel Envelope<T>/,
  );
  assert.doesNotMatch(
    declarations,
    /```typespec\n[\s\S]*?\/\*\* Generic response wrapper/,
  );
  assert.doesNotMatch(page, /@category\(Categories.Responses\)/);
  assert.match(declarations, /model Response extends Base/);
  assert.match(declarations, /#### `reason\?`\n\nA machine-readable reason\./);
  assert.match(declarations, /Type: `string` \| `null`\./);
  assert.match(declarations, /#### `agent.id`[\s\S]*?minLength: `1`/);
  assert.match(declarations, /Type: \[\`Response\`\]\(#test-response\)\./);
  assert.doesNotMatch(declarations, /^\| Property \|/m);
});

test("ignores another namespace's category decorator on a generic declaration", async () => {
  const collisionTester = createTester(
    resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    {
      libraries: ["@agent-hooks/reference-docs", "@typespec/json-schema"],
      features: ["auto-decorators"],
    },
  )
    .importLibraries()
    .using("AgentHooks.Docs", "TypeSpec.JsonSchema")
    .emit("@agent-hooks/reference-docs");
  const { outputs } = await collisionTester.compile(`
    namespace Other {
      auto dec category(target: TypeSpec.Reflection.Model, value: AgentHooks.Docs.Categories);
    }
    @Other.category(Categories.Responses) @AgentHooks.Docs.category(
      Categories.Requests
    ) model Listed<T> { value: T; }
    @Other.category(Categories.Responses)
    model Unrelated<T> { value: T; }
  `);
  for (const page of Object.values(outputs)) {
    assert.match(page, /## Hook requests/);
    assert.doesNotMatch(page, /## Hook responses/);
    assert.match(page, /### `Listed<T>`/);
    assert.doesNotMatch(page, /### `Unrelated<T>`/);
    assert.match(
      page,
      /@Other\.category\(Categories.Responses\) model Listed<T>/,
    );
    assert.doesNotMatch(page, /@AgentHooks\.Docs\.category/);
  }
});

test("renders JSON examples, union variants, enums, and Markdown table metacharacters", async () => {
  const { outputs } = await emitter.compile(`
    @category(Categories.Common)
    enum Choice { First: "a|b", Second: "second" }
    @category(Categories.Common)
    union Selection { Choice, null }
    @category(Categories.Common)
    scalar Identifier extends string;
    /** Complete request payload. */
    @summary("A concise request.")
    @example(#{ text: "hello" }, #{ title: "Minimal" })
    @category(Categories.Requests)
    model Request {
      /** Text with a | separator and \`left | right\`. */
      @pattern("^(hello|world)$")
      text: string;
      selection?: Selection;
      choices?: (Choice | null)[];
    }
  `);
  const page = outputs["REFERENCE-TABLES.md"];
  assert.match(page, /<code>"a&#124;b"<\/code>/);
  assert.match(
    page,
    /Text with a &#124; separator and <code>left &#124; right<\/code>\./,
  );
  assert.match(page, /pattern: <code>\^\(hello&#124;world\)\$<\/code>/);
  assert.match(page, /- \[\`Choice\`\]\(#choice\)\n- `null`/);
  assert.match(
    page,
    /\| `choices\?` \| \(\[\`Choice\`\]\(#choice\) &#124; `null`\)\[\] \|/,
  );
  assert.match(page, /#### Minimal\n\n```json\n{\n  "text": "hello"\n}\n```/);
  const declarations = outputs["REFERENCE.md"];
  assert.match(
    declarations,
    /enum Choice \{ First: "a\|b", Second: "second" \}/,
  );
  assert.match(declarations, /union Selection \{ Choice, null \}/);
  assert.match(declarations, /scalar Identifier extends string;/);
  assert.match(declarations, /@example\(/);
  assert.match(
    declarations,
    /A concise request\.\n\nComplete request payload\.\n\n```typespec\n@example\([^)]*\)\n\s*model Request/,
  );
  const requestSnippet = declarations.match(
    /```typespec\n([\s\S]*?)\n```(?=\n\n#### `text`)/,
  )?.[1];
  assert.ok(requestSnippet);
  assert.doesNotMatch(requestSnippet, /\/\*\*/);
  assert.doesNotMatch(
    declarations,
    /```typespec\n[\s\S]*?@summary\("A concise request\."\)/,
  );
  assert.doesNotMatch(declarations, /\/\*\* Complete request payload/);
  assert.doesNotMatch(declarations, /@category\(Categories\./);
  assert.match(declarations, /#### `First`\n\nValue: `"a\|b"`\./);
  assert.match(declarations, /Text with a \| separator and `left \| right`\./);
  assert.match(declarations, /pattern: `\^\(hello\|world\)\$`/);
  assert.match(
    declarations,
    /#### Minimal\n\n```json\n{\n  "text": "hello"\n}\n```/,
  );
  assert.doesNotMatch(declarations, /^\| (?:Property|Member) \|/m);
});

test("reports an empty selection rather than emitting a success-shaped empty page", async () => {
  const [result, diagnostics] =
    await emitter.compileAndDiagnose("model Unlisted {}");
  assert.deepEqual(Object.keys(result.outputs), []);
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "@agent-hooks/reference-docs/no-categories",
    ),
  );
});

test("keeps literal backticks and HTML metacharacters intact in source, examples, and tables", async () => {
  const { outputs } = await emitter.compile(`
    @category(Categories.Common)
    @example(#{ text: "\`\`\`" })
    model Literal {
      @pattern("^\`<a|b>&\`$")
      pattern?: string;
      text: "\`\`\`";
    }
  `);
  const source = outputs["REFERENCE.md"];
  assert.match(source, /````typespec\n[\s\S]*?text: "```";[\s\S]*?\n````/);
  assert.match(source, /````json\n\{\n  "text": "```"\n\}\n````/);
  const table = outputs["REFERENCE-TABLES.md"];
  assert.match(table, /````"```"````/);
  assert.match(table, /<code>\^`&lt;a&#124;b&gt;&amp;`\$<\/code>/);
});
