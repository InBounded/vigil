/**
 * Acceptance criterion: no secret appears in any output. RPC URLs with API keys in the path, the
 * query string and the credentials are configured through the environment, every command runs in
 * every output mode (and through its failure paths), and nothing written to stdout or stderr may
 * contain any part of a key. Only the host may be shown.
 */
import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { FixtureRpcClient, loadFixtureFile } from "@vigil-sol/core";
import { describe, expect, it } from "vitest";
import { Redactor } from "./secrets.js";
import {
  BATCH_MULTISIG,
  BATCH_VAULT,
  FIXTURES,
  fixtureEnv,
  OPAQUE_MULTISIG,
  type RunResult,
  run,
  SQUADS_PROGRAM,
  UPGRADE_MULTISIG,
} from "./test-support/harness.js";

const KEYS = [
  "PATHKEY-5f0c9e1a-77d2-4b8e-9a1c-3f6e2b9d0c11",
  "QUERYKEY9d8c7b6a5f4e3d2c1b0a",
  "CREDPASSWORD0123456789",
  "CROSSPATHKEYabcdef0123456789",
  "CROSSQUERYKEY9876543210zyx",
];
const PRIMARY = `https://rpc.provider.example/v2/${KEYS[0]}?api-key=${KEYS[1]}`;
const SECONDARY = `https://user:${KEYS[2]}@second.provider.example/${KEYS[3]}?token=${KEYS[4]}`;

function expectNoSecret(result: RunResult, what: string): void {
  const all = `${result.stdout}\n${result.stderr}`;
  for (const key of KEYS) {
    expect(all, `${what}: leaked ${key}`).not.toContain(key);
  }
  expect(all, what).not.toContain(PRIMARY);
  expect(all, what).not.toContain("user:");
}

const secretEnv = (base: Record<string, string>) => ({
  ...base,
  VIGIL_CROSS_CHECK_RPC_URL: SECONDARY,
  VIGIL_RPC_URL: PRIMARY,
});

