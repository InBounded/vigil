/**
 * An `RpcClient` that forwards every call to a live client and records the answers, so a gatherer
 * run can be written out as a fixture and replayed offline by `FixtureRpcClient` (see
 * `scripts/capture-gatherers.ts`). It adds no RPC methods: it only wraps the allowlisted ones.
 */
import type { Address, Signature } from "@solana/kit";
import { isSolanaError } from "@solana/kit";
import type { AnalysisGap } from "../../packages/core/src/report.js";
import type {
  AccountInfo,
  ContextualResult,
  RpcClient,
  RpcReadOptions,
  SignatureInfo,
  SimulateOptions,
  SimulateResult,
  TransactionResult,
} from "../../packages/core/src/rpc/types.js";

export interface RecordedCall {
  readonly request: {
    readonly accounts: readonly Address[];
    readonly innerInstructions: boolean;
    readonly replaceRecentBlockhash: boolean;
  };
  readonly result?: SimulateResult;
  readonly rpcError?: { readonly code: number; readonly message: string };
}

export class RecordingRpcClient implements RpcClient {
  readonly #inner: RpcClient;
  readonly accounts = new Map<Address, AccountInfo>();
  readonly transactions = new Map<Signature, TransactionResult>();
  readonly simulations = new Map<string, RecordedCall>();
  contextSlot = 0n;

  constructor(inner: RpcClient) {
    this.#inner = inner;
  }

  #slot(slot: bigint): void {
    if (slot > this.contextSlot) {
      this.contextSlot = slot;
    }
  }

  async getAccountInfo(address: Address, options?: RpcReadOptions) {
    const result = await this.#inner.getAccountInfo(address, options);
    this.#slot(result.contextSlot);
    this.#record(address, result.value);
    return result;
  }

  async getMultipleAccounts(
    addresses: readonly Address[],
    options?: RpcReadOptions,
  ): Promise<ContextualResult<ReadonlyArray<AccountInfo | null>>> {
    const result = await this.#inner.getMultipleAccounts(addresses, options);
    this.#slot(result.contextSlot);
    addresses.forEach((address, i) => {
      this.#record(address, result.value[i] ?? null);
    });
    return result;
  }

  /**
   * An address read twice keeps its first recorded state, so a replay sees what the gatherer saw
   * first. A later read that differs is reported, because the replay cannot reproduce it.
   */
  #record(address: Address, value: AccountInfo | null): void {
    if (value === null) {
      return;
    }
    const previous = this.accounts.get(address);
    if (previous === undefined) {
      this.accounts.set(address, value);
    } else if (previous.dataBase64 !== value.dataBase64 || previous.lamports !== value.lamports) {
      console.warn(`  ! ${address} changed between two reads during capture; keeping the first`);
    }
  }

  getGenesisHash(): Promise<string> {
    return this.#inner.getGenesisHash();
  }

  getSlot(options?: RpcReadOptions): Promise<bigint> {
    return this.#inner.getSlot(options);
  }

  getSignaturesForAddress(
    address: Address,
    options?: RpcReadOptions & { readonly limit?: number; readonly before?: Signature },
  ): Promise<readonly SignatureInfo[]> {
    return this.#inner.getSignaturesForAddress(address, options);
  }

  async getTransaction(signature: Signature, options?: RpcReadOptions) {
    const result = await this.#inner.getTransaction(signature, options);
    if (result !== null) {
      this.transactions.set(signature, result);
    }
    return result;
  }

  limitations(): readonly AnalysisGap[] {
    return this.#inner.limitations();
  }

  async simulateTransaction(
    transactionBase64: string,
    options?: SimulateOptions,
  ): Promise<SimulateResult> {
    const request = {
      accounts: options?.accounts ?? [],
      innerInstructions: options?.innerInstructions === true,
      replaceRecentBlockhash: options?.replaceRecentBlockhash === true,
    };
    try {
      const result = await this.#inner.simulateTransaction(transactionBase64, options);
      this.#slot(result.contextSlot);
      this.simulations.set(transactionBase64, { request, result });
      return result;
    } catch (error) {
      if (isSolanaError(error)) {
        const context = error.context as { __code?: unknown; __serverMessage?: unknown };
        if (typeof context.__code === "number" && typeof context.__serverMessage === "string") {
          this.simulations.set(transactionBase64, {
            request,
            rpcError: { code: context.__code, message: context.__serverMessage },
          });
        }
      }
      throw error;
    }
  }
}

function accountRecord(account: AccountInfo) {
  return {
    dataBase64: account.dataBase64,
    executable: account.executable,
    lamports: account.lamports.toString(),
    owner: account.owner,
    space: account.space.toString(),
  };
}

/** The recorded exchange in `fixtures/*.json` form (see `packages/core/src/rpc/fixture-file.ts`). */
export function recordingToFixture(recording: RecordingRpcClient): Record<string, unknown> {
  const accounts: Record<string, unknown> = {};
  for (const [address, account] of [...recording.accounts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    accounts[address] = accountRecord(account);
  }
  const transactions: Record<string, unknown> = {};
  for (const [signature, tx] of recording.transactions) {
    transactions[signature] = {
      blockTime: tx.blockTime === null ? null : tx.blockTime.toString(),
      err: tx.err,
      loadedAddresses: tx.loadedAddresses,
      slot: tx.slot.toString(),
      transactionBase64: tx.transactionBase64,
    };
  }
  const simulations: Record<string, unknown> = {};
  for (const [transaction, call] of recording.simulations) {
    const result = call.result;
    simulations[transaction] = {
      request: call.request,
      ...(call.rpcError === undefined ? {} : { rpcError: call.rpcError }),
      ...(result === undefined
        ? {}
        : {
            result: {
              accounts:
                result.accounts === null
                  ? null
                  : result.accounts.map((account) =>
                      account === null ? null : accountRecord(account),
                    ),
              contextSlot: result.contextSlot.toString(),
              err: result.err,
              fee: result.fee === null ? null : result.fee.toString(),
              innerInstructionPrograms: result.innerInstructionPrograms,
              loadedAddresses: result.loadedAddresses,
              logs: result.logs,
              postBalances: result.postBalances?.map(String) ?? null,
              postTokenBalances: tokenBalances(result.postTokenBalances),
              preBalances: result.preBalances?.map(String) ?? null,
              preTokenBalances: tokenBalances(result.preTokenBalances),
              unitsConsumed: result.unitsConsumed === null ? null : result.unitsConsumed.toString(),
            },
          }),
    };
  }
  return {
    ...(Object.keys(accounts).length > 0 ? { accounts } : {}),
    ...(Object.keys(transactions).length > 0 ? { transactions } : {}),
    ...(Object.keys(simulations).length > 0 ? { simulations } : {}),
  };
}

function tokenBalances(list: SimulateResult["preTokenBalances"]) {
  return list === null
    ? null
    : list.map((entry) => ({
        accountIndex: entry.accountIndex,
        amount: entry.amount.toString(),
        decimals: entry.decimals,
        mint: entry.mint,
        owner: entry.owner,
      }));
}
