/**
 * `vigil list`, `verify`, `rules`, `explain`, `watch`, `--help` and `--version`, in-process, on
 * real captured mainnet data (`fixtures/cli/`).
 */
import { RULES } from "@vigil-sol/core";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "./args.js";
import {
  BATCH_MULTISIG,
  BATCH_VAULT,
  fixtureEnv,
  run,
  SQUADS_PROGRAM,
} from "./test-support/harness.js";

const BATCH = fixtureEnv("list-batch-drafts");
const UPGRADE = fixtureEnv("upgrade-proposal");

interface ListJson {
  readonly schemaVersion: number;
  readonly cluster: string;
  readonly rpcHost: string;
  readonly multisig: string;
  readonly proposals: readonly {
    readonly transactionIndex: string;
    readonly status: string | null;
    readonly analysed: boolean;
    readonly pending: boolean;
    readonly report?: { readonly verdict: string };
  }[];
}

describe("vigil list", () => {
  it("lists only pending proposals by default, each with a short verdict", async () => {
    const result = await run(["list", BATCH_MULTISIG, "--limit", "6"], { env: BATCH });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Vigil · Proposals of multisig ${BATCH_MULTISIG}`);
    expect(result.stdout).toContain("#2268 · batch · Draft\n  ⚠ Needs attention\n");
    expect(result.stdout).toContain("#2267 · batch · Draft\n  ⚠ Needs attention\n");
    expect(result.stdout).not.toContain("Executed");
    expect(result.stdout).toContain(`vigil decode ${BATCH_MULTISIG} <index>`);
  });

  it("--status all also lists executed transactions, without analysing them", async () => {
    const result = await run(["list", BATCH_MULTISIG, "--limit", "6", "--status", "all"], {
      env: BATCH,
    });
    expect(result.stdout).toContain("#2271 · batch · Executed\n  not analysed (no longer pending)");
    expect(result.stdout.match(/^#\d+/gm)).toEqual([
      "#2271",
      "#2270",
      "#2269",
      "#2268",
      "#2267",
      "#2266",
    ]);
  });

  it("--json lists every row and the full report of each analysed proposal", async () => {
    const result = await run(
      ["list", BATCH_MULTISIG, "--limit", "6", "--status", "all", "--json"],
      { env: BATCH },
    );
    const list = JSON.parse(result.stdout) as ListJson;
    expect(list).toMatchObject({
      cluster: "mainnet",
      multisig: BATCH_MULTISIG,
      rpcHost: "api.mainnet-beta.solana.com",
      schemaVersion: 1,
    });
    expect(
      list.proposals.map((p) => [p.transactionIndex, p.status, p.analysed, p.report?.verdict]),
    ).toEqual([
      ["2271", "Executed", false, undefined],
      ["2270", "Executed", false, undefined],
      ["2269", "Executed", false, undefined],
      ["2268", "Draft", true, "attention"],
      ["2267", "Draft", true, "attention"],
      ["2266", "Executed", false, undefined],
    ]);
    expect(result.stderr).toBe("");
  });

  it("exit codes follow the worst analysed proposal", async () => {
    const args = ["list", BATCH_MULTISIG, "--limit", "6"];
    expect((await run([...args, "--fail-on", "warning"], { env: BATCH })).code).toBe(1);
    expect((await run([...args, "--no-simulate"], { env: BATCH })).code).toBe(4);
    expect((await run([...args, "--no-simulate", "--fail-on", "never"], { env: BATCH })).code).toBe(
      0,
    );
  });

  it("says so when nothing is pending", async () => {
    const result = await run(["list", BATCH_MULTISIG, "--limit", "3"], { env: BATCH });
    expect(result.stdout).toContain("No pending proposals among the last 3 transactions.");
    expect(result.code).toBe(0);
  });

  it("rejects a vault address, bad limits and --status values", async () => {
    const vault = await run(["list", BATCH_VAULT], { env: BATCH });
    expect(vault.code).toBe(3);
    expect(vault.stderr).toContain("is not a Squads v4 multisig");
    for (const [argv, message] of [
      [["list"], "Missing the multisig address."],
      [["list", BATCH_MULTISIG, "--limit", "0"], "--limit must be a whole number from 1 to 100"],
      [["list", BATCH_MULTISIG, "--status", "open"], "--status must be one of active, all"],
      [["decode", BATCH_MULTISIG, "1", "--limit", "5"], "--limit only applies to vigil list"],
    ] as const) {
      const result = await run(argv, { env: BATCH });
      expect(result.code).toBe(3);
      expect(result.stderr).toContain(message);
    }
  });
});

describe("vigil verify", () => {
  it("shows upgradeability, last deploy, hash and verification of a real program", async () => {
    const result = await run(["verify", SQUADS_PROGRAM], { env: UPGRADE });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Vigil · Program ${SQUADS_PROGRAM}`);
    expect(result.stdout).toContain("Squads Multisig v4 · cannot be upgraded · verification:");
    expect(result.stdout).toContain("last deployed at slot 302582236");
    expect(result.stdout).toMatch(/executable hash:\s+d48660833989ecea/);
  });

  it("--json gives the program facts and gaps", async () => {
    const result = await run(["verify", SQUADS_PROGRAM, "--json"], { env: UPGRADE });
    const json = JSON.parse(result.stdout) as {
      program: { address: string; loader: string; lastDeploySlot: string };
      gaps: unknown[];
    };
    expect(json.program).toMatchObject({
      address: SQUADS_PROGRAM,
      lastDeploySlot: "302582236",
      loader: "upgradeable",
    });
    expect(json.gaps).toEqual([]);
  });

  it("--no-external: verification not checked, a gap, exit 4", async () => {
    const result = await run(["verify", SQUADS_PROGRAM, "--no-external"], { env: UPGRADE });
    expect(result.stdout).toContain("verification: not checked");
    expect(result.code).toBe(4);
  });

  it("refuses an address that is not a program", async () => {
    const result = await run(["verify", BATCH_VAULT], { env: BATCH });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(`${BATCH_VAULT} is not a program`);
    expect(result.stderr).toContain("→ Pass the program's own address");
  });
});

