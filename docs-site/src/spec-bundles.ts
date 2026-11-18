// Copyright (c) Microsoft. All rights reserved.

/**
 * Publishes the specification bundles in the docs site. For every
 * spec/<MAJOR.MINOR>/ folder and for spec/draft/ it writes, under
 * src/content/docs/:
 *
 *   spec/<version>.md  one page per released version, from AGENT-HOOKS-<version>.md
 *   spec/draft.md      the draft, from AGENT-HOOKS-DRAFT.md, its banner link
 *                      pointed at the version page beside it
 *   spec.md            the newest released version again, the stable "latest" URL
 *
 * and under public/:
 *
 *   schema/<path>      every *.schema.json under a bundle's schema/ (outside
 *                      src/ and examples/) at the path its own $id names
 *                      (schema/vX.Y/ for a release, schema/draft/ for the
 *                      draft); the inventories the bundle carries beside its
 *                      root schemas; and each conformance/<version>/vectors.schema.json
 *                      at its own $id path
 *
 * Nothing it writes is committed.
 *
 * A published path is immutable: two bundles may stage the same path only
 * with identical bytes, so a release that changes a schema must publish
 * under a new $id path (the generator's ID_BASE). Symbolic links anywhere
 * in a bundle fail the staging.
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
// The draft banner's link to a released text, rewritten to that
// version's page, which sits in the same site folder as the draft page.
const BACK_LINK = /\]\(\.\.\/((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\/AGENT-HOOKS-\1\.md\)/g;
export const INVENTORIES = [
  "reserved-reasons.json",
  "reserved-warnings.json",
  "declaration-errors.json",
] as const;
const SYMLINK = "is a symbolic link; specification bundles hold regular files only";

export const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Encode text that may reach a workflow log (percent, CR and LF). */
function escapeData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  return exists(path) && lstatSync(path).isSymbolicLink();
}

/** Released folder names, newest first. */
export function releasedVersions(specDir: string): string[] {
  return readdirSync(specDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && VERSION.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => {
      const [aMajor, aMinor] = a.split(".").map(Number);
      const [bMajor, bMinor] = b.split(".").map(Number);
      return bMajor - aMajor || bMinor - aMinor;
    });
}

/** The one specification text of a bundle: AGENT-HOOKS-<folder>.md, or AGENT-HOOKS-DRAFT.md for the draft. */
function specText(folder: string): string {
  const name = folder.split(/[\\/]/).pop();
  const expected = name === "draft" ? "AGENT-HOOKS-DRAFT.md" : `AGENT-HOOKS-${name}.md`;
  const files = readdirSync(folder)
    .filter((file) => file.startsWith("AGENT-HOOKS-") && file.endsWith(".md"))
    .sort();
  if (files.length !== 1 || files[0] !== expected) {
    throw new Error(`${folder} must contain exactly one specification text, ${expected}`);
  }
  const path = join(folder, expected);
  if (isSymlink(path)) throw new Error(`${path} ${SYMLINK}`);
  return path;
}

/** The path after /schema/ in the file's $id, such as draft/agent-context/input.schema.json. */
export function publishedPath(schemaFile: string): string {
  const identity = JSON.parse(readFileSync(schemaFile, "utf8")).$id;
  if (typeof identity !== "string") throw new Error(`${schemaFile} has no $id`);
  if (/[\x00-\x1f\x7f]/.test(identity)) {
    throw new Error(`${schemaFile}: $id contains control characters`);
  }
  let path: string;
  try {
    path = new URL(identity).pathname;
  } catch {
    throw new Error(`${schemaFile}: $id ${escapeData(identity)} is not an absolute URL`);
  }
  const marker = "/schema/";
  const index = path.indexOf(marker);
  if (index === -1) {
    throw new Error(`${schemaFile}: $id ${escapeData(identity)} has no /schema/ segment`);
  }
  const published = path.slice(index + marker.length);
  const parts = published.split("/");
  if (parts.length < 2 || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(
      `${schemaFile}: $id ${escapeData(identity)} does not name a file under a path`,
    );
  }
  return published;
}

/** Writes files under schema/ and keeps every published path immutable. */
class Publisher {
  readonly #staged = new Map<string, { origin: string; data: Buffer }>();
  readonly #schemaOut: string;

  constructor(schemaOut: string) {
    this.#schemaOut = schemaOut;
  }

