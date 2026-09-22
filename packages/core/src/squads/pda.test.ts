import { address } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import { describe, expect, it } from "vitest";
import {
  getBatchTransactionPda,
  getEphemeralSignerPda,
  getMultisigPda,
  getProgramConfigPda,
  getProposalPda,
  getSpendingLimitPda,
  getTransactionPda,
  getVaultPda,
} from "./pda.js";

// A real, on-chain Squads v4 multisig (see fixtures/multisig-mixed-permissions.json) and some
// arbitrary valid addresses, reused across cases below.
const MULTISIG = address("3gjeSqMDqip2uLALaeFoGN3PmNx1tuY1y6S9qVxLyVJt");
const CREATE_KEY = address("By8ZMDk9pt3sY2vuKiwcYhzrTTH8bw648iH8nmbnh5wY");
const TRANSACTION_PDA = address("MwXvLTjbQFFy5fMt5q9cU9HC92huDiriAk6KQUS6VLG");

const U64_MAX = 2n ** 64n - 1n;
const U32_MAX = 2 ** 32 - 1;

describe("PDA helpers cross-checked against @sqds/multisig", () => {
  it("getProgramConfigPda matches", async () => {
    const [ours] = await getProgramConfigPda();
    const [theirs] = sqds.getProgramConfigPda({});
    expect(ours).toBe(theirs.toBase58());
  });

  it("getMultisigPda matches", async () => {
    const [ours] = await getMultisigPda({ createKey: CREATE_KEY });
    const [theirs] = sqds.getMultisigPda({ createKey: new PublicKey(CREATE_KEY) });
    expect(ours).toBe(theirs.toBase58());
  });

  it.each([0, 1, 128, 255])("getVaultPda matches for index %i", async (index) => {
    const [ours] = await getVaultPda({ index, multisigPda: MULTISIG });
    const [theirs] = sqds.getVaultPda({ index, multisigPda: new PublicKey(MULTISIG) });
    expect(ours).toBe(theirs.toBase58());
  });

  it("getVaultPda rejects an out-of-range index", async () => {
    await expect(getVaultPda({ index: 256, multisigPda: MULTISIG })).rejects.toThrow(RangeError);
  });

  it.each([0n, 1n, 352n, 1_000_000n, U64_MAX])(
    "getTransactionPda matches for a large u64 index (%s)",
    async (index) => {
      const [ours] = await getTransactionPda({ index, multisigPda: MULTISIG });
      const [theirs] = sqds.getTransactionPda({ index, multisigPda: new PublicKey(MULTISIG) });
      expect(ours).toBe(theirs.toBase58());
    },
  );

  it.each([0n, 1n, 352n, U64_MAX])(
    "getProposalPda matches for a large u64 index (%s)",
    async (transactionIndex) => {
      const [ours] = await getProposalPda({ multisigPda: MULTISIG, transactionIndex });
      const [theirs] = sqds.getProposalPda({
        multisigPda: new PublicKey(MULTISIG),
        transactionIndex,
      });
      expect(ours).toBe(theirs.toBase58());
    },
  );

  it.each([0, 1, 255])(
    "getEphemeralSignerPda matches for index %i",
    async (ephemeralSignerIndex) => {
      const [ours] = await getEphemeralSignerPda({
        ephemeralSignerIndex,
        transactionPda: TRANSACTION_PDA,
      });
      const [theirs] = sqds.getEphemeralSignerPda({
        ephemeralSignerIndex,
        transactionPda: new PublicKey(TRANSACTION_PDA),
      });
      expect(ours).toBe(theirs.toBase58());
    },
  );

  it("getBatchTransactionPda matches for large batchIndex and transactionIndex", async () => {
    const [ours] = await getBatchTransactionPda({
      batchIndex: U64_MAX,
      multisigPda: MULTISIG,
      transactionIndex: U32_MAX,
    });
    const [theirs] = sqds.getBatchTransactionPda({
      batchIndex: U64_MAX,
      multisigPda: new PublicKey(MULTISIG),
      transactionIndex: U32_MAX,
    });
    expect(ours).toBe(theirs.toBase58());
  });

  it("getBatchTransactionPda matches for small indices", async () => {
    const [ours] = await getBatchTransactionPda({
      batchIndex: 1n,
      multisigPda: MULTISIG,
      transactionIndex: 1,
    });
    const [theirs] = sqds.getBatchTransactionPda({
      batchIndex: 1n,
      multisigPda: new PublicKey(MULTISIG),
      transactionIndex: 1,
    });
    expect(ours).toBe(theirs.toBase58());
  });

  it("getSpendingLimitPda matches", async () => {
    const [ours] = await getSpendingLimitPda({ createKey: CREATE_KEY, multisigPda: MULTISIG });
    const [theirs] = sqds.getSpendingLimitPda({
      createKey: new PublicKey(CREATE_KEY),
      multisigPda: new PublicKey(MULTISIG),
    });
    expect(ours).toBe(theirs.toBase58());
  });
});
