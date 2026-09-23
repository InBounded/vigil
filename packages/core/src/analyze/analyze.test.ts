/**
 * Report assembly on real mainnet data: every fixture in `fixtures/cli/` was captured by running
 * this very analysis live (`scripts/capture-reports.ts`) through the recording RPC and HTTP
 * clients, so these tests replay exactly what the live run read. Balances and simulations are
 * current at capture time, not historical.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  type Address,
  address,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
} from "@solana/kit";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { AnalysisReport } from "../report.js";
import { ANALYSIS_GAP_CODES } from "../report.js";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import type { FixtureData, RpcClient } from "../rpc/index.js";
import { RULES } from "../rules/engine.js";
import { getVaultPda } from "../squads/pda.js";
import { failingHttp, loadRecordedHttp } from "../test-support/http.js";
import { loadFixture } from "../test-support/rules.js";
import {
  type AnalysisDependencies,
  type AnalysisStep,
  analyzeProposal,
  analyzeRawTransaction,
  MAX_RAW_TRANSACTION_BASE64_LENGTH,
  rpcHostOf,
} from "./analyze.js";
import { AnalysisError } from "./errors.js";
import { reportToJson, serializeReport } from "./serialize.js";

const BATCH_MULTISIG = address("81S2mzdgrTGVjHHiJGiN2bCt8hjaiBvoNqVmYyRVzuJf");
const UPGRADE_MULTISIG = address("DQnoxvJiAYUeB5Ahp5VbsaMGMmJUA5Jr5b1nnJ2ANeMG");
const OPAQUE_MULTISIG = address("3gjeSqMDqip2uLALaeFoGN3PmNx1tuY1y6S9qVxLyVJt");
const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const RAW_SIGNATURE =
  "3Feg3sty9zSxEridJZWLqdEuLeSL2khcwyZjQu76KA1nif69KJ7Pj2iDiL9VEDW2qbRFR4if1CdrPyL1rJhWgBE1";
/** 2026-09-23T12:00:00Z: a fixed clock, so reports are deterministic. */
const NOW = Date.UTC(2026, 8, 23, 12);

