/**
 * Warning rules: positive and negative cases. Real decoded transactions are covered in
 * `fixtures.test.ts`; here instructions are encoded with the official builders, and facts gathered
 * in Phase 5 (balances, simulation, verification, history) are given by hand.
 */
import { type Address, address } from "@solana/kit";
import * as system from "@solana-program/system";
import * as token from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { renderFinding } from "../i18n/render.js";
import type { DecodedInstruction, Finding, ProgramInfo } from "../report.js";
import type { SanitizedString } from "../sanitize/sanitize.js";
import {
  account,
  addr,
  context,
  decodeBuilt,
  instruction,
  multisig,
  SIM_RUN,
  signer,
} from "../test-support/rules.js";
import type { TokenInfo } from "../tokens/enrich.js";
import {
  durableNonce,
  fragileMultisig,
  impersonatingToken,
  incompleteAnalysis,
  largeTransfer,
  newDestination,
  opaqueInstruction,
  simulationProblem,
  thirdPartyUpgradeable,
  unexpectedBalanceChanges,
  unverifiedProgram,
} from "./catalog/warning.js";
import { PROGRAMS } from "./helpers.js";

const A = addr(1);
const B = addr(2);
const C = addr(3);
const THIRD_PARTY_PROGRAM = addr(40);
const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

function only(findings: readonly Finding[]): Finding {
  expect(findings).toHaveLength(1);
  const [first] = findings;
  if (first === undefined) {
    throw new Error("no finding");
  }
  return first;
}

const call = (programId: Address, index = 0) =>
  instruction({ decoder: "anchor-idl", index, programId, provenance: "idl-declared" });

const solTransfer = (amount: bigint, from: Address = A, to: Address = B) =>
  decodeBuilt(system.getTransferSolInstruction({ amount, destination: to, source: signer(from) }));

/** A token transfer as token enrichment leaves it (mint, decimals, symbol, destination owner). */
const usdcTransfer = (amount: bigint, params: Record<string, string> = {}) => {
  const built = decodeBuilt(
    token.getTransferInstruction({ amount, authority: A, destination: C, source: addr(30) }),
  );
  return {
    ...built,
    summary: {
      key: "ix.token.transfer",
      params: { decimals: "6", destinationOwner: B, mint: USDC, symbol: "USDC", ...params },
    },
  };
};

function withoutSummary(ix: DecodedInstruction): DecodedInstruction {
  const { summary: _summary, ...rest } = ix;
  return rest;
}

describe("VGL-W001 opaque instruction", () => {
  it("fires on every instruction no decoder understood, nested ones included", async () => {
    const ctx = await context({
      instructions: [
        instruction({ decoder: "none", programId: THIRD_PARTY_PROGRAM, rawDataHex: "0102" }),
        instruction({
          decoder: "squads",
          inner: [
            instruction({ decoder: "none", programId: PROGRAMS.token, programLabel: "SPL Token" }),
          ],
          programId: PROGRAMS.squads,
        }),
      ],
    });
    const found = opaqueInstruction.evaluate(ctx);
    expect(found.map((f) => [f.params.program, f.instructionIndex])).toEqual([
      [THIRD_PARTY_PROGRAM, 0],
      [PROGRAMS.token, 1],
    ]);
    expect(found[0]?.evidence).toContain("programLabel: none");
    expect(found[1]?.evidence).toContain("programLabel: SPL Token");
  });

  it("does not fire on decoded instructions", async () => {
    expect(opaqueInstruction.evaluate(await context({ instructions: [solTransfer(1n)] }))).toEqual(
      [],
    );
  });
});

describe("VGL-W002 program not verified", () => {
  const info = (verification: ProgramInfo["verification"]): ProgramInfo => ({
    address: THIRD_PARTY_PROGRAM,
    upgrade: { kind: "immutable" },
    verification,
  });

  it("fires once per called program that is unverified or of unknown status", async () => {
    const unverified = await context({
      instructions: [call(THIRD_PARTY_PROGRAM), call(THIRD_PARTY_PROGRAM, 1)],
      programs: [info("unverified")],
    });
    expect(only(unverifiedProgram.evaluate(unverified))).toMatchObject({
      params: { program: THIRD_PARTY_PROGRAM },
      provenance: "external-api",
      titleKey: "finding.VGL-W002.unverified",
    });
    const unknown = await context({ instructions: [call(THIRD_PARTY_PROGRAM)] });
    expect(only(unverifiedProgram.evaluate(unknown))).toMatchObject({
      provenance: "rule-inference",
      titleKey: "finding.VGL-W002.unknown",
    });
  });

  it("does not fire for verified programs or curated registry programs", async () => {
    const ctx = await context({
      instructions: [call(THIRD_PARTY_PROGRAM), solTransfer(1n)],
      programs: [info("verified")],
    });
    expect(unverifiedProgram.evaluate(ctx)).toEqual([]);
  });

  it("does not fire when the user turned verification lookups off (a gap says so instead)", async () => {
    const ctx = await context({
      instructions: [call(THIRD_PARTY_PROGRAM)],
      programs: [info("not-checked")],
    });
    expect(unverifiedProgram.evaluate(ctx)).toEqual([]);
  });
});

