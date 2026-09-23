import { type Address, getAddressEncoder, getBase64Encoder } from "@solana/kit";
import type { AnalysisGap } from "../report.js";
import type { AccountInfo, RpcClient } from "../rpc/types.js";

/** Accounts whose content decides what a proposal does, and so must not depend on one RPC's word. */
export type CriticalAccountKind =
  | "multisig"
  | "transaction"
  | "proposal"
  | "batch-transaction"
  | "lookup-table"
  | "programdata"
  | "buffer";

export interface CriticalAccount {
  readonly address: Address;
  readonly kind: CriticalAccountKind;
}

/** Two RPCs returned different content for the same account. `null` = the RPC says it does not exist. */
export interface RpcMismatch {
  readonly address: Address;
  readonly kind: CriticalAccountKind;
  readonly primarySha256: string | null;
  readonly secondarySha256: string | null;
}

export interface CrossCheckResult {
  readonly mismatches: readonly RpcMismatch[];
  readonly gaps: readonly AnalysisGap[];
}

const base64Bytes = getBase64Encoder();
const addressEncoder = getAddressEncoder();

/**
 * SHA-256 (hex) of what an account *is*: owner, executable flag and data. Lamports are left out on
 * purpose — they change with every rent top-up or tip and say nothing about what the account holds.
 */
export async function accountContentHash(account: AccountInfo | null): Promise<string | null> {
  if (account === null) {
    return null;
  }
  const owner = addressEncoder.encode(account.owner);
  const data = base64Bytes.encode(account.dataBase64);
  const bytes = new Uint8Array(owner.length + 1 + data.length);
  bytes.set(owner, 0);
  bytes[owner.length] = account.executable ? 1 : 0;
  bytes.set(data, owner.length + 1);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readHashes(
  rpc: RpcClient,
  addresses: readonly Address[],
  minContextSlot?: bigint,
): Promise<{ readonly slot: bigint; readonly hashes: readonly (string | null)[] }> {
  const { contextSlot, value } = await rpc.getMultipleAccounts(
    addresses,
    minContextSlot === undefined ? {} : { minContextSlot },
  );
  return {
    hashes: await Promise.all(addresses.map((_address, i) => accountContentHash(value[i] ?? null))),
    slot: contextSlot,
  };
}

/**
 * Reads the critical accounts from the primary and the user's second RPC and compares their
 * content hashes. If they differ while the two reads were at different slots, both are read once
 * more at the later slot, so a vote landing between the reads is not reported as a disagreement.
 * What still differs is a mismatch (rule VGL-C012, and an `RPC_MISMATCH` gap that makes the
 * analysis incomplete). If either RPC cannot be read, the check did not happen: an
 * `RPC_CROSS_CHECK_FAILED` gap, never an exception.
 */
export async function crossCheckAccounts(
  primary: RpcClient,
  secondary: RpcClient,
  accounts: readonly CriticalAccount[],
): Promise<CrossCheckResult> {
  const unique = new Map<Address, CriticalAccountKind>();
  for (const account of accounts) {
    if (!unique.has(account.address)) {
      unique.set(account.address, account.kind);
    }
  }
  const addresses = [...unique.keys()].sort();
  if (addresses.length === 0) {
    return { gaps: [], mismatches: [] };
  }
  const failed = (which: string): CrossCheckResult => ({
    gaps: [
      {
        code: "RPC_CROSS_CHECK_FAILED",
        message: `the ${which} RPC could not be read, so the accounts were not compared between the two RPCs`,
      },
    ],
    mismatches: [],
  });

  let a: Awaited<ReturnType<typeof readHashes>>;
  let b: Awaited<ReturnType<typeof readHashes>>;
  try {
    a = await readHashes(primary, addresses);
  } catch {
    return failed("primary");
  }
  try {
    b = await readHashes(secondary, addresses);
  } catch {
    return failed("second");
  }
  const differs = () => addresses.some((_address, i) => a.hashes[i] !== b.hashes[i]);
  if (differs() && a.slot !== b.slot) {
    const slot = a.slot > b.slot ? a.slot : b.slot;
    try {
      a = await readHashes(primary, addresses, slot);
    } catch {
      return failed("primary");
    }
    try {
      b = await readHashes(secondary, addresses, slot);
    } catch {
      return failed("second");
    }
  }
  const mismatches: RpcMismatch[] = [];
  addresses.forEach((address, i) => {
    const primarySha256 = a.hashes[i] ?? null;
    const secondarySha256 = b.hashes[i] ?? null;
    if (primarySha256 !== secondarySha256) {
      mismatches.push({
        address,
        kind: unique.get(address) ?? "transaction",
        primarySha256,
        secondarySha256,
      });
    }
  });
  return {
    gaps: mismatches.map((mismatch) => ({
      address: mismatch.address,
      code: "RPC_MISMATCH" as const,
      message: `the two RPCs return different content for this ${mismatch.kind} account`,
    })),
    mismatches,
  };
}