describe("no secret appears in any output", () => {
  const BATCH = secretEnv(fixtureEnv("list-batch-drafts"));
  const UPGRADE = secretEnv(fixtureEnv("upgrade-proposal"));
  const OPAQUE = secretEnv(fixtureEnv("opaque-proposal"));
  const RAW = secretEnv(fixtureEnv("raw-usdc-transfer"));

  const invocations: [string, readonly string[], Record<string, string>][] = [
    ["decode", ["decode", BATCH_MULTISIG, "2268", "--history", "150"], BATCH],
    ["decode critical", ["decode", UPGRADE_MULTISIG, "4"], UPGRADE],
    ["decode incomplete", ["decode", OPAQUE_MULTISIG, "352"], OPAQUE],
    ["decode missing index", ["decode", BATCH_MULTISIG, "999999"], BATCH],
    ["decode vault", ["decode", BATCH_VAULT, "1"], BATCH],
    ["list", ["list", BATCH_MULTISIG, "--limit", "6", "--status", "all"], BATCH],
    ["verify", ["verify", SQUADS_PROGRAM], UPGRADE],
    ["verify not a program", ["verify", BATCH_VAULT], BATCH],
    ["rules", ["rules"], BATCH],
    ["explain", ["explain", "VGL-C012"], BATCH],
    ["watch", ["watch", BATCH_MULTISIG], BATCH],
    ["help", ["--help"], BATCH],
  ];
  for (const [what, argv, env] of invocations) {
    for (const mode of [[], ["--json"], ["--verbose"], ["--lang", "pt", "--verbose"]]) {
      it(`${what} ${mode.join(" ")}`, async () => {
        const result = await run([...argv, ...mode], { env, stderrTTY: true, stdoutTTY: true });
        expectNoSecret(result, `${what} ${mode.join(" ")}`);
      });
    }
  }

  it("raw transaction from stdin, with progress on a terminal", async () => {
    const data = await loadFixtureFile(`${FIXTURES}raw-usdc-transfer.json`);
    const [tx] = data.transactions.values();
    const result = await run(["decode", "--tx", "-", "--verbose"], {
      env: RAW,
      stderrTTY: true,
      stdin: tx?.transactionBase64 ?? "",
    });
    expect(result.code).toBe(0);
    expectNoSecret(result, "raw");
  });

  it("the report shows the RPC host only", async () => {
    const result = await run(["decode", BATCH_MULTISIG, "2268", "--json"], { env: BATCH });
    expect((JSON.parse(result.stdout) as { rpcHost: string }).rpcHost).toBe("rpc.provider.example");
    expect(result.stdout).toContain('"rpcHost": "rpc.provider.example"');
  });

  it("an RPC error that echoes the URL (as a transport library might) is never printed", async () => {
    const data = await loadFixtureFile(`${FIXTURES}list-batch-drafts.json`);
    const failing = () => {
      const client = new FixtureRpcClient(data);
      client.getGenesisHash = () =>
        Promise.reject(
          new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
            headers: new Headers(),
            message: `Unauthorized: ${PRIMARY}`,
            statusCode: 401,
          }),
        );
      client.getMultipleAccounts = () => Promise.reject(new Error(`fetch failed for ${PRIMARY}`));
      return client;
    };
    for (const argv of [
      ["decode", BATCH_MULTISIG, "2268"],
      ["list", BATCH_MULTISIG],
      ["verify", SQUADS_PROGRAM],
    ]) {
      const result = await run(argv, { env: BATCH, rpc: failing });
      expect(result.code).toBe(3);
      expectNoSecret(result, argv.join(" "));
    }
    const decode = await run(["decode", BATCH_MULTISIG, "2268"], { env: BATCH, rpc: failing });
    expect(decode.stderr).toContain("the endpoint answered HTTP 401");
  });

  it("an unexpected error message containing the URL is redacted", async () => {
    const result = await run(["decode", BATCH_MULTISIG, "2268"], {
      env: BATCH,
      rpc: () => {
        throw new TypeError(`Invalid URL ${PRIMARY} and ${SECONDARY}`);
      },
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("Unexpected failure (TypeError)");
    expect(result.stderr).toContain("[redacted]");
    expectNoSecret(result, "unexpected");
  });

  it("refuses an RPC URL with a key in a flag, and does not echo it", async () => {
    for (const [flag, variable] of [
      ["--rpc", "VIGIL_RPC_URL"],
      ["--cross-check-rpc", "VIGIL_CROSS_CHECK_RPC_URL"],
    ] as const) {
      for (const url of [PRIMARY, SECONDARY, `https://rpc.provider.example/${KEYS[0]}`]) {
        const result = await run(["decode", BATCH_MULTISIG, "2268", flag, url], {
          env: fixtureEnv("list-batch-drafts"),
        });
        expect(result.code).toBe(3);
        expect(result.stderr).toContain(`set ${variable} instead`);
        expectNoSecret(result, flag);
        expect(result.rpcUrls).toEqual([]);
      }
    }
  });

  it("accepts a plain endpoint in --rpc", async () => {
    const result = await run(
      ["decode", BATCH_MULTISIG, "2268", "--rpc", "https://plain.example.com", "--json"],
      { env: fixtureEnv("list-batch-drafts") },
    );
    expect(result.rpcUrls).toEqual(["https://plain.example.com/"]);
    expect((JSON.parse(result.stdout) as { rpcHost: string }).rpcHost).toBe("plain.example.com");
  });
});

describe("Redactor", () => {
  it("removes whole URLs and each secret-looking part, but not common short words", () => {
    const redactor = new Redactor();
    redactor.add(PRIMARY);
    redactor.add(undefined);
    redactor.add("");
    redactor.add("https://mainnet.example.com/mainnet");
    expect(redactor.scrub(`a ${PRIMARY} b`)).toBe("a [redacted] b");
    expect(redactor.scrub(`key ${KEYS[0]} and ${KEYS[1]}`)).toBe("key [redacted] and [redacted]");
    expect(redactor.scrub("mainnet via mainnet.example.com")).toBe(
      "mainnet via mainnet.example.com",
    );
    const encoded = new Redactor();
    encoded.add("https://u:p%40ssw0rd-long-secret@host.example/");
    expect(encoded.scrub("p@ssw0rd-long-secret")).toBe("[redacted]");
    const notUrl = new Redactor();
    notUrl.add("not a url at all");
    expect(notUrl.scrub("x not a url at all y")).toBe("x [redacted] y");
  });
});
