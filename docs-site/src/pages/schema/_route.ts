// Copyright (c) Microsoft. All rights reserved.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { APIRoute } from "astro";
import { root } from "astro:config/server";
import { schemaFiles } from "../../spec.ts";

/**
 * Static paths for the published schema files with this extension. Each
 * route file name carries its extension so Astro serves it without a
 * trailing slash.
 */
export function schemaPaths(extension: ".json" | ".abnf") {
  return [...schemaFiles(fileURLToPath(new URL("../", root)))]
    .filter(([path]) => path.endsWith(extension))
    .map(([path, file]) => ({
      params: { path: path.slice(0, -extension.length) },
      props: { file },
    }));
}

/** Serves the source file byte for byte. */
export const GET: APIRoute = ({ props }) => new Response(readFileSync(props.file));
