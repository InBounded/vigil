#!/usr/bin/env -S pnpm exec tsx
/**
 * Regenerates the Squads v4 client from the committed IDL (`packages/core/idl/`) using Codama.
 * The generated output is committed at `packages/core/src/squads/generated/` — re-run this
 * script and review the diff whenever the IDL is updated, rather than hand-editing the output.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";
import { createFromRoot } from "codama";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const idlPath = path.join(repoRoot, "packages/core/idl/squads_multisig_program.json");
const outDir = path.join(repoRoot, "packages/core/src/squads/generated");

async function main(): Promise<void> {
  const idlJson = JSON.parse(await readFile(idlPath, "utf8"));
  const codama = createFromRoot(rootNodeFromAnchor(idlJson));
  codama.accept(
    renderVisitor(outDir, {
      deleteFolderBeforeRendering: true,
      generatedFolder: ".",
      importExtension: "js",
      syncPackageJson: false,
    }),
  );
  console.log(`Generated Squads v4 client at ${outDir}`);
}

await main();