  publish(source: string, published: string, origin: string): void {
    if (isSymlink(source)) throw new Error(`${source} ${SYMLINK}`);
    const data = readFileSync(source);
    const earlier = this.#staged.get(published);
    if (earlier && !earlier.data.equals(data)) {
      throw new Error(
        `${origin} and ${earlier.origin} both publish schema/${published} with different ` +
          "content; a published $id path is immutable, so the newer bundle must " +
          "publish under its own path (set ID_BASE in " +
          "spec/scripts/generate-schemas.mts before regenerating)",
      );
    }
    this.#staged.set(published, { origin, data });
    const target = join(this.#schemaOut, published);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

/**
 * Every *.schema.json under a bundle's schema/ folder, refusing symbolic
 * links on the way; src/ holds TypeSpec and examples/ hold instances, so
 * neither contributes a schema.
 */
function bundleSchemas(root: string): string[] {
  if (isSymlink(root)) throw new Error(`${root} ${SYMLINK}`);
  if (!exists(root)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${path} ${SYMLINK}`);
      if (entry.isFile() && entry.name.endsWith(".schema.json")) files.push(path);
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "src" && entry.name !== "examples") {
        walk(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return files.sort();
}

function stageSchemas(root: string, bundles: string[], schemaOut: string): void {
  const publisher = new Publisher(schemaOut);
  for (const name of bundles) {
    const bundle = join(root, "spec", name);
    const origin = `spec/${name}`;
    const prefixes = new Set<string>();
    for (const file of bundleSchemas(join(bundle, "schema"))) {
      const published = publishedPath(file);
      publisher.publish(file, published, origin);
      prefixes.add(published.split("/")[0]);
    }
    if (prefixes.size !== 1) {
      throw new Error(
        `${origin} schemas publish under ${JSON.stringify([...prefixes].sort())}; expected one path`,
      );
    }
    const [prefix] = prefixes;
    const grammar = join(bundle, "schema", "path-grammar.abnf");
    if (exists(grammar)) publisher.publish(grammar, `${prefix}/path-grammar.abnf`, origin);
    // A bundle carries the inventories of its time; 0.1 predates
    // reserved-warnings.json, so only the files present are published.
    for (const inventory of INVENTORIES) {
      const source = join(bundle, inventory);
      if (!exists(source)) continue;
      const published = publishedPath(source);
      if (published !== `${prefix}/${inventory}`) {
        throw new Error(
          `${origin}/${inventory}: $id names schema/${published}; the bundle ` +
            `publishes under schema/${prefix}/`,
        );
      }
      publisher.publish(source, published, origin);
    }
  }
  for (const name of bundles) {
    const vectors = join(root, "conformance", name, "vectors.schema.json");
    publisher.publish(vectors, publishedPath(vectors), `conformance/${name}/vectors.schema.json`);
  }
}

/** Moves the document's H1 into Starlight frontmatter without changing the source. */
function writePage(text: string, target: string, slug: string): void {
  const newline = text.indexOf("\n");
  const heading = newline === -1 ? text : text.slice(0, newline);
  const body = newline === -1 ? "" : text.slice(newline + 1);
  if (!heading.startsWith("# ")) {
    throw new Error(`${target}: specification text must start with an H1`);
  }
  // Explicit slugs keep the dots in version URLs such as spec/0.1/.
  const title = JSON.stringify(heading.slice(2));
  writeFileSync(target, `---\ntitle: ${title}\nslug: ${slug}\n---\n${body}`, "utf8");
}

/** Stages every bundle into the site and returns the released versions, newest first. */
export function stageSpecBundles(
  root: string = REPOSITORY_ROOT,
  site: string = join(root, "docs-site"),
): string[] {
  const spec = join(root, "spec");
  const docs = join(site, "src", "content", "docs");
  const versions = releasedVersions(spec);
  if (versions.length === 0) throw new Error("spec/ has no released MAJOR.MINOR folder");

  const pages = join(docs, "spec");
  rmSync(pages, { recursive: true, force: true });
  mkdirSync(pages, { recursive: true });
  for (const version of versions) {
    const text = readFileSync(specText(join(spec, version)), "utf8");
    writePage(text, join(pages, `${version}.md`), `spec/${version}`);
    if (version === versions[0]) writePage(text, join(docs, "spec.md"), "spec");
  }
  const draft = readFileSync(specText(join(spec, "draft")), "utf8")
    .replace(BACK_LINK, "]($1.md)")
    .replaceAll("](schema/path-grammar.abnf)", "](../../schema/draft/path-grammar.abnf)");
  writePage(draft, join(pages, "draft.md"), "spec/draft");

  const schemaOut = join(site, "public", "schema");
  rmSync(schemaOut, { recursive: true, force: true });
  // Oldest release first, the draft last, so a conflict names the bundle
  // that arrived later.
  stageSchemas(root, [...versions].reverse().concat("draft"), schemaOut);
  return versions;
}

/** Astro integration that stages the specification bundles before each dev or build run. */
export function specBundles(root: string = REPOSITORY_ROOT): AstroIntegration {
  return {
    name: "agent-hooks:spec-bundles",
    hooks: {
      "astro:config:setup": ({ config, logger }) => {
        const versions = stageSpecBundles(root, fileURLToPath(config.root));
        logger.info(
          `staged specification versions ${versions.join(", ")} and the draft; spec is ${versions[0]}`,
        );
      },
    },
  };
}
