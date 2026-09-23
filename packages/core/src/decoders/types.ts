import type { Address, ReadonlyUint8Array } from "@solana/kit";
import type { DecoderKind } from "../report.js";

export interface InstructionAccountInput {
  readonly address: Address;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
  readonly fromLookupTable?: Address;
}

/** A fully resolved instruction: every account index already mapped to a concrete address. */
export interface InstructionInput {
  readonly programId: Address;
  readonly accounts: readonly InstructionAccountInput[];
  readonly data: ReadonlyUint8Array;
}

/** A transaction message carried inside an instruction's data (e.g. Squads `vaultTransactionCreate`). */
export interface EmbeddedMessageRef {
  readonly kind: "squads-transaction-message";
  readonly bytes: ReadonlyUint8Array;
}

export interface ProgramDecodeResult {
  readonly name: string;
  readonly args?: Readonly<Record<string, unknown>>;
  /** Role per account position; `undefined` for positions with no named role (e.g. multisig signers). */
  readonly accountRoles?: readonly (string | undefined)[];
  readonly summary?: { readonly key: string; readonly params: Readonly<Record<string, string>> };
  /** Nested instructions already resolved against this instruction's own accounts (Token `Batch`). */
  readonly innerInstructions?: readonly InstructionInput[];
  /** A nested transaction message that must be resolved (possibly via lookup tables) and decoded. */
  readonly embeddedMessage?: EmbeddedMessageRef;
  /** `true` when the instruction was identified by name but its arguments were not decoded. */
  readonly argsNotDecoded?: boolean;
  /** Set when the instruction was recognised but part of what it will do cannot be shown. */
  readonly incompleteReason?: {
    readonly code: "EMBEDDED_MESSAGE_IN_BUFFER";
    readonly message: string;
  };
}

export interface ProgramDecoder {
  /** `anchor-idl` / `program-metadata-idl` decoders are built at runtime from a program's IDL. */
  readonly kind: Exclude<DecoderKind, "none">;
  /** Stable short key used to build i18n summary keys: `ix.<key>.<instructionName>`. */
  readonly key: string;
  readonly programIds: readonly Address[];
  readonly label: string;
  /**
   * Pure and synchronous. Throws (a `DecodeError`, or a `SolanaError` from an official client's
   * codec) when the instruction is unknown or malformed; the caller turns that into a gap.
   */
  decode(instruction: InstructionInput): ProgramDecodeResult;
}
