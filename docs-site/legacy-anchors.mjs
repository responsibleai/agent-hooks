// Copyright (c) Microsoft. All rights reserved.

import { rehypeHeadingIds } from "@astrojs/markdown-remark";

// MkDocs collapsed runs of spaces and hyphens; keep those old fragments
// alongside Astro's GitHub-style heading IDs.
const legacySlug = (text) =>
  text.normalize("NFKD").replace(/[^\x00-\x7F]/g, "")
    .replace(/[^\w\s-]/g, "").trim().toLowerCase().replace(/[-\s]+/g, "-");

const anchor = (id) => ({ type: "element", tagName: "span", properties: { id }, children: [] });

export function legacyAnchors() {
  const assignHeadingIds = rehypeHeadingIds();
  return (tree, file) => {
    assignHeadingIds(tree, file);
    const headings = file.data.astro.headings;
    const used = new Set(headings.map(({ slug }) => slug));
    const addAlias = (text, children) => {
      const id = legacySlug(text);
      if (id && !used.has(id)) {
        children.unshift(anchor(id));
        used.add(id);
      }
    };

    const title = file.data.astro.frontmatter?.title;
    if (typeof title === "string") addAlias(title, tree.children);

    const byId = new Map(headings.map(({ slug, text }) => [slug, text]));
    const visit = (node) => {
      const text = byId.get(node.properties?.id);
      if (text && /^h[1-6]$/.test(node.tagName)) addAlias(text, node.children);
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
