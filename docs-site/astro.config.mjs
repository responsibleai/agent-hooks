// Copyright (c) Microsoft. All rights reserved.

import { readFileSync } from "node:fs";
import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { legacyAnchors } from "./legacy-anchors.mjs";

const versions = JSON.parse(readFileSync(new URL("./.spec-versions.json", import.meta.url), "utf8"));

export default defineConfig({
  site: "https://responsibleai.github.io",
  base: "/agent-hooks",
  trailingSlash: "always",
  markdown: { processor: unified({ rehypePlugins: [legacyAnchors] }) },
  integrations: [
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
          ],
        },
        { slug: "faq" },
      ],
    }),
  ],
});
