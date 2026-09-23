import { type Address, type Signature, SolanaError } from "@solana/kit";
import type { AnalysisGap } from "../report.js";
import type {
  AccountInfo,
  ContextualResult,
  RpcClient,
  RpcReadOptions,
  SignatureInfo,
  SimulateOptions,
  SimulateResult,
  TransactionResult,
} from "./types.js";

export class FixtureNotSupportedError extends Error {
  constructor(method: string) {
    super(`FixtureRpcClient does not support ${method}() — no fixture data is captured for it`);
    this.name = "FixtureNotSupportedError";
  }
}

/** The request a recorded simulation was made with; a replay must ask exactly the same. */
export interface RecordedSimulationRequest {
  readonly accounts: readonly Address[];
  readonly innerInstructions: boolean;
  readonly replaceRecentBlockhash: boolean;
}

/** A real `simulateTransaction` exchange: the endpoint's answer, or the JSON-RPC error it returned. */
export type RecordedSimulation = {
  readonly request: RecordedSimulationRequest;
} & (
  | { readonly result: SimulateResult }
  | { readonly rpcError: { readonly code: number; readonly message: string } }
);

export interface FixtureData {
  /** The slot recorded at capture time; used as the context slot for any lookup. */
  readonly contextSlot: bigint;
  readonly accounts: ReadonlyMap<Address, AccountInfo>;
  readonly transactions: ReadonlyMap<Signature, TransactionResult>;
  readonly genesisHash?: string;
  /** Recorded simulations, keyed by the exact base64 wire transaction that was simulated. */
  readonly simulations?: ReadonlyMap<string, RecordedSimulation>;
  /** Recorded `getSignaturesForAddress` answers (newest first), keyed by address. */
  readonly signatures?: ReadonlyMap<Address, readonly SignatureInfo[]>;
}

/**
 * An `RpcClient` backed entirely by pre-captured fixture data (see `scripts/capture-fixture.ts`
 * and `fixtures/`), for deterministic offline tests. Addresses/signatures absent from the fixture
 * resolve to `null`, mirroring how a real RPC responds to an account or transaction that doesn't
 * exist — this is correct, not a gap, for fixtures capturing closed accounts.
 */
export class FixtureRpcClient implements RpcClient {
  readonly #data: FixtureData;

  constructor(data: FixtureData) {
    this.#data = data;
  }

  getAccountInfo(
    address: Address,
    _options?: RpcReadOptions,
  ): Promise<ContextualResult<AccountInfo | null>> {
    return Promise.resolve({
      contextSlot: this.#data.contextSlot,
      value: this.#data.accounts.get(address) ?? null,
    });
  }

  getMultipleAccounts(
    addresses: readonly Address[],
    _options?: RpcReadOptions,
  ): Promise<ContextualResult<ReadonlyArray<AccountInfo | null>>> {
    return Promise.resolve({
      contextSlot: this.#data.contextSlot,
      value: addresses.map((address) => this.#data.accounts.get(address) ?? null),
    });
  }

  getGenesisHash(): Promise<string> {
    if (this.#data.genesisHash === undefined) {
      throw new FixtureNotSupportedError("getGenesisHash");
    }
    return Promise.resolve(this.#data.genesisHash);
  }

  getSlot(_options?: RpcReadOptions): Promise<bigint> {
    return Promise.resolve(this.#data.contextSlot);
  }

  /**
   * Replays a recorded answer for this address, cut to `limit`. Paging (`before`) and addresses
   * with no recording are not supported: a replay must not invent history.
   */
  getSignaturesForAddress(
    address: Address,
    options?: RpcReadOptions & { readonly limit?: number; readonly before?: Signature },
  ): Promise<readonly SignatureInfo[]> {
    const recorded = this.#data.signatures?.get(address);
    if (recorded === undefined || options?.before !== undefined) {
      throw new FixtureNotSupportedError("getSignaturesForAddress");
    }
    return Promise.resolve(recorded.slice(0, options?.limit ?? recorded.length));
  }

  getTransaction(
    signature: Signature,
    _options?: RpcReadOptions,
  ): Promise<TransactionResult | null> {
    return Promise.resolve(this.#data.transactions.get(signature) ?? null);
  }

  limitations(): readonly AnalysisGap[] {
    return [];
  }

  /**
   * Replays a recorded simulation of exactly this transaction with exactly these options. A JSON-RPC
   * error the endpoint returned is re-thrown as the same kit `SolanaError` a live client throws.
   */
  simulateTransaction(
    transactionBase64: string,
    options?: SimulateOptions,
  ): Promise<SimulateResult> {
    const recorded = this.#data.simulations?.get(transactionBase64);
    if (recorded === undefined) {
      throw new FixtureNotSupportedError("simulateTransaction (no recording of this transaction)");
    }
    const request: RecordedSimulationRequest = {
      accounts: options?.accounts ?? [],
      innerInstructions: options?.innerInstructions === true,
      replaceRecentBlockhash: options?.replaceRecentBlockhash === true,
    };
    if (JSON.stringify(request) !== JSON.stringify(recorded.request)) {
      throw new FixtureNotSupportedError(
        "simulateTransaction (recorded with different options than requested)",
      );
    }
    if ("rpcError" in recorded) {
      // Every JSON-RPC server error kit raises carries `__serverMessage`; the literal type only
      // selects that context shape (the recorded code itself is whatever the endpoint returned).
      return Promise.reject(
        new SolanaError(recorded.rpcError.code as -32602, {
          __serverMessage: recorded.rpcError.message,
        }),
      );
    }
    return Promise.resolve(recorded.result);
  }
}
