import type { Address, Signature } from "@solana/kit";
import type { AnalysisGap } from "../report.js";
import type {
  AccountInfo,
  ContextualResult,
  RpcClient,
  RpcReadOptions,
  SignatureInfo,
  SimulateResult,
  TransactionResult,
} from "./types.js";

export class FixtureNotSupportedError extends Error {
  constructor(method: string) {
    super(`FixtureRpcClient does not support ${method}() — no fixture data is captured for it`);
    this.name = "FixtureNotSupportedError";
  }
}

export interface FixtureData {
  /** The slot recorded at capture time; used as the context slot for any lookup. */
  readonly contextSlot: bigint;
  readonly accounts: ReadonlyMap<Address, AccountInfo>;
  readonly transactions: ReadonlyMap<Signature, TransactionResult>;
  readonly genesisHash?: string;
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

  getSignaturesForAddress(
    _address: Address,
    _options?: RpcReadOptions & { readonly limit?: number; readonly before?: Signature },
  ): Promise<readonly SignatureInfo[]> {
    throw new FixtureNotSupportedError("getSignaturesForAddress");
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

  simulateTransaction(
    _transactionBase64: string,
    _options?: RpcReadOptions & { readonly replaceRecentBlockhash?: boolean },
  ): Promise<SimulateResult> {
    throw new FixtureNotSupportedError("simulateTransaction");
  }
}
