import type { Address } from "@solana/kit";
import type { TransactionVersion, V1TransactionConfig } from "./decoders/transaction.js";
import type { AccountLabel } from "./labels/labels.js";
import type { Cluster } from "./rpc/types.js";
import type { SanitizerNote } from "./sanitize/args.js";
import type {
  SquadsMultisigSummary,
  SquadsProposalStatus,
  SquadsProposalVotes,
  SquadsTransactionKind,
} from "./squads/types.js";
import type { TokenInfo } from "./tokens/enrich.js";

/**
 * Where a piece of information in a report comes from. See `AGENTS.md` → "Fidelity above all".
 *
 * The whole `AnalysisReport` contract lives in this file; `analyze/` assembles it.
 */
export type Provenance =
  | "onchain"
  | "idl-declared"
  | "external-api"
  | "simulation"
  | "rule-inference";

export type DecoderKind = "native" | "squads" | "program-metadata-idl" | "anchor-idl" | "none";

export interface DecodedAccount {
  readonly address: Address;
  /** Role name from the program's account list (e.g. `"source"`), when known. */
  readonly role?: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
  /**
   * An i18n key + params (e.g. `label.vault` `{ index: "0" }`) and where it comes from; a string in
   * the original `AGENTS.md` contract, see `docs/DECISIONS.md`.
   */
  readonly label?: AccountLabel;
  /** Set when this address was loaded from an address lookup table rather than listed statically. */
  readonly fromLookupTable?: Address;
}

/** i18n key + string params; the UI owns the wording. */
export interface InstructionSummary {
  readonly key: string;
  readonly params: Readonly<Record<string, string>>;
  /**
   * Params whose value is `"none"` because the argument was null (e.g. an authority being
   * removed). Every other value, including an on-chain string that happens to read "none", is
   * shown exactly as written. Not in the original `AGENTS.md` contract; see `docs/DECISIONS.md`.
   */
  readonly nullParams?: readonly string[];
}

export interface DecodedInstruction {
  readonly index: number;
  readonly batchItem?: number;
  readonly programId: Address;
  readonly programLabel?: string;
  readonly decoder: DecoderKind;
  readonly name?: string;
  readonly summary?: InstructionSummary;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly accounts: readonly DecodedAccount[];
  readonly rawDataHex: string;
  readonly provenance: Provenance;
  /**
   * Instructions carried *inside* this one and decoded recursively: the transaction message of a
   * Squads `vaultTransactionCreate`/`batchAddTransaction`, or the items of a Token/Token-2022
   * `Batch`. Not in the original `AGENTS.md` contract; see `docs/DECISIONS.md`.
   */
  readonly inner?: readonly DecodedInstruction[];
  /**
   * Strings in `args` that the sanitizer changed or flagged (`args` already holds the sanitized
   * text). Absent when nothing was changed or flagged. Not in the original `AGENTS.md` contract;
   * see `docs/DECISIONS.md`.
   */
  readonly sanitizer?: readonly SanitizerNote[];
}

/** Every gap code, as a runtime list (each one has plain-language text in every locale). */
export const ANALYSIS_GAP_CODES = [
  "UNKNOWN_PROGRAM",
  "UNKNOWN_INSTRUCTION",
  "MALFORMED_INSTRUCTION",
  "INSTRUCTION_ARGS_NOT_DECODED",
  "ACCOUNT_INDEX_OUT_OF_RANGE",
  "ACCOUNT_UNRESOLVED",
  "LOOKUP_TABLE_NOT_FOUND",
  "LOOKUP_TABLE_INVALID",
  "LOOKUP_TABLE_INDEX_OUT_OF_RANGE",
  "EMBEDDED_MESSAGE_INVALID",
  "EMBEDDED_MESSAGE_IN_BUFFER",
  "RPC_TRANSACTION_VERSION_UNSUPPORTED",
  "TOKEN_DECIMALS_UNKNOWN",
  "IDL_FETCH_FAILED",
  "IDL_INVALID",
  "IDL_AT_URL",
  "IDL_UNSUPPORTED",
  "SIMULATION_DISABLED",
  "PROGRAM_VERIFICATION_UNKNOWN",
  "TRANSFER_BALANCE_UNKNOWN",
  "SIMULATION_UNAVAILABLE",
  "SIMULATION_PRESTATE_MISMATCH",
  "SIMULATION_BALANCES_INCOMPLETE",
  "PROGRAM_INFO_UNKNOWN",
  "PROGRAM_VERIFICATION_DISABLED",
  "RPC_MISMATCH",
  "RPC_CROSS_CHECK_FAILED",
  "HISTORY_UNAVAILABLE",
] as const;

