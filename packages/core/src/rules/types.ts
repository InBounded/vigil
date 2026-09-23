import type { Address } from "@solana/kit";
import type { V1TransactionConfig } from "../decoders/transaction.js";
import type {
  AnalysisGap,
  AssetId,
  ConfigAction,
  DecodedInstruction,
  Finding,
  ProgramInfo,
  Severity,
  SimulationResult,
} from "../report.js";
import type { Cluster } from "../rpc/types.js";
import type {
  SquadsMultisigSummary,
  SquadsProposalInfo,
  SquadsTransactionKind,
} from "../squads/types.js";
import type { TokenInfo } from "../tokens/enrich.js";

/** What is being analysed (mirrors `AnalysisReport.input`). */
export type RuleInput =
  | {
      readonly kind: "squads-proposal";
      readonly multisig: Address;
      readonly transactionIndex: bigint;
    }
  | { readonly kind: "raw-transaction"; readonly sha256: string };

/** User-tunable rule options. Every field is optional; see `DEFAULT_RULE_OPTIONS`. */
export interface RuleOptions {
  /**
   * A transfer is large when it moves at least this percentage of the sending account's balance
   * in that asset (0 < value ≤ 100, at most two decimal places). @defaultValue 10
   */
  readonly largeTransferPercent?: number;
  /**
   * Per-asset absolute thresholds in base units (lamports for `"SOL"`): a transfer of at least
   * this amount is large whatever the balance. Optional; none by default.
   */
  readonly largeTransferAbsolute?: ReadonlyMap<AssetId, bigint>;
  /**
   * How many of the vault's recent transactions the "new destination" check looks at; 0 turns it
   * off. The rules only read the destinations gathered beforehand. @defaultValue 0
   */
  readonly historyDepth?: number;
  /** Addresses the user knows, with their own label (already sanitized). */
  readonly knownAddresses?: ReadonlyMap<Address, string>;
}

export interface ResolvedRuleOptions {
  /** `largeTransferPercent` in basis points (10 % = 1,000), so comparisons stay in bigint. */
  readonly largeTransferBasisPoints: bigint;
  readonly largeTransferAbsolute: ReadonlyMap<AssetId, bigint>;
  readonly historyDepth: number;
  readonly knownAddresses: ReadonlyMap<Address, string>;
}

/** Why an address is known. An address can be known for several reasons. */
export type KnownAddressKind =
  | "multisig"
  | "vault"
  | "member"
  | "registry-program"
  | "registry-token"
  | "user"
  | "recent-destination";

export interface UpgradeBufferInfo {
  readonly address: Address;
  /** `null`: the buffer has no authority (its contents can no longer change). */
  readonly authority: Address | null;
  /** solana-verify compatible hash of the buffer's program bytes, when computed. */
  readonly executableHash?: string;
}

/** A balance of `owner` in `asset`, in base units, read before the rules run. */
export interface AssetBalance {
  readonly owner: Address;
  readonly asset: AssetId;
  readonly amount: bigint;
}

/** Chain data gathered before the rules run. Anything missing is simply not used by the rules. */
export interface RuleFacts {
  /** Upgrade buffers referenced by loader `upgrade` instructions, by address. */
  readonly buffers?: ReadonlyMap<Address, UpgradeBufferInfo>;
  /** Balances of the accounts funds are sent from. */
  readonly balances?: readonly AssetBalance[];
  /** Destinations seen in the vault's last `historyDepth` transactions (only when > 0). */
  readonly recentDestinations?: ReadonlySet<Address>;
}

/** Everything a rule may look at. Built by `createRuleContext`; rules never do I/O. */
export interface RuleContext {
  readonly input: RuleInput;
  readonly cluster: Cluster;
  /** Current time, unix seconds, from the injected clock. */
  readonly now: bigint;
  readonly instructions: readonly DecodedInstruction[];
  readonly gaps: readonly AnalysisGap[];
  readonly tokens: readonly TokenInfo[];
  readonly programs: readonly ProgramInfo[];
  readonly simulation?: SimulationResult;
  readonly configActions?: readonly ConfigAction[];
  readonly transactionKind?: SquadsTransactionKind;
  readonly multisig?: SquadsMultisigSummary;
  /** `null`: the proposal account does not exist (yet). Absent in raw-transaction mode. */
  readonly proposal?: SquadsProposalInfo | null;
  /** Fee payer of a raw transaction (its SOL balance also pays the fee). */
  readonly feePayer?: Address;
  /** Inline compute budget of a v1 raw transaction. */
  readonly transactionConfig?: V1TransactionConfig;
  readonly facts: RuleFacts;
  readonly options: ResolvedRuleOptions;
  /** This multisig's derived vaults (address → index). */
  readonly vaults: ReadonlyMap<Address, number>;
  /** Every address Vigil or the user knows, and why. */
  readonly known: ReadonlyMap<Address, readonly KnownAddressKind[]>;
}

/** Plain-language documentation of a rule; `docs/rules.md` is generated from it. */
export interface RuleDocs {
  readonly what: string;
  readonly why: string;
  readonly falsePositives: string;
}

export interface Rule {
  /** e.g. `VGL-C001`. */
  readonly id: string;
  readonly name: string;
  readonly defaultSeverity: Severity;
  /** The main i18n key; variants are `<titleKey>.<variant>`. */
  readonly titleKey: string;
  /** Every variant suffix the rule can emit (`""` = `titleKey` itself), so tests can check texts. */
  readonly variants: readonly string[];
  readonly docs: RuleDocs;
  /** Pure and deterministic. */
  evaluate(context: RuleContext): Finding[];
}
