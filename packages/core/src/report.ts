import type { Address } from "@solana/kit";
import type { AccountLabel } from "./labels/labels.js";
import type { SanitizerNote } from "./sanitize/args.js";

/**
 * Where a piece of information in a report comes from. See `AGENTS.md` → "Fidelity above all".
 *
 * Only the subset of the `AnalysisReport` contract needed by instruction decoding (Phase 3A) is
 * defined here so far; the rest of the report is assembled in a later phase.
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

export type AnalysisGapCode =
  | "UNKNOWN_PROGRAM"
  | "UNKNOWN_INSTRUCTION"
  | "MALFORMED_INSTRUCTION"
  | "INSTRUCTION_ARGS_NOT_DECODED"
  | "ACCOUNT_INDEX_OUT_OF_RANGE"
  | "ACCOUNT_UNRESOLVED"
  | "LOOKUP_TABLE_NOT_FOUND"
  | "LOOKUP_TABLE_INVALID"
  | "LOOKUP_TABLE_INDEX_OUT_OF_RANGE"
  | "EMBEDDED_MESSAGE_INVALID"
  | "EMBEDDED_MESSAGE_IN_BUFFER"
  | "RPC_TRANSACTION_VERSION_UNSUPPORTED"
  | "TOKEN_DECIMALS_UNKNOWN"
  | "IDL_FETCH_FAILED"
  | "IDL_INVALID"
  | "IDL_AT_URL"
  | "IDL_UNSUPPORTED";

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
