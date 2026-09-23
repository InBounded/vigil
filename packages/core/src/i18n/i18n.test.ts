import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type Address, address, type Signature } from "@solana/kit";
import * as memoProgram from "@solana-program/memo";
import * as system from "@solana-program/system";
import * as token from "@solana-program/token";
import { AuthorityType } from "@solana-program/token";
import * as token2022 from "@solana-program/token-2022";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { annotateInstructions } from "../annotate.js";
import { PROGRAM_DECODERS } from "../decoders/decode.js";
import { TOKEN_2022_AUTHORITY_TYPES } from "../decoders/native/token-2022.js";
import { decodeRawTransaction } from "../decoders/transaction.js";
import { ANALYSIS_GAP_CODES, type ConfigAction, type DecodedInstruction } from "../report.js";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import { loadFixtureFile } from "../rpc/fixture-file.js";
import type { FixtureData } from "../rpc/index.js";
import { SquadsV4Adapter } from "../squads/adapter.js";
import { configActionsFromInstruction } from "../squads/config-actions.js";
import { addr, decodeBuilt, signer } from "../test-support/rules.js";
import {
  CATALOGS,
  formatAmount,
  LOCALES,
  renderConfigAction,
  renderGap,
  renderSummary,
  shortAddress,
} from "./render.js";

const FIXTURES = fileURLToPath(new URL("../../../../fixtures/", import.meta.url));

const placeholders = (template: string) =>
  [...template.matchAll(/\{([A-Za-z0-9_.]+)(?::([A-Za-z]+))?\}/g)].map((m) => m[0]).sort();

function flatten(instructions: readonly DecodedInstruction[]): DecodedInstruction[] {
  return instructions.flatMap((ix) => [ix, ...flatten(ix.inner ?? [])]);
}

