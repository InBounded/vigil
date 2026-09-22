import { readFile } from "node:fs/promises";
import type { Address, Signature } from "@solana/kit";
import type { FixtureData } from "./fixture-client.js";
import type { AccountInfo, TransactionResult } from "./types.js";

/**
 * On-disk shape written by `scripts/capture-fixture.ts` and read by `loadFixtureFile`. `bigint`
 * values (lamports, space, slots) are serialized as decimal strings, since JSON has no bigint.
 */
export interface FixtureFile {
  readonly description?: string;
  readonly capturedAt?: string;
  readonly cluster?: string;
  readonly contextSlot: string;
  readonly genesisHash?: string;
  readonly accounts?: Readonly<Record<string, FixtureAccountRecord>>;
  readonly transactions?: Readonly<Record<string, FixtureTransactionRecord>>;
}

export interface FixtureAccountRecord {
  readonly owner: string;
  readonly lamports: string;
  readonly dataBase64: string;
  readonly executable: boolean;
  readonly space: string;
}

export interface FixtureTransactionRecord {
  readonly slot: string;
  readonly blockTime: string | null;
  readonly transactionBase64: string;
  readonly err: unknown | null;
  readonly loadedAddresses: {
    readonly writable: readonly string[];
    readonly readonly: readonly string[];
  };
}

/** Reads and parses one fixture JSON file into `FixtureData`, ready for `FixtureRpcClient`. */
export async function loadFixtureFile(path: string): Promise<FixtureData> {
  const raw = await readFile(path, "utf8");
  const file = JSON.parse(raw) as FixtureFile;
  return fixtureDataFromFile(file);
}

/** Reads and merges several fixture files into one `FixtureData` (later files win on conflicts). */
export async function loadFixtureFiles(paths: readonly string[]): Promise<FixtureData> {
  const parts = await Promise.all(paths.map((path) => loadFixtureFile(path)));
  const accounts = new Map<Address, AccountInfo>();
  const transactions = new Map<Signature, TransactionResult>();
  let contextSlot = 0n;
  let genesisHash: string | undefined;
  for (const part of parts) {
    for (const [address, info] of part.accounts) {
      accounts.set(address, info);
    }
    for (const [signature, tx] of part.transactions) {
      transactions.set(signature, tx);
    }
    if (part.contextSlot > contextSlot) {
      contextSlot = part.contextSlot;
    }
    genesisHash ??= part.genesisHash;
  }
  return {
    accounts,
    contextSlot,
    transactions,
    ...(genesisHash === undefined ? {} : { genesisHash }),
  };
}

function fixtureDataFromFile(file: FixtureFile): FixtureData {
  const accounts = new Map<Address, AccountInfo>();
  for (const [address, record] of Object.entries(file.accounts ?? {})) {
    accounts.set(address as Address, {
      dataBase64: record.dataBase64,
      executable: record.executable,
      lamports: BigInt(record.lamports),
      owner: record.owner as Address,
      space: BigInt(record.space),
    });
  }
  const transactions = new Map<Signature, TransactionResult>();
  for (const [signature, record] of Object.entries(file.transactions ?? {})) {
    transactions.set(signature as Signature, {
      blockTime: record.blockTime === null ? null : BigInt(record.blockTime),
      err: record.err,
      loadedAddresses: {
        readonly: record.loadedAddresses.readonly as Address[],
        writable: record.loadedAddresses.writable as Address[],
      },
      slot: BigInt(record.slot),
      transactionBase64: record.transactionBase64,
    });
  }
  return {
    accounts,
    contextSlot: BigInt(file.contextSlot),
    transactions,
    ...(file.genesisHash === undefined ? {} : { genesisHash: file.genesisHash }),
  };
}
