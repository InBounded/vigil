#!/usr/bin/env -S pnpm exec tsx
/**
 * Records real answers of the program-verification API (`GET https://verify.osec.io/status/<id>`)
 * verbatim — HTTP status and body text — through Vigil's own `FetchHttpClient` (allowlisted host
 * only), into `fixtures/http/`, so verification tests replay real responses offline.
 *
 * Usage: pnpm exec tsx scripts/capture-verification.ts --name <file> --description "..." \
 *          --programs A,B,C
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { address } from "@solana/kit";
import { FetchHttpClient } from "../packages/core/src/io/http.js";
import { VERIFICATION_API } from "../packages/core/src/programs/verification.js";

const { values } = parseArgs({
  options: {
    description: { type: "string" },
    name: { type: "string" },
    programs: { type: "string" },
  },
});
if (!values.name || !values.description || !values.programs) {
  throw new Error("--name, --description and --programs are required");
}
const http = new FetchHttpClient();
const responses: Record<string, { status: number; text: string }> = {};
for (const program of values.programs.split(",").map((p) => address(p.trim()))) {
  const response = await http.get(`${VERIFICATION_API}${program}`, {
    maxBytes: 64 * 1024,
    timeoutMs: 8_000,
  });
  responses[program] = response;
  console.log(program, response.status, response.text);
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "http");
await mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, `${values.name}.json`);
await writeFile(
  outPath,
  `${JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      description: values.description,
      endpoint: VERIFICATION_API,
      responses,
    },
    null,
    2,
  )}\n`,
);
console.log(`Wrote ${outPath}`);