describe("i18n catalogs", () => {
  it("have exactly the same keys in English and European Portuguese", () => {
    expect(Object.keys(CATALOGS["pt-PT"]).sort()).toEqual(Object.keys(CATALOGS.en).sort());
  });

  it("use the same placeholders in both languages for every key", () => {
    for (const [key, template] of Object.entries(CATALOGS.en)) {
      expect(placeholders(CATALOGS["pt-PT"][key] ?? ""), key).toEqual(placeholders(template));
    }
  });

  it("give every native and Squads instruction a summary in both languages", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const decoder of PROGRAM_DECODERS) {
      expect(decoder.instructionNames.length, decoder.key).toBeGreaterThan(0);
      for (const name of decoder.instructionNames) {
        for (const locale of LOCALES) {
          checked++;
          if (CATALOGS[locale][`ix.${decoder.key}.${name}`] === undefined) {
            missing.push(`${locale} ix.${decoder.key}.${name}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(400);
  });

  it("explain every analysis gap to the signer in both languages", () => {
    for (const code of ANALYSIS_GAP_CODES) {
      for (const locale of LOCALES) {
        expect(CATALOGS[locale][`gap.${code}`], `${locale} ${code}`).toBeDefined();
      }
    }
    expect(renderGap({ code: "IDL_AT_URL", message: "" }, "en")).toContain(
      "never opens links found on the chain",
    );
  });

  it("name every SPL Token and Token-2022 authority type in both languages", () => {
    const types = [
      ...TOKEN_2022_AUTHORITY_TYPES,
      ...Object.values(AuthorityType).filter((v): v is string => typeof v === "string"),
    ];
    for (const type of types) {
      for (const locale of LOCALES) {
        expect(CATALOGS[locale][`authority.${type}`], `${locale} ${type}`).toBeDefined();
      }
    }
  });

  it("contain no raw HTML or template syntax other than placeholders", () => {
    for (const locale of LOCALES) {
      for (const [key, template] of Object.entries(CATALOGS[locale])) {
        expect(template, key).not.toMatch(/[<>]/);
        expect(template.replace(/\{[A-Za-z0-9_.]+(?::[A-Za-z]+)?\}/g, ""), key).not.toMatch(/[{}]/);
      }
    }
  });
});

describe("number formatting", () => {
  it("formats base units exactly with bigint arithmetic, trimming trailing zeros", () => {
    expect(formatAmount(250000000000n, 6, "en")).toBe("250,000");
    expect(formatAmount("13446797098256", 9, "en")).toBe("13,446.797098256");
    expect(formatAmount("1", 9, "en")).toBe("0.000000001");
    expect(formatAmount("18446744073709551615", 0, "en")).toBe("18,446,744,073,709,551,615");
    expect(formatAmount("0", 6, "en")).toBe("0");
  });

  it("uses a no-break-space group separator and a decimal comma in pt-PT", () => {
    expect(formatAmount(250000500000n, 6, "pt-PT")).toBe("250\u00A0000,5");
  });

  it("groups pt-PT digits only from five digits, like CLDR and Intl", () => {
    expect(formatAmount("1000", 0, "pt-PT")).toBe("1000");
    expect(formatAmount("9999500", 3, "pt-PT")).toBe("9999,5");
    expect(formatAmount("10000", 0, "pt-PT")).toBe("10\u00A0000");
    expect(formatAmount("1000", 0, "en")).toBe("1,000");
    const intl = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 0 });
    for (const n of [1000, 9999, 10000, 1234567]) {
      expect(formatAmount(String(n), 0, "pt-PT")).toBe(intl.format(n).replace(/\s/g, "\u00A0"));
    }
  });

  it("shortens addresses to the first and last four characters", () => {
    expect(shortAddress("Gh3wV2hQvA4dq8x4Ld1PnJ7nzJ5kJ4mE3wWfHq1Lq7m")).toBe("Gh3w…Lq7m");
  });
});

describe("summaries of real mainnet instructions", () => {
  let transfers: FixtureData;
  beforeAll(async () => {
    transfers = await loadFixtureFile(`${FIXTURES}squads-token-transfers.json`);
  });

  async function proposal(): Promise<DecodedInstruction[]> {
    const tx = transfers.transactions.get(
      "euBTzbwHWGePPcB158kTa5qqC5U1AVNab15FDtDRhRgCzJm3BiYQyzHQtWcqpGoa2TVfvoXf1yh6fTdbkBfd9qD" as Signature,
    );
    if (tx === undefined) {
      throw new Error("missing transaction");
    }
    const rpc = new FixtureRpcClient(transfers);
    const decoded = await decodeRawTransaction(rpc, tx.transactionBase64);
    const multisigAddress = address("HpGrGa8tE1wxgxaNEasb71SYmgXUdwU5U7ZzpbLWgAs");
    const multisig = await new SquadsV4Adapter(rpc).fetchMultisig(multisigAddress);
    const annotated = await annotateInstructions(rpc, decoded.instructions, {
      cluster: "mainnet",
      multisig: {
        address: multisigAddress,
        members: multisig.members.map((m) => m.key),
        vaultIndex: 0,
      },
    });
    return flatten(annotated.instructions);
  }

  it("says what a Squads vault transfer does, in plain words, in both languages", async () => {
    // 99pbDSgf... is the real owner of destination token account 6jzsmLLz... (and the recipient
    // named in the proposal's own memo, "Transfer (2/8) -> 99pbDSgf...").
    const all = await proposal();
    const idle = all.find((ix) => ix.args?.amount === 13446797098256n);
    if (idle === undefined) {
      throw new Error("missing transfer");
    }
    const en = renderSummary(idle, "en");
    expect(en.missing).toEqual([]);
    expect(en.text).toBe(
      "Transfers 13,446.797098256 of token BjcR…EroT (declared name “IdleMine”, symbol “IDLE”) from Vault #0 to 99pb…6WHB (token account 6jzs…4LKC)",
    );
    const pt = renderSummary(idle, "pt-PT");
    expect(pt.missing).toEqual([]);
    expect(pt.text).toBe(
      "Transfere 13\u00A0446,797098256 do token BjcR…EroT (nome declarado “IdleMine”, símbolo “IDLE”) de Cofre n.º 0 para 99pb…6WHB (conta de token 6jzs…4LKC)",
    );
    // With full addresses (the CLI), every address is complete and follows its label.
    const full = renderSummary(idle, "en", { addresses: "full" });
    expect(full.missing).toEqual([]);
    const vault = idle.accounts.find((a) => a.role === "authority")?.address;
    const destination = idle.accounts.find((a) => a.role === "destination")?.address;
    const source = idle.accounts.find((a) => a.role === "source")?.address;
    expect(full.text).toContain(`from Vault #0’s token account (${source}) to `);
    expect(vault).toBeDefined();
    expect(full.text).toContain(`(token account ${destination})`);
    expect(full.text).not.toContain("\u2026");
    const create = all.find((ix) => ix.name === "vaultTransactionCreate");
    expect(create && renderSummary(create, "en").text).toBe(
      "Creates a transaction for this multisig to run from vault #0 (its instructions are listed below)",
    );
  });

  it("renders every instruction of every real fixture in both languages with no missing values", async () => {
    const warn = vi.spyOn(console, "warn");
    const files = (await readdir(FIXTURES)).filter((f) => f.endsWith(".json"));
    let rendered = 0;
    const problems: string[] = [];
    for (const file of files) {
      const data = await loadFixtureFile(`${FIXTURES}${file}`);
      const rpc = new FixtureRpcClient(data);
      for (const [signature, tx] of data.transactions) {
        const decoded = await decodeRawTransaction(rpc, tx.transactionBase64);
        const annotated = await annotateInstructions(rpc, decoded.instructions, {
          cluster: "mainnet",
        });
        for (const ix of flatten(annotated.instructions)) {
          for (const locale of LOCALES) {
            const { text, missing } = renderSummary(ix, locale);
            rendered++;
            if (ix.decoder !== "none" && missing.length > 0) {
              problems.push(
                `${file} ${signature.slice(0, 8)} ${ix.summary?.key} ${locale}: ${missing}`,
              );
            }
            if (/[{}]/.test(text)) {
              problems.push(
                `${file} ${signature.slice(0, 8)} ${ix.summary?.key}: unrendered braces`,
              );
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(rendered).toBeGreaterThan(100);
    // Codama conversion warnings are captured, never printed.
    expect(warn).not.toHaveBeenCalled();
  });

  it("says an instruction could not be decoded instead of staying silent", () => {
    const text = renderSummary(
      {
        accounts: [],
        decoder: "none",
        index: 0,
        programId: address("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95") as Address,
        provenance: "onchain",
        rawDataHex: "00",
      },
      "en",
    ).text;
    expect(text).toBe("Instruction that could not be decoded: what it does is unknown");
  });
});

describe("on-chain text in summaries is never translated", () => {
  const A = addr(1);
  const B = addr(2);

  it("shows a memo and a seed that read “none” exactly as written", () => {
    const memo = decodeBuilt(memoProgram.getAddMemoInstruction({ memo: "none" }));
    expect(memo.summary?.nullParams).toBeUndefined();
    expect(renderSummary(memo, "pt-PT").text).toBe("Adiciona a nota “none”");
    const seeded = decodeBuilt(
      system.getCreateAccountWithSeedInstruction({
        amount: 1n,
        base: A,
        baseAccount: signer(A),
        newAccount: B,
        payer: signer(A),
        programAddress: A,
        seed: "none",
        space: 0n,
      }),
    );
    expect(renderSummary(seeded, "pt-PT").text).toContain("(semente “none”)");
  });

  it("still says “none” for an argument that is really null, in each language", () => {
    const pointer = decodeBuilt(
      token2022.getInitializeMetadataPointerInstruction({
        authority: null,
        metadataAddress: B,
        mint: A,
      }),
    );
    expect(pointer.summary?.nullParams).toEqual(["authority"]);
    expect(renderSummary(pointer, "en").text).toMatch(/\(authority none\)$/);
    expect(renderSummary(pointer, "pt-PT").text).toMatch(/\(autoridade nenhum\)$/);
    const removed = decodeBuilt(
      token.getSetAuthorityInstruction({
        authorityType: AuthorityType.FreezeAccount,
        newAuthority: null,
        owned: A,
        owner: B,
      }),
    );
    expect(renderSummary(removed, "en").text).toBe(
      `Removes the freeze authority of ${shortAddress(A)} permanently`,
    );
  });

  it("does not treat a value reading “none” as absent unless the summary says it was null", () => {
    const instruction = decodeBuilt(memoProgram.getAddMemoInstruction({ memo: "x" }));
    const summary = {
      key: "ix.token.setAuthority",
      params: { authorityType: "MintTokens", newAuthority: "none", owned: A },
    };
    expect(renderSummary({ ...instruction, summary }, "en").text).toBe(
      `Changes the mint authority of ${shortAddress(A)} to none`,
    );
    expect(
      renderSummary({ ...instruction, summary: { ...summary, nullParams: ["newAuthority"] } }, "en")
        .text,
    ).toBe(`Removes the mint authority of ${shortAddress(A)} permanently`);
  });
});

describe("settings changes of config proposals", () => {
  it("renders every action of the real config transactions in both languages", async () => {
    let rendered = 0;
    for (const name of ["config-transaction", "config-transaction-2"]) {
      const data = await loadFixtureFile(`${FIXTURES}${name}.json`);
      const rpc = new FixtureRpcClient(data);
      for (const tx of data.transactions.values()) {
        const decoded = await decodeRawTransaction(rpc, tx.transactionBase64);
        for (const instruction of flatten(decoded.instructions)) {
          for (const action of configActionsFromInstruction(instruction) ?? []) {
            for (const locale of LOCALES) {
              const text = renderConfigAction(action, locale, {}, { addresses: "full" });
              expect(text.missing, `${action.kind} ${locale}`).toEqual([]);
              expect(text.text).not.toContain("{");
            }
            rendered++;
          }
        }
      }
    }
    expect(rendered).toBeGreaterThan(0);
  });

  it("covers every kind of action, including a removed rent collector and SOL limits", () => {
    const member = addr(7);
    const actions: ConfigAction[] = [
      { kind: "addMember", member, permissions: ["Initiate", "Vote"] },
      { kind: "addMember", member, permissions: [] },
      { kind: "removeMember", member },
      { kind: "changeThreshold", newThreshold: 3 },
      { kind: "setTimeLock", newTimeLockSeconds: 86_400 },
      {
        amount: 5_000_000n,
        createKey: addr(8),
        destinations: [],
        kind: "addSpendingLimit",
        members: [member],
        mint: "11111111111111111111111111111111" as Address,
        period: "Day",
        vaultIndex: 0,
      },
      {
        amount: 5_000_000n,
        createKey: addr(8),
        destinations: [addr(9)],
        kind: "addSpendingLimit",
        members: [member],
        mint: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
        period: "Week",
        vaultIndex: 1,
      },
      { kind: "removeSpendingLimit", spendingLimit: addr(10) },
      { kind: "setRentCollector", newRentCollector: null },
      { kind: "setRentCollector", newRentCollector: addr(11) },
      { kind: "setConfigAuthority", newConfigAuthority: addr(12) },
    ];
    const en = actions.map((action) => renderConfigAction(action, "en").text);
    expect(en).toEqual([
      `Add ${shortAddress(member)} as a member, with permissions: initiate, vote`,
      `Add ${shortAddress(member)} as a member, with permissions: none`,
      `Remove member ${shortAddress(member)}`,
      "Change the approvals needed to 3",
      "Set the waiting time before execution to 1 d",
      `Add a spending limit: vault #0 may send 0.005 SOL per day without a vote; members who may use it: ${shortAddress(member)}; to any destination`,
      `Add a spending limit: vault #1 may send 5,000,000 base units of token EPjF…Dt1v (decimals unknown) per week without a vote; members who may use it: ${shortAddress(member)}; destinations: ${shortAddress(addr(9))}`,
      `Remove spending limit ${shortAddress(addr(10))}`,
      "Remove the rent collector",
      `Set the rent collector to ${shortAddress(addr(11))}`,
      `Change the config authority to ${shortAddress(addr(12))}`,
    ]);
    const usdc = renderConfigAction(actions[6] as ConfigAction, "pt-PT", {
      tokens: [
        {
          decimals: 6,
          mint: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
          registry: { name: "USD Coin", symbol: "USDC" },
          tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        },
      ],
    });
    expect(usdc.text).toContain("pode enviar 5 USDC por semana sem votação");
    for (const action of actions) {
      expect(renderConfigAction(action, "pt-PT").missing).toEqual([]);
    }
  });
});
