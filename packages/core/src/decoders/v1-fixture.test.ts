import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import { loadFixtureFile } from "../rpc/fixture-file.js";
import { decodeRawTransaction } from "./transaction.js";

const FIXTURE = fileURLToPath(new URL("../../../../fixtures/v1-transaction.json", import.meta.url));
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
});
