#!/usr/bin/env tsx
// Copyright (c) Microsoft. All rights reserved.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));

export function escapeWorkflowCommandData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function files(directory: string): string[] {
  return existsSync(directory)
    ? readdirSync(directory, { recursive: true }).map(String).filter((name) => name.endsWith(".json")).sort()
    : [];
}

function main(): number {
  const args = process.argv.slice(2);
  const specIndex = args.indexOf("--spec");
  const spec = specIndex < 0 ? "draft" : args[specIndex + 1];
  if (!spec || (spec !== "draft" && !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(spec))) {
    throw new Error("--spec must name draft or a MAJOR.MINOR version");
  }
  const schema = resolve(directory, "..", spec, "schema");
  if (!existsSync(join(schema, "src/main.tsp"))) {
    execFileSync(process.execPath, ["--import", "tsx", join(directory, "generate-legacy-schemas.mts"), ...args], { stdio: "inherit" });
    return 0;
  }
  if (args.some((arg, index) => arg !== "--check" && arg !== "--spec" && !(specIndex >= 0 && index === specIndex + 1))) {
    throw new Error("usage: generate-schemas.mts [--check] [--spec draft|MAJOR.MINOR]");
  }
  const output = join(schema, "generated");
  const temporary = mkdtempSync(join(tmpdir(), "agent-hooks-schema-"));
  const check = args.includes("--check");
  try {
    execFileSync(process.execPath, [
      join(directory, "node_modules/@typespec/compiler/cmd/tsp.js"),
      "compile", join(directory, "schema-emitter.tsp"),
      "--import", join(schema, "src/main.tsp"),
      "--config", join(schema, "tspconfig.yaml"),
      ...(check ? ["--output-dir", temporary] : []),
    ], { stdio: "inherit" });
    if (!check) return 0;
    const expected = files(temporary);
    if (expected.length === 0) throw new Error("TypeSpec emitted no schemas");
    let failing = 0;
    for (const file of new Set([...expected, ...files(output)])) {
      const generated = join(temporary, file);
      const committed = join(output, file);
      if (!existsSync(generated) || !existsSync(committed) ||
          readFileSync(generated, "utf8") !== readFileSync(committed, "utf8")) {
        console.error(`::error::${escapeWorkflowCommandData(join(output, file))} differs from native TypeSpec output; run npm run generate:schema`);
        failing++;
      }
    }
    console.log(`generate-schemas --check: ${expected.length} files generated, ${failing} failing`);
    return failing ? 1 : 0;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
