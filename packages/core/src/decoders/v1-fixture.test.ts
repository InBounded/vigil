import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import { loadFixtureFile } from "../rpc/fixture-file.js";
import { decodeRawTransaction } from "./transaction.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../../fixtures/${name}.json`, import.meta.url));
const FIXTURE = fixture("v1-transaction");
const SIGNATURE = signature(
  "3RpFf2ab6Jw1a5TUqZG4qfC7WaJtWtdqVyJzx5VVouyCev1MND5DGemApNd64HgUk4juCZ8iEaAAybf6DG3H8oa1",
);

describe("a real mainnet v1 transaction (SIMD-0385)", () => {
  it("decodes the message, its inline compute budget, and reports what it can't decode", async () => {
    const data = await loadFixtureFile(FIXTURE);
    const tx = data.transactions.get(SIGNATURE);
    if (tx === undefined) {
      throw new Error("fixture is missing the transaction");
    }
    const bytes = Buffer.from(tx.transactionBase64, "base64");
    expect(bytes[0]).toBe(0x81); // versioned prefix | 1

    const result = await decodeRawTransaction(new FixtureRpcClient(data), tx.transactionBase64);

    expect(result.version).toBe(1);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.signatureCount).toBe(1);
    expect(result.feePayer).toBe("diffNmcR6YCQruUnvxgh6pYTk4iLMemAKRUgoP8Pamn");
    expect(result.transactionConfig).toEqual({
      computeUnitLimit: 420000,
      loadedAccountsDataSizeLimit: 67108864,
      priorityFeeLamports: 1500n,
    });
    expect(result.lookupTables).toEqual([]);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0]?.accounts[0]).toMatchObject({
      address: "diffNmcR6YCQruUnvxgh6pYTk4iLMemAKRUgoP8Pamn",
      isSigner: true,
      isWritable: true,
    });
    expect(result.gaps).toEqual([
      expect.objectContaining({
        address: "FZfcDn7xme9422Y1dqXBjcJEYS4Cr65deXGZaX5JXqzH",
        code: "UNKNOWN_PROGRAM",
        instructionIndex: 0,
      }),
    ]);
  });

  it("decodes a v1 transaction that failed on-chain, keeping its recorded error", async () => {
    const data = await loadFixtureFile(fixture("v1-failed-transaction"));
    const failed = signature(
      "2TYLLmgrBe82yNhbQo2sZRWE3Zp7bAykig4BqW3Ux3LfcosSpFKYHf9Z75m5RcHhCPdGbmkJ7i9ws5M3TfH1Ea9C",
    );
    const tx = data.transactions.get(failed);
    if (tx === undefined) {
      throw new Error("fixture is missing the transaction");
    }
    // Written by capture-fixture.ts with bigints as decimal strings.
    expect(tx.err).toEqual({ InstructionError: ["0", { Custom: "7" }] });
    expect(Buffer.from(tx.transactionBase64, "base64")).toHaveLength(2310);

    const result = await decodeRawTransaction(new FixtureRpcClient(data), tx.transactionBase64);
    expect(result.version).toBe(1);
    expect(result.transactionConfig).toEqual({
      computeUnitLimit: 76636,
      loadedAccountsDataSizeLimit: 13631488,
      priorityFeeLamports: 700n,
    });
    expect(result.instructions.map((ix) => ix.name ?? null)).toEqual([
      null,
      null,
      null,
      "transferSol",
      "transferSol",
    ]);
    for (const transfer of result.instructions.slice(3)) {
      expect(transfer.args).toEqual({ amount: 2010101n });
      expect(transfer.accounts[0]).toMatchObject({
        address: "2UcS1C7PoEodaZ4hBu3QjSBvTmii73AAPSuMFER4tfEb",
        isSigner: true,
        isWritable: true,
        role: "source",
      });
    }
    expect(result.instructions[3]?.accounts[1]?.address).toBe(
      "Sp1xMS2cbw83SZDNr4AGqkBYYLjb3LvVnmDSrTMaHkr",
    );
    expect(result.gaps.map((gap) => [gap.code, gap.instructionIndex, gap.address])).toEqual([
      ["UNKNOWN_PROGRAM", 0, "7JwTi9ambvCTYwZbNQEZA8hzpG3ymPWRZpAxgKPJ94ZG"],
      ["UNKNOWN_PROGRAM", 1, "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"],
      ["UNKNOWN_PROGRAM", 2, "7JwTi9ambvCTYwZbNQEZA8hzpG3ymPWRZpAxgKPJ94ZG"],
    ]);
  });
});
