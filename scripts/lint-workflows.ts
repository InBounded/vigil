#!/usr/bin/env -S pnpm exec tsx
/**
 * Runs actionlint (https://github.com/rhysd/actionlint) on the repository's workflows and on the
 * example workflows in `examples/github-actions/`. actionlint is a single Go binary, not an npm
 * package: CI downloads a pinned release and checks its SHA-256 (see `.github/workflows/ci.yml`),
 * then sets `ACTIONLINT` and `VIGIL_REQUIRE_ACTIONLINT=1`. Locally it uses `$ACTIONLINT` or
 * `actionlint` on the PATH, and prints a visible "skipped" line when neither exists.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflows = [".github/workflows", "examples/github-actions"].flatMap((dir) =>
  readdirSync(path.join(root, dir))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => path.join(dir, name)),
);

const binary = process.env.ACTIONLINT ?? "actionlint";
const probe = spawnSync(binary, ["-version"], { encoding: "utf8" });
if (probe.error !== undefined || probe.status !== 0) {
  if (process.env.VIGIL_REQUIRE_ACTIONLINT === "1") {
    console.error("actionlint: not found, and VIGIL_REQUIRE_ACTIONLINT=1 (CI) requires it");
    process.exit(1);
  }
  console.log(
    `actionlint: SKIPPED (not installed; CI runs it). ${workflows.length} workflow files not linted.`,
  );
  process.exit(0);
}

const version = probe.stdout.split("\n")[0];
const result = spawnSync(binary, workflows, { cwd: root, encoding: "utf8", stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
console.log(`actionlint ${version}: ${workflows.length} workflow files OK`);
