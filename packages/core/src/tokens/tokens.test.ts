import { fileURLToPath } from "node:url";
import { type Address, address, getBase64Encoder, type Signature } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { annotateInstructions } from "../annotate.js";
import { decodeRawTransaction } from "../decoders/transaction.js";
import { renderSummary } from "../i18n/render.js";
import { REGISTRY_TOKENS } from "../registry/index.js";
import type { DecodedInstruction } from "../report.js";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import { loadFixtureFile } from "../rpc/fixture-file.js";
import type { FixtureData, RpcClient } from "../rpc/index.js";
import { SquadsV4Adapter } from "../squads/adapter.js";
import {
  findMetaplexMetadataAddress,
  parseMetaplexMetadata,
  parseMintAccount,
  parseTokenAccount,
  type RawAccount,
} from "./accounts.js";
import { enrichTokenAmounts } from "./enrich.js";

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../../fixtures/${name}.json`, import.meta.url));
}

const base64 = getBase64Encoder();

function raw(data: FixtureData, at: Address): RawAccount {
  const info = data.accounts.get(at);
  if (info === undefined) {
    throw new Error(`fixture has no account ${at}`);
  }
  return { data: base64.encode(info.dataBase64), owner: info.owner };
}

const MULTISIG = address("HpGrGa8tE1wxgxaNEasb71SYmgXUdwU5U7ZzpbLWgAs");
const VAULT_0 = address("Cv7e4t2LM1chzziHZA8aRvfT24nvbdcjHvoTMXPNLCu7");
const CREATOR = address("HqgTVEqKuYfji4WtUKyJDqXGna5C2sa67SSkMry8zCJb");
const PROPOSAL_TX =
  "euBTzbwHWGePPcB158kTa5qqC5U1AVNab15FDtDRhRgCzJm3BiYQyzHQtWcqpGoa2TVfvoXf1yh6fTdbkBfd9qD" as Signature;

let transfers: FixtureData;
let registryMints: FixtureData;
beforeAll(async () => {
  transfers = await loadFixtureFile(fixturePath("squads-token-transfers"));
  registryMints = await loadFixtureFile(fixturePath("registry-mints"));
});

async function decodedProposal(data: FixtureData = transfers): Promise<DecodedInstruction[]> {
  const tx = data.transactions.get(PROPOSAL_TX);
  if (tx === undefined) {
    throw new Error("fixture is missing the proposal transaction");
  }
  const result = await decodeRawTransaction(new FixtureRpcClient(data), tx.transactionBase64);
  expect(result.gaps).toEqual([]);
  return [...result.instructions];
}

function embedded(instructions: readonly DecodedInstruction[]): DecodedInstruction[] {
  const create = instructions.find((ix) => ix.name === "vaultTransactionCreate");
  return [...(create?.inner ?? [])];
}

describe("the curated token registry against live mainnet mint accounts", () => {
  it("has the owner program and decimals the chain reports for every entry", () => {
    for (const token of REGISTRY_TOKENS) {
      const mint = parseMintAccount(raw(registryMints, token.address));
      expect(mint, token.symbol).not.toBeNull();
      expect(mint?.tokenProgram, token.symbol).toBe(token.tokenProgram);
      expect(mint?.decimals, token.symbol).toBe(token.decimals);
    }
  });
});

describe("token account readers against real mainnet accounts", () => {
  it("reads SPL Token and Token-2022 token accounts (mint and owner)", () => {
    expect(
      parseTokenAccount(raw(transfers, address("6oWjfjgTHY5PE7gjH4QiHNMMvxjWjnpgJZy62Kp1U7Uk"))),
    ).toEqual({
      mint: "BjcRmwm8e25RgjkyaFE56fc7bxRgGPw96JUkXRJFEroT",
      owner: VAULT_0,
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    });
    expect(
      parseTokenAccount(raw(transfers, address("J8Pyd9cxemXD5kGgxf5WgKD3hFR4XFSm9tarp9oYuNwB"))),
    ).toEqual({
      mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
      owner: VAULT_0,
      tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    });
  });

  it("reads the Token-2022 TokenMetadata extension from inside the mint", () => {
    expect(
      parseMintAccount(raw(transfers, address("XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"))),
    ).toEqual({
      decimals: 8,
      extensionMetadata: { name: "Tesla xStock", symbol: "TSLAx" },
      tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    });
  });

  it("reads Metaplex metadata at the derived PDA, stripping the NUL padding", async () => {
    const mint = address("6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN");
    const metadata = await findMetaplexMetadataAddress(mint);
    expect(metadata).toBe("H7efTb73LpehuDBaPqZ81Gc585PDf1bCbtQnVb8JpgB8");
    expect(parseMetaplexMetadata(raw(transfers, metadata), mint)).toEqual({
      name: "OFFICIAL TRUMP",
      symbol: "TRUMP",
    });
  });

  it("refuses metadata that belongs to a different mint or another owner", async () => {
    const trump = await findMetaplexMetadataAddress(
      address("6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN"),
    );
    const account = raw(transfers, trump);
    expect(
      parseMetaplexMetadata(account, address("2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv")),
    ).toBeNull();
    expect(
      parseMetaplexMetadata(
        { ...account, owner: address("11111111111111111111111111111111") },
        address("6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN"),
      ),
    ).toBeNull();
  });

  it("does not mistake a token account for a mint, or a mint for a token account", () => {
    expect(
      parseMintAccount(raw(transfers, address("6oWjfjgTHY5PE7gjH4QiHNMMvxjWjnpgJZy62Kp1U7Uk"))),
    ).toBeNull();
    expect(
      parseTokenAccount(
        raw(registryMints, address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")),
      ),
    ).toBeNull();
  });
});

describe("token amounts in a real Squads proposal (unchecked SPL transfers + Token-2022)", () => {
  it("adds the mint, decimals and declared name to unchecked transfers by reading the source account", async () => {
    const result = await enrichTokenAmounts(
      new FixtureRpcClient(transfers),
      await decodedProposal(),
      "mainnet",
    );
    expect(result.gaps).toEqual([]);
    const inner = embedded(result.instructions);
    const idle = inner.find((ix) => ix.args?.amount === 13446797098256n);
    expect(idle?.name).toBe("transfer");
    expect(idle?.summary?.params).toMatchObject({
      amount: "13446797098256",
      decimals: "9",
      declaredName: "IdleMine",
      declaredSymbol: "IDLE",
      mint: "BjcRmwm8e25RgjkyaFE56fc7bxRgGPw96JUkXRJFEroT",
    });
    const tesla = inner.find((ix) => ix.args?.amount === 387012n);
    expect(tesla?.summary?.params).toMatchObject({
      decimals: "8",
      declaredName: "Tesla xStock",
      declaredSymbol: "TSLAx",
      mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    });
    expect(result.tokens.map((t) => [t.mint, t.decimals, t.declared?.source])).toEqual([
      ["2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv", 6, "metaplex"],
      ["6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", 6, "metaplex"],
      ["BjcRmwm8e25RgjkyaFE56fc7bxRgGPw96JUkXRJFEroT", 9, "metaplex"],
      ["XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", 8, "token-2022-metadata"],
      ["XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1", 8, "token-2022-metadata"],
    ]);
  });

  it("reports a gap and keeps base units when the source account cannot be read", async () => {
    const accounts = new Map(transfers.accounts);
    accounts.delete(address("6oWjfjgTHY5PE7gjH4QiHNMMvxjWjnpgJZy62Kp1U7Uk"));
    const data = { ...transfers, accounts };
    const result = await enrichTokenAmounts(
      new FixtureRpcClient(data),
      await decodedProposal(data),
      "mainnet",
    );
    expect(result.gaps).toHaveLength(4);
    expect(result.gaps[0]).toMatchObject({
      address: "6oWjfjgTHY5PE7gjH4QiHNMMvxjWjnpgJZy62Kp1U7Uk",
      code: "TOKEN_DECIMALS_UNKNOWN",
      instructionIndex: 2,
    });
    const idle = embedded(result.instructions).find((ix) => ix.args?.amount === 13446797098256n);
    expect(idle?.summary?.params).not.toHaveProperty("decimals");
    expect(idle?.summary?.params).not.toHaveProperty("mint");
  });

  it("reports a gap for every amount when the RPC fails, and never throws", async () => {
    class FailingRpc extends FixtureRpcClient {
      override getMultipleAccounts(): ReturnType<RpcClient["getMultipleAccounts"]> {
        return Promise.reject(new Error("503 from rpc.example"));
      }
    }
    const failing = new FailingRpc(transfers);
    const result = await enrichTokenAmounts(failing, await decodedProposal(), "mainnet");
    // 6 unchecked transfers need the RPC; the 2 transferChecked carry their own decimals.
    expect(result.gaps).toHaveLength(6);
    expect(result.gaps[0]?.message).toContain("503 from rpc.example");
  });
});

describe("annotateInstructions: labels on a real Squads proposal", () => {
  it("labels vault #0, the multisig, its members, programs and sysvars", async () => {
    const multisig = await new SquadsV4Adapter(new FixtureRpcClient(transfers)).fetchMultisig(
      MULTISIG,
    );
    const { instructions } = await annotateInstructions(
      new FixtureRpcClient(transfers),
      await decodedProposal(),
      {
        cluster: "mainnet",
        multisig: { address: MULTISIG, members: multisig.members.map((m) => m.key), vaultIndex: 0 },
      },
    );
    const create = instructions.find((ix) => ix.name === "vaultTransactionCreate");
    const labelOf = (role: string) => create?.accounts.find((a) => a.role === role)?.label;
    expect(labelOf("multisig")).toEqual({ key: "label.multisig", params: {}, source: "multisig" });
    expect(labelOf("creator")).toEqual({ key: "label.member", params: {}, source: "multisig" });
    expect(labelOf("systemProgram")).toEqual({
      key: "label.program",
      params: { name: "System Program" },
      source: "registry",
    });
    const transfer = embedded(instructions).find((ix) => ix.name === "transfer");
    expect(transfer?.accounts.find((a) => a.role === "authority")).toMatchObject({
      address: VAULT_0,
      label: { key: "label.vault", params: { index: "0" }, source: "multisig" },
    });
    expect(CREATOR).toBe(create?.accounts.find((a) => a.role === "creator")?.address);
  });
});

describe("registry mints whose mint account is not read", () => {
  const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  let native: FixtureData;
  let usdcTransfer: DecodedInstruction[];
  beforeAll(async () => {
    native = await loadFixtureFile(fixturePath("native-instructions"));
    const signature = [...native.transactions.keys()].find((s) => s.startsWith("3Feg3sty"));
    const tx = signature === undefined ? undefined : native.transactions.get(signature);
    if (tx === undefined) {
      throw new Error("fixture is missing the USDC transfer");
    }
    const decoded = await decodeRawTransaction(new FixtureRpcClient(native), tx.transactionBase64);
    usdcTransfer = [...decoded.instructions];
  });

  it("names a real USDC transfer from the registry when the mint account was not captured", async () => {
    expect(native.accounts.has(USDC)).toBe(false);
    const result = await enrichTokenAmounts(new FixtureRpcClient(native), usdcTransfer, "mainnet");
    expect(result.gaps).toEqual([]);
    const transfer = result.instructions.find((ix) => ix.name === "transferChecked");
    expect(transfer?.summary?.params).toMatchObject({ decimals: "6", mint: USDC, symbol: "USDC" });
    expect(result.tokens).toEqual([
      {
        decimals: 6,
        decimalsSource: "registry",
        mint: USDC,
        registry: { name: "USD Coin", symbol: "USDC" },
        tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      },
    ]);
    if (transfer === undefined) {
      throw new Error("no transfer");
    }
    expect(renderSummary(transfer, "en").text).toContain("50 USDC");
    expect(renderSummary(transfer, "pt-PT").text).toContain("50 USDC");
  });

  it("uses the mint account itself when it can be read (no registry fallback)", async () => {
    const withMint = {
      ...native,
      accounts: new Map([...native.accounts, ...registryMints.accounts]),
    };
    const result = await enrichTokenAmounts(
      new FixtureRpcClient(withMint),
      usdcTransfer,
      "mainnet",
    );
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0]).not.toHaveProperty("decimalsSource");
    expect(result.tokens[0]?.registry?.symbol).toBe("USDC");
  });

  it("keeps base units and a gap for a mint outside the registry whose account cannot be read", async () => {
    const IDLE = address("BjcRmwm8e25RgjkyaFE56fc7bxRgGPw96JUkXRJFEroT");
    const accounts = new Map(transfers.accounts);
    accounts.delete(IDLE);
    const data = { ...transfers, accounts };
    const result = await enrichTokenAmounts(
      new FixtureRpcClient(data),
      await decodedProposal(data),
      "mainnet",
    );
    expect(result.gaps).toHaveLength(4);
    expect(result.gaps[0]?.message).toContain("the mint account could not be read");
    const idle = embedded(result.instructions).find((ix) => ix.args?.amount === 13446797098256n);
    expect(idle?.summary?.params).toMatchObject({ mint: IDLE });
    expect(idle?.summary?.params).not.toHaveProperty("decimals");
    expect(result.tokens.map((t) => t.mint)).not.toContain(IDLE);
  });
});
