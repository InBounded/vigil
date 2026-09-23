/**
 * `vigil decode` end to end, in-process, on real mainnet data captured by running the same
 * analysis live (`fixtures/cli/`, see docs/DECISIONS.md). Balances are current at capture time.
 */
import { address } from "@solana/kit";
import {
  analyzeProposal,
  analyzeRawTransaction,
  CATALOGS,
  loadFixtureFile,
  serializeReport,
} from "@vigil-sol/core";
import { describe, expect, it } from "vitest";
import { fixtureMode } from "./fixture-mode.js";
import {
  BATCH_MULTISIG,
  BATCH_VAULT,
  FIXTURES,
  fixtureEnv,
  OPAQUE_MULTISIG,
  run,
  UPGRADE_MULTISIG,
  visibleLength,
} from "./test-support/harness.js";

const BATCH = fixtureEnv("list-batch-drafts");
const UPGRADE = fixtureEnv("upgrade-proposal");
const OPAQUE = fixtureEnv("opaque-proposal");
const RAW = fixtureEnv("raw-usdc-transfer");

/** Output with line wrapping undone, to look for a whole sentence. */
const flat = (text: string) => text.replace(/\s+/g, " ");
/** A line without ANSI styling. */
const plain = (line: string) =>
  line.split(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`)).join("");

async function rawBase64(): Promise<string> {
  const data = await loadFixtureFile(`${FIXTURES}raw-usdc-transfer.json`);
  const [tx] = data.transactions.values();
  if (tx === undefined) {
    throw new Error("fixture incomplete");
  }
  return tx.transactionBase64;
}

describe("vigil decode <multisig> <index>", () => {
  it("prints the verdict first, then findings, effects, balance changes and programs", async () => {
    const { code, stdout, stderr } = await run(["decode", BATCH_MULTISIG, "2268"], { env: BATCH });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const lines = stdout.split("\n");
    const verdictLine = lines.findIndex((line) => line.startsWith("⚠ NEEDS ATTENTION"));
    const order = [
      verdictLine,
      lines.indexOf("Findings (5)"),
      lines.indexOf("What this proposal does"),
      lines.indexOf("Balance changes if executed now"),
      lines.indexOf("Programs (2)"),
    ];
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Only the header comes before the verdict.
    expect(
      lines
        .slice(0, verdictLine)
        .every((line) => line === "" || line.startsWith("Vigil ·") || line.startsWith("  ")),
    ).toBe(true);
    // Findings by severity: every warning before every info.
    const severities = lines
      .filter((l) => /^ {2}[✖⚠ℹ] /.test(l))
      .map((l) => l.trim().split(" ")[1]);
    expect(severities).toEqual(["WARNING", "WARNING", "WARNING", "INFO", "INFO"]);
  });

  it("shows every address in full, never shortened", async () => {
    const { stdout } = await run(["decode", BATCH_MULTISIG, "2268"], { env: BATCH });
    expect(stdout).not.toContain("…");
    expect(stdout).toContain(BATCH_MULTISIG);
    expect(stdout).toContain(`Vault #0 (${BATCH_VAULT})`);
    expect(stdout).toContain("HzN7EsAb2WFqUTG2bErPbRLA6ifC6KPp7gPHu3RmYrQS");
  });

  it("frames the snapshot note above every balance change, even when a simulation failed", async () => {
    const { stdout } = await run(["decode", BATCH_MULTISIG, "2268"], { env: BATCH });
    const lines = stdout.split("\n");
    const heading = lines.indexOf("Balance changes if executed now");
    expect(lines[heading + 1]).toMatch(/^ {2}┌ ⚠ SNAPSHOT, NOT A GUARANTEE ─+$/);
    expect(lines[heading + 2]).toMatch(/^ {2}│ Snapshot of one moment:/);
    const boxEnd = lines.findIndex((line, i) => i > heading && line.startsWith("  └"));
    const firstChange = lines.findIndex((line) => /^ +[+-][0-9]/.test(line));
    expect(boxEnd).toBeGreaterThan(heading);
    expect(firstChange).toBeGreaterThan(boxEnd);
    expect(stdout).toContain("The simulation failed:");
    expect(stdout).toContain(
      "-20,000 USDC (token account C8WeFFWibqw2VaawLr9oo4FwLYqJJNatkiEoE8BAsAgN)",
    );
  });

  it("is readable without colour and uses colour only on a terminal", async () => {
    const esc = String.fromCharCode(27);
    const plain = await run(["decode", BATCH_MULTISIG, "2268"], { env: BATCH });
    expect(plain.stdout).not.toContain(esc);
    const tty = await run(["decode", BATCH_MULTISIG, "2268"], { env: BATCH, stdoutTTY: true });
    expect(tty.stdout).toContain(`${esc}[`);
    const noColor = await run(["decode", BATCH_MULTISIG, "2268"], {
      env: { ...BATCH, NO_COLOR: "1" },
      stdoutTTY: true,
    });
    expect(noColor.stdout).not.toContain(esc);
    // Same words with and without colour.
    expect(noColor.stdout).toBe(plain.stdout);
  });

  it("fits a narrow terminal: no line is wider than 40 columns unless it is one unbreakable word", async () => {
    const { stdout } = await run(["decode", BATCH_MULTISIG, "2268", "--verbose"], {
      columns: 40,
      env: BATCH,
      stdoutTTY: true,
    });
    const tooWide = stdout
      .split("\n")
      .filter((line) => visibleLength(line) > 40)
      // Words (addresses, hashes, URLs) are never split, so one may overflow on its own line.
      .filter((line) => plain(line).trim().includes(" "));
    expect(tooWide).toEqual([]);
    expect(stdout).toContain("SNAPSHOT, NOT A GUARANTEE");
  });

  it("speaks European Portuguese with --lang pt", async () => {
    const { stdout } = await run(["decode", BATCH_MULTISIG, "2268", "--lang", "pt"], {
      env: BATCH,
    });
    expect(stdout).toContain("⚠ REQUER ATENÇÃO");
    expect(stdout).toContain("O que esta proposta faz");
    expect(stdout).toContain("RETRATO DE UM MOMENTO, NÃO UMA GARANTIA");
    expect(stdout).toContain("-20\u00A0000 USDC");
  });

  it("takes the language from LANG when --lang is not given", async () => {
    const { stdout } = await run(["decode", BATCH_MULTISIG, "2268"], {
      env: { ...BATCH, LANG: "pt_PT.UTF-8" },
    });
    expect(stdout).toContain("Resultados (5)");
  });

  it("--verbose adds accounts, evidence and program details", async () => {
    const { stdout } = await run(["decode", BATCH_MULTISIG, "2268", "--verbose"], { env: BATCH });
    expect(stdout).toContain("Accounts:");
    expect(stdout).toContain(`from: ${BATCH_VAULT}`);
    expect(stdout).toContain("loader: ");
  });

  it("--json writes exactly the serialized AnalysisReport and nothing else", async () => {
    const { code, stdout, stderr } = await run(
      ["decode", BATCH_MULTISIG, "2268", "--json", "--history", "150"],
      { env: BATCH },
    );
    const fixtures = await fixtureMode(BATCH);
    if (fixtures === undefined) {
      throw new Error("fixture mode off");
    }
    const expected = await analyzeProposal(
      {
        clock: fixtures.clock ?? { now: () => 0 },
        http: fixtures.createHttp(),
        rpc: fixtures.createRpc(""),
        rpcHost: "api.mainnet-beta.solana.com",
      },
      { multisig: address(BATCH_MULTISIG), transactionIndex: 2268n },
      { rules: { historyDepth: 150 } },
    );
    expect(stdout).toBe(`${serializeReport(expected)}\n`);
    expect(stderr).toBe("");
    expect((JSON.parse(stdout) as { verdict: string }).verdict).toBe("attention");
    expect(code).toBe(0);
  });
});

