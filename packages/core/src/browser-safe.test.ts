/**
 * The web app bundles `@vigil-sol/core`'s main entry for the browser, so no module reachable from
 * `src/index.ts` may import a Node built-in. Node-only helpers live behind `@vigil-sol/core/node`.
 */
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
// `import type` / `export type` statements are erased by the compiler and load nothing.
const IMPORT =
  /(?:^|\n)\s*(?:import|export)\s(?!type\s)[^;]*?from\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)/g;
const NODE_BUILTINS = new Set(builtinModules);

function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(IMPORT)].flatMap((match) => {
    const specifier = match[1] ?? match[2];
    return specifier === undefined ? [] : [specifier];
  });
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier.split("/")[0] ?? "");
}

/** Every source file reachable from `entry` through relative imports, with its bare imports. */
function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) {
      continue;
    }
    const all = specifiers(file);
    seen.set(
      file,
      all.filter((specifier) => !specifier.startsWith(".")),
    );
    for (const specifier of all.filter((s) => s.startsWith("."))) {
      const target = resolve(dirname(file), specifier);
      queue.push(target.endsWith(".js") ? `${target.slice(0, -3)}.ts` : target);
    }
  }
  return seen;
}

describe("browser safety of the main entry", () => {
  it("reaches no Node built-in module from src/index.ts", () => {
    const graph = reachable(resolve(SRC, "index.ts"));
    expect(graph.size).toBeGreaterThan(50);
    const offenders = [...graph].flatMap(([file, imports]) =>
      imports.filter(isNodeBuiltin).map((specifier) => `${file}: ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the Node-only file loaders on the node entry", () => {
    const graph = reachable(resolve(SRC, "node.ts"));
    const nodeImports = [...graph.values()].flat().filter(isNodeBuiltin);
    expect(nodeImports).toContain("node:fs/promises");
  });
});