const schema = JSON.parse(
  await readFile(
    fileURLToPath(new URL("../../../../docs/report.schema.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, unknown>;
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function expectValid(report: AnalysisReport): void {
  const json = JSON.parse(serializeReport(report)) as unknown;
  const ok = validate(json);
  expect(validate.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

async function fixture(name: string, gz = false) {
  const data = await loadFixture(gz ? `cli/${name}.json.gz` : `cli/${name}`);
  const http = await loadRecordedHttp(`cli/${name}.http`);
  return { data, http };
}

function deps(
  data: FixtureData,
  http: AnalysisDependencies["http"],
  extra: Partial<AnalysisDependencies> = {},
): AnalysisDependencies {
  return {
    clock: { now: () => NOW },
    http,
    rpc: new FixtureRpcClient(data),
    rpcHost: "fixture",
    ...extra,
  };
}

const ids = (report: AnalysisReport) => report.findings.map((f) => f.ruleId);
const gapCodes = (report: AnalysisReport) => report.completeness.gaps.map((g) => g.code);

describe("analyzeProposal on real proposals", () => {
  it("program upgrade (DQnox... #4): critical, with the upgrade and program facts", async () => {
    const { data, http } = await fixture("upgrade-proposal", true);
    const steps: AnalysisStep[] = [];
    const report = await analyzeProposal(
      deps(data, http),
      { multisig: UPGRADE_MULTISIG, transactionIndex: 4n },
      { onProgress: (step) => steps.push(step), rules: { historyDepth: 20 } },
    );
    expect(report.verdict).toBe("critical");
    expect(ids(report)).toContain("VGL-C001");
    expect(report.transactionKind).toBe("vault");
    expect(report.cluster).toBe("mainnet");
    expect(report.generatedAt).toBe("2026-09-23T12:00:00.000Z");
    expect(report.input).toEqual({
      kind: "squads-proposal",
      multisig: UPGRADE_MULTISIG,
      transactionIndex: 4n,
    });
    expect(report.proposal).toMatchObject({ transactionIndex: 4n, vaultIndex: 0 });
    expect(report.instructions.map((ix) => ix.name)).toEqual(["upgrade"]);
    expect(report.programs.length).toBeGreaterThan(0);
    expect(steps).toEqual([
      "cluster",
      "proposal",
      "decode",
      "annotate",
      "simulate",
      "programs",
      "verification",
      "balances",
      "history",
      "rules",
    ]);
    expectValid(report);
  });

  it("batch draft (81S2... #2268): real vault balance for VGL-W004 and real history for VGL-W005", async () => {
    const { data, http } = await fixture("list-batch-drafts");
    const report = await analyzeProposal(
      deps(data, http),
      { multisig: BATCH_MULTISIG, transactionIndex: 2268n },
      { rules: { historyDepth: 150 } },
    );
    expect(report.verdict).toBe("attention");
    expect(report.completeness).toEqual({ complete: true, gaps: [] });
    expect(report.transactionKind).toBe("batch");
    expect(report.proposal?.batchItems).toEqual([1, 2]);
    expect(new Set(report.instructions.map((ix) => ix.batchItem))).toEqual(new Set([1, 2]));

    // VGL-W004 compares with the vault's USDC token account as read on chain.
    const [vault] = await getVaultPda({ index: 0, multisigPda: BATCH_MULTISIG });
    const w004 = report.findings.find((f) => f.ruleId === "VGL-W004");
    expect(w004?.evidence).toContain(`from: ${vault}`);
    expect(w004?.evidence).toContain(`asset: ${USDC}`);
    const source = report.instructions
      .find((ix) => ix.name === "transferChecked" || ix.name === "transfer")
      ?.accounts.find((a) => a.role === "source")?.address as Address;
    const account = data.accounts.get(source);
    const bytes = Buffer.from(account?.dataBase64 ?? "", "base64");
    expect(w004?.evidence).toContain(`balanceBaseUnits: ${bytes.readBigUInt64LE(64)}`);

    // VGL-W005: one of the three destinations was paid by an earlier execute of this multisig.
    const w005 = report.findings.filter((f) => f.ruleId === "VGL-W005");
    expect(w005).toHaveLength(2);
    const checked = w005[0]?.evidence.find((line) =>
      line.startsWith("recentDestinationsChecked: "),
    );
    expect(Number(checked?.split(": ")[1])).toBeGreaterThan(0);
    expectValid(report);
  });

  it("opaque program (3gjeSq... #352): incomplete, the invalid on-chain IDL is a gap", async () => {
    const { data, http } = await fixture("opaque-proposal", true);
    const report = await analyzeProposal(deps(data, http), {
      multisig: OPAQUE_MULTISIG,
      transactionIndex: 352n,
    });
    expect(report.verdict).toBe("incomplete");
    expect(ids(report)).toEqual(expect.arrayContaining(["VGL-W001", "VGL-W007"]));
    expect(gapCodes(report)).toContain("IDL_INVALID");
    expect(report.completeness.complete).toBe(false);
    expectValid(report);
  });

  it("gives the same JSON on every run (deterministic serialization)", async () => {
    const { data, http } = await fixture("list-batch-drafts");
    const run = () =>
      analyzeProposal(deps(data, http), { multisig: BATCH_MULTISIG, transactionIndex: 2267n });
    const [a, b] = [serializeReport(await run()), serializeReport(await run())];
    expect(a).toBe(b);
    const keys = Object.keys(JSON.parse(a) as object);
    expect(keys).toEqual([...keys].sort());
    expect(a).toContain('"contextSlot": "');
  });
});

describe("analyzeProposal options", () => {
  it("simulation off: no simulation, a SIMULATION_DISABLED gap, verdict incomplete", async () => {
    const { data, http } = await fixture("list-batch-drafts");
    const report = await analyzeProposal(
      deps(data, http),
      { multisig: BATCH_MULTISIG, transactionIndex: 2268n },
      { simulate: false },
    );
    expect(report.simulation).toBeUndefined();
    expect(gapCodes(report)).toContain("SIMULATION_DISABLED");
    expect(report.verdict).toBe("incomplete");
    expectValid(report);
  });

  it("verification off: the API is never called, one PROGRAM_VERIFICATION_DISABLED gap", async () => {
    const { data } = await fixture("list-batch-drafts");
    const http = failingHttp(() => Promise.reject(new Error("must not be called")));
    const report = await analyzeProposal(
      deps(data, http),
      { multisig: BATCH_MULTISIG, transactionIndex: 2268n },
      { verification: false },
    );
    expect(http.calls).toBe(0);
    expect(gapCodes(report).filter((c) => c === "PROGRAM_VERIFICATION_DISABLED")).toHaveLength(1);
    expect(report.programs.some((p) => p.verification === "not-checked")).toBe(true);
  });

  it("history ignores transactions this multisig did not execute (address poisoning)", async () => {
    // The vault's 25 most recent transactions are real third-party USDC deposits that mention it;
    // none is an execute of this multisig, so none of their addresses count as known.
    const { data, http } = await fixture("list-batch-drafts");
    const report = await analyzeProposal(
      deps(data, http),
      { multisig: BATCH_MULTISIG, transactionIndex: 2268n },
      { rules: { historyDepth: 25 } },
    );
    const w005 = report.findings.filter((f) => f.ruleId === "VGL-W005");
    expect(w005).toHaveLength(3);
    expect(w005[0]?.evidence).toContain("recentDestinationsChecked: 0");
  });

  it("history that cannot be read is a HISTORY_UNAVAILABLE gap, and VGL-W005 does not run", async () => {
    const { data, http } = await fixture("list-batch-drafts");
    const report = await analyzeProposal(
      deps({ ...data, signatures: new Map() }, http),
      { multisig: BATCH_MULTISIG, transactionIndex: 2268n },
      { rules: { historyDepth: 150 } },
    );
    expect(gapCodes(report)).toEqual(["HISTORY_UNAVAILABLE"]);
    expect(ids(report)).not.toContain("VGL-W005");
    expect(report.verdict).toBe("incomplete");
  });

  it("cross-check against an RPC that agrees: no mismatch, no gap", async () => {
    const { data, http } = await fixture("list-batch-drafts");
    const report = await analyzeProposal(
      deps(data, http, { crossCheckRpc: new FixtureRpcClient(data) }),
      { multisig: BATCH_MULTISIG, transactionIndex: 2268n },
    );
    expect(ids(report)).not.toContain("VGL-C012");
    expect(report.completeness.complete).toBe(true);
  });

  it("cross-check against an RPC that is down: RPC_CROSS_CHECK_FAILED gap", async () => {
    const { data, http } = await fixture("list-batch-drafts");
    const down = new FixtureRpcClient(data);
    down.getMultipleAccounts = () => Promise.reject(new Error("down"));
    const report = await analyzeProposal(deps(data, http, { crossCheckRpc: down }), {
      multisig: BATCH_MULTISIG,
      transactionIndex: 2268n,
    });
    expect(gapCodes(report)).toContain("RPC_CROSS_CHECK_FAILED");
    expect(report.verdict).toBe("incomplete");
  });

  it("a mismatching second RPC raises VGL-C012 (critical)", async () => {
    const { data, http } = await fixture("list-batch-drafts");
    const [multisigAccount] = [data.accounts.get(BATCH_MULTISIG)];
    if (multisigAccount === undefined) {
      throw new Error("fixture incomplete");
    }
    const tampered: FixtureData = {
      ...data,
      accounts: new Map([
        ...data.accounts,
        [
          BATCH_MULTISIG,
          { ...multisigAccount, dataBase64: Buffer.from("tampered").toString("base64") },
        ],
      ]),
    };
    const report = await analyzeProposal(
      deps(data, http, { crossCheckRpc: new FixtureRpcClient(tampered) }),
      { multisig: BATCH_MULTISIG, transactionIndex: 2268n },
    );
    expect(ids(report)).toContain("VGL-C012");
    expect(report.verdict).toBe("critical");
  });
});

describe("analyzeProposal errors", () => {
  it("a vault address is not a multisig", async () => {
    const { data, http } = await fixture("list-batch-drafts");
    const [vault] = await getVaultPda({ index: 0, multisigPda: BATCH_MULTISIG });
    await expect(
      analyzeProposal(deps(data, http), { multisig: vault, transactionIndex: 1n }),
    ).rejects.toMatchObject({ code: "NOT_A_MULTISIG" });
  });

  it("an index past the multisig's last transaction, or zero, does not exist", async () => {
    const { data, http } = await fixture("list-batch-drafts");
    for (const transactionIndex of [0n, 999_999n]) {
      const error = await analyzeProposal(deps(data, http), {
        multisig: BATCH_MULTISIG,
        transactionIndex,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AnalysisError);
      expect(error).toMatchObject({ code: "TRANSACTION_NOT_FOUND" });
      expect((error as Error).message).toMatch(/has transactions 1 to \d+/);
    }
  });

  it("a transaction account that is gone (closed) does not exist", async () => {
    const { data, http } = await fixture("list-batch-drafts");
    await expect(
      analyzeProposal(deps(data, http), { multisig: BATCH_MULTISIG, transactionIndex: 2000n }),
    ).rejects.toMatchObject({ code: "TRANSACTION_NOT_FOUND" });
  });

  it("an RPC failure keeps only the HTTP status, never the endpoint", async () => {
    const { data, http } = await fixture("list-batch-drafts");
    const rpc: RpcClient = new FixtureRpcClient(data);
    rpc.getGenesisHash = () =>
      Promise.reject(
        new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
          headers: new Headers(),
          message: "Unauthorized https://rpc.example.com/?api-key=SECRET",
          statusCode: 401,
        }),
      );
    const error = await analyzeProposal(
      { clock: { now: () => NOW }, http, rpc, rpcHost: "rpc.example.com" },
      { multisig: BATCH_MULTISIG, transactionIndex: 2268n },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "RPC_FAILED" });
    expect((error as Error).message).toBe(
      "the RPC endpoint could not be queried: the endpoint answered HTTP 401",
    );
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("analyzeRawTransaction on a real transaction", () => {
  it("3Feg3sty... (50 USDC transferChecked): decoded, simulated, judged", async () => {
    const { data, http } = await fixture("raw-usdc-transfer");
    const tx = data.transactions.get(RAW_SIGNATURE as never);
    if (tx === undefined) {
      throw new Error("fixture incomplete");
    }
    const report = await analyzeRawTransaction(deps(data, http), tx.transactionBase64);
    expect(report.input.kind).toBe("raw-transaction");
    expect(report.rawTransaction).toMatchObject({ signatureCount: 2, version: "legacy" });
    expect(report.multisig).toBeUndefined();
    expect(report.instructions.map((ix) => ix.name)).toContain("transferChecked");
    expect(report.simulation?.status).toBeDefined();
    expect(report.verdict).toBe("attention");
    expect(ids(report)).toContain("VGL-W004");
    expectValid(report);

    // The schema is strict: a URL path in rpcHost or an unknown field is rejected.
    const json = JSON.parse(serializeReport(report)) as Record<string, unknown>;
    expect(validate({ ...json, rpcHost: "rpc.example.com/KEY" })).toBe(false);
    expect(validate({ ...json, extra: true })).toBe(false);
  });

  it("rejects input that is not a transaction, and input over the size limit", async () => {
    const { data, http } = await fixture("raw-usdc-transfer");
    await expect(analyzeRawTransaction(deps(data, http), "not base64!")).rejects.toMatchObject({
      code: "INVALID_TRANSACTION",
    });
    await expect(
      analyzeRawTransaction(deps(data, http), "A".repeat(MAX_RAW_TRANSACTION_BASE64_LENGTH + 4)),
    ).rejects.toMatchObject({ code: "INVALID_TRANSACTION" });
  });
});

describe("report schema", () => {
  it("lists exactly the gap codes and rule ids the engine can produce", () => {
    const defs = schema.$defs as Record<
      string,
      { properties?: Record<string, { enum?: unknown[]; pattern?: string }> }
    >;
    expect(defs.gap?.properties?.code?.enum).toEqual([...ANALYSIS_GAP_CODES]);
    const pattern = new RegExp(defs.finding?.properties?.ruleId?.pattern ?? "$^");
    for (const rule of RULES) {
      expect(rule.id).toMatch(pattern);
    }
  });

  it("serializes bigints as strings and byte arrays as hex, leaving undefined out", () => {
    expect(
      reportToJson({
        a: 1n,
        b: undefined,
        c: new Uint8Array([1, 255]),
      } as unknown as AnalysisReport),
    ).toEqual({ a: "1", c: "01ff" });
  });
});

describe("rpcHostOf", () => {
  it("keeps the host only", () => {
    expect(rpcHostOf("https://user:pw@mainnet.helius-rpc.com:8443/v1/KEY?api-key=KEY")).toBe(
      "mainnet.helius-rpc.com:8443",
    );
    expect(rpcHostOf("not a url")).toBe("invalid-url");
  });
});
