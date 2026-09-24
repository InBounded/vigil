/**
 * The built binary (`dist/bin.js`, what `npx @vigil-sol/cli` runs), spawned as a separate process
 * with real pipes. `vigil decode --json … | jq .verdict` is checked by parsing stdout here, so CI
 * does not need jq (maintainer decision). `pnpm check` builds before it tests.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadFixtureFile } from "@vigil-sol/core/node";
import { beforeAll, describe, expect, it } from "vitest";
import { BATCH_MULTISIG, FIXTURES, fixtureEnv, UPGRADE_MULTISIG } from "./test-support/harness.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

interface Spawned {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function vigil(
  args: readonly string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<Spawned> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, ...args],
      // A clean environment: nothing from the developer's shell (no real RPC URL) leaks in.
      { env: { PATH: process.env.PATH ?? "", ...env }, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ code, stderr, stdout });
      },
    );
    child.stdin?.end(stdin ?? "");
  });
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} does not exist: run pnpm build first (pnpm check does)`);
  }
});

describe("the built vigil binary", () => {
  it("vigil decode --json | jq .verdict", async () => {
    const result = await vigil(
      ["decode", BATCH_MULTISIG, "2268", "--json"],
      fixtureEnv("list-batch-drafts"),
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { verdict: string }).verdict).toBe("attention");
  });

  it("exits 2 on a critical finding, with the report still on stdout", async () => {
    const result = await vigil(
      ["decode", UPGRADE_MULTISIG, "4", "--json"],
      fixtureEnv("upgrade-proposal"),
    );
    expect(result.code).toBe(2);
    expect((JSON.parse(result.stdout) as { verdict: string }).verdict).toBe("critical");
  });

  it("reads a transaction from a real stdin pipe", async () => {
    const data = await loadFixtureFile(`${FIXTURES}raw-usdc-transfer.json`);
    const [tx] = data.transactions.values();
    const result = await vigil(
      ["decode", "--tx", "-", "--json"],
      fixtureEnv("raw-usdc-transfer"),
      `${tx?.transactionBase64 ?? ""}\n`,
    );
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { input: { kind: string } }).input.kind).toBe(
      "raw-transaction",
    );
  });

  it("writes plain text to a pipe: no colour, no progress", async () => {
    const result = await vigil(["decode", BATCH_MULTISIG, "2268"], fixtureEnv("list-batch-drafts"));
    expect(result.stdout).toContain("⚠ NEEDS ATTENTION");
    expect(result.stdout).not.toContain(String.fromCharCode(27));
    expect(result.stderr).toBe("");
  });

  it("stops quietly when the reader closes the pipe (vigil … | head)", async () => {
    const result = await new Promise<Spawned>((resolve) => {
      const child = execFile(
        process.execPath,
        [BIN, "decode", BATCH_MULTISIG, "2268", "--verbose"],
        { env: { PATH: process.env.PATH ?? "", ...fixtureEnv("list-batch-drafts") } },
        (error, _stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
          resolve({ code, stderr, stdout: "" });
        },
      );
      child.stdout?.destroy();
    });
    expect(result.stderr).not.toContain("EPIPE");
    expect(result.code).toBe(0);
  });

  it("--version prints the package version; invalid input exits 3", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(await vigil(["--version"], {})).toEqual({
      code: 0,
      stderr: "",
      stdout: `${pkg.version}\n`,
    });
    const bad = await vigil(["decode", "nope", "1"], {});
    expect(bad.code).toBe(3);
    expect(bad.stderr).toMatch(/^error: /);
  });
});