describe("vigil decode exit codes", () => {
  it("0 for warnings by default, 1 with --fail-on warning, 0 with --fail-on never", async () => {
    const args = ["decode", BATCH_MULTISIG, "2268"];
    expect((await run(args, { env: BATCH })).code).toBe(0);
    expect((await run([...args, "--fail-on", "warning"], { env: BATCH })).code).toBe(1);
    expect((await run([...args, "--fail-on", "never"], { env: BATCH })).code).toBe(0);
  });

  it("2 for a critical finding (the real program upgrade), even with --fail-on warning", async () => {
    const args = ["decode", UPGRADE_MULTISIG, "4"];
    const result = await run(args, { env: UPGRADE });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("✖ CRITICAL FINDINGS");
    expect(result.stdout).toContain("VGL-C001");
    expect((await run([...args, "--fail-on", "warning"], { env: UPGRADE })).code).toBe(2);
    expect((await run([...args, "--fail-on", "never"], { env: UPGRADE })).code).toBe(0);
  });

  it("4 for an incomplete analysis with nothing critical, 0 with --fail-on never", async () => {
    const args = ["decode", OPAQUE_MULTISIG, "352"];
    const result = await run(args, { env: OPAQUE });
    expect(result.code).toBe(4);
    expect(result.stdout).toContain("? ANALYSIS INCOMPLETE");
    expect(result.stdout).toContain("Not checked (");
    expect((await run([...args, "--fail-on", "warning"], { env: OPAQUE })).code).toBe(4);
    expect((await run([...args, "--fail-on", "never"], { env: OPAQUE })).code).toBe(0);
  });

  it("--no-simulate makes the analysis incomplete (exit 4) and shows no balance changes", async () => {
    const result = await run(["decode", BATCH_MULTISIG, "2268", "--no-simulate"], { env: BATCH });
    expect(result.code).toBe(4);
    expect(result.stdout).not.toContain("Balance changes if executed now");
    expect(result.stdout).toContain("Not checked (1)");
    expect(flat(result.stdout)).toContain(CATALOGS.en["gap.SIMULATION_DISABLED"]);
  });

  it("--no-external never asks the verification API and says so", async () => {
    const result = await run(["decode", BATCH_MULTISIG, "2268", "--no-external", "--json"], {
      env: { ...BATCH, VIGIL_TEST_HTTP_FIXTURE: "" },
    });
    const report = JSON.parse(result.stdout) as { completeness: { gaps: { code: string }[] } };
    expect(report.completeness.gaps.map((g) => g.code)).toEqual(["PROGRAM_VERIFICATION_DISABLED"]);
    expect(result.code).toBe(4);
  });
});

