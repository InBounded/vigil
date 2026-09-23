/**
 * Every rule run over real decoded mainnet data (fixtures under `fixtures/`). Facts that are only
 * gathered in Phase 5 (balances, buffers, simulation, verification) are added by hand where a test
 * needs them, and say so.
 */
import { type Address, address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { renderFinding } from "../i18n/render.js";
import type { DecodedInstruction, Finding } from "../report.js";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import type { FixtureData } from "../rpc/index.js";
import { SquadsV4Adapter } from "../squads/adapter.js";
import {
  addr,
  context,
  decodeFixtureTransaction,
  loadFixture,
  lookalikeOf,
  multisig,
  NOW,
  proposalFixtureContext,
} from "../test-support/rules.js";
import { priorityFeeLamports } from "./catalog/info.js";
import { computeVerdict, runRules } from "./engine.js";
import type { RuleContext } from "./types.js";
import { walkInstructions } from "./walk.js";

const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

function byRule(findings: readonly Finding[], ruleId: string): Finding[] {
  return findings.filter((f) => f.ruleId === ruleId);
}

function ruleIds(findings: readonly Finding[]): string[] {
  return [...new Set(findings.map((f) => f.ruleId))].sort();
}

async function rawContext(
  data: FixtureData,
  signature: string,
  overrides: Parameters<typeof context>[0] = {},
  multisigContext?: { readonly address: Address; readonly members: readonly Address[] },
): Promise<{ ctx: RuleContext; instructions: DecodedInstruction[] }> {
  const decoded = await decodeFixtureTransaction(data, signature, multisigContext);
  const ctx = await context({
    feePayer: decoded.decoded.feePayer,
    gaps: decoded.gaps,
    instructions: decoded.instructions,
    tokens: decoded.tokens,
    ...(decoded.decoded.transactionConfig === undefined
      ? {}
      : { transactionConfig: decoded.decoded.transactionConfig }),
    ...overrides,
  });
  return { ctx, instructions: decoded.instructions };
}

describe("program upgrade proposal (squads-program-upgrade.json)", () => {
  const MULTISIG = address("DQnoxvJiAYUeB5Ahp5VbsaMGMmJUA5Jr5b1nnJ2ANeMG");
  const PROGRAM = "Sett1ereLzRw7neSzoUSwp6vvstBkEgAgQeP6wFcw5F";
  const BUFFER = address("GzewiqRokBYbczNYHaSRx6ujtoEGaY5DFwczjMSEhtsR");
  const UPGRADE_AUTHORITY = address("ER4DX3atK5EV6p4i8k11gGvR5imAQC72TWkXMk4DDpus");
  const CREATE_TX =
    "43qBeNMhT4zbtbQd7BSDughU2GumtPJUSu7EYUt2u6DvDoxpb1rYVukef9eHLzAA3xUSgcHSDiHtt9DN46Fk2h9z";
  let data: FixtureData;
  beforeAll(async () => {
    data = await loadFixture("squads-program-upgrade");
  });

  it("flags the upgrade inside the proposal being created, marked as proposed, in both languages", async () => {
    const { ctx, instructions } = await rawContext(data, CREATE_TX);
    const findings = runRules(ctx);
    const [upgrade] = byRule(findings, "VGL-C001");
    expect(byRule(findings, "VGL-C001")).toHaveLength(1);
    expect(upgrade).toMatchObject({
      instructionIndex: 1,
      params: {
        buffer: BUFFER,
        bufferHash: "unknown",
        program: PROGRAM,
        proposed: "true",
        verification: "unknown",
      },
      severity: "critical",
    });
    expect(upgrade?.evidence).toContain(`upgradeAuthority: ${UPGRADE_AUTHORITY}`);
    expect(upgrade?.evidence).toContain("instruction: 1.0");
    if (upgrade === undefined) {
      throw new Error("no upgrade finding");
    }
    const en = renderFinding(upgrade, "en", instructions);
    expect(en.missing).toEqual([]);
    expect(en.text).toBe(
      "Upgrades program Sett…cw5F with the code in buffer Gzew…htsR (executable hash unknown; current verification of the program: unknown) Proposed only: this transaction creates the Squads proposal, and this happens only if the proposal is later approved and executed.",
    );
    const pt = renderFinding(upgrade, "pt-PT", instructions);
    expect(pt.missing).toEqual([]);
    expect(pt.text).toContain("Atualiza o programa Sett…cw5F");
    expect(pt.text).toContain("Apenas proposto: esta transação cria a proposta Squads");
    expect(computeVerdict(findings, ctx.gaps)).toBe("critical");
  });

  it("shows the buffer's hash and flags a buffer someone else controls (buffer facts added by hand)", async () => {
    const outsider = addr(9);
    const own = await rawContext(data, CREATE_TX, {
      facts: {
        buffers: new Map([
          [
            BUFFER,
            { address: BUFFER, authority: UPGRADE_AUTHORITY, executableHash: "ab".repeat(32) },
          ],
        ]),
      },
    });
    const ownFindings = runRules(own.ctx);
    expect(byRule(ownFindings, "VGL-C001")[0]?.params.bufferHash).toBe("ab".repeat(32));
    expect(byRule(ownFindings, "VGL-C011")).toEqual([]);

    const other = await rawContext(data, CREATE_TX, {
      facts: { buffers: new Map([[BUFFER, { address: BUFFER, authority: outsider }]]) },
    });
    const [external] = byRule(runRules(other.ctx), "VGL-C011");
    expect(external).toMatchObject({
      instructionIndex: 1,
      params: { buffer: BUFFER, bufferAuthority: outsider, proposed: "true" },
    });
    expect(external?.evidence).toContain(`upgradeAuthority: ${UPGRADE_AUTHORITY}`);
  });

  it("reads the stored proposal through the adapter: upgrade not marked as proposed, proposal already executed", async () => {
    const { context: ctx, bundle } = await proposalFixtureContext(
      "squads-program-upgrade",
      MULTISIG,
      4n,
    );
    expect(bundle.proposal?.status.kind).toBe("Executed");
    const findings = runRules(ctx);
    const [upgrade] = byRule(findings, "VGL-C001");
    expect(upgrade?.params.program).toBe(PROGRAM);
    expect(upgrade?.params.proposed).toBeUndefined();
    // The upgrade authority is this multisig's own vault (derived, not asserted by hand).
    expect(ctx.vaults.has(UPGRADE_AUTHORITY)).toBe(true);
    expect(byRule(findings, "VGL-I004")[0]?.titleKey).toBe("finding.VGL-I004.Executed");
    expect(byRule(findings, "VGL-I005")[0]?.titleKey).toBe("finding.VGL-I005.Executed");
  });

  it("flags a direct top-level loader Upgrade without the proposed marker", async () => {
    const { ctx, instructions } = await rawContext(
      data,
      "5xtxNM6YF1NcARP6muAtv4xLzqv5TPtaE5BLhpSbQLwkZnvwwfCvr4hXrUWNbys1Bm61HjBjeewiCB88TVBrHQqT",
    );
    const program = instructions[0]?.accounts.find((a) => a.role === "programAccount")?.address;
    expect(program).toMatch(/^7x1R.*YmJV$/);
    const [upgrade] = byRule(runRules(ctx), "VGL-C001");
    expect(upgrade?.instructionIndex).toBe(0);
    expect(upgrade?.params.program).toBe(program);
    expect(upgrade?.params.proposed).toBeUndefined();
  });
});

describe("config transactions created and executed atomically (config-transaction*.json)", () => {
  for (const fixture of ["config-transaction", "config-transaction-2"]) {
    it(`${fixture}: reports the SOL spending limit, not as merely proposed (it is executed in the same transaction)`, async () => {
      const data = await loadFixture(fixture);
      const [signature, ...others] = [...data.transactions.keys()];
      expect(others).toEqual([]);
      const { ctx, instructions } = await rawContext(data, signature ?? "");
      const findings = runRules(ctx);
      const [limit] = byRule(findings, "VGL-C006");
      expect(byRule(findings, "VGL-C006")).toHaveLength(1);
      expect(limit).toMatchObject({
        instructionIndex: 1,
        params: {
          amount: "100000000",
          decimals: "9",
          destinations: "1",
          members: "1",
          period: "Day",
        },
        titleKey: "finding.VGL-C006.spendingLimitAdded",
      });
      expect(limit?.params.proposed).toBeUndefined();
      if (limit === undefined) {
        throw new Error("no finding");
      }
      expect(renderFinding(limit, "en", instructions).text).toBe(
        "Adds a spending limit on vault #0: 1 member(s) can spend up to 0.1 SOL per day without a vote, to 1 allowed destination(s)",
      );
      expect(renderFinding(limit, "pt-PT", instructions).text).toBe(
        "Adiciona um limite de gastos ao cofre n.º 0: 1 membro(s) poderão gastar até 0,1 SOL por dia sem votação, para 1 destino(s) autorizado(s)",
      );

      // Same real instructions without the execute step: now the change is only proposed.
      const withoutExecute = await context({
        instructions: instructions.filter((ix) => ix.name !== "configTransactionExecute"),
      });
      const [proposed] = byRule(runRules(withoutExecute), "VGL-C006");
      expect(proposed?.params.proposed).toBe("true");
    });
  }
});

describe("Squads proposal with token transfers (squads-token-transfers.json)", () => {
  const MULTISIG = address("HpGrGa8tE1wxgxaNEasb71SYmgXUdwU5U7ZzpbLWgAs");
  const VAULT_0 = address("Cv7e4t2LM1chzziHZA8aRvfT24nvbdcjHvoTMXPNLCu7");
  const RECIPIENT = address("99pbDSgfWtaq9NNog1Ebk9Dkt3bEYtvA1Rb13hfL6WHB");
  const IDLE = address("BjcRmwm8e25RgjkyaFE56fc7bxRgGPw96JUkXRJFEroT");
  const PENGU = address("2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv");
  const TX =
    "euBTzbwHWGePPcB158kTa5qqC5U1AVNab15FDtDRhRgCzJm3BiYQyzHQtWcqpGoa2TVfvoXf1yh6fTdbkBfd9qD";
  // The four real IDLE transfers of this proposal, in base units.
  const IDLE_TOTAL = 13446797098256n + 827804145361n + 505474670146n + 3043539611206n;
  let data: FixtureData;
  let members: Address[];
  beforeAll(async () => {
    data = await loadFixture("squads-token-transfers");
    const summary = await new SquadsV4Adapter(new FixtureRpcClient(data)).fetchMultisig(MULTISIG);
    members = summary.members.map((m) => m.key);
  });

  async function transfersContext(overrides: Parameters<typeof context>[0] = {}) {
    const summary = await new SquadsV4Adapter(new FixtureRpcClient(data)).fetchMultisig(MULTISIG);
    return rawContext(
      data,
      TX,
      { multisig: summary, ...overrides },
      { address: MULTISIG, members },
    );
  }

  it("adds up the four IDLE transfers and compares them with the vault's balance (balances added by hand)", async () => {
    const { ctx, instructions } = await transfersContext({
      facts: {
        balances: [
          // 20 % of the balance leaves in IDLE; PENGU is a small share.
          { amount: IDLE_TOTAL * 5n, asset: IDLE, owner: VAULT_0 },
          { amount: 764422824n * 1000n, asset: PENGU, owner: VAULT_0 },
        ],
      },
    });
    const large = byRule(runRules(ctx), "VGL-W004");
    expect(large).toHaveLength(1);
    expect(large[0]).toMatchObject({
      params: {
        amount: String(IDLE_TOTAL),
        decimals: "9",
        declaredSymbol: "IDLE",
        from: VAULT_0,
        mint: IDLE,
        proposed: "true",
        share: "20",
        threshold: "10",
      },
      titleKey: "finding.VGL-W004.share",
    });
    expect(large[0]?.evidence.filter((line) => line.startsWith("transfer:"))).toHaveLength(4);
    if (large[0] === undefined) {
      throw new Error("no finding");
    }
    expect(renderFinding(large[0], "en", instructions).text).toMatch(
      /^Moves 17,823\.615524969 of token BjcR…EroT \(declared name “IdleMine”, symbol “IDLE”\) out of Vault #0: 20% of its balance in this asset \(threshold 10%\) Proposed only/,
    );
  });

  it("does not flag the transfers when they are a small share of the balances", async () => {
    const { ctx } = await transfersContext({
      facts: {
        balances: [
          { amount: IDLE_TOTAL * 100n, asset: IDLE, owner: VAULT_0 },
          { amount: 764422824n * 1000n, asset: PENGU, owner: VAULT_0 },
        ],
      },
    });
    expect(byRule(runRules(ctx), "VGL-W004")).toEqual([]);
  });

  it("reports the recipient as a new destination only when the vault's history does not contain it", async () => {
    const fresh = await transfersContext({
      facts: { recentDestinations: new Set([address("11111111111111111111111111111112")]) },
      options: { historyDepth: 25 },
    });
    const [newDestination] = byRule(runRules(fresh.ctx), "VGL-W005");
    expect(byRule(runRules(fresh.ctx), "VGL-W005")).toHaveLength(1);
    expect(newDestination?.params).toMatchObject({
      destination: RECIPIENT,
      historyDepth: "25",
      proposed: "true",
    });

    const known = await transfersContext({
      facts: { recentDestinations: new Set([RECIPIENT]) },
      options: { historyDepth: 25 },
    });
    expect(byRule(runRules(known.ctx), "VGL-W005")).toEqual([]);
  });

  it("raises nothing about the five real tokens, the addresses or closes (no false alarms)", async () => {
    const { ctx } = await transfersContext();
    expect(ctx.tokens.map((t) => t.declared?.symbol.text).sort()).toEqual([
      "CRCLx",
      "IDLE",
      "PENGU",
      "TRUMP",
      "TSLAx",
    ]);
    const findings = runRules(ctx);
    for (const rule of ["VGL-W008", "VGL-C008", "VGL-C009", "VGL-C004", "VGL-C003"]) {
      expect(byRule(findings, rule), rule).toEqual([]);
    }
    // Compute Budget instructions inside the stored message are listed as having no effect.
    expect(byRule(findings, "VGL-I001").map((f) => f.titleKey)).toEqual([
      "finding.VGL-I001.inProposal",
      "finding.VGL-I001.fee",
    ]);
  });

  it("flags a look-alike of the real recipient once it is a recent destination", async () => {
    // A previously paid address that matches the real recipient 99pb…6WHB on the visible characters.
    const previous = lookalikeOf(RECIPIENT);
    const { ctx } = await transfersContext({
      facts: { recentDestinations: new Set([previous]) },
      options: { historyDepth: 10 },
    });
    const [poisoning] = byRule(runRules(ctx), "VGL-C008");
    expect(poisoning?.params).toEqual({ address: RECIPIENT, resembles: previous });
  });
});

describe("real proposal with an undecodable program (vault-transaction.json)", () => {
  it("reports the opaque instruction, the gap first, and the 1-of-12 multisig", async () => {
    const { context: ctx, bundle } = await proposalFixtureContext(
      "vault-transaction",
      address("3gjeSqMDqip2uLALaeFoGN3PmNx1tuY1y6S9qVxLyVJt"),
      352n,
    );
    expect(bundle.multisig.threshold).toBe(1);
    const findings = runRules(ctx);
    expect(findings[0]?.ruleId).toBe("VGL-W011");
    expect(byRule(findings, "VGL-W001")[0]?.params.program).toBe(
      "J24jWEosQc5jgkdPm3YzNgzQ54CqNKkhzKy56XXJsLo2",
    );
    expect(byRule(findings, "VGL-W010")[0]).toMatchObject({
      params: { members: String(bundle.multisig.members.length) },
      titleKey: "finding.VGL-W010.threshold",
    });
    expect(computeVerdict(findings, ctx.gaps)).toBe("incomplete");
  });
});

describe("native instructions (native-instructions.json)", () => {
  let data: FixtureData;
  beforeAll(async () => {
    data = await loadFixture("native-instructions");
  });
  const tx = (prefix: string): string => {
    const signature = [...data.transactions.keys()].find((s) => s.startsWith(prefix));
    if (signature === undefined) {
      throw new Error(`no transaction ${prefix}`);
    }
    return signature;
  };

  it("flags a real durable-nonce transaction in base64 mode", async () => {
    const { ctx } = await rawContext(data, tx("P1pgDRoQ"));
    const [nonce] = byRule(runRules(ctx), "VGL-W009");
    expect(nonce).toMatchObject({
      instructionIndex: 0,
      params: {
        nonceAccount: "FnUsuJhbYpBbg6MyJcSL8TNjhAfAuaFuUhufcwg1BbE6",
        nonceAuthority: "BdS5Rf2U16PoEtE3yrNYkvjPSwmHeQ387ynTMYTxeKR4",
      },
    });
    expect(byRule(runRules(ctx), "VGL-I002")[0]?.params.memo).toBe(
      "pump-limit:v3:take_profit:104781:969622027608754",
    );
  });

  it("does not report stake withdraw, initialize or delegate as authority changes, nor StakeConfig as poisoning", async () => {
    for (const prefix of ["D78nFyzr", "rfo8UEYu", "LFNio8rs"]) {
      const findings = runRules((await rawContext(data, tx(prefix))).ctx);
      expect(byRule(findings, "VGL-C007"), prefix).toEqual([]);
      expect(byRule(findings, "VGL-C008"), prefix).toEqual([]);
    }
  });

  it("computes the maximum priority fee exactly as Agave does", async () => {
    const [fee] = byRule(runRules((await rawContext(data, tx("62Ye2RyK"))).ctx), "VGL-I001");
    // ceil(812,534 × 492,287 / 1,000,000) = ceil(399,999.73…) = 400,000 lamports.
    expect(fee?.params).toEqual({ fee: "400000", limit: "492287", price: "812534" });
    expect(priorityFeeLamports(812534n, 492287n)).toBe(400000n);
    const [lookups] = byRule(runRules((await rawContext(data, tx("62Ye2RyK"))).ctx), "VGL-I003");
    expect(lookups?.params.count).toBe("4");
  });

  it("closing a token account to its own signer is not external in base64 mode, but is when it leaves a multisig", async () => {
    const raw = await rawContext(data, tx("3LhnZy1F"));
    expect(byRule(runRules(raw.ctx), "VGL-C009")).toEqual([]);

    // The same real instruction as the content of a proposal of a multisig it does not belong to.
    const inProposal = await context({
      input: { kind: "squads-proposal", multisig: multisig().address, transactionIndex: 1n },
      instructions: raw.instructions,
      multisig: multisig(),
    });
    const [closed] = byRule(runRules(inProposal), "VGL-C009");
    expect(closed).toMatchObject({
      params: {
        account: "7xsdLSnN1HJsvUsafdys5ZNLxjTgTqdirnJay6Qx1BUM",
        destination: "2HQEZkgWhapA8xLyjJVAUYAG61ZUU6SAFrkZV7X5MWYJ",
      },
      titleKey: "finding.VGL-C009.token",
    });
  });

  it("routine proposal: a small USDC transfer to a known address gives no findings", async () => {
    const real = await rawContext(data, tx("3Feg3sty"));
    const transfer = real.instructions.find((ix) => ix.name === "transferChecked");
    if (transfer === undefined) {
      throw new Error("no USDC transfer in the fixture");
    }
    expect(transfer.summary?.params).toMatchObject({
      amount: "50000000",
      decimals: "6",
      mint: USDC,
    });
    const source = transfer.accounts.find((a) => a.role === "source")?.address;
    const destination = transfer.accounts.find((a) => a.role === "destination")?.address;
    const owner = transfer.accounts.find((a) => a.role === "authority")?.address;
    if (source === undefined || destination === undefined || owner === undefined) {
      throw new Error("unexpected accounts");
    }
    // The real 50 USDC transfer as the whole content of an Active 1-of-2 proposal; the balance, the
    // simulation and the user's known address are the facts Phase 5 will gather.
    const ctx = await context({
      facts: { balances: [{ amount: 5_000_000_000n, asset: USDC, owner }] },
      input: { kind: "squads-proposal", multisig: multisig().address, transactionIndex: 7n },
      instructions: [transfer],
      multisig: multisig(),
      options: { knownAddresses: new Map([[destination, "Supplier payments"]]) },
      proposal: {
        address: address("11111111111111111111111111111113"),
        status: { kind: "Active", timestamp: NOW - 60n },
        votes: { approved: [multisig().members[0]?.key ?? owner], cancelled: [], rejected: [] },
      },
      simulation: {
        balanceChanges: [
          { account: source, asset: USDC, owner, pre: 5_000_000_000n, post: 4_950_000_000n },
          { account: destination, asset: USDC, pre: 0n, post: 50_000_000n },
        ],
        status: "success",
      },
      transactionKind: "vault",
    });
    const findings = runRules(ctx);
    expect(findings.filter((f) => f.severity !== "info")).toEqual([]);
    expect(ruleIds(findings)).toEqual(["VGL-I004"]);
    expect(computeVerdict(findings, ctx.gaps)).toBe("no-findings");
  });
});

describe("other real transactions", () => {
  it("v1 transactions: priority fee from the inline configuration", async () => {
    for (const [fixture, fee] of [
      ["v1-transaction", "1500"],
      ["v1-failed-transaction", "700"],
    ] as const) {
      const data = await loadFixture(fixture);
      const [signature] = [...data.transactions.keys()];
      const { ctx } = await rawContext(data, signature ?? "");
      expect(byRule(runRules(ctx), "VGL-I001")).toEqual([
        expect.objectContaining({ params: { fee }, titleKey: "finding.VGL-I001.v1" }),
      ]);
    }
  });

  it("a price with no explicit compute-unit limit (idl-programs.json, Raydium CPMM swap)", async () => {
    const data = await loadFixture("idl-programs");
    const signature = [...data.transactions.keys()].find((s) => s.startsWith("x2L9pQd7"));
    const { ctx } = await rawContext(data, signature ?? "");
    expect(byRule(runRules(ctx), "VGL-I001")[0]).toMatchObject({
      params: { price: "50000" },
      titleKey: "finding.VGL-I001.defaultLimit",
    });
  });

  it("a proposal created and executed in one transaction is not marked as proposed (squads-create-with-lookup-table.json)", async () => {
    const data = await loadFixture("squads-create-with-lookup-table");
    const [signature] = [...data.transactions.keys()];
    const { ctx } = await rawContext(data, signature ?? "");
    const nested = walkInstructions(ctx.instructions).filter((at) => at.depth > 0);
    expect(nested.length).toBeGreaterThan(0);
    expect(nested.every((at) => !at.proposed)).toBe(true);
    expect(byRule(runRules(ctx), "VGL-I003")).toHaveLength(1);
  });

  it("batch and vault proposals only being created are marked as proposed (squads-batch-and-token-2022.json)", async () => {
    const data = await loadFixture("squads-batch-and-token-2022");
    for (const signature of data.transactions.keys()) {
      const { ctx } = await rawContext(data, signature);
      const nested = walkInstructions(ctx.instructions).filter((at) => at.depth > 0);
      expect(nested.length, signature).toBeGreaterThan(0);
      expect(
        nested.every((at) => at.proposed),
        signature,
      ).toBe(true);
    }
  });
});