describe("VGL-W003 program upgradeable by a third party", () => {
  it("fires when someone outside the multisig can upgrade a called program", async () => {
    const ctx = await context({
      instructions: [call(THIRD_PARTY_PROGRAM)],
      programs: [
        {
          address: THIRD_PARTY_PROGRAM,
          upgrade: { authority: C, kind: "upgradeable" },
          verification: "verified",
        },
      ],
    });
    expect(only(thirdPartyUpgradeable.evaluate(ctx)).params).toEqual({
      authority: C,
      program: THIRD_PARTY_PROGRAM,
    });
  });

  it("does not fire for immutable or unknown programs, or ones this multisig controls", async () => {
    const ms = multisig();
    const base = await context({ multisig: ms });
    const [vault] = [...base.vaults.keys()];
    if (vault === undefined) {
      throw new Error("no vault");
    }
    for (const upgrade of [
      { kind: "immutable" } as const,
      { kind: "unknown" } as const,
      { authority: vault, kind: "upgradeable" } as const,
    ]) {
      const ctx = await context({
        instructions: [call(THIRD_PARTY_PROGRAM)],
        multisig: ms,
        programs: [{ address: THIRD_PARTY_PROGRAM, upgrade, verification: "verified" }],
      });
      expect(thirdPartyUpgradeable.evaluate(ctx), upgrade.kind).toEqual([]);
    }
    expect(
      thirdPartyUpgradeable.evaluate(await context({ instructions: [call(THIRD_PARTY_PROGRAM)] })),
    ).toEqual([]);
  });
});

