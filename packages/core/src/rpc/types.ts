import type { Address, Signature } from "@solana/kit";
import type { AnalysisGap } from "../report.js";

/** Solana cluster, as detected from a genesis hash. See {@link detectCluster}. */
export type Cluster = "mainnet" | "devnet" | "testnet" | "unknown";

export type CommitmentLevel = "processed" | "confirmed" | "finalized";

export interface RpcReadOptions {
  readonly commitment?: CommitmentLevel;
  readonly minContextSlot?: bigint;
}

export interface AccountInfo {
  readonly owner: Address;
  readonly lamports: bigint;
  readonly dataBase64: string;
  readonly executable: boolean;
  /** Size of the account data in bytes, as reported by the RPC (excludes the 128-byte header). */
  readonly space: bigint;
}

export interface ContextualResult<T> {
  readonly contextSlot: bigint;
  readonly value: T;
}

export interface SignatureInfo {
  readonly signature: Signature;
  readonly slot: bigint;
  readonly err: unknown | null;
  readonly blockTime: bigint | null;
  readonly confirmationStatus: CommitmentLevel | null;
}

export interface LoadedAddresses {
  readonly writable: readonly Address[];
  readonly readonly: readonly Address[];
}

export interface TransactionResult {
  readonly slot: bigint;
  readonly blockTime: bigint | null;
  /** Base64-encoded wire transaction bytes (message + signatures), undecoded. */
  readonly transactionBase64: string;
  readonly err: unknown | null;
  readonly loadedAddresses: LoadedAddresses;
}

/** A token balance as the RPC reports it in `pre/postTokenBalances` (amount in base units). */
export interface RpcTokenBalance {
  /** Index into the transaction's account keys (static keys, then loaded writable, then readonly). */
  readonly accountIndex: number;
  readonly mint: Address;
  readonly owner: Address | null;
  readonly amount: bigint;
  readonly decimals: number;
}

export interface SimulateOptions extends RpcReadOptions {
  readonly replaceRecentBlockhash?: boolean;
  /** Accounts whose post-simulation state to return (base64). */
  readonly accounts?: readonly Address[];
  readonly innerInstructions?: boolean;
}

export interface SimulateResult {
  /** Slot of the bank the transaction was simulated against. */
  readonly contextSlot: bigint;
  readonly err: unknown | null;
  readonly logs: readonly string[] | null;
  readonly unitsConsumed: bigint | null;
  readonly fee: bigint | null;
  /** Post-simulation state of `options.accounts`, in the same order; `null` if not requested. */
  readonly accounts: ReadonlyArray<AccountInfo | null> | null;
  /** Lamports per account key, as the RPC reports them (newer Agave only; else `null`). */
  readonly preBalances: readonly bigint[] | null;
  readonly postBalances: readonly bigint[] | null;
  readonly preTokenBalances: readonly RpcTokenBalance[] | null;
  readonly postTokenBalances: readonly RpcTokenBalance[] | null;
  /** Addresses loaded from lookup tables, when reported. */
  readonly loadedAddresses: LoadedAddresses | null;
  /**
   * Program ids of the inner (CPI) instructions, per top-level instruction index; `null` when
   * inner instructions were not requested or not returned.
   */
  readonly innerInstructionPrograms: ReadonlyArray<{
    readonly index: number;
    readonly programs: readonly Address[];
  }> | null;
}

/**
 * Only these seven methods may ever be called against a Solana RPC endpoint anywhere in this
 * project — see `docs/reference.md` §4. `rpc/allowlist.test.ts` enforces this by scanning
 * `kit-client.ts`'s source for RPC method call sites.
 */
export interface RpcClient {
  getAccountInfo(
    address: Address,
    options?: RpcReadOptions,
  ): Promise<ContextualResult<AccountInfo | null>>;

  getMultipleAccounts(
    addresses: readonly Address[],
    options?: RpcReadOptions,
  ): Promise<ContextualResult<ReadonlyArray<AccountInfo | null>>>;

  /** @returns the base58-encoded genesis hash. */
  getGenesisHash(): Promise<string>;

  getSlot(options?: RpcReadOptions): Promise<bigint>;

  getSignaturesForAddress(
    address: Address,
    options?: RpcReadOptions & { readonly limit?: number; readonly before?: Signature },
  ): Promise<readonly SignatureInfo[]>;

  getTransaction(signature: Signature, options?: RpcReadOptions): Promise<TransactionResult | null>;

  /**
   * Not an RPC method: limitations of this endpoint discovered while talking to it (e.g. it cannot
   * serve v1 transactions). Callers must copy these into the report's gaps.
   */
  limitations(): readonly AnalysisGap[];

  /** `sigVerify` is fixed to `false`; this project never verifies signatures via simulation. */
  simulateTransaction(
    transactionBase64: string,
    options?: SimulateOptions,
  ): Promise<SimulateResult>;
}
