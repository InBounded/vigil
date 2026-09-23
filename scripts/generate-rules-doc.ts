#!/usr/bin/env -S pnpm exec tsx
/**
 * Writes `docs/rules.md` from the rules' own metadata (`pnpm docs:rules`). A test fails when the
 * committed file differs from what this generates, so the documentation cannot drift.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderRulesMarkdown } from "../packages/core/src/rules/docs.js";
import { RULES } from "../packages/core/src/rules/engine.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.join(repoRoot, "docs/rules.md");

await writeFile(outPath, renderRulesMarkdown(RULES));
console.log(`Wrote ${RULES.length} rules to ${outPath}`);
