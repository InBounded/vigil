import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type Address, address, type Signature } from "@solana/kit";
import { AuthorityType } from "@solana-program/token";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { annotateInstructions } from "../annotate.js";
import { PROGRAM_DECODERS } from "../decoders/decode.js";
import { TOKEN_2022_AUTHORITY_TYPES } from "../decoders/native/token-2022.js";
import { decodeRawTransaction } from "../decoders/transaction.js";
import { ANALYSIS_GAP_CODES, type DecodedInstruction } from "../report.js";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import { loadFixtureFile } from "../rpc/fixture-file.js";
import type { FixtureData } from "../rpc/index.js";
import { SquadsV4Adapter } from "../squads/adapter.js";
import {
  CATALOGS,
  formatAmount,
  LOCALES,
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
    const create = all.find((ix) => ix.name === "vaultTransactionCreate");
    expect(create && renderSummary(create, "en").text).toBe(
      "Creates a transaction for this multisig to run from vault #0 (its instructions are listed below)",
    );
  });

  it("renders every instruction of every real fixture in both languages with no missing values", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
