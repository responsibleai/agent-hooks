// Copyright (c) Microsoft. All rights reserved.

import { fileURLToPath } from "node:url";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import type { Loader, LoaderContext } from "astro/loaders";
import { defineCollection } from "astro:content";
import { specPages } from "./spec.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const specDir = `${repositoryRoot}spec/`;
const docsDir = new URL("./content/docs/", import.meta.url);

/** Adds the specification texts under spec/ to the docs pages in src/content/docs/. */
function docsAndSpecLoader(): Loader {
  const docs = docsLoader();
  const loadSpec = async ({ store, parseData, renderMarkdown }: LoaderContext) => {
    for (const { id, title, body } of specPages(repositoryRoot)) {
      store.set({
        id,
        body,
        data: await parseData({ id, data: { title } }),
        // Render as if the page lived in docs/, so Starlight's heading links apply.
        rendered: await renderMarkdown(body, { fileURL: new URL(`${id}.md`, docsDir) }),
      });
    }
  };
  return {
    name: "agent-hooks-docs",
    async load(context) {
      await docs.load(context);
      await loadSpec(context);
      context.watcher?.add(specDir);
      context.watcher?.on("change", (path) => {
        if (path.startsWith(specDir) && path.endsWith(".md")) void loadSpec(context);
      });
    },
  };
}

export const collections = {
  docs: defineCollection({ loader: docsAndSpecLoader(), schema: docsSchema() }),
};