describe("vigil rules and vigil explain", () => {
  it("lists every rule", async () => {
    const result = await run(["rules"]);
    expect(result.code).toBe(0);
    for (const rule of RULES) {
      expect(result.stdout).toContain(rule.id);
    }
    const json = JSON.parse((await run(["rules", "--json"])).stdout) as { id: string }[];
    expect(json.map((r) => r.id)).toEqual(RULES.map((r) => r.id));
  });

  it("explains one rule, whatever the case of its id", async () => {
    const result = await run(["explain", "vgl-c001"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("VGL-C001 · ");
    expect(result.stdout).toContain("What it checks");
    expect(result.stdout).toContain("Why it matters");
    expect(result.stdout).toContain("False positives and limits");
    const json = JSON.parse((await run(["explain", "VGL-W004", "--json"])).stdout) as {
      id: string;
      severity: string;
    };
    expect(json).toMatchObject({ id: "VGL-W004", severity: "warning" });
  });

  it("refuses an unknown rule or a missing id", async () => {
    expect((await run(["explain", "VGL-X999"])).stderr).toContain('There is no rule "VGL-X999"');
    expect((await run(["explain"])).stderr).toContain("Missing the rule id.");
    expect((await run(["rules", "extra"])).code).toBe(3);
  });
});

describe("vigil watch: usage and help", () => {
  it("--help describes the command, its options and the alert variables", async () => {
    const help = await run(["watch", "--help"]);
    expect(help.code).toBe(0);
    for (const text of [
      "--interval <S>",
      "--once",
      "--state-file <path>",
      "VIGIL_DISCORD_WEBHOOK",
      "VIGIL_TELEGRAM_BOT_TOKEN",
      "VIGIL_TELEGRAM_CHAT_ID",
      "VIGIL_WEB_URL",
      "XDG_STATE_HOME",
    ]) {
      expect(help.stdout).toContain(text);
    }
    expect(help.stdout).not.toContain("later version");
    const overview = await run(["--help"]);
    expect(overview.stdout).toMatch(/vigil watch <multisig> +Alert on new proposals/);
  });

  it.each([
    [["watch"], "Missing the multisig address."],
    [["watch", BATCH_MULTISIG, "extra"], "Too many arguments for vigil watch."],
    [["watch", BATCH_MULTISIG, "--interval", "14"], "--interval"],
    [["watch", BATCH_MULTISIG, "--interval", "86401"], "--interval"],
    [
      ["watch", BATCH_MULTISIG, "--once", "--interval", "60"],
      "--interval does not apply with --once",
    ],
    [["watch", BATCH_MULTISIG, "--state-file", " "], "--state-file needs a path."],
    [["list", BATCH_MULTISIG, "--once"], "--once only applies to vigil watch."],
    [
      ["decode", BATCH_MULTISIG, "1", "--interval", "60"],
      "--interval only applies to vigil watch.",
    ],
  ])("%j is a usage error (exit 3)", async (argv, message) => {
    const result = await run(argv);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(message);
  });
});

describe("--help and --version everywhere", () => {
  it("vigil with no command, and --help / -h, print the overview", async () => {
    for (const argv of [[], ["--help"], ["-h"]]) {
      const result = await run(argv);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("Exit codes:");
      expect(result.stderr).toBe("");
    }
  });

  for (const command of COMMANDS) {
    it(`vigil ${command} --help and --version`, async () => {
      const help = await run([command, "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain(`vigil ${command}`);
      const version = await run([command, "--version"]);
      expect(version).toMatchObject({ code: 0, stderr: "", stdout: "0.0.0-test\n" });
    });
  }
});
