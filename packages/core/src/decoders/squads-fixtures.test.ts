import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type Address, getBase64Encoder, type Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { DecodedInstruction } from "../report.js";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import { loadFixtureFile } from "../rpc/fixture-file.js";
import type { FixtureData } from "../rpc/index.js";
import { SquadsV4Adapter } from "../squads/adapter.js";
import { toEncodedAccount } from "../squads/decode.js";
import { decodeVaultTransaction } from "../squads/generated/accounts/vaultTransaction.js";
import { getVaultPda } from "../squads/pda.js";
import { createDecodeContext, decodeCompiledMessage } from "./decode.js";
import { fetchLookupTables } from "./lookup-tables.js";
import { decodeVaultTransactionMessage } from "./squads-proposal.js";
import { decodeRawTransaction, parseWireTransaction } from "./transaction.js";

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../../fixtures/${name}.json`, import.meta.url));
}

function transactionOf(data: FixtureData, signature: string): string {
  const tx = data.transactions.get(signature as Signature);
  if (tx === undefined) {
    throw new Error(`fixture has no transaction ${signature}`);
  }
  return tx.transactionBase64;
}

const base64Bytes = getBase64Encoder();

/**
 * Independent check of lookup-table resolution: for every account an instruction loads from a
 * table, the address we resolved (from the captured table account) must equal the address the
 * cluster itself recorded in `meta.loadedAddresses` (writable ones first, then readonly).
 */
async function expectLookupResolutionMatchesMeta(data: FixtureData, signature: string) {
  const tx = data.transactions.get(signature as Signature);
  if (tx === undefined) {
    throw new Error(`fixture has no transaction ${signature}`);
  }
  const { message } = parseWireTransaction(base64Bytes.encode(tx.transactionBase64));
  const { compiled } = message;
  const { entries } = await fetchLookupTables(
    new FixtureRpcClient(data),
    compiled.lookups.map((lookup) => lookup.tableAddress),
  );
  const decoded = decodeCompiledMessage(compiled, createDecodeContext(entries), 0, undefined);
  const loaded = [...tx.loadedAddresses.writable, ...tx.loadedAddresses.readonly];
  const staticCount = compiled.staticAccounts.length;
  let checked = 0;
  compiled.instructions.forEach((instruction, i) => {
    instruction.accountIndexes.forEach((accountIndex, position) => {
      if (accountIndex < staticCount) {
        return;
      }
      const account = decoded[i]?.accounts[position];
      expect(account?.address).toBe(loaded[accountIndex - staticCount]);
      expect(account?.fromLookupTable).toBeDefined();
      expect(account?.isWritable).toBe(
        accountIndex - staticCount < tx.loadedAddresses.writable.length,
      );
      checked++;
    });
  });
  expect(checked).toBeGreaterThan(0);
}

/** Strips fields that legitimately differ between two decodings of the same instruction. */
function shape(instruction: DecodedInstruction | undefined) {
  if (instruction === undefined) {
    return undefined;
  }
  const { inner: _inner, ...rest } = instruction;
  return rest;
}

describe("raw transaction mode against real mainnet Squads transactions", () => {
  it("decodes a v0 create+execute transaction, resolving lookup tables in both the outer and the embedded message", async () => {
    const data = await loadFixtureFile(fixturePath("squads-create-with-lookup-table"));
    const signature =
      "4VM1xbEnopeLaBGsw4MryHNTyek4nr58Rq4De1AssUVpCktwfXxqyhbgXAiioALSgFt799XbT3dKsp8WmC4fLqdn";
    const base64 = transactionOf(data, signature);
    const result = await decodeRawTransaction(new FixtureRpcClient(data), base64);

    expect(result.version).toBe(0);
    expect(result.sha256).toBe(
      createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex"),
    );
    expect(result.lookupTables.map((table) => table.address)).toEqual([
      "C4X9vTAXQ7HUzbK5iYMYBF6Ptgy4Uy54BXKXTZ7iAH8T",
    ]);
    // Only the third-party program at index 0 is undecodable, and it is reported.
    expect(result.gaps).toEqual([
      expect.objectContaining({
        address: "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95",
        code: "UNKNOWN_PROGRAM",
        instructionIndex: 0,
      }),
    ]);
    expect(result.instructions.map((ix) => ix.name ?? null)).toEqual([
      null,
      "vaultTransactionCreate",
      "proposalCreate",
      "proposalApprove",
      "proposalApprove",
      "vaultTransactionExecute",
      "vaultTransactionAccountsClose",
    ]);

    const create = result.instructions[1];
    expect(create?.args).toMatchObject({ transactionMessageLength: 264, vaultIndex: 0 });
    const [ata, transfer] = create?.inner ?? [];
    expect(ata?.name).toBe("createAssociatedTokenIdempotent");
    expect(ata?.accounts.find((a) => a.role === "tokenProgram")).toEqual({
      address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      fromLookupTable: "C4X9vTAXQ7HUzbK5iYMYBF6Ptgy4Uy54BXKXTZ7iAH8T",
      isSigner: false,
      isWritable: false,
      role: "tokenProgram",
    });
    expect(transfer?.name).toBe("transferChecked");
    expect(transfer?.args).toEqual({ amount: 41257552n, decimals: 9 });

    // The vault PDA is the authority, and is a signer inside the embedded message.
    const [vault] = await getVaultPda({
      index: 0,
      multisigPda: "FXZy1wWir1PbMyvuZF6WP6JRd6qnvj5pCmjGVXNyrjK" as Address,
    });
    expect(transfer?.accounts.find((a) => a.role === "authority")).toMatchObject({
      address: vault,
      isSigner: true,
    });
  });

  it("resolves the outer message's lookup-table accounts exactly as the cluster did", async () => {
    const data = await loadFixtureFile(fixturePath("squads-create-with-lookup-table"));
    await expectLookupResolutionMatchesMeta(
      data,
      "4VM1xbEnopeLaBGsw4MryHNTyek4nr58Rq4De1AssUVpCktwfXxqyhbgXAiioALSgFt799XbT3dKsp8WmC4fLqdn",
    );
  });

  it("decodes batchAddTransaction messages whose accounts come from a lookup table", async () => {
    const data = await loadFixtureFile(fixturePath("squads-batch-and-token-2022"));
    const rpc = new FixtureRpcClient(data);
    const result = await decodeRawTransaction(
      rpc,
      transactionOf(
        data,
        "2X5P5vkkoMSYBBxNZMcmtmQuuQ3DZCY7rRtKMNbyx68Hzme1wXT7UgUEa22uyP2PVsAG4AvRDPE28Gxgiw5AwQKt",
      ),
    );
    expect(result.gaps).toEqual([]);
    const add = result.instructions[3];
    expect(add?.name).toBe("batchAddTransaction");
    expect(add?.inner?.map((ix) => ix.name)).toEqual([
      "createAssociatedTokenIdempotent",
      "transferChecked",
      "createAssociatedTokenIdempotent",
      "transferChecked",
      "createAssociatedTokenIdempotent",
    ]);
    const usdcTransfers = (add?.inner ?? []).filter((ix) => ix.name === "transferChecked");
    for (const transfer of usdcTransfers) {
      expect(transfer.accounts.find((a) => a.role === "mint")).toMatchObject({
        address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        fromLookupTable: "DZboAojTvNwYbhW5rCARYLnWSKNumnd4khQG63aCxTfR",
      });
    }
  });

  it("reports a missing lookup table as a gap instead of guessing the accounts", async () => {
    const data = await loadFixtureFile(fixturePath("squads-batch-and-token-2022"));
    const withoutTable: FixtureData = { ...data, accounts: new Map() };
    const result = await decodeRawTransaction(
      new FixtureRpcClient(withoutTable),
      transactionOf(
        data,
        "tmx2sVyckub9gJ15iZdPhNdAJba7hK95MKykF3758uF3JBy3uVXXeK6ejXXJpAgisYqghmSt5mwDpKZfyqwHV1v",
      ),
    );
    expect(result.gaps.map((gap) => gap.code)).toContain("LOOKUP_TABLE_NOT_FOUND");
    expect(result.gaps.map((gap) => gap.code)).toContain("ACCOUNT_UNRESOLVED");
    expect(result.instructions[3]?.inner?.every((ix) => ix.decoder === "none")).toBe(true);
  });

  it("decodes a Token-2022 MintToChecked embedded in a vault transaction", async () => {
    const data = await loadFixtureFile(fixturePath("squads-batch-and-token-2022"));
    const result = await decodeRawTransaction(
      new FixtureRpcClient(data),
      transactionOf(
        data,
        "5wTfxKetUC8RiMpfPZbeMcbYsRzfGRc1f4aCaH2gbUKCHBTnxiNR3813gVpcKzPUM5rznxVp8VTaoBoEqjfRZDtE",
      ),
    );
    expect(result.version).toBe("legacy");
    expect(result.gaps).toEqual([]);
    const [mint] = result.instructions[0]?.inner ?? [];
    expect(mint).toMatchObject({
      args: { amount: 13608320371093n, decimals: 9 },
      decoder: "native",
      name: "mintToChecked",
      programLabel: "Token-2022",
    });
    expect(mint?.accounts.map((a) => a.role)).toEqual(["mint", "token", "mintAuthority"]);
  });
});

describe("a real Squads program-upgrade proposal", () => {
  const multisig = "DQnoxvJiAYUeB5Ahp5VbsaMGMmJUA5Jr5b1nnJ2ANeMG" as Address;
  const transactionAccount = "5mcdmy4tqDJSwG5a6yWXYW12YZv5s44AVM8f6XqfrkbZ" as Address;
  const creation =
    "43qBeNMhT4zbtbQd7BSDughU2GumtPJUSu7EYUt2u6DvDoxpb1rYVukef9eHLzAA3xUSgcHSDiHtt9DN46Fk2h9z";

  it("decodes the stored VaultTransaction message as a loader Upgrade signed by the vault", async () => {
    const data = await loadFixtureFile(fixturePath("squads-program-upgrade"));
    const rpc = new FixtureRpcClient(data);
    const bundle = await new SquadsV4Adapter(rpc).fetchProposalBundle(multisig, 4n);
    expect(bundle.transactionKind).toBe("vault");
    expect(bundle.transactionAddress).toBe(transactionAccount);

    const info = data.accounts.get(transactionAccount);
    if (info === undefined) {
      throw new Error("fixture is missing the VaultTransaction account");
    }
    const stored = decodeVaultTransaction(toEncodedAccount(transactionAccount, info)).data;
    const result = await decodeVaultTransactionMessage(rpc, stored.message);

    expect(result.gaps).toEqual([]);
    expect(result.instructions).toHaveLength(1);
    const [upgrade] = result.instructions;
    expect(upgrade?.name).toBe("upgrade");
    expect(upgrade?.programId).toBe("BPFLoaderUpgradeab1e11111111111111111111111");
    expect(upgrade?.accounts.map((a) => a.role)).toEqual([
      "programDataAccount",
      "programAccount",
      "bufferAccount",
      "spillAccount",
      "rentSysvar",
      "clockSysvar",
      "authority",
    ]);
    const [vault] = await getVaultPda({ index: stored.vaultIndex, multisigPda: multisig });
    expect(upgrade?.accounts[6]).toMatchObject({ address: vault, isSigner: true });
    expect(upgrade?.accounts[1]?.address).toBe("Sett1ereLzRw7neSzoUSwp6vvstBkEgAgQeP6wFcw5F");
  });

  it("decodes the raw creation transaction's embedded message identically to the stored account", async () => {
    const data = await loadFixtureFile(fixturePath("squads-program-upgrade"));
    const rpc = new FixtureRpcClient(data);
    const raw = await decodeRawTransaction(rpc, transactionOf(data, creation));
    expect(raw.gaps).toEqual([]);
    const create = raw.instructions[1];
    expect(create?.name).toBe("vaultTransactionCreate");
    expect(create?.accounts.find((a) => a.role === "transaction")?.address).toBe(
      transactionAccount,
    );

    const info = data.accounts.get(transactionAccount);
    if (info === undefined) {
      throw new Error("fixture is missing the VaultTransaction account");
    }
    const stored = decodeVaultTransaction(toEncodedAccount(transactionAccount, info)).data;
    const fromAccount = await decodeVaultTransactionMessage(rpc, stored.message);
    expect(create?.inner?.map(shape)).toEqual(fromAccount.instructions.map(shape));
  });

  it("decodes a direct top-level loader Upgrade", async () => {
    const data = await loadFixtureFile(fixturePath("squads-program-upgrade"));
    const result = await decodeRawTransaction(
      new FixtureRpcClient(data),
      transactionOf(
        data,
        "5xtxNM6YF1NcARP6muAtv4xLzqv5TPtaE5BLhpSbQLwkZnvwwfCvr4hXrUWNbys1Bm61HjBjeewiCB88TVBrHQqT",
      ),
    );
    expect(result.gaps).toEqual([]);
    expect(result.instructions.map((ix) => ix.name)).toEqual([
      "upgrade",
      "setComputeUnitPrice",
      "setComputeUnitLimit",
    ]);
    expect(result.instructions[0]?.summary).toEqual({
      key: "ix.loaderV3.upgrade",
      params: {
        authority: "F52NK7rsb3ChTfJsrzmDNU3rj2E3JYNDzgYiprq43Ztx",
        bufferAccount: "8edy2p1Km4pL5Ewqay3boGynvKy5HtBjwgUmAGS2msfA",
        clockSysvar: "SysvarC1ock11111111111111111111111111111111",
        programAccount: "7x1REKyhPMCmFKGWxMtQddyCwpKtBfLc5ez5NBQfYmJV",
        programDataAccount: "58bQfFb9ZYwyMpUWRyhxxWtqZKxLB4EvMJNZAuh7MfZ8",
        rentSysvar: "SysvarRent111111111111111111111111111111111",
        spillAccount: "F52NK7rsb3ChTfJsrzmDNU3rj2E3JYNDzgYiprq43Ztx",
      },
    });
  });
});

describe("the Phase 2 VaultTransaction fixture", () => {
  it("decodes its stored message and reports the unknown program instead of hiding it", async () => {
    const data = await loadFixtureFile(fixturePath("vault-transaction"));
    const address = "MwXvLTjbQFFy5fMt5q9cU9HC92huDiriAk6KQUS6VLG" as Address;
    const info = data.accounts.get(address);
    if (info === undefined) {
      throw new Error("fixture is missing the VaultTransaction account");
    }
    const stored = decodeVaultTransaction(toEncodedAccount(address, info)).data;
    const result = await decodeVaultTransactionMessage(new FixtureRpcClient(data), stored.message);
    expect(result.instructions).toHaveLength(stored.message.instructions.length);
    expect(result.instructions[0]?.decoder).toBe("none");
    expect(result.gaps).toEqual([
      expect.objectContaining({
        address: "J24jWEosQc5jgkdPm3YzNgzQ54CqNKkhzKy56XXJsLo2",
        code: "UNKNOWN_PROGRAM",
      }),
    ]);
  });
});