export type AnalysisGapCode = (typeof ANALYSIS_GAP_CODES)[number];

/**
 * Something the analysis could not establish. Any gap makes the report incomplete, which must
 * never be presented as "no findings".
 */
export interface AnalysisGap {
  readonly code: AnalysisGapCode;
  readonly message: string;
  /** Top-level instruction index the gap relates to, if any. */
  readonly instructionIndex?: number;
  /** Address the gap relates to (a program, lookup table, ...), if any. */
  readonly address?: Address;
}

export type Severity = "critical" | "warning" | "info";

/** `critical` if any critical finding; else `incomplete` if any gap; else `attention` if any
 * warning; else `no-findings` (shown as "No findings from the checks performed", never "safe"). */
export type Verdict = "critical" | "incomplete" | "attention" | "no-findings";

export interface Finding {
  /** e.g. `VGL-C001`. */
  readonly ruleId: string;
  readonly severity: Severity;
  /** i18n key of the finding's sentence; `params` fill it in. */
  readonly titleKey: string;
  /**
   * Template params (addresses, amounts in base units with `decimals`/`mint`/`symbol`, ...). When
   * `proposed` is `"true"` the instruction behind the finding is inside a Squads proposal that the
   * analysed transaction only *creates*: it happens only if that proposal is later approved and
   * executed.
   */
  readonly params: Readonly<Record<string, string>>;
  /** Top-level instruction the finding is about (for a nested instruction, its top-level parent). */
  readonly instructionIndex?: number;
  /** Concrete facts behind the finding, as `field: value` lines (not translated). */
  readonly evidence: readonly string[];
  readonly provenance: Provenance;
}

/** An amount's asset: native SOL, or a token mint. `"SOL"` can never be an address (base58 has no `O`). */
export type AssetId = "SOL" | Address;

/** Which loader owns a program account. Only `upgradeable` programs can change after deployment. */
export type ProgramLoader =
  | "upgradeable"
  | "loader-v1"
  | "loader-v2"
  | "loader-v4"
  | "native"
  | "not-a-program"
  | "unknown";

/** What the program-verification API (OtterSec) says, beyond the bare status. */
export interface VerificationDetails {
  readonly source: "osec";
  /** Only a `https://github.com/...` URL; anything else is dropped. */
  readonly repoUrl?: string;
  /** Only a 40-character hex git commit; anything else (including `"None"`) is dropped. */
  readonly commit?: string;
  readonly lastVerifiedAt?: string;
  /** Hash of the verified build, as reported by the API. */
  readonly verifiedHash?: string;
  /**
   * `true` when the API says verified but its verified build hash differs from the hash Vigil
   * computed from the code deployed now (the program was upgraded since): reported as unverified.
   */
  readonly hashMismatch?: boolean;
}

/**
 * What is known about a program the transaction calls or changes. Gathered before the rules run
 * (account reads and the verification API); every field that could not be established says so.
 */
export interface ProgramInfo {
  readonly address: Address;
  /**
   * `immutable`: cannot be changed (no upgrade authority, or not an upgradeable-loader program);
   * `upgradeable`: `authority` can replace its code at any time; `unknown`: could not be read.
   */
  readonly upgrade:
    | { readonly kind: "immutable" }
    | { readonly kind: "upgradeable"; readonly authority: Address }
    | { readonly kind: "unknown" };
  /** The program's ProgramData account (upgradeable loader), when known. */
  readonly programData?: Address;
  /** solana-verify compatible hash of the deployed code, when known. */
  readonly executableHash?: string;
  /**
   * Verified build status from the program-verification API. `unknown`: it was asked (or should
   * have been) and the status could not be established; `not-checked`: the user turned verification
   * lookups off, so it was never asked (a `PROGRAM_VERIFICATION_DISABLED` gap says so).
   */
  readonly verification: "verified" | "unverified" | "unknown" | "not-checked";
  /** Owning loader, when the program account was read. */
  readonly loader?: ProgramLoader;
  /** Slot of the last deployment or upgrade (ProgramData header), when known. */
  readonly lastDeploySlot?: bigint;
  /**
   * When the upgrade authority is a vault of this multisig (a vault the proposal uses, or vault 0),
   * its index. Absent when it is not, or there is no multisig.
   */
  readonly authorityVaultIndex?: number;
  readonly verificationDetails?: VerificationDetails;
}

