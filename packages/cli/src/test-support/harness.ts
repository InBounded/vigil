/**
 * Runs the CLI in-process against real captured fixtures, through the same test-only
 * `VIGIL_TEST_FIXTURES` mechanism the binary uses (`fixture-mode.ts`). Not shipped.
 */
import { fileURLToPath } from "node:url";
import type { RpcClient } from "@vigil-sol/core";
import type { CliEnvironment } from "../environment.js";
import { fixtureMode } from "../fixture-mode.js";
import { main } from "../main.js";

export const FIXTURES = fileURLToPath(new URL("../../../../fixtures/cli/", import.meta.url));

export const BATCH_MULTISIG = "81S2mzdgrTGVjHHiJGiN2bCt8hjaiBvoNqVmYyRVzuJf";
export const UPGRADE_MULTISIG = "DQnoxvJiAYUeB5Ahp5VbsaMGMmJUA5Jr5b1nnJ2ANeMG";
export const OPAQUE_MULTISIG = "3gjeSqMDqip2uLALaeFoGN3PmNx1tuY1y6S9qVxLyVJt";
export const SQUADS_PROGRAM = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
/** Vault #0 of `BATCH_MULTISIG` (a system account, not a multisig or a program). */
export const BATCH_VAULT = "HH6dXisw1Lin1k8c1y2h6cWNoFopV59kHrwQAK6fZVCh";
export const NOW = "2026-09-23T12:00:00.000Z";

export type FixtureName =
  | "list-batch-drafts"
  | "upgrade-proposal"
  | "opaque-proposal"
  | "raw-usdc-transfer";

const GZIPPED = new Set<FixtureName>(["upgrade-proposal", "opaque-proposal"]);

export function fixtureEnv(name: FixtureName): Record<string, string> {
  return {
    NODE_ENV: "test",
    VIGIL_TEST_FIXTURES: `${FIXTURES}${name}.json${GZIPPED.has(name) ? ".gz" : ""}`,
    VIGIL_TEST_HTTP_FIXTURE: `${FIXTURES}${name}.http.json`,
    VIGIL_TEST_NOW: NOW,
  };
}

export interface RunOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
  readonly stdoutTTY?: boolean;
  readonly stderrTTY?: boolean;
  readonly columns?: number;
  /** Replaces the fixture RPC (e.g. one that fails). */
  readonly rpc?: (url: string) => RpcClient;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** URLs the CLI asked for an RPC client for. */
  readonly rpcUrls: readonly string[];
}

export async function run(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const env = options.env ?? {};
  const fixtures = await fixtureMode(env);
  let stdout = "";
  let stderr = "";
  const rpcUrls: string[] = [];
  const environment: CliEnvironment = {
    clock: fixtures?.clock ?? { now: () => Date.parse(NOW) },
    createHttp:
      fixtures?.createHttp ??
      (() => ({ get: () => Promise.reject(new Error("no HTTP in this test")) })),
    createRpc: (url) => {
      rpcUrls.push(url);
      if (options.rpc !== undefined) {
        return options.rpc(url);
      }
      if (fixtures === undefined) {
        throw new Error("no fixtures configured for this test");
      }
      return fixtures.createRpc(url);
    },
    env,
    readStdin: (maxBytes) => {
      const text = options.stdin ?? "";
      return Buffer.byteLength(text) > maxBytes
        ? Promise.reject(new Error(`more than ${maxBytes} bytes`))
        : Promise.resolve(text);
    },
    stderr: {
      columns: options.columns ?? 80,
      isTTY: options.stderrTTY ?? false,
      write: (text) => {
        stderr += text;
      },
    },
    stdout: {
      columns: options.columns ?? 80,
      isTTY: options.stdoutTTY ?? false,
      write: (text) => {
        stdout += text;
      },
    },
    version: "0.0.0-test",
  };
  const code = await main(argv, environment);
  return { code, rpcUrls, stderr, stdout };
}

/** Visible width of a line (ANSI escapes removed). */
export function visibleLength(line: string): number {
  // The escape character is built from its code, never written literally in the source.
  const esc = String.fromCharCode(27);
  return [...line.split(new RegExp(`${esc}\\[[0-9;]*m`)).join("")].length;
}
