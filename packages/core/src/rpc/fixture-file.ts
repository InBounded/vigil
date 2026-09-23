import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import type { Address, Signature } from "@solana/kit";
import type { FixtureData, RecordedSimulation } from "./fixture-client.js";
import type {
  AccountInfo,
  CommitmentLevel,
  RpcTokenBalance,
  SignatureInfo,
  SimulateResult,
  TransactionResult,
} from "./types.js";

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
  /** Keyed by the exact base64 wire transaction simulated. */
  readonly simulations?: Readonly<Record<string, FixtureSimulationRecord>>;
  /** `getSignaturesForAddress` answers, newest first, keyed by address. */
  readonly signatures?: Readonly<Record<string, readonly FixtureSignatureRecord[]>>;
}

export interface FixtureSignatureRecord {
  readonly signature: string;
  readonly slot: string;
  readonly err: unknown | null;
  readonly blockTime: string | null;
  readonly confirmationStatus: CommitmentLevel | null;
}

export interface FixtureTokenBalanceRecord {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner: string | null;
  readonly amount: string;
  readonly decimals: number;
}

export interface FixtureSimulationResultRecord {
  readonly contextSlot: string;
  readonly err: unknown | null;
  readonly logs: readonly string[] | null;
  readonly unitsConsumed: string | null;
  readonly fee: string | null;
  readonly accounts: ReadonlyArray<FixtureAccountRecord | null> | null;
  readonly preBalances: readonly string[] | null;
  readonly postBalances: readonly string[] | null;
  readonly preTokenBalances: readonly FixtureTokenBalanceRecord[] | null;
  readonly postTokenBalances: readonly FixtureTokenBalanceRecord[] | null;
  readonly loadedAddresses: {
    readonly writable: readonly string[];
    readonly readonly: readonly string[];
  } | null;
  readonly innerInstructionPrograms: ReadonlyArray<{
    readonly index: number;
    readonly programs: readonly string[];
  }> | null;
}

export interface FixtureSimulationRecord {
  readonly request: {
    readonly accounts: readonly string[];
    readonly innerInstructions: boolean;
    readonly replaceRecentBlockhash: boolean;
  };
  readonly result?: FixtureSimulationResultRecord;
  readonly rpcError?: { readonly code: number; readonly message: string };
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

/**
 * Reads and parses one fixture JSON file into `FixtureData`, ready for `FixtureRpcClient`. A path
 * ending in `.gz` is gunzipped first (fixtures holding whole program binaries are stored that way).
 */
export async function loadFixtureFile(path: string): Promise<FixtureData> {
  const bytes = await readFile(path);
  const raw = (path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");
  const file = JSON.parse(raw) as FixtureFile;
  return fixtureDataFromFile(file);
}

/** Reads and merges several fixture files into one `FixtureData` (later files win on conflicts). */
export async function loadFixtureFiles(paths: readonly string[]): Promise<FixtureData> {
  const parts = await Promise.all(paths.map((path) => loadFixtureFile(path)));
  const accounts = new Map<Address, AccountInfo>();
  const transactions = new Map<Signature, TransactionResult>();
  const simulations = new Map<string, RecordedSimulation>();
  const signatures = new Map<Address, readonly SignatureInfo[]>();
  let contextSlot = 0n;
  let genesisHash: string | undefined;
  for (const part of parts) {
    for (const [transaction, simulation] of part.simulations ?? []) {
      simulations.set(transaction, simulation);
    }
    for (const [address, list] of part.signatures ?? []) {
      signatures.set(address, list);
    }
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
    signatures,
    simulations,
    transactions,
    ...(genesisHash === undefined ? {} : { genesisHash }),
  };
}

function accountFromRecord(record: FixtureAccountRecord): AccountInfo {
  return {
    dataBase64: record.dataBase64,
    executable: record.executable,
    lamports: BigInt(record.lamports),
    owner: record.owner as Address,
    space: BigInt(record.space),
  };
}

function tokenBalancesFromRecord(
  records: readonly FixtureTokenBalanceRecord[] | null,
): readonly RpcTokenBalance[] | null {
  return records === null
    ? null
    : records.map((record) => ({
        accountIndex: record.accountIndex,
        amount: BigInt(record.amount),
        decimals: record.decimals,
        mint: record.mint as Address,
        owner: record.owner as Address | null,
      }));
}

function simulationResultFromRecord(record: FixtureSimulationResultRecord): SimulateResult {
  const bigints = (list: readonly string[] | null) => (list === null ? null : list.map(BigInt));
  return {
    accounts:
      record.accounts === null
        ? null
        : record.accounts.map((account) => (account === null ? null : accountFromRecord(account))),
    contextSlot: BigInt(record.contextSlot),
    err: record.err,
    fee: record.fee === null ? null : BigInt(record.fee),
    innerInstructionPrograms:
      record.innerInstructionPrograms === null
        ? null
        : record.innerInstructionPrograms.map((group) => ({
            index: group.index,
            programs: group.programs as Address[],
          })),
    loadedAddresses:
      record.loadedAddresses === null
        ? null
        : {
            readonly: record.loadedAddresses.readonly as Address[],
            writable: record.loadedAddresses.writable as Address[],
          },
    logs: record.logs,
    postBalances: bigints(record.postBalances),
    postTokenBalances: tokenBalancesFromRecord(record.postTokenBalances),
    preBalances: bigints(record.preBalances),
    preTokenBalances: tokenBalancesFromRecord(record.preTokenBalances),
    unitsConsumed: record.unitsConsumed === null ? null : BigInt(record.unitsConsumed),
  };
}

function simulationFromRecord(record: FixtureSimulationRecord): RecordedSimulation {
  const request = {
    accounts: record.request.accounts as Address[],
    innerInstructions: record.request.innerInstructions,
    replaceRecentBlockhash: record.request.replaceRecentBlockhash,
  };
  if (record.result !== undefined) {
    return { request, result: simulationResultFromRecord(record.result) };
  }
  if (record.rpcError !== undefined) {
    return { request, rpcError: record.rpcError };
  }
  throw new Error("fixture simulation record has neither `result` nor `rpcError`");
}

function fixtureDataFromFile(file: FixtureFile): FixtureData {
  const accounts = new Map<Address, AccountInfo>();
  for (const [address, record] of Object.entries(file.accounts ?? {})) {
    accounts.set(address as Address, accountFromRecord(record));
  }
  const simulations = new Map<string, RecordedSimulation>();
  for (const [transaction, record] of Object.entries(file.simulations ?? {})) {
    simulations.set(transaction, simulationFromRecord(record));
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
  const signatures = new Map<Address, readonly SignatureInfo[]>();
  for (const [address, records] of Object.entries(file.signatures ?? {})) {
    signatures.set(
      address as Address,
      records.map((record) => ({
        blockTime: record.blockTime === null ? null : BigInt(record.blockTime),
        confirmationStatus: record.confirmationStatus,
        err: record.err,
        signature: record.signature as Signature,
        slot: BigInt(record.slot),
      })),
    );
  }
  return {
    accounts,
    contextSlot: BigInt(file.contextSlot),
    signatures,
    simulations,
    transactions,
    ...(file.genesisHash === undefined ? {} : { genesisHash: file.genesisHash }),
  };
}