/**
 * A balance the simulation reports as changed, in base units (lamports for SOL). The values are a
 * snapshot of one moment (see `SimulationRun.notes`), never a guarantee of what execution does.
 */
export interface BalanceChange {
  readonly account: Address;
  readonly asset: AssetId;
  /** Owner of the token account, for token balances. */
  readonly owner?: Address;
  readonly pre: bigint;
  readonly post: bigint;
  /** Token decimals (from the mint account, else the registry); 9 for SOL. Absent if unknown. */
  readonly decimals?: number;
  /**
   * Lamports added back to `post` because they are the simulated transaction fee (fee payer's SOL
   * only), so the change shows what the transaction's instructions do.
   */
  readonly feeExcluded?: bigint;
  /** The account did not exist before (`pre` is 0) or no longer exists after (`post` is 0). */
  readonly created?: boolean;
  readonly closed?: boolean;
  readonly label?: AccountLabel;
  /** Label of `owner` (token balances) or of the account itself (SOL). */
  readonly holderLabel?: AccountLabel;
}

/** i18n key of the note every simulation result carries (maintainer requirement, Phase 5). */
export const SIMULATION_SNAPSHOT_NOTE = "simulation.note.snapshot";

export type SimulationNoteKey =
  | typeof SIMULATION_SNAPSHOT_NOTE
  | "simulation.note.feeExcluded"
  | "simulation.note.feePayerMember"
  | "simulation.note.feePayerTransaction"
  | "simulation.note.extraSigner"
  | "simulation.note.batchIsolated"
  | "simulation.note.innerInstructionsUnavailable"
  | "simulation.note.logsTruncated"
  | "simulation.note.balancesNotReported";

/** A sentence about how to read a simulation result: an i18n key + params. */
export interface SimulationNote {
  readonly key: SimulationNoteKey;
  readonly params: Readonly<Record<string, string>>;
}

/** Why simulation could not be run. */
export type SimulationUnavailableCode =
  | "too-large"
  | "rpc-refused"
  | "rpc-error"
  | "accounts-unresolved"
  | "no-fee-payer"
  | "build-failed";

/** Facts about a simulation that actually ran (successfully or not). */
export interface SimulationRun {
  /** Slot of the bank the RPC simulated against. */
  readonly slot: bigint;
  readonly feePayer: {
    readonly address: Address;
    /** `vault`/`member`: chosen by Vigil for a proposal; `transaction`: a raw transaction's own. */
    readonly source: "vault" | "member" | "transaction";
  };
  /** Sanitized, at most 200 lines of 512 characters. */
  readonly logs: readonly string[];
  readonly logsTruncated: boolean;
  readonly unitsConsumed?: bigint;
  /** Fee the simulated transaction would pay, as reported by the RPC. */
  readonly fee?: bigint;
  /** Programs invoked through CPI, from the RPC's inner instructions (absent if not reported). */
  readonly innerPrograms?: readonly Address[];
  /** Always starts with `SIMULATION_SNAPSHOT_NOTE`. */
  readonly notes: readonly SimulationNote[];
  /** Batch item (1-based) this simulation is about, for a batch proposal. */
  readonly batchItem?: number;
}

/**
 * Outcome of simulating the transaction. Absent from a report when simulation was not attempted
 * (turned off by the user: that is a `SIMULATION_DISABLED` gap instead; or a config proposal,
 * whose actions are described directly).
 */
export type SimulationResult =
  | ({
      readonly status: "success";
      readonly balanceChanges: readonly BalanceChange[];
    } & SimulationRun)
  | ({ readonly status: "failed"; readonly error: string } & SimulationRun)
  | {
      readonly status: "unavailable";
      readonly reason: string;
      readonly code: SimulationUnavailableCode;
      readonly notes: readonly SimulationNote[];
      readonly batchItem?: number;
    };

/**
 * A batch proposal's items are simulated one by one: the effects of earlier items are not carried
 * into later ones (see the `simulation.note.batchIsolated` note).
 */
