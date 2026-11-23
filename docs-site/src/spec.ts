// Copyright (c) Microsoft. All rights reserved.

/**
 * Reads the specification bundles under spec/ for the docs site, without
 * copying them: content.config.ts turns specPages() into docs entries and
 * src/pages/schema/[...path].ts serves schemaFiles() at their $id URLs.
 *
 * A published schema path is immutable: two bundles may publish the same
 * path only with identical bytes, so a release that changes a schema must
 * publish under a new $id path (the TypeSpec @baseUri).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ID_BASE = "https://responsibleai.github.io/agent-hooks/schema/";

/** Released bundle folders (spec/<MAJOR.MINOR>/), newest first. */
export function releasedVersions(root: string): string[] {
  return readdirSync(join(root, "spec"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => {
      const [aMajor, aMinor] = a.split(".").map(Number);
      const [bMajor, bMinor] = b.split(".").map(Number);
      return bMajor - aMajor || bMinor - aMinor;
    });
}

export interface SpecPage {
  id: string;
  title: string;
  body: string;
}

/**
 * One page per released version, the newest again at the stable `spec` URL,
 * and the draft. The H1 becomes the page title so Starlight renders it once.
 */
export function specPages(root: string): SpecPage[] {
  const read = (bundle: string) =>
    readFileSync(
      join(root, "spec", bundle, `AGENT-HOOKS-${bundle === "draft" ? "DRAFT" : bundle}.md`),
      "utf8",
    );
  const page = (id: string, text: string): SpecPage => {
    const match = /^# (.+)\n([\s\S]*)$/.exec(text);
    if (!match) throw new Error(`${id}: the specification text must start with an H1`);
    return { id, title: match[1], body: match[2] };
  };
  const versions = releasedVersions(root);
  if (versions.length === 0) throw new Error("spec/ has no released MAJOR.MINOR folder");
  // The draft links to source files beside it; point them at the published pages.
  const draft = read("draft")
    .replace(/\]\(\.\.\/(\d+\.\d+)\/AGENT-HOOKS-\1\.md\)/g, "](../$1/)")
    .replaceAll("](schema/path-grammar.abnf)", "](../../schema/draft/path-grammar.abnf)");
  return [
    page("spec", read(versions[0])),
    ...versions.map((version) => page(`spec/${version}`, read(version))),
    page("spec/draft", draft),
  ];
}

/**
 * Maps each published path under /schema/ to its source file: every JSON
 * document with an $id in a bundle (outside src/ and examples/), each
 * conformance/<bundle>/vectors.schema.json, and the bundle's path grammar.
 */
export function schemaFiles(root: string): Map<string, string> {
  const published = new Map<string, string>();
  const publish = (path: string, file: string) => {
    const earlier = published.get(path);
    if (earlier && !readFileSync(earlier).equals(readFileSync(file))) {
      throw new Error(
        `${relative(root, file)} and ${relative(root, earlier)} both publish schema/${path} ` +
          "with different content; a published $id path is immutable, so set the TypeSpec " +
          "@baseUri before regenerating",
      );
    }
    published.set(path, file);
  };
  const publishById = (file: string): string | undefined => {
    const id: unknown = JSON.parse(readFileSync(file, "utf8")).$id;
    if (typeof id !== "string") return undefined;
    const path = id.startsWith(ID_BASE) ? id.slice(ID_BASE.length) : "";
    const segments = path.split("/");
    const valid =
      /^[\w.-]+(\/[\w.-]+)+\.json$/.test(path) && !segments.some((s) => s === "." || s === "..");
    if (!valid) {
      throw new Error(`${relative(root, file)}: $id must name a .json file under ${ID_BASE}`);
    }
    publish(path, file);
    return segments[0];
  };

  // Oldest release first and the draft last, so a conflict names the later bundle.
  for (const bundle of [...releasedVersions(root).reverse(), "draft"]) {
    const folder = join(root, "spec", bundle);
    const prefixes = new Set<string>();
    for (const name of readdirSync(folder, { recursive: true, encoding: "utf8" }).sort()) {
      if (name.endsWith(".json") && !/(^|[\\/])(src|examples)[\\/]/.test(name)) {
        const prefix = publishById(join(folder, name));
        if (prefix) prefixes.add(prefix);
      }
    }
    if (prefixes.size !== 1) {
      throw new Error(
        `spec/${bundle} publishes under ${JSON.stringify([...prefixes].sort())}; expected one path`,
      );
    }
    const [prefix] = prefixes;
    const grammar = join(folder, "schema", "path-grammar.abnf");
    if (existsSync(grammar)) publish(`${prefix}/path-grammar.abnf`, grammar);
    publishById(join(root, "conformance", bundle, "vectors.schema.json"));
  }
  return published;
}