describe("VGL-W004 large transfer", () => {
  it("fires at the percentage threshold of the balance, adding up transfers of the same asset", async () => {
    const ctx = await context({
      facts: { balances: [{ amount: 100_000_000n, asset: USDC, owner: A }] },
      instructions: [usdcTransfer(6_000_000n), usdcTransfer(4_000_000n)],
    });
    const found = only(largeTransfer.evaluate(ctx));
    expect(found).toMatchObject({
      params: { amount: "10000000", from: A, share: "10", symbol: "USDC", threshold: "10" },
      titleKey: "finding.VGL-W004.share",
    });
    expect(renderFinding(found, "en").text).toContain("Moves 10 USDC out of");
  });

  it("does not fire just below the threshold, nor when the balance is unknown and no amount is set", async () => {
    const below = await context({
      facts: { balances: [{ amount: 100_000_000n, asset: USDC, owner: A }] },
      instructions: [usdcTransfer(9_999_999n)],
    });
    expect(largeTransfer.evaluate(below)).toEqual([]);
    const unknown = await context({ instructions: [usdcTransfer(9_999_999_999n)] });
    expect(largeTransfer.evaluate(unknown)).toEqual([]);
  });

  it("honours a custom percentage with decimals, and absolute per-asset thresholds", async () => {
    const custom = await context({
      facts: { balances: [{ amount: 1_000_000_000n, asset: "SOL", owner: A }] },
      instructions: [solTransfer(12_345_678n)],
      options: { largeTransferPercent: 1.2 },
    });
    expect(only(largeTransfer.evaluate(custom)).params).toMatchObject({
      decimals: "9",
      share: "1.23",
      symbol: "SOL",
      threshold: "1.2",
    });

    const absolute = await context({
      instructions: [solTransfer(5_000_000_000n)],
      options: { largeTransferAbsolute: new Map([["SOL", 5_000_000_000n]]) },
    });
    const found = only(largeTransfer.evaluate(absolute));
    expect(found.titleKey).toBe("finding.VGL-W004.absolute");
    expect(found.params.share).toBe("unknown");
    expect(found.evidence).toContain("absoluteThresholdBaseUnits: 5000000000");
    const under = await context({
      instructions: [solTransfer(4_999_999_999n)],
      options: { largeTransferAbsolute: new Map([["SOL", 5_000_000_000n]]) },
    });
    expect(largeTransfer.evaluate(under)).toEqual([]);
  });

  it("treats any transfer out of an empty balance as large", async () => {
    const ctx = await context({
      facts: { balances: [{ amount: 0n, asset: "SOL", owner: A }] },
      instructions: [solTransfer(1n)],
    });
    expect(only(largeTransfer.evaluate(ctx)).params.share).toBe("100+");
  });

  it("keeps proposed and immediate transfers, senders and assets apart", async () => {
    const ctx = await context({
      facts: {
        balances: [
          { amount: 10n, asset: "SOL", owner: A },
          { amount: 10n, asset: "SOL", owner: C },
        ],
      },
      instructions: [
        solTransfer(1n),
        solTransfer(1n, C),
        instruction({ decoder: "squads", inner: [solTransfer(1n)], programId: PROGRAMS.squads }),
      ],
    });
    expect(largeTransfer.evaluate(ctx).map((f) => [f.params.from, f.params.proposed])).toEqual([
      [A, undefined],
      [C, undefined],
      [A, "true"],
    ]);
  });

  it("skips transfers whose sender, recipient, amount or asset cannot be established", async () => {
    const ctx = await context({
      facts: { balances: [{ amount: 1n, asset: USDC, owner: A }] },
      instructions: [
        instruction({ name: "transferSol", programId: PROGRAMS.system }),
        instruction({ args: { amount: 5n }, name: "transferSol", programId: PROGRAMS.system }),
        instruction({
          accounts: [account(A, "source")],
          args: { amount: 5n },
          name: "transferSol",
          programId: PROGRAMS.system,
        }),
        instruction({ args: { amount: 5n }, name: "transfer", programId: PROGRAMS.token }),
        usdcTransfer(5n, { mint: "not-a-mint" }),
        withoutSummary(usdcTransfer(5n)),
        instruction({ decoder: "none", name: "transfer", programId: PROGRAMS.token }),
        instruction({ args: { amount: 5n }, name: "burn", programId: PROGRAMS.token }),
      ],
    });
    expect(largeTransfer.evaluate(ctx)).toEqual([]);
  });

  it("uses the token account as the recipient when its owner is unknown", async () => {
    const ctx = await context({
      facts: { balances: [{ amount: 1n, asset: USDC, owner: A }] },
      instructions: [
        { ...usdcTransfer(5n), summary: { key: "x", params: { decimals: "6", mint: USDC } } },
      ],
    });
    expect(only(largeTransfer.evaluate(ctx)).evidence).toContain(`transfer: 0: 5 to ${C}`);
  });
});

describe("VGL-W005 new destination", () => {
  it("fires once per destination missing from the vault's recent history", async () => {
    const ctx = await context({
      facts: { recentDestinations: new Set([C]) },
      instructions: [solTransfer(1n), solTransfer(2n), solTransfer(3n, A, C)],
      options: { historyDepth: 50 },
    });
    expect(only(newDestination.evaluate(ctx)).params).toEqual({
      destination: B,
      historyDepth: "50",
    });
  });

  it("does not run when history is off or was not gathered, and skips own addresses", async () => {
    expect(
      newDestination.evaluate(
        await context({
          facts: { recentDestinations: new Set() },
          instructions: [solTransfer(1n)],
        }),
      ),
    ).toEqual([]);
    expect(
      newDestination.evaluate(
        await context({ instructions: [solTransfer(1n)], options: { historyDepth: 10 } }),
      ),
    ).toEqual([]);
    expect(
      newDestination.evaluate(
        await context({
          facts: { recentDestinations: new Set() },
          instructions: [solTransfer(1n)],
          options: { historyDepth: 10, knownAddresses: new Map([[B, "Payroll"]]) },
        }),
      ),
    ).toEqual([]);
  });
});

describe("VGL-W006 simulation failed or unavailable", () => {
  it("fires when simulation failed or could not run, with the detail sanitized", async () => {
    const failed = await context({
      simulation: { ...SIM_RUN, error: "custom program error: 0x1\u202E", status: "failed" },
    });
    const found = only(simulationProblem.evaluate(failed));
    expect(found).toMatchObject({
      params: { detail: "custom program error: 0x1" },
      titleKey: "finding.VGL-W006.failed",
    });
    expect(renderFinding(found, "pt-PT").text).toBe(
      "A simula\u00E7\u00E3o falhou: custom program error: 0x1",
    );
    const unavailable = await context({
      simulation: {
        code: "rpc-error",
        notes: SIM_RUN.notes,
        reason: "RPC timeout",
        status: "unavailable",
      },
    });
    expect(only(simulationProblem.evaluate(unavailable)).titleKey).toBe(
      "finding.VGL-W006.unavailable",
    );
  });

  it("does not fire when simulation succeeded or was turned off (that is a gap instead)", async () => {
    expect(
      simulationProblem.evaluate(
        await context({ simulation: { ...SIM_RUN, balanceChanges: [], status: "success" } }),
      ),
    ).toEqual([]);
    expect(simulationProblem.evaluate(await context())).toEqual([]);
  });
});