export interface BatchSimulation {
  readonly status: "batch";
  readonly items: readonly SimulationResult[];
  readonly notes: readonly SimulationNote[];
}

export type SimulationOutcome = SimulationResult | BatchSimulation;

export type SpendingLimitPeriod = "OneTime" | "Day" | "Week" | "Month";

/**
 * A change to a Squads multisig's settings: an action of a config transaction, or one of the
 * direct `multisig*` instructions a controlled multisig's config authority can call.
 */
export type ConfigAction =
  | {
      readonly kind: "addMember";
      readonly member: Address;
      readonly permissions: readonly ("Initiate" | "Vote" | "Execute")[];
    }
  | { readonly kind: "removeMember"; readonly member: Address }
  | { readonly kind: "changeThreshold"; readonly newThreshold: number }
  | { readonly kind: "setTimeLock"; readonly newTimeLockSeconds: number }
  | {
      readonly kind: "addSpendingLimit";
      readonly createKey: Address;
      readonly vaultIndex: number;
      /** `11111111111111111111111111111111` (`Pubkey::default()`) means SOL. */
      readonly mint: Address;
      readonly amount: bigint;
      readonly period: SpendingLimitPeriod;
      readonly members: readonly Address[];
      /** Empty means any destination. */
      readonly destinations: readonly Address[];
    }
  | { readonly kind: "removeSpendingLimit"; readonly spendingLimit: Address }
  | { readonly kind: "setRentCollector"; readonly newRentCollector: Address | null }
  | { readonly kind: "setConfigAuthority"; readonly newConfigAuthority: Address };

/** The multisig a proposal belongs to, as read on chain. */
export type MultisigSummary = SquadsMultisigSummary;

/** The proposal being analysed, as read on chain. */
export interface ProposalSummary {
  readonly transactionIndex: bigint;
  /** The `VaultTransaction`, `ConfigTransaction` or `Batch` account. */
  readonly transactionAddress: Address;
  /** `null` when no proposal account exists yet (a transaction created without a proposal). */
  readonly proposalAddress: Address | null;
  readonly status: SquadsProposalStatus | null;
  readonly votes: SquadsProposalVotes | null;
  /** At or below the multisig's `staleTransactionIndex`: can no longer be approved or executed. */
  readonly isStale: boolean;
  /** Vault the transaction executes from (vault and batch proposals). */
  readonly vaultIndex?: number;
  /** Batch items found (batch proposals), 1-based. */
  readonly batchItems?: readonly number[];
}

/** Facts about the transaction given in raw-transaction mode. */
export interface RawTransactionSummary {
  readonly version: TransactionVersion;
  readonly feePayer: Address;
  readonly signatureCount: number;
  readonly transactionConfig?: V1TransactionConfig;
}

export type ReportInput =
  | {
      readonly kind: "squads-proposal";
      readonly multisig: Address;
      readonly transactionIndex: bigint;
    }
  | { readonly kind: "raw-transaction"; readonly sha256: string };

/**
 * The result of one analysis: everything the CLI and the web app show, and nothing they compute
 * themselves. Serialized with `serializeReport` (bigint as decimal strings, keys sorted), described
 * by `docs/report.schema.json`.
 */
export interface AnalysisReport {
  readonly schemaVersion: 1;
  /** ISO 8601, from the injected clock. */
  readonly generatedAt: string;
  /** From the RPC's genesis hash, never from what the user said. */
  readonly cluster: Cluster;
  /** Host of the RPC endpoint only (never the path or query, which may hold an API key). */
  readonly rpcHost: string;
  /** Slot the analysis started at; every read is at or after it. */
  readonly contextSlot: bigint;
  readonly input: ReportInput;
  readonly multisig?: MultisigSummary;
  readonly proposal?: ProposalSummary;
  readonly transactionKind?: SquadsTransactionKind;
  readonly rawTransaction?: RawTransactionSummary;
  readonly instructions: readonly DecodedInstruction[];
  readonly configActions?: readonly ConfigAction[];
  /** Tokens the instructions move or name (decimals, registry or declared names). */
  readonly tokens: readonly TokenInfo[];
  readonly programs: readonly ProgramInfo[];
  readonly simulation?: SimulationOutcome;
  readonly findings: readonly Finding[];
  readonly verdict: Verdict;
  readonly completeness: {
    readonly complete: boolean;
    readonly gaps: readonly AnalysisGap[];
  };
}
