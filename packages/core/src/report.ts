import type { Address } from "@solana/kit";
import type { AccountLabel } from "./labels/labels.js";
import type { SanitizerNote } from "./sanitize/args.js";

/**
 * Where a piece of information in a report comes from. See `AGENTS.md` → "Fidelity above all".
 *
 * Only the subset of the `AnalysisReport` contract needed so far (decoding in Phase 3, findings and
 * the inputs of the risk rules in Phase 4) is defined here; the report itself is assembled in a
 * later phase.
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

export interface DecodedInstruction {
  readonly index: number;
  readonly batchItem?: number;
  readonly programId: Address;
  readonly programLabel?: string;
  readonly decoder: DecoderKind;
  readonly name?: string;
  /** i18n key + string params; the UI owns the wording. */
  readonly summary?: { readonly key: string; readonly params: Readonly<Record<string, string>> };
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
  /** Verified build status from the program-verification API; `unknown` when it could not be asked. */
  readonly verification: "verified" | "unverified" | "unknown";
}

/** A balance the simulation reports as changed, in base units (lamports for SOL). */
export interface BalanceChange {
  readonly account: Address;
  readonly asset: AssetId;
  /** Owner of the token account, for token balances. */
  readonly owner?: Address;
  readonly pre: bigint;
  readonly post: bigint;
}

/**
 * Outcome of simulating the transaction. Absent from a report when simulation was not attempted
 * (turned off by the user: that is a `SIMULATION_DISABLED` gap instead).
 */
export type SimulationResult =
  | { readonly status: "success"; readonly balanceChanges: readonly BalanceChange[] }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "unavailable"; readonly reason: string };

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