describe("VGL-W007 unexpected balance changes", () => {
  it("fires on changes to accounts no decoded instruction lists as writable", async () => {
    const ctx = await context({
      feePayer: A,
      instructions: [
        solTransfer(1n),
        instruction({
          accounts: [account(C, undefined, { isWritable: true })],
          decoder: "none",
          programId: THIRD_PARTY_PROGRAM,
        }),
      ],
      simulation: {
        ...SIM_RUN,
        balanceChanges: [
          { account: A, asset: "SOL", post: 0n, pre: 10n },
          { account: B, asset: "SOL", post: 11n, pre: 10n },
          { account: C, asset: "SOL", post: 0n, pre: 10n },
          { account: addr(60), asset: USDC, owner: C, post: 5n, pre: 5n },
          { account: addr(61), asset: USDC, owner: C, post: 1n, pre: 5n },
        ],
        status: "success",
      },
    });
    const found = only(unexpectedBalanceChanges.evaluate(ctx));
    expect(found.params).toEqual({ count: "2" });
    expect(found.evidence).toEqual([
      `change: ${C} SOL 10 -> 0 (-10)`,
      `change: ${addr(61)} ${USDC} 5 -> 1 (-4)`,
    ]);
  });

  it("reports the fee payer's SOL only when it increases, and a non-fee-payer's decrease", async () => {
    const ctx = await context({
      feePayer: C,
      simulation: {
        ...SIM_RUN,
        balanceChanges: [
          { account: C, asset: "SOL", post: 9n, pre: 10n },
          { account: C, asset: "SOL", post: 11n, pre: 10n },
          { account: C, asset: USDC, post: 1n, pre: 10n },
        ],
        status: "success",
      },
    });
    expect(only(unexpectedBalanceChanges.evaluate(ctx)).params.count).toBe("2");
  });

  it("does not fire when every change is explained, or without a successful simulation", async () => {
    const explained = await context({
      instructions: [solTransfer(1n)],
      simulation: {
        ...SIM_RUN,
        balanceChanges: [
          { account: A, asset: "SOL", post: 9n, pre: 10n },
          { account: B, asset: "SOL", post: 11n, pre: 10n },
        ],
        status: "success",
      },
    });
    expect(unexpectedBalanceChanges.evaluate(explained)).toEqual([]);
    expect(
      unexpectedBalanceChanges.evaluate(
        await context({ simulation: { ...SIM_RUN, error: "x", status: "failed" } }),
      ),
    ).toEqual([]);
  });
});

