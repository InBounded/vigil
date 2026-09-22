import {
  type Address,
  type Base64EncodedWireTransaction,
  createSolanaRpc,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import { chunk, mapWithConcurrency } from "./batch.js";
import { withRetry } from "./retry.js";
import type {
  AccountInfo,
  CommitmentLevel,
  ContextualResult,
  RpcClient,
  RpcReadOptions,
  SignatureInfo,
  SimulateResult,
  TransactionResult,
} from "./types.js";

const GET_MULTIPLE_ACCOUNTS_BATCH_SIZE = 100;

export interface KitRpcClientOptions {
  readonly timeoutMs?: number;
  readonly maxRetryAttempts?: number;
  readonly getMultipleAccountsConcurrency?: number;
}

/**
 * The only `RpcClient` implementation backed by a live network connection, via `@solana/kit`'s
 * `createSolanaRpc`. Every RPC call site in this file is one of the seven allowlisted methods —
 * see `allowlist.test.ts`, which scans this file's source to enforce that mechanically.
 */
export class KitRpcClient implements RpcClient {
  readonly #rpc: Rpc<SolanaRpcApi>;
  readonly #timeoutMs: number;
  readonly #maxRetryAttempts: number;
  readonly #concurrency: number;

  constructor(url: string, options: KitRpcClientOptions = {}) {
    this.#rpc = createSolanaRpc(url);
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxRetryAttempts = options.maxRetryAttempts ?? 3;
    this.#concurrency = options.getMultipleAccountsConcurrency ?? 4;
  }

  async getAccountInfo(
    address: Address,
    options?: RpcReadOptions,
  ): Promise<ContextualResult<AccountInfo | null>> {
    const response = await this.#send(() =>
      this.#rpc
        .getAccountInfo(address, {
          commitment: options?.commitment ?? "confirmed",
          encoding: "base64",
          ...optional("minContextSlot", options?.minContextSlot),
        })
        .send({ abortSignal: this.#timeoutSignal() }),
    );
    return {
      contextSlot: response.context.slot,
      value: response.value === null ? null : accountInfoFromKit(response.value),
    };
  }

  async getMultipleAccounts(
    addresses: readonly Address[],
    options?: RpcReadOptions,
  ): Promise<ContextualResult<ReadonlyArray<AccountInfo | null>>> {
    const batches = chunk(addresses, GET_MULTIPLE_ACCOUNTS_BATCH_SIZE);
    let maxContextSlot = 0n;
    const batchResults = await mapWithConcurrency(batches, this.#concurrency, async (batch) => {
      const response = await this.#send(() =>
        this.#rpc
          .getMultipleAccounts(batch, {
            commitment: options?.commitment ?? "confirmed",
            encoding: "base64",
            ...optional("minContextSlot", options?.minContextSlot),
          })
          .send({ abortSignal: this.#timeoutSignal() }),
      );
      if (response.context.slot > maxContextSlot) {
        maxContextSlot = response.context.slot;
      }
      return response.value.map((account) =>
        account === null ? null : accountInfoFromKit(account),
      );
    });
    return { contextSlot: maxContextSlot, value: batchResults.flat() };
  }

  async getGenesisHash(): Promise<string> {
    return this.#send(() =>
      this.#rpc.getGenesisHash().send({ abortSignal: this.#timeoutSignal() }),
    );
  }

  async getSlot(options?: RpcReadOptions): Promise<bigint> {
    return this.#send(() =>
      this.#rpc
        .getSlot({
          commitment: options?.commitment ?? "confirmed",
          ...optional("minContextSlot", options?.minContextSlot),
        })
        .send({ abortSignal: this.#timeoutSignal() }),
    );
  }

  async getSignaturesForAddress(
    address: Address,
    options?: RpcReadOptions & { readonly limit?: number; readonly before?: Signature },
  ): Promise<readonly SignatureInfo[]> {
    const response = await this.#send(() =>
      this.#rpc
        .getSignaturesForAddress(address, {
          ...optional("before", options?.before),
          ...optional("commitment", toSignaturesCommitment(options?.commitment)),
          ...optional("limit", options?.limit),
          ...optional("minContextSlot", options?.minContextSlot),
        })
        .send({ abortSignal: this.#timeoutSignal() }),
    );
    return response.map((entry) => ({
      blockTime: entry.blockTime === null ? null : BigInt(entry.blockTime),
      confirmationStatus: entry.confirmationStatus,
      err: entry.err,
      signature: entry.signature,
      slot: entry.slot,
    }));
  }

  async getTransaction(
    signature: Signature,
    options?: RpcReadOptions,
  ): Promise<TransactionResult | null> {
    const response = await this.#send(() =>
      this.#rpc
        .getTransaction(signature, {
          commitment: options?.commitment ?? "confirmed",
          encoding: "base64",
          maxSupportedTransactionVersion: 0,
          ...optional("minContextSlot", options?.minContextSlot),
        })
        .send({ abortSignal: this.#timeoutSignal() }),
    );
    if (response === null) {
      return null;
    }
    return {
      blockTime: response.blockTime === null ? null : BigInt(response.blockTime),
      err: response.meta?.err ?? null,
      loadedAddresses: response.meta?.loadedAddresses ?? { readonly: [], writable: [] },
      slot: response.slot,
      transactionBase64: response.transaction[0],
    };
  }

  async simulateTransaction(
    transactionBase64: string,
    options?: RpcReadOptions & { readonly replaceRecentBlockhash?: boolean },
  ): Promise<SimulateResult> {
    const response = await this.#send(() =>
      this.#rpc
        .simulateTransaction(transactionBase64 as Base64EncodedWireTransaction, {
          commitment: options?.commitment ?? "confirmed",
          encoding: "base64",
          sigVerify: false,
          ...optional("minContextSlot", options?.minContextSlot),
          ...optional("replaceRecentBlockhash", options?.replaceRecentBlockhash),
        })
        .send({ abortSignal: this.#timeoutSignal() }),
    );
    return {
      err: response.value.err,
      logs: response.value.logs,
      unitsConsumed: response.value.unitsConsumed ?? null,
    };
  }

  #send<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, { maxAttempts: this.#maxRetryAttempts });
  }

  #timeoutSignal(): AbortSignal {
    return AbortSignal.timeout(this.#timeoutMs);
  }
}

function accountInfoFromKit(account: {
  readonly owner: Address;
  readonly lamports: bigint;
  readonly data: readonly [string, string];
  readonly executable: boolean;
  readonly space: bigint;
}): AccountInfo {
  return {
    dataBase64: account.data[0],
    executable: account.executable,
    lamports: account.lamports,
    owner: account.owner,
    space: account.space,
  };
}

/** `getSignaturesForAddress` rejects `commitment: "processed"`; fall back to the server default. */
function toSignaturesCommitment(
  commitment: CommitmentLevel | undefined,
): Exclude<CommitmentLevel, "processed"> | undefined {
  return commitment === "processed" ? undefined : commitment;
}

/**
 * Under `exactOptionalPropertyTypes`, an optional config field (`foo?: T`) rejects an explicit
 * `foo: undefined` — it must be entirely absent instead. This spreads in the key only when the
 * value is actually defined, e.g. `{ a: 1, ...optional("b", maybeUndefined) }`.
 */
function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): { readonly [P in K]: V } | Record<never, never> {
  return value === undefined ? {} : ({ [key]: value } as { readonly [P in K]: V });
}
