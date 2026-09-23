import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCANNED = ["packages", "apps", "scripts", "docs", "fixtures"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", "coverage", ".scratch"]);
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".css", ".html"]);

/**
 * "Trojan Source" guard: bidirectional-control and invisible characters in source files make code
 * or test data read differently from what it is. Tests that need them must write `\u` escapes.
 */
const INVISIBLE = /[\u00A0\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF\u{E0000}-\u{E007F}]/u;

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        yield* files(full);
      }
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

describe("source hygiene", () => {
  it("no source file contains literal bidi or zero-width characters", async () => {
    const offenders: string[] = [];
    for (const top of SCANNED) {
      for await (const file of files(path.join(ROOT, top))) {
        const lines = (await readFile(file, "utf8")).split("\n");
        lines.forEach((line, i) => {
          if (INVISIBLE.test(line)) {
            offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