describe("vigil decode --tx", () => {
  it("analyses a base64 transaction given inline", async () => {
    const result = await run(["decode", "--tx", await rawBase64()], { env: RAW });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Vigil · Raw transaction");
    expect(result.stdout).toContain("What this transaction does");
    expect(result.stdout).toContain("Transfers 50 USDC");
  });

  it("reads it from standard input with --tx -, and --json is the serialized report", async () => {
    const base64 = await rawBase64();
    const result = await run(["decode", "--tx", "-", "--json"], {
      env: RAW,
      stdin: `\n  ${base64.slice(0, 40)}\n${base64.slice(40)}\n`,
    });
    const fixtures = await fixtureMode(RAW);
    if (fixtures === undefined) {
      throw new Error("fixture mode off");
    }
    const expected = await analyzeRawTransaction(
      {
        clock: fixtures.clock ?? { now: () => 0 },
        http: fixtures.createHttp(),
        rpc: fixtures.createRpc(""),
        rpcHost: "api.mainnet-beta.solana.com",
      },
      base64,
    );
    expect(result.stdout).toBe(`${serializeReport(expected)}\n`);
  });

  it("rejects input that is not base64, too large, or given together with a proposal", async () => {
    const bad = await run(["decode", "--tx", "not base64!"], { env: RAW });
    expect(bad.code).toBe(3);
    expect(bad.stderr).toContain("error: The transaction is not valid base64");
    const big = await run(["decode", "--tx", "A".repeat(6000)], { env: RAW });
    expect(big.code).toBe(3);
    expect(big.stderr).toContain("a Solana transaction is at most 5464");
    const both = await run(["decode", BATCH_MULTISIG, "1", "--tx", "AAAA"], { env: RAW });
    expect(both.code).toBe(3);
    expect(both.stderr).toContain("either <multisig> <index> or --tx");
    const history = await run(["decode", "--tx", "AAAA", "--history", "5"], { env: RAW });
    expect(history.stderr).toContain("--history applies to Squads proposals only");
    const garbage = await run(["decode", "--tx", "AAAAAAAA"], { env: RAW });
    expect(garbage.code).toBe(3);
    expect(garbage.stderr).toMatch(/^error: /);
    const tooMuchStdin = await run(["decode", "--tx", "-"], {
      env: RAW,
      stdin: "A".repeat(20_000),
    });
    expect(tooMuchStdin.stderr).toContain("Could not read the transaction from standard input");
  });
});

