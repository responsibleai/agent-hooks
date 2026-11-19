// Copyright (c) Microsoft. All rights reserved.

import { fileURLToPath } from "node:url";
import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import rehypeAstroRelativeMarkdownLinks from "astro-rehype-relative-markdown-links";
import { defineConfig } from "astro/config";
import { releasedVersions } from "./src/spec.ts";

const base = "/agent-hooks";
const versions = releasedVersions(fileURLToPath(new URL("../", import.meta.url)));

export default defineConfig({
  site: "https://responsibleai.github.io",
  base,
  trailingSlash: "always",
  markdown: {
    // Lets pages link to source files, e.g. `[Verdicts](concepts/verdicts.md)`.
    processor: unified({
      rehypePlugins: [
        [rehypeAstroRelativeMarkdownLinks, { base, collectionBase: false, trailingSlash: "always" }],
      ],
    }),
  },
  integrations: [
    // Must precede Starlight so Mermaid fences skip code highlighting.
    mermaid({ enableLog: false }),
    starlight({
      title: "Agent Hooks",
      description: "Framework-neutral control contract for AI agents.",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/responsibleai/agent-hooks" },
      ],
      sidebar: [
        { label: "Home", slug: "" },
        {
          label: "Concepts",
          items: [
            { label: "Interception points", slug: "concepts/interception-points" },
            { slug: "concepts/verdicts" },
            { slug: "concepts/composition" },
            { label: "Approval seam", slug: "concepts/approval" },
            { slug: "concepts/identity" },
            { slug: "concepts/records" },
          ],
        },
        {
          label: "Quickstarts",
          items: [
            { label: "Python", slug: "quickstart/python" },
            { label: "TypeScript", slug: "quickstart/typescript" },
            { label: "Rust", slug: "quickstart/rust" },
            { label: ".NET", slug: "quickstart/dotnet" },
            { label: "Go", slug: "quickstart/go" },
          ],
        },
        {
          label: "Examples",
          items: [
            { label: "Policy deny", slug: "examples/policy-deny" },
            { label: "Human approval", slug: "examples/approval-flow" },
            { label: "Redaction transform", slug: "examples/redaction" },
          ],
        },
        { slug: "conformance" },
        {
          label: "Specification",
          items: [
            ...versions.map((version) => ({ label: version, slug: `spec/${version}` })),
            { label: "Draft", slug: "spec/draft" },
            { label: "Draft schema reference", slug: "spec/draft/reference" },
            { label: "Draft reference tables", slug: "spec/draft/reference-tables" },
          ],
        },
        { slug: "faq" },
      ],
    }),
  ],
});
