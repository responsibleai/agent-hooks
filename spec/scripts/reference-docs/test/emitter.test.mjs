// Copyright (c) Microsoft. All rights reserved.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTester } from "@typespec/compiler/testing";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";

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
      model Result { request: Requests.Result; }
    }
    namespace Requests {
      model Result { id: string; }
    }
    @@category(Hooks.Result, Categories.Responses);
    @@category(Requests.Result, Categories.Requests);
  `);
  assert.deepEqual(Object.keys(outputs), ["REFERENCE.md"]);
  for (const page of Object.values(outputs)) {
    assert.ok(
      page.indexOf("## Hook requests") < page.indexOf("## Hook responses"),
    );
    assert.match(
      page,
      /- \[Hook requests\]\(#reference-hook-requests\)\n- \[Hook responses\]/,
    );
    assert.match(page, /\[\`Result\`\]\(#requests-result\)/);
    assert.match(page, /<a id="hooks-result"><\/a>/);
    assert.match(page, /<a id="requests-result"><\/a>/);
  }
});

test("documents generic declarations, concrete envelopes, and inherited and nested constraints", async () => {
  const { outputs } = await emitter.compile(`
    namespace Test;
    enum Kind { Allow: "allow", Deny: "deny" }
    model Base {
      /** A machine-readable reason. */
      @pattern("^(?!host_error:).*")
      reason?: string | null;
    }
    /** Generic response wrapper. */
    model Envelope<T> {
      value: T;
    }
    model Response extends Base {
      kind: Kind;
      wrapped: Envelope<Kind>;
      agent: { @minLength(1) id: string; };
      next?: Response;
    }
    @@category(Kind, Categories.Common);
    @@category(Base, Categories.Common);
    @@category(Envelope, Categories.Responses);
    @@category(Response, Categories.Responses);
  `);
  const page = outputs["REFERENCE.md"];
  assert.match(page, /### `Envelope<T>`/);
  assert.match(page, /Generic response wrapper\./);
  assert.match(page, /#### `value`\n\nType: `T`\./);
  assert.match(
    page,
    /\[\`Envelope\`\]\(#test-envelope\)&lt;\[\`Kind\`\]\(#test-kind\)&gt;/,
  );
  assert.match(
    page,
    /#### `reason\?`\n\nA machine-readable reason\./,
  );
  assert.match(page, /pattern: `\^\(\?!host_error:\)\.\*`/);
  assert.match(page, /#### `agent.id`\n\nType: `string`\.\n\nminLength: `1`/);
  assert.match(page, /#### `next\?`\n\nType: \[\`Response\`\]\(#test-response\)/);
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
  assert.match(declarations, /Type: `string` &#124; `null`\./);
  assert.match(declarations, /#### `agent.id`[\s\S]*?minLength: `1`/);
  assert.match(declarations, /Type: \[\`Response\`\]\(#test-response\)\./);
  assert.doesNotMatch(declarations, /^\| Property \|/m);
});

test("reads augmented template categories without confusing another namespace's decorator", async () => {
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
    @Other.category(Categories.Responses) model Listed<T> { value: T; }
    @@AgentHooks.Docs.category(Listed, Categories.Requests);
  `);
  for (const page of Object.values(outputs)) {
    assert.match(page, /## Hook requests/);
    assert.doesNotMatch(page, /## Hook responses/);
    assert.match(page, /### `Listed<T>`/);
    assert.match(
      page,
      /@Other\.category\(Categories.Responses\) model Listed<T>/,
    );
    assert.doesNotMatch(page, /@AgentHooks\.Docs\.category/);
  }
});

test("renders JSON examples, union variants, enums, and Markdown metacharacters", async () => {
  const { outputs } = await emitter.compile(`
    enum Choice { First: "a|b", Second: "second" }
    union Selection { Choice, null }
    scalar Identifier extends string;
    /** Complete request payload. */
    @summary("A concise request.")
    @example(#{ text: "hello" }, #{ title: "Minimal" })
    model Request {
      /** Text with a | separator and \`left | right\`. */
      @pattern("^(hello|world)$")
      text: string;
      selection?: Selection;
      choices?: (Choice | null)[];
      literal?: "left|right";
    }
    @@category(Choice, Categories.Common);
    @@category(Selection, Categories.Common);
    @@category(Identifier, Categories.Common);
    @@category(Request, Categories.Requests);
  `);
  const page = outputs["REFERENCE.md"];
  assert.ok(page.includes('`"a|b"`'));
  assert.match(
    page,
    /Text with a \| separator and `left \| right`\./,
  );
  assert.ok(page.includes('pattern: `^(hello|world)$`'));
  assert.match(page, /- \[\`Choice\`\]\(#choice\)\n- `null`/);
  assert.match(
    page,
    /Type: \(\[\`Choice\`\]\(#choice\) &#124; `null`\)\[\]\./,
  );
  assert.match(page, /#### Minimal\n\n```json\n{\n  "text": "hello"\n}\n```/);
  const processor = await createMarkdownProcessor({ syntaxHighlight: false });
  const { code } = await processor.render(page);
  assert.ok(code.includes("Text with a | separator and <code>left | right</code>."));
  assert.ok(code.includes('Type: <code>"left|right"</code>.'));
  assert.ok(code.includes('Type: (<a href="#choice"><code>Choice</code></a> | <code>null</code>)[].'));
  assert.doesNotMatch(code, /<table>/);
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

test("reports each missing declaration at its source and emits no partial reference", async () => {
  const [result, diagnostics] =
    await emitter.compileAndDiagnose(`
      model Listed { nested: { value: string }; list: string[]; }
      @@category(Listed, Categories.Common);
      namespace Unreferenced {
        model Missing {}
        model Generic<T> { value: T; }
        enum MissingEnum { A }
        union MissingUnion { string, null }
        scalar MissingScalar extends string;
      }
    `);
  assert.deepEqual(Object.keys(result.outputs), []);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.code),
    Array(5).fill("@agent-hooks/reference-docs/missing-category"),
  );
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.target.name).sort(),
    ["Generic", "Missing", "MissingEnum", "MissingScalar", "MissingUnion"],
  );
  assert.match(diagnostics[0].message, /@@category\(Unreferenced\./);
});

test("excludes imported libraries and concrete template instances from completeness validation", async () => {
  const { outputs } = await emitter.compile(`
    model Envelope<T> { value: T; }
    model Request { value: Envelope<string>; open: Record<unknown>; }
    @@category(Envelope, Categories.Responses);
    @@category(Request, Categories.Requests);
  `);
  for (const page of Object.values(outputs)) {
    assert.match(page, /### \`Envelope<T>\`/);
    assert.match(page, /### \`Request\`/);
    assert.doesNotMatch(page, /### \`(?:Categories|Record|Array|JsonSchema)/);
    assert.equal((page.match(/^### /gm) ?? []).length, 2);
  }
});

test("validates category completeness even when no emitter is selected", async () => {
  const [, diagnostics] = await tester.compileAndDiagnose("model Missing {}");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "@agent-hooks/reference-docs/missing-category");
  assert.equal(diagnostics[0].target.name, "Missing");
});

test("keeps literal backticks and HTML metacharacters intact in source, examples, and member docs", async () => {
  const { outputs } = await emitter.compile(`
    @example(#{ text: "\`\`\`" })
    model Literal {
      @pattern("^\`<a|b>&\`$")
      pattern?: string;
      text: "\`\`\`";
    }
    @@category(Literal, Categories.Common);
  `);
  const source = outputs["REFERENCE.md"];
  assert.match(source, /````typespec\n[\s\S]*?text: "```";[\s\S]*?\n````/);
  assert.match(source, /````json\n\{\n  "text": "```"\n\}\n````/);
  assert.match(source, /````"```"````/);
  const processor = await createMarkdownProcessor({ syntaxHighlight: false });
  const { code } = await processor.render(source);
  assert.ok(code.includes('<code>^`&#x3C;a|b>&#x26;`$</code>'));
  assert.ok(code.includes('<code>"```"</code>'));
});

test("preserves literal regexes, Markdown punctuation, and padded backtick spans in Astro", async () => {
  const patterns = [
    String.raw`^(a|b)\.json$`,
    "a*b|c*d",
    "`left|right`",
    "``left|right``",
    " left|right ",
  ];
  const { outputs } = await emitter.compile(`
    model Patterns {
      ${patterns.map((pattern, i) => `@pattern(${JSON.stringify(pattern)}) value${i}: string;`).join("\n")}
    }
    @@category(Patterns, Categories.Common);
  `);
  const processor = await createMarkdownProcessor({ syntaxHighlight: false });
  const { code } = await processor.render(outputs["REFERENCE.md"]);
  const constraints = [...code.matchAll(/<p>pattern: <code>([\s\S]*?)<\/code><\/p>/g)];
  assert.equal(constraints.length, patterns.length);
  for (const [i, constraint] of constraints.entries()) {
    assert.ok(
      constraint[1] === patterns[i],
      constraint[1],
    );
  }
});