describe("vigil decode input validation", () => {
  const cases: [readonly string[], string][] = [
    [["decode"], "Missing the multisig address."],
    [["decode", BATCH_MULTISIG], "Missing the proposal index."],
    [["decode", "0OIl", "3"], "is not a base58 address"],
    [["decode", "abc", "3"], "is not a valid Solana address"],
    [["decode", BATCH_MULTISIG, "0"], "is not a positive whole number"],
    [["decode", BATCH_MULTISIG, "1.5"], "is not a positive whole number"],
    [["decode", BATCH_MULTISIG, "18446744073709551616"], "is not a positive whole number"],
    [["decode", BATCH_MULTISIG, "1", "2"], "Too many arguments"],
    [["decode", BATCH_MULTISIG, "1", "--fail-on", "sometimes"], "--fail-on must be one of"],
    [
      ["decode", BATCH_MULTISIG, "1", "--history", "1001"],
      "--history must be a whole number from 0 to 1000",
    ],
    [
      ["decode", BATCH_MULTISIG, "1", "--cluster", "testnet"],
      "--cluster must be one of mainnet, devnet",
    ],
    [["decode", BATCH_MULTISIG, "1", "--lang", "fr"], "--lang must be one of"],
    [["decode", BATCH_MULTISIG, "1", "--bogus"], "Unknown option '--bogus'"],
  ];
  for (const [argv, message] of cases) {
    it(`exit 3: vigil ${argv.join(" ")}`, async () => {
      const result = await run(argv, { env: BATCH });
      expect(result.code).toBe(3);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
      expect(result.stderr).toMatch(/^error: .+\n( {2}→ .+\n)?$/);
    });
  }

  it("says what to do when the index does not exist, or the address is a vault", async () => {
    const missing = await run(["decode", BATCH_MULTISIG, "999999"], { env: BATCH });
    expect(missing.code).toBe(3);
    expect(missing.stderr).toMatch(/has transactions 1 to \d+; there is no transaction 999999\./);
    expect(missing.stderr).toContain("→ Run vigil list <multisig> --status all");
    const vault = await run(["decode", BATCH_VAULT, "1"], { env: BATCH });
    expect(vault.code).toBe(3);
    expect(vault.stderr).toContain("is not a Squads v4 multisig");
    expect(vault.stderr).toContain("→ Use the multisig address");
  });
});

describe("progress", () => {
  it("goes to stderr only when it is a terminal, and never to stdout", async () => {
    const quiet = await run(["decode", BATCH_MULTISIG, "2268", "--json"], { env: BATCH });
    expect(quiet.stderr).toBe("");
    const shown = await run(["decode", BATCH_MULTISIG, "2268", "--json"], {
      env: BATCH,
      stderrTTY: true,
    });
    expect(shown.stderr).toContain("Reading the multisig and the proposal…");
    expect(shown.stderr).toContain("Simulating…");
    expect(shown.stdout).toBe(quiet.stdout);
    // The status line is erased at the end.
    expect(shown.stderr.endsWith(`\r${String.fromCharCode(27)}[2K`)).toBe(true);
  });
});

describe("cluster and cross-check", () => {
  it("notes on stderr when --cluster disagrees with the RPC's genesis hash", async () => {
    const result = await run(["decode", BATCH_MULTISIG, "2268", "--cluster", "devnet"], {
      env: BATCH,
    });
    expect(result.rpcUrls[0]).toBe("https://api.devnet.solana.com/");
    expect(result.stderr).toContain("--cluster devnet was given, but the RPC is on mainnet");
  });

  it("cross-checks with VIGIL_CROSS_CHECK_RPC_URL; the same data agrees", async () => {
    const result = await run(["decode", BATCH_MULTISIG, "2268", "--json"], {
      env: { ...BATCH, VIGIL_CROSS_CHECK_RPC_URL: "https://second.example.com" },
    });
    expect(result.rpcUrls).toEqual([
      "https://api.mainnet-beta.solana.com/",
      "https://second.example.com/",
    ]);
    const report = JSON.parse(result.stdout) as { findings: { ruleId: string }[] };
    expect(report.findings.map((f) => f.ruleId)).not.toContain("VGL-C012");
  });

  it("refuses a cross-check RPC that is the primary one", async () => {
    const result = await run(["decode", BATCH_MULTISIG, "2268"], {
      env: {
        ...BATCH,
        VIGIL_CROSS_CHECK_RPC_URL: "https://api.mainnet-beta.solana.com",
      },
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("same endpoint as the primary RPC");
  });
});