describe("VGL-W008 impersonating token", () => {
  const text = (value: string, flags: SanitizedString["flags"] = []): SanitizedString => ({
    flags,
    modified: false,
    text: value,
  });
  const declared = (
    symbol: SanitizedString,
    name: SanitizedString,
    mint: Address = addr(70),
  ): TokenInfo => ({
    declared: { name, source: "metaplex", symbol },
    decimals: 6,
    mint,
    tokenProgram: PROGRAMS.token,
  });

  it("fires on a look-alike of a registry symbol or name with a different mint", async () => {
    const ctx = await context({
      tokens: [
        // Cyrillic \u0405 (U+0405) and \u0421 (U+0421) in place of Latin S and C.
        declared(text("U\u0405D\u0421", ["non-ascii"]), text("Totally Legit")),
        declared(text("MEME"), text("u s d   c o i n"), addr(71)),
        // Capital I and digit zero; UTS #39 does not treat "1" as confusable with a lower-case "i".
        declared(text("JIT0SOL"), text("x"), addr(72)),
      ],
    });
    const found = impersonatingToken.evaluate(ctx);
    expect(found.map((f) => [f.titleKey, f.params.registrySymbol])).toEqual([
      ["finding.VGL-W008.impersonation", "USDC"],
      ["finding.VGL-W008.impersonation", "USDC"],
      ["finding.VGL-W008.impersonation", "JitoSOL"],
    ]);
    expect(found[0]?.evidence).toContain("flags: non-ascii");
    expect(found[0]?.params.registryMint).toBe(USDC);
    expect(renderFinding(found[1] as Finding, "en").text).toBe(
      `Token ${addr(71).slice(0, 4)}…${addr(71).slice(-4)} calls itself “MEME” (“u s d   c o i n”), which looks like USDC, but it is not the real USDC mint`,
    );
  });

  it("fires on suspicious characters even without a look-alike", async () => {
    const ctx = await context({
      tokens: [declared(text("PEPE"), text("Pepe\u0435", ["mixed-scripts"]))],
    });
    const found = only(impersonatingToken.evaluate(ctx));
    expect(found.titleKey).toBe("finding.VGL-W008.characters");
    expect(found.evidence).toContain("flags: mixed-scripts");
    expect(found.params.registrySymbol).toBeUndefined();
  });

  it("does not fire on registry tokens, tokens with no declared metadata, ordinary names, or off mainnet", async () => {
    const ordinary = await context({
      tokens: [
        {
          decimals: 6,
          mint: USDC,
          registry: { name: "USD Coin", symbol: "USDC" },
          tokenProgram: PROGRAMS.token,
        },
        { decimals: 6, mint: addr(73), tokenProgram: PROGRAMS.token },
        declared(text("BONK"), text("Bonk"), addr(74)),
        declared(text("X"), text("Truncated name", ["truncated"]), addr(75)),
        declared(text(""), text("..."), addr(76)),
      ],
    });
    expect(impersonatingToken.evaluate(ordinary)).toEqual([]);
    const devnet = await context({
      cluster: "devnet",
      tokens: [declared(text("USDC"), text("USD Coin"))],
    });
    expect(impersonatingToken.evaluate(devnet)).toEqual([]);
  });
});

describe("VGL-W009 durable nonce", () => {
  const advance = () =>
    decodeBuilt(
      system.getAdvanceNonceAccountInstruction({ nonceAccount: A, nonceAuthority: signer(B) }),
    );

  it("fires when a base64 transaction starts with AdvanceNonceAccount", async () => {
    const found = only(
      durableNonce.evaluate(await context({ instructions: [advance(), solTransfer(1n)] })),
    );
    expect(found).toMatchObject({
      instructionIndex: 0,
      params: { nonceAccount: A, nonceAuthority: B },
    });
  });

  it("does not fire when the nonce instruction is not first, for proposals, or on empty transactions", async () => {
    expect(
      durableNonce.evaluate(await context({ instructions: [solTransfer(1n), advance()] })),
    ).toEqual([]);
    expect(
      durableNonce.evaluate(
        await context({
          input: { kind: "squads-proposal", multisig: A, transactionIndex: 1n },
          instructions: [advance()],
        }),
      ),
    ).toEqual([]);
    expect(durableNonce.evaluate(await context())).toEqual([]);
  });
});

describe("VGL-W010 fragile multisig", () => {
  it("fires on a threshold of 1 and on a config authority", async () => {
    const ctx = await context({
      multisig: multisig({ configAuthority: C, isControlled: true, threshold: 1 }),
    });
    const found = fragileMultisig.evaluate(ctx);
    expect(found.map((f) => f.titleKey)).toEqual([
      "finding.VGL-W010.threshold",
      "finding.VGL-W010.controlled",
    ]);
    expect(found[1]?.params.configAuthority).toBe(C);
  });

  it("does not fire on an autonomous multisig with threshold 2, or without a multisig", async () => {
    expect(fragileMultisig.evaluate(await context({ multisig: multisig() }))).toEqual([]);
    expect(fragileMultisig.evaluate(await context())).toEqual([]);
  });
});

describe("VGL-W011 incomplete analysis", () => {
  it("fires when there is any gap, listing them", async () => {
    const ctx = await context({
      gaps: [
        { code: "SIMULATION_DISABLED", message: "turned off" },
        { code: "TOKEN_DECIMALS_UNKNOWN", message: "mint not read" },
      ],
    });
    const found = only(incompleteAnalysis.evaluate(ctx));
    expect(found.params).toEqual({ count: "2" });
    expect(found.evidence).toEqual([
      "SIMULATION_DISABLED: turned off",
      "TOKEN_DECIMALS_UNKNOWN: mint not read",
    ]);
  });

  it("does not fire on a complete analysis", async () => {
    expect(incompleteAnalysis.evaluate(await context())).toEqual([]);
  });
});
